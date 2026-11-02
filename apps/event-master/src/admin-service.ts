import {
  appendAuditRecord,
  getDatabase,
  isAdmin,
  Prisma,
  grantReward,
  queueReward,
  changeBalance,
  transitionHunt,
  transitionHalloween,
  listSharedPumpkins,
  type GameEvent,
  type ShopItem,
  type PumpkinMessage,
  type Quest,
  type Riddle,
} from '@discord-bots/shared';

const IMPORTED_HALLOWEEN_RIDDLE_ACTOR =
  'system:initial-halloween-riddle-import';
const IMPORTED_HALLOWEEN_QUEST_ACTOR =
  'system:initial-halloween-quest-import';
export interface FactoryResetCounts {
  players: number;
  events: number;
  purchases: number;
  shopItems: number;
  racesPreserved: number;
  balanceTransactions: number;
  pendingOperations: number;
  activityMessages: number;
  effects: number;
  riddles: number;
  riddlesPreserved: number;
  quests: number;
  questsPreserved: number;
  pumpkins: number;
  sharedPumpkins: number;
  pumpkinFinds: number;
}

export const panelSections = [
  'events',
  'halloween',
  'riddles',
  'quests',
  'pumpkins',
  'shop',
  'economy',
  'players',
  'stats',
  'logs',
  'system',
] as const;
export type PanelSection = (typeof panelSections)[number];

