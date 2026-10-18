-- AlterTable
ALTER TABLE "Parlay" ADD COLUMN "externalId" TEXT;
ALTER TABLE "Parlay" ADD COLUMN "payout" REAL;

-- CreateIndex
CREATE UNIQUE INDEX "Parlay_externalId_key" ON "Parlay"("externalId");
