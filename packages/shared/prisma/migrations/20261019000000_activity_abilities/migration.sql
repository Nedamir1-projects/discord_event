CREATE TABLE "VoiceProgress" ("userId" TEXT PRIMARY KEY, "seconds" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "TextProgress" ("userId" TEXT PRIMARY KEY, "messages" INTEGER NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "ActivityMessage" ("messageId" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ActivityMessage_userId_createdAt_idx" ON "ActivityMessage"("userId", "createdAt");
CREATE TABLE "GameEffect" ("id" TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL, "targetId" TEXT NOT NULL, "kind" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "data" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "GameEffect_targetId_expiresAt_idx" ON "GameEffect"("targetId", "expiresAt");
CREATE TABLE "AbilityCooldown" ("key" TEXT PRIMARY KEY, "readyAt" TIMESTAMP(3) NOT NULL);
ALTER TABLE "ActivityMessage" ADD COLUMN "contentHash" TEXT NOT NULL DEFAULT '';
