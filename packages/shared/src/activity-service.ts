import { getDatabase } from './database.js';
import { Prisma } from './generated/prisma/client.js';
import type { GameEffect } from './generated/prisma/client.js';
import { getProfile, EconomyError } from './economy-service.js';

export function voiceBonusSeconds(
  start: Date,
  end: Date,
  timezone: string,
): number {
  // Count only seconds within the local 21:00–00:00 window, including midnight crossings.
  let total = 0;
  for (let t = start.getTime(); t < end.getTime(); t += 60_000) {
    const d = new Date(t);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const hour = Number(parts.find((x) => x.type === 'hour')?.value ?? 0);
    total += hour >= 21 ? Math.min(60_000, end.getTime() - t) / 1000 : 0;
  }
  return total;
}
export function qualifiesText(
  text: string,
  isBot: boolean,
  isCommand: boolean,
): boolean {
  return !isBot && !isCommand && text.trim().length > 0;
}
export async function recordTextMessage(input: {
  messageId: string;
  userId: string;
  text: string;
  isBot: boolean;
  isCommand: boolean;
  rewardEvery: number;
  reward: number;
  witchBonus: number;
  minIntervalSeconds: number;
  maxPerHour: number;
  repeatWindow: number;
  repeatLimit: number;
}): Promise<{ accepted: boolean; rewards: number }> {
  if (!qualifiesText(input.text, input.isBot, input.isCommand))
    return { accepted: false, rewards: 0 };
  const db = getDatabase();
  try {
    return await db.$transaction(
      async (tx) => {
        const since = new Date(Date.now() - 3_600_000);
        const count = await tx.activityMessage.count({
          where: { userId: input.userId, createdAt: { gte: since } },
        });
        const last = await tx.activityMessage.findFirst({
          where: { userId: input.userId },
          orderBy: { createdAt: 'desc' },
        });
        if (
          count >= input.maxPerHour ||
          (last &&
            Date.now() - last.createdAt.getTime() <
              input.minIntervalSeconds * 1000)
        )
          return { accepted: false, rewards: 0 };
        const normalized = input.text.trim().toLowerCase();
        const recent = await tx.activityMessage.findMany({
          where: {
            userId: input.userId,
            createdAt: {
              gte: new Date(Date.now() - input.repeatWindow * 60_000),
            },
          },
          orderBy: { createdAt: 'desc' },
          take: input.repeatLimit,
        });
        const hash = normalizedHash(normalized);
        if (
          recent.filter((x) => x.contentHash === hash).length >=
          input.repeatLimit - 1
        )
          return { accepted: false, rewards: 0 };
        await tx.activityMessage.create({
          data: {
            messageId: input.messageId,
            userId: input.userId,
            contentHash: hash,
          },
        });
        const profile = await tx.playerProfile.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId },
          update: {},
        });
        const progress = await tx.textProgress.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId, messages: 1 },
          update: { messages: { increment: 1 } },
        });
        const rewards = Math.floor(progress.messages / input.rewardEvery);
        if (rewards) {
          const amount =
            Math.floor(
              input.reward *
                (profile.race === 'Witch' ? 1 + input.witchBonus : 1),
            ) * rewards;
          // A deterministic key makes retry safe. Progress reset and ledger share this transaction.
          const op = `text:${input.userId}:${input.messageId}`;
          await tx.playerProfile.update({
            where: { userId: input.userId },
            data: { candies: { increment: amount } },
          });
          await tx.balanceTransaction.create({
            data: {
              userId: input.userId,
              amount,
              reason: 'Текстовая активность',
              operationId: op,
            },
          });
          await tx.textProgress.update({
            where: { userId: input.userId },
            data: { messages: { decrement: rewards * input.rewardEvery } },
          });
        }
        return { accepted: true, rewards };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
      return { accepted: false, rewards: 0 };
    throw e;
  }
}

export async function recordVoiceActivity(input: {
  userId: string;
  seconds: number;
  rewardEverySeconds: number;
  reward: number;
  operationId: string;
}): Promise<{ duplicate: boolean; reward: number }> {
  return recordVoiceActivityAttempt(input, 3);
}

