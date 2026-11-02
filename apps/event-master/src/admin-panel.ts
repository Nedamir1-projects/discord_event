/* eslint-disable @typescript-eslint/no-explicit-any -- each panel section has a distinct Prisma payload shape. */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  Message,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  getDatabase,
  getRaceNameRu,
  isAdmin,
  logger,
  createHuntEvent,
  configureHuntEvent,
  configureHuntBoss,
  startHuntBoss,
  getHuntLeaderboard,
  createHalloweenEvent,
  addHalloweenChapter,
  attachHalloweenRiddle,
  createHalloweenPoll,
  assignHalloweenTraitor,
  parseDiscordMessageUrl,
  registerSharedPumpkin,
  configureSharedPumpkin,
  listPumpkinFinders,
  getSevenPumpkinCollectors,
  resetSharedPumpkinProgress,
  pauseMatrixNight,
  resumeMatrixNight,
  startMatrixNight,
  endMatrixNight,
} from '@discord-bots/shared';
import {
  adjustPlayerCandies,
  createEvent,
  createQuest,
  createRiddle,
  getPanelData,
  panelSections,
  recordAdminAction,
  registerPumpkin,
  setEventStatus,
  updateRiddle,
  updatePumpkin,
  createPanelShopItem,
  updatePanelShopItem,
  resetAllGameData,
  type PanelSection,
} from './admin-service.js';
import { parseBoundedInteger, parseDiscordId } from './admin-service.js';
import { canUsePanel } from './panel-policy.js';
import { createMatrixDiscordAdapter } from './matrix-discord-adapter.js';
import { buildHuntSignupMessage } from './hunt-signup-message.js';
import {
  deleteProvisionedEvents,
  provisionEvent,
} from './event-provisioning.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const PANEL_PAGE_SIZE = 10;
type PendingAction =
  | { kind: 'event-status'; id: string; status: string }
  | { kind: 'boss-start'; id: string }
  | { kind: 'factory-reset' }
  | { kind: 'pumpkin-reset' }
  | { kind: 'matrix-transition'; id: string; operation: 'start' | 'end' }
  | { kind: 'candies'; id: string; mode: 'give' | 'take'; amount: number };
const sessions = new Map<
  string,
  {
    ownerId: string;
    expiresAt: number;
    section: PanelSection;
    selectedId: string | undefined;
    pending: PendingAction | undefined;
    page?: number;
  }
>();
const labels: Record<PanelSection, string> = {
  events: 'События',
  halloween: 'Проклятие Хэллоуина',
  riddles: 'Загадки',
  quests: 'Квесты',
  pumpkins: 'Тыквы',
  shop: 'Магазин',
  economy: 'Экономика',
  players: 'Игроки',
  stats: 'Статистика',
  logs: 'Журнал действий',
  system: 'Состояние системы',
};

const homeButtons = (sessionId: string): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentId(sessionId, 'home:hunt')).setLabel('🍬 Ночь охоты - Битва за сладости').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(componentId(sessionId, 'home:halloween')).setLabel('🎃 Проклятие Хэллоуина').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(componentId(sessionId, 'home:control')).setLabel('📊 Центр управления').setStyle(ButtonStyle.Secondary),
  );

function homeEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Панель управления Event Master')
    .setDescription('Выберите событие для управления или откройте общую статистику и журналы системы.');
}

function componentId(sessionId: string, action: string): string {
  return `em:${sessionId}:${action}`;
}
function components(
  sessionId: string,
  section: PanelSection,
  data: unknown,
  pending?: PendingAction,
): ActionRowBuilder<any>[] {
  const selectedId = sessions.get(sessionId)?.selectedId;
  const select = new StringSelectMenuBuilder()
    .setCustomId(componentId(sessionId, 'section'))
    .setPlaceholder('Выберите раздел')
    .addOptions(
      panelSections.map((value) => ({
        label: labels[value],
        value,
        default: value === section,
      })),
    );
  const rows: any[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  const pageCount = Array.isArray(data) ? Math.max(1, Math.ceil(data.length / PANEL_PAGE_SIZE)) : 1;
  const currentPage = sessions.get(sessionId)?.page ?? 0;
  if (pageCount > 1 && !pending) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(componentId(sessionId, 'page:previous')).setLabel('← Назад').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 0),
      new ButtonBuilder().setCustomId(componentId(sessionId, 'page:next')).setLabel('Вперёд →').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    ));
  }
  if (pending) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'confirm'))
          .setLabel('Подтвердить')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'cancel'))
          .setLabel('Отмена')
          .setStyle(ButtonStyle.Secondary),
      ) as never,
    );
  } else if (
    ['events', 'halloween', 'riddles', 'quests', 'pumpkins'].includes(section)
  ) {
    const actions =
      section === 'halloween' && selectedId
        ? []
        : [
            new ButtonBuilder()
              .setCustomId(
                componentId(
                  sessionId,
                  section === 'pumpkins'
                    ? 'create:shared-pumpkin'
                    : section === 'riddles'
                      ? 'create:riddle'
                      : `create:${section}`,
                ),
              )
              .setLabel(
                section === 'pumpkins'
                  ? 'Зарегистрировать тыкву'
                  : section === 'halloween'
                    ? 'Создать событие'
                    : section === 'riddles'
                      ? 'Добавить загадку'
                      : 'Создать',
              )
              .setStyle(ButtonStyle.Primary),
          ];
    if (section === 'events' && Array.isArray(data) && data.length) {
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'event-actions'))
          .setLabel('Управлять событием')
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (section === 'events')
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:hunt'))
          .setLabel('Создать Ночь охоты')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:halloween'))
          .setLabel('Создать Проклятие Хэллоуина')
          .setStyle(ButtonStyle.Success),
      );
    if (section === 'halloween' && selectedId) {
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:chapter'))
          .setLabel('Добавить главу')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:halloween-riddle'))
          .setLabel('Подключить загадку')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:halloween-quest'))
          .setLabel('Подключить квест')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:poll'))
          .setLabel('Создать голосование')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'create:traitor'))
          .setLabel('Назначить предателя')
          .setStyle(ButtonStyle.Danger),
      );
    }
    if (section === 'riddles' && Array.isArray(data) && data.length) {
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'riddle-edit'))
          .setLabel('Изменить загадку')
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (section === 'pumpkins' && Array.isArray(data) && data.length) {
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'shared-pumpkin-edit'))
          .setLabel('Настроить выбранную')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'pumpkin-finders'))
          .setLabel('Посмотреть открытия')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'pumpkin-errors'))
          .setLabel('Ошибки проверки')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'pumpkin-reset-request'))
          .setLabel('Сбросить прогресс')
          .setStyle(ButtonStyle.Danger),
      );
    }
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...actions));
  } else if (section === 'shop') {
    const actions = [
      new ButtonBuilder()
        .setCustomId(componentId(sessionId, 'create:shop-item'))
        .setLabel('Добавить товар')
        .setStyle(ButtonStyle.Primary),
    ];
    if (selectedId && Array.isArray(data) && data.some((item: any) => item.id === selectedId))
      actions.push(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'shop-item-edit'))
          .setLabel('Изменить выбранный товар')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'shop-item-role'))
          .setLabel('Настроить роль')
          .setStyle(ButtonStyle.Secondary),
      );
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...actions));
  } else if (section === 'economy') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'give'))
          .setLabel('Выдать конфеты')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'take'))
          .setLabel('Снять конфеты')
          .setStyle(ButtonStyle.Danger),
      ),
    );
  } else if (section === 'players') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(componentId(sessionId, 'player-profile'))
          .setLabel('Профиль игрока')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  } else if (section === 'stats') {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(componentId(sessionId, 'control-logs')).setLabel('Журнал действий').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(componentId(sessionId, 'control-errors')).setLabel('Журнал ошибок').setStyle(ButtonStyle.Danger),
    ));
  }
  if (section === 'events' && Array.isArray(data) && data.length && !pending) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(componentId(sessionId, 'event-select'))
          .setPlaceholder('Выберите событие')
          .addOptions(
            data.slice(0, 25).map((event: any) => ({
              label: `${event.title} (${event.status})`.slice(0, 100),
              value: event.id,
            })),
          ),
      ),
    );
  }
  if (
    section === 'halloween' &&
    Array.isArray(data) &&
    data.length &&
    !pending
  ) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(componentId(sessionId, 'halloween-event-select'))
          .setPlaceholder('Выберите событие «Проклятие Хэллоуина»')
          .addOptions(
            data.slice(0, 25).map((event: any) => ({
              label: `${event.title} (${event.status})`.slice(0, 100),
              value: event.id,
            })),
          ),
      ),
    );
  }
  if (section === 'riddles' && Array.isArray(data) && data.length && !pending) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(componentId(sessionId, 'riddle-select'))
          .setPlaceholder('Выберите загадку')
          .addOptions(
            data.slice(0, 25).map((riddle: any) => ({
              label: riddle.title.slice(0, 100),
              value: riddle.id,
            })),
          ),
      ),
    );
  }
  if (
    section === 'pumpkins' &&
    Array.isArray(data) &&
    data.length &&
    !pending
  ) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(componentId(sessionId, 'pumpkin-select'))
          .setPlaceholder('Выберите зарегистрированную тыкву')
          .addOptions(
            data.slice(0, 25).map((item: any) => ({
              label:
                `Тыква ${item.slot} · №${item.pumpkinNumber} · ${item.active ? 'активна' : 'выключена'}`.slice(
                  0,
                  100,
                ),
              value: String(item.slot),
            })),
          ),
      ),
    );
  }
  if (section === 'shop' && Array.isArray(data) && data.length && !pending) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(componentId(sessionId, 'shop-item-select'))
          .setPlaceholder('Выберите товар для изменения')
          .addOptions(
            data.slice(0, 25).map((item: any) => ({
              label: `${item.name} · ${item.price} конфет${item.available ? '' : ' · выключен'}`.slice(0, 100),
              value: item.id,
              default: item.id === selectedId,
            })),
          ),
      ),
    );
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentId(sessionId, 'home:main')).setLabel('Назад в главное меню').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function formatData(section: PanelSection, data: any, page = 0): string {
  if (section === 'economy') {
    if (!Array.isArray(data) || !data.length)
      return 'Игровых балансов пока нет.';
    return data.slice(page * PANEL_PAGE_SIZE, (page + 1) * PANEL_PAGE_SIZE)
      .map((player) => `• ${player.userId}: ${player.candies} конфет`)
      .join('\n')
      ;
  }
  if (section === 'system')
    return `База данных: ${data.database}. Event Master: online (панель отвечает).\n${data.bots.map((bot: any) => `${bot.botId}: ${bot.status}, проверка ${bot.lastSeen.toLocaleString('ru-RU')}`).join('\n') || 'Heartbeats ботов ещё не получены.'}`;
  if (section === 'stats')
    return [
      'Statistics',
      'Events: ' + data.events + '; active: ' + data.activeEvents + '; completed: ' + data.completedEvents,
      'Night Hunt participants: ' + data.huntParticipants,
      'Halloween participants: ' + data.halloweenParticipants,
      'Rewards issued: ' + data.issuedRewards,
      'Errors: ' + data.errors,
      'Players: ' + data.players + '; riddles: ' + data.riddles + '; quests: ' + data.quests + '; pumpkins: ' + data.pumpkins,
    ].join('\n');  if (!Array.isArray(data) || !data.length) return 'Записей пока нет.';
  return data.slice(page * PANEL_PAGE_SIZE, (page + 1) * PANEL_PAGE_SIZE)
    .map((item) => {
      if (section === 'events')
        return `• ${item.title} — ${item.status}; участников: ${item._count.participations}; ID: ${item.id}`;
      if (section === 'riddles')
        return `• ${item.title} — ${item.status}; награда: ${item.reward}; подсказок: ${item.hints.length}; ID: ${item.id}`;
      if (section === 'quests')
        return `• ${item.title} — ${item.status}; награда: ${item.reward}; условия: ${item.conditions || 'не заданы'}; ID: ${item.id}`;
      if (section === 'pumpkins')
        return `• Тыква ${item.slot} · №${item.pumpkinNumber}; ${item.active ? 'активна' : 'выключена'}; открытий: ${item._count.finds}; награда: ${item.reward}; сообщение: ${item.messageId}`;
      if (section === 'shop')
        return `• ${item.name} (${item.id}) — ${item.price} конфет; ${item.available ? 'доступен' : 'выключен'}; лимит: ${item.limit ?? 'нет'}; роль: ${item.roleId ?? 'нет'}${item.description ? `; ${item.description}` : ''}`;
      if (section === 'halloween')
        return `• ${item.title} — ${item.status}; участники: ${item.halloween?._count.participants ?? 0}; главы: ${item.halloween?._count.chapters ?? 0}; голосования: ${item.halloween?._count.polls ?? 0}; ID: ${item.id}`;
      if (section === 'players')
        return `• ${item.userId} — конфеты: ${item.candies}; прогресс: ${JSON.stringify(item.progress)}`;
      return `• ${new Date(item.createdAt).toLocaleString('ru-RU')} — ${item.actorId}: ${item.action} (${item.objectType}/${item.objectId}) — ${item.result}`;
    })
    .join('\n')
    ;
}

