import { getDatabase } from './database.js';
import { Prisma } from './generated/prisma/client.js';
import { randomInt } from 'node:crypto';
import type {
  BalanceTransaction,
  PlayerProfile,
  Race,
  ShopItem,
} from './generated/prisma/client.js';

export interface EconomyReward {
  userId: string;
  amount: number;
  reason: string;
  operationId: string;
}

export class EconomyError extends Error {
  constructor(
    message: string,
    readonly code:
      'INVALID' | 'FUNDS' | 'UNAVAILABLE' | 'OWNED' | 'LIMIT' = 'INVALID',
  ) {
    super(message);
  }
}

function validAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2_147_483_647)
    throw new EconomyError(
      'Количество должно быть положительным целым числом.',
    );
}

/** All balance writes are committed with their unique operation ledger row in one transaction. */
export async function changeBalance(
  input: EconomyReward & { delta: number },
): Promise<{ balance: number; duplicate: boolean }> {
  validAmount(Math.abs(input.delta));
  if (!input.userId || !input.operationId || !input.reason)
    throw new EconomyError('Не заполнены данные операции.');
  const db = getDatabase();
  try {
    return await db.$transaction(
      async (tx) => {
        const exists = await tx.balanceTransaction.findUnique({
          where: { operationId: input.operationId },
        });
        if (exists) {
          if (exists.userId !== input.userId || exists.amount !== input.delta)
            throw new EconomyError('Идентификатор операции уже использован.');
          const profile = await tx.playerProfile.findUnique({
            where: { userId: input.userId },
          });
          return { balance: profile?.candies ?? 0, duplicate: true };
        }
        if (input.delta < 0) {
          const updated = await tx.playerProfile.updateMany({
            where: { userId: input.userId, candies: { gte: -input.delta } },
            data: { candies: { decrement: -input.delta } },
          });
          if (!updated.count)
            throw new EconomyError('Недостаточно конфет.', 'FUNDS');
        } else {
          await tx.playerProfile.upsert({
            where: { userId: input.userId },
            create: { userId: input.userId, candies: input.delta },
            update: { candies: { increment: input.delta } },
          });
        }
        await tx.balanceTransaction.create({
          data: {
            operationId: input.operationId,
            userId: input.userId,
            amount: input.delta,
            reason: input.reason,
          },
        });
        const profile = await tx.playerProfile.findUniqueOrThrow({
          where: { userId: input.userId },
        });
        return { balance: profile.candies, duplicate: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof EconomyError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    ) {
      if (error.code === 'P2034') return changeBalance(input);
      const tx = await db.balanceTransaction.findUnique({
        where: { operationId: input.operationId },
      });
      if (tx && tx.userId === input.userId && tx.amount === input.delta)
        return {
          balance:
            (
              await db.playerProfile.findUnique({
                where: { userId: input.userId },
              })
            )?.candies ?? 0,
          duplicate: true,
        };
    }
    throw error;
  }
}

export async function grantReward(
  reward: EconomyReward,
): Promise<{ balance: number; duplicate: boolean }> {
  return changeBalance({ ...reward, delta: reward.amount });
}

export type CoinSide = 'heads' | 'tails';

export interface CoinFlipResult {
  choice: CoinSide;
  result: CoinSide;
  stake: number;
  won: boolean;
  balance: number;
  duplicate: boolean;
}

const coinSideRu: Record<CoinSide, string> = {
  heads: 'Орёл',
  tails: 'Решка',
};

export async function playCoinFlip(
  userId: string,
  choice: CoinSide,
  stake: number,
  interactionId: string,
): Promise<CoinFlipResult> {
  if (!Number.isSafeInteger(stake) || stake < 1 || stake > 1_000_000_000)
    throw new EconomyError('Ставка должна быть от 1 до 1 000 000 000 конфет.');
  if (!userId || !interactionId || !['heads', 'tails'].includes(choice))
    throw new EconomyError('Некорректные данные для игры.');

  const db = getDatabase();
  const betOperationId = `coinflip:${interactionId}:bet`;
  try {
    return await db.$transaction(
      async (tx) => {
        const priorBet = await tx.balanceTransaction.findUnique({
          where: { operationId: betOperationId },
        });
        if (priorBet) {
          const match = priorBet.reason.match(
            /^Монетка: ставка (\d+) конфет; выбор (Орёл|Решка); выпало (Орёл|Решка)$/,
          );
          if (
            priorBet.userId !== userId ||
            priorBet.amount !== -stake ||
            !match ||
            Number(match[1]) !== stake ||
            match[2] !== coinSideRu[choice]
          )
            throw new EconomyError('Идентификатор игры уже использован.');
          const result = match[3] === 'Орёл' ? 'heads' : 'tails';
          const won = result === choice;
          const profile = await tx.playerProfile.findUnique({
            where: { userId },
          });
          return {
            choice,
            result,
            stake,
            won,
            balance: profile?.candies ?? 0,
            duplicate: true,
          };
        }

        const result: CoinSide = randomInt(0, 2) === 0 ? 'heads' : 'tails';
        const won = result === choice;
        const debit = await tx.playerProfile.updateMany({
          where: { userId, candies: { gte: stake } },
          data: { candies: { decrement: stake } },
        });
        if (!debit.count)
          throw new EconomyError('Недостаточно конфет для этой ставки.', 'FUNDS');

        const choiceRu = coinSideRu[choice];
        const resultRu = coinSideRu[result];
        await tx.balanceTransaction.create({
          data: {
            operationId: betOperationId,
            userId,
            amount: -stake,
            reason: `Монетка: ставка ${stake} конфет; выбор ${choiceRu}; выпало ${resultRu}`,
          },
        });

        if (won) {
          const payout = stake * 2;
          const credit = await tx.playerProfile.updateMany({
            where: {
              userId,
              candies: { lte: 2_147_483_647 - payout },
            },
            data: { candies: { increment: payout } },
          });
          if (!credit.count)
            throw new EconomyError('Выигрыш превышает допустимый баланс.');
          await tx.balanceTransaction.create({
            data: {
              operationId: `coinflip:${interactionId}:payout`,
              userId,
              amount: payout,
              reason: `Монетка: выигрышная выплата ${payout} конфет`,
            },
          });
        }

        const profile = await tx.playerProfile.findUniqueOrThrow({
          where: { userId },
        });
        return { choice, result, stake, won, balance: profile.candies, duplicate: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof EconomyError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2034' || error.code === 'P2002')
    )
      return playCoinFlip(userId, choice, stake, interactionId);
    throw error;
  }
}

export async function getBalance(userId: string): Promise<number> {
  return (
    (
      await getDatabase().playerProfile.findUnique({
        where: { userId },
        select: { candies: true },
      })
    )?.candies ?? 0
  );
}

export async function getProfile(userId: string): Promise<PlayerProfile> {
  return getDatabase().playerProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function getLeaderboard(
  limit = 10,
): Promise<Array<Pick<PlayerProfile, 'userId' | 'candies' | 'race'>>> {
  return getDatabase().playerProfile.findMany({
    where: { candies: { gt: 0 } },
    orderBy: [{ candies: 'desc' }, { userId: 'asc' }],
    take: limit,
    select: { userId: true, candies: true, race: true },
  });
}

const initialRaces = [
  ['Mortal', 0, 'Обычный смертный. Начальная раса.'],
  ['Witch', 100, 'Владеет тайной магией.'],
  ['Werewolf', 100, 'Сильный и быстрый оборотень.'],
  ['Vampire', 150, 'Бессмертный ночной охотник.'],
  ['Ghost', 200, 'Таинственный призрак.'],
] as const;
const raceNamesRu: Record<string, string> = {
  Mortal: 'Смертный',
  Witch: 'Ведьма',
  Werewolf: 'Оборотень',
  Vampire: 'Вампир',
  Ghost: 'Призрак',
};
export function getRaceNameRu(raceId: string): string {
  return raceNamesRu[raceId] ?? raceId;
}

export async function getRaces(): Promise<Race[]> {
  const db = getDatabase();
  for (const [id, price, description] of initialRaces)
    await db.race.upsert({
      where: { id },
      create: { id, price, description },
      update: {},
    });
  return db.race.findMany({
    where: { available: true },
    orderBy: { price: 'asc' },
  });
}

export async function buyRace(
  userId: string,
  raceId: string,
  operationId: string,
): Promise<{ balance: number; race: string; duplicate: boolean }> {
  const db = getDatabase();
  try {
    return await db.$transaction(
      async (tx) => {
        const existing = await tx.balanceTransaction.findUnique({
          where: { operationId },
        });
        if (existing) {
          if (existing.userId !== userId)
            throw new EconomyError(
              'Операция уже зарегистрирована для другого игрока.',
            );
          const profile = await tx.playerProfile.findUniqueOrThrow({
            where: { userId },
          });
          return {
            balance: profile.candies,
            race: profile.race,
            duplicate: true,
          };
        }
        const race = await tx.race.findUnique({ where: { id: raceId } });
        if (!race?.available)
          throw new EconomyError('Эта раса сейчас недоступна.', 'UNAVAILABLE');
        const profile = await tx.playerProfile.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });
        if (profile.race !== 'Mortal')
          throw new EconomyError(
            `Вы уже выбрали расу «${getRaceNameRu(profile.race)}». Купить другую расу можно только один раз.`,
            'OWNED',
          );
        if (race.price > 0) {
          const debit = await tx.playerProfile.updateMany({
            where: { userId, candies: { gte: race.price } },
            data: { candies: { decrement: race.price }, race: raceId },
          });
          if (!debit.count)
            throw new EconomyError('Недостаточно конфет.', 'FUNDS');
        } else
          await tx.playerProfile.update({
            where: { userId },
            data: { race: raceId },
          });
        await tx.balanceTransaction.create({
          data: {
            operationId,
            userId,
            amount: -race.price,
            reason: `Покупка расы ${raceId}`,
          },
        });
        const updated = await tx.playerProfile.findUniqueOrThrow({
          where: { userId },
        });
        return {
          balance: updated.candies,
          race: updated.race,
          duplicate: false,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof EconomyError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const profile = await db.playerProfile.findUniqueOrThrow({
        where: { userId },
      });
      return { balance: profile.candies, race: profile.race, duplicate: true };
    }
    throw error;
  }
}

export async function listShop(): Promise<ShopItem[]> {
  return getDatabase().shopItem.findMany({
    where: { available: true },
    orderBy: { price: 'asc' },
  });
}

export async function configureShopItem(input: {
  id: string;
  name: string;
  description: string;
  price: number;
  available?: boolean;
  limit?: number | null;
  roleId?: string | null;
  effect?: Prisma.InputJsonValue;
}): Promise<ShopItem> {
  validAmount(input.price);
  if (!input.id.trim() || !input.name.trim())
    throw new EconomyError('Укажите ID и название товара.');
  return getDatabase().shopItem.upsert({
    where: { id: input.id },
    create: { ...input, available: input.available ?? true },
    update: { ...input, available: input.available ?? true },
  });
}

export async function configureRace(input: {
  id: string;
  price: number;
  description: string;
  available?: boolean;
}): Promise<Race> {
  if (!Number.isSafeInteger(input.price) || input.price < 0)
    throw new EconomyError(
      'Цена расы должна быть неотрицательным целым числом.',
    );
  if (!input.id.trim()) throw new EconomyError('Укажите название расы.');
  return getDatabase().race.upsert({
    where: { id: input.id },
    create: { ...input, available: input.available ?? true },
    update: input,
  });
}

export async function buyItem(
  userId: string,
  itemId: string,
  quantity: number,
  operationId: string,
): Promise<{
  duplicate: boolean;
  amount: number;
  balance: number;
  roleId: string | null;
}> {
  validAmount(quantity);
  const db = getDatabase();
  return db.$transaction(
    async (tx) => {
      const duplicate = await tx.purchase.findUnique({
        where: { operationId },
        include: { item: { select: { roleId: true } } },
      });
      if (duplicate) {
        if (duplicate.userId !== userId || duplicate.itemId !== itemId)
          throw new EconomyError('Операция уже использована.');
        return {
          duplicate: true,
          amount: duplicate.amount,
          balance:
            (await tx.playerProfile.findUnique({ where: { userId } }))
              ?.candies ?? 0,
          roleId: duplicate.item.roleId,
        };
      }
      const item = await tx.shopItem.findUnique({ where: { id: itemId } });
      if (!item?.available)
        throw new EconomyError('Товар недоступен.', 'UNAVAILABLE');
      if (
        item.limit !== null &&
        (await tx.purchase.count({ where: { userId, itemId } })) + quantity >
          item.limit
      )
        throw new EconomyError('Достигнут лимит покупки.', 'LIMIT');
      const amount = item.price * quantity;
      validAmount(amount);
      const debit = await tx.playerProfile.updateMany({
        where: { userId, candies: { gte: amount } },
        data: { candies: { decrement: amount } },
      });
      if (!debit.count) throw new EconomyError('Недостаточно конфет.', 'FUNDS');
      await tx.balanceTransaction.create({
        data: {
          userId,
          amount: -amount,
          reason: `Покупка: ${item.name}`,
          operationId,
        },
      });
      await tx.purchase.create({
        data: { operationId, userId, itemId, quantity, amount },
      });
      const profile = await tx.playerProfile.findUniqueOrThrow({
        where: { userId },
      });
      return {
        duplicate: false,
        amount,
        balance: profile.candies,
        roleId: item.roleId,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function getBalanceHistory(
  userId: string,
  limit = 10,
): Promise<BalanceTransaction[]> {
  return getDatabase().balanceTransaction.findMany({
    where: { userId, amount: { not: 0 } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function queueReward(reward: EconomyReward): Promise<void> {
  const db = getDatabase();
  await db.pendingOperation.upsert({
    where: { operationId: reward.operationId },
    create: { ...reward, status: 'pending' },
    update: {},
  });
}

export async function processPendingRewards(): Promise<void> {
  const db = getDatabase();
  const pending = await db.pendingOperation.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const row of pending) {
    try {
      await grantReward({
        userId: row.userId,
        amount: row.amount,
        reason: row.reason,
        operationId: row.operationId,
      });
      await db.pendingOperation.update({
        where: { operationId: row.operationId },
        data: { status: 'processed', lastError: null },
      });
    } catch (error) {
      await db.pendingOperation.update({
        where: { operationId: row.operationId },
        data: {
          attempts: { increment: 1 },
          lastError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : 'Unknown error',
        },
      });
    }
  }
}
