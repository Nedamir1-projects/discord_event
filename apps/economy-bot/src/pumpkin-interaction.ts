import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';
import {
  claimSharedPumpkin,
  HalloweenError,
  listSharedPumpkins,
  parseDiscordMessageUrl,
  recordPumpkinCheckError,
} from '@discord-bots/shared';

type ReportError = (message: string) => Promise<void>;

export async function startPumpkinClaim(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const pumpkins = (await listSharedPumpkins()).filter(
    (pumpkin) => pumpkin.active,
  );
  if (!pumpkins.length) {
    await interaction.reply({
      content: 'Активные тыквы пока не зарегистрированы.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId(`shared-pumpkin:slot:${interaction.user.id}`)
    .setPlaceholder('Выберите тыкву №17')
    .addOptions(
      pumpkins.map((pumpkin) => ({
        label: `Тыква ${pumpkin.slot} · №${pumpkin.pumpkinNumber}`,
        description: `Награда: ${pumpkin.reward} конфет`,
        value: String(pumpkin.slot),
      })),
    );
  await interaction.reply({
    content:
      'Выберите тыкву и затем отправьте ссылку на зарегистрированное сообщение с 🎃.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handlePumpkinInteraction(
  interaction: Interaction,
  client: Client,
  reportError: ReportError,
): Promise<boolean> {
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith('shared-pumpkin:slot:')
  ) {
    const ownerId = interaction.customId.split(':')[2];
    if (ownerId !== interaction.user.id) {
      await interaction.reply({
        content: 'Это меню принадлежит другому игроку.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const slot = Number(interaction.values[0]);
    if (!Number.isSafeInteger(slot) || slot < 1 || slot > 7) {
      await interaction.reply({
        content: 'Не удалось определить номер тыквы.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`shared-pumpkin:link:${ownerId}:${slot}`)
      .setTitle(`Найти тыкву ${slot} · №17`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('messageLink')
            .setLabel('Ссылка на сообщение с тыквой')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(
              'https://discord.com/channels/сервер/канал/сообщение',
            )
            .setRequired(true)
            .setMaxLength(200),
        ),
      );
    await interaction.showModal(modal);
    return true;
  }
  if (
    !interaction.isModalSubmit() ||
    !interaction.customId.startsWith('shared-pumpkin:link:')
  )
    return false;
  const [, , ownerId, slotText] = interaction.customId.split(':');
  if (ownerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Эта форма принадлежит другому игроку.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let ids: ReturnType<typeof parseDiscordMessageUrl> | undefined;
  try {
    const slot = Number(slotText);
    const link = interaction.fields.getTextInputValue('messageLink').trim();
    ids = parseDiscordMessageUrl(link);
    const channel = await client.channels.fetch(ids.channelId);
    if (!channel?.isTextBased() || !('messages' in channel))
      throw new HalloweenError(
        'Сообщение недоступно для проверки.',
        'message_unavailable',
      );
    if ('guildId' in channel && channel.guildId !== ids.guildId)
      throw new HalloweenError(
        'Ссылка указывает на другой сервер.',
        'wrong_guild',
      );
    const message = await channel.messages.fetch(ids.messageId).catch(() => {
      throw new HalloweenError(
        'Сообщение удалено или недоступно боту.',
        'message_unavailable',
      );
    });
    if (message.guildId !== ids.guildId)
      throw new HalloweenError(
        'Полученное сообщение относится к другому серверу.',
        'wrong_guild',
      );
    const result = await claimSharedPumpkin({
      slot,
      userId: interaction.user.id,
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      content: message.content,
    });
    await interaction.editReply(
      result.duplicate
        ? `Вы уже находили эту тыкву. Повторная награда не начисляется. Ваш баланс: ${result.balance} 🍬.`
        : `Тыква ${result.slot} найдена! Начислено ${result.reward} 🍬. Баланс: ${result.balance} 🍬.`,
    );
  } catch (error) {
    const code =
      error instanceof HalloweenError ? error.code : 'verification_error';
    await recordPumpkinCheckError({
      userId: interaction.user.id,
      ...(ids
        ? {
            guildId: ids.guildId,
            channelId: ids.channelId,
            messageId: ids.messageId,
          }
        : {}),
      code,
    }).catch(() => undefined);
    if (code === 'message_unavailable')
      await reportError(
        `Не удалось проверить сообщение-тыкву для участника ${interaction.user.id}; причина: ${code}.`,
      );
    await interaction.editReply(
      error instanceof Error
        ? error.message
        : 'Не удалось проверить сообщение. Попробуйте позже.',
    );
  }
  return true;
}
