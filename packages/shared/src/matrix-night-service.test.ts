import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, getDatabase } from './database.js';
import {
  addMatrixMission,
  advanceMatrixMission,
  assignMatrixRole,
  createMatrixNight,
  DiscordRequestQueue,
  endMatrixNight,
  jailMatrixPlayer,
  MATRIX_DEFAULT_DURATION_MS,
  pauseMatrixNight,
  recoverMatrixNights,
  resumeMatrixNight,
  startMatrixNight,
  unjailMatrixPlayer,
  withDiscordRequestQueue,
  type MatrixDiscordAdapter,
} from './matrix-night-service.js';
import { MatrixNightError } from './matrix-night-service.js';

const enabled = Boolean(process.env.HUNT_TEST_DATABASE_URL);
const guildId = '12345678901234567';
const roleIds = {
  Prophet: '22345678901234567',
  Punishers: '32345678901234567',
  Rebels: '42345678901234567',
  Prisoners: '52345678901234567',
};

function fakeDiscord(initial: Record<string, string[]> = {}) {
  const members = new Map(
    Object.entries(initial).map(([id, roles]) => [id, new Set(roles)]),
  );
  const mutations: string[] = [];
  let failNextAdd = false;
  let failNextRemove = false;
  const adapter: MatrixDiscordAdapter = {
    fetchRoles: async (_guild, ids) =>
      ids.map((id, index) => ({
        id,
        name: `role-${index}`,
        position: index + 1,
        permissions: [],
      })),
    botHighestRolePosition: async () => 100,
    fetchMemberRoleIds: async (_guild, userId) => [
      ...(members.get(userId) ?? new Set<string>()),
    ],
    hasRole: async (_guild, roleId) => Object.values(roleIds).includes(roleId),
    addRole: async (_guild, userId, roleId) => {
      if (failNextAdd) {
        failNextAdd = false;
        throw new Error('simulated Discord timeout');
      }
      const roles = members.get(userId) ?? new Set<string>();
      if (!roles.has(roleId)) mutations.push(`add:${userId}:${roleId}`);
      roles.add(roleId);
      members.set(userId, roles);
    },
    removeRole: async (_guild, userId, roleId) => {
      if (failNextRemove) {
        failNextRemove = false;
        throw new Error('simulated Discord restoration failure');
      }
      const roles = members.get(userId) ?? new Set<string>();
      if (roles.delete(roleId)) mutations.push(`remove:${userId}:${roleId}`);
      members.set(userId, roles);
    },
  };
  return {
    adapter,
    members,
    mutations,
    failNextAdd: () => {
      failNextAdd = true;
    },
    failNextRemove: () => {
      failNextRemove = true;
    },
  };
}

describe('Matrix Discord request queue', () => {
  it('serializes calls and can be clock-controlled in tests', async () => {
    vi.useFakeTimers();
    const queue = new DiscordRequestQueue(25);
    const order: number[] = [];
    const results = Promise.all([
      queue.run(async () => {
        order.push(1);
      }),
      queue.run(async () => {
        order.push(2);
      }),
    ]);
    await vi.runAllTimersAsync();
    await results;
    expect(order).toEqual([1, 2]);
    vi.useRealTimers();
  });
});