async function recordVoiceActivityAttempt(
  input: {
    userId: string;
    seconds: number;
    rewardEverySeconds: number;
    reward: number;
    operationId: string;
  },
  retriesRemaining: number,
): Promise<{ duplicate: boolean; reward: number }> {
  if (
    !Number.isSafeInteger(input.seconds) ||
    input.seconds < 1 ||
    !Number.isSafeInteger(input.rewardEverySeconds) ||
    input.rewardEverySeconds < 1 ||
    !Number.isSafeInteger(input.reward) ||
    input.reward < 0
  )
    throw new EconomyError('Некорректные параметры голосовой активности.');

  const db = getDatabase();
  const operationId = `voice:${input.userId}:${input.operationId}`;
  try {
    return await db.$transaction(
      async (tx) => {
        const marker = await tx.balanceTransaction.findUnique({
          where: { operationId },
        });
        if (marker) return { duplicate: true, reward: 0 };

        const profile = await tx.playerProfile.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId },
          update: {},
        });
        const progress = await tx.voiceProgress.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId, seconds: input.seconds },
          update: { seconds: { increment: input.seconds } },
        });
        const rewards = Math.floor(
          progress.seconds / input.rewardEverySeconds,
        );
        const amount = rewards * input.reward;
        const remainingSeconds =
          progress.seconds - rewards * input.rewardEverySeconds;

        await tx.voiceProgress.update({
          where: { userId: input.userId },
          data: { seconds: remainingSeconds },
        });
        if (amount > 0)
          await tx.playerProfile.update({
            where: { userId: input.userId },
            data: { candies: { increment: amount } },
          });
        await tx.balanceTransaction.create({
          data: {
            userId: input.userId,
            amount,
            reason:
              amount > 0
                ? 'Голосовая активность'
                : 'Прогресс голосовой активности',
            operationId,
          },
        });
        return { duplicate: false, reward: amount };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    // Prisma's PostgreSQL driver adapter reports serialization failures as a
    // DriverAdapterError (kind: TransactionWriteConflict), rather than as the
    // P2034 known request error used by Prisma's engine.
    const adapterCause =
      error instanceof Error &&
      typeof error.cause === 'object' &&
      error.cause !== null
        ? (error.cause as { kind?: unknown })
        : undefined;
    if (
      adapterCause?.kind === 'TransactionWriteConflict' &&
      retriesRemaining > 0
    )
      return recordVoiceActivityAttempt(input, retriesRemaining - 1);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      return { duplicate: true, reward: 0 };
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034' &&
      retriesRemaining > 0
    )
      return recordVoiceActivityAttempt(input, retriesRemaining - 1);
    throw error;
  }
}

