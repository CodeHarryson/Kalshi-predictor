-- Player/team prop bets (player goals, team corners) for the parlay builder.
-- All changes are additive and non-breaking:
--   * new nullable columns on KalshiMarket / PlayerGameStat — backfill is opt-in
--     (only when the new kalshi-props parser + API-Football sync lands, which
--     is gated on Step 0 live-verify and the API key being set)
--   * new legKind column on ParlayLeg with a constant DEFAULT so existing
--     rows grade correctly under the new settle code without backfill
--   * new TeamGameStat table for team-level box-score stats
-- Don't run `prisma migrate dev` against the existing dev.db — the project
-- already has drift (see the 20260711003343 yesSubTitle migration for the
-- same warning). After this file lands, run `prisma migrate resolve` to
-- mark it applied, then `prisma generate` to refresh the client.

-- 1. PlayerGameStat: soccer / World Cup player goals (populated by
-- syncPropStatsForLeague from API-Football). Null for basketball.
ALTER TABLE "PlayerGameStat" ADD COLUMN "goals" REAL;

-- 2. KalshiMarket: prop-market fields. Null for moneyline / game-winner
-- markets (the default) — the builder's existing branch keys off
-- propKind IS NULL. Populated at sync time once the kalshi-props parser
-- is verified against live KXWCPLAYERGOALS / KXWCTCORNERS tickers.
ALTER TABLE "KalshiMarket" ADD COLUMN "propKind" TEXT;
ALTER TABLE "KalshiMarket" ADD COLUMN "propThreshold" REAL;
ALTER TABLE "KalshiMarket" ADD COLUMN "propSubjectExternalId" TEXT;
ALTER TABLE "KalshiMarket" ADD COLUMN "propSubjectName" TEXT;

-- 3. ParlayLeg: what this leg is grading on. DEFAULT 'GAME_WINNER' so
-- existing rows grade correctly under the new settlement branch — without
-- the default this would require a backfill UPDATE for every existing leg.
-- SQLite allows ADD COLUMN with a constant DEFAULT, so this is a one-shot
-- ALTER (no rebuild-table needed).
ALTER TABLE "ParlayLeg" ADD COLUMN "legKind" TEXT NOT NULL DEFAULT 'GAME_WINNER';

-- 4. TeamGameStat: new table for team-level box-score stats. v1 only
-- stores corners; future prop kinds (shots, cards, …) add columns here.
-- Matches the Game/Team FK shape used elsewhere in the schema.
CREATE TABLE "TeamGameStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "corners" REAL,
    "raw" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "TeamGameStat_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TeamGameStat_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TeamGameStat_gameId_teamId_key" ON "TeamGameStat"("gameId", "teamId");
CREATE INDEX "TeamGameStat_teamId_idx" ON "TeamGameStat"("teamId");
