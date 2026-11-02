import { ChannelType, PermissionFlagsBits, type Client, type Guild, type OverwriteResolvable } from 'discord.js';
import { getDatabase } from '@discord-bots/shared';

export type ProvisionedEvent = { guildId: string; roles: Record<string, string>; channels: Record<string, string>; categoryId: string };

export class ProvisioningError extends Error {
  constructor(message: string, readonly created: string[]) {
    super(`${message}${created.length ? ` Частично созданы ресурсы: ${created.join(', ')}.` : ''}`);
    this.name = 'ProvisioningError';
  }
}

const roleSpecs = {
  hunt: [['mortal', 'Смертный', 0x8c8c8c], ['witch', 'Ведьма', 0x8b5cf6], ['werewolf', 'Оборотень', 0x92400e], ['vampire', 'Вампир', 0xdc2626], ['ghost', 'Призрак', 0xe5e7eb]],
  matrix: [['Prophet', 'Фальшивый Пророк', 0xfbbf24], ['Punishers', 'Каратели', 0xef4444], ['Rebels', 'Повстанцы', 0x22c55e], ['Prisoners', 'Пленники', 0x6b7280]],
} as const;

async function ensureBotPermissions(guild: Guild): Promise<void> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles) || !me.permissions.has(PermissionFlagsBits.ManageChannels))
    throw new Error('Для подготовки ивента боту нужны права Manage Roles и Manage Channels.');
}

