-- CreateTable
CREATE TABLE "PlayerGameLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "gameDate" DATETIME NOT NULL,
    "stats" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlayerGameLog_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGameLog_playerId_eventId_key" ON "PlayerGameLog"("playerId", "eventId");

-- CreateIndex
CREATE INDEX "PlayerGameLog_playerId_gameDate_idx" ON "PlayerGameLog"("playerId", "gameDate");