export function parseBoundedInteger(
  value: string,
  min = 0,
  max = 1_000_000,
): number {
  if (!/^\d+$/.test(value))
    throw new Error('Введите целое неотрицательное число.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Число должно быть от ${min} до ${max}.`);
  return parsed;
}

export function parseDiscordId(value: string): string {
  const id = value.trim().replace(/^<@!?|>$/g, '');
  if (!/^\d{17,20}$/.test(id))
    throw new Error('Укажите корректный Discord ID пользователя.');
  return id;
}

export function nextCandyBalance(
  balance: number,
  amount: number,
  mode: 'give' | 'take',
): number {
  parseBoundedInteger(String(amount), 1, 1_000_000);
  if (!Number.isSafeInteger(balance) || balance < 0)
    throw new Error('Текущий баланс повреждён.');
  if (mode === 'take' && balance < amount)
    throw new Error('Недостаточно конфет.');
  const next = mode === 'give' ? balance + amount : balance - amount;
  if (next > 2_147_483_647)
    throw new Error('Баланс превышает допустимый предел.');
  return next;
}

async function audit(
  actorId: string,
  action: string,
  objectType: string,
  objectId: string,
  result: 'success' | 'failure',
  details: Record<string, unknown> = {},
): Promise<void> {
  await appendAuditRecord(
    {
      create: ({ data }) =>
        getDatabase().auditLog.create({ data: data as never }),
    },
    {
      actorId,
      action,
      objectType,
      objectId,
      result,
      details,
    },
  );
}

async function audited<T extends { id: string }>(
  actorId: string,
  action: string,
  objectType: string,
  details: Record<string, unknown>,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  idOf: (value: T) => string,
): Promise<T> {
  try {
    return await getDatabase().$transaction(async (transaction) => {
      const result = await operation(transaction);
      await appendAuditRecord(
        {
          create: ({ data }) =>
            transaction.auditLog.create({ data: data as never }),
        },
        {
          actorId,
          action,
          objectType,
          objectId: idOf(result),
          result: 'success',
          details,
        },
      );
      return result;
    });
  } catch (error) {
    await audit(actorId, action, objectType, 'unknown', 'failure', {
      ...details,
      error: error instanceof Error ? error.name : 'UnknownError',
    }).catch(() => undefined);
    throw error;
  }
}

export async function createEvent(
  actorId: string,
  title: string,
  description: string,
): Promise<GameEvent> {
  const safeTitle = title.trim();
  if (!safeTitle || safeTitle.length > 100)
    throw new Error('Название: от 1 до 100 символов.');
  if (description.length > 1000)
    throw new Error('Описание не должно превышать 1000 символов.');
  return audited(
    actorId,
    'event.create',
    'event',
    { title: safeTitle },
    (transaction) =>
      transaction.gameEvent.create({
        data: { title: safeTitle, description, createdBy: actorId },
      }),
    (event) => event.id,
  );
}

export async function setEventStatus(
  actorId: string,
  id: string,
  status: string,
): Promise<GameEvent> {
  if (!['running', 'paused', 'ended', 'active', 'completed'].includes(status))
    throw new Error('Недопустимый статус события.');
  const persisted = await getDatabase().gameEvent.findUnique({
    where: { id },
    select: { status: true, eventType: true },
  });
  if (
    persisted &&
    ['waiting', 'active', 'paused', 'completed'].includes(persisted.status)
  ) {
    const target =
      (
        { running: 'active', ended: 'completed' } as Record<
          string,
          'active' | 'paused' | 'completed'
        >
      )[status] ?? status;
    if (persisted.eventType === 'halloween-curse')
      return transitionHalloween(
        actorId,
        id,
        target as 'active' | 'paused' | 'completed',
      ) as Promise<GameEvent>;
    return transitionHunt(
      actorId,
      id,
      target as 'active' | 'paused' | 'completed',
    ) as Promise<GameEvent>;
  }
  if (!['running', 'paused', 'ended'].includes(status))
    throw new Error('Недопустимый статус события.');
  return audited(
    actorId,
    `event.${status}`,
    'event',
    { status },
    async (transaction) => {
      const event = await transaction.gameEvent.findUnique({ where: { id } });
      if (!event) throw new Error('Событие не найдено.');
      const allowed: Record<string, string[]> = {
        draft: ['running'],
        running: ['paused', 'ended'],
        paused: ['running', 'ended'],
        ended: [],
      };
      if (!allowed[event.status]?.includes(status))
        throw new Error(
          `Нельзя изменить статус события с В«${event.status}В» на В«${status}В».`,
        );
      return transaction.gameEvent.update({ where: { id }, data: { status } });
    },
    (event) => event.id,
  );
}

export async function createRiddle(
  actorId: string,
  input: {
    title: string;
    prompt: string;
    answer: string;
    hints?: string[];
    reward: number;
  },
): Promise<Riddle> {
  if (!input.title.trim() || !input.prompt.trim() || !input.answer.trim())
    throw new Error('Заполните название, загадку и ответ.');
  if (input.title.trim().length > 100)
    throw new Error('Название загадки не должно превышать 100 символов.');
  parseBoundedInteger(String(input.reward), 0, 1_000_000);
  const hints = (input.hints ?? []).map((hint) => hint.trim()).filter(Boolean);
  return audited(
    actorId,
    'riddle.create',
    'riddle',
    { title: input.title.trim(), reward: input.reward },
    (transaction) =>
      transaction.riddle.create({
        data: {
          ...input,
          title: input.title.trim(),
          prompt: input.prompt.trim(),
          answer: input.answer.trim(),
          hints,
          createdBy: actorId,
        },
      }),
    (riddle) => riddle.id,
  );
}

export async function updateRiddle(
  actorId: string,
  id: string,
  input: {
    title?: string;
    prompt?: string;
    hints?: string[];
    answer?: string;
    reward?: number;
  },
): Promise<Riddle> {
  if (
    input.title !== undefined &&
    (!input.title.trim() || input.title.length > 100)
  )
    throw new Error('Название должно содержать от 1 до 100 символов.');
  if (input.prompt !== undefined && !input.prompt.trim())
    throw new Error('Текст загадки не может быть пустым.');
  if (input.reward !== undefined)
    parseBoundedInteger(String(input.reward), 0, 1_000_000);
  return audited(
    actorId,
    'riddle.update',
    'riddle',
    { id, fields: Object.keys(input) },
    (transaction) => transaction.riddle.update({ where: { id }, data: input }),
    (riddle) => riddle.id,
  );
}

export async function createQuest(
  actorId: string,
  input: {
    title: string;
    description: string;
    conditions: string;
    reward: number;
    startsAt?: Date;
    endsAt?: Date;
    dependencies: string[];
    campaignEventId?: string;
  },
): Promise<Quest> {
  if (!input.title.trim() || !input.description.trim())
    throw new Error('Заполните название и описание квеста.');
  parseBoundedInteger(String(input.reward), 0, 1_000_000);
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt)
    throw new Error('Срок окончания должен быть позже начала.');
  return audited(
    actorId,
    'quest.create',
    'quest',
    { title: input.title.trim(), reward: input.reward },
    async (transaction) => {
      if (input.campaignEventId) {
        const campaign = await transaction.halloweenCampaign.findUnique({
          where: { eventId: input.campaignEventId },
          select: { eventId: true },
        });
        if (!campaign) throw new Error('Выбранная кампания Хэллоуина не найдена.');
      }
      const missingDependencies = input.dependencies.length
        ? await transaction.quest.count({
            where: { id: { in: input.dependencies } },
          })
        : 0;
      if (missingDependencies !== input.dependencies.length)
        throw new Error('Одна или несколько зависимостей квеста не найдены.');
      return transaction.quest.create({
        data: {
          ...input,
          title: input.title.trim(),
          description: input.description.trim(),
          createdBy: actorId,
          ...(input.campaignEventId ? { status: 'active' } : {}),
        },
      });
    },
    (quest) => quest.id,
  );
}