function huntRosterPayload(sessionId: string, page: number, rows: any[], rankings: any) {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice(page * pageSize, (page + 1) * pageSize);
  const embed = new EmbedBuilder()
    .setTitle('Участники и вклад в бой')
    .setDescription(visible.map((p, i) => `${page * pageSize + i + 1}. <@${p.userId}> · ${getRaceNameRu(p.race)} · урон ${p.bossDamage} · голос ${p.voiceSeconds} с · сообщения ${p.textMessages}`).join('\n') || 'Участников пока нет.')
    .addFields(
      { name: 'Личный рейтинг · урон', value: rankings.individual.slice(0, 10).map((p: any, i: number) => `${i + 1}. <@${p.userId}> — ${p.bossDamage}`).join('\n') || 'Пока нет данных.', inline: true },
      { name: 'Рейтинг фракций · урон', value: rankings.factions.map((faction: any) => `${faction.faction}: ${faction._sum.damage ?? 0}`).join('\n').slice(0, 1024) || 'Пока нет данных.', inline: true },
    )
    .setFooter({ text: `Страница ${page + 1} из ${pageCount} · Участников: ${rows.length}` });
  const components = pageCount > 1 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentId(sessionId, `hunt-roster-page:${Math.max(0, page - 1)}`)).setLabel('← Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(componentId(sessionId, `hunt-roster-page:${Math.min(pageCount - 1, page + 1)}`)).setLabel('Вперёд →').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
  )] : [];
  return { embeds: [embed], components };
}

function matrixRosterPayload(sessionId: string, page: number, participants: any[]) {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(participants.length / pageSize));
  const embed = new EmbedBuilder()
    .setTitle('Участники Судной ночи')
    .setDescription(participants.slice(page * pageSize, (page + 1) * pageSize)
      .map((p, index) => `${page * pageSize + index + 1}. <@${p.userId}> — ${p.role}${p.faction ? ` (${p.faction})` : ''}`)
      .join('\n') || 'Участников пока нет.')
    .setFooter({ text: `Страница ${page + 1} из ${pageCount} · Всего участников: ${participants.length}` });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-roster-page:0')).setLabel('Участники').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-missions')).setLabel('Миссии').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(componentId(sessionId, `matrix-roster-page:${Math.max(0, page - 1)}`)).setLabel('← Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(componentId(sessionId, `matrix-roster-page:${Math.min(pageCount - 1, page + 1)}`)).setLabel('Вперёд →').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
    )],
  };
}

function matrixMissionsPayload(sessionId: string, page: number, missions: any[]) {
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(missions.length / pageSize));
  const visible = missions.slice(page * pageSize, (page + 1) * pageSize);
  const embed = new EmbedBuilder()
    .setTitle('Миссии Судной ночи')
    .setDescription(visible.map((mission) =>
      `**${mission.title}** · ${mission.faction} · ${mission.status}\nПрогресс: ${mission.progress}/${mission.targetProgress}\n${mission.description}`,
    ).join('\n\n') || 'Для этого события миссий пока нет.')
    .setFooter({ text: `Страница ${page + 1} из ${pageCount} · Всего миссий: ${missions.length}` });
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-roster-page:0')).setLabel('Участники').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(componentId(sessionId, `matrix-mission-page:${Math.max(0, page - 1)}`)).setLabel('← Назад').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(componentId(sessionId, `matrix-mission-page:${Math.min(pageCount - 1, page + 1)}`)).setLabel('Вперёд →').setStyle(ButtonStyle.Secondary).setDisabled(page >= pageCount - 1),
    )],
  };
}

async function render(
  sessionId: string,
  message: Message | ButtonInteraction | StringSelectMenuInteraction,
  section?: PanelSection,
): Promise<void> {
  const session = sessions.get(sessionId)!;
  if (section) session.section = section;
  const data = await getPanelData(session.section);
  const embed = new EmbedBuilder()
    .setTitle(`Event Master · ${labels[session.section]}`)
    .setDescription(formatData(session.section, data, session.page))
    .setFooter({
      text: 'Панель действует 15 минут. Все изменения записываются в журнал.',
    });
  const payload = {
    embeds: [embed],
    components: components(sessionId, session.section, data, session.pending),
  };
  if (message instanceof Message) await message.edit(payload);
  else await message.update(payload);
}