function normalizedHash(value: string): string {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16);
}
export async function biteVampire(
  userId: string,
  targetId: string,
  operationId: string,
  now = new Date(),
): Promise<number> {
  const db = getDatabase();
  return db.$transaction(
    async (tx) => {
      const me = await tx.playerProfile.findUnique({ where: { userId } });
      const target = await tx.playerProfile.findUnique({
        where: { userId: targetId },
      });
      if (
        me?.race !== 'Vampire' ||
        target?.race !== 'Mortal' ||
        targetId === userId
      )
        throw new EconomyError('Цель должна быть другим игроком с расой «Смертный».');
      const key = `vampire:${userId}`;
      const cd = await tx.abilityCooldown.findUnique({ where: { key } });
      if (cd && cd.readyAt > now)
        throw new EconomyError('Способность перезаряжается.');
      const amount = Math.min(15, target.candies);
      if (amount < 1) throw new EconomyError('У цели нет конфет.');
      await tx.playerProfile.update({
        where: { userId: targetId },
        data: { candies: { decrement: amount } },
      });
      await tx.playerProfile.update({
        where: { userId },
        data: { candies: { increment: amount } },
      });
      await tx.balanceTransaction.createMany({
        data: [
          {
            userId: targetId,
            amount: -amount,
            reason: 'Укус вампира',
            operationId: `${operationId}:debit`,
          },
          {
            userId,
            amount,
            reason: 'Укус вампира',
            operationId: `${operationId}:credit`,
          },
        ],
      });
      await tx.abilityCooldown.upsert({
        where: { key },
        create: { key, readyAt: new Date(now.getTime() + 4 * 3600_000) },
        update: { readyAt: new Date(now.getTime() + 4 * 3600_000) },
      });
      return amount;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
export async function createGameEffect(input: {
  id: string;
  ownerId: string;
  targetId: string;
  kind: string;
  durationMs: number;
  data?: Prisma.InputJsonValue;
}): Promise<GameEffect> {
  const db = getDatabase();
  const byOperation = await db.gameEffect.findUnique({
    where: { id: input.id },
  });
  if (byOperation) {
    if (
      byOperation.ownerId !== input.ownerId ||
      byOperation.targetId !== input.targetId ||
      byOperation.kind !== input.kind
    )
      throw new EconomyError('ID операции уже используется.');
    return byOperation;
  }
  if (input.ownerId === input.targetId)
    throw new EconomyError('Выберите другого игрока.');
  const owner = await getProfile(input.ownerId);
  if (!['Witch', 'Ghost'].includes(owner.race))
    throw new EconomyError('Эта способность недоступна вашей расе.');
  const target = await getProfile(input.targetId);
  if (input.kind === 'curse' && target.race === 'Witch')
    throw new EconomyError('Нельзя проклясть игрока с расой «Ведьма».');
  const key = `${input.kind}:${input.ownerId}`;
  const now = new Date();
  try {
    return await db.$transaction(
      async (tx) => {
        const byOperation = await tx.gameEffect.findUnique({
          where: { id: input.id },
        });
        if (byOperation) {
          if (
            byOperation.ownerId !== input.ownerId ||
            byOperation.targetId !== input.targetId ||
            byOperation.kind !== input.kind
          )
            throw new EconomyError('ID операции уже используется.');
          return byOperation;
        }
        const cd = await tx.abilityCooldown.findUnique({ where: { key } });
        if (cd && cd.readyAt > now)
          throw new EconomyError('Способность перезаряжается.');
        const existing = await tx.gameEffect.findFirst({
          where: {
            ownerId: input.ownerId,
            targetId: input.targetId,
            kind: input.kind,
            expiresAt: { gt: now },
          },
        });
        if (existing) throw new EconomyError('Эффект уже действует.');
        const duration = input.kind === 'curse' ? 3_600_000 : 1_800_000;
        const effect = await tx.gameEffect.create({
          data: {
            id: input.id,
            ownerId: input.ownerId,
            targetId: input.targetId,
            kind: input.kind,
            expiresAt: new Date(now.getTime() + duration),
            data: input.data ?? {},
          },
        });
        await tx.abilityCooldown.upsert({
          where: { key },
          create: { key, readyAt: effect.expiresAt },
          update: { readyAt: effect.expiresAt },
        });
        return effect;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    )
      return createGameEffect(input);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await db.gameEffect.findUnique({
        where: { id: input.id },
      });
      if (
        existing?.ownerId === input.ownerId &&
        existing.targetId === input.targetId &&
        existing.kind === input.kind
      )
        return existing;
    }
    throw error;
  }
}
export async function expireGameEffects(
  now = new Date(),
): Promise<{ count: number }> {
  const db = getDatabase();
  const expired = await db.gameEffect.findMany({
    where: { expiresAt: { lte: now } },
    select: { id: true, data: true },
  });
  const rolelessIds = expired
    .filter((effect) => {
      const data = effect.data;
      return (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof (data as Record<string, unknown>).roleId !== 'string'
      );
    })
    .map((effect) => effect.id);
  if (!rolelessIds.length) return { count: 0 };
  return db.gameEffect.deleteMany({ where: { id: { in: rolelessIds } } });
}
