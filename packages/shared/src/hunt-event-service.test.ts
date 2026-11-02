import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase } from './database.js';
import {
  attackHuntBoss,
  configureHuntBoss,
  createHuntEvent,
  getHuntLeaderboard,
  joinHunt,
  settleHuntRewards,
  startHuntBoss,
  transitionHunt,
} from './hunt-event-service.js';
import { getBalance } from './economy-service.js';

const enabled = Boolean(process.env.HUNT_TEST_DATABASE_URL);
describe.skipIf(!enabled)('hunt event PostgreSQL integration', () => {
  afterAll(async () => closeDatabase());
  it('persists lifecycle and boss action idempotency across reload reads', async () => {
    process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
    const event = await createHuntEvent('integration-test', {
      settings: {
        durationMs: 3 * 86_400_000,
        rewards: { participation: 2, individual: 3, faction: 4 },
      },
    });
    const userId = `hunt-test-${event.id}`;
    try {
      const waiting = await getDatabase().gameEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(waiting.status).toBe('waiting');
      expect(waiting.eventType).toBe('hunt');
      await configureHuntBoss('integration-test', event.id, {
        name: 'Test boss',
        health: 50,
        durationMs: 60_000,
        phases: [],
        actions: [
          { id: 'hit', damage: 5 },
          { id: 'finish', damage: 45 },
        ],
        damageRules: {},
      });
      await transitionHunt('integration-test', event.id, 'active');
      await joinHunt(event.id, userId);
      await startHuntBoss('integration-test', event.id);
      const first = await attackHuntBoss({
        eventId: event.id,
        userId,
        interactionId: `int-${event.id}`,
        action: 'hit',
      });
      const duplicate = await attackHuntBoss({
        eventId: event.id,
        userId,
        interactionId: `int-${event.id}`,
        action: 'hit',
      });
      expect(first.damage).toBe(5);
      expect(duplicate.duplicate).toBe(true);
      expect(
        (
          await getDatabase().eventBoss.findUniqueOrThrow({
            where: { eventId: event.id },
          })
        ).health,
      ).toBe(45);
      const victory = await attackHuntBoss({
        eventId: event.id,
        userId,
        interactionId: `finish-${event.id}`,
        action: 'finish',
      });
      expect(victory.outcome).toBe('victory');
      expect(
        (await getHuntLeaderboard(event.id)).individual[0]?.bossDamage,
      ).toBe(50);
      expect((await getHuntLeaderboard(event.id)).factions[0]).toMatchObject({
        faction: 'Mortal',
        _sum: { damage: 50 },
      });
      await transitionHunt('integration-test', event.id, 'paused');
      const paused = await getDatabase().gameEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(paused.status).toBe('paused');
      await transitionHunt('integration-test', event.id, 'active');
      const resumed = await getDatabase().gameEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      expect(resumed.endsAt!.getTime()).toBeGreaterThan(Date.now());
      await transitionHunt('integration-test', event.id, 'completed');
      await settleHuntRewards(event.id);
      expect(await getBalance(userId)).toBe(9);
    } finally {
      await getDatabase().gameEvent.delete({ where: { id: event.id } });
      await getDatabase().balanceTransaction.deleteMany({ where: { userId } });
      await getDatabase().playerProfile.deleteMany({ where: { userId } });
    }
  });
});