describe.skipIf(!enabled)(
  'Matrix Night PostgreSQL and simulated Discord integration',
  () => {
    afterAll(async () => closeDatabase());

    it('snapshots before role changes, survives partial API failure/retry, pauses, resumes and restores only event roles', async () => {
      process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
      const db = getDatabase();
      const actor = 'matrix-admin-test';
      const event = await createMatrixNight(actor, {
        guildId,
        title: 'Matrix integration test',
        countdownMs: 0,
        roles: roleIds,
        maxJailDurationMs: 60_000,
        maxParticipantsByRole: {
          Prophet: 1,
          Punishers: 1,
          Rebels: 2,
          Prisoners: 2,
        },
        victoryRules: 'test-configured victory rule',
        objectives: 'test-configured faction objective',
      });
      const prophet = `matrix-prophet-${event.id}`;
      const punisher = `matrix-punisher-${event.id}`;
      const rebel = `matrix-rebel-${event.id}`;
      const preservedRole = '62345678901234567';
      const discord = fakeDiscord({
        [prophet]: [preservedRole],
        [punisher]: [],
        [rebel]: [],
      });
      const queued = withDiscordRequestQueue(
        discord.adapter,
        new DiscordRequestQueue(0),
      );
      try {
        expect(
          (
            await db.matrixNight.findUniqueOrThrow({
              where: { eventId: event.id },
            })
          ).durationMs,
        ).toBe(BigInt(MATRIX_DEFAULT_DURATION_MS));
        await assignMatrixRole(actor, event.id, prophet, 'Prophet');
        await assignMatrixRole(actor, event.id, punisher, 'Punishers');
        await assignMatrixRole(actor, event.id, rebel, 'Rebels');
        discord.failNextAdd();
        const started = await startMatrixNight(actor, event.id, queued);
        const snapshot = await db.matrixSnapshot.findUniqueOrThrow({
          where: { id: started.snapshotId },
        });
        expect(snapshot.schemaVersion).toBe(1);
        expect(
          (snapshot.memberRoleState as Record<string, string[]>)[prophet],
        ).toEqual([preservedRole]);
        expect(snapshot.status).toBe('partial');
        await recoverMatrixNights(queued);
        expect(
          (
            await db.matrixSnapshot.findUniqueOrThrow({
              where: { id: snapshot.id },
            })
          ).status,
        ).toBe('applied');
        expect(discord.members.get(prophet)?.has(preservedRole)).toBe(true);
        expect(discord.members.get(prophet)?.has(roleIds.Prophet)).toBe(true);

        const jail = await jailMatrixPlayer(
          punisher,
          event.id,
          rebel,
          'Настроенная игровая причина',
          30_000,
          `jail-${event.id}`,
          queued,
        );
        expect(jail.result).toBe('complete');
        const jailRow = await db.matrixJail.findUniqueOrThrow({
          where: { operationKey: `jail-${event.id}` },
        });
        expect(jailRow).toMatchObject({
          actorId: punisher,
          targetId: rebel,
          reason: 'Настроенная игровая причина',
          result: 'complete',
        });
        const mission = await addMatrixMission(actor, event.id, {
          title: 'Миссия теста',
          description: 'Условия заданы администратором',
          faction: 'Rebels',
          targetProgress: 2,
          config: { consequence: 'configured' },
        });
        await expect(
          advanceMatrixMission(
            event.id,
            mission.id,
            rebel,
            `blocked-${event.id}`,
          ),
        ).rejects.toMatchObject({ code: 'jailed' });
        await expect(
          jailMatrixPlayer(
            rebel,
            event.id,
            punisher,
            'нет',
            10_000,
            `unauthorized-${event.id}`,
            queued,
          ),
        ).rejects.toBeInstanceOf(MatrixNightError);
        await unjailMatrixPlayer(
          punisher,
          event.id,
          rebel,
          `unjail-${event.id}`,
          queued,
        );
        const progressed = await advanceMatrixMission(
          event.id,
          mission.id,
          rebel,
          `mission-${event.id}`,
          2,
        );
        expect(progressed.completed).toBe(true);
        expect(
          (
            await advanceMatrixMission(
              event.id,
              mission.id,
              rebel,
              `mission-${event.id}`,
              2,
            )
          ).duplicate,
        ).toBe(true);

        const expiringJail = await jailMatrixPlayer(
          punisher,
          event.id,
          rebel,
          'Срок тестового заключения',
          10_000,
          `expiry-jail-${event.id}`,
          queued,
        );
        await db.matrixJail.update({
          where: { id: expiringJail.jail.id },
          data: { scheduledEndAt: new Date(Date.now() - 1) },
        });
        await recoverMatrixNights(queued);
        expect(
          (
            await db.matrixJail.findUniqueOrThrow({
              where: { id: expiringJail.jail.id },
            })
          ).releaseResult,
        ).toBe('complete');

        const pause = await pauseMatrixNight(actor, event.id);
        expect(pause.remainingMs).toBeGreaterThan(0n);
        const resumed = await resumeMatrixNight(actor, event.id);
        expect(resumed.deadlineAt.getTime()).toBeGreaterThan(Date.now());
        discord.failNextRemove();
        const restored = await endMatrixNight(
          actor,
          event.id,
          queued,
          'admin-configured-result',
        );
        expect(restored.errors).toBe(1);
        expect(
          (
            await db.matrixSnapshot.findUniqueOrThrow({
              where: { id: snapshot.id },
            })
          ).status,
        ).toBe('partial');
        await recoverMatrixNights(queued);
        expect(
          (
            await db.matrixSnapshot.findUniqueOrThrow({
              where: { id: snapshot.id },
            })
          ).status,
        ).toBe('restored');
        expect(discord.members.get(prophet)?.has(roleIds.Prophet)).toBe(false);
        expect(discord.members.get(prophet)?.has(preservedRole)).toBe(true);
        const mutationCount = discord.mutations.length;
        await recoverMatrixNights(queued);
        expect(discord.mutations).toHaveLength(mutationCount);
        expect(
          (
            await db.matrixSnapshot.findUniqueOrThrow({
              where: { id: snapshot.id },
            })
          ).status,
        ).toBe('restored');
      } finally {
        await db.gameEvent.delete({ where: { id: event.id } });
        await db.auditLog.deleteMany({ where: { actorId: actor } });
      }
    });

    it('rejects game roles with Administrator or a position above the bot before snapshot creation', async () => {
      process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
      const event = await createMatrixNight('matrix-role-safety', {
        guildId,
        title: 'Safety',
        countdownMs: 0,
        roles: roleIds,
      });
      const unsafe = fakeDiscord().adapter;
      let mode: 'admin' | 'hierarchy' = 'admin';
      unsafe.fetchRoles = async (_guild, ids) =>
        ids.map((id) => ({
          id,
          name: 'unsafe',
          position: mode === 'hierarchy' && id === roleIds.Prophet ? 100 : 1,
          permissions:
            mode === 'admin' && id === roleIds.Prophet ? ['Administrator'] : [],
        }));
      try {
        await expect(
          startMatrixNight(
            'matrix-role-safety',
            event.id,
            withDiscordRequestQueue(unsafe, new DiscordRequestQueue(0)),
          ),
        ).rejects.toMatchObject({ code: 'unsafe_role' });
        mode = 'hierarchy';
        await expect(
          startMatrixNight(
            'matrix-role-safety',
            event.id,
            withDiscordRequestQueue(unsafe, new DiscordRequestQueue(0)),
          ),
        ).rejects.toMatchObject({ code: 'role_hierarchy' });
        expect(
          await getDatabase().matrixSnapshot.count({
            where: { eventId: event.id },
          }),
        ).toBe(0);
      } finally {
        await getDatabase().gameEvent.delete({ where: { id: event.id } });
        await getDatabase().auditLog.deleteMany({
          where: { actorId: 'matrix-role-safety' },
        });
      }
    });

    it('recovers a persisted countdown deadline after restart', async () => {
      process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
      const db = getDatabase();
      const actor = 'matrix-countdown-test';
      const event = await createMatrixNight(actor, {
        guildId,
        title: 'Countdown recovery test',
        countdownMs: 60_000,
        roles: roleIds,
      });
      const player = `matrix-countdown-player-${event.id}`;
      const discord = fakeDiscord({ [player]: [] });
      const queued = withDiscordRequestQueue(
        discord.adapter,
        new DiscordRequestQueue(0),
      );
      try {
        await assignMatrixRole(actor, event.id, player, 'Rebels');
        const started = await startMatrixNight(actor, event.id, queued);
        expect(started.phase).toBe('countdown');
        expect(discord.mutations).toHaveLength(0);

        await db.matrixNight.update({
          where: { eventId: event.id },
          data: { deadlineAt: new Date(Date.now() - 1) },
        });
        await recoverMatrixNights(queued);

        const recovered = await db.matrixNight.findUniqueOrThrow({
          where: { eventId: event.id },
        });
        expect(recovered.phase).toBe('active');
        expect(discord.members.get(player)?.has(roleIds.Rebels)).toBe(true);
      } finally {
        await db.gameEvent.delete({ where: { id: event.id } });
        await db.auditLog.deleteMany({ where: { actorId: actor } });
      }
    });
  },
);
