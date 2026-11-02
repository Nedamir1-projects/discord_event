import { getDatabase } from './database.js';
import { grantReward } from './economy-service.js';
import { Prisma } from './generated/prisma/client.js';

const DAY_MS = 86_400_000;
const PUMPKIN_COUNT = 7;
const PUMPKIN_NUMBER = 17;

export class HalloweenError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function parseDiscordMessageUrl(value: string): {
  guildId: string;
  channelId: string;
  messageId: string;
} {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HalloweenError(
      'Вставьте ссылку на сообщение Discord.',
      'invalid_link',
    );
  }
  if (
    ![
      'discord.com',
      'discordapp.com',
      'ptb.discord.com',
      'canary.discord.com',
    ].includes(url.hostname)
  )
    throw new HalloweenError(
      'Ссылка должна вести на сообщение Discord.',
      'invalid_link',
    );
  const match = url.pathname.match(
    /^\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/,
  );
  if (!match)
    throw new HalloweenError(
      'Не удалось распознать сервер, канал и сообщение в ссылке.',
      'invalid_link',
    );
  return { guildId: match[1]!, channelId: match[2]!, messageId: match[3]! };
}

export async function createHalloweenEvent(
  actorId: string,
  input: { title?: string; durationDays?: number; timezone?: string },
) {
  const durationDays = input.durationDays ?? 34;
  if (
    !Number.isSafeInteger(durationDays) ||
    durationDays < 1 ||
    durationDays > 365
  )
    throw new HalloweenError(
      'Длительность должна быть от 1 до 365 дней.',
      'invalid_duration',
    );
  const timezone = input.timezone?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
  } catch {
    throw new HalloweenError(
      'Укажите поддерживаемый часовой пояс, например Europe/Moscow.',
      'invalid_timezone',
    );
  }
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const event = await tx.gameEvent.create({
      data: {
        eventType: 'halloween-curse',
        title: input.title?.trim() || 'Проклятие Хэллоуина',
        status: 'waiting',
        createdBy: actorId,
        settings: { durationMs: durationDays * DAY_MS, timezone },
      },
    });
    await tx.halloweenCampaign.create({
      data: { eventId: event.id, timezone },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'halloween.create',
        objectType: 'event',
        objectId: event.id,
        result: 'success',
        details: { durationDays, timezone },
      },
    });
    return event;
  });
}

export async function addHalloweenChapter(
  actorId: string,
  eventId: string,
  input: {
    order: number;
    title: string;
    content: string;
    opensAt?: Date;
    closesAt?: Date;
  },
) {
  if (
    !Number.isSafeInteger(input.order) ||
    input.order < 1 ||
    !input.title.trim() ||
    !input.content.trim()
  )
    throw new HalloweenError(
      'Укажите номер, название и текст главы.',
      'invalid_chapter',
    );
  if (input.opensAt && input.closesAt && input.closesAt <= input.opensAt)
    throw new HalloweenError(
      'Окончание главы должно быть позже её открытия.',
      'invalid_deadline',
    );
  return getDatabase().$transaction(async (tx) => {
    const chapter = await tx.halloweenChapter.create({
      data: {
        eventId,
        ...input,
        title: input.title.trim(),
        content: input.content.trim(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'halloween.chapter.create',
        objectType: 'chapter',
        objectId: chapter.id,
        result: 'success',
        details: { eventId, order: input.order, title: input.title.trim() },
      },
    });
    return chapter;
  });
}

export async function attachHalloweenRiddle(
  actorId: string,
  eventId: string,
  riddleId: string,
  input: {
    storyOrder?: number;
    opensAt?: Date;
    closesAt?: Date;
    isFinal?: boolean;
  },
) {
  if (input.opensAt && input.closesAt && input.closesAt <= input.opensAt)
    throw new HalloweenError(
      'Окончание загадки должно быть позже её открытия.',
      'invalid_deadline',
    );
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    if (input.isFinal) {
      await tx.riddle.updateMany({
        where: {
          campaignEventId: eventId,
          isFinal: true,
          id: { not: riddleId },
        },
        data: { isFinal: false },
      });
    }
    const riddle = await tx.riddle.update({
      where: { id: riddleId },
      data: { campaignEventId: eventId, status: 'active', ...input },
      select: {
        id: true,
        title: true,
        reward: true,
        storyOrder: true,
        isFinal: true,
      },
    });
    if (input.isFinal)
      await tx.halloweenCampaign.update({
        where: { eventId },
        data: { finalPuzzleId: riddleId },
      });
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'halloween.riddle.attach',
        objectType: 'riddle',
        objectId: riddleId,
        result: 'success',
        details: {
          eventId,
          storyOrder: input.storyOrder,
          isFinal: input.isFinal ?? false,
        },
      },
    });
    return riddle;
  });
}

