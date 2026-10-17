import { db } from "@/lib/db";
import type { League, LegKind } from "@/generated/prisma/enums";
import { scoreGameSideProbability } from "@/lib/scoring/leg-scorer";
import { resolveMarketFavoredSide } from "@/lib/scoring/composite";
import { ELO_CONFIG } from "@/lib/scoring/elo";
import { scorePropMarket, scorePlayerAnytimeGoal } from "@/lib/scoring/prop-scorer";
import {
  impliedProbabilityFromPriceCents,
  computeEdge,
} from "@/lib/scoring/parlay";

export interface CandidateLeg {
  // Null for tournament-scoped legs (PLAYER_GOALS) - there's no single
  // game to peg an "anytime this tournament" bet to. Must stay a real
  // Game.id or null (never a placeholder string): this flows straight
  // into ParlayLeg.gameId, a real FK, when the leg is persisted.
  gameId: string | null;
  kalshiMarketId: string;
  description: string;
  side: "YES" | "NO";
  // What this leg grades on. Must be threaded through to ParlayLeg.legKind
  // at creation time (src/app/api/parlays/route.ts) - without it every leg
  // silently defaults to GAME_WINNER and prop legs get graded through the
  // wrong settlement path.
  legKind: LegKind;
  predictedProbability: number;
  marketImpliedProbability: number;
  edge: number;
  features: Record<string, number>;
}