export async function registerPumpkin(
  actorId: string,
  input: {
    messageId: string;
    channelId: string;
    authorId: string;
    reward: number;
  },
): Promise<PumpkinMessage> {
  parseBoundedInteger(String(input.reward), 0, 1_000_000);
  return audited(
    actorId,
    'pumpkin.register',
    'pumpkin-message',
    input,
    (transaction) =>
      transaction.pumpkinMessage.create({
        data: { ...input, createdBy: actorId },
      }),
    (message) => message.id,
  );
}

export async function updatePumpkin(
  actorId: string,
  id: string,
  input: { authorId?: string; reward?: number; status?: string },
): Promise<PumpkinMessage> {
  if (input.reward !== undefined)
    parseBoundedInteger(String(input.reward), 0, 1_000_000);
  if (
    input.status &&
    !['registered', 'approved', 'rejected'].includes(input.status)
  )
    throw new Error(
      'Статус тыквы должен быть registered, approved или rejected.',
    );
  return audited(
    actorId,
    'pumpkin.update',
    'pumpkin-message',
    { id, fields: Object.keys(input) },
    (transaction) =>
      transaction.pumpkinMessage.update({ where: { id }, data: input }),
    (item) => item.id,
  );
}

export async function createPanelShopItem(
  actorId: string,
  input: {
    id: string;
    name: string;
    description: string;
    price: number;
    limit: number | null;
    roleId: string | null;
  },
): Promise<ShopItem> {
  const id = input.id.trim();
  const name = input.name.trim();
  const description = input.description.trim();
  const roleId = input.roleId?.trim() || null;
  if (!/^[a-z0-9_-]{1,50}$/i.test(id))
    throw new Error('ID товара: 1–50 символов, только латиница, цифры, _ и -.');
  if (!name || name.length > 100)
    throw new Error('Название товара должно содержать от 1 до 100 символов.');
  if (description.length > 1000)
    throw new Error('Описание товара не должно превышать 1000 символов.');
  if (roleId && !/^\d{17,20}$/.test(roleId))
    throw new Error('Укажите корректный Discord ID роли.');
  parseBoundedInteger(String(input.price), 1, 1_000_000);
  if (input.limit !== null)
    parseBoundedInteger(String(input.limit), 1, 1_000_000);

  return audited(
    actorId,
    'shop_item.create',
    'shop-item',
    { id, name, price: input.price, limit: input.limit, roleId },
    async (transaction) => {
      if (await transaction.shopItem.findUnique({ where: { id } }))
        throw new Error('Товар с таким ID уже существует.');
      return transaction.shopItem.create({
        data: {
          id,
          name,
          description,
          price: input.price,
          limit: input.limit,
          roleId,
          available: true,
        },
      });
    },
    (item) => item.id,
  );
}

