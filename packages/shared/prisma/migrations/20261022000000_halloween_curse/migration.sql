CREATE TABLE "HalloweenCampaign" (
  "eventId" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "finalPuzzleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenCampaign_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "HalloweenCampaign_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "GameEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "Riddle"
  ADD COLUMN "campaignEventId" TEXT,
  ADD COLUMN "storyOrder" INTEGER,
  ADD COLUMN "opensAt" TIMESTAMP(3),
  ADD COLUMN "closesAt" TIMESTAMP(3),
  ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Riddle" ADD CONSTRAINT "Riddle_campaignEventId_fkey"
  FOREIGN KEY ("campaignEventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Riddle_campaignEventId_storyOrder_idx" ON "Riddle"("campaignEventId", "storyOrder");

ALTER TABLE "Quest" ADD COLUMN "campaignEventId" TEXT;
ALTER TABLE "Quest" ADD CONSTRAINT "Quest_campaignEventId_fkey"
  FOREIGN KEY ("campaignEventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Quest_campaignEventId_startsAt_endsAt_idx" ON "Quest"("campaignEventId", "startsAt", "endsAt");

CREATE TABLE "HalloweenChapter" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "opensAt" TIMESTAMP(3),
  "closesAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenChapter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HalloweenChapter_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "HalloweenChapter_eventId_order_key" ON "HalloweenChapter"("eventId", "order");
CREATE INDEX "HalloweenChapter_eventId_opensAt_closesAt_idx" ON "HalloweenChapter"("eventId", "opensAt", "closesAt");

CREATE TABLE "HalloweenParticipant" (
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastChapterOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "HalloweenParticipant_pkey" PRIMARY KEY ("eventId", "userId"),
  CONSTRAINT "HalloweenParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HalloweenSecretRole" (
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenSecretRole_pkey" PRIMARY KEY ("eventId", "userId"),
  CONSTRAINT "HalloweenSecretRole_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RiddleAttempt" (
  "riddleId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "hintsUsed" INTEGER NOT NULL DEFAULT 0,
  "solvedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiddleAttempt_pkey" PRIMARY KEY ("riddleId", "userId"),
  CONSTRAINT "RiddleAttempt_riddleId_fkey" FOREIGN KEY ("riddleId") REFERENCES "Riddle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HalloweenQuestProgress" (
  "questId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenQuestProgress_pkey" PRIMARY KEY ("questId", "userId"),
  CONSTRAINT "HalloweenQuestProgress_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "HalloweenPoll" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "options" TEXT[] NOT NULL,
  "opensAt" TIMESTAMP(3),
  "closesAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenPoll_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HalloweenPoll_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "HalloweenCampaign"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HalloweenPoll_eventId_status_closesAt_idx" ON "HalloweenPoll"("eventId", "status", "closesAt");

CREATE TABLE "HalloweenVote" (
  "pollId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "choice" TEXT NOT NULL,
  "votedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HalloweenVote_pkey" PRIMARY KEY ("pollId", "userId"),
  CONSTRAINT "HalloweenVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "HalloweenPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HalloweenVote_pollId_choice_idx" ON "HalloweenVote"("pollId", "choice");

CREATE TABLE "SharedPumpkin" (
  "id" TEXT NOT NULL,
  "slot" INTEGER NOT NULL,
  "pumpkinNumber" INTEGER NOT NULL DEFAULT 17,
  "guildId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "allowedAuthorIds" TEXT[] NOT NULL,
  "allowedChannelIds" TEXT[] NOT NULL,
  "reward" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SharedPumpkin_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SharedPumpkin_slot_key" ON "SharedPumpkin"("slot");
CREATE UNIQUE INDEX "SharedPumpkin_messageId_key" ON "SharedPumpkin"("messageId");
CREATE INDEX "SharedPumpkin_guildId_channelId_messageId_idx" ON "SharedPumpkin"("guildId", "channelId", "messageId");

CREATE TABLE "SharedPumpkinFind" (
  "pumpkinId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "foundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SharedPumpkinFind_pkey" PRIMARY KEY ("pumpkinId", "userId"),
  CONSTRAINT "SharedPumpkinFind_pumpkinId_fkey" FOREIGN KEY ("pumpkinId") REFERENCES "SharedPumpkin"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SharedPumpkinFind_userId_foundAt_idx" ON "SharedPumpkinFind"("userId", "foundAt");

CREATE TABLE "PumpkinCheckError" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "pumpkinId" TEXT,
  "guildId" TEXT,
  "channelId" TEXT,
  "messageId" TEXT,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PumpkinCheckError_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PumpkinCheckError_createdAt_idx" ON "PumpkinCheckError"("createdAt");
CREATE INDEX "PumpkinCheckError_code_createdAt_idx" ON "PumpkinCheckError"("code", "createdAt");
