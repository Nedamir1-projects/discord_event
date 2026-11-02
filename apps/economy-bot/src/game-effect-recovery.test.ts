import { afterAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createGameEffect,
  getDatabase,
} from '@discord-bots/shared';
import { reconcileGameEffectRoles } from './game-effect-recovery.js';

const enabled = Boolean(process.env.HUNT_TEST_DATABASE_URL);

describe.skipIf(!enabled)('temporary role effect recovery', () => {
  afterAll(async () => closeDatabase());

  it('retries a failed role change, restores the original state, and deduplicates', async () => {
    process.env.DATABASE_URL = process.env.HUNT_TEST_DATABASE_URL;
    const db = getDatabase();
    const suffix = crypto.randomUUID();
    const ownerId = `effect-owner-${suffix}`;
    const originalOwnerId = `effect-original-owner-${suffix}`;
    const targetId = `effect-target-${suffix}`;
    const effectId = `effect-role-${suffix}`;
    const originalEffectId = `effect-original-role-${suffix}`;
    const cooldownKey = `curse:${ownerId}`;
    const roleId = '92345678901234567';
    const guildId = '12345678901234567';
    const roles = new Set<string>();
    const calls: string[] = [];
    let failNextAdd = true;

    await db.playerProfile.create({
      data: { userId: ownerId, race: 'Witch' },
    });
    await db.playerProfile.create({
      data: { userId: originalOwnerId, race: 'Ghost' },
    });
    const effect = await createGameEffect({
      id: effectId,
      ownerId,
      targetId,
      kind: 'curse',
      durationMs: 3_600_000,
      data: { guildId, roleId, roleWasPresent: false, roleApplied: false },
    });

    try {
      expect(
        await createGameEffect({
          id: effectId,
          ownerId,
          targetId,
          kind: 'curse',
          durationMs: 3_600_000,
          data: { guildId, roleId, roleWasPresent: false, roleApplied: false },
        }),
      ).toMatchObject({ id: effectId });

      const adapter = {
        async ensureRole(
          _guildId: string,
          userId: string,
          requestedRoleId: string,
          present: boolean,
        ): Promise<void> {
          if (userId !== targetId || requestedRoleId !== roleId)
            throw new Error('unexpected target');
          if (present && failNextAdd) {
            failNextAdd = false;
            throw new Error('simulated Discord API failure');
          }
          const hasRole = roles.has(roleId);
          calls.push(`${present ? 'add' : 'remove'}:${roleId}`);
          if (present) roles.add(roleId);
          else roles.delete(roleId);
          if (hasRole === present) return;
        },
      };

      expect(await reconcileGameEffectRoles(adapter)).toMatchObject({
        reconciled: 0,
        errors: 1,
      });
      expect(roles.has(roleId)).toBe(false);
      expect(await reconcileGameEffectRoles(adapter)).toMatchObject({
        reconciled: 1,
        errors: 0,
      });
      expect(roles.has(roleId)).toBe(true);
      expect(await reconcileGameEffectRoles(adapter)).toMatchObject({
        reconciled: 0,
        errors: 0,
      });

      await db.gameEffect.update({
        where: { id: effect.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      expect(await reconcileGameEffectRoles(adapter)).toMatchObject({
        reconciled: 1,
        expired: 1,
        errors: 0,
      });
      expect(roles.has(roleId)).toBe(false);
      expect(await db.gameEffect.findUnique({ where: { id: effect.id } })).toBe(
        null,
      );
      const callsAfterExpiry = calls.length;
      await reconcileGameEffectRoles(adapter);
      expect(calls).toHaveLength(callsAfterExpiry);

      roles.add(roleId);
      const originallyAssigned = await createGameEffect({
        id: originalEffectId,
        ownerId: originalOwnerId,
        targetId,
        kind: 'possession',
        durationMs: 1_800_000,
        data: { guildId, roleId, roleWasPresent: true, roleApplied: true },
      });
      await db.gameEffect.update({
        where: { id: originallyAssigned.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await reconcileGameEffectRoles(adapter);
      expect(roles.has(roleId)).toBe(true);
    } finally {
      await db.gameEffect.deleteMany({
        where: { id: { in: [effectId, originalEffectId] } },
      });
      await db.abilityCooldown.deleteMany({
        where: { key: { in: [cooldownKey, `possession:${originalOwnerId}`] } },
      });
      await db.playerProfile.deleteMany({
        where: { userId: { in: [ownerId, originalOwnerId] } },
      });
    }
  });
});
