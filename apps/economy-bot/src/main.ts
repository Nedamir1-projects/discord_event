import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
  type Guild,
  type Role,
  type ButtonInteraction,
  type GuildMember,
  type VoiceState,
} from 'discord.js';
import {
  checkDatabaseConnection,
  closeDatabase,
  loadEconomyConfig,
  logger,
  setBotStatus,
  getDatabase,
  getBalance,
  getProfile,
  getRaces,
  getRaceNameRu,
  buyRace,
  listShop,
  buyItem,
  getLeaderboard,
  getBalanceHistory,
  processPendingRewards,
  EconomyError,
  recordTextMessage,
  recordVoiceActivity,
  biteVampire,
  createGameEffect,
  changeBalance,
  playCoinFlip,
  isAdmin,
  getCurrentHunt,
  joinHunt,
  attackHuntBoss,
  recordHuntActivity,
  getCurrentHalloween,
  joinHalloween,
  getMyHalloweenRole,
  readHalloweenStory,
  listHalloweenQuests,
  listOpenHalloweenPolls,
} from '@discord-bots/shared';
import { commands } from './commands.js';
import { handleHuntAttackInteraction } from './hunt-interaction.js';
import {
  handlePumpkinInteraction,
  startPumpkinClaim,
} from './pumpkin-interaction.js';
import { isVoiceChannelAllowed } from './voice-policy.js';
import {
  halloweenRiddleListMessage,
  handleHalloweenRiddleInteraction,
} from './halloween-riddle-interaction.js';
import {
  handleHalloweenPollInteraction,
  startHalloweenPollVote,
} from './halloween-poll-interaction.js';
import {
  createGameEffectRoleAdapter,
  reconcileGameEffectRoles,
} from './game-effect-recovery.js';
const config = loadEconomyConfig();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});
const voiceSessions = new Map<
  string,
  { lastRecordedAt: number; channelId: string }
>();
let shuttingDown = false;
const gameEffectRoleAdapter = createGameEffectRoleAdapter(client);
let effectRecoveryRunning = false;

function halloweenNoticeEmbed(
  title: string,
  description: string,
  color = 0x7d3c98,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title.slice(0, 256))
    .setDescription((description || '\u200b').slice(0, 4096))
    .setTimestamp();
}

async function getAssignableShopRole(
  guild: Guild,
  roleId: string,
): Promise<Role> {
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.id === guild.id)
    throw new EconomyError('Роль товара не найдена на этом сервере. Обратитесь к администратору.');
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (
    !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles) ||
    role.managed ||
    role.comparePositionTo(botMember.roles.highest) >= 0
  )
    throw new EconomyError('Бот не может выдать роль этого товара: проверьте право «Управлять ролями» и положение роли бота.');
  return role;
}

function shopPageComponents(
  items: Awaited<ReturnType<typeof listShop>>,
  ownerId: string,
  page: number,
): ActionRowBuilder<ButtonBuilder>[] {
  const pageCount = Math.ceil(items.length / 5);
  const pageItems = items.slice(page * 5, page * 5 + 5);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (pageItems.length) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...pageItems.map((item, index) =>
          new ButtonBuilder()
            .setCustomId(`shop-buy:${ownerId}:${encodeURIComponent(item.id)}`)
            .setLabel(String(index + 1))
            .setStyle(ButtonStyle.Success),
        ),
      ),
    );
  }
  if (pageCount > 1) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`shop-page:${ownerId}:${Math.max(0, page - 1)}`)
          .setLabel('←')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`shop-page:${ownerId}:${Math.min(pageCount - 1, page + 1)}`)
          .setLabel('→')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pageCount - 1),
      ),
    );
  }
  return rows;
}