export async function updatePanelShopItem(
  actorId: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    price?: number;
    limit?: number | null;
    available?: boolean;
    roleId?: string | null;
  },
): Promise<ShopItem> {
  const data: {
    name?: string;
    description?: string;
    price?: number;
    limit?: number | null;
    available?: boolean;
    roleId?: string | null;
  } = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 100)
      throw new Error('Название товара должно содержать от 1 до 100 символов.');
    data.name = name;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim();
    if (description.length > 1000)
      throw new Error('Описание товара не должно превышать 1000 символов.');
    data.description = description;
  }
  if (patch.price !== undefined) {
    parseBoundedInteger(String(patch.price), 1, 1_000_000);
    data.price = patch.price;
  }
  if (patch.limit !== undefined) {
    if (patch.limit !== null)
      parseBoundedInteger(String(patch.limit), 1, 1_000_000);
    data.limit = patch.limit;
  }
  if (patch.available !== undefined) data.available = patch.available;
  if (patch.roleId !== undefined) {
    const roleId = patch.roleId?.trim() || null;
    if (roleId && !/^\d{17,20}$/.test(roleId))
      throw new Error('Укажите корректный Discord ID роли.');
    data.roleId = roleId;
  }
  if (!Object.keys(data).length)
    throw new Error('Укажите хотя бы одно поле для изменения.');

  return audited(
    actorId,
    'shop_item.update',
    'shop-item',
    { id, fields: Object.keys(data) },
    async (transaction) => {
      if (!(await transaction.shopItem.findUnique({ where: { id } })))
        throw new Error('Товар не найден.');
      return transaction.shopItem.update({ where: { id }, data });
    },
    (item) => item.id,
  );
}

export async function recordAdminAction(
  actorId: string,
  action: string,
  objectType = 'command',
  objectId = 'none',
  result: 'success' | 'failure' = 'success',
  details: Record<string, unknown> = {},
): Promise<void> {
  await audit(actorId, action, objectType, objectId, result, details);
}