export async function buildParlaySuggestions(
  league: League,
  opts?: { limit?: number }
): Promise<CandidateLeg[]> {
  const limit = opts?.limit ?? 20;

  const games = await db.game.findMany({
    where: {
      league,
      status: "SCHEDULED",
      startTime: { gte: new Date() },
      markets: { some: {} },
    },
    include: {
      homeTeam: true,
      awayTeam: true,
      markets: true,
    },
  });

  const candidates: CandidateLeg[] = [];
  const outcomeIndex = new Map<string, number>(); // two-way game id -> index of its kept pick

  for (const game of games) {
    for (const market of game.markets) {
      if (market.yesPrice == null) continue;

      // Second branch: per-game prop markets (team corners). Branched off
      // `propKind IS NOT NULL` so the existing moneyline path is untouched.
      // PLAYER_GOALS markets never reach this loop - they're synced with
      // `gameId: null` (tournament-scoped, not tied to one game - see
      // kalshi-props.ts's PROP_SERIES comment) and are scored separately
      // below, after this per-game loop.
      if (market.propKind === "TEAM_CORNERS") {
        const propScore = await scorePropMarket({
          gameId: game.id,
          propKind: market.propKind,
          propThreshold: market.propThreshold ?? 0.5,
          propSubjectExternalId: market.propSubjectExternalId ?? "",
          propSubjectName: market.propSubjectName ?? "subject",
        });
        if (!propScore) continue;
        const thresholdLabel = `${market.propThreshold}+`;
        const yesImplied = impliedProbabilityFromPriceCents(market.yesPrice);
        const noImplied =
          market.noPrice != null
            ? impliedProbabilityFromPriceCents(market.noPrice)
            : 1 - yesImplied;
        const yesEdge = computeEdge(propScore.predictedProbability, yesImplied);
        const noEdge = computeEdge(1 - propScore.predictedProbability, noImplied);
        const takeYes = yesEdge >= noEdge;
        const side: "YES" | "NO" = takeYes ? "YES" : "NO";
        const predictedProbability = takeYes
          ? propScore.predictedProbability
          : 1 - propScore.predictedProbability;
        const marketImpliedProbability = takeYes ? yesImplied : noImplied;
        const edge = takeYes ? yesEdge : noEdge;
        candidates.push({
          gameId: game.id,
          kalshiMarketId: market.id,
          description: `${market.propSubjectName ?? "subject"} ${thresholdLabel} corners — ${game.awayTeam.name} @ ${game.homeTeam.name}`,
          side,
          legKind: "TEAM_CORNERS",
          predictedProbability,
          marketImpliedProbability,
          edge,
          features: {
            propThreshold: market.propThreshold ?? 0.5,
            gamesObserved: propScore.gamesObserved,
            fellBackToPrior: propScore.fellBackToPrior ? 1 : 0,
          },
        });
        continue;
      }

      const favoredSide = resolveMarketFavoredSide(
        market.yesSubTitle ?? market.title,
        game.homeTeam.name,
        game.homeTeam.shortName,
        game.awayTeam.name,
        game.awayTeam.shortName
      );
      if (!favoredSide) continue;

      const score = await scoreGameSideProbability(game.id, favoredSide);
      if (!score) continue;

      const yesImplied = impliedProbabilityFromPriceCents(market.yesPrice);
      const noImplied =
        market.noPrice != null
          ? impliedProbabilityFromPriceCents(market.noPrice)
          : 1 - yesImplied;

      const yesEdge = computeEdge(score.probability, yesImplied);
      const noEdge = computeEdge(1 - score.probability, noImplied);

      const takeYes = yesEdge >= noEdge;
      const side: "YES" | "NO" = takeYes ? "YES" : "NO";
      const predictedProbability = takeYes
        ? score.probability
        : 1 - score.probability;
      const marketImpliedProbability = takeYes ? yesImplied : noImplied;
      const edge = takeYes ? yesEdge : noEdge;

      const features: Record<string, number> = {
        baseProbability: score.features.baseProbability,
        ratingDiffNorm: score.features.ratingDiffNorm,
        isHome: score.features.isHome,
        recentFormDiff: score.features.recentFormDiff,
        modelBlended: score.modelBlended ? 1 : 0,
      };
      // Extra inputs, stored for later analysis / retraining. They are not part
      // of the trained model's vector (see leg-scorer.ts featuresToVector).
      const extras = {
        injuryEloDiff: score.features.injuryEloDiff,
        recentMarginDiff: score.features.recentMarginDiff,
        h2hMargin: score.features.h2hMargin,
        h2hGames: score.features.h2hGames,
      };
      for (const [key, value] of Object.entries(extras)) {
        if (typeof value === "number" && Number.isFinite(value)) features[key] = value;
      }

      const outcomeLabel =
        favoredSide === "draw"
          ? "Draw"
          : favoredSide === "home"
            ? game.homeTeam.name
            : game.awayTeam.name;
      const pick =
        side === "YES"
          ? favoredSide === "draw"
            ? "Draw"
            : `${outcomeLabel} to win`
          : favoredSide === "draw"
            ? "No draw"
            : `${outcomeLabel} NOT to win`;

      const winnerLeg: CandidateLeg = {
        gameId: game.id,
        kalshiMarketId: market.id,
        description: `${game.awayTeam.name} @ ${game.homeTeam.name} — ${pick}`,
        side,
        legKind: "GAME_WINNER",
        predictedProbability,
        marketImpliedProbability,
        edge,
        features,
      };

      // In a two-outcome league, Kalshi lists one market per team, so "Jacksonville
      // to win" and "Houston NOT to win" are the same bet, and "Jacksonville to
      // win" vs "Houston to win" can never both happen. Either way the game has
      // exactly one winner, so keep only the best-edge pick per game: otherwise
      // the list is padded with duplicates, and ticking two of them in the
      // builder multiplies one event's probability into a parlay.
      if (!ELO_CONFIG[league].hasDraws && favoredSide !== "draw") {
        const existing = outcomeIndex.get(game.id);
        if (existing !== undefined) {
          if (winnerLeg.edge > candidates[existing].edge) candidates[existing] = winnerLeg;
          continue;
        }
        outcomeIndex.set(game.id, candidates.length);
      }
      candidates.push(winnerLeg);
    }
  }

  // Tournament-scoped prop markets (PLAYER_GOALS) aren't linked to any
  // single game (gameId is null - see kalshi-props.ts's PROP_SERIES
  // comment), so they're never reachable via the per-game loop above.
  // Scanned separately here, scoped to `league` the same way the games
  // query is (these rows are only ever synced with league: "WORLD_CUP").
  const playerGoalMarkets = await db.kalshiMarket.findMany({
    // Sync only upserts markets Kalshi still lists as open and never retires
    // the rest, so a past closeTime is the only signal a market is dead.
    where: {
      league,
      propKind: "PLAYER_GOALS",
      gameId: null,
      closeTime: { gt: new Date() },
    },
  });
  for (const market of playerGoalMarkets) {
    if (market.yesPrice == null || !market.propSubjectExternalId) continue;

    const propScore = await scorePlayerAnytimeGoal(market.propSubjectExternalId);
    const yesImplied = impliedProbabilityFromPriceCents(market.yesPrice);
    const noImplied =
      market.noPrice != null
        ? impliedProbabilityFromPriceCents(market.noPrice)
        : 1 - yesImplied;
    const yesEdge = computeEdge(propScore.predictedProbability, yesImplied);
    const noEdge = computeEdge(1 - propScore.predictedProbability, noImplied);
    const takeYes = yesEdge >= noEdge;
    const side: "YES" | "NO" = takeYes ? "YES" : "NO";
    const predictedProbability = takeYes
      ? propScore.predictedProbability
      : 1 - propScore.predictedProbability;
    const marketImpliedProbability = takeYes ? yesImplied : noImplied;
    const edge = takeYes ? yesEdge : noEdge;
    const pick = side === "YES" ? "to score anytime this tournament" : "NOT to score this tournament";

    candidates.push({
      gameId: null,
      kalshiMarketId: market.id,
      description: `${market.propSubjectName ?? "subject"} ${pick}`,
      side,
      legKind: "PLAYER_GOALS",
      predictedProbability,
      marketImpliedProbability,
      edge,
      features: {
        gamesObserved: propScore.gamesObserved,
        fellBackToPrior: propScore.fellBackToPrior ? 1 : 0,
        alreadyScored: propScore.alreadyScored ? 1 : 0,
        remainingGames: propScore.remainingGames,
      },
    });
  }

  candidates.sort((a, b) => b.edge - a.edge);
  return candidates.slice(0, limit);
}

