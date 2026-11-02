/* Prisma's generated transaction payloads provide the exported return types. */
import { getDatabase } from './database.js';
import { grantReward } from './economy-service.js';
import { Prisma } from './generated/prisma/client.js';

export type HuntStatus = 'waiting' | 'active' | 'paused' | 'completed';
export interface HuntSettings {
  durationMs: number;
  startsAt: string | null;
  endsAt: string | null;
  pausedRemainingMs?: number;
  rewards: {
    participation: number;
    individual: number;
    faction: number;
    defeatIndividual?: number;
    defeatFaction?: number;
  };
  activity?: { voice: number; text: number };
  signupChannelId?: string;
  provisioning?: { guildId: string; roles: Record<string, string>; channels: Record<string, string>; categoryId: string };
}

const DAY = 86_400_000;
export const defaultHuntSettings: HuntSettings = {
  durationMs: 3 * DAY,
  startsAt: null,
  endsAt: null,
  rewards: {
    participation: 0,
    individual: 0,
    faction: 0,
    defeatIndividual: 0,
    defeatFaction: 0,
  },
};

function settingsOf(raw: Prisma.JsonValue): HuntSettings {
  return {
    ...defaultHuntSettings,
    ...(raw as Partial<HuntSettings>),
    rewards: {
      ...defaultHuntSettings.rewards,
      ...((raw as Partial<HuntSettings>).rewards ?? {}),
    },
  };
}

function validateSettings(settings: HuntSettings): void {
  if (!Number.isSafeInteger(settings.durationMs) || settings.durationMs < 1)
    throw new Error('Продолжительность должна быть положительной.');
  for (const value of [
    settings.rewards.participation,
    settings.rewards.individual,
    settings.rewards.faction,
    settings.rewards.defeatIndividual ?? 0,
    settings.rewards.defeatFaction ?? 0,
    settings.activity?.voice ?? 0,
    settings.activity?.text ?? 0,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Награды должны быть неотрицательными целыми числами.');
  for (const value of [settings.startsAt, settings.endsAt])
    if (value !== null && !Number.isFinite(new Date(value).getTime()))
      throw new Error('Даты должны быть в формате ISO 8601.');
  if (
    settings.startsAt &&
    settings.endsAt &&
    new Date(settings.endsAt) <= new Date(settings.startsAt)
  )
    throw new Error('Окончание должно быть позже начала.');
}

export async function createHuntEvent(
  actorId: string,
  input: {
    title?: string;
    description?: string;
    settings?: Partial<HuntSettings>;
  } = {},
) {
  const settings = {
    ...defaultHuntSettings,
    ...input.settings,
    rewards: { ...defaultHuntSettings.rewards, ...input.settings?.rewards },
  };
  validateSettings(settings);
  return getDatabase().$transaction(async (tx) => {
    const event = await tx.gameEvent.create({
      data: {
        eventType: 'hunt',
        title: input.title?.trim() || 'Ночь охоты: Битва за сладости',
        description: input.description ?? '',
        status: 'waiting',
        createdBy: actorId,
        startsAt: settings.startsAt ? new Date(settings.startsAt) : null,
        endsAt: settings.endsAt ? new Date(settings.endsAt) : null,
        settings: settings as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'hunt.create',
        objectType: 'event',
        objectId: event.id,
        result: 'success',
        details: settings as unknown as Prisma.InputJsonValue,
      },
    });
    return event;
  });
}

export async function configureHuntEvent(
  actorId: string,
  eventId: string,
  patch: Partial<HuntSettings>,
) {
  return getDatabase().$transaction(async (tx) => {
    const event = await tx.gameEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    const old = settingsOf(event.settings);
    const settings = {
      ...old,
      ...patch,
      rewards: { ...old.rewards, ...patch.rewards },
    };
    validateSettings(settings);
    if (event.status === 'active' || event.status === 'completed')
      throw new Error('Настройки можно менять только до запуска или на паузе.');
    const updated = await tx.gameEvent.update({
      where: { id: eventId },
      data: {
        settings: settings as unknown as Prisma.InputJsonValue,
        startsAt: settings.startsAt ? new Date(settings.startsAt) : null,
        endsAt: settings.endsAt ? new Date(settings.endsAt) : null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'hunt.configure',
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: patch as Prisma.InputJsonValue,
      },
    });
    return updated;
  });
}

export async function transitionHunt(
  actorId: string,
  eventId: string,
  target: HuntStatus,
  now = new Date(),
) {
  const db = getDatabase();
  const event = await db.$transaction(async (tx) => {
    const current = await tx.gameEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    const transitions: Record<HuntStatus, HuntStatus[]> = {
      waiting: ['active', 'completed'],
      active: ['paused', 'completed'],
      paused: ['active', 'completed'],
      completed: [],
    };
    if (!transitions[current.status as HuntStatus]?.includes(target))
      throw new Error(`Недопустимый переход ${current.status} → ${target}.`);
    const settings = settingsOf(current.settings);
    if (target === 'active') {
      if (settings.startsAt && new Date(settings.startsAt) > now)
        throw new Error('Время начала события ещё не наступило.');
      if (current.status === 'paused') {
        settings.endsAt = new Date(
          now.getTime() + (settings.pausedRemainingMs ?? settings.durationMs),
        ).toISOString();
        delete settings.pausedRemainingMs;
      } else
        settings.endsAt = new Date(
          settings.endsAt ?? now.getTime() + settings.durationMs,
        ).toISOString();
      settings.startsAt ??= now.toISOString();
    }
    if (target === 'paused')
      settings.pausedRemainingMs = Math.max(
        0,
        new Date(settings.endsAt ?? now).getTime() - now.getTime(),
      );
    const updated = await tx.gameEvent.update({
      where: { id: eventId },
      data: {
        status: target,
        startsAt: settings.startsAt ? new Date(settings.startsAt) : null,
        endsAt: settings.endsAt ? new Date(settings.endsAt) : null,
        settings: settings as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: `hunt.${target}`,
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: { from: current.status, to: target },
      },
    });
    return updated;
  });
  if (target === 'completed') await settleHuntRewards(eventId);
  return event;
}

export async function joinHunt(eventId: string, userId: string, guildId?: string) {
  const db = getDatabase();
  const event = await db.gameEvent.findUniqueOrThrow({
    where: { id: eventId },
  });
  if (event.eventType !== 'hunt')
    throw new Error('Это не событие «Ночь охоты».');
  if (!['waiting', 'active', 'paused'].includes(event.status))
    throw new Error('Регистрация на событие закрыта.');
  const settings = settingsOf(event.settings);
  if (guildId && settings.provisioning?.guildId !== guildId)
    throw new Error('Событие не найдено на этом сервере.');
  const profile = await db.playerProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return db.eventParticipation.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, race: profile.race, faction: profile.race },
    update: {},
  });
}