export async function resetAllGameData(
  actorId: string,
): Promise<FactoryResetCounts> {
  if (!isAdmin(actorId))
    throw new Error('Нет доступа к полному сбросу.');
  const db = getDatabase();
  try {
    return await db.$transaction(async (tx) => {
      const counts = {
        players: await tx.playerProfile.count(),
        events: await tx.gameEvent.count(),
        purchases: await tx.purchase.count(),
        shopItems: await tx.shopItem.count(),
        racesPreserved: await tx.race.count(),
        balanceTransactions: await tx.balanceTransaction.count(),
        pendingOperations: await tx.pendingOperation.count(),
        activityMessages: await tx.activityMessage.count(),
        effects: await tx.gameEffect.count(),
        riddles: await tx.riddle.count(),
        riddlesPreserved: await tx.riddle.count({
          where: { createdBy: IMPORTED_HALLOWEEN_RIDDLE_ACTOR },
        }),
        quests: await tx.quest.count(),
        questsPreserved: await tx.quest.count({
          where: { createdBy: IMPORTED_HALLOWEEN_QUEST_ACTOR },
        }),
        pumpkins: await tx.pumpkinMessage.count(),
        sharedPumpkins: await tx.sharedPumpkin.count(),
        pumpkinFinds: await tx.sharedPumpkinFind.count(),
      };
      await tx.purchase.deleteMany();
      await tx.sharedPumpkinFind.deleteMany();
      await tx.sharedPumpkin.deleteMany();
      await tx.pumpkinCheckError.deleteMany();
      const preservedRiddles = await tx.riddle.findMany({
        where: { createdBy: IMPORTED_HALLOWEEN_RIDDLE_ACTOR },
        select: { id: true },
      });
      const preservedQuests = await tx.quest.findMany({
        where: { createdBy: IMPORTED_HALLOWEEN_QUEST_ACTOR },
        select: { id: true },
      });
      const preservedRiddleIds = preservedRiddles.map(({ id }) => id);
      const preservedQuestIds = preservedQuests.map(({ id }) => id);
      if (preservedRiddleIds.length) {
        await tx.riddleAttempt.deleteMany({
          where: { riddleId: { in: preservedRiddleIds } },
        });
        await tx.riddle.updateMany({
          where: { id: { in: preservedRiddleIds } },
          data: { campaignEventId: null, status: 'draft' },
        });
      }
      if (preservedQuestIds.length) {
        await tx.halloweenQuestProgress.deleteMany({
          where: { questId: { in: preservedQuestIds } },
        });
        await tx.quest.updateMany({
          where: { id: { in: preservedQuestIds } },
          data: { campaignEventId: null, status: 'draft' },
        });
      }
      await tx.gameEvent.deleteMany();
      await tx.shopItem.deleteMany();
      await tx.playerProfile.updateMany({
        data: { candies: 0, progress: {} },
      });
      await tx.balanceTransaction.deleteMany();
      await tx.pendingOperation.deleteMany();
      await tx.voiceProgress.deleteMany();
      await tx.textProgress.deleteMany();
      await tx.activityMessage.deleteMany();
      await tx.gameEffect.deleteMany();
      await tx.abilityCooldown.deleteMany();
      await tx.riddle.deleteMany({
        where: { createdBy: { not: IMPORTED_HALLOWEEN_RIDDLE_ACTOR } },
      });
      await tx.quest.deleteMany({
        where: { createdBy: { not: IMPORTED_HALLOWEEN_QUEST_ACTOR } },
      });
      await tx.pumpkinMessage.deleteMany();
      await tx.botStatus.deleteMany();
      await tx.healthCheck.deleteMany();
      await tx.auditLog.deleteMany();
      await tx.auditLog.create({
        data: {
          actorId,
          action: 'system.factory_reset',
          objectType: 'database',
          objectId: 'all-game-data',
          result: 'success',
          details: counts,
        },
      });
      return counts;
    });
  } catch (error) {
    await recordAdminAction(
      actorId,
      'system.factory_reset',
      'database',
      'all-game-data',
      'failure',
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
    ).catch(() => undefined);
    throw error;
  }
}