export async function attachHalloweenQuest(
  actorId: string,
  eventId: string,
  questId: string,
  input: { startsAt?: Date; endsAt?: Date },
) {
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt)
    throw new HalloweenError(
      'Окончание квеста должно быть позже его открытия.',
      'invalid_deadline',
    );
  const quest = await getDatabase().quest.update({
    where: { id: questId },
    data: { campaignEventId: eventId, status: 'active', ...input },
    select: {
      id: true,
      title: true,
      reward: true,
      dependencies: true,
      startsAt: true,
      endsAt: true,
    },
  });
  await getDatabase().auditLog.create({
    data: {
      actorId,
      action: 'halloween.quest.attach',
      objectType: 'quest',
      objectId: questId,
      result: 'success',
      details: { eventId, dependencies: quest.dependencies },
    },
  });
  return quest;
}

export async function createHalloweenPoll(
  actorId: string,
  eventId: string,
  input: {
    title: string;
    prompt: string;
    options: string[];
    opensAt?: Date;
    closesAt?: Date;
  },
) {
  const options = input.options.map((option) => option.trim()).filter(Boolean);
  if (
    !input.title.trim() ||
    !input.prompt.trim() ||
    options.length < 2 ||
    options.length > 25
  )
    throw new HalloweenError(
      'Голосованию нужны название, вопрос и от 2 до 25 вариантов.',
      'invalid_poll',
    );
  if (new Set(options).size !== options.length)
    throw new HalloweenError(
      'Варианты голосования должны быть уникальными.',
      'duplicate_option',
    );
  if (input.opensAt && input.closesAt && input.closesAt <= input.opensAt)
    throw new HalloweenError(
      'Окончание голосования должно быть позже его открытия.',
      'invalid_deadline',
    );
  const poll = await getDatabase().halloweenPoll.create({
    data: {
      eventId,
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      options,
      ...(input.opensAt ? { opensAt: input.opensAt } : {}),
      ...(input.closesAt ? { closesAt: input.closesAt } : {}),
    },
  });
  await getDatabase().auditLog.create({
    data: {
      actorId,
      action: 'halloween.poll.create',
      objectType: 'poll',
      objectId: poll.id,
      result: 'success',
      details: { eventId, title: poll.title, optionCount: options.length },
    },
  });
  return poll;
}

export async function joinHalloween(eventId: string, userId: string) {
  const db = getDatabase();
  const event = await db.gameEvent.findUnique({
    where: { id: eventId },
    include: { halloween: true },
  });
  if (!event?.halloween || event.status !== 'active')
    throw new HalloweenError(
      'Событие сейчас не принимает участников.',
      'event_inactive',
    );
  if (event.endsAt && event.endsAt <= new Date())
    throw new HalloweenError('Срок события уже завершён.', 'event_expired');
  return db.halloweenParticipant.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId },
    update: {},
  });
}

