ALTER TABLE "GameEvent" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "EventParticipation" ADD COLUMN "race" TEXT NOT NULL DEFAULT 'Mortal', ADD COLUMN "voiceSeconds" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "textMessages" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "bossDamage" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "faction" TEXT NOT NULL DEFAULT 'Mortal';
CREATE TABLE "EventBoss" (
  "eventId" TEXT NOT NULL, "name" TEXT NOT NULL, "health" INTEGER NOT NULL, "maxHealth" INTEGER NOT NULL,
  "phase" INTEGER NOT NULL DEFAULT 0, "phases" JSONB NOT NULL DEFAULT '[]', "actions" JSONB NOT NULL DEFAULT '[]',
  "damageRules" JSONB NOT NULL DEFAULT '{}', "durationMs" INTEGER NOT NULL, "startedAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3), "outcome" TEXT NOT NULL DEFAULT 'pending',
  CONSTRAINT "EventBoss_pkey" PRIMARY KEY ("eventId"), CONSTRAINT "EventBoss_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "GameEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EventBoss_outcome_endsAt_idx" ON "EventBoss"("outcome", "endsAt");
CREATE TABLE "BossAction" (
  "interactionId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "userId" TEXT NOT NULL, "faction" TEXT NOT NULL,
  "action" TEXT NOT NULL, "damage" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BossAction_pkey" PRIMARY KEY ("interactionId"), CONSTRAINT "BossAction_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventBoss"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "BossAction_eventId_userId_idx" ON "BossAction"("eventId", "userId");
CREATE INDEX "BossAction_eventId_faction_idx" ON "BossAction"("eventId", "faction");
