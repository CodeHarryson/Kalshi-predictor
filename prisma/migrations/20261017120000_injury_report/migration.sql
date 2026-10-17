-- CreateTable
CREATE TABLE "InjuryReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "league" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerExternalId" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "position" TEXT,
    "status" TEXT NOT NULL,
    "isStarter" BOOLEAN,
    "availabilityLoss" REAL NOT NULL,
    "impactElo" REAL NOT NULL,
    "reportedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "InjuryReport_league_teamId_idx" ON "InjuryReport"("league", "teamId");