async function openAdminPanel(
  interaction: ChatInputCommandInteraction,
  adminIds: string,
): Promise<void> {
  const authorized = isAdmin(interaction.user.id, adminIds);
  if (!authorized) {
    await recordAdminAction(
      interaction.user.id,
      'panel.access_denied',
      'panel',
      'open',
      'failure',
    ).catch(() => undefined);
    await interaction
      .reply({
        content: 'Доступ к панели запрещён.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return;
  }
  for (const [id, state] of sessions) {
    if (state.expiresAt < Date.now()) sessions.delete(id);
  }
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    ownerId: interaction.user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
    section: 'events',
    selectedId: undefined,
    pending: undefined,
    page: 0,
  });
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const data = await getPanelData('events');
    const embed = new EmbedBuilder()
      .setTitle('Event Master · События')
      .setDescription(formatData('events', data))
      .setFooter({
        text: 'Панель действует 15 минут. Все изменения записываются в журнал.',
      });
    await interaction.editReply({
      embeds: [homeEmbed()],
      components: [homeButtons(sessionId)],
    });
    await recordAdminAction(
      interaction.user.id,
      'panel.open',
      'panel',
      sessionId,
      'success',
    );
  } catch (error) {
    sessions.delete(sessionId);
    await recordAdminAction(
      interaction.user.id,
      'panel.open',
      'panel',
      sessionId,
      'failure',
      { error: error instanceof Error ? error.name : 'UnknownError' },
    ).catch(() => undefined);
    const text = 'Не удалось открыть панель. Повторите команду позже.';
    if (interaction.deferred || interaction.replied)
      await interaction
        .editReply({ content: text, embeds: [], components: [] })
        .catch(() => undefined);
    else
      await interaction
        .reply({ content: text, flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
  }
}

function modal(sessionId: string, kind: string): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(
    componentId(sessionId, `submit:${kind}`),
  );
  const field = (
    id: string,
    label: string,
    style = TextInputStyle.Short,
    required = true,
    placeholder?: string,
  ): ActionRowBuilder<TextInputBuilder> =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(4000)
        .setPlaceholder(placeholder ?? label),
    );
  if (kind === 'event')
    return modal
      .setTitle('Создать событие')
      .addComponents(
        field('title', 'Название'),
        field('description', 'Описание', TextInputStyle.Paragraph, false),
      );
  if (kind === 'hunt')
    return modal
      .setTitle('Создать Ночь охоты')
      .addComponents(
        field('title', 'Название', TextInputStyle.Short, false),
        field('description', 'Описание', TextInputStyle.Paragraph, false),
        field('signupChannelId', 'ID канала для регистрации', TextInputStyle.Short, true),
      );
  if (kind === 'hunt-config')
    return modal
      .setTitle('Настройки Ночи охоты')
      .addComponents(
        field(
          'durationDays',
          'Длительность, дней',
          TextInputStyle.Short,
          true,
          'Например: 3',
        ),
        field(
          'startsAt',
          'Начало события',
          TextInputStyle.Short,
          false,
          'ГГГГ-ММ-ДДTчч:мм:сс+05:00 или пусто',
        ),
        field(
          'endsAt',
          'Окончание события',
          TextInputStyle.Short,
          false,
          'ГГГГ-ММ-ДДTчч:мм:сс+05:00 или пусто',
        ),
        field(
          'rewards',
          'Награды: участие, личная, фракция',
          TextInputStyle.Short,
          false,
          'Числа через запятую: 10, 25, 50 (пусто — 0)',
        ),
        field(
          'activity',
          'Активность: голос, сообщения',
          TextInputStyle.Short,
          false,
          'Конфеты за минуту и сообщение: 1, 2 (пусто — 0)',
        ),
      );
  if (kind === 'hunt-boss')
    return modal
      .setTitle('Настроить босса')
      .addComponents(
        field('name', 'Имя босса'),
        field(
          'health',
          'Здоровье босса',
          TextInputStyle.Short,
          true,
          'Введите целое число',
        ),
        field(
          'durationMinutes',
          'Длительность боя, минут',
          TextInputStyle.Short,
          true,
          'Например: 60',
        ),
        field(
          'actions',
          'Действия: название=урон',
          TextInputStyle.Paragraph,
          true,
          'Через запятую: удар=10, заклинание=20',
        ),
        field(
          'rules',
          'Фазы и правила урона',
          TextInputStyle.Paragraph,
          false,
          'Фазы: 70,30; правила: база=10, раса.Ведьма=1.5, фаза.1=2',
        ),
      );
  if (kind === 'halloween')
    return modal
      .setTitle('Создать Проклятие Хэллоуина')
      .addComponents(
        field(
          'title',
          'Название события',
          TextInputStyle.Short,
          false,
          'Проклятие Хэллоуина',
        ),
        field(
          'durationDays',
          'Длительность, дней',
          TextInputStyle.Short,
          true,
          '34',
        ),
        field(
          'timezone',
          'Часовой пояс',
          TextInputStyle.Short,
          true,
          'Например: Asia/Qyzylorda',
        ),
      );
  if (kind === 'chapter')
    return modal
      .setTitle('Добавить главу истории')
      .addComponents(
        field('order', 'Номер главы', TextInputStyle.Short, true, '1, 2, 3…'),
        field('title', 'Название главы'),
        field('content', 'Текст главы', TextInputStyle.Paragraph),
        field(
          'opensAt',
          'Открыть с даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
        field(
          'closesAt',
          'Закрыть после даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
      );
  if (kind === 'halloween-riddle')
    return modal
      .setTitle('Подключить загадку к событию')
      .addComponents(
        field('riddleId', 'ID загадки'),
        field(
          'storyOrder',
          'Порядок в истории',
          TextInputStyle.Short,
          false,
          'Номер шага или пусто',
        ),
        field(
          'opensAt',
          'Открыть с даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
        field(
          'closesAt',
          'Закрыть после даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
        field(
          'isFinal',
          'Финальная головоломка?',
          TextInputStyle.Short,
          true,
          'да или нет',
        ),
      );
  if (kind === 'halloween-quest')
    return modal
      .setTitle('Создать квест для Хэллоуина')
      .addComponents(
        field('title', 'Название квеста'),
        field('description', 'Описание квеста', TextInputStyle.Paragraph),
        field('conditions', 'Условия выполнения', TextInputStyle.Paragraph),
        field('reward', 'Награда, конфеты'),
      );  if (kind === 'poll')
    return modal
      .setTitle('Создать голосование')
      .addComponents(
        field('title', 'Название голосования'),
        field('prompt', 'Вопрос', TextInputStyle.Paragraph),
        field(
          'options',
          'Варианты через запятую',
          TextInputStyle.Paragraph,
          true,
          'Игрок A, Игрок B',
        ),
        field(
          'opensAt',
          'Открыть с даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
        field(
          'closesAt',
          'Закрыть после даты',
          TextInputStyle.Short,
          false,
          'Дата с часовым поясом или пусто',
        ),
      );
  if (kind === 'traitor')
    return modal
      .setTitle('Назначить скрытого предателя')
      .addComponents(field('userId', 'Discord ID участника'));
  if (kind === 'shared-pumpkin')
    return modal
      .setTitle('Зарегистрировать общую тыкву №17')
      .addComponents(
        field('slot', 'Слот тыквы, от 1 до 7'),
        field(
          'messageLink',
          'Ссылка на сообщение с тыквой',
          TextInputStyle.Short,
          true,
          'Вставьте ссылку Discord',
        ),
        field(
          'authors',
          'Разрешённые авторы',
          TextInputStyle.Paragraph,
          true,
          'Discord ID через запятую',
        ),
        field(
          'channels',
          'Разрешённые каналы',
          TextInputStyle.Paragraph,
          false,
          'ID каналов через запятую; пусто — только канал сообщения',
        ),
        field('reward', 'Награда, конфеты'),
      );
  if (kind === 'shop-item')
    return modal
      .setTitle('Добавить товар в магазин')
      .addComponents(
        field('id', 'ID товара', TextInputStyle.Short, true, 'Например: potion_small'),
        field('name', 'Название товара'),
        field('description', 'Описание', TextInputStyle.Paragraph, false, 'Можно оставить пустым'),
        field('price', 'Цена в конфетах', TextInputStyle.Short, true, 'Целое число от 1'),
        field('roleId', 'ID роли за покупку', TextInputStyle.Short, false, 'Пусто — без роли'),
      );
  if (kind === 'shop-item-edit')
    return modal
      .setTitle('Изменить товар магазина')
      .addComponents(
        field('name', 'Новое название', TextInputStyle.Short, false, 'Пусто — без изменений'),
        field('description', 'Новое описание', TextInputStyle.Paragraph, false, 'Пусто — без изменений'),
        field('price', 'Новая цена', TextInputStyle.Short, false, 'Пусто — без изменений'),
        field('limit', 'Лимит на игрока', TextInputStyle.Short, false, 'Пусто — без изменений; 0 — снять лимит'),
        field('available', 'Доступность', TextInputStyle.Short, false, 'да — включить, нет — выключить'),
      );
  if (kind === 'shop-item-role')
    return modal
      .setTitle('Роль за покупку товара')
      .addComponents(
        field('roleId', 'Discord ID роли', TextInputStyle.Short, false, 'Пусто — убрать выдачу роли'),
      );
  if (kind === 'shared-pumpkin-edit')
    return modal
      .setTitle('Настроить выбранную тыкву')
      .addComponents(
        field(
          'reward',
          'Новая награда',
          TextInputStyle.Short,
          false,
          'Пусто — без изменений',
        ),
        field(
          'authors',
          'Разрешённые авторы',
          TextInputStyle.Paragraph,
          false,
          'ID через запятую; пусто — без изменений',
        ),
        field(
          'channels',
          'Разрешённые каналы',
          TextInputStyle.Paragraph,
          false,
          'ID через запятую; пусто — без изменений',
        ),
        field(
          'active',
          'Активность',
          TextInputStyle.Short,
          false,
          'да — включить, нет — выключить',
        ),
      );
  if (kind === 'riddle')
    return modal
      .setTitle('Создать загадку')
      .addComponents(
        field('title', 'Название'),
        field('prompt', 'Вопрос / текст загадки', TextInputStyle.Paragraph),
        field('answer', 'Ответ'),
        field(
          'hints',
          'Подсказки (необязательно)',
          TextInputStyle.Paragraph,
          false,
          'Каждая подсказка с новой строки или через запятую',
        ),
        field('reward', 'Награда, конфеты'),
      );
  if (kind === 'riddle-edit')
    return modal
      .setTitle('Редактировать выбранную загадку')
      .addComponents(
        field('title', 'Новое название', TextInputStyle.Short, false),
        field('prompt', 'Новый текст загадки', TextInputStyle.Paragraph, false),
        field('answer', 'Новый ответ', TextInputStyle.Paragraph, false),
        field(
          'hints',
          'Подсказки через запятую',
          TextInputStyle.Paragraph,
          false,
          'Первая подсказка, вторая подсказка',
        ),
        field('reward', 'Новая награда', TextInputStyle.Short, false),
      );
  if (kind === 'quest')
    return modal
      .setTitle('Создать квест')
      .addComponents(
        field('title', 'Название'),
        field('description', 'Описание', TextInputStyle.Paragraph),
        field('conditions', 'Условия', TextInputStyle.Paragraph),
        field('reward', 'Награда, конфеты'),
        field(
          'options',
          'Даты и зависимости',
          TextInputStyle.Paragraph,
          false,
          'Начало|окончание; ID зависимостей через запятую',
        ),
      );
  if (kind === 'pumpkins')
    return modal
      .setTitle('Зарегистрировать сообщение с тыквой')
      .addComponents(
        field('messageId', 'ID сообщения'),
        field('authorId', 'Discord ID автора'),
        field('channelId', 'ID канала'),
        field('reward', 'Награда, конфеты'),
      );
  if (kind === 'pumpkin-edit')
    return modal
      .setTitle('Изменить тыкву')
      .addComponents(
        field(
          'authorId',
          'Discord ID автора (необязательно)',
          TextInputStyle.Short,
          false,
        ),
        field(
          'reward',
          'Новая награда (необязательно)',
          TextInputStyle.Short,
          false,
        ),
        field(
          'status',
          'Статус: новая / одобрена / отклонена',
          TextInputStyle.Short,
          false,
          'Введите: новая, одобрена или отклонена',
        ),
      );
  if (kind === 'player')
    return modal
      .setTitle('Найти профиль игрока')
      .addComponents(field('userId', 'Discord ID пользователя'));
  if (kind === 'give' || kind === 'take')
    return modal
      .setTitle(kind === 'give' ? 'Выдать конфеты' : 'Снять конфеты')
      .addComponents(
        field('userId', 'Discord ID пользователя'),
        field('amount', 'Количество конфет'),
      );
  return modal;
}

function read(interaction: Interaction, id: string): string {
  return interaction.isModalSubmit()
    ? interaction.fields.getTextInputValue(id).trim()
    : '';
}

function parseRiddleHints(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((hint) => hint.trim())
    .filter(Boolean);
}

function parseNumberList(value: string, label: string): number[] {
  if (!value.trim()) return [];
  const parts = value.split(',').map((part) => part.trim());
  if (parts.some((part) => !part))
    throw new Error(
      `${label}: разделяйте значения запятыми без пустых пунктов.`,
    );
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0))
    throw new Error(
      `${label}: укажите неотрицательные целые числа через запятую.`,
    );
  return numbers;
}

function parseOptionalDate(value: string): Date | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime()))
    throw new Error(
      'Укажите дату в формате ISO с часовым поясом, например 2026-10-31T18:00:00+05:00.',
    );
  return date;
}

function parseIdList(value: string, kind: 'user' | 'channel'): string[] {
  const ids = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('Укажите хотя бы один Discord ID.');
  return ids.map((id) =>
    kind === 'user'
      ? parseDiscordId(id)
      : /^\d{17,20}$/.test(id)
        ? id
        : (() => {
            throw new Error('Укажите корректный ID канала Discord.');
          })(),
  );
}

