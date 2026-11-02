import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type Message,
} from 'discord.js';
import {
  checkDatabaseConnection,
  getDatabase,
  closeDatabase,
  isAdmin,
  loadEventMasterConfig,
  logger,
  setBotStatus,
  recoverHuntEvents,
  recoverHalloweenEvents,
  createMatrixNight,
  assignMatrixRole,
  startMatrixNight,
  pauseMatrixNight,
  resumeMatrixNight,
  addMatrixMission,
  advanceMatrixMission,
  jailMatrixPlayer,
  unjailMatrixPlayer,
  endMatrixNight,
  recoverMatrixNights,
  recordMatrixOutcome,
  listMatrixNights,
  MatrixNightError,
  registerMatrixParticipant,
  joinHunt,
  getRaceNameRu,
} from '@discord-bots/shared';
import { commands } from './commands.js';
import { parseAdminCommand } from './admin-command.js';
import {
  handleAdminPanelInteraction,
  handlePrefixAdminCommand,
} from './admin-panel.js';
import { recordAdminAction } from './admin-service.js';
import { createMatrixDiscordAdapter } from './matrix-discord-adapter.js';
import { assignHuntParticipantMortalRole, provisionEvent } from './event-provisioning.js';

async function handleMatrixCommand(
  interaction: import('discord.js').ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const administrator = isAdmin(interaction.user.id, config.ADMIN_IDS);
  if (!administrator) {
    await interaction.reply({
      content: 'Эта операция доступна только администраторам бота.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === 'list') {
    const events = await listMatrixNights();
    const summary = events
      .map((entry) => {
        const snapshot = entry.snapshots[0];
        const operationCounts = (snapshot?.operations ?? []).reduce(
          (counts, operation) => {
            counts[operation.status] = (counts[operation.status] ?? 0) + 1;
            return counts;
          },
          {} as Record<string, number>,
        );
        return `**${entry.event.title}** · ID: \`${entry.eventId}\` · фаза: ${entry.phase} · участников: ${entry._count.participants} · миссий: ${entry._count.missions} · снимок: ${snapshot?.status ?? 'не создан'} · операции: ${JSON.stringify(operationCounts)}`;
      })
      .join('\n')
      .slice(0, 1900);
    await interaction.reply({
      content: summary || 'Событий «Судная ночь» пока нет.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  let eventId = interaction.options.getString('event_id') ?? '';
  if (['jail', 'unjail'].includes(subcommand)) {
    if (!interaction.guildId)
      throw new MatrixNightError('Эту команду можно использовать только на сервере.', 'guild_only');
    const activeNights = await getDatabase().matrixNight.findMany({
      where: {
        guildId: interaction.guildId,
        phase: 'active',
        pausedAt: null,
        deadlineAt: { gt: new Date() },
      },
      select: { eventId: true },
      take: 2,
    });
    if (activeNights.length !== 1)
      throw new MatrixNightError(
        activeNights.length
          ? 'На сервере запущено несколько активных Судных ночей; обратитесь к администратору.'
          : 'На этом сервере сейчас нет активной Судной ночи.',
        activeNights.length ? 'multiple_active_events' : 'no_active_event',
      );
    eventId = activeNights[0]!.eventId;
  }
  if (subcommand !== 'create') {
    if (!interaction.guildId)
      throw new Error('Команда доступна только на сервере события.');
    const night = await getDatabase().matrixNight.findUnique({
      where: { eventId },
      select: { guildId: true },
    });
    if (!night || night.guildId !== interaction.guildId)
      throw new Error('Событие не найдено на этом сервере.');
  }
  if (subcommand === 'create') {
    if (!interaction.guildId)
      throw new Error('Создавать событие можно только на сервере.');
    if (!interaction.guild) throw new Error('Создание возможно только на сервере Discord.');
    const signupChannelId = interaction.options.getString('signup_channel_id', true);
    const signupChannel = await interaction.guild.channels.fetch(signupChannelId);
    if (!signupChannel || (signupChannel.type !== ChannelType.GuildText && signupChannel.type !== ChannelType.GuildAnnouncement) || !signupChannel.isSendable())
      throw new Error('Укажите доступный текстовый канал или канал объявлений этого сервера.');
    const botMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe();
    const signupPermissions = signupChannel.permissionsFor(botMember);
    if (!signupPermissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]))
      throw new Error('Боту нужны права View Channel, Send Messages и Embed Links в канале регистрации.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const provisioned = await provisionEvent(interaction.guild, 'matrix');
    const created = await createMatrixNight(interaction.user.id, {
      guildId: interaction.guildId,
      title: interaction.options.getString('title', true),
      signupChannelId,
      durationMs:
        (interaction.options.getInteger('duration_hours') ?? 1224) * 3_600_000,
      countdownMs:
        interaction.options.getInteger('countdown_minutes', true) * 60_000,
      roles: {
        Prophet: provisioned.roles.Prophet!,
        Punishers: provisioned.roles.Punishers!,
        Rebels: provisioned.roles.Rebels!,
        Prisoners: provisioned.roles.Prisoners!,
      },
      provisioning: { channels: provisioned.channels, categoryId: provisioned.categoryId },
      ...(interaction.options.getInteger('max_jail_minutes')
        ? {
            maxJailDurationMs:
              interaction.options.getInteger('max_jail_minutes')! * 60_000,
          }
        : {}),
      ...(interaction.options.getString('victory_rules')
        ? { victoryRules: interaction.options.getString('victory_rules') }
        : {}),
      ...(interaction.options.getString('objectives')
        ? { objectives: interaction.options.getString('objectives') }
        : {}),
      maxParticipantsByRole: {
        ...(interaction.options.getInteger('max_prophet')
          ? { Prophet: interaction.options.getInteger('max_prophet')! }
          : {}),
        ...(interaction.options.getInteger('max_punishers')
          ? { Punishers: interaction.options.getInteger('max_punishers')! }
          : {}),
        ...(interaction.options.getInteger('max_rebels')
          ? { Rebels: interaction.options.getInteger('max_rebels')! }
          : {}),
        ...(interaction.options.getInteger('max_prisoners')
          ? { Prisoners: interaction.options.getInteger('max_prisoners')! }
          : {}),
      },
    });
    try {
      await signupChannel.send({
        embeds: [new EmbedBuilder()
          .setTitle(created.title)
          .setDescription('Нажмите кнопку ниже, чтобы записаться в Судную ночь. Роли будут случайно распределены только среди записавшихся участников.')
          .addFields({ name: 'Регистрация', value: 'Открыта до запуска события.' })],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`matrix-signup:${created.id}`)
            .setLabel('Участвовать')
            .setStyle(ButtonStyle.Success),
        )],
      });
    } catch (error) {
      logger.error('Could not send Matrix signup message', {
        eventId: created.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        errorMessage: error instanceof Error ? error.message : String(error),
        discordCode: (error as { code?: number })?.code,
      });
      await interaction.editReply({
        content: `Судная ночь создана (ID: \`${created.id}\`), но сообщение регистрации не отправилось. Проверьте права View Channel, Send Messages и Embed Links в <#${signupChannelId}>. Ошибка Discord: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    await interaction.editReply({
      content: `Судная ночь создана. ID: \`${created.id}\`. Сообщение регистрации отправлено в <#${signupChannelId}>. При запуске роли получат только записавшиеся участники.`,
    });
  } else if (subcommand === 'assign') {
    const role = interaction.options.getString('role', true) as
      'Prophet' | 'Punishers' | 'Rebels' | 'Prisoners';
    await assignMatrixRole(
      interaction.user.id,
      eventId,
      interaction.options.getUser('player', true).id,
      role,
      interaction.options.getString('faction') ?? undefined,
    );
    await interaction.reply({
      content:
        'Предварительная роль сохранена. При запуске состав всех участников сервера будет случайно распределён заново.',
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'start') {
    const missionChannel = await getMatrixMissionChannel(eventId);
    await syncMatrixMissionBoard(eventId);
    const result = await startMatrixNight(
      interaction.user.id,
      eventId,
      matrixAdapter,
    );
    const distribution = Object.entries(result.randomAssignment.counts)
      .map(([role, count]) => `${role}: ${count ?? 0}`)
      .join(', ');
    const failures = result.roleOperations.filter(
      (operation) => operation.status === 'failed',
    ).length;
    await interaction.reply({
      content: `Подготовлен снимок состояния \`${result.snapshotId}\`. Фаза события: ${result.phase}. Случайно распределено участников: ${result.randomAssignment.participants} (${distribution}). Канал миссий: <#${missionChannel.id}>.${failures ? ` Не удалось применить Discord-роль ${failures} участникам; результат записан для восстановления.` : ''}`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'pause') {
    await pauseMatrixNight(interaction.user.id, eventId);
    await interaction.reply({
      content: 'Событие приостановлено; оставшееся время сохранено.',
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'resume') {
    const result = await resumeMatrixNight(interaction.user.id, eventId);
    await interaction.reply({
      content: `Событие продолжено. Фаза: ${result.phase}.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'emergency') {
    if (interaction.options.getString('confirm', true) !== 'ОСТАНОВИТЬ')
      throw new Error(
        'Для подтверждения повторите команду и укажите ОСТАНОВИТЬ.',
      );
    const outcome = interaction.options.getString('outcome', true);
    const restored = await endMatrixNight(
      interaction.user.id,
      eventId,
      matrixAdapter,
      outcome,
    );
    await interaction.reply({
      content: `Событие аварийно завершено. Восстановлено: ${restored.restored}; пропущено: ${restored.skipped}; ошибок: ${restored.errors}. Повторная проверка продолжится автоматически.`,
      flags: MessageFlags.Ephemeral,
    });
    await reportControl(
      `Аварийная остановка события ${eventId}: восстановлено ${restored.restored}, пропущено ${restored.skipped}, ошибок ${restored.errors}.`,
    );
  } else if (subcommand === 'jail') {
    const result = await jailMatrixPlayer(
      interaction.user.id,
      eventId,
      interaction.options.getUser('player', true).id,
      interaction.options.getString('reason', true),
      interaction.options.getInteger('duration_minutes', true) * 60_000,
      interaction.id,
      matrixAdapter,
    );
    await interaction.reply({
      content: result.duplicate
        ? 'Эта операция уже обработана.'
        : `Заключение записано до <t:${Math.floor(result.jail.scheduledEndAt.getTime() / 1000)}:F>. Статус: ${result.result}.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'unjail') {
    const result = await unjailMatrixPlayer(
      interaction.user.id,
      eventId,
      interaction.options.getUser('player', true).id,
      interaction.id,
      matrixAdapter,
    );
    await interaction.reply({
      content: `Заключение завершено. Результат освобождения: ${result.releaseResult}.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'mission_create') {
    const mission = await addMatrixMission(interaction.user.id, eventId, {
      title: interaction.options.getString('title', true),
      description: interaction.options.getString('description', true),
      faction: interaction.options.getString('faction', true),
      targetProgress: interaction.options.getInteger('target_progress', true),
      config: {
        consequence: interaction.options.getString('consequence') ?? '',
      },
    });
    const channelId = await publishMatrixMission(mission.id);
    await interaction.reply({
      content: `Миссия создана и опубликована в <#${channelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === 'outcome') {
    await recordMatrixOutcome(
      interaction.user.id,
      eventId,
      interaction.options.getString('result', true),
    );
    await interaction.reply({
      content: 'Результат события записан в PostgreSQL и аудит.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

const config = loadEventMasterConfig();
const MATRIX_EVENT_ENABLED = false;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});
let shuttingDown = false;
const matrixAdapter = createMatrixDiscordAdapter(client);

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};

async function getMatrixMissionChannel(eventId: string) {
  const db = getDatabase();
  const night = await db.matrixNight.findUnique({ where: { eventId } });
  if (!night) throw new Error('Судная ночь для этой миссии не найдена.');
  const nightConfig = asRecord(night.config);
  const provisioning = asRecord(nightConfig.provisioning);
  const channels = asRecord(provisioning.channels);
  const guild = client.guilds.cache.get(night.guildId) ?? await client.guilds.fetch(night.guildId);
  const configuredChannelId = channels.missions;
  if (typeof configuredChannelId === 'string') {
    const existing = await guild.channels.fetch(configuredChannelId).catch(() => null);
    if (existing?.isTextBased() && existing.isSendable()) return existing;
  }

  const me = guild.members.me ?? await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels))
    throw new Error('Для создания канала миссий боту нужно право Manage Channels.');
  const roleIds = Object.values(asRecord(nightConfig.roles)).filter(
    (id): id is string => typeof id === 'string' && /^\d{17,20}$/.test(id),
  );
  const channel = await guild.channels.create({
    name: 'миссии',
    type: ChannelType.GuildText,
    ...(typeof provisioning.categoryId === 'string' ? { parent: provisioning.categoryId } : {}),
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      ...roleIds.map((id) => ({
        id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages],
      })),
      { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks] },
    ],
    reason: `Создание доски миссий события ${eventId}`,
  });
  await db.matrixNight.update({
    where: { eventId },
    data: {
      config: {
        ...nightConfig,
        provisioning: {
          ...provisioning,
          channels: { ...channels, missions: channel.id },
        },
      } as never,
    },
  });
  return channel;
}

function matrixMissionPayload(mission: {
  id: string;
  title: string;
  description: string;
  faction: string;
  progress: number;
  targetProgress: number;
  status: string;
  config: unknown;
}) {
  const config = asRecord(mission.config);
  const consequence = typeof config.consequence === 'string' ? config.consequence.trim() : '';
  const embed = new EmbedBuilder()
    .setColor(mission.status === 'complete' ? 0x22c55e : 0x5865f2)
    .setTitle(mission.title.slice(0, 256))
    .setDescription(mission.description.slice(0, 3500) || 'Описание не указано.')
    .addFields(
      { name: 'Фракция', value: mission.faction, inline: true },
      { name: 'Прогресс', value: `${mission.progress}/${mission.targetProgress}`, inline: true },
      { name: 'Статус', value: mission.status === 'complete' ? 'Выполнена' : 'Открыта', inline: true },
    );
  if (consequence) embed.addFields({ name: 'Последствие', value: consequence.slice(0, 1024) });
  const components = mission.status === 'open'
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`matrix-mission-advance:${mission.id}`)
          .setLabel('Продвинуть')
          .setStyle(ButtonStyle.Success),
      )]
    : [];
  return { embeds: [embed], components };
}

async function publishMatrixMission(missionId: string): Promise<string> {
  const db = getDatabase();
  const mission = await db.matrixMission.findUnique({ where: { id: missionId } });
  if (!mission) throw new Error('Миссия не найдена.');
  const channel = await getMatrixMissionChannel(mission.eventId);
  const config = asRecord(mission.config);
  const oldMessageId = typeof config.boardMessageId === 'string' ? config.boardMessageId : undefined;
  let message: Message | undefined;
  if (oldMessageId && 'messages' in channel) {
    const fetched = await channel.messages.fetch(oldMessageId).catch(() => null);
    if (fetched) message = await fetched.edit(matrixMissionPayload(mission));
  }
  if (!message) message = await channel.send(matrixMissionPayload(mission));
  const latest = await db.matrixMission.findUniqueOrThrow({ where: { id: missionId } });
  await db.matrixMission.update({
    where: { id: missionId },
    data: {
      config: {
        ...asRecord(latest.config),
        boardMessageId: message.id,
        boardChannelId: channel.id,
      } as never,
    },
  });
  return channel.id;
}

async function syncOpenMatrixMissions(): Promise<void> {
  const missions = await getDatabase().matrixMission.findMany({
    where: { status: 'open' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const mission of missions) {
    try {
      await publishMatrixMission(mission.id);
    } catch (error) {
      logger.warn('Could not publish Matrix mission board item', {
        missionId: mission.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}

async function syncMatrixMissionBoard(eventId: string): Promise<void> {
  const missions = await getDatabase().matrixMission.findMany({
    where: { eventId, status: 'open' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const mission of missions) await publishMatrixMission(mission.id);
}

async function reportControl(message: string): Promise<void> {
  if (!config.BOT_CONTROL_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(config.BOT_CONTROL_CHANNEL_ID);
    if (channel?.isSendable()) await channel.send(message);
  } catch (error) {
    logger.warn('Could not report to bot control channel', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

client.once(Events.ClientReady, (readyClient) => {
  logger.info('Event Master connected to Discord', {
    bot: readyClient.user.tag,
  });
  if (MATRIX_EVENT_ENABLED) void syncOpenMatrixMissions().catch((error: unknown) => {
    logger.error('Matrix mission board reconciliation failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  });
  void reportControl('Event Master запущен.');
  void setBotStatus('event-master', 'online').catch((error: unknown) => {
    logger.warn('Could not persist Event Master status', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (await handleAdminPanelInteraction(interaction, config.ADMIN_IDS, client))
    return;
  if (
    (interaction.isButton() && (
      interaction.customId.startsWith('matrix-signup:') ||
      interaction.customId.startsWith('matrix-mission-advance:')
    )) ||
    (interaction.isModalSubmit() && interaction.customId.startsWith('matrix-mission-contribute:'))
  ) {
    await interaction.reply({ content: 'Эта функция недоступна.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('hunt-signup:')) {
    try {
      if (!interaction.guildId) throw new Error('Кнопка регистрации работает только на сервере.');
      const eventId = interaction.customId.slice('hunt-signup:'.length);
      const event = await getDatabase().gameEvent.findUnique({ where: { id: eventId } });
      if (
        !event ||
        event.eventType !== 'hunt' ||
        !['waiting', 'active', 'paused'].includes(event.status)
      )
        throw new Error('Регистрация на «Ночь охоты» уже закрыта.');
      const existing = await getDatabase().eventParticipation.findUnique({
        where: { eventId_userId: { eventId, userId: interaction.user.id } },
      });
      const participation = await joinHunt(eventId, interaction.user.id, interaction.guildId);
      await assignHuntParticipantMortalRole(
        interaction.guild ?? (await client.guilds.fetch(interaction.guildId)),
        eventId,
        interaction.user.id,
      );
      await interaction.reply({
        content: existing
          ? 'Вы уже записаны на «Ночь охоты».'
          : `Вы записаны на «Ночь охоты». Ваша раса: ${getRaceNameRu(participation.race)}.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : 'Не удалось зарегистрировать участие.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('matrix-signup:')) {
    const eventId = interaction.customId.slice('matrix-signup:'.length);
    try {
      if (!interaction.guildId) throw new MatrixNightError('Эта кнопка работает только на сервере.', 'guild_only');
      const result = await registerMatrixParticipant(eventId, interaction.guildId, interaction.user.id);
      await interaction.reply({
        content: result.duplicate ? 'Вы уже записаны на Судную ночь.' : 'Вы записаны. Роль будет случайно назначена при запуске.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await interaction.reply({
        content: error instanceof MatrixNightError ? error.message : 'Не удалось записать вас на событие.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('matrix-mission-advance:')) {
    try {
      const missionId = interaction.customId.slice('matrix-mission-advance:'.length);
      const mission = await getDatabase().matrixMission.findUnique({ where: { id: missionId } });
      if (!interaction.guildId || !mission || mission.status !== 'open')
        throw new Error('Эта миссия больше недоступна.');
      const night = await getDatabase().matrixNight.findUnique({
        where: { eventId: mission.eventId },
        select: { guildId: true },
      });
      if (night?.guildId !== interaction.guildId)
        throw new Error('Миссия доступна только на сервере события.');
      const modal = new ModalBuilder()
        .setCustomId(`matrix-mission-contribute:${mission.id}`)
        .setTitle(`Продвинуть: ${mission.title}`.slice(0, 45))
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('На сколько единиц увеличить прогресс?')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(9)
            .setValue('1'),
        ));
      await interaction.showModal(modal);
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : 'Не удалось открыть форму вклада.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('matrix-mission-contribute:')) {
    try {
      const missionId = interaction.customId.slice('matrix-mission-contribute:'.length);
      const mission = await getDatabase().matrixMission.findUnique({ where: { id: missionId } });
      if (!interaction.guildId || !mission)
        throw new Error('Миссия не найдена на этом сервере.');
      const night = await getDatabase().matrixNight.findUnique({
        where: { eventId: mission.eventId },
        select: { guildId: true },
      });
      if (night?.guildId !== interaction.guildId)
        throw new Error('Миссия доступна только на сервере события.');
      const amountText = interaction.fields.getTextInputValue('amount').trim();
      const amount = Number(amountText);
      if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1)
        throw new Error('Укажите положительное целое число.');
      const result = await advanceMatrixMission(
        mission.eventId,
        mission.id,
        interaction.user.id,
        interaction.id,
        amount,
      );
      await interaction.reply({
        content: result.duplicate
          ? 'Этот вклад уже был учтён.'
          : `Прогресс «${mission.title}»: ${result.progress}/${mission.targetProgress}${result.completed ? ' — миссия выполнена.' : '.'}`,
        flags: MessageFlags.Ephemeral,
      });
      void publishMatrixMission(mission.id).catch((error: unknown) => {
        logger.warn('Could not refresh Matrix mission board item', {
          missionId: mission.id,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
      });
    } catch (error) {
      await interaction.reply({
        content: error instanceof Error ? error.message : 'Не удалось учесть вклад в миссию.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => undefined);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'matrix') {
      await interaction.reply({ content: 'Эта команда недоступна.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!commands.some((command) => command.name === interaction.commandName))
      return;
    if (interaction.commandName === 'matrix') {
      await handleMatrixCommand(interaction);
      return;
    }
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong!' });
      return;
    }
    if (interaction.commandName === 'eventhelp') {
      await interaction.reply({
        content:
          'Event Master: `/panel` — панель администратора. Участникам доступны команды Economy Bot `/hunt`, `/halloween` и `/pumpkin`.',
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Interaction handler failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorMessage,
      discordCode: (error as { code?: number })?.code,
      ...(error instanceof MatrixNightError ? { matrixErrorCode: error.code } : {}),
    });
    const userMessage = error instanceof MatrixNightError
      ? error.message
      : errorMessage || 'Не удалось обработать команду. Проверьте журнал Event Master.';
    if (interaction.deferred)
      await interaction.editReply({ content: userMessage }).catch(() => undefined);
    else if (!interaction.replied)
      await interaction
        .reply({
          content: userMessage,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
  }
});

async function dispatchPrefix(message: Message): Promise<void> {
  if (message.author.bot) return;
  const parsed = parseAdminCommand(message.content);
  if (parsed.kind === 'ignored') return;
  if (!isAdmin(message.author.id, config.ADMIN_IDS)) {
    await recordAdminAction(
      message.author.id,
      'command.access_denied',
      'command',
      parsed.name,
      'failure',
    ).catch(() => undefined);
    await message.reply('Недостаточно прав.').catch(() => undefined);
    return;
  }
  if (parsed.kind === 'invalid-arguments') {
    await recordAdminAction(
      message.author.id,
      'command.invalid_arguments',
      'command',
      parsed.name,
      'failure',
      { usage: parsed.usage },
    ).catch(() => undefined);
    await message
      .reply(`Неверные аргументы. Использование: ${parsed.usage}`)
      .catch(() => undefined);
    return;
  }
  try {
    await handlePrefixAdminCommand(
      message,
      parsed.name,
      parsed.args,
      config.ADMIN_IDS,
      client,
    );
  } catch (error) {
    logger.warn('Prefix command failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    await recordAdminAction(
      message.author.id,
      `command.${parsed.name}.error`,
      'command',
      parsed.name,
      'failure',
      {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
    ).catch(() => undefined);
    await message
      .reply(
        error instanceof Error
          ? error.message
          : 'Команду выполнить не удалось.',
      )
      .catch(() => undefined);
  }
}

client.on(Events.MessageCreate, (message) => {
  void dispatchPrefix(message).catch((error: unknown) => {
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    logger.error('Prefix command handler failed', { errorType });
    void reportControl(
      `Event Master: критическая ошибка обработчика (${errorType}).`,
    );
  });
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error', { errorType: error.name });
  void reportControl(
    `Event Master: критическая ошибка Discord (${error.name}).`,
  );
});
process.on('unhandledRejection', (error: unknown) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  logger.error('Unhandled promise rejection', { errorType });
  void reportControl(`Event Master: критическая ошибка (${errorType}).`);
});

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down Event Master', { signal });
  await reportControl(`Event Master остановлен (${signal}).`);
  await setBotStatus(
    'event-master',
    signal === 'startup-error' ? 'error' : 'offline',
  ).catch(() => undefined);
  client.destroy();
  try {
    await closeDatabase();
    process.exitCode = 0;
  } catch (error) {
    logger.error('Database shutdown failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  await checkDatabaseConnection();
  logger.info('Event Master database connection ready');
  await recoverHuntEvents();
  await recoverHalloweenEvents();
  client.once(Events.ClientReady, () => {
    const reconcile = () => {
      if (!MATRIX_EVENT_ENABLED) return;
      void recoverMatrixNights(matrixAdapter).catch((error: unknown) => {
        logger.error('Matrix event recovery failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        void reportControl(
          'Не удалось полностью восстановить событие «Судная ночь». Проверьте журнал операций и снимок в PostgreSQL.',
        );
      });
    };
    reconcile();
    setInterval(reconcile, 15_000).unref();
  });
  setInterval(() => {
    void recoverHuntEvents().catch((error: unknown) => {
      logger.error('Hunt event deadline reconciliation failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    });
    void recoverHalloweenEvents().catch((error: unknown) => {
      logger.error('Halloween event deadline reconciliation failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  }, 15_000).unref();
  await client.login(config.EVENT_MASTER_BOT_TOKEN);
}

main().catch(async (error: unknown) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  logger.error('Event Master startup failed', { errorType });
  await reportControl(
    `Event Master: критическая ошибка запуска (${errorType}).`,
  );
  await shutdown('startup-error');
  process.exitCode = 1;
});