function shopPageEmbed(
  items: Awaited<ReturnType<typeof listShop>>,
  page: number,
): EmbedBuilder {
  const pageCount = Math.max(1, Math.ceil(items.length / 5));
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Магазин')
    .setDescription(
      items.length
        ? `${items.slice(page * 5, page * 5 + 5).map((item, index) =>
            `**${index + 1}. ${item.name}** · ${item.price} 🍬\n${item.description}${item.roleId ? `\nРоль: <@&${item.roleId}>` : ''}`,
          ).join('\n\n')}\n\nНажмите кнопку с номером товара, чтобы купить его. Страница ${page + 1}/${pageCount}.`
        : 'Магазин пока пуст. Товары добавляются администратором в каталог.',
    );
}
function recoverGameEffectRoles(): void {
  if (effectRecoveryRunning) return;
  effectRecoveryRunning = true;
  void reconcileGameEffectRoles(gameEffectRoleAdapter)
    .then((result) => {
      if (result.errors)
        logger.warn('Some temporary game effect roles need recovery', {
          errors: result.errors,
        });
    })
    .catch((error: unknown) => {
      logger.warn('Temporary game effect role recovery failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
    })
    .finally(() => {
      effectRecoveryRunning = false;
    });
}
function allowedVoiceState(state: VoiceState): boolean {
  if (
    state.member?.user.bot ||
    client.users.cache.get(state.id)?.bot ||
    !state.channelId
  )
    return false;
  return (
    isVoiceChannelAllowed(
      state.channelId,
      config.VOICE_CHANNEL_IDS,
      config.VOICE_AFK_CHANNEL_IDS,
    ) && !(config.VOICE_IGNORE_SELF_DEAF && state.selfDeaf)
  );
}
async function recordVoiceDelta(
  userId: string,
  session: { lastRecordedAt: number; channelId: string },
  now = Date.now(),
): Promise<void> {
  const seconds = Math.floor((now - session.lastRecordedAt) / 1000);
  if (seconds < 1) return;
  const voiceReward = await recordVoiceActivity({
    userId,
    seconds,
    rewardEverySeconds: config.VOICE_REWARD_EVERY_MINUTES * 60,
    reward: config.VOICE_REWARD_CANDIES,
    operationId: String(session.lastRecordedAt),
  }).catch((error: unknown) => {
    logger.warn('Voice activity reward processing failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
      errorCode: (error as { code?: unknown } | null)?.code,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (voiceReward?.reward)
    logger.info('Voice activity reward granted', {
      userId,
      reward: voiceReward.reward,
    });
  if (!voiceReward) return;
  const hunt = await getCurrentHunt();
  if (hunt?.status === 'active') {
    await recordHuntActivity(
      hunt.id,
      userId,
      'voice',
      seconds,
      `${hunt.id}:${userId}:${session.lastRecordedAt}`,
    ).catch((error: unknown) => {
      logger.warn('Hunt voice progress processing failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        errorCode: (error as { code?: unknown } | null)?.code,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
  }
  session.lastRecordedAt = Math.max(session.lastRecordedAt, now);
}

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = newState.id || oldState.id;
  const session = voiceSessions.get(userId);
  if (
    session &&
    (!allowedVoiceState(newState) || session.channelId !== newState.channelId)
  ) {
    void recordVoiceDelta(userId, session);
    voiceSessions.delete(userId);
  }
  if (allowedVoiceState(newState) && !voiceSessions.has(userId))
    voiceSessions.set(userId, {
      lastRecordedAt: Date.now(),
      channelId: newState.channelId!,
    });
});
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
  logger.info('Economy Bot connected to Discord', {
    bot: readyClient.user.tag,
  });
  void reportControl('Economy Bot запущен.');
  void setBotStatus('economy-bot', 'online').catch(() => undefined);
  if (!config.VOICE_CHANNEL_IDS.split(',').some((id) => id.trim()))
    logger.warn(
      'Voice activity rewards are disabled because VOICE_CHANNEL_IDS is empty',
    );
  recoverGameEffectRoles();
  setInterval(recoverGameEffectRoles, 30_000).unref();
  void processPendingRewards();
  setInterval(() => void processPendingRewards(), 30_000).unref();
  for (const guild of readyClient.guilds.cache.values())
    for (const state of guild.voiceStates.cache.values())
      if (allowedVoiceState(state))
        voiceSessions.set(state.id, {
          lastRecordedAt: Date.now(),
          channelId: state.channelId!,
        });
  setInterval(() => {
    const now = Date.now();
    for (const [userId, session] of voiceSessions)
      void recordVoiceDelta(userId, session, now);
  }, 60_000).unref();
});
async function handleRacePurchaseButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, ownerId, encodedRaceId] = interaction.customId.split(':', 3);
  if (ownerId !== interaction.user.id || !encodedRaceId) {
    await interaction.reply({
      content: 'Эта кнопка выбора расы вам не принадлежит. Вызовите `/race` заново.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  let raceId: string;
  try {
    raceId = decodeURIComponent(encodedRaceId);
  } catch {
    await interaction.reply({
      content: 'Не удалось определить расу. Вызовите `/race` заново.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  try {
    const hunt = await getCurrentHunt();
    if (hunt?.status !== 'active')
      throw new EconomyError('Покупка рас доступна только во время активной «Ночи охоты».');
    const result = await buyRace(
      interaction.user.id,
      raceId,
      `race:${interaction.id}`,
    );
    let roleNotice = '';
    const setup = hunt.settings as {
      provisioning?: { guildId?: string; roles?: Record<string, string> };
    } | undefined;
    const roleKey = result.race.toLowerCase();
    const roleIds = setup?.provisioning?.roles;
    if (
      interaction.guild &&
      setup?.provisioning?.guildId === interaction.guild.id &&
      roleIds?.[roleKey]
    ) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const botMember =
          interaction.guild.members.me ??
          (await interaction.guild.members.fetchMe());
        if (!botMember.permissions.has('ManageRoles'))
          throw new Error('Manage Roles permission is missing');
        const targetRole = await interaction.guild.roles.fetch(roleIds[roleKey]!);
        if (
          !targetRole ||
          targetRole.position >= botMember.roles.highest.position
        )
          throw new Error('Role is missing or above the bot');
        const previousRoleIds = Object.values(roleIds).filter(
          (id) => member.roles.cache.has(id) && id !== targetRole.id,
        );
        if (previousRoleIds.length)
          await member.roles.remove(previousRoleIds, 'Race changed for Night Hunt');
        if (!member.roles.cache.has(targetRole.id))
          await member.roles.add(targetRole, 'Race purchased for Night Hunt');
      } catch (error) {
        logger.warn('Race purchase role assignment failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          userId: interaction.user.id,
          raceId: result.race,
        });
        roleNotice = ' Конфеты списаны и раса сохранена, но бот не смог выдать роль. Проверьте его права и иерархию ролей.';
      }
    }
    await interaction.editReply({
      content: `Вы выбрали расу **${getRaceNameRu(result.race)}**. Баланс: ${result.balance} 🍬.${roleNotice}`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    if (!(error instanceof EconomyError))
      logger.error('Race purchase failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        userId: interaction.user.id,
        raceId,
      });
    await interaction
      .editReply({
        content:
          error instanceof EconomyError
            ? error.message
            : 'Не удалось купить расу. Попробуйте позже.',
        embeds: [],
        components: [],
      })
      .catch(() => undefined);
  }
}

async function handleShopButton(interaction: ButtonInteraction): Promise<void> {
  const [action, ownerId, value] = interaction.customId.split(':', 3);
  if (ownerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Этот магазин открыт другим пользователем. Вызовите `/shop` заново.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const items = await listShop();
  if (action === 'shop-page') {
    const page = Number(value);
    const pageCount = Math.max(1, Math.ceil(items.length / 5));
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
      await interaction.reply({ content: 'Страница магазина устарела. Вызовите `/shop` заново.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({
      embeds: [shopPageEmbed(items, page)],
      components: shopPageComponents(items, ownerId, page),
    });
    return;
  }
  if (action !== 'shop-buy' || !value) return;
  let itemId: string;
  try {
    itemId = decodeURIComponent(value);
  } catch {
    await interaction.reply({ content: 'Не удалось определить товар. Вызовите `/shop` заново.', flags: MessageFlags.Ephemeral });
    return;
  }
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) {
    await interaction.reply({ content: 'Этот товар больше недоступен. Вызовите `/shop` заново.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  try {
    let assignableRole: Role | undefined;
    if (item.roleId) {
      if (!interaction.guild)
        throw new EconomyError('Товар с ролью можно купить только на сервере Discord.');
      assignableRole = await getAssignableShopRole(interaction.guild, item.roleId);
    }
    const result = await buyItem(
      interaction.user.id,
      item.id,
      1,
      `shop:${interaction.id}`,
    );
    let roleNotice = '';
    if (result.roleId && interaction.guild && assignableRole) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.roles.cache.has(assignableRole.id))
          await member.roles.add(assignableRole, `Shop purchase: ${item.id}`);
        roleNotice = ` Роль ${assignableRole} выдана.`;
      } catch (error) {
        logger.warn('Shop purchase role assignment failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          userId: interaction.user.id,
          itemId: item.id,
          roleId: result.roleId,
        });
        roleNotice = ' Покупка оплачена, но роль выдать не удалось. Обратитесь к администратору сервера.';
      }
    }
    await interaction.editReply({
      content: `Покупка выполнена: **${item.name}**. Списано ${result.amount} 🍬. Баланс: ${result.balance} 🍬.${roleNotice}`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    if (!(error instanceof EconomyError))
      logger.error('Shop purchase failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        userId: interaction.user.id,
        itemId,
      });
    await interaction.editReply({
      content: error instanceof EconomyError ? error.message : 'Не удалось купить товар. Попробуйте позже.',
      embeds: [],
      components: [],
    }).catch(() => undefined);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (await handleHalloweenRiddleInteraction(interaction)) return;
  if (
    interaction.isStringSelectMenu() &&
    await handleHalloweenPollInteraction(interaction)
  )
    return;
  if (
    await handlePumpkinInteraction(interaction, client, reportControl).catch(
      (error: unknown) => {
        logger.error('Shared pumpkin interaction failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        return false;
      },
    )
  )
    return;
  if (
    interaction.isButton() &&
    interaction.customId.startsWith('race-buy:')
  ) {
    await handleRacePurchaseButton(interaction);
    return;
  }
  if (
    interaction.isButton() &&
    (interaction.customId.startsWith('shop-buy:') || interaction.customId.startsWith('shop-page:'))
  ) {
    await handleShopButton(interaction);
    return;
  }
  if (
    !interaction.isChatInputCommand() ||
    !commands.some((command) => command.name === interaction.commandName)
  )
    return;
  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong!' });
      return;
    }
    if (interaction.commandName === 'coin') {
      const choice = interaction.options.getString('side', true);
      if (choice !== 'heads' && choice !== 'tails')
        throw new EconomyError('Выберите орла или решку.');
      const stake = interaction.options.getInteger('stake', true);
      const result = await playCoinFlip(
        interaction.user.id,
        choice,
        stake,
        interaction.id,
      );
      const sideName = (side: 'heads' | 'tails') =>
        side === 'heads' ? 'Орёл' : 'Решка';
      await interaction.reply({
        content: `Выпало: **${sideName(result.result)}**. ${result.won ? `Вы выиграли **${result.stake} 🍬** чистыми — ставка возвращена с выигрышем.` : `Вы проиграли ставку **${result.stake} 🍬**.`}\nБаланс: **${result.balance} 🍬**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'hunt') {
      const event = await getCurrentHunt();
      if (!event) {
        await interaction.reply({
          content: 'Событие сейчас не настроено.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (event.status === 'active' && subcommand !== 'join')
        await joinHunt(event.id, interaction.user.id);
      if (subcommand === 'join') {
        const participation = await joinHunt(event.id, interaction.user.id);
        await interaction.reply({
          content: `Вы участвуете в событии. Ваша раса: ${getRaceNameRu(participation.race)}.`,
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'attack') {
        await handleHuntAttackInteraction(
          interaction,
          event.id,
          interaction.options.getString('action', true),
          attackHuntBoss,
        );
      } else {
        const boss = event.boss;
        const participantCount =
          event.status === 'active'
            ? await getDatabase().eventParticipation.count({
                where: { eventId: event.id },
              })
            : event._count.participations;
        await interaction.reply({
          content: `**${event.title}** — ${event.status}; участников: ${participantCount}${event.endsAt ? `; окончание: ${event.endsAt.toLocaleString()}` : ''}${boss ? `\nБосс: ${boss.name}, ${boss.health}/${boss.maxHealth} HP, фаза ${boss.phase}, бой: ${boss.outcome}` : '\nБосс ещё не настроен.'}`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    if (interaction.commandName === 'pumpkin') {
      await startPumpkinClaim(interaction);
      return;
    }
    if (interaction.commandName === 'halloween') {
      const event = await getCurrentHalloween();
      if (!event) {
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              'Событие пока недоступно',
              '«Проклятие Хэллоуина» ещё не создано.',
              0xe74c3c,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (event.status === 'active' && subcommand !== 'join')
        await joinHalloween(event.id, interaction.user.id);
      if (subcommand === 'join') {
        await joinHalloween(event.id, interaction.user.id);
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              'Вы в событии',
              'Вы присоединились к «Проклятию Хэллоуина». Используйте `/halloween story`, чтобы читать историю по главам.',
              0x2ecc71,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'story') {
        const chapter = await readHalloweenStory(event.id, interaction.user.id);
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              chapter
                ? `Глава ${chapter.order}: ${chapter.title}`
                : 'История Хэллоуина',
              (chapter?.content ?? 'Новых глав пока нет.').slice(0, 4096),
              chapter ? 0x8e44ad : 0x95a5a6,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'riddles') {
        await interaction.reply({
          ...(await halloweenRiddleListMessage(event.id, interaction.user.id)),
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'role') {
        const role = await getMyHalloweenRole(event.id, interaction.user.id);
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              'Ваша секретная роль',
              role === 'traitor'
                ? 'Вы — **предатель**. Не раскрывайте свою роль другим игрокам.'
                : 'Вы — **участник**.',
              role === 'traitor' ? 0xc0392b : 0x2980b9,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'quests') {
        const quests = await listHalloweenQuests(event.id, interaction.user.id);
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              'Квесты Хэллоуина',
              quests.length
                ? quests
                    .map(
                      (quest, index) =>
                        `**${index + 1}. ${quest.title}** · ${quest.reward} 🍬\n${quest.description}\n${quest.conditions ? `Условия: ${quest.conditions}` : ''}`,
                    )
                    .join('\n\n')
                    .concat('\n\nПосле выполнения отправьте подтверждение администратору.')
                    .slice(0, 4000)
                : 'Открытых квестов пока нет.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'polls') {
        const polls = await listOpenHalloweenPolls(event.id);
        await interaction.reply({
          embeds: [
            halloweenNoticeEmbed(
              'Голосования Хэллоуина',
              polls.length
                ? polls
                    .map(
                      (poll, index) =>
                        `**${index + 1}. ${poll.title}** · ID: \`${poll.id}\`\n${poll.prompt}\nВарианты: ${poll.options.join(' | ')}`,
                    )
                    .join('\n\n')
                    .slice(0, 4000)
                : 'Открытых голосований пока нет.',
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      } else if (subcommand === 'vote') {
        await startHalloweenPollVote(interaction, event.id);
      }
      return;
    }
    if (
      interaction.commandName === 'bite' ||
      interaction.commandName === 'curse' ||
      interaction.commandName === 'possess'
    ) {
      const target = interaction.options.getUser('player', true);
      if (interaction.commandName === 'bite') {
        const amount = await biteVampire(
          interaction.user.id,
          target.id,
          `bite:${interaction.id}`,
        );
        await interaction.reply({
          content: `Укус успешен: украдено ${amount} 🍬.`,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        const kind =
          interaction.commandName === 'curse' ? 'curse' : 'possession';
        const roleId =
          kind === 'curse'
            ? config.WITCH_CURSE_ROLE_ID
            : config.GHOST_EFFECT_ROLE_ID;
        let roleMember: GuildMember | undefined;
        let effectData: Record<string, string | boolean> = {
          status: kind === 'curse' ? config.WITCH_CURSE_EFFECT : 'possessed',
        };
        if (roleId && interaction.guildId && interaction.guild) {
          roleMember = await interaction.guild.members.fetch(target.id);
          const priorEffects = await getDatabase().gameEffect.findMany({
            where: {
              targetId: target.id,
              expiresAt: { gt: new Date() },
            },
          });
          const priorEffect = priorEffects.find((candidate) => {
            const data = candidate.data as Record<string, unknown>;
            return (
              data.guildId === interaction.guildId && data.roleId === roleId
            );
          });
          const priorData = priorEffect?.data as
            Record<string, unknown> | undefined;
          effectData = {
            roleId,
            guildId: interaction.guildId,
            roleWasPresent: priorEffect
              ? priorData?.roleWasPresent !== false
              : roleMember.roles.cache.has(roleId),
            roleApplied: false,
          };
        }
        const effect = await createGameEffect({
          id: `${kind}:${interaction.id}`,
          ownerId: interaction.user.id,
          targetId: target.id,
          kind,
          durationMs: kind === 'curse' ? 3600000 : 1800000,
          data: effectData,
        });
        if (roleId && roleMember) {
          if (!roleMember.roles.cache.has(roleId))
            await roleMember.roles.add(roleId);
          await getDatabase().gameEffect.update({
            where: { id: effect.id },
            data: {
              data: { ...effectData, roleApplied: true },
            },
          });
        }
        await interaction.reply({
          content: `Эффект действует до ${effect.expiresAt.toLocaleString()}.`,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
    const userId = interaction.user.id;
    if (interaction.commandName === 'balance') {
      const [balance, history] = await Promise.all([
        getBalance(userId),
        getBalanceHistory(userId, 5),
      ]);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('Баланс конфет')
            .setDescription(`У вас **${balance} 🍬**`)
            .addFields({
              name: 'Последние операции',
              value: history.length
                ? history
                    .map(
                      (x) =>
                        `${x.amount > 0 ? '+' : ''}${x.amount} · ${x.reason}`,
                    )
                    .join('\n')
                : 'Операций пока нет.',
            }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'profile') {
      const profile = await getProfile(userId);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle(`Профиль ${interaction.user.username}`)
            .addFields(
              { name: 'Конфеты', value: `${profile.candies} 🍬`, inline: true },
              { name: 'Раса', value: getRaceNameRu(profile.race), inline: true },
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'shop') {
      const items = await listShop();
      await interaction.reply({
        embeds: [shopPageEmbed(items, 0)],
        components: shopPageComponents(items, interaction.user.id, 0),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'race') {
      const races = await getRaces();
      const hunt = await getCurrentHunt();
      const profile = await getProfile(userId);
      const canBuy = hunt?.status === 'active' && profile.race === 'Mortal';
      const visibleRaces = races.slice(0, 25);
      const raceButtons = visibleRaces.map((race) =>
        new ButtonBuilder()
          .setCustomId(
            `race-buy:${interaction.user.id}:${encodeURIComponent(race.id)}`,
          )
          .setLabel(
            `${getRaceNameRu(race.id)} · ${race.price === 0 ? 'бесплатно' : `${race.price} 🍬`}`.slice(
              0,
              80,
            ),
          )
          .setStyle(
            race.id === 'Mortal' ? ButtonStyle.Secondary : ButtonStyle.Primary,
          )
          .setDisabled(!canBuy || race.id === 'Mortal'),
      );
      const raceRows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let index = 0; index < raceButtons.length; index += 5)
        raceRows.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...raceButtons.slice(index, index + 5),
          ),
        );
      const statusText =
        hunt?.status !== 'active'
          ? 'Покупка станет доступна после запуска «Ночи охоты».'
          : profile.race !== 'Mortal'
            ? `У вас уже выбрана раса «${getRaceNameRu(profile.race)}». Расу можно купить только один раз.`
            : 'Нажмите кнопку с выбранной расой. Смертный — бесплатная стартовая раса.';
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x8e44ad)
            .setTitle('Выбор расы')
            .setDescription(
              `${visibleRaces
                .map(
                  (race) =>
                    `**${getRaceNameRu(race.id)}** · ${race.price === 0 ? 'бесплатно' : `${race.price} 🍬`}\n${race.description}`,
                )
                .join('\n\n')}\n\n${statusText}`,
            ),
        ],
        components: raceRows,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'abilities') {
      const profile = await getProfile(userId);
      const race = (await getRaces()).find((x) => x.id === profile.race);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Раса и способности')
            .setDescription(
              `**${getRaceNameRu(profile.race)}**\n${race?.description ?? 'Описание не задано.'}`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.commandName === 'leaderboard') {
      const players = await getLeaderboard(10);
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Таблица лидеров')
            .setDescription(
              players.length
                ? players
                    .map(
                      (x, i) =>
                        `**${i + 1}.** <@${x.userId}> — ${x.candies} 🍬`,
                    )
                    .join('\n')
                : 'Пока нет игроков.',
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (error) {
    logger.error('Interaction handler failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    const description =
      error instanceof EconomyError
        ? error.message
        : 'Не удалось обработать команду. Попробуйте позже.';
    if (interaction.deferred)
      await interaction
        .editReply({
          embeds: [
            halloweenNoticeEmbed('Не удалось выполнить команду', description, 0xe74c3c),
          ],
        })
        .catch(() => undefined);
    else if (!interaction.replied)
      await interaction
        .reply({
          embeds: [
            halloweenNoticeEmbed('Не удалось выполнить команду', description, 0xe74c3c),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
  }
});
client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  const prefixCommand = message.content.trim().split(/\s+/);
  if (
    prefixCommand[0]?.toLowerCase() ===
    `${config.BOT_PREFIX}remove-candies`.toLowerCase()
  ) {
    if (!isAdmin(message.author.id, config.ADMIN_IDS)) {
      await message.reply('Эта команда доступна только администраторам.');
      return;
    }
    const target = message.mentions.users.first();
    const amountText = prefixCommand.find((part) => /^\d+$/.test(part));
    const amount = amountText ? Number(amountText) : NaN;
    if (!target || !Number.isSafeInteger(amount) || amount < 1) {
      await message.reply(
        `Использование: ${config.BOT_PREFIX}remove-candies @пользователь количество`,
      );
      return;
    }
    try {
      const result = await changeBalance({
        userId: target.id,
        amount,
        delta: -amount,
        reason: `Списание администратором ${message.author.id}`,
        operationId: `admin-remove:${message.id}`,
      });
      await message.reply(
        `Снято ${amount} 🍬 у <@${target.id}>. Новый баланс: ${result.balance} 🍬.`,
      );
    } catch (error) {
      await message.reply(
        error instanceof EconomyError && error.code === 'FUNDS'
          ? 'У пользователя недостаточно конфет для списания.'
          : 'Не удалось выполнить списание. Проверьте сумму и повторите попытку.',
      );
    }
    return;
  }
  const allowed = config.TEXT_CHANNEL_IDS.split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(message.channelId)) return;
  const result = await recordTextMessage({
    messageId: message.id,
    userId: message.author.id,
    text: message.content,
    isBot: message.author.bot,
    isCommand: message.content.startsWith('/'),
    rewardEvery: config.TEXT_REWARD_EVERY,
    reward: config.TEXT_REWARD_CANDIES,
    witchBonus: 0.15,
    minIntervalSeconds: config.TEXT_MIN_INTERVAL_SECONDS,
    maxPerHour: config.TEXT_MAX_PER_HOUR,
    repeatWindow: config.TEXT_REPEAT_WINDOW,
    repeatLimit: config.TEXT_REPEAT_LIMIT,
  }).catch((error) => {
    logger.warn('Text activity processing failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  });
  if (result?.rewards)
    logger.info('Text activity reward granted', {
      userId: message.author.id,
      rewards: result.rewards,
    });
  if (result?.accepted) {
    const hunt = await getCurrentHunt().catch(() => null);
    if (hunt?.status === 'active')
      await recordHuntActivity(
        hunt.id,
        message.author.id,
        'text',
        1,
        message.id,
      ).catch((error: unknown) => {
        logger.warn('Hunt text progress processing failed', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          errorCode: (error as { code?: unknown } | null)?.code,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }
});
client.on(Events.Error, (error) => {
  logger.error('Discord client error', { errorType: error.name });
  void reportControl(
    `Economy Bot: критическая ошибка Discord (${error.name}).`,
  );
});
process.on('unhandledRejection', (error) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  logger.error('Unhandled promise rejection', { errorType });
  void reportControl(`Economy Bot: критическая ошибка (${errorType}).`);
});
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down Economy Bot', { signal });
  await reportControl(`Economy Bot остановлен (${signal}).`);
  await setBotStatus(
    'economy-bot',
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
  logger.info('Economy Bot database connection ready');
  await client.login(config.ECONOMY_BOT_TOKEN);
}
main().catch(async (error) => {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  logger.error('Economy Bot startup failed', { errorType });
  await reportControl(
    `Economy Bot: критическая ошибка запуска (${errorType}).`,
  );
  await shutdown('startup-error');
  process.exitCode = 1;
});