function parseNamedNumbers(
  value: string,
  label: string,
): { id: string; amount: number }[] {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.lastIndexOf('=');
      const id = part.slice(0, separator).trim();
      const amount = Number(part.slice(separator + 1).trim());
      if (separator < 1 || !id || !Number.isSafeInteger(amount) || amount < 0)
        throw new Error(
          `${label}: используйте формат «название=целое число» через запятую.`,
        );
      return { id, amount };
    });
  if (!entries.length) throw new Error(`${label}: укажите хотя бы один пункт.`);
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    throw new Error(`${label}: названия должны быть уникальными.`);
  return entries;
}

function parseBossRules(value: string): {
  phases: { atHealthPercent: number }[];
  damageRules: Record<string, unknown>;
} {
  const [phaseList = '', ruleList = ''] = value.split(';', 2);
  const phases = parseNumberList(phaseList, 'Фазы босса').map(
    (atHealthPercent) => {
      if (atHealthPercent > 100)
        throw new Error('Фазы босса задаются процентами от 0 до 100.');
      return { atHealthPercent };
    },
  );
  const races: Record<string, number> = {};
  const phaseMultipliers: Record<string, number> = {};
  const effects: Record<string, number> = {};
  let baseDamage: number | undefined;
  for (const entry of ruleList
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.lastIndexOf('=');
    const key = entry.slice(0, separator).trim();
    const value = Number(entry.slice(separator + 1).trim());
    if (separator < 1 || !Number.isFinite(value) || value < 0)
      throw new Error(
        'Правила урона: используйте формат «ключ=число» через запятую после точки с запятой.',
      );
    if (key === 'база' || key === 'base') baseDamage = value;
    else if (key.startsWith('раса.') || key.startsWith('race.')) {
      const raceName = key.slice(key.indexOf('.') + 1);
      const raceIds: Record<string, string> = {
        смертный: 'Mortal',
        ведьма: 'Witch',
        оборотень: 'Werewolf',
        вампир: 'Vampire',
        призрак: 'Ghost',
      };
      races[raceIds[raceName.toLowerCase()] ?? raceName] = value;
    } else if (key.startsWith('фаза.') || key.startsWith('phase.'))
      phaseMultipliers[key.slice(key.indexOf('.') + 1)] = value;
    else if (key.startsWith('эффект.') || key.startsWith('effect.'))
      effects[key.slice(key.indexOf('.') + 1)] = value;
    else throw new Error(`Неизвестное правило урона: ${key}.`);
  }
  return {
    phases,
    damageRules: {
      ...(baseDamage === undefined ? {} : { baseDamage }),
      ...(Object.keys(races).length ? { races } : {}),
      ...(Object.keys(phaseMultipliers).length
        ? { phases: phaseMultipliers }
        : {}),
      ...(Object.keys(effects).length ? { effects } : {}),
    },
  };
}

