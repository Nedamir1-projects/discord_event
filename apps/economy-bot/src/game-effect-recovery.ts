import { getDatabase, Prisma } from '@discord-bots/shared';
import type { Client } from 'discord.js';

export interface GameEffectRoleAdapter {
  ensureRole(
    guildId: string,
    userId: string,
    roleId: string,
    present: boolean,
  ): Promise<void>;
}

export function createGameEffectRoleAdapter(
  client: Client,
): GameEffectRoleAdapter {
  return {
    async ensureRole(guildId, userId, roleId, present): Promise<void> {
      const guild = await client.guilds.fetch(guildId);
      const role =
        guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId));
      if (!role) return;
      const member = await guild.members.fetch({ user: userId, force: true });
      const hasRole = member.roles.cache.has(roleId);
      if (present && !hasRole) await member.roles.add(role);
      else if (!present && hasRole) await member.roles.remove(role);
    },
  };
}

interface RoleEffectData {
  guildId?: string;
  roleId?: string;
  roleWasPresent?: boolean;
  roleApplied?: boolean;
}

function readRoleEffectData(data: unknown): RoleEffectData | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.roleId !== 'string' || typeof record.guildId !== 'string')
    return undefined;
  return {
    roleId: record.roleId,
    guildId: record.guildId,
    ...(typeof record.roleApplied === 'boolean'
      ? { roleApplied: record.roleApplied }
      : {}),
    ...(typeof record.roleWasPresent === 'boolean'
      ? { roleWasPresent: record.roleWasPresent }
      : {}),
  };
}

export async function reconcileGameEffectRoles(
  adapter: GameEffectRoleAdapter,
  now = new Date(),
): Promise<{ reconciled: number; expired: number; errors: number }> {
  const db = getDatabase();
  const effects = await db.gameEffect.findMany({
    orderBy: { expiresAt: 'asc' },
  });
  const active = effects.filter((effect) => effect.expiresAt > now);
  const expiredIds: string[] = [];
  let reconciled = 0;
  let errors = 0;

  for (const effect of effects) {
    const data = readRoleEffectData(effect.data);
    if (!data) {
      if (effect.expiresAt <= now) expiredIds.push(effect.id);
      continue;
    }

    const overlapping = active.filter((candidate) => {
      if (candidate.targetId !== effect.targetId) return false;
      const candidateData = readRoleEffectData(candidate.data);
      return (
        candidateData?.guildId === data.guildId &&
        candidateData?.roleId === data.roleId
      );
    });
    const originallyPresent =
      data.roleWasPresent !== false ||
      overlapping.some(
        (candidate) =>
          readRoleEffectData(candidate.data)?.roleWasPresent !== false,
      );
    const shouldBePresent =
      effect.expiresAt > now || originallyPresent || overlapping.length > 0;
    if (effect.expiresAt > now && data.roleApplied) continue;

    try {
      await adapter.ensureRole(
        data.guildId!,
        effect.targetId,
        data.roleId!,
        shouldBePresent,
      );
      reconciled++;
      if (effect.expiresAt <= now) expiredIds.push(effect.id);
      else
        await db.gameEffect.update({
          where: { id: effect.id },
          data: {
            data: {
              ...(effect.data as Record<string, unknown>),
              roleApplied: true,
            } as Prisma.InputJsonValue,
          },
        });
    } catch {
      errors++;
    }
  }

  if (expiredIds.length)
    await db.gameEffect.deleteMany({ where: { id: { in: expiredIds } } });
  return { reconciled, expired: expiredIds.length, errors };
}
