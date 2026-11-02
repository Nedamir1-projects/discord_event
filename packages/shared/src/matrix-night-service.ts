import { Prisma } from './generated/prisma/client.js';
import { getDatabase } from './database.js';
import { randomInt } from 'node:crypto';

export const MATRIX_DEFAULT_DURATION_MS = 1224 * 60 * 60 * 1000;
export const MATRIX_SNAPSHOT_SCHEMA_VERSION = 1;
export const MATRIX_ROLES = [
  'Prophet',
  'Punishers',
  'Rebels',
  'Prisoners',
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

export interface MatrixDiscordRole {
  id: string;
  name: string;
  position: number;
  permissions: string[];
}
export interface MatrixDiscordAdapter {
  fetchGuildMemberIds?(guildId: string): Promise<string[]>;
  fetchRoles(guildId: string, roleIds: string[]): Promise<MatrixDiscordRole[]>;
  botHighestRolePosition(guildId: string): Promise<number>;
  fetchMemberRoleIds(guildId: string, userId: string): Promise<string[]>;
  hasRole(guildId: string, roleId: string): Promise<boolean>;
  addRole(
    guildId: string,
    userId: string,
    roleId: string,
    reason: string,
  ): Promise<void>;
  removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    reason: string,
  ): Promise<void>;
}

export class MatrixNightError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class DiscordRequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  constructor(
    private readonly intervalMs = 1100,
    private readonly sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}
  run<T>(action: () => Promise<T>): Promise<T> {
    const current = this.tail.then(async () => {
      const waitMs = Math.max(0, this.nextAt - Date.now());
      if (waitMs) await this.sleep(waitMs);
      this.nextAt = Date.now() + this.intervalMs;
      return action();
    });
    this.tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

const queuedAdapters = new WeakSet<MatrixDiscordAdapter>();
export function withDiscordRequestQueue(
  adapter: MatrixDiscordAdapter,
  queue = new DiscordRequestQueue(),
): MatrixDiscordAdapter {
  const wrapped: MatrixDiscordAdapter = {
    ...(adapter.fetchGuildMemberIds
      ? {
          fetchGuildMemberIds: (guildId: string) =>
            queue.run(() => adapter.fetchGuildMemberIds!(guildId)),
        }
      : {}),
    fetchRoles: (guildId, ids) =>
      queue.run(() => adapter.fetchRoles(guildId, ids)),
    botHighestRolePosition: (guildId) =>
      queue.run(() => adapter.botHighestRolePosition(guildId)),
    fetchMemberRoleIds: (guildId, userId) =>
      queue.run(() => adapter.fetchMemberRoleIds(guildId, userId)),
    hasRole: (guildId, roleId) =>
      queue.run(() => adapter.hasRole(guildId, roleId)),
    addRole: (guildId, userId, roleId, reason) =>
      queue.run(() => adapter.addRole(guildId, userId, roleId, reason)),
    removeRole: (guildId, userId, roleId, reason) =>
      queue.run(() => adapter.removeRole(guildId, userId, roleId, reason)),
  };
  queuedAdapters.add(wrapped);
  return wrapped;
}
function queued(adapter: MatrixDiscordAdapter): MatrixDiscordAdapter {
  return queuedAdapters.has(adapter)
    ? adapter
    : withDiscordRequestQueue(adapter);
}

type RoleConfig = Record<MatrixRole, string>;
type NightConfig = {
  roles: RoleConfig;
  signupChannelId?: string;
  provisioning?: { channels: Record<string, string>; categoryId: string };
  maxParticipantsByRole?: Partial<Record<MatrixRole, number>>;
  maxJailDurationMs?: number;
  objectives?: unknown;
  victoryRules?: unknown;
  randomAssignment?: {
    completedAt: string;
    memberCount: number;
    counts: Partial<Record<MatrixRole, number>>;
  };
};
const db = () => getDatabase();

function validateDuration(
  value: number,
  name: string,
  allowZero = false,
): void {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 365 * 24 * 60 * 60 * 1000
  )
    throw new MatrixNightError(
      `${name}: задана недопустимая длительность.`,
      'invalid_duration',
    );
}

