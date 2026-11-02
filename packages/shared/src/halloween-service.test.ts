import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase } from './database.js';
import {
  claimSharedPumpkin,
  addHalloweenChapter,
  answerHalloweenRiddle,
  assignHalloweenTraitor,
  castHalloweenVote,
  completeHalloweenQuest,
  createHalloweenPoll,
  createHalloweenEvent,
  getMyHalloweenRole,
  joinHalloween,
  parseDiscordMessageUrl,
  readHalloweenStory,
  registerSharedPumpkin,
  requestHalloweenHint,
  transitionHalloween,
} from './halloween-service.js';
import { getBalance } from './economy-service.js';

const enabled = Boolean(process.env.HUNT_TEST_DATABASE_URL);

describe('Halloween message links', () => {
  it('parses guild, channel and message IDs and rejects unrelated URLs', () => {
    expect(
      parseDiscordMessageUrl(
        'https://discord.com/channels/12345678901234567/22345678901234567/32345678901234567',
      ),
    ).toEqual({
      guildId: '12345678901234567',
      channelId: '22345678901234567',
      messageId: '32345678901234567',
    });
    expect(() =>
      parseDiscordMessageUrl(
        'https://example.com/channels/12345678901234567/22345678901234567/32345678901234567',
      ),
    ).toThrow();
  });
});