export async function provisionEvent(guild: Guild, kind: 'hunt' | 'matrix'): Promise<ProvisionedEvent> {
  await ensureBotPermissions(guild);
  const created: string[] = [];
  const roles: Record<string, string> = {};
  const channels: Record<string, string> = {};
  const me = guild.members.me ?? (await guild.members.fetchMe());
  try {
    for (const [key, name, color] of roleSpecs[kind]) {
      const role = await guild.roles.create({ name, color, permissions: [], reason: `Подготовка ивента ${kind}` });
      roles[key] = role.id;
      created.push(`роль «${name}» (${role.id})`);
    }
    const everyone = guild.roles.everyone.id;
    const bot = me.id;
    const memberRoleIds = kind === 'hunt'
      ? Object.values(roles)
      : [roles.Prophet!, roles.Punishers!, roles.Rebels!];
    const baseOverwrites: OverwriteResolvable[] = [
      { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
      ...memberRoleIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] })),
      ...(kind === 'matrix' ? [{ id: roles.Prisoners!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
      { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
    ];
    const categoryName = kind === 'hunt' ? '🌙 Ночь охоты — игровые каналы' : '⚖️ Судная ночь — игровые каналы';
    const category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory, permissionOverwrites: baseOverwrites, reason: `Подготовка ивента ${kind}` });
    channels.category = category.id;
    created.push(`категория «${categoryName}» (${category.id})`);
    const makeText = async (key: string, name: string, overwrites: OverwriteResolvable[] = baseOverwrites) => {
      const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: overwrites, reason: `Подготовка ивента ${kind}` });
      channels[key] = channel.id;
      created.push(`канал #${name} (${channel.id})`);
    };
    if (kind === 'hunt') {
      await makeText('info', 'информация', [
        { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
      ]);
      await makeText('chat', 'охота-за-сладостями');
      await makeText('quests', 'выдача-заданий');
      await makeText('submissions', 'сдача-квестов');
      await makeText('leaderboard', 'таблица-лидеров');
      for (const [key, name, roleKeys] of [['coven', 'шабаш', ['witch', 'ghost']], ['den', 'логово-стаи', ['werewolf', 'ghost']], ['crypt', 'вампирский-склеп', ['vampire', 'ghost']]] as const) {
        const privateOverwrites: OverwriteResolvable[] = [
          { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
          { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ...roleKeys.map((roleKey) => ({ id: roles[roleKey]!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        ];
        await makeText(key, name, privateOverwrites);
      }
      const voice = await guild.channels.create({ name: 'хэллоуинский-квиз', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: baseOverwrites, reason: 'Подготовка ивента hunt' });
      channels.quizVoice = voice.id;
      created.push(`голосовой канал «${voice.name}» (${voice.id})`);
    } else {
      await makeText('announcements', 'объявления-судной-ночи', [
        { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
      ]);
      await makeText('missions', 'миссии', [
        { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        ...Object.values(roles).map((id) => ({
          id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages],
        })),
        { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
      ]);
      await makeText('mainChat', 'главный-флуд', baseOverwrites);
      const purgatoryOverwrites: OverwriteResolvable[] = [
        { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ...[roles.Prophet!, roles.Punishers!, roles.Rebels!].map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
        { id: roles.Prisoners!, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: bot, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
      ];
      await makeText('purgatory', 'чистилище', purgatoryOverwrites);
      await makeText('status', 'статус-события');
      const voice = await guild.channels.create({ name: 'сирена', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: baseOverwrites, reason: 'Подготовка ивента matrix' });
      channels.sirenVoice = voice.id;
      created.push(`голосовой канал «${voice.name}» (${voice.id})`);
    }
    return { guildId: guild.id, roles, channels, categoryId: category.id };
  } catch (error) {
    throw new ProvisioningError(error instanceof Error ? error.message : 'Ошибка создания ресурсов Discord.', created);
  }
}

export async function assignHuntParticipantMortalRole(
  guild: Guild,
  eventId: string,
  userId: string,
): Promise<void> {
  const event = await getDatabase().gameEvent.findUnique({
    where: { id: eventId },
    select: { eventType: true, settings: true },
  });
  if (!event || event.eventType !== 'hunt')
    throw new Error('Событие «Ночь охоты» не найдено.');

  const settings = asRecord(event.settings);
  const provisioning = asRecord(settings.provisioning);
  if (provisioning.guildId !== guild.id)
    throw new Error('Событие относится к другому серверу.');
  const roleIds = asRecord(provisioning.roles);
  const mortalRoleId = roleIds.mortal;
  if (typeof mortalRoleId !== 'string')
    throw new Error('Для события не настроена роль «Смертный».');

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles))
    throw new Error('Боту нужно право Manage Roles для выдачи роли.');
  const mortalRole = await guild.roles.fetch(mortalRoleId);
  if (!mortalRole) throw new Error('Роль «Смертный» удалена или недоступна.');
  if (mortalRole.position >= botMember.roles.highest.position)
    throw new Error('Роль «Смертный» находится выше роли бота.');

  const member = await guild.members.fetch(userId);
  if (!member.user.bot) {
    const otherRaceRoleIds = Object.values(roleIds).filter(
      (id): id is string => typeof id === 'string' && id !== mortalRoleId && member.roles.cache.has(id),
    );
    if (otherRaceRoleIds.length)
      await member.roles.remove(otherRaceRoleIds, 'Join Night Hunt as Mortal');
    if (!member.roles.cache.has(mortalRoleId))
      await member.roles.add(mortalRole, 'Join Night Hunt as Mortal');
  }
  if (!member.user.bot)
    await getDatabase().playerProfile.upsert({
      where: { userId },
      create: { userId, race: 'Mortal' },
      update: { race: 'Mortal' },
    });
}

type GuildResources = { channels: Set<string>; categories: Set<string>; roles: Set<string> };
type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const stringIds = (value: unknown): string[] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.values(value).filter((item): item is string => typeof item === 'string' && /^\d{17,20}$/.test(item))
    : [];
const isMissingDiscordResource = (error: unknown): boolean => {
  const code = (error as { code?: number; rawError?: { code?: number } })?.code ??
    (error as { rawError?: { code?: number } })?.rawError?.code;
  return code === 10003 || code === 10011;
};

/** Deletes only Discord IDs retained in the event provisioning settings. */
export async function deleteProvisionedEvents(client: Client): Promise<{ deletedChannels: number; deletedRoles: number }> {
  const db = getDatabase();
  const [huntEvents, matrixNights] = await Promise.all([
    db.gameEvent.findMany({ where: { eventType: 'hunt' }, select: { settings: true } }),
    db.matrixNight.findMany({ select: { guildId: true, config: true } }),
  ]);
  const byGuild = new Map<string, GuildResources>();
  const resourcesFor = (guildId: string) => {
    let resources = byGuild.get(guildId);
    if (!resources) {
      resources = { channels: new Set(), categories: new Set(), roles: new Set() };
      byGuild.set(guildId, resources);
    }
    return resources;
  };
  for (const event of huntEvents) {
    const setup = asRecord(asRecord(event.settings).provisioning);
    if (typeof setup.guildId !== 'string') continue;
    const resources = resourcesFor(setup.guildId);
    const categoryId = setup.categoryId;
    if (typeof categoryId === 'string' && /^\d{17,20}$/.test(categoryId)) resources.categories.add(categoryId);
    for (const id of stringIds(setup.channels)) resources.channels.add(id);
    for (const id of stringIds(setup.roles)) resources.roles.add(id);
  }
  for (const night of matrixNights) {
    const setup = asRecord(asRecord(night.config).provisioning);
    const resources = resourcesFor(night.guildId);
    if (typeof setup.categoryId === 'string' && /^\d{17,20}$/.test(setup.categoryId)) resources.categories.add(setup.categoryId);
    for (const id of stringIds(setup.channels)) resources.channels.add(id);
    for (const id of stringIds(asRecord(night.config).roles)) resources.roles.add(id);
  }

  const guilds = new Map<string, Guild>();
  for (const guildId of byGuild.keys()) {
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new Error(`На сервере ${guild.name} боту нужны Manage Channels и Manage Roles; база не сброшена.`);
    const roleIds = [...byGuild.get(guildId)!.roles];
    for (const roleId of roleIds) {
      const role = await guild.roles.fetch(roleId).catch((error: unknown) => isMissingDiscordResource(error) ? null : Promise.reject(error));
      if (role && role.position >= me.roles.highest.position)
        throw new Error(`Роль ${roleId} на сервере ${guild.name} выше роли бота; база не сброшена.`);
    }
    guilds.set(guildId, guild);
  }

  const failures: string[] = [];
  let deletedChannels = 0;
  let deletedRoles = 0;
  for (const [guildId, resources] of byGuild) {
    const guild = guilds.get(guildId)!;
    for (const channelId of resources.channels) {
      try {
        const channel = await guild.channels.fetch(channelId);
        if (channel) { await channel.delete('Event Master reset: remove event-created channels'); deletedChannels++; }
      } catch (error) {
        if (!isMissingDiscordResource(error)) failures.push(`канал ${channelId}: ${error instanceof Error ? error.message : 'ошибка Discord'}`);
      }
    }
    for (const categoryId of resources.categories) {
      try {
        const category = await guild.channels.fetch(categoryId);
        if (category) { await category.delete('Event Master reset: remove event-created category'); deletedChannels++; }
      } catch (error) {
        if (!isMissingDiscordResource(error)) failures.push(`категория ${categoryId}: ${error instanceof Error ? error.message : 'ошибка Discord'}`);
      }
    }
    for (const roleId of resources.roles) {
      try {
        const role = await guild.roles.fetch(roleId);
        if (role) { await role.delete('Event Master reset: remove event-created role'); deletedRoles++; }
      } catch (error) {
        if (!isMissingDiscordResource(error)) failures.push(`роль ${roleId}: ${error instanceof Error ? error.message : 'ошибка Discord'}`);
      }
    }
  }
  if (failures.length)
    throw new Error(`Удалено каналов/категорий: ${deletedChannels}, ролей: ${deletedRoles}. Не удалось удалить: ${failures.join('; ')}. Данные PostgreSQL сохранены; повторите reset после исправления прав.`);
  return { deletedChannels, deletedRoles };
}