export async function createMatrixNight(
  actorId: string,
  input: {
    guildId: string;
    title: string;
    signupChannelId?: string;
    durationMs?: number;
    countdownMs: number;
    roles: RoleConfig;
    maxParticipantsByRole?: Partial<Record<MatrixRole, number>>;
    maxJailDurationMs?: number;
    provisioning?: { channels: Record<string, string>; categoryId: string };
    objectives?: unknown;
    victoryRules?: unknown;
  },
) {
  const durationMs = input.durationMs ?? MATRIX_DEFAULT_DURATION_MS;
  validateDuration(durationMs, 'duration');
  validateDuration(input.countdownMs, 'countdown', true);
  if (
    new Set(Object.values(input.roles)).size !== MATRIX_ROLES.length ||
    Object.values(input.roles).some((id) => !/^\d{17,20}$/.test(id))
  )
    throw new MatrixNightError(
      'Для четырёх игровых ролей укажите разные Discord ID ролей.',
      'invalid_roles',
    );
  if (input.maxJailDurationMs !== undefined)
    validateDuration(input.maxJailDurationMs, 'maximum jail duration');
  const config: NightConfig = {
    roles: input.roles,
    ...(input.signupChannelId ? { signupChannelId: input.signupChannelId } : {}),
    ...(input.provisioning ? { provisioning: input.provisioning } : {}),
    ...(input.maxParticipantsByRole
      ? { maxParticipantsByRole: input.maxParticipantsByRole }
      : {}),
    ...(input.maxJailDurationMs !== undefined
      ? { maxJailDurationMs: input.maxJailDurationMs }
      : {}),
    ...(input.objectives !== undefined ? { objectives: input.objectives } : {}),
    ...(input.victoryRules !== undefined
      ? { victoryRules: input.victoryRules }
      : {}),
  };
  return db().$transaction(async (tx) => {
    const event = await tx.gameEvent.create({
      data: {
        eventType: 'matrix-night',
        title: input.title.trim() || 'Судная ночь — Перезагрузка Матрицы',
        status: 'waiting',
        createdBy: actorId,
        settings: { durationMs },
      },
    });
    await tx.matrixNight.create({
      data: {
        eventId: event.id,
        guildId: input.guildId,
        durationMs: BigInt(durationMs),
        countdownMs: BigInt(input.countdownMs),
        config: config as never,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'matrix.create',
        objectType: 'event',
        objectId: event.id,
        result: 'success',
        details: {
          durationMs,
          countdownMs: input.countdownMs,
          guildId: input.guildId,
        },
      },
    });
    return event;
  });
}

export async function assignMatrixRole(
  actorId: string,
  eventId: string,
  userId: string,
  role: MatrixRole,
  faction?: string,
) {
  if (!MATRIX_ROLES.includes(role))
    throw new MatrixNightError('Неизвестная игровая роль.', 'invalid_role');
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || night.phase !== 'waiting' || night.pausedAt)
    throw new MatrixNightError(
      'Состав ролей можно менять только до запуска.',
      'wrong_phase',
    );
  const config = night.config as unknown as NightConfig;
  const registeredParticipant = await db().matrixParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!registeredParticipant)
    throw new MatrixNightError(
      'Игрок должен сначала записаться через кнопку регистрации.',
      'participant_not_registered',
    );
  const cap = config.maxParticipantsByRole?.[role];
  if (
    cap !== undefined &&
    (await db().matrixParticipant.count({ where: { eventId, role } })) >= cap &&
    !(await db().matrixParticipant.findUnique({
      where: { eventId_userId: { eventId, userId } },
    }))
  )
    throw new MatrixNightError(
      'Достигнут настроенный лимит участников этой роли.',
      'role_capacity',
    );
  const member = await db().matrixParticipant.update({
    where: { eventId_userId: { eventId, userId } },
    data: { role, faction: faction ?? null },
  });
  await db().auditLog.create({
    data: {
      actorId,
      action: 'matrix.role.assign',
      objectType: 'event',
      objectId: eventId,
      result: 'success',
      details: { role },
    },
  });
  return member;
}

export async function registerMatrixParticipant(
  eventId: string,
  guildId: string,
  userId: string,
) {
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || night.guildId !== guildId)
    throw new MatrixNightError('Событие не найдено на этом сервере.', 'wrong_guild');
  if (night.phase !== 'waiting' || night.snapshotId)
    throw new MatrixNightError('Регистрация закрыта: Судная ночь уже запущена.', 'wrong_phase');
  const existing = await db().matrixParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (existing) return { duplicate: true };
  await db().matrixParticipant.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, role: 'Pending', faction: null },
    update: {},
  });
  return { duplicate: false };
}

function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const selected = randomInt(index + 1);
    [result[index], result[selected]] = [result[selected]!, result[index]!];
  }
  return result;
}

