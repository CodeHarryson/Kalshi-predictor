-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "league" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "externalIds" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "league" TEXT NOT NULL,
    "teamId" TEXT,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "externalIds" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "league" TEXT NOT NULL,
    "startTime" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "externalIds" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Game_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Game_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlayerGameStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "points" REAL,
    "rebounds" REAL,
    "assists" REAL,
    "minutes" REAL,
    "raw" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "PlayerGameStat_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlayerGameStat_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamRating" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "rating" REAL NOT NULL DEFAULT 1500,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamRating_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KalshiMarket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticker" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "league" TEXT,
    "gameId" TEXT,
    "yesPrice" REAL,
    "noPrice" REAL,
    "closeTime" DATETIME,
    "status" TEXT,
    "raw" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KalshiMarket_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Parlay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "combinedProbability" REAL,
    "stake" REAL,
    "source" TEXT NOT NULL DEFAULT 'manual'
);

-- CreateTable
CREATE TABLE "ParlayLeg" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parlayId" TEXT NOT NULL,
    "kalshiMarketId" TEXT,
    "gameId" TEXT,
    "description" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'YES',
    "predictedProbability" REAL NOT NULL,
    "marketImpliedProbability" REAL,
    "actualOutcome" TEXT NOT NULL DEFAULT 'PENDING',
    "settledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ParlayLeg_parlayId_fkey" FOREIGN KEY ("parlayId") REFERENCES "Parlay" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParlayLeg_kalshiMarketId_fkey" FOREIGN KEY ("kalshiMarketId") REFERENCES "KalshiMarket" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ParlayLeg_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelFeatureLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parlayLegId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "predictedProbability" REAL NOT NULL,
    "actualOutcome" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelFeatureLog_parlayLegId_fkey" FOREIGN KEY ("parlayLegId") REFERENCES "ParlayLeg" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Team_league_idx" ON "Team"("league");

-- CreateIndex
CREATE UNIQUE INDEX "Team_league_name_key" ON "Team"("league", "name");

-- CreateIndex
CREATE INDEX "Player_league_idx" ON "Player"("league");

-- CreateIndex
CREATE INDEX "Player_teamId_idx" ON "Player"("teamId");

-- CreateIndex
CREATE INDEX "Game_league_startTime_idx" ON "Game"("league", "startTime");

-- CreateIndex
CREATE INDEX "Game_status_idx" ON "Game"("status");

-- CreateIndex
CREATE INDEX "PlayerGameStat_playerId_idx" ON "PlayerGameStat"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGameStat_gameId_playerId_key" ON "PlayerGameStat"("gameId", "playerId");

-- CreateIndex
CREATE INDEX "TeamRating_league_idx" ON "TeamRating"("league");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRating_teamId_key" ON "TeamRating"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "KalshiMarket_ticker_key" ON "KalshiMarket"("ticker");

-- CreateIndex
CREATE INDEX "KalshiMarket_league_idx" ON "KalshiMarket"("league");

-- CreateIndex
CREATE INDEX "KalshiMarket_gameId_idx" ON "KalshiMarket"("gameId");

-- CreateIndex
CREATE INDEX "ParlayLeg_parlayId_idx" ON "ParlayLeg"("parlayId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelFeatureLog_parlayLegId_key" ON "ModelFeatureLog"("parlayLegId");

-- CreateIndex
CREATE INDEX "ModelFeatureLog_league_idx" ON "ModelFeatureLog"("league");
