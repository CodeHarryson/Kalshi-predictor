-- Make Game.externalId required (was nullable to allow orphan rows during
-- initial provider onboarding). All 10 existing dev rows already have an
-- externalId, so this is a no-op for dev data. For production, backfill
-- Game.externalId from the provider before applying this migration.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "league" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "externalId" TEXT NOT NULL,
    "ratingApplied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Game_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Game_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Game" ("id", "league", "startTime", "status", "homeTeamId", "awayTeamId", "homeScore", "awayScore", "externalId", "ratingApplied", "createdAt", "updatedAt")
SELECT "id", "league", "startTime", "status", "homeTeamId", "awayTeamId", "homeScore", "awayScore", "externalId", "ratingApplied", "createdAt", "updatedAt" FROM "Game";
DROP TABLE "Game";
ALTER TABLE "new_Game" RENAME TO "Game";
CREATE INDEX "Game_league_startTime_idx" ON "Game"("league", "startTime");
CREATE INDEX "Game_status_idx" ON "Game"("status");
CREATE UNIQUE INDEX "Game_league_externalId_key" ON "Game"("league", "externalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