export async function recordHuntActivity(
  eventId: string,
  userId: string,
  type: 'voice' | 'text',
  amount: number,
  operationId: string,
) {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new Error('Некорректное значение активности.');
  const db = getDatabase();
  return db.$transaction(
    async (tx) => {
      const event = await tx.gameEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      if (
        event.status !== 'active' ||
        (event.endsAt && event.endsAt <= new Date())
      )
        throw new Error('Событие не активно.');
      const profile = await tx.playerProfile.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      await tx.eventParticipation.upsert({
        where: { eventId_userId: { eventId, userId } },
        create: { eventId, userId, race: profile.race, faction: profile.race },
        update: {},
      });
      // The interaction ledger makes retries safe and shares the existing candy economy.
      const marker = await tx.balanceTransaction.findUnique({
        where: { operationId: `hunt-activity:${operationId}` },
      });
      if (marker) return { duplicate: true };
      const data =
        type === 'voice'
          ? { voiceSeconds: { increment: amount } }
          : { textMessages: { increment: amount } };
      await tx.eventParticipation.update({
        where: { eventId_userId: { eventId, userId } },
        data,
      });
      const settings = settingsOf(event.settings);
      const reward =
        type === 'voice'
          ? Math.floor(((settings.activity?.voice ?? 0) * amount) / 60)
          : (settings.activity?.text ?? 0) * amount;
      if (reward > 0) {
        await tx.playerProfile.update({
          where: { userId },
          data: { candies: { increment: reward } },
        });
        await tx.balanceTransaction.create({
          data: {
            userId,
            amount: reward,
            reason: `Ивент: активность ${type}`,
            operationId: `hunt-activity:${operationId}`,
          },
        });
      } else {
        // Reserve the deterministic operation key even when activity has no candy reward.
        await tx.balanceTransaction.create({
          data: {
            userId,
            amount: 0,
            reason: `Ивент: прогресс ${type}`,
            operationId: `hunt-activity:${operationId}`,
          },
        });
      }
      return { duplicate: false, reward };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function configureHuntBoss(
  actorId: string,
  eventId: string,
  input: {
    name: string;
    health: number;
    durationMs: number;
    phases: unknown[];
    actions: unknown[];
    damageRules: Record<string, unknown>;
  },
) {
  if (
    !Number.isSafeInteger(input.health) ||
    input.health <= 0 ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs <= 0 ||
    !input.name.trim()
  )
    throw new Error('Босс требует имя, положительное здоровье и длительность.');
  return getDatabase().$transaction(async (tx) => {
    const event = await tx.gameEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    if (event.status === 'active')
      throw new Error('Настраивать босса во время активного события нельзя.');
    const boss = await tx.eventBoss.upsert({
      where: { eventId },
      create: {
        eventId,
        name: input.name,
        health: input.health,
        maxHealth: input.health,
        durationMs: input.durationMs,
        phases: input.phases as Prisma.InputJsonValue,
        actions: input.actions as Prisma.InputJsonValue,
        damageRules: input.damageRules as Prisma.InputJsonValue,
      },
      update: {
        name: input.name,
        health: input.health,
        maxHealth: input.health,
        durationMs: input.durationMs,
        phases: input.phases as Prisma.InputJsonValue,
        actions: input.actions as Prisma.InputJsonValue,
        damageRules: input.damageRules as Prisma.InputJsonValue,
        phase: 0,
        outcome: 'pending',
        startedAt: null,
        endsAt: null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'hunt.boss.configure',
        objectType: 'boss',
        objectId: eventId,
        result: 'success',
        details: input as unknown as Prisma.InputJsonValue,
      },
    });
    return boss;
  });
}

export async function startHuntBoss(
  actorId: string,
  eventId: string,
  now = new Date(),
) {
  return getDatabase().$transaction(async (tx) => {
    const event = await tx.gameEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    if (event.status !== 'active')
      throw new Error('Сначала запустите событие.');
    const boss = await tx.eventBoss.findUniqueOrThrow({ where: { eventId } });
    if (boss.outcome !== 'pending' || boss.startedAt)
      throw new Error('Бой уже запускался.');
    const result = await tx.eventBoss.update({
      where: { eventId },
      data: {
        startedAt: now,
        endsAt: new Date(now.getTime() + boss.durationMs),
        outcome: 'active',
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'hunt.boss.start',
        objectType: 'boss',
        objectId: eventId,
        result: 'success',
      },
    });
    return result;
  });
}

export async function attackHuntBoss(input: {
  eventId: string;
  userId: string;
  interactionId: string;
  action: string;
  now?: Date;
}) {
  const db = getDatabase();
  const now = input.now ?? new Date();
  try {
    return await db.$transaction(
      async (tx) => {
        const existing = await tx.bossAction.findUnique({
          where: { interactionId: input.interactionId },
        });
        if (existing)
          return {
            duplicate: true,
            damage: existing.damage,
            health: (
              await tx.eventBoss.findUniqueOrThrow({
                where: { eventId: input.eventId },
              })
            ).health,
          };
        const event = await tx.gameEvent.findUniqueOrThrow({
          where: { id: input.eventId },
        });
        if (event.status !== 'active') throw new Error('Событие не активно.');
        const boss = await tx.eventBoss.findUniqueOrThrow({
          where: { eventId: input.eventId },
        });
        if (boss.outcome !== 'active' || !boss.endsAt || boss.endsAt <= now)
          throw new Error('Бой с боссом завершён.');
        const actions = boss.actions as Array<{ id: string; damage?: number }>;
        const action = actions.find((entry) => entry.id === input.action);
        if (!action) throw new Error('Это действие недоступно.');
        const profile = await tx.playerProfile.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId },
          update: {},
        });
        const participation = await tx.eventParticipation.upsert({
          where: {
            eventId_userId: { eventId: input.eventId, userId: input.userId },
          },
          create: {
            eventId: input.eventId,
            userId: input.userId,
            race: profile.race,
            faction: profile.race,
          },
          update: {},
        });
        const rules = boss.damageRules as Record<string, unknown>;
        const raceRule =
          (rules.races as Record<string, number> | undefined)?.[
            participation.race
          ] ?? 1;
        const phaseRule =
          (rules.phases as Record<string, number> | undefined)?.[
            String(boss.phase)
          ] ?? 1;
        const activeEffects = await tx.gameEffect.findMany({
          where: { targetId: input.userId, expiresAt: { gt: now } },
        });
        const effectRules = rules.effects as Record<string, number> | undefined;
        const effectRule = activeEffects.reduce(
          (multiplier, effect) =>
            multiplier * (effectRules?.[effect.kind] ?? 1),
          1,
        );
        const damage = Math.max(
          0,
          Math.floor(
            (action.damage ?? Number(rules.baseDamage ?? 0)) *
              raceRule *
              phaseRule *
              effectRule,
          ),
        );
        await tx.bossAction.create({
          data: {
            interactionId: input.interactionId,
            eventId: input.eventId,
            userId: input.userId,
            faction: participation.faction,
            action: input.action,
            damage,
          },
        });
        const health = Math.max(0, boss.health - damage);
        const phases = boss.phases as Array<{ atHealthPercent?: number }>;
        const phase = phases.reduce(
          (current, p, index) =>
            health <= boss.maxHealth * ((p.atHealthPercent ?? 0) / 100)
              ? index
              : current,
          boss.phase,
        );
        const outcome = health === 0 ? 'victory' : 'active';
        await tx.eventBoss.update({
          where: { eventId: input.eventId },
          data: { health, phase, outcome },
        });
        await tx.eventParticipation.update({
          where: {
            eventId_userId: { eventId: input.eventId, userId: input.userId },
          },
          data: { bossDamage: { increment: damage } },
        });
        return { duplicate: false, damage, health, phase, outcome };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      return { duplicate: true, damage: 0 };
    throw error;
  }
}

export async function settleHuntRewards(eventId: string) {
  const db = getDatabase();
  const event = await db.gameEvent.findUniqueOrThrow({
    where: { id: eventId },
  });
  const settings = settingsOf(event.settings);
  const boss = await db.eventBoss.findUnique({ where: { eventId } });
  const participants = await db.eventParticipation.findMany({
    where: { eventId },
    orderBy: { bossDamage: 'desc' },
  });
  const factionTotals = new Map<string, number>();
  for (const p of participants)
    factionTotals.set(
      p.faction,
      (factionTotals.get(p.faction) ?? 0) + p.bossDamage,
    );
  const topFaction = [...factionTotals].sort((a, b) => b[1] - a[1])[0]?.[0];
  const won = boss?.outcome === 'victory';
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i]!;
    if (p.rewardsSettled) continue;
    const individualPrize = won
      ? settings.rewards.individual
      : (settings.rewards.defeatIndividual ?? 0);
    const factionPrize = won
      ? settings.rewards.faction
      : (settings.rewards.defeatFaction ?? 0);
    const amount =
      settings.rewards.participation +
      (i === 0 ? individualPrize : 0) +
      (p.faction === topFaction ? factionPrize : 0);
    if (amount > 0)
      await grantReward({
        userId: p.userId,
        amount,
        reason: `Ночь охоты: результат ${boss?.outcome ?? 'участие'}`,
        operationId: `hunt:${eventId}:reward:${p.userId}`,
      });
    await db.eventParticipation.update({
      where: { eventId_userId: { eventId, userId: p.userId } },
      data: { rewardsSettled: true },
    });
  }
  return {
    participants: participants.length,
    factionTotals: Object.fromEntries(factionTotals),
    outcome: boss?.outcome ?? 'no-boss',
  };
}