/** Randomly assigns every registered participant to exactly one Matrix faction. */
export async function randomlyAssignMatrixParticipants(
  actorId: string,
  eventId: string,
  memberIds: string[],
  now = new Date(),
) {
  const uniqueIds = [...new Set(memberIds.filter((id) => id.trim()))];
  if (!uniqueIds.length)
    throw new MatrixNightError(
      'На сервере нет доступных участников для распределения.',
      'no_members',
    );

  return db().$transaction(
    async (tx) => {
      const night = await tx.matrixNight.findUnique({ where: { eventId } });
      if (!night || night.phase !== 'waiting' || night.snapshotId)
        throw new MatrixNightError(
          'Случайное распределение доступно только до запуска.',
          'wrong_phase',
        );
      const config = configOf(night);
      if (config.randomAssignment?.completedAt) {
        const existing = await tx.matrixParticipant.findMany({
          where: { eventId },
        });
        return {
          participants: existing.length,
          counts: config.randomAssignment.counts,
          duplicate: true,
        };
      }

      const available = shuffled(uniqueIds);
      const caps = config.maxParticipantsByRole ?? {};
      const countFor = (role: MatrixRole, desired: number) =>
        Math.min(desired, caps[role] ?? desired);
      const prophetCount = countFor('Prophet', 1);
      const punishersCount = countFor(
        'Punishers',
        available.length < 2
          ? 0
          : Math.min(35, Math.max(1, Math.round(available.length * 0.15))),
      );
      const prisonersCount = countFor(
        'Prisoners',
        available.length < 5
          ? 0
          : Math.min(10, Math.max(1, Math.round(available.length * 0.05))),
      );
      const counts: Record<MatrixRole, number> = {
        Prophet: prophetCount,
        Punishers: punishersCount,
        Rebels: 0,
        Prisoners: prisonersCount,
      };
      counts.Rebels =
        available.length - prophetCount - punishersCount - prisonersCount;
      if (counts.Rebels < 0)
        throw new MatrixNightError(
          'Не удалось сформировать состав фракций для текущего количества участников.',
          'invalid_distribution',
        );
      if (
        caps.Rebels !== undefined &&
        counts.Rebels > caps.Rebels
      )
        throw new MatrixNightError(
          'Лимит Повстанцев слишком мал, чтобы распределить всех участников.',
          'role_capacity',
        );

      const assignments: Array<{ userId: string; role: MatrixRole }> = [];
      let cursor = 0;
      for (const role of MATRIX_ROLES) {
        for (let index = 0; index < counts[role]; index++)
          assignments.push({ userId: available[cursor++]!, role });
      }
      await tx.matrixParticipant.deleteMany({ where: { eventId } });
      if (assignments.length)
        await tx.matrixParticipant.createMany({
          data: assignments.map(({ userId, role }) => ({
            eventId,
            userId,
            role,
            faction: role,
          })),
        });
      await tx.matrixNight.update({
        where: { eventId },
        data: {
          config: {
            ...config,
            randomAssignment: {
              completedAt: now.toISOString(),
              memberCount: assignments.length,
              counts,
            },
          } as never,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'matrix.participants.random_assign',
          objectType: 'event',
          objectId: eventId,
          result: 'success',
          details: { memberCount: assignments.length, counts },
        },
      });
      return { participants: assignments.length, counts, duplicate: false };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

function configOf(night: { config: unknown }): NightConfig {
  return night.config as NightConfig;
}
function gameRoleIds(config: NightConfig): string[] {
  return [...new Set(Object.values(config.roles))];
}
function roleIdFor(config: NightConfig, role: string): string {
  if (!MATRIX_ROLES.includes(role as MatrixRole))
    throw new MatrixNightError(
      'В составе события обнаружена неизвестная роль.',
      'invalid_role',
    );
  return config.roles[role as MatrixRole];
}
const forbiddenPermissions = new Set([
  'Administrator',
  'ManageRoles',
  'ManageGuild',
  'ManageChannels',
  'ManageWebhooks',
  'KickMembers',
  'BanMembers',
  'ModerateMembers',
  'ManageMessages',
  'MentionEveryone',
  'ManageNicknames',
  'ManageEvents',
  'ManageThreads',
  'ManageGuildExpressions',
]);

async function validateGuildRoles(
  adapter: MatrixDiscordAdapter,
  guildId: string,
  roleIds: string[],
) {
  const roles = await adapter.fetchRoles(guildId, roleIds);
  const top = await adapter.botHighestRolePosition(guildId);
  const map = new Map(roles.map((role) => [role.id, role]));
  for (const id of roleIds) {
    const role = map.get(id);
    if (!role)
      throw new MatrixNightError(
        `Игровая роль ${id} не найдена.`,
        'role_unavailable',
      );
    if (role.id === guildId || role.name === '@everyone')
      throw new MatrixNightError(
        'оль @everyone нельзя использовать как игровую роль.',
        'unsafe_role',
      );
    if (role.position >= top)
      throw new MatrixNightError(
        `Роль ${role.name} находится выше роли бота.`,
        'role_hierarchy',
      );
    if (
      role.permissions.some((permission) =>
        forbiddenPermissions.has(permission),
      )
    )
      throw new MatrixNightError(
        `Роль ${role.name} содержит опасные права.`,
        'unsafe_role',
      );
  }
  return roles;
}

export async function startMatrixNight(
  actorId: string,
  eventId: string,
  rawAdapter: MatrixDiscordAdapter,
  now = new Date(),
) {
  const adapter = queued(rawAdapter);
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || night.phase !== 'waiting' || night.snapshotId)
    throw new MatrixNightError(
      'Событие не находится в ожидании.',
      'wrong_phase',
    );
  const config = configOf(night);
  const roleIds = gameRoleIds(config);
  const roleStates = await validateGuildRoles(adapter, night.guildId, roleIds);
  const signups = await db().matrixParticipant.findMany({
    where: { eventId },
    select: { userId: true },
  });
  const currentMemberIds = adapter.fetchGuildMemberIds
    ? new Set(await adapter.fetchGuildMemberIds(night.guildId))
    : undefined;
  const randomAssignment = await randomlyAssignMatrixParticipants(
    actorId,
    eventId,
    signups
      .map((signup) => signup.userId)
      .filter((userId) => !currentMemberIds || currentMemberIds.has(userId)),
    now,
  );
  const participants = await db().matrixParticipant.findMany({
    where: { eventId },
    orderBy: { assignedAt: 'asc' },
  });
  const memberRoleState: Record<string, string[]> = {};
  for (const participant of participants)
    memberRoleState[participant.userId] = await adapter.fetchMemberRoleIds(
      night.guildId,
      participant.userId,
    );
  const plannedChanges = participants.map((participant) => ({
    userId: participant.userId,
    roleId: roleIdFor(config, participant.role),
    operation: 'grant',
  }));
  const snapshot = await db().matrixSnapshot.create({
    data: {
      eventId,
      guildId: night.guildId,
      schemaVersion: MATRIX_SNAPSHOT_SCHEMA_VERSION,
      plannedChanges: plannedChanges as never,
      roleStates: roleStates as never,
      memberRoleState: memberRoleState as never,
    },
  });
  const countdownMs = Number(night.countdownMs);
  const phase = countdownMs ? 'countdown' : 'active';
  const claimed = await db().$transaction(async (tx) => {
    const lock = await tx.matrixNight.updateMany({
      where: { eventId, phase: 'waiting', snapshotId: null },
      data: {
        snapshotId: snapshot.id,
        phase,
        deadlineAt: new Date(
          now.getTime() + (countdownMs || Number(night.durationMs)),
        ),
      },
    });
    if (!lock.count) return false;
    await tx.gameEvent.update({
      where: { id: eventId },
      data: {
        status: phase,
        startsAt: now,
        endsAt: new Date(
          now.getTime() + (countdownMs || Number(night.durationMs)),
        ),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'matrix.start',
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: { snapshotId: snapshot.id, phase },
      },
    });
    return true;
  });
  if (!claimed) {
    await db().matrixSnapshot.delete({ where: { id: snapshot.id } });
    throw new MatrixNightError(
      'Событие уже запускается другим действием.',
      'start_conflict',
    );
  }
  const roleOperations = !countdownMs
    ? await applyAssignedRoles(eventId, snapshot.id, adapter)
    : [];
  return {
    phase,
    snapshotId: snapshot.id,
    randomAssignment,
    roleOperations,
  };
}

async function applyOperation(
  adapter: MatrixDiscordAdapter,
  snapshotId: string,
  kind: string,
  guildId: string,
  userId: string,
  roleId: string,
  desiredAdd: boolean,
  operationKey: string,
) {
  const operation = await db().matrixOperation.upsert({
    where: { operationKey },
    create: {
      snapshotId,
      operationKey,
      kind,
      targetId: userId,
      roleId,
      desiredAdd,
    },
    update: {},
  });
  if (operation.status === 'complete' || operation.status === 'skipped')
    return operation.status;
  await db().matrixOperation.update({
    where: { id: operation.id },
    data: { status: 'running', attempts: { increment: 1 }, lastError: null },
  });
  try {
    const roleExists = await adapter.hasRole(guildId, roleId);
    if (!roleExists) {
      await db().matrixOperation.update({
        where: { id: operation.id },
        data: { status: 'skipped', lastError: 'role_unavailable' },
      });
      return 'skipped';
    }
    const current = await adapter.fetchMemberRoleIds(guildId, userId);
    if (current.includes(roleId) !== desiredAdd) {
      if (desiredAdd)
        await adapter.addRole(guildId, userId, roleId, `Matrix event ${kind}`);
      else
        await adapter.removeRole(
          guildId,
          userId,
          roleId,
          `Matrix event ${kind}`,
        );
    }
    await db().matrixOperation.update({
      where: { id: operation.id },
      data: { status: 'complete', lastError: null },
    });
    return 'complete';
  } catch (error) {
    const message = error instanceof Error ? error.name : 'UnknownError';
    await db().matrixOperation.update({
      where: { id: operation.id },
      data: { status: 'failed', lastError: message },
    });
    return 'failed';
  }
}

async function applyAssignedRoles(
  eventId: string,
  snapshotId: string,
  rawAdapter: MatrixDiscordAdapter,
) {
  const adapter = queued(rawAdapter);
  const [night, participants] = await Promise.all([
    db().matrixNight.findUniqueOrThrow({ where: { eventId } }),
    db().matrixParticipant.findMany({ where: { eventId } }),
  ]);
  const config = configOf(night);
  const snapshot = await db().matrixSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
  });
  const originalMemberRoles = snapshot.memberRoleState as Record<string, string[]>;
  const outcomes: Array<{ userId: string; roleId: string; status: string }> =
    [];
  for (const participant of participants) {
    const roleId = roleIdFor(config, participant.role);
    for (const oldRoleId of gameRoleIds(config)) {
      if (
        oldRoleId === roleId ||
        !originalMemberRoles[participant.userId]?.includes(oldRoleId)
      )
        continue;
      const removeStatus = await applyOperation(
        adapter,
        snapshotId,
        'clear_faction',
        night.guildId,
        participant.userId,
        oldRoleId,
        false,
        `matrix:clear:${eventId}:${participant.userId}:${oldRoleId}`,
      );
      outcomes.push({
        userId: participant.userId,
        roleId: oldRoleId,
        status: removeStatus,
      });
    }
    const status = await applyOperation(
      adapter,
      snapshotId,
      'assign',
      night.guildId,
      participant.userId,
      roleId,
      true,
      `matrix:assign:${eventId}:${participant.userId}:${roleId}`,
    );
    outcomes.push({ userId: participant.userId, roleId, status });
  }
  await db().matrixSnapshot.update({
    where: { id: snapshotId },
    data: {
      status: outcomes.some((x) => x.status === 'failed')
        ? 'partial'
        : 'applied',
      outcomes: outcomes as never,
    },
  });
  return outcomes;
}

