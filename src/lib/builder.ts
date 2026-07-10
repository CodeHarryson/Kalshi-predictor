import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { scoreGameSideProbability } from "@/lib/scoring/leg-scorer";
import { resolveMarketFavoredSide } from "@/lib/scoring/composite";
import {
  impliedProbabilityFromPriceCents,
  computeEdge,
} from "@/lib/scoring/parlay";

export interface CandidateLeg {
  gameId: string;
  kalshiMarketId: string;
  description: string;
  side: "YES" | "NO";
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

  for (const game of games) {
    for (const market of game.markets) {
      if (market.yesPrice == null) continue;

      const favoredSide = resolveMarketFavoredSide(
        market.title,
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

      candidates.push({
        gameId: game.id,
        kalshiMarketId: market.id,
        description: `${game.awayTeam.name} @ ${game.homeTeam.name} — ${market.title} (${side})`,
        side,
        predictedProbability,
        marketImpliedProbability,
        edge,
        features,
      });
    }
  }

  candidates.sort((a, b) => b.edge - a.edge);
  return candidates.slice(0, limit);
}