describe.skipIf(!enabled)('Halloween PostgreSQL integration', () => {
  afterAll(async () => closeDatabase());

  it('persists chapters, riddle attempts, private traitor role, dependent quests and one-time votes/rewards', async () => {
    process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
    const db = getDatabase();
    const event = await createHalloweenEvent('halloween-content-test', {
      timezone: 'UTC',
    });
    const suffix = event.id.replaceAll('-', '');
    const actor = `halloween-content-admin-${suffix}`;
    const user = `halloween-content-user-${suffix}`;
    const voter = `halloween-content-voter-${suffix}`;
    try {
      await transitionHalloween(actor, event.id, 'active');
      await joinHalloween(event.id, user);
      await joinHalloween(event.id, voter);
      const chapter = await addHalloweenChapter(actor, event.id, {
        order: 1,
        title: 'Глава',
        content: 'Секретный текст истории',
      });
      expect((await readHalloweenStory(event.id, user))?.id).toBe(chapter.id);
      const riddle = await db.riddle.create({
        data: {
          title: 'Загадка теста',
          prompt: 'Вопрос?',
          answer: 'Летучая мышь',
          hints: ['Ночное животное'],
          reward: 5,
          status: 'active',
          createdBy: actor,
          campaignEventId: event.id,
        },
      });
      expect(
        (await answerHalloweenRiddle(riddle.id, user, 'неверно')).correct,
      ).toBe(false);
      expect((await requestHalloweenHint(riddle.id, user)).hint).toBe(
        'Ночное животное',
      );
      expect(
        (await answerHalloweenRiddle(riddle.id, user, 'ЛЕТУЧАЯ МЫШЬ')).correct,
      ).toBe(true);
      expect(
        (await answerHalloweenRiddle(riddle.id, user, 'Летучая мышь'))
          .duplicate,
      ).toBe(true);
      await assignHalloweenTraitor(actor, event.id, user);
      expect(await getMyHalloweenRole(event.id, user)).toBe('traitor');
      expect(await getMyHalloweenRole(event.id, voter)).toBe('innocent');
      const firstQuest = await db.quest.create({
        data: {
          title: 'Первый квест',
          description: '',
          reward: 2,
          status: 'active',
          createdBy: actor,
          campaignEventId: event.id,
        },
      });
      const secondQuest = await db.quest.create({
        data: {
          title: 'Зависимый квест',
          description: '',
          reward: 3,
          status: 'active',
          createdBy: actor,
          campaignEventId: event.id,
          dependencies: [firstQuest.id],
        },
      });
      await expect(
        completeHalloweenQuest(event.id, secondQuest.id, user),
      ).rejects.toMatchObject({ code: 'dependencies_incomplete' });
      await completeHalloweenQuest(event.id, firstQuest.id, user);
      await completeHalloweenQuest(event.id, secondQuest.id, user);
      expect(
        (await completeHalloweenQuest(event.id, secondQuest.id, user))
          .duplicate,
      ).toBe(true);
      const poll = await createHalloweenPoll(actor, event.id, {
        title: 'Выбор',
        prompt: 'Какой путь?',
        options: ['Лес', 'Замок'],
      });
      await castHalloweenVote(poll.id, voter, 'Лес');
      await expect(
        castHalloweenVote(poll.id, voter, 'Замок'),
      ).rejects.toMatchObject({ code: 'already_voted' });
      const secretAudit = await db.auditLog.findFirst({
        where: {
          actorId: actor,
          action: 'halloween.secret_role.assign',
          objectId: event.id,
        },
      });
      expect(JSON.stringify(secretAudit?.details ?? {})).not.toContain(user);
      expect(await getBalance(user)).toBe(10);
    } finally {
      await db.gameEvent.delete({ where: { id: event.id } });
      await db.balanceTransaction.deleteMany({
        where: { userId: { in: [user, voter] } },
      });
      await db.playerProfile.deleteMany({
        where: { userId: { in: [user, voter] } },
      });
      await db.auditLog.deleteMany({ where: { actorId: actor } });
    }
  });

  it('persists event lifecycle and grants a shared pumpkin once per player, including concurrent claims', async (context) => {
    process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
    const db = getDatabase();
    const event = await createHalloweenEvent('halloween-integration', {
      durationDays: 34,
      timezone: 'Asia/Qyzylorda',
    });
    const suffix = event.id.replaceAll('-', '');
    const actorId = `halloween-admin-${suffix}`;
    const userA = `halloween-a-${suffix}`;
    const userB = `halloween-b-${suffix}`;
    const guildId = '12345678901234567';
    const channelId = '22345678901234567';
    let slot = 1;
    try {
      const persisted = await db.gameEvent.findUniqueOrThrow({
        where: { id: event.id },
        include: { halloween: true },
      });
      expect(persisted.halloween?.timezone).toBe('Asia/Qyzylorda');
      await transitionHalloween(actorId, event.id, 'active');
      await joinHalloween(event.id, userA);
      await joinHalloween(event.id, userB);
      const taken = new Set(
        (await db.sharedPumpkin.findMany({ select: { slot: true } })).map(
          (item) => item.slot,
        ),
      );
      slot =
        [1, 2, 3, 4, 5, 6, 7].find((candidate) => !taken.has(candidate)) ?? 0;
      if (!slot)
        context.skip(
          'Для проверки тыкв нужна тестовая база со свободным слотом изолированного набора.',
        );
      const pumpkin = await registerSharedPumpkin(actorId, {
        slot,
        guildId,
        channelId,
        messageId: `3${suffix}`.slice(0, 20),
        allowedAuthorIds: ['42345678901234567'],
        reward: 11,
      });
      const claim = (userId: string) =>
        claimSharedPumpkin({
          slot,
          userId,
          guildId,
          channelId,
          messageId: pumpkin.messageId,
          authorId: '42345678901234567',
          content: '🎃',
        });
      const check = (input: Parameters<typeof claimSharedPumpkin>[0]) =>
        claimSharedPumpkin(input);
      await expect(
        check({
          slot,
          userId: userA,
          guildId: 'wrong-guild',
          channelId,
          messageId: pumpkin.messageId,
          authorId: '42345678901234567',
          content: '🎃',
        }),
      ).rejects.toMatchObject({ code: 'wrong_guild' });
      await expect(
        check({
          slot,
          userId: userA,
          guildId,
          channelId: '32345678901234567',
          messageId: pumpkin.messageId,
          authorId: '42345678901234567',
          content: '🎃',
        }),
      ).rejects.toMatchObject({ code: 'wrong_channel' });
      await expect(
        check({
          slot,
          userId: userA,
          guildId,
          channelId,
          messageId: '52345678901234567',
          authorId: '42345678901234567',
          content: '🎃',
        }),
      ).rejects.toMatchObject({ code: 'wrong_message' });
      await expect(
        check({
          slot,
          userId: userA,
          guildId,
          channelId,
          messageId: pumpkin.messageId,
          authorId: '62345678901234567',
          content: '🎃',
        }),
      ).rejects.toMatchObject({ code: 'wrong_author' });
      await expect(
        check({
          slot,
          userId: userA,
          guildId,
          channelId,
          messageId: pumpkin.messageId,
          authorId: '42345678901234567',
          content: 'нет тыквы',
        }),
      ).rejects.toMatchObject({ code: 'missing_emoji' });
      const parallel = await Promise.all([claim(userA), claim(userA)]);
      expect(parallel.filter((result) => !result.duplicate)).toHaveLength(1);
      expect((await claim(userA)).duplicate).toBe(true);
      expect((await claim(userB)).duplicate).toBe(false);
      expect(await getBalance(userA)).toBe(11);
      expect(await getBalance(userB)).toBe(11);
      expect(
        await db.sharedPumpkinFind.count({ where: { pumpkinId: pumpkin.id } }),
      ).toBe(2);
      const { configureSharedPumpkin } = await import('./halloween-service.js');
      await configureSharedPumpkin(actorId, slot, { active: false });
      await expect(claim(userB)).rejects.toMatchObject({
        code: 'pumpkin_inactive',
      });
      await transitionHalloween(actorId, event.id, 'paused');
      const paused = await db.gameEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(paused.status).toBe('paused');
      await transitionHalloween(actorId, event.id, 'active');
      expect(
        (await db.gameEvent.findUniqueOrThrow({ where: { id: event.id } }))
          .endsAt,
      ).not.toBeNull();
    } finally {
      if (slot) await db.sharedPumpkin.deleteMany({ where: { slot } });
      await db.gameEvent.delete({ where: { id: event.id } });
      await db.balanceTransaction.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await db.playerProfile.deleteMany({
        where: { userId: { in: [userA, userB] } },
      });
      await db.auditLog.deleteMany({ where: { actorId } });
    }
  });
});
