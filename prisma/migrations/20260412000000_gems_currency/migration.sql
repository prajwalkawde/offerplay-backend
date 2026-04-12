-- Add gemBalance to User
ALTER TABLE "User" ADD COLUMN "gemBalance" INTEGER NOT NULL DEFAULT 0;

-- CreateTable GemTransaction
CREATE TABLE "GemTransaction" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GemTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex GemTransaction
CREATE INDEX "GemTransaction_userId_idx" ON "GemTransaction"("userId");
CREATE INDEX "GemTransaction_createdAt_idx" ON "GemTransaction"("createdAt");

-- AddForeignKey GemTransaction
ALTER TABLE "GemTransaction" ADD CONSTRAINT "GemTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable SuperOfferTier: rename ticketCost → gemsCost, add rewardType, quizGemReward
ALTER TABLE "SuperOfferTier" RENAME COLUMN "ticketCost" TO "gemsCost";
ALTER TABLE "SuperOfferTier" ADD COLUMN "rewardType" TEXT NOT NULL DEFAULT 'COINS';
ALTER TABLE "SuperOfferTier" ADD COLUMN "quizGemReward" INTEGER NOT NULL DEFAULT 5;

-- AlterTable SuperOfferAttempt: rename ticketCost → gemsCost, add rewardType, gemsFromQuiz
ALTER TABLE "SuperOfferAttempt" RENAME COLUMN "ticketCost" TO "gemsCost";
ALTER TABLE "SuperOfferAttempt" ADD COLUMN "rewardType" TEXT NOT NULL DEFAULT 'COINS';
ALTER TABLE "SuperOfferAttempt" ADD COLUMN "gemsFromQuiz" INTEGER NOT NULL DEFAULT 0;