export async function pauseMatrixNight(
  actorId: string,
  eventId: string,
  now = new Date(),
) {
  return db().$transaction(async (tx) => {
    const night = await tx.matrixNight.findUniqueOrThrow({
      where: { eventId },
    });
    if (
      !['countdown', 'active'].includes(night.phase) ||
      night.pausedAt ||
      !night.deadlineAt
    )
      throw new MatrixNightError(
        'Нельзя приостановить событие в текущем состоянии.',
        'wrong_phase',
      );
    const remainingMs = BigInt(
      Math.max(0, night.deadlineAt.getTime() - now.getTime()),
    );
    await tx.matrixNight.update({
      where: { eventId },
      data: {
        pausedAt: now,
        pausedPhase: night.phase,
        remainingMs,
        deadlineAt: null,
      },
    });
    await tx.gameEvent.update({
      where: { id: eventId },
      data: { status: 'paused', endsAt: null },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'matrix.pause',
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: { remainingMs: remainingMs.toString() },
      },
    });
    return { paused: true, remainingMs };
  });
}

export async function resumeMatrixNight(
  actorId: string,
  eventId: string,
  now = new Date(),
) {
  return db().$transaction(async (tx) => {
    const night = await tx.matrixNight.findUniqueOrThrow({
      where: { eventId },
    });
    if (!night.pausedAt || !night.pausedPhase || night.remainingMs === null)
      throw new MatrixNightError('Событие не приостановлено.', 'wrong_phase');
    const deadlineAt = new Date(now.getTime() + Number(night.remainingMs));
    await tx.matrixNight.update({
      where: { eventId },
      data: {
        phase: night.pausedPhase,
        pausedAt: null,
        pausedPhase: null,
        deadlineAt,
        remainingMs: null,
      },
    });
    await tx.gameEvent.update({
      where: { id: eventId },
      data: { status: night.pausedPhase, endsAt: deadlineAt },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'matrix.resume',
        objectType: 'event',
        objectId: eventId,
        result: 'success',
      },
    });
    return { phase: night.pausedPhase, deadlineAt };
  });
}