export async function getHuntLeaderboard(eventId: string) {
  const [individual, actions] = await Promise.all([
    getDatabase().eventParticipation.findMany({
      where: { eventId },
      orderBy: [{ bossDamage: 'desc' }, { userId: 'asc' }],
    }),
    getDatabase().bossAction.groupBy({
      by: ['faction'],
      where: { eventId },
      _sum: { damage: true },
      orderBy: { _sum: { damage: 'desc' } },
    }),
  ]);
  return { individual, factions: actions };
}

/** Reconcile persisted deadlines after startup and on each scheduler tick. */
export async function recoverHuntEvents(now = new Date()) {
  const db = getDatabase();
  const waiting = await db.gameEvent.findMany({
    where: { status: 'waiting', startsAt: { lte: now } },
  });
  for (const event of waiting)
    await transitionHunt('system', event.id, 'active', now);
  const expired = await db.gameEvent.findMany({
    where: { status: 'active', endsAt: { lte: now } },
  });
  for (const event of expired)
    await transitionHunt('system', event.id, 'completed', now);
  const bosses = await db.eventBoss.findMany({
    where: { outcome: 'active', endsAt: { lte: now } },
  });
  for (const boss of bosses) {
    await db.eventBoss.updateMany({
      where: { eventId: boss.eventId, outcome: 'active' },
      data: { outcome: 'defeat' },
    });
    await settleHuntRewards(boss.eventId);
  }
  const unsettled = await db.gameEvent.findMany({
    where: {
      status: 'completed',
      participations: { some: { rewardsSettled: false } },
    },
    select: { id: true },
  });
  for (const event of unsettled) await settleHuntRewards(event.id);
  return {
    activatedEvents: waiting.length,
    expiredEvents: expired.length,
    expiredBosses: bosses.length,
    rewardEventsRecovered: unsettled.length,
  };
}

export async function getCurrentHunt() {
  return getDatabase().gameEvent.findFirst({
    where: {
      eventType: 'hunt',
      status: { in: ['waiting', 'active', 'paused'] },
    },
    include: { boss: true, _count: { select: { participations: true } } },
    orderBy: { createdAt: 'desc' },
  });
}
