import type { Client, Guild, Role } from 'discord.js';
import type {
  MatrixDiscordAdapter,
  MatrixDiscordRole,
} from '@discord-bots/shared';

export function createMatrixDiscordAdapter(
  client: Client,
): MatrixDiscordAdapter {
  const guild = async (guildId: string): Promise<Guild> =>
    client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId));
  const roleData = (role: Role): MatrixDiscordRole => ({
    id: role.id,
    name: role.name,
    position: role.position,
    permissions: role.permissions.toArray(),
  });
  return {
    async fetchGuildMemberIds(guildId) {
      const target = await guild(guildId);
      const members = await target.members.fetch();
      return [...members.values()]
        .filter((member) => !member.user.bot)
        .map((member) => member.id);
    },
    async fetchRoles(guildId, roleIds) {
      const target = await guild(guildId);
      await target.roles.fetch();
      return roleIds.flatMap((id) => {
        const role = target.roles.cache.get(id);
        return role ? [roleData(role)] : [];
      });
    },
    async botHighestRolePosition(guildId) {
      const target = await guild(guildId);
      const botMember = target.members.me ?? (await target.members.fetchMe());
      return botMember.roles.highest.position;
    },
    async fetchMemberRoleIds(guildId, userId) {
      const target = await guild(guildId);
      const member = await target.members.fetch(userId);
      return [...member.roles.cache.keys()];
    },
    async hasRole(guildId, roleId) {
      const target = await guild(guildId);
      return Boolean(await target.roles.fetch(roleId).catch(() => null));
    },
    async addRole(guildId, userId, roleId, reason) {
      const target = await guild(guildId);
      const member = await target.members.fetch(userId);
      await member.roles.add(roleId, reason);
    },
    async removeRole(guildId, userId, roleId, reason) {
      const target = await guild(guildId);
      const member = await target.members.fetch(userId);
      await member.roles.remove(roleId, reason);
    },
  };
}