export async function handleAdminPanelInteraction(
  interaction: Interaction,
  adminIds: string,
  client: Client,
): Promise<boolean> {
  if (interaction.isChatInputCommand() && interaction.commandName === 'panel') {
    await openAdminPanel(interaction, adminIds);
    return true;
  }
  if (!(
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  ))
    return false;
  const [prefix, sessionId, action, ...tail] = interaction.customId.split(':');
  if (prefix !== 'em' || !sessionId || !action) return false;
  const session = sessions.get(sessionId);
  const authorized = isAdmin(interaction.user.id, adminIds);
  if (
    !session ||
    !canUsePanel(interaction.user.id, adminIds, session)
  ) {
    if (session?.expiresAt && session.expiresAt < Date.now())
      sessions.delete(sessionId);
    await recordAdminAction(
      interaction.user.id,
      'panel.access_denied',
      'panel',
      sessionId,
      'failure',
      { authorized, owner: session?.ownerId === interaction.user.id },
    ).catch(() => undefined);
    await interaction
      .reply({
        content: !authorized
          ? 'Доступ запрещён.'
          : 'Панель истекла или принадлежит другому администратору. Откройте `<panel` заново.',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return true;
  }
  if (
    action.startsWith('matrix-') ||
    (action === 'home' && tail[0] === 'matrix')
  ) {
    await interaction.reply({
      content: 'Эта функция недоступна.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
    return true;
  }
  try {
    if (interaction.isButton() && action === 'home') {
      const destination = tail[0];
      if (destination === 'main') {
        session.selectedId = undefined;
        session.pending = undefined;
        await interaction.update({ embeds: [homeEmbed()], components: [homeButtons(sessionId)] });
        return true;
      }
      if (destination === 'control') {
        await recordAdminAction(interaction.user.id, 'panel.section.view', 'control-center', sessionId);
        session.selectedId = undefined;
        session.pending = undefined;
        session.section = 'stats';
        await render(sessionId, interaction, 'stats');
        return true;
      }
      if (destination === 'matrix') {
        const nights = await getDatabase().matrixNight.findMany({
          include: { event: true, _count: { select: { participants: true, missions: true } } },
          orderBy: { createdAt: 'desc' }, take: 10,
        });
        const description = nights.length
          ? nights.map((night) => `• ${night.event.title} — ${night.phase}; участников: ${night._count.participants}; миссий: ${night._count.missions}; ID: ${night.eventId}`).join('\n').slice(0, 3800)
          : 'Событий «Судная ночь» пока нет. Создайте событие командой /matrix.';
        const embed = new EmbedBuilder().setTitle('Судная ночь — Перезагрузка Матрицы').setDescription(description);
        const rows: ActionRowBuilder<any>[] = [];
        if (nights.length) {
          rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId(componentId(sessionId, 'matrix-select')).setPlaceholder('Выберите Судную ночь').addOptions(nights.slice(0, 25).map((night) => ({ label: `${night.event.title} (${night.phase})`.slice(0, 100), value: night.eventId }))),
          ));
        }
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(componentId(sessionId, 'home:main')).setLabel('Назад в главное меню').setStyle(ButtonStyle.Secondary),
        ));
        await interaction.update({ embeds: [embed], components: rows });
        return true;
      }
      const section: PanelSection = destination === 'halloween' ? 'halloween' : 'events';
      session.selectedId = undefined;
      session.pending = undefined;
      await recordAdminAction(interaction.user.id, 'panel.section.view', section, sessionId);
      await render(sessionId, interaction, section);
      return true;
    }
    if (interaction.isButton() && (action === 'control-logs' || action === 'control-errors')) {
      const rows = await getDatabase().auditLog.findMany({
        ...(action === 'control-errors' ? { where: { result: 'failure' } } : {}),
        orderBy: { createdAt: 'desc' }, take: 15,
      });
      const content = rows.map((row) => `• ${row.createdAt.toISOString()} UTC — <@${row.actorId}> — ${row.action} (${row.objectType}/${row.objectId}) — ${row.result}`).join('\n') || 'Записей пока нет.';
      await interaction.update({ embeds: [new EmbedBuilder().setTitle(action === 'control-errors' ? 'Журнал ошибок Event Master' : 'Журнал действий Event Master').setDescription(content.slice(0, 3900))], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'home:control')).setLabel('Назад в Центр управления').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(componentId(sessionId, 'home:main')).setLabel('Главное меню').setStyle(ButtonStyle.Secondary))] });
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'matrix-select') {
      session.selectedId = interaction.values[0]!;
      const night = await getDatabase().matrixNight.findUnique({ where: { eventId: session.selectedId }, include: { event: true, _count: { select: { participants: true, missions: true } } } });
      if (!night) throw new Error('Событие не найдено.');
      const rows: ActionRowBuilder<any>[] = [];
      const controls = new ActionRowBuilder<ButtonBuilder>();
      if (night.phase === 'waiting') controls.addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-start')).setLabel('Запустить').setStyle(ButtonStyle.Success));
      if (['countdown', 'active'].includes(night.phase)) controls.addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-pause')).setLabel('Пауза').setStyle(ButtonStyle.Secondary));
      if (night.pausedAt) controls.addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-resume')).setLabel('Возобновить').setStyle(ButtonStyle.Success));
      if (night.phase !== 'ended') controls.addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-end')).setLabel('Завершить').setStyle(ButtonStyle.Danger));
      controls.addComponents(new ButtonBuilder().setCustomId(componentId(sessionId, 'matrix-roster')).setLabel('Участники и миссии').setStyle(ButtonStyle.Primary));
      await interaction.update({ embeds: [new EmbedBuilder().setTitle(`Судная ночь: ${night.event.title}`).setDescription(`Статус: ${night.phase}${night.pausedAt ? ' (пауза)' : ''}\nУчастников: ${night._count.participants}\nМиссий: ${night._count.missions}\nID: ${night.eventId}`)], components: rows });
      return true;
    }
    if (interaction.isButton() && action.startsWith('matrix-')) {
      if (!session.selectedId) throw new Error('Выберите Судную ночь.');
      if (action === 'matrix-roster') {
        const participants = await getDatabase().matrixParticipant.findMany({ where: { eventId: session.selectedId }, orderBy: { assignedAt: 'asc' } });
        await interaction.reply({ ...matrixRosterPayload(sessionId, 0, participants), flags: MessageFlags.Ephemeral });
        return true;
      }
      if (action === 'matrix-missions') {
        const missions = await getDatabase().matrixMission.findMany({ where: { eventId: session.selectedId }, orderBy: { createdAt: 'asc' } });
        await interaction.update(matrixMissionsPayload(sessionId, 0, missions));
        return true;
      }
      if (action === 'matrix-roster-page') {
        const page = Number(tail[0]);
        const participants = await getDatabase().matrixParticipant.findMany({ where: { eventId: session.selectedId }, orderBy: { assignedAt: 'asc' } });
        await interaction.update(matrixRosterPayload(sessionId, page, participants));
        return true;
      }
      if (action === 'matrix-mission-page') {
        const page = Number(tail[0]);
        const missions = await getDatabase().matrixMission.findMany({ where: { eventId: session.selectedId }, orderBy: { createdAt: 'asc' } });
        await interaction.update(matrixMissionsPayload(sessionId, page, missions));
        return true;
      }
      if (action === 'matrix-start' || action === 'matrix-end') {
        session.pending = { kind: 'matrix-transition', id: session.selectedId, operation: action === 'matrix-start' ? 'start' : 'end' };
        await interaction.update({ embeds: [new EmbedBuilder().setTitle('Подтверждение операции').setDescription(action === 'matrix-start' ? 'Запустить Судную ночь? Будут проверены роли и разрешения бота.' : 'Завершить Судную ночь? Перед критическими изменениями будет создан снимок состояния.')], components: components(sessionId, session.section, [], session.pending) });
        return true;
      }
      if (action === 'matrix-pause') await pauseMatrixNight(interaction.user.id, session.selectedId);
      else if (action === 'matrix-resume') await resumeMatrixNight(interaction.user.id, session.selectedId);
      await interaction.reply({ content: 'Состояние Судной ночи обновлено.', flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'section') {
      const selected = interaction.values[0] as PanelSection;
      if (!(panelSections as readonly string[]).includes(selected))
        throw new Error('Неизвестный раздел.');
      session.selectedId = undefined;
      session.page = 0;
      await recordAdminAction(
        interaction.user.id,
        'panel.section.view',
        selected,
        sessionId,
      );
      session.pending = undefined;
      await render(sessionId, interaction, selected);
      return true;
    }
    if (interaction.isButton() && action === 'page') {
      const data = await getPanelData(session.section);
      const pageCount = Array.isArray(data) ? Math.max(1, Math.ceil(data.length / PANEL_PAGE_SIZE)) : 1;
      session.page = Math.max(0, Math.min(pageCount - 1, (session.page ?? 0) + (tail[0] === 'next' ? 1 : -1)));
      await render(sessionId, interaction);
      return true;
    }
    if (interaction.isButton() && action === 'hunt-roster-page') {
      if (!session.selectedId) throw new Error('Сначала выберите событие.');
      const page = Number(tail[0]);
      const [rows, rankings] = await Promise.all([
        getDatabase().eventParticipation.findMany({ where: { eventId: session.selectedId }, orderBy: [{ bossDamage: 'desc' }, { joinedAt: 'asc' }] }),
        getHuntLeaderboard(session.selectedId),
      ]);
      await interaction.update(huntRosterPayload(sessionId, page, rows, rankings));
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'event-select') {
      session.selectedId = interaction.values[0]!;
      session.pending = undefined;
      const event = await getDatabase().gameEvent.findUnique({
        where: { id: session.selectedId },
        select: { status: true, title: true },
      });
      if (!event) throw new Error('Событие не найдено.');
      const hunt = ['waiting', 'active', 'paused', 'completed'].includes(
        event.status,
      );
      const options =
        event.status === 'draft' || event.status === 'waiting'
          ? [
              {
                status: hunt ? 'active' : 'running',
                label: 'Запустить',
                style: ButtonStyle.Primary,
              },
            ]
          : event.status === 'running' || event.status === 'active'
            ? [
                {
                  status: 'paused',
                  label: 'Пауза',
                  style: ButtonStyle.Secondary,
                },
                {
                  status: hunt ? 'completed' : 'ended',
                  label: 'Завершить',
                  style: ButtonStyle.Danger,
                },
              ]
            : event.status === 'paused'
              ? [
                  {
                    status: hunt ? 'active' : 'running',
                    label: 'Продолжить',
                    style: ButtonStyle.Primary,
                  },
                  {
                    status: hunt ? 'completed' : 'ended',
                    label: 'Завершить',
                    style: ButtonStyle.Danger,
                  },
                ]
              : [];
      const huntControls = hunt
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'hunt-config'))
                .setLabel('Настроить событие')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'hunt-boss-config'))
                .setLabel('Настроить босса')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'hunt-boss-start'))
                .setLabel('Запустить бой')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'hunt-roster'))
                .setLabel('Участники и вклад')
                .setStyle(ButtonStyle.Primary),
            ),
          ]
        : [];
      await interaction.update({
        content: `Выбрано событие ${session.selectedId}. Выберите действие ниже.`,
        embeds: [],
        components: [
          ...(options.length
            ? [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                  ...options.map(({ status, label, style }) =>
                    new ButtonBuilder()
                      .setCustomId(componentId(sessionId, `status:${status}`))
                      .setLabel(label)
                      .setStyle(style),
                  ),
                ),
              ]
            : []),
          ...huntControls,
        ],
      });
      return true;
    }
    if (
      interaction.isStringSelectMenu() &&
      action === 'halloween-event-select'
    ) {
      session.selectedId = interaction.values[0]!;
      await interaction.update({
        content: `Выбрано событие ${session.selectedId}. Выберите действие ниже.`,
        embeds: [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'status:active'))
              .setLabel('Запустить')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'status:paused'))
              .setLabel('Пауза')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'status:completed'))
              .setLabel('Завершить')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:chapter'))
              .setLabel('Добавить главу')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:poll'))
              .setLabel('Создать голосование')
              .setStyle(ButtonStyle.Primary),
          ),
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:halloween-riddle'))
              .setLabel('Подключить загадку')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:halloween-quest'))
              .setLabel('Подключить квест')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:traitor'))
              .setLabel('Назначить предателя')
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      });
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'riddle-select') {
      session.selectedId = interaction.values[0]!;
      await interaction.update({
        content: `Выбрана загадка ${session.selectedId}. Ответ и содержимое загадок публично не показываются.`,
        embeds: [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'create:riddle-edit'))
              .setLabel('Редактировать')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'shop-item-select') {
      session.selectedId = interaction.values[0]!;
      session.pending = undefined;
      await render(sessionId, interaction);
      return true;
    }
    if (interaction.isStringSelectMenu() && action === 'pumpkin-select') {
      session.selectedId = interaction.values[0]!;
      await interaction.update({
        content: `Выбрана запись о тыкве ${session.selectedId}.`,
        embeds: [],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'shared-pumpkin-edit'))
              .setLabel('Изменить автора, награду или статус')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'pumpkin-finders'))
              .setLabel('Открытия и полный сбор')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'pumpkin-errors'))
              .setLabel('Ошибки проверки')
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(componentId(sessionId, 'pumpkin-reset-request'))
              .setLabel('Сбросить прогресс')
              .setStyle(ButtonStyle.Danger),
          ),
        ],
      });
      return true;
    }
    if (interaction.isButton() && action.startsWith('create')) {
      const kind = tail[0];
      if (!kind) throw new Error('Не указано действие панели.');
      await interaction.showModal(modal(sessionId, kind));
      return true;
    }
    if (interaction.isButton() && action === 'event-actions') {
      await interaction.reply({
        content: 'Выберите событие в выпадающем списке раздела «События».',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (
      interaction.isButton() &&
      ['hunt-config', 'hunt-boss-config'].includes(action)
    ) {
      if (!session.selectedId) throw new Error('Сначала выберите событие.');
      await interaction.showModal(
        modal(
          sessionId,
          action === 'hunt-config' ? 'hunt-config' : 'hunt-boss',
        ),
      );
      return true;
    }
    if (interaction.isButton() && action === 'hunt-roster') {
      if (!session.selectedId) throw new Error('Сначала выберите событие.');
      const [rows, rankings] = await Promise.all([
        getDatabase().eventParticipation.findMany({
          where: { eventId: session.selectedId },
          orderBy: [{ bossDamage: 'desc' }, { joinedAt: 'asc' }],
        }),
        getHuntLeaderboard(session.selectedId),
      ]);
      const individual = rankings.individual
        .slice(0, 10)
        .map(
          (player, index) =>
            `${index + 1}. ${player.userId}: ${player.bossDamage}`,
        )
        .join('\n');
      const factions = rankings.factions
        .map((faction) => `${faction.faction}: ${faction._sum.damage ?? 0}`)
        .join('\n');
      await interaction.reply({ ...huntRosterPayload(sessionId, 0, rows, rankings), flags: MessageFlags.Ephemeral });
      /*
      await interaction.reply({
        content: [
          `Личный рейтинг (урон):\n${individual || 'Пока нет данных.'}`,
          `Рейтинг фракций (урон):\n${factions || 'Пока нет данных.'}`,
          `Участники (активность):\n${
            rows
              .map(
                (p) =>
                  `${p.userId} — ${getRaceNameRu(p.race)}; голос ${p.voiceSeconds}с; текст ${p.textMessages}`,
              )
              .join('\n') || 'Пока нет участников.'
          }`,
        ]
          .join('\n\n')
          .slice(0, 1900),
        flags: MessageFlags.Ephemeral,
      });
      */
      return true;
    }
    if (interaction.isButton() && action === 'hunt-boss-start') {
      if (!session.selectedId) throw new Error('Сначала выберите событие.');
      session.pending = { kind: 'boss-start', id: session.selectedId };
      await interaction.reply({
        content: `Подтвердите запуск боя с боссом события ${session.selectedId}.`,
        components: components(sessionId, session.section, [], session.pending),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.isButton() && action === 'player-profile') {
      await interaction.showModal(modal(sessionId, 'player'));
      return true;
    }
    if (interaction.isButton() && (action === 'give' || action === 'take')) {
      await interaction.showModal(modal(sessionId, action));
      return true;
    }
    if (interaction.isButton() && action === 'riddle-edit') {
      if (!session.selectedId)
        throw new Error('Сначала выберите загадку в списке.');
      await interaction.showModal(modal(sessionId, 'riddle-edit'));
      return true;
    }
    if (interaction.isButton() && action === 'shop-item-edit') {
      if (!session.selectedId)
        throw new Error('Сначала выберите товар в списке.');
      await interaction.showModal(modal(sessionId, 'shop-item-edit'));
      return true;
    }
    if (interaction.isButton() && action === 'shop-item-role') {
      if (!session.selectedId)
        throw new Error('Сначала выберите товар в списке.');
      await interaction.showModal(modal(sessionId, 'shop-item-role'));
      return true;
    }
    if (
      interaction.isButton() &&
      ['pumpkin-edit', 'shared-pumpkin-edit'].includes(action)
    ) {
      if (!session.selectedId)
        throw new Error('Сначала выберите зарегистрированную тыкву.');
      await interaction.showModal(
        modal(
          sessionId,
          action === 'shared-pumpkin-edit'
            ? 'shared-pumpkin-edit'
            : 'pumpkin-edit',
        ),
      );
      return true;
    }
    if (interaction.isButton() && action === 'pumpkin-finders') {
      if (!session.selectedId)
        throw new Error('Сначала выберите зарегистрированную тыкву.');
      const slot = Number(session.selectedId);
      const [finders, collectors] = await Promise.all([
        listPumpkinFinders(slot),
        getSevenPumpkinCollectors(),
      ]);
      const collectorText = collectors
        .map((collector) => `• ${collector.userId}`)
        .join('\n');
      await interaction.reply({
        content: [
          `Тыкву ${slot} нашли ${finders.length} участников:`,
          finders.map((finder) => `• ${finder.userId}`).join('\n') ||
            'Пока никто.',
          `Собрали все семь (${collectors.length}):`,
          collectorText || 'Пока никто.',
        ]
          .join('\n')
          .slice(0, 1900),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.isButton() && action === 'pumpkin-errors') {
      const errors = await getDatabase().pumpkinCheckError.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      const details = errors
        .map(
          (item) =>
            `• ${item.createdAt.toISOString()} · ${item.code} · участник ${item.userId} · сообщение ${item.messageId ?? 'не определено'}`,
        )
        .join('\n');
      await interaction.reply({
        content:
          `Последние ошибки проверки тыкв:\n${details || 'Ошибок пока нет.'}`.slice(
            0,
            1900,
          ),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.isButton() && action === 'pumpkin-reset-request') {
      session.pending = { kind: 'pumpkin-reset' };
      await interaction.reply({
        content:
          'Сбросить открытия всех семи тыкв? История финансовых операций сохранится. Уже выданные награды не отзываются.',
        components: components(sessionId, session.section, [], session.pending),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.isButton() && action === 'status') {
      if (!session.selectedId) throw new Error('Сначала выберите событие.');
      const status = tail[0];
      if (
        !status ||
        !['running', 'paused', 'ended', 'active', 'completed'].includes(status)
      )
        throw new Error('Недопустимый статус события.');
      session.pending = {
        kind: 'event-status',
        id: session.selectedId,
        status,
      };
      const pending = session.pending;
      await interaction.update({
        content: `Подтвердите изменение статуса события ${pending.id} на «${pending.status}».`,
        embeds: [],
        components: components(sessionId, session.section, [], session.pending),
      });
      return true;
    }
    if (interaction.isButton() && action === 'cancel') {
      if (session.pending?.kind === 'factory-reset') {
        session.pending = undefined;
        sessions.delete(sessionId);
        await recordAdminAction(
          interaction.user.id,
          'system.factory_reset.cancel',
          'database',
          'all-game-data',
          'success',
        );
        await interaction.update({
          content: 'Полный сброс отменён.',
          components: [],
        });
        return true;
      }
      session.pending = undefined;
      await render(sessionId, interaction);
      return true;
    }
    if (interaction.isButton() && action === 'confirm') {
      if (!session.pending) throw new Error('Нет действия для подтверждения.');
      const pending = session.pending;
      session.pending = undefined;
      if (pending.kind === 'factory-reset') {
        const resources = await deleteProvisionedEvents(client);
        const counts = await resetAllGameData(interaction.user.id);
        sessions.delete(sessionId);
        await interaction.update({
          content: `\u041f\u043e\u043b\u043d\u044b\u0439 \u0441\u0431\u0440\u043e\u0441 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d. \u0423\u0434\u0430\u043b\u0435\u043d\u043e \u043a\u0430\u043d\u0430\u043b\u043e\u0432/\u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0439: ${resources.deletedChannels}, \u0440\u043e\u043b\u0435\u0439: ${resources.deletedRoles}. \u041f\u0440\u043e\u0444\u0438\u043b\u0435\u0439 \u0441\u0431\u0440\u043e\u0448\u0435\u043d\u043e: ${counts.players}, \u0441\u043e\u0431\u044b\u0442\u0438\u0439: ${counts.events}, \u043e\u043f\u0435\u0440\u0430\u0446\u0438\u0439 \u0431\u0430\u043b\u0430\u043d\u0441\u0430: ${counts.balanceTransactions}. \u0420\u0430\u0441 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e: ${counts.racesPreserved}; \u0437\u0430\u0433\u0430\u0434\u043e\u043a \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e: ${counts.riddlesPreserved}; \u043a\u0432\u0435\u0441\u0442\u043e\u0432 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e: ${counts.questsPreserved}.`,
          components: [],
        });
        return true;
      }
      if (pending.kind === 'pumpkin-reset') {
        await resetSharedPumpkinProgress(interaction.user.id);
        await render(sessionId, interaction);
        return true;
      }
      if (pending.kind === 'matrix-transition') {
        const adapter = createMatrixDiscordAdapter(client);
        let startSummary = '';
        if (pending.operation === 'start') {
          const result = await startMatrixNight(
            interaction.user.id,
            pending.id,
            adapter,
          );
          const distribution = Object.entries(result.randomAssignment.counts)
            .map(([role, count]) => `${role}: ${count ?? 0}`)
            .join(', ');
          const failures = result.roleOperations.filter(
            (operation) => operation.status === 'failed',
          ).length;
          startSummary = ` Случайно распределено участников: ${result.randomAssignment.participants} (${distribution}).${failures ? ` Ошибок выдачи ролей: ${failures}; восстановление продолжится автоматически.` : ''}`;
        } else
          await endMatrixNight(interaction.user.id, pending.id, adapter);
        await recordAdminAction(
          interaction.user.id,
          `matrix.${pending.operation}`,
          'event',
          pending.id,
          startSummary.includes('Ошибок выдачи ролей:') ? 'failure' : 'success',
          startSummary ? { partialResult: startSummary } : {},
        );
        const partial = startSummary.includes('Ошибок выдачи ролей:');
        return true;
      }
      if (pending.kind === 'event-status')
        await setEventStatus(interaction.user.id, pending.id, pending.status);
      else if (pending.kind === 'boss-start')
        await startHuntBoss(interaction.user.id, pending.id);
      else
        await adjustPlayerCandies(
          interaction.user.id,
          pending.id,
          pending.amount,
          pending.mode,
        );
      await render(sessionId, interaction);
      return true;
    }
    if (interaction.isModalSubmit() && action === 'submit') {
      const kind = tail[0];
      let createdEventId: string | undefined;
      let provisionedSummary = '';
      let shopItemNotice: string | undefined;
      let riddleNotice: string | undefined;
      if (kind === 'hunt') {
        if (!interaction.guild) throw new Error('Создать событие можно только на сервере Discord.');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      if (kind === 'shared-pumpkin')
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (kind === 'shop-item' || kind === 'shop-item-edit')
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (kind === 'shop-item-role')
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (kind === 'halloween') {
        const event = await createHalloweenEvent(interaction.user.id, {
          ...(read(interaction, 'title')
            ? { title: read(interaction, 'title') }
            : {}),
          durationDays: parseBoundedInteger(
            read(interaction, 'durationDays'),
            1,
            365,
          ),
          timezone: read(interaction, 'timezone'),
        });
        createdEventId = event.id;
        session.selectedId = event.id;
      } else if (kind === 'chapter') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        const opensAt = parseOptionalDate(read(interaction, 'opensAt'));
        const closesAt = parseOptionalDate(read(interaction, 'closesAt'));
        await addHalloweenChapter(interaction.user.id, session.selectedId, {
          order: parseBoundedInteger(read(interaction, 'order'), 1, 10000),
          title: read(interaction, 'title'),
          content: read(interaction, 'content'),
          ...(opensAt ? { opensAt } : {}),
          ...(closesAt ? { closesAt } : {}),
        });
      } else if (kind === 'halloween-riddle') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        const order = read(interaction, 'storyOrder');
        const final = read(interaction, 'isFinal').toLowerCase();
        const opensAt = parseOptionalDate(read(interaction, 'opensAt'));
        const closesAt = parseOptionalDate(read(interaction, 'closesAt'));
        if (!['да', 'нет', 'yes', 'no'].includes(final))
          throw new Error('Укажите «да» или «нет» для финальной загадки.');
        await attachHalloweenRiddle(
          interaction.user.id,
          session.selectedId,
          read(interaction, 'riddleId'),
          {
            ...(order
              ? { storyOrder: parseBoundedInteger(order, 1, 10000) }
              : {}),
            ...(opensAt ? { opensAt } : {}),
            ...(closesAt ? { closesAt } : {}),
            isFinal: ['да', 'yes'].includes(final),
          },
        );
      } else if (kind === 'halloween-quest') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        await createQuest(interaction.user.id, {
          title: read(interaction, 'title'),
          description: read(interaction, 'description'),
          conditions: read(interaction, 'conditions'),
          reward: parseBoundedInteger(read(interaction, 'reward'), 0, 1_000_000),
          dependencies: [],
          campaignEventId: session.selectedId,
        });      } else if (kind === 'poll') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        const opensAt = parseOptionalDate(read(interaction, 'opensAt'));
        const closesAt = parseOptionalDate(read(interaction, 'closesAt'));
        await createHalloweenPoll(interaction.user.id, session.selectedId, {
          title: read(interaction, 'title'),
          prompt: read(interaction, 'prompt'),
          options: read(interaction, 'options')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
          ...(opensAt ? { opensAt } : {}),
          ...(closesAt ? { closesAt } : {}),
        });
      } else if (kind === 'traitor') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        await assignHalloweenTraitor(
          interaction.user.id,
          session.selectedId,
          parseDiscordId(read(interaction, 'userId')),
        );
      } else if (kind === 'shared-pumpkin') {
        const ids = parseDiscordMessageUrl(read(interaction, 'messageLink'));
        const channel = await client.channels.fetch(ids.channelId);
        if (!channel?.isTextBased() || !('messages' in channel))
          throw new Error(
            'Не удалось получить текстовый канал для проверки тыквы.',
          );
        const message = await channel.messages.fetch(ids.messageId);
        if (message.guildId !== ids.guildId || !message.content.includes('🎃'))
          throw new Error(
            'Сообщение должно быть доступно на этом сервере и содержать 🎃.',
          );
        const authors = parseIdList(read(interaction, 'authors'), 'user');
        if (!authors.includes(message.author.id))
          throw new Error(
            'Автор сообщения не включён в список разрешённых авторов.',
          );
        const channels = read(interaction, 'channels')
          ? parseIdList(read(interaction, 'channels'), 'channel')
          : [ids.channelId];
        await registerSharedPumpkin(interaction.user.id, {
          slot: parseBoundedInteger(read(interaction, 'slot'), 1, 7),
          guildId: ids.guildId,
          channelId: ids.channelId,
          messageId: ids.messageId,
          allowedAuthorIds: authors,
          allowedChannelIds: channels,
          reward: parseBoundedInteger(
            read(interaction, 'reward'),
            1,
            1_000_000,
          ),
        });
      } else if (kind === 'shared-pumpkin-edit') {
        if (!session.selectedId) throw new Error('Сначала выберите тыкву.');
        const db = getDatabase();
        const current = await db.sharedPumpkin.findUniqueOrThrow({
          where: { id: session.selectedId },
        });
        const activeText = read(interaction, 'active').toLowerCase();
        if (activeText && !['да', 'нет', 'yes', 'no'].includes(activeText))
          throw new Error('Для активности укажите «да» или «нет».');
        await configureSharedPumpkin(interaction.user.id, current.slot, {
          ...(read(interaction, 'reward')
            ? {
                reward: parseBoundedInteger(
                  read(interaction, 'reward'),
                  1,
                  1_000_000,
                ),
              }
            : {}),
          ...(read(interaction, 'authors')
            ? {
                allowedAuthorIds: parseIdList(
                  read(interaction, 'authors'),
                  'user',
                ),
              }
            : {}),
          ...(read(interaction, 'channels')
            ? {
                allowedChannelIds: parseIdList(
                  read(interaction, 'channels'),
                  'channel',
                ),
              }
            : {}),
          ...(activeText ? { active: ['да', 'yes'].includes(activeText) } : {}),
        });
      } else if (kind === 'event') {
        const event = await createEvent(
          interaction.user.id,
          read(interaction, 'title'),
          read(interaction, 'description'),
        );
        createdEventId = event.id;
      } else if (kind === 'hunt') {
        const title = read(interaction, 'title');
        const description = read(interaction, 'description');
        const signupChannelId = parseDiscordId(read(interaction, 'signupChannelId'));
        const signupChannel = await interaction.guild!.channels.fetch(signupChannelId);
        if (!signupChannel || (signupChannel.type !== ChannelType.GuildText && signupChannel.type !== ChannelType.GuildAnnouncement) || !signupChannel.isSendable())
          throw new Error('Укажите доступный текстовый канал этого сервера.');
        const botMember = interaction.guild!.members.me ?? await interaction.guild!.members.fetchMe();
        const signupPermissions = signupChannel.permissionsFor(botMember);
        if (!signupPermissions?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]))
          throw new Error('Боту нужны права View Channel, Send Messages и Embed Links в канале регистрации.');
        const provisioned = await provisionEvent(interaction.guild!, 'hunt');
        const event = await createHuntEvent(interaction.user.id, {
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          settings: { signupChannelId },
        });
        await configureHuntEvent(interaction.user.id, event.id, { provisioning: provisioned, signupChannelId });
        await signupChannel.send(buildHuntSignupMessage(event.id));
        createdEventId = event.id;
        session.selectedId = event.id;
        provisionedSummary = ` Сообщение регистрации отправлено в <#${signupChannelId}>. Роли: ${Object.entries(provisioned.roles).map(([name, id]) => `${name} <@&${id}>`).join(', ')}. Каналы: ${Object.values(provisioned.channels).map((id) => `<#${id}>`).join(', ')}.`;
      } else if (kind === 'hunt-config') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        const durationDays = parseBoundedInteger(
          read(interaction, 'durationDays'),
          1,
          365,
        );
        const startsAt = read(interaction, 'startsAt');
        const endsAt = read(interaction, 'endsAt');
        const rewards = parseNumberList(
          read(interaction, 'rewards'),
          'Награды',
        );
        if (rewards.length !== 0 && rewards.length !== 3)
          throw new Error(
            'Награды: укажите три числа — за участие, личную награду и фракцию.',
          );
        const activity = parseNumberList(
          read(interaction, 'activity'),
          'Активность',
        );
        if (activity.length !== 0 && activity.length !== 2)
          throw new Error(
            'Активность: укажите два числа — за минуту голосовой активности и сообщение.',
          );
        const [participation = 0, individual = 0, faction = 0] = rewards;
        const [voice = 0, text = 0] = activity;
        await configureHuntEvent(interaction.user.id, session.selectedId, {
          durationMs: durationDays * 86_400_000,
          startsAt: startsAt || null,
          endsAt: endsAt || null,
          rewards: {
            participation,
            individual,
            faction,
          },
          activity: { voice, text },
        });
      } else if (kind === 'hunt-boss') {
        if (!session.selectedId) throw new Error('Сначала выберите событие.');
        const actions = parseNamedNumbers(
          read(interaction, 'actions'),
          'Действия босса',
        ).map(({ id, amount }) => ({ id, damage: amount }));
        const { phases, damageRules } = parseBossRules(
          read(interaction, 'rules'),
        );
        await configureHuntBoss(interaction.user.id, session.selectedId, {
          name: read(interaction, 'name'),
          health: parseBoundedInteger(
            read(interaction, 'health'),
            1,
            2_147_483_647,
          ),
          durationMs: parseBoundedInteger(
            String(
              parseBoundedInteger(
                read(interaction, 'durationMinutes'),
                1,
                35_791,
              ) * 60_000,
            ),
            1,
            2_147_483_647,
          ),
          phases,
          actions,
          damageRules,
        });
      } else if (kind === 'riddle') {
        const riddle = await createRiddle(interaction.user.id, {
          title: read(interaction, 'title'),
          prompt: read(interaction, 'prompt'),
          answer: read(interaction, 'answer'),
          hints: parseRiddleHints(read(interaction, 'hints')),
          reward: parseBoundedInteger(
            read(interaction, 'reward'),
            0,
            1_000_000,
          ),
        });
        riddleNotice = `Загадка создана как черновик. ID: \`${riddle.id}\`. Чтобы участники увидели её, откройте раздел «Проклятие Хэллоуина», выберите событие и нажмите «Подключить загадку».`;
      }
      else if (kind === 'riddle-edit') {
        if (!session.selectedId)
          throw new Error('Выбранная загадка отсутствует.');
        const rewardText = read(interaction, 'reward');
        const title = read(interaction, 'title');
        const prompt = read(interaction, 'prompt');
        const answer = read(interaction, 'answer');
        await updateRiddle(interaction.user.id, session.selectedId, {
          ...(title ? { title } : {}),
          ...(prompt ? { prompt } : {}),
          ...(answer ? { answer } : {}),
          ...(read(interaction, 'hints')
            ? {
                hints: parseRiddleHints(read(interaction, 'hints')),
              }
            : {}),
          ...(rewardText
            ? { reward: parseBoundedInteger(rewardText, 0, 1_000_000) }
            : {}),
        });
      } else if (kind === 'quest') {
        const [datesText, dependenciesText = ''] = read(
          interaction,
          'options',
        ).split(';', 2);
        const dates = (datesText ?? '').split('|').map((x) => x.trim());
        const startsAt = dates[0] ? new Date(dates[0]) : undefined;
        const endsAt = dates[1] ? new Date(dates[1]) : undefined;
        if ([startsAt, endsAt].some((d) => d && Number.isNaN(d.getTime())))
          throw new Error('Укажите даты в ISO-формате.');
        await createQuest(interaction.user.id, {
          title: read(interaction, 'title'),
          description: read(interaction, 'description'),
          conditions: read(interaction, 'conditions'),
          reward: parseBoundedInteger(
            read(interaction, 'reward'),
            0,
            1_000_000,
          ),
          ...(startsAt ? { startsAt } : {}),
          ...(endsAt ? { endsAt } : {}),
          dependencies: dependenciesText
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        });
      } else if (kind === 'shop-item') {
        const item = await createPanelShopItem(interaction.user.id, {
          id: read(interaction, 'id'),
          name: read(interaction, 'name'),
          description: read(interaction, 'description'),
          price: parseBoundedInteger(read(interaction, 'price'), 1, 1_000_000),
          limit: null,
          roleId: read(interaction, 'roleId').trim() || null,
        });
        session.section = 'shop';
        session.selectedId = item.id;
        shopItemNotice = `Товар «${item.name}» добавлен в магазин. ID: ${item.id}; цена: ${item.price} конфет${item.roleId ? `; за покупку будет выдана роль <@&${item.roleId}>` : ''}. Чтобы обновить список, заново выберите «Магазин» в меню разделов.`;
      } else if (kind === 'shop-item-edit') {
        if (!session.selectedId)
          throw new Error('Сначала выберите товар в разделе «Магазин».');
        const name = read(interaction, 'name');
        const description = read(interaction, 'description');
        const priceText = read(interaction, 'price').trim();
        const limitText = read(interaction, 'limit').trim();
        const availableText = read(interaction, 'available').trim().toLowerCase();
        if (availableText && !['да', 'нет', 'yes', 'no'].includes(availableText))
          throw new Error('Доступность укажите как «да» или «нет».');
        const item = await updatePanelShopItem(
          interaction.user.id,
          session.selectedId,
          {
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(priceText
              ? { price: parseBoundedInteger(priceText, 1, 1_000_000) }
              : {}),
            ...(limitText
              ? {
                  limit:
                    parseBoundedInteger(limitText, 0, 1_000_000) || null,
                }
              : {}),
            ...(availableText
              ? { available: ['да', 'yes'].includes(availableText) }
              : {}),
          },
        );
        session.section = 'shop';
        shopItemNotice = `Товар «${item.name}» обновлён. Цена: ${item.price} конфет; ${item.available ? 'доступен' : 'выключен'}. Чтобы обновить список, заново выберите «Магазин» в меню разделов.`;
      } else if (kind === 'shop-item-role') {
        if (!session.selectedId)
          throw new Error('Сначала выберите товар в разделе «Магазин».');
        const roleId = read(interaction, 'roleId').trim();
        const item = await updatePanelShopItem(
          interaction.user.id,
          session.selectedId,
          { roleId: roleId || null },
        );
        session.section = 'shop';
        shopItemNotice = item.roleId
          ? `Для товара «${item.name}» настроена роль <@&${item.roleId}>. Она будет выдаваться после покупки.`
          : `Выдача роли для товара «${item.name}» отключена.`;
      } else if (kind === 'pumpkins') {
        const channel = await client.channels.fetch(
          read(interaction, 'channelId'),
        );
        if (!channel?.isTextBased() || !('messages' in channel))
          throw new Error('Канал не найден или не является текстовым.');
        const message = await channel.messages.fetch(
          read(interaction, 'messageId'),
        );
        const authorId = parseDiscordId(read(interaction, 'authorId'));
        if (message.author.id !== authorId)
          throw new Error('Автор не совпадает с автором сообщения.');
        await registerPumpkin(interaction.user.id, {
          messageId: message.id,
          channelId: channel.id,
          authorId,
          reward: parseBoundedInteger(
            read(interaction, 'reward'),
            0,
            1_000_000,
          ),
        });
      } else if (kind === 'pumpkin-edit') {
        if (!session.selectedId)
          throw new Error('Сначала выберите зарегистрированную тыкву.');
        const db = (await import('@discord-bots/shared')).getDatabase();
        const current = await db.pumpkinMessage.findUnique({
          where: { id: session.selectedId },
        });
        if (!current) throw new Error('Запись о тыкве не найдена.');
        const channel = await client.channels.fetch(current.channelId);
        if (!channel?.isTextBased() || !('messages' in channel))
          throw new Error('Канал не найден или не является текстовым.');
        const message = await channel.messages.fetch(current.messageId);
        const authorId = read(interaction, 'authorId')
          ? parseDiscordId(read(interaction, 'authorId'))
          : current.authorId;
        if (message.author.id !== authorId)
          throw new Error('Автор не совпадает с автором сообщения.');
        const rewardText = read(interaction, 'reward');
        const rawStatus = read(interaction, 'status').toLowerCase();
        const status =
          (
            {
              новая: 'registered',
              одобрена: 'approved',
              отклонена: 'rejected',
              registered: 'registered',
              approved: 'approved',
              rejected: 'rejected',
            } as Record<string, string>
          )[rawStatus] ?? '';
        if (rawStatus && !status)
          throw new Error('Выберите статус: новая, одобрена или отклонена.');
        await updatePumpkin(interaction.user.id, current.id, {
          authorId,
          ...(rewardText
            ? { reward: parseBoundedInteger(rewardText, 0, 1_000_000) }
            : {}),
          ...(status ? { status } : {}),
        });
      } else if (kind === 'player') {
        const userId = parseDiscordId(read(interaction, 'userId'));
        const user = await client.users.fetch(userId);
        const db = (await import('@discord-bots/shared')).getDatabase();
        const profile = await db.playerProfile.findUnique({
          where: { userId },
        });
        const participations = await db.eventParticipation.findMany({
          where: { userId },
          include: { event: true },
          take: 20,
        });
        await interaction.reply({
          content: profile
            ? `Игрок ${user.tag} (${user.id})\nКонфеты: ${profile.candies}\nПрогресс: ${JSON.stringify(profile.progress)}\nУчастие в событиях: ${participations.map((entry) => `${entry.event.title} — ${entry.progress}`).join('; ') || 'нет'}`
            : `Игрок ${user.tag} пока не имеет игрового профиля.`,
          flags: MessageFlags.Ephemeral,
        });
        await recordAdminAction(
          interaction.user.id,
          'player.profile.view',
          'player',
          userId,
          'success',
        );
        return true;
      } else if (kind === 'give' || kind === 'take') {
        const userId = parseDiscordId(read(interaction, 'userId'));
        await client.users.fetch(userId);
        const amount = parseBoundedInteger(
          read(interaction, 'amount'),
          1,
          1_000_000,
        );
        session.pending = { kind: 'candies', id: userId, mode: kind, amount };
        await interaction.reply({
          content: `Подтвердите ${kind === 'give' ? 'выдачу' : 'снятие'} ${amount} конфет у игрока ${userId}.`,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'confirm'))
                .setLabel('Подтвердить')
                .setStyle(ButtonStyle.Danger),
              new ButtonBuilder()
                .setCustomId(componentId(sessionId, 'cancel'))
                .setLabel('Отмена')
                .setStyle(ButtonStyle.Secondary),
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return true;
      } else throw new Error('Неизвестная форма панели.');
      const responseContent = createdEventId
        ? `\u0421\u043e\u0431\u044b\u0442\u0438\u0435 \u0441\u043e\u0437\u0434\u0430\u043d\u043e. ID: \`${createdEventId}\`. \u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c: \`<event start ${createdEventId}\`.${provisionedSummary}`
        : shopItemNotice ??
          riddleNotice ??
          '\u0418\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e \u0432 PostgreSQL \u0438 \u0437\u0430\u043f\u0438\u0441\u0430\u043d\u043e \u0432 \u0436\u0443\u0440\u043d\u0430\u043b \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439.';
      if (interaction.deferred) await interaction.editReply({ content: responseContent });
      else await interaction.reply({ content: responseContent, flags: MessageFlags.Ephemeral });
      return true;
    }
  } catch (error) {
    logger.warn('Admin panel action failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      action,
    });
    await recordAdminAction(
      interaction.user.id,
      `panel.${action}`,
      session.section,
      session.selectedId ?? 'unknown',
      'failure',
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
    ).catch(() => undefined);
    const text =
      error instanceof Error ? error.message : 'Операция не выполнена.';
    if (interaction.deferred) await interaction.editReply({ content: text }).catch(() => undefined);
    else if (interaction.isModalSubmit() || interaction.isStringSelectMenu())
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    else if (interaction.isButton())
      await interaction
        .reply({ content: text, flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    return true;
  }
  return true;
}

export async function handlePrefixAdminCommand(
  message: Message,
  name: string,
  args: string[],
  adminIds: string,
  client: Client,
): Promise<void> {
  if (name === 'reset') {
    if (!isAdmin(message.author.id, adminIds))
      throw new Error(
        'Команда полного сброса доступна только назначенному владельцу.',
      );
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      ownerId: message.author.id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      section: 'system',
      selectedId: undefined,
      pending: { kind: 'factory-reset' },
    });
    await recordAdminAction(
      message.author.id,
      'system.factory_reset.request',
      'database',
      'all-game-data',
      'success',
    );
    await message.author.send({
      content:
        'ВНИМАНИЕ: будут сброшены игровые профили (конфеты и прогресс), история баланса, события, покупки, товары и эффекты. Выбранные расы игроков и каталог рас сохранятся. Боты и команды останутся. Подтвердите действие кнопкой ниже.',
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(componentId(sessionId, 'confirm'))
            .setLabel('Подтвердить полный сброс')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(componentId(sessionId, 'cancel'))
            .setLabel('Отмена')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
    await message
      .reply(
        'Запрос на сброс отправлен вам в личные сообщения для подтверждения.',
      )
      .catch(() => undefined);
    return;
  }
  if (name === 'panel') {
    await recordAdminAction(
      message.author.id,
      'panel.use_slash_command',
      'panel',
      'current-channel',
    );
    await message
      .reply(
        'Откройте `/panel`: Discord позволяет показывать панель только вам через скрытый ответ slash-команды.',
      )
      .catch(() => undefined);
    return;
  }
  if (name === 'help') {
    await message
      .reply(
        'Команды администратора: `<help`, `<panel`, `<events`, `<event start|pause|resume|end <ID>`, `<give <Discord ID> <количество>`, `<take <Discord ID> <количество>`, `<stats`, `<logs [количество]`. Также принимается префикс `>` .',
      )
      .catch(() => undefined);
    await recordAdminAction(
      message.author.id,
      'help.view',
      'command',
      'help',
    ).catch(() => undefined);
    return;
  }
  if (name === 'events') {
    const db = (await import('@discord-bots/shared')).getDatabase();
    const events = await db.gameEvent.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        startsAt: true,
        endsAt: true,
      },
    });
    const lines = events.map(
      (event) =>
        `• ${event.title} — ${event.status}; ID: ${event.id}${event.endsAt ? `; окончание: ${event.endsAt.toISOString()}` : ''}`,
    );
    if (!lines.length) lines.push('Событий пока нет.');
    for (let index = 0; index < lines.length; index += 10)
      await message.author.send(lines.slice(index, index + 10).join('\n'));
    await recordAdminAction(
      message.author.id,
      'events.list',
      'event',
      'all',
      'success',
      { count: events.length },
    );
    await message
      .reply(`Отправил список ${events.length} событий в личные сообщения.`)
      .catch(() => undefined);
    return;
  }
  if (name === 'stats') {
    const stats = (await getPanelData('stats')) as {
      events: number;
      participants: number;
      riddles: number;
      quests: number;
      pumpkins: number;
      errors: number;
      players: number;
      progressRecords: number;
      totalRewards: number;
    };
    await message
      .reply(
        `События: ${stats.events}; участия: ${stats.participants}; игроков: ${stats.players}; записей прогресса: ${stats.progressRecords}; загадки: ${stats.riddles}; квесты: ${stats.quests}; тыквы: ${stats.pumpkins}; ошибки/отказы: ${stats.errors}; награды: ${stats.totalRewards}.`,
      )
      .catch(() => undefined);
    await recordAdminAction(
      message.author.id,
      'stats.view',
      'statistics',
      'global',
    ).catch(() => undefined);
    return;
  }
  if (name === 'logs') {
    const db = (await import('@discord-bots/shared')).getDatabase();
    const limit = args[0] ? parseBoundedInteger(args[0], 1, 50) : 10;
    const records = await db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const output =
      records
        .map(
          (log) =>
            `${log.createdAt.toISOString()} ${log.actorId}: ${log.action} ${log.objectType}/${log.objectId} ${log.result}`,
        )
        .join('\n') || 'Журнал пуст.';
    await message.author.send(output.slice(0, 1900));
    await recordAdminAction(
      message.author.id,
      'logs.view',
      'audit-log',
      'latest',
      'success',
      { limit },
    );
    await message
      .reply('Записи журнала отправлены вам в личные сообщения.')
      .catch(() => undefined);
    return;
  }
  if (name === 'event') {
    const status = (
      {
        start: 'running',
        pause: 'paused',
        resume: 'running',
        end: 'ended',
      } as Record<string, string>
    )[args[0]!];
    if (!status)
      throw new Error(
        'Использование: `<event start|pause|resume|end <ID события>`.',
      );
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      ownerId: message.author.id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      section: 'events',
      selectedId: undefined,
      pending: { kind: 'event-status', id: args[1]!, status },
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(componentId(sessionId, 'confirm'))
        .setLabel('Подтвердить')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(componentId(sessionId, 'cancel'))
        .setLabel('Отмена')
        .setStyle(ButtonStyle.Secondary),
    );
    await message.author.send({
      content: `Подтвердите смену статуса события ${args[1]} на «${status}».`,
      components: [row],
    });
    await message
      .reply('Запрос подтверждения отправлен в личные сообщения.')
      .catch(() => undefined);
    return;
  }
  if (name === 'give' || name === 'take') {
    const userId = parseDiscordId(args[0]!);
    await client.users.fetch(userId);
    const amount = parseBoundedInteger(args[1]!, 1, 1_000_000);
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      ownerId: message.author.id,
      expiresAt: Date.now() + SESSION_TTL_MS,
      section: 'economy',
      selectedId: userId,
      pending: { kind: 'candies', id: userId, mode: name, amount },
    });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(componentId(sessionId, 'confirm'))
        .setLabel('Подтвердить')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(componentId(sessionId, 'cancel'))
        .setLabel('Отмена')
        .setStyle(ButtonStyle.Secondary),
    );
    await message.author.send({
      content: `Подтвердите ${name === 'give' ? 'выдачу' : 'снятие'} ${amount} конфет у игрока ${userId}.`,
      components: [row],
    });
    await message
      .reply('Запрос подтверждения отправлен в личные сообщения.')
      .catch(() => undefined);
    return;
  }
  if (['pumpkin', 'riddle', 'quest'].includes(name)) {
    await recordAdminAction(
      message.author.id,
      `${name}.panel.open`,
      name,
      'panel',
    );
    await message
      .reply(
        `Откройте panel и выберите раздел «${labels[({ pumpkin: 'pumpkins', riddle: 'riddles', quest: 'quests' } as Record<string, PanelSection>)[name]!]}».`,
      )
      .catch(() => undefined);
    return;
  }
}