export async function getCurrentHalloween() {
  return getDatabase().gameEvent.findFirst({
    where: {
      eventType: 'halloween-curse',
      status: { in: ['waiting', 'active', 'paused'] },
    },
    include: { halloween: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function transitionHalloween(
  actorId: string,
  eventId: string,
  target: 'active' | 'paused' | 'completed',
  now = new Date(),
) {
  return getDatabase().$transaction(async (tx) => {
    const event = await tx.gameEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    if (event.eventType !== 'halloween-curse')
      throw new HalloweenError(
        'Это не событие «Проклятие Хэллоуина».',
        'wrong_event',
      );
    const settings = event.settings as {
      durationMs?: number;
      pausedRemainingMs?: number;
    };
    const allowed: Record<string, string[]> = {
      waiting: ['active'],
      active: ['paused', 'completed'],
      paused: ['active', 'completed'],
      completed: [],
    };
    if (!allowed[event.status]?.includes(target))
      throw new HalloweenError(
        'Такой переход состояния события недоступен.',
        'invalid_transition',
      );
    const data =
      target === 'active'
        ? {
            status: 'active',
            ...(event.status === 'waiting' ? { startsAt: now } : {}),
            endsAt: new Date(
              now.getTime() +
                (event.status === 'paused'
                  ? (settings.pausedRemainingMs ?? 0)
                  : (settings.durationMs ?? 34 * DAY_MS)),
            ),
            settings: { ...settings, pausedRemainingMs: null },
          }
        : target === 'paused'
          ? {
              status: 'paused',
              endsAt: null,
              settings: {
                ...settings,
                pausedRemainingMs: Math.max(
                  0,
                  (event.endsAt?.getTime() ?? now.getTime()) - now.getTime(),
                ),
              },
            }
          : { status: 'completed', endsAt: now };
    const updated = await tx.gameEvent.update({ where: { id: eventId }, data });
    await tx.auditLog.create({
      data: {
        actorId,
        action: `halloween.${target}`,
        objectType: 'event',
        objectId: eventId,
        result: 'success',
        details: { from: event.status, to: target },
      },
    });
    return updated;
  });
}

export async function recoverHalloweenEvents(now = new Date()) {
  const db = getDatabase();
  const overdue = await db.gameEvent.findMany({
    where: {
      eventType: 'halloween-curse',
      status: 'active',
      endsAt: { lte: now },
    },
    select: { id: true },
  });
  for (const event of overdue) {
    await db.$transaction(async (tx) => {
      const updated = await tx.gameEvent.updateMany({
        where: { id: event.id, status: 'active', endsAt: { lte: now } },
        data: { status: 'completed' },
      });
      if (updated.count)
        await tx.auditLog.create({
          data: {
            actorId: 'system',
            action: 'halloween.deadline.complete',
            objectType: 'event',
            objectId: event.id,
            result: 'success',
          },
        });
    });
  }
  return { completedEvents: overdue.length };
}

export async function getMyHalloweenRole(eventId: string, userId: string) {
  const participant = await getDatabase().halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  const secret = await getDatabase().halloweenSecretRole.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  return secret?.role ?? 'innocent';
}

export async function assignHalloweenTraitor(
  actorId: string,
  eventId: string,
  userId: string,
) {
  const db = getDatabase();
  const participant = await db.halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Игрок не участвует в событии.', 'not_joined');
  await db.$transaction(async (tx) => {
    await tx.halloweenSecretRole.deleteMany({
      where: { eventId, role: 'traitor' },
    });
    await tx.halloweenSecretRole.upsert({
      where: { eventId_userId: { eventId, userId } },
      create: { eventId, userId, role: 'traitor' },
      update: { role: 'traitor' },
    });
  });
  // Audit only that the role assignment happened; never put the traitor's user ID or role in logs.
  await db.auditLog.create({
    data: {
      actorId,
      action: 'halloween.secret_role.assign',
      objectType: 'event',
      objectId: eventId,
      result: 'success',
    },
  });
}

function isOpen(
  now: Date,
  opensAt: Date | null,
  closesAt: Date | null,
): boolean {
  return (!opensAt || opensAt <= now) && (!closesAt || closesAt > now);
}

async function assertHalloweenActive(eventId: string): Promise<void> {
  const event = await getDatabase().gameEvent.findUnique({
    where: { id: eventId },
    select: { status: true },
  });
  if (event?.status !== 'active')
    throw new HalloweenError('Событие сейчас не активно.', 'event_inactive');
}

export async function readHalloweenStory(
  eventId: string,
  userId: string,
  now = new Date(),
) {
  await assertHalloweenActive(eventId);
  const participant = await getDatabase().halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  const chapter = await getDatabase().halloweenChapter.findFirst({
    where: { eventId, order: { gt: participant.lastChapterOrder } },
    orderBy: { order: 'asc' },
  });
  if (!chapter) return null;
  if (!isOpen(now, chapter.opensAt, chapter.closesAt))
    throw new HalloweenError(
      'Следующая глава пока закрыта или уже завершилась.',
      'chapter_closed',
    );
  await getDatabase().halloweenParticipant.update({
    where: { eventId_userId: { eventId, userId } },
    data: { lastChapterOrder: chapter.order },
  });
  return chapter;
}

export async function listHalloweenRiddles(
  eventId: string,
  userId: string,
  now = new Date(),
) {
  await assertHalloweenActive(eventId);
  const db = getDatabase();
  const participant = await db.halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');

  const riddles = await db.riddle.findMany({
    where: { campaignEventId: eventId, status: 'active' },
    select: {
      id: true,
      title: true,
      prompt: true,
      reward: true,
      opensAt: true,
      closesAt: true,
      storyOrder: true,
      createdAt: true,
    },
    orderBy: [{ storyOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return riddles.filter((riddle) => isOpen(now, riddle.opensAt, riddle.closesAt));
}

export async function requestHalloweenHint(
  riddleId: string,
  userId: string,
  now = new Date(),
) {
  const db = getDatabase();
  const riddle = await db.riddle.findUnique({ where: { id: riddleId } });
  if (
    !riddle ||
    !riddle.campaignEventId ||
    riddle.status !== 'active' ||
    !isOpen(now, riddle.opensAt, riddle.closesAt)
  )
    throw new HalloweenError('Загадка пока недоступна.', 'riddle_closed');
  await assertHalloweenActive(riddle.campaignEventId);
  const participant = await db.halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId: riddle.campaignEventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  const attempt = await db.riddleAttempt.upsert({
    where: { riddleId_userId: { riddleId, userId } },
    create: { riddleId, userId, hintsUsed: 1 },
    update: { hintsUsed: { increment: 1 } },
  });
  if (attempt.solvedAt) return { solved: true, hint: null };
  const hint = riddle.hints[attempt.hintsUsed - 1] ?? null;
  return { solved: false, hint };
}

export async function answerHalloweenRiddle(
  riddleId: string,
  userId: string,
  answer: string,
  now = new Date(),
) {
  const db = getDatabase();
  const riddle = await db.riddle.findUnique({ where: { id: riddleId } });
  if (
    !riddle ||
    !riddle.campaignEventId ||
    riddle.status !== 'active' ||
    !isOpen(now, riddle.opensAt, riddle.closesAt)
  )
    throw new HalloweenError('Загадка пока недоступна.', 'riddle_closed');
  await assertHalloweenActive(riddle.campaignEventId);
  const participant = await db.halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId: riddle.campaignEventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  let solved = false;
  await db.$transaction(
    async (tx) => {
      const progress = await tx.riddleAttempt.upsert({
        where: { riddleId_userId: { riddleId, userId } },
        create: { riddleId, userId },
        update: {},
      });
      if (progress.solvedAt) {
        solved = true;
        return;
      }
      solved =
        answer.trim().normalize('NFKC').toLocaleLowerCase('ru-RU') ===
        riddle.answer.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');
      await tx.riddleAttempt.update({
        where: { riddleId_userId: { riddleId, userId } },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: now,
          ...(solved ? { solvedAt: now } : {}),
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  if (!solved) return { correct: false, reward: 0, duplicate: false };
  const reward = riddle.reward
    ? await grantReward({
        userId,
        amount: riddle.reward,
        reason: riddle.isFinal ? 'Halloween final puzzle' : 'Halloween riddle',
        operationId: `halloween-riddle:${riddle.id}:${userId}`,
      })
    : { duplicate: false };
  return { correct: true, reward: riddle.reward, duplicate: reward.duplicate };
}

export async function listHalloweenQuests(
  eventId: string,
  userId: string,
  now = new Date(),
) {
  await assertHalloweenActive(eventId);
  const participant = await getDatabase().halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  return getDatabase().quest.findMany({
    where: {
      campaignEventId: eventId,
      status: 'active',
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
    },
    select: {
      id: true,
      title: true,
      description: true,
      conditions: true,
      reward: true,
      dependencies: true,
      startsAt: true,
      endsAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function completeHalloweenQuest(
  eventId: string,
  questId: string,
  userId: string,
  now = new Date(),
) {
  await assertHalloweenActive(eventId);
  const db = getDatabase();
  const quest = await db.quest.findFirst({
    where: { id: questId, campaignEventId: eventId, status: 'active' },
  });
  if (!quest || !isOpen(now, quest.startsAt, quest.endsAt))
    throw new HalloweenError(
      'Квест не открыт или уже завершён.',
      'quest_closed',
    );
  const participant = await db.halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId, userId } },
  });
  if (!participant)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  if (quest.dependencies.length) {
    const completed = await db.halloweenQuestProgress.count({
      where: { userId, questId: { in: quest.dependencies } },
    });
    if (completed !== quest.dependencies.length)
      throw new HalloweenError(
        'Сначала завершите связанные квесты.',
        'dependencies_incomplete',
      );
  }
  let created = true;
  try {
    await db.halloweenQuestProgress.create({
      data: { questId, userId, completedAt: now },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      created = false;
    else throw error;
  }
  const reward = quest.reward
    ? await grantReward({
        userId,
        amount: quest.reward,
        reason: 'Halloween quest',
        operationId: `halloween-quest:${quest.id}:${userId}`,
      })
    : { duplicate: false };
  return { duplicate: !created || reward.duplicate, reward: quest.reward };
}

export async function castHalloweenVote(
  pollId: string,
  userId: string,
  choice: string,
  now = new Date(),
) {
  const poll = await getDatabase().halloweenPoll.findUnique({
    where: { id: pollId },
    include: { campaign: { include: { event: true } } },
  });
  if (
    !poll ||
    poll.status !== 'active' ||
    poll.campaign.event.status !== 'active' ||
    !isOpen(now, poll.opensAt, poll.closesAt)
  )
    throw new HalloweenError('Голосование сейчас закрыто.', 'poll_closed');
  const joined = await getDatabase().halloweenParticipant.findUnique({
    where: { eventId_userId: { eventId: poll.eventId, userId } },
  });
  if (!joined)
    throw new HalloweenError('Сначала присоединитесь к событию.', 'not_joined');
  if (!poll.options.includes(choice))
    throw new HalloweenError('Выберите вариант из списка.', 'invalid_choice');
  try {
    await getDatabase().halloweenVote.create({
      data: { pollId, userId, choice },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new HalloweenError('Ваш голос уже учтён.', 'already_voted');
    throw error;
  }
  return { accepted: true };
}

export async function listOpenHalloweenPolls(
  eventId: string,
  now = new Date(),
) {
  return getDatabase().halloweenPoll.findMany({
    where: {
      eventId,
      status: 'active',
      OR: [{ opensAt: null }, { opensAt: { lte: now } }],
      AND: [{ OR: [{ closesAt: null }, { closesAt: { gt: now } }] }],
    },
    select: {
      id: true,
      title: true,
      prompt: true,
      options: true,
      closesAt: true,
    },
  });
}

export async function getHalloweenPollResults(pollId: string) {
  const poll = await getDatabase().halloweenPoll.findUnique({
    where: { id: pollId },
    include: { votes: true },
  });
  if (!poll)
    throw new HalloweenError('Голосование не найдено.', 'poll_missing');
  return poll.options.map((choice) => ({
    choice,
    votes: poll.votes.filter((vote) => vote.choice === choice).length,
  }));
}

export async function registerSharedPumpkin(
  actorId: string,
  input: {
    slot: number;
    guildId: string;
    channelId: string;
    messageId: string;
    allowedAuthorIds: string[];
    allowedChannelIds?: string[];
    reward: number;
  },
) {
  if (
    !Number.isSafeInteger(input.slot) ||
    input.slot < 1 ||
    input.slot > PUMPKIN_COUNT
  )
    throw new HalloweenError(
      'Номер общей тыквы должен быть от 1 до 7.',
      'invalid_pumpkin_slot',
    );
  if (!Number.isSafeInteger(input.reward) || input.reward < 1)
    throw new HalloweenError(
      'Награда должна быть положительным целым числом.',
      'invalid_reward',
    );
  if (!input.allowedAuthorIds.length)
    throw new HalloweenError(
      'Добавьте хотя бы одного разрешённого автора.',
      'missing_allowed_author',
    );
  const channels = [
    ...new Set(
      input.allowedChannelIds?.length
        ? input.allowedChannelIds
        : [input.channelId],
    ),
  ];
  if (!channels.includes(input.channelId)) channels.push(input.channelId);
  const pumpkin = await getDatabase().sharedPumpkin.create({
    data: {
      ...input,
      pumpkinNumber: PUMPKIN_NUMBER,
      allowedChannelIds: channels,
      active: true,
    },
  });
  await getDatabase().auditLog.create({
    data: {
      actorId,
      action: 'halloween.pumpkin.register',
      objectType: 'shared-pumpkin',
      objectId: pumpkin.id,
      result: 'success',
      details: { slot: input.slot, reward: input.reward },
    },
  });
  return pumpkin;
}

export async function configureSharedPumpkin(
  actorId: string,
  slot: number,
  patch: {
    active?: boolean;
    reward?: number;
    allowedAuthorIds?: string[];
    allowedChannelIds?: string[];
  },
) {
  const data: Record<string, unknown> = { ...patch };
  if (
    patch.reward !== undefined &&
    (!Number.isSafeInteger(patch.reward) || patch.reward < 1)
  )
    throw new HalloweenError(
      'Награда должна быть положительным целым числом.',
      'invalid_reward',
    );
  if (patch.allowedAuthorIds && !patch.allowedAuthorIds.length)
    throw new HalloweenError(
      'Список разрешённых авторов не может быть пустым.',
      'missing_allowed_author',
    );
  const pumpkin = await getDatabase().sharedPumpkin.update({
    where: { slot },
    data: data as never,
  });
  await getDatabase().auditLog.create({
    data: {
      actorId,
      action: 'halloween.pumpkin.configure',
      objectType: 'shared-pumpkin',
      objectId: pumpkin.id,
      result: 'success',
      details: { slot, fields: Object.keys(patch) },
    },
  });
  return pumpkin;
}

export async function listSharedPumpkins() {
  return getDatabase().sharedPumpkin.findMany({
    include: { _count: { select: { finds: true } } },
    orderBy: { slot: 'asc' },
  });
}

export async function listPumpkinFinders(slot: number) {
  return getDatabase().sharedPumpkinFind.findMany({
    where: { pumpkin: { slot } },
    orderBy: { foundAt: 'asc' },
  });
}

export async function getSevenPumpkinCollectors() {
  return getDatabase().$queryRaw<Array<{ userId: string; count: bigint }>>`
    SELECT f."userId", COUNT(DISTINCT f."pumpkinId") AS count
    FROM "SharedPumpkinFind" f
    GROUP BY f."userId"
    HAVING COUNT(DISTINCT f."pumpkinId") = ${PUMPKIN_COUNT}
    ORDER BY f."userId"
  `;
}

export async function resetSharedPumpkinProgress(actorId: string) {
  const db = getDatabase();
  return db.$transaction(async (tx) => {
    const counts = await tx.sharedPumpkinFind.count();
    await tx.sharedPumpkinFind.deleteMany();
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'halloween.pumpkin.progress_reset',
        objectType: 'shared-pumpkins',
        objectId: 'all',
        result: 'success',
        details: { openedCount: counts, financialHistoryRetained: true },
      },
    });
    return counts;
  });
}

export async function recordPumpkinCheckError(input: {
  userId: string;
  pumpkinId?: string;
  guildId?: string;
  channelId?: string;
  messageId?: string;
  code: string;
}) {
  const error = await getDatabase().pumpkinCheckError.create({ data: input });
  await getDatabase().auditLog.create({
    data: {
      actorId: input.userId,
      action: 'halloween.pumpkin.check_failed',
      objectType: 'pumpkin-check',
      objectId: error.id,
      result: 'failure',
      details: { code: input.code, pumpkinId: input.pumpkinId },
    },
  });
  return error;
}

export async function claimSharedPumpkin(input: {
  slot: number;
  userId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  content: string;
}) {
  const db = getDatabase();
  const pumpkin = await db.sharedPumpkin.findUnique({
    where: { slot: input.slot },
  });
  if (!pumpkin || !pumpkin.active)
    throw new HalloweenError(
      'Эта тыква сейчас не активна.',
      'pumpkin_inactive',
    );
  if (pumpkin.guildId !== input.guildId)
    throw new HalloweenError(
      'Сообщение находится не на том сервере.',
      'wrong_guild',
    );
  if (
    pumpkin.channelId !== input.channelId ||
    !pumpkin.allowedChannelIds.includes(input.channelId)
  )
    throw new HalloweenError(
      'Сообщение находится не в разрешённом канале.',
      'wrong_channel',
    );
  if (pumpkin.messageId !== input.messageId)
    throw new HalloweenError(
      'Ссылка ведёт не на зарегистрированное сообщение.',
      'wrong_message',
    );
  if (!pumpkin.allowedAuthorIds.includes(input.authorId))
    throw new HalloweenError(
      'Автор сообщения не разрешён для этой тыквы.',
      'wrong_author',
    );
  if (!input.content.includes('🎃'))
    throw new HalloweenError('В сообщении нет эмодзи 🎃.', 'missing_emoji');
  let created = false;
  try {
    await db.sharedPumpkinFind.create({
      data: { pumpkinId: pumpkin.id, userId: input.userId },
    });
    created = true;
  } catch (error) {
    if (!(
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ))
      throw error;
  }
  // Stable economy operation ID makes retries safe, including recovery if the process stopped after recording the find.
  const award = await grantReward({
    userId: input.userId,
    amount: pumpkin.reward,
    reason: `Halloween pumpkin ${pumpkin.slot}`,
    operationId: `halloween-pumpkin:${pumpkin.id}:${input.userId}`,
  });
  return {
    found: created || !award.duplicate,
    duplicate: !created && award.duplicate,
    reward: pumpkin.reward,
    balance: award.balance,
    slot: pumpkin.slot,
  };
}