export async function addMatrixMission(
  actorId: string,
  eventId: string,
  input: {
    title: string;
    description: string;
    faction: string;
    targetProgress: number;
    config?: unknown;
  },
) {
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || night.phase === 'ended')
    throw new MatrixNightError(
      'Нельзя добавить миссию в завершённое событие.',
      'wrong_phase',
    );
  if (
    !input.title.trim() ||
    !input.faction.trim() ||
    !Number.isSafeInteger(input.targetProgress) ||
    input.targetProgress < 1
  )
    throw new MatrixNightError(
      'Заполните миссию, фракцию и положительную цель прогресса.',
      'invalid_mission',
    );
  const mission = await db().matrixMission.create({
    data: { eventId, ...input, config: (input.config ?? {}) as never },
  });
  await db().auditLog.create({
    data: {
      actorId,
      action: 'matrix.mission.create',
      objectType: 'mission',
      objectId: mission.id,
      result: 'success',
      details: {
        eventId,
        faction: mission.faction,
        targetProgress: mission.targetProgress,
      },
    },
  });
  return mission;
}

export async function advanceMatrixMission(
  eventId: string,
  missionId: string,
  userId: string,
  interactionId: string,
  amount = 1,
) {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new MatrixNightError(
      'Прогресс должен быть положительным целым числом.',
      'invalid_progress',
    );
  return db().$transaction(
    async (tx) => {
      const night = await tx.matrixNight.findUniqueOrThrow({
        where: { eventId },
      });
      if (
        night.phase !== 'active' ||
        night.pausedAt ||
        (night.deadlineAt && night.deadlineAt <= new Date())
      )
        throw new MatrixNightError(
          'Миссии доступны только во время активной фазы.',
          'wrong_phase',
        );
      const participant = await tx.matrixParticipant.findUnique({
        where: { eventId_userId: { eventId, userId } },
      });
      if (participant?.role !== 'Rebels')
        throw new MatrixNightError(
          'Миссии доступны только назначенным повстанцам.',
          'not_authorized',
        );
      const jail = await tx.matrixJail.findFirst({
        where: {
          eventId,
          targetId: userId,
          releasedAt: null,
          scheduledEndAt: { gt: new Date() },
        },
      });
      if (jail)
        throw new MatrixNightError(
          'Заключённый участник не может выполнять миссии.',
          'jailed',
        );
      const prior = await tx.matrixMissionAction.findUnique({
        where: { interactionId },
      });
      if (prior) return { duplicate: true, progress: prior.progressAfter };
      const candidateMission = await tx.matrixMission.findFirst({
        where: { id: missionId, eventId, status: 'open' },
      });
      const normalizeFaction = (faction: string) => {
        const normalized = faction.trim().toLocaleLowerCase('ru-RU').replace(/[\s_-]+/g, '');
        return ['rebel', 'rebels', 'повстанцы', 'повстанец'].includes(normalized)
          ? 'rebels'
          : normalized;
      };
      const mission = candidateMission &&
        normalizeFaction(candidateMission.faction) === normalizeFaction(participant.faction ?? 'Rebels')
        ? candidateMission
        : null;
      if (!mission)
        throw new MatrixNightError(
          'Миссия недоступна этой фракции.',
          'mission_unavailable',
        );
      const progress = Math.min(
        mission.targetProgress,
        mission.progress + amount,
      );
      await tx.matrixMission.update({
        where: { id: mission.id },
        data: {
          progress,
          ...(progress >= mission.targetProgress ? { status: 'complete' } : {}),
        },
      });
      await tx.matrixMissionAction.create({
        data: {
          interactionId,
          missionId,
          userId,
          amount,
          progressAfter: progress,
        },
      });
      return {
        duplicate: false,
        progress,
        completed: progress >= mission.targetProgress,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function recordJailOperation(
  adapter: MatrixDiscordAdapter,
  night: { guildId: string },
  snapshotId: string,
  eventId: string,
  targetId: string,
  add: boolean,
  key: string,
) {
  const config = configOf(
    await db().matrixNight.findUniqueOrThrow({ where: { eventId } }),
  );
  return applyOperation(
    queued(adapter),
    snapshotId,
    add ? 'jail' : 'unjail',
    night.guildId,
    targetId,
    config.roles.Prisoners,
    add,
    key,
  );
}

export async function jailMatrixPlayer(
  actorId: string,
  eventId: string,
  targetId: string,
  reason: string,
  durationMs: number,
  interactionId: string,
  adapter: MatrixDiscordAdapter,
  now = new Date(),
) {
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (
    !night ||
    night.phase !== 'active' ||
    night.pausedAt ||
    (night.deadlineAt && night.deadlineAt <= now)
  )
    throw new MatrixNightError(
      'Заключение возможно только в активной фазе.',
      'wrong_phase',
    );
  const actor = await db().matrixParticipant.findUnique({
    where: { eventId_userId: { eventId, userId: actorId } },
  });
  if (actor?.role !== 'Punishers')
    throw new MatrixNightError(
      'Команда доступна только карателям.',
      'not_authorized',
    );
  const actorJail = await db().matrixJail.findFirst({
    where: {
      eventId,
      targetId: actorId,
      releasedAt: null,
      scheduledEndAt: { gt: now },
    },
  });
  if (actorJail)
    throw new MatrixNightError(
      'Заключённый участник не может выполнять игровые команды.',
      'jailed',
    );
  const target = await db().matrixParticipant.findUnique({
    where: { eventId_userId: { eventId, userId: targetId } },
  });
  if (!target || targetId === actorId)
    throw new MatrixNightError(
      'Цель должна быть другим участником события.',
      'invalid_target',
    );
  const config = configOf(night);
  if (!config.maxJailDurationMs || durationMs > config.maxJailDurationMs)
    throw new MatrixNightError(
      'Администратор не настроил допустимый срок заключения или срок превышен.',
      'duration_not_configured',
    );
  validateDuration(durationMs, 'jail');
  if (!reason.trim())
    throw new MatrixNightError('Укажите причину заключения.', 'missing_reason');
  const existing = await db().matrixJail.findUnique({
    where: { operationKey: interactionId },
  });
  if (existing) return { jail: existing, duplicate: true };
  const active = await db().matrixJail.findFirst({
    where: { eventId, targetId, releasedAt: null, scheduledEndAt: { gt: now } },
  });
  if (active)
    throw new MatrixNightError(
      'Участник уже находится в заключении.',
      'already_jailed',
    );
  const jail = await db().matrixJail.create({
    data: {
      eventId,
      operationKey: interactionId,
      actorId,
      targetId,
      reason: reason.trim(),
      scheduledEndAt: new Date(now.getTime() + durationMs),
    },
  });
  const snapshot = await db().matrixSnapshot.findFirst({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot)
    throw new MatrixNightError(
      'Снимок перед изменениями не найден.',
      'snapshot_missing',
    );
  const result = await recordJailOperation(
    adapter,
    night,
    snapshot.id,
    eventId,
    targetId,
    true,
    `matrix:jail:${jail.id}`,
  );
  await db().matrixJail.update({ where: { id: jail.id }, data: { result } });
  await db().auditLog.create({
    data: {
      actorId,
      action: 'matrix.jail',
      objectType: 'jail',
      objectId: jail.id,
      result: result === 'failed' ? 'failure' : 'success',
      details: {
        eventId,
        targetId,
        reason: reason.trim(),
        scheduledEndAt: jail.scheduledEndAt.toISOString(),
        operationStatus: result,
      },
    },
  });
  return { jail, duplicate: false, result };
}

export async function unjailMatrixPlayer(
  actorId: string,
  eventId: string,
  targetId: string,
  interactionId: string,
  adapter: MatrixDiscordAdapter,
  now = new Date(),
  system = false,
) {
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || (!system && (night.phase !== 'active' || night.pausedAt)))
    throw new MatrixNightError(
      'Освобождение недоступно в текущей фазе.',
      'wrong_phase',
    );
  if (!system) {
    const actor = await db().matrixParticipant.findUnique({
      where: { eventId_userId: { eventId, userId: actorId } },
    });
    if (actor?.role !== 'Rebels')
      throw new MatrixNightError(
        'Команда доступна только повстанцам.',
        'not_authorized',
      );
    const actorJail = await db().matrixJail.findFirst({
      where: {
        eventId,
        targetId: actorId,
        releasedAt: null,
        scheduledEndAt: { gt: now },
      },
    });
    if (actorJail)
      throw new MatrixNightError(
        'Заключённый участник не может выполнять игровые команды.',
        'jailed',
      );
  }
  const jail = await db().matrixJail.findFirst({
    where: { eventId, targetId, releasedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (!jail)
    throw new MatrixNightError(
      'Активное заключение не найдено.',
      'jail_missing',
    );
  const snapshot = await db().matrixSnapshot.findFirst({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
  });
  if (!snapshot)
    throw new MatrixNightError(
      'Снимок перед изменениями не найден.',
      'snapshot_missing',
    );
  const nightConfig = configOf(night);
  const original =
    (snapshot.memberRoleState as Record<string, string[]>)[targetId] ?? [];
  const targetParticipant = await db().matrixParticipant.findUnique({
    where: { eventId_userId: { eventId, userId: targetId } },
  });
  const otherJails = await db().matrixJail.count({
    where: {
      eventId,
      targetId,
      id: { not: jail.id },
      releasedAt: null,
      scheduledEndAt: { gt: now },
    },
  });
  const shouldKeepPrisonerRole =
    original.includes(nightConfig.roles.Prisoners) ||
    targetParticipant?.role === 'Prisoners' ||
    otherJails > 0;
  const result = shouldKeepPrisonerRole
    ? 'complete'
    : await recordJailOperation(
        adapter,
        night,
        snapshot.id,
        eventId,
        targetId,
        false,
        `matrix:unjail:${jail.id}:${interactionId}`,
      );
  const updated = await db().matrixJail.update({
    where: { id: jail.id },
    data: {
      releasedAt: now,
      releaseResult: result,
      result: result === 'failed' ? 'release_failed' : 'released',
    },
  });
  await db().auditLog.create({
    data: {
      actorId,
      action: 'matrix.unjail',
      objectType: 'jail',
      objectId: jail.id,
      result: result === 'failed' ? 'failure' : 'success',
      details: {
        eventId,
        targetId,
        operationStatus: result,
        automatic: system,
      },
    },
  });
  return updated;
}

async function restoreSnapshot(
  adapterRaw: MatrixDiscordAdapter,
  snapshotId: string,
) {
  const adapter = queued(adapterRaw);
  const snapshot = await db().matrixSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
  });
  if (snapshot.status === 'restored')
    return { restored: 0, skipped: 0, errors: 0 };
  await db().matrixSnapshot.update({
    where: { id: snapshotId },
    data: { status: 'restoring' },
  });
  const roleStates = snapshot.roleStates as unknown as MatrixDiscordRole[];
  const roleIds = roleStates.map((role) => role.id);
  const currentRoles = await adapter
    .fetchRoles(snapshot.guildId, roleIds)
    .catch(() => []);
  const available = new Set(currentRoles.map((role) => role.id));
  const members = snapshot.memberRoleState as Record<string, string[]>;
  const outcomes: Array<{ userId: string; roleId: string; status: string }> =
    [];
  for (const [userId, originalIds] of Object.entries(members)) {
    let current: string[];
    try {
      current = await adapter.fetchMemberRoleIds(snapshot.guildId, userId);
    } catch {
      outcomes.push({
        userId,
        roleId: '*',
        status: 'skipped_member_unavailable',
      });
      continue;
    }
    for (const roleId of roleIds) {
      if (!available.has(roleId)) {
        outcomes.push({ userId, roleId, status: 'skipped_role_unavailable' });
        continue;
      }
      const desiredAdd = originalIds.includes(roleId);
      if (current.includes(roleId) === desiredAdd) {
        outcomes.push({ userId, roleId, status: 'already_restored' });
        continue;
      }
      const status = await applyOperation(
        adapter,
        snapshot.id,
        'restore',
        snapshot.guildId,
        userId,
        roleId,
        desiredAdd,
        `matrix:restore:${snapshot.id}:${userId}:${roleId}`,
      );
      outcomes.push({ userId, roleId, status });
    }
  }
  const errors = outcomes.filter((x) => x.status === 'failed').length;
  const skipped = outcomes.filter((x) => x.status.startsWith('skipped')).length;
  await db().matrixSnapshot.update({
    where: { id: snapshot.id },
    data: {
      status: errors ? 'partial' : 'restored',
      restoredAt: errors ? null : new Date(),
      outcomes: outcomes as never,
    },
  });
  await db().auditLog.create({
    data: {
      actorId: 'system',
      action: 'matrix.snapshot.restore',
      objectType: 'snapshot',
      objectId: snapshot.id,
      result: errors ? 'failure' : 'success',
      details: {
        restored: outcomes.filter((x) =>
          ['complete', 'already_restored'].includes(x.status),
        ).length,
        skipped,
        errors,
      },
    },
  });
  return {
    restored: outcomes.filter((x) =>
      ['complete', 'already_restored'].includes(x.status),
    ).length,
    skipped,
    errors,
  };
}

export async function endMatrixNight(
  actorId: string,
  eventId: string,
  adapter: MatrixDiscordAdapter,
  outcome = 'ended',
  now = new Date(),
) {
  const night = await db().matrixNight.findUnique({ where: { eventId } });
  if (!night || night.phase === 'ended')
    throw new MatrixNightError(
      'Событие уже завершено или не найдено.',
      'wrong_phase',
    );
  await db().$transaction(async (tx) => {
    await tx.matrixNight.update({
      where: { eventId },
      data: {
        phase: 'ended',
        deadlineAt: now,
        pausedAt: null,
        pausedPhase: null,
        remainingMs: null,
        outcome,
      },
    });
    await tx.gameEvent.update({
      where: { id: eventId },
      data: { status: 'ended', endsAt: now },
    });
    await tx.matrixJail.updateMany({
      where: { eventId, releasedAt: null },
      data: {
        releasedAt: now,
        releaseResult: 'event_ended',
        result: 'event_ended',
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action:
          actorId === 'system' ? 'matrix.deadline.end' : 'matrix.emergency_end',
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: { outcome },
      },
    });
  });
  const snapshot = await db().matrixSnapshot.findFirst({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
  });
  return snapshot
    ? restoreSnapshot(adapter, snapshot.id)
    : { restored: 0, skipped: 0, errors: 0 };
}

export async function recoverMatrixNights(
  adapter: MatrixDiscordAdapter,
  now = new Date(),
) {
  const due = await db().matrixNight.findMany({
    where: {
      phase: { in: ['countdown', 'active'] },
      pausedAt: null,
      deadlineAt: { lte: now },
    },
  });
  let activated = 0;
  let ended = 0;
  for (const night of due) {
    if (night.phase === 'countdown') {
      const activeDeadline = new Date(now.getTime() + Number(night.durationMs));
      const updated = await db().$transaction(async (tx) => {
        const result = await tx.matrixNight.updateMany({
          where: {
            eventId: night.eventId,
            phase: 'countdown',
            pausedAt: null,
            deadlineAt: { lte: now },
          },
          data: { phase: 'active', deadlineAt: activeDeadline },
        });
        if (result.count)
          await tx.gameEvent.update({
            where: { id: night.eventId },
            data: { status: 'active', endsAt: activeDeadline },
          });
        return result;
      });
      if (updated.count) {
        const snapshot = await db().matrixSnapshot.findFirst({
          where: { eventId: night.eventId },
          orderBy: { createdAt: 'desc' },
        });
        if (snapshot)
          await applyAssignedRoles(night.eventId, snapshot.id, adapter);
        activated++;
      }
    } else {
      await endMatrixNight('system', night.eventId, adapter, 'deadline', now);
      ended++;
    }
  }
  const live = await db().matrixNight.findMany({
    where: { phase: 'active', pausedAt: null },
  });
  for (const night of live) {
    const snapshot = await db().matrixSnapshot.findFirst({
      where: { eventId: night.eventId },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot || !['partial', 'prepared'].includes(snapshot.status))
      continue;
    const operations = await applyAssignedRoles(
      night.eventId,
      snapshot.id,
      adapter,
    );
    void operations;
  }
  const incompleteJails = await db().matrixJail.findMany({
    where: {
      result: { in: ['pending', 'failed'] },
      releasedAt: null,
      night: { phase: 'active', pausedAt: null },
    },
  });
  for (const jail of incompleteJails) {
    const night = await db().matrixNight.findUniqueOrThrow({
      where: { eventId: jail.eventId },
    });
    const snapshot = await db().matrixSnapshot.findFirst({
      where: { eventId: jail.eventId },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot) continue;
    const result = await recordJailOperation(
      adapter,
      night,
      snapshot.id,
      jail.eventId,
      jail.targetId,
      true,
      `matrix:jail:${jail.id}`,
    );
    await db().matrixJail.update({ where: { id: jail.id }, data: { result } });
  }
  const expiredJails = await db().matrixJail.findMany({
    where: {
      releasedAt: null,
      scheduledEndAt: { lte: now },
      night: { phase: 'active', pausedAt: null },
    },
    select: { eventId: true, targetId: true },
  });
  for (const jail of expiredJails)
    await unjailMatrixPlayer(
      'system',
      jail.eventId,
      jail.targetId,
      `expiry:${jail.eventId}:${jail.targetId}`,
      adapter,
      now,
      true,
    ).catch(() => undefined);
  const endedPending = await db().matrixNight.findMany({
    where: {
      phase: 'ended',
      snapshots: { some: { status: { not: 'restored' } } },
    },
  });
  for (const night of endedPending) {
    const snapshot = await db().matrixSnapshot.findFirst({
      where: { eventId: night.eventId },
      orderBy: { createdAt: 'desc' },
    });
    if (snapshot) await restoreSnapshot(adapter, snapshot.id);
  }
  return { activated, ended };
}

export async function listMatrixNights() {
  return db().matrixNight.findMany({
    include: {
      event: true,
      _count: { select: { participants: true, missions: true } },
      snapshots: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { operations: { select: { status: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function recordMatrixOutcome(
  actorId: string,
  eventId: string,
  outcome: string,
) {
  if (!outcome.trim() || outcome.length > 100)
    throw new MatrixNightError(
      'Укажите результат до 100 символов.',
      'invalid_outcome',
    );
  const night = await db().matrixNight.update({
    where: { eventId },
    data: { outcome: outcome.trim() },
  });
  await db().auditLog.create({
    data: {
      actorId,
      action: 'matrix.outcome.set',
      objectType: 'event',
      objectId: eventId,
      result: 'success',
    },
  });
  return night;
}
