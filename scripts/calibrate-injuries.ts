/**
 * Compares the model with Kalshi's current game prices to check how much of
 * the injury adjustment to trust.
 *
 *   npx tsx scripts/calibrate-injuries.ts
 *
 * ESPN keeps no injury history, so the injury weights can't be fit against
 * past outcomes. Kalshi prices already reflect each game's injuries, so for
 * upcoming games with both sides priced we sweep the injury scale and report
 * how far the model is from the (de-vigged) market at each setting. Update
 * INJURY_SCALE in src/lib/scoring/injuries.ts from the result. Needs enough
 * games to mean anything: treat n < ~30 as a hint, and note that pre-season
 * and early-season games are unrepresentative.
 */
import { db } from "../src/lib/db";
import { estimateGameProbabilities, resolveMarketFavoredSide } from "../src/lib/scoring/composite";
import { matchOutcomeProbabilities } from "../src/lib/scoring/elo";
import { INJURY_SCALE } from "../src/lib/scoring/injuries";
import type { League } from "../src/generated/prisma/enums";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const SCALES = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];

async function main() {
  for (const league of ["NBA", "NFL", "CFB"] as League[]) {
    const games = await db.game.findMany({
      where: { league, status: "SCHEDULED", startTime: { gte: new Date() }, markets: { some: {} } },
      include: { homeTeam: true, awayTeam: true, markets: true },
    });

    const current = INJURY_SCALE[league] ?? 1;
    const rows: { market: number; est: NonNullable<Awaited<ReturnType<typeof estimateGameProbabilities>>> }[] = [];
    for (const g of games) {
      let home: number | null = null;
      let away: number | null = null;
      for (const m of g.markets) {
        if (m.yesPrice == null || m.propKind) continue;
        const side = resolveMarketFavoredSide(
          m.yesSubTitle ?? m.title,
          g.homeTeam.name,
          g.homeTeam.shortName,
          g.awayTeam.name,
          g.awayTeam.shortName
        );
        if (side === "home") home = m.yesPrice;
        else if (side === "away") away = m.yesPrice;
      }
      if (home == null || away == null || home + away === 0) continue;
      const est = await estimateGameProbabilities(g.id);
      if (est) rows.push({ market: home / (home + away), est });
    }

    const injured = rows.filter((r) => r.est.homeInjuryElo + r.est.awayInjuryElo > 0);
    console.log(`\n${league}: ${rows.length} games priced on both sides, ${injured.length} with injuries (current scale ${current})`);
    if (injured.length < 3) {
      console.log("  too few injured games to calibrate");
      continue;
    }

    // estimateGameProbabilities applies INJURY_SCALE already; undo it to sweep.
    const modelAt = (r: (typeof rows)[number], s: number) => {
      const e = r.est;
      const rawHome = e.homeInjuryElo / current;
      const rawAway = e.awayInjuryElo / current;
      const at = (k: number) =>
        matchOutcomeProbabilities(league, e.homeRating - k * rawHome, e.awayRating - k * rawAway).homeWin;
      return clamp(at(s) + (e.homeWin - at(current)), 0.01, 0.98); // keep the form nudge
    };

    console.log("  scale   RMSE vs market (pct points)");
    for (const s of SCALES) {
      const rmse = Math.sqrt(injured.reduce((t, r) => t + (modelAt(r, s) - r.market) ** 2, 0) / injured.length);
      console.log(`  ${String(s).padEnd(6)}  ${(rmse * 100).toFixed(2)}${s === current ? "   <- current" : ""}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