export async function getPanelData(section: PanelSection): Promise<unknown> {
  const db = getDatabase();
  switch (section) {
    case 'events':
      return db.gameEvent.findMany({
        where: { eventType: 'hunt' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { _count: { select: { participations: true } } },
      });
    case 'halloween':
      return db.gameEvent.findMany({
        where: { eventType: 'halloween-curse' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          halloween: {
            include: {
              _count: {
                select: {
                  chapters: true,
                  participants: true,
                  polls: true,
                },
              },
            },
          },
        },
      });
    case 'riddles':
      return db.riddle.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          title: true,
          reward: true,
          status: true,
          hints: true,
          createdAt: true,
        },
      });
    case 'quests':
      return db.quest.findMany({ orderBy: { createdAt: 'desc' }, take: 10 });
    case 'pumpkins':
      return listSharedPumpkins();
    case 'shop':
      return db.shopItem.findMany({
        orderBy: [{ price: 'asc' }, { id: 'asc' }],
        take: 25,
      });
    case 'players':
      return db.playerProfile.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: {
          userId: true,
          candies: true,
          progress: true,
          updatedAt: true,
        },
      });
    case 'stats': {
      const [
        events,
        participants,
        riddles,
        quests,
        pumpkins,
        errors,
        players,
        riddleRewards,
        questRewards,
        pumpkinRewards,
        progress,
        activeEvents,
        completedEvents,
        huntParticipants,
        halloweenParticipants,
        matrixParticipants,
        issuedRewards,
        matrixMissionsCompleted,
      ] = await Promise.all([
        db.gameEvent.count(),
        db.eventParticipation.count(),
        db.riddle.count(),
        db.quest.count(),
        db.sharedPumpkin.count(),
        db.auditLog.count({ where: { result: 'failure' } }),
        db.playerProfile.count(),
        db.riddle.aggregate({ _sum: { reward: true } }),
        db.quest.aggregate({ _sum: { reward: true } }),
        db.sharedPumpkin.aggregate({ _sum: { reward: true } }),
        db.playerProfile.findMany({ select: { progress: true } }),
        db.gameEvent.count({ where: { status: { in: ['active', 'running'] } } }),
        db.gameEvent.count({ where: { status: { in: ['completed', 'ended'] } } }),
        db.eventParticipation.count({ where: { event: { eventType: 'hunt' } } }),
        db.halloweenParticipant.count(),
        db.matrixParticipant.count(),
        db.balanceTransaction.aggregate({ where: { amount: { gt: 0 } }, _sum: { amount: true } }),
        db.matrixMission.count({ where: { status: 'complete' } }),
      ]);
      const progressRecords = progress.reduce((total, item) => {
        const value = item.progress;
        return (
          total +
          (value && typeof value === 'object' && !Array.isArray(value)
            ? Object.keys(value).length
            : 0)
        );
      }, 0);
      return {
        events,
        participants,
        riddles,
        quests,
        pumpkins,
        errors,
        players,
        progressRecords,
        totalRewards:
          (riddleRewards._sum.reward ?? 0) +
          (questRewards._sum.reward ?? 0) +
          (pumpkinRewards._sum.reward ?? 0),
        activeEvents,
        completedEvents,
        huntParticipants,
        halloweenParticipants,
        matrixParticipants,
        issuedRewards: issuedRewards._sum.amount ?? 0,
        matrixMissionsCompleted,
      };
    }
    case 'logs':
      return db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    case 'system':
      return {
        health: await db.healthCheck.findMany({
          orderBy: { createdAt: 'desc' },
          take: 1,
        }),
        bots: await db.botStatus.findMany({ orderBy: { botId: 'asc' } }),
        database: 'connected',
      };
    case 'economy':
      return db.playerProfile.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 20,
        select: { userId: true, candies: true, updatedAt: true },
      });
  }
}

export async function adjustPlayerCandies(
  actorId: string,
  userId: string,
  amount: number,
  mode: 'give' | 'take',
): Promise<{ balance: number }> {
  parseBoundedInteger(String(amount), 1, 1_000_000);
  const operationId = `admin:${actorId}:${crypto.randomUUID()}`;
  try {
    const result = await changeBalance({
      userId,
      amount,
      reason: `Администратор ${mode === 'give' ? 'выдал' : 'списал'} конфеты`,
      operationId,
      delta: mode === 'give' ? amount : -amount,
    });
    await recordAdminAction(
      actorId,
      `candies.${mode}`,
      'player',
      userId,
      'success',
      { amount, balance: result.balance, operationId },
    );
    return { balance: result.balance };
  } catch (error) {
    await recordAdminAction(
      actorId,
      `candies.${mode}`,
      'player',
      userId,
      'failure',
      { amount, error: error instanceof Error ? error.name : 'UnknownError' },
    ).catch(() => undefined);
    throw error;
  }
}

export async function awardEventReward(input: {
  userId: string;
  amount: number;
  reason: string;
  operationId: string;
}): Promise<void> {
  try {
    await grantReward(input);
  } catch {
    await queueReward(input);
  }
}
