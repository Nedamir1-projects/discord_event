CREATE TABLE "MatrixNight" (
  "eventId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'waiting',
  "durationMs" BIGINT NOT NULL DEFAULT 4406400000,
  "countdownMs" BIGINT NOT NULL DEFAULT 0,
  "deadlineAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "pausedPhase" TEXT,
  "remainingMs" BIGINT,
  "config" JSONB NOT NULL DEFAULT '{}',
  "outcome" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MatrixNight_pkey" PRIMARY KEY ("eventId"),
  CONSTRAINT "MatrixNight_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "GameEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixNight_phase_deadlineAt_idx" ON "MatrixNight"("phase", "deadlineAt");

CREATE TABLE "MatrixParticipant" (
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "faction" TEXT,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatrixParticipant_pkey" PRIMARY KEY ("eventId", "userId"),
  CONSTRAINT "MatrixParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MatrixNight"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixParticipant_eventId_role_idx" ON "MatrixParticipant"("eventId", "role");

CREATE TABLE "MatrixJail" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "scheduledEndAt" TIMESTAMP(3) NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "result" TEXT NOT NULL DEFAULT 'pending',
  "releaseResult" TEXT,
  CONSTRAINT "MatrixJail_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatrixJail_operationKey_key" UNIQUE ("operationKey"),
  CONSTRAINT "MatrixJail_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MatrixNight"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixJail_eventId_targetId_releasedAt_idx" ON "MatrixJail"("eventId", "targetId", "releasedAt");
CREATE INDEX "MatrixJail_scheduledEndAt_releasedAt_idx" ON "MatrixJail"("scheduledEndAt", "releasedAt");

CREATE TABLE "MatrixMission" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "faction" TEXT NOT NULL,
  "targetProgress" INTEGER NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "config" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'open',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MatrixMission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatrixMission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MatrixNight"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixMission_eventId_faction_status_idx" ON "MatrixMission"("eventId", "faction", "status");

CREATE TABLE "MatrixMissionAction" (
  "interactionId" TEXT NOT NULL,
  "missionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "progressAfter" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatrixMissionAction_pkey" PRIMARY KEY ("interactionId"),
  CONSTRAINT "MatrixMissionAction_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "MatrixMission"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MatrixSnapshot" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "guildId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'prepared',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "plannedChanges" JSONB NOT NULL,
  "roleStates" JSONB NOT NULL,
  "memberRoleState" JSONB NOT NULL,
  "outcomes" JSONB NOT NULL DEFAULT '[]',
  "restoredAt" TIMESTAMP(3),
  CONSTRAINT "MatrixSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatrixSnapshot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MatrixNight"("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixSnapshot_eventId_createdAt_idx" ON "MatrixSnapshot"("eventId", "createdAt");

CREATE TABLE "MatrixOperation" (
  "id" TEXT NOT NULL,
  "snapshotId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "desiredAdd" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MatrixOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatrixOperation_operationKey_key" UNIQUE ("operationKey"),
  CONSTRAINT "MatrixOperation_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MatrixSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MatrixOperation_snapshotId_status_idx" ON "MatrixOperation"("snapshotId", "status");
