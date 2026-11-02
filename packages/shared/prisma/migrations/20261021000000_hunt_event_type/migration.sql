ALTER TABLE "GameEvent" ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'general';
UPDATE "GameEvent" SET "eventType" = 'hunt' WHERE "settings" ? 'durationMs';