export interface RecommendedCombo {
  legs: CandidateLeg[];
  combinedProbability: number;
  combinedMarketImplied: number;
  combinedEdge: number;
  size: number;
  leagues: League[];
}

interface BuildRecommendedCombosOptions {
  perLeague?: number;
  comboSizes?: number[];
  limit?: number;
}

/**
 * Greedy cross-league combo builder. Pulls per-leg candidates via
 * `buildParlaySuggestions` for each requested league, then enumerates
 * 2- and 3-leg combos and ranks them by combined edge. Used by the
 * dashboard "Recommended combos" section.
 *
 * Constraints:
 *   - No two legs from the same game (a parlay can't win both sides
 *     of the same game).
 *   - Per-leg probabilities are combined with naive independence
 *     (product), matching how `combineParlayProbability` works for
 *     user-built parlays in /api/parlays.
 *
 * Returns the top N combos (default 6) sorted by combined edge desc.
 */
export async function buildRecommendedCombos(
  leagues: League[],
  opts?: BuildRecommendedCombosOptions
): Promise<RecommendedCombo[]> {
  const perLeague = opts?.perLeague ?? 30;
  const comboSizes = opts?.comboSizes ?? [2, 3];
  const limit = opts?.limit ?? 6;

  if (leagues.length === 0) return [];

  // Pull a healthy pool of single-leg candidates per league. We pull more
  // than we'll need so the cross-league search has room to find good
  // pairings without always picking from the same top-5.
  const pools = await Promise.all(
    leagues.map((l) => buildParlaySuggestions(l, { limit: perLeague }))
  );
  const all: CandidateLeg[] = pools.flat();

  if (all.length < comboSizes[0]) return [];

  // Dedupe by kalshiMarketId+side (the same market can appear once per
  // side via the yes/no edge split in buildParlaySuggestions).
  const seen = new Set<string>();
  const candidates: CandidateLeg[] = [];
  for (const leg of all) {
    const key = `${leg.kalshiMarketId}:${leg.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(leg);
  }

  if (candidates.length < comboSizes[0]) return [];

  // Cap the search space so we don't blow up combinatorially. 3-leg
  // combos of 60 is ~34k — fine for an in-process build.
  const trimmed = candidates.slice(0, Math.min(candidates.length, 60));

  // Resolve gameId -> league once so we can tag each combo with the
  // distinct leagues it touches. Single batched query covers every
  // leg in the trimmed pool. Tournament-scoped legs (PLAYER_GOALS) have
  // gameId: null - excluded from this lookup and tagged WORLD_CUP directly
  // below, since that's the only league they're synced for.
  const gameIds = [...new Set(trimmed.map((l) => l.gameId).filter((id): id is string => id !== null))];
  const games = await db.game.findMany({
    where: { id: { in: gameIds } },
    select: { id: true, league: true },
  });
  const leagueByGame = new Map(games.map((g) => [g.id, g.league]));

  const combos: RecommendedCombo[] = [];
  for (const size of comboSizes) {
    enumerateCombos(trimmed, size, leagueByGame, combos);
  }

  // Dedupe by sorted set of (kalshiMarketId+side). Two combos that
  // contain the same legs in different orders count as one.
  const seenKeys = new Set<string>();
  const deduped: RecommendedCombo[] = [];
  for (const combo of combos) {
    const key = combo.legs
      .map((l) => `${l.kalshiMarketId}:${l.side}`)
      .sort()
      .join("|");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(combo);
  }

  deduped.sort((a, b) => b.combinedEdge - a.combinedEdge);
  return deduped.slice(0, limit);
}

function enumerateCombos(
  pool: CandidateLeg[],
  size: number,
  leagueByGame: Map<string, League>,
  out: RecommendedCombo[]
): void {
  if (size < 2) return;
  const n = pool.length;
  if (n < size) return;
  const indices: number[] = [];
  const stack: number[] = [];
  const walk = (start: number) => {
    if (stack.length === size) {
      const legs = stack.map((i) => pool[i]);
      // Skip if any two legs share a gameId. Tournament-scoped legs
      // (PLAYER_GOALS) have gameId: null - falling back to kalshiMarketId
      // for those so two different players' anytime-goalscorer legs don't
      // spuriously "conflict" just because they're both ungamed, while
      // still preventing the same market appearing twice in one combo.
      const games = new Set<string>();
      let conflict = false;
      for (const leg of legs) {
        const key = leg.gameId ?? `market:${leg.kalshiMarketId}`;
        if (games.has(key)) {
          conflict = true;
          break;
        }
        games.add(key);
      }
      if (!conflict) {
        const combinedProbability = legs.reduce(
          (p, l) => p * l.predictedProbability,
          1
        );
        const combinedMarketImplied = legs.reduce(
          (p, l) => p * l.marketImpliedProbability,
          1
        );
        const combinedEdge = combinedProbability - combinedMarketImplied;
        // Distinct leagues touched, preserving first-seen order so
        // the dashboard can render the same combo in the same order
        // across reloads.
        const seenLeagues = new Set<League>();
        const leagues: League[] = [];
        for (const leg of legs) {
          // PLAYER_GOALS legs have no gameId to look up - they're only
          // ever synced for WORLD_CUP (see kalshi-props.ts's PROP_SERIES).
          const lg = leg.gameId ? leagueByGame.get(leg.gameId) : leg.legKind === "PLAYER_GOALS" ? "WORLD_CUP" : undefined;
          if (lg && !seenLeagues.has(lg)) {
            seenLeagues.add(lg);
            leagues.push(lg);
          }
        }
        out.push({
          legs,
          combinedProbability,
          combinedMarketImplied,
          combinedEdge,
          size,
          leagues,
        });
      }
      return;
    }
    for (let i = start; i < n; i++) {
      if (indices.includes(i)) continue;
      indices.push(i);
      stack.push(i);
      walk(i + 1);
      stack.pop();
      indices.pop();
    }
  };
  walk(0);
}
