import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
} from 'discord.js';
import {
  answerHalloweenRiddle,
  getCurrentHalloween,
  HalloweenError,
  listHalloweenRiddles,
  logger,
  requestHalloweenHint,
} from '@discord-bots/shared';

const PAGE_SIZE = 10;
const RIDDLE_SELECT_ID = 'halloween-riddle-select';
const RIDDLE_PAGE_PREFIX = 'halloween-riddles-page:';
const ANSWER_PREFIX = 'halloween-riddle-answer:';
const RETRY_PREFIX = 'halloween-riddle-retry:';
const HINT_PREFIX = 'halloween-riddle-hint:';

export async function halloweenRiddleListMessage(
  eventId: string,
  userId: string,
  requestedPage = 0,
) {
  const riddles = await listHalloweenRiddles(eventId, userId);
  const pageCount = Math.max(1, Math.ceil(riddles.length / PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const pageRiddles = riddles.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  );
  const embed = new EmbedBuilder()
    .setColor(0xc0392b)
    .setTitle('Загадки Хэллоуина')
    .setDescription(
      riddles.length
        ? 'Выберите загадку в меню ниже — откроется форма для ответа. Вводить ID не нужно.'
        : 'Открытых загадок пока нет.',
    );

  if (pageRiddles.length)
    embed.addFields(
      ...pageRiddles.map((riddle, index) => {
        const prompt = riddle.prompt.trim();
        const shortenedPrompt =
          prompt.length > 350 ? `${prompt.slice(0, 347)}…` : prompt;
        return {
          name: `${page * PAGE_SIZE + index + 1}. ${riddle.title}`.slice(
            0,
            100,
          ),
          value: `${shortenedPrompt}\nНаграда: ${riddle.reward} 🍬`,
        };
      }),
    );

  embed
    .setFooter({
      text:
        pageCount > 1
          ? `Проклятие Хэллоуина · страница ${page + 1} из ${pageCount}`
          : 'Проклятие Хэллоуина',
    })
    .setTimestamp();

  const components: (
    | ActionRowBuilder<StringSelectMenuBuilder>
    | ActionRowBuilder<ButtonBuilder>
  )[] = [];
  if (pageRiddles.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(RIDDLE_SELECT_ID)
      .setPlaceholder('Выберите загадку, чтобы ответить')
      .addOptions(
        pageRiddles.map((riddle, index) => ({
          label: `${page * PAGE_SIZE + index + 1}. ${riddle.title}`.slice(
            0,
            100,
          ),
          description: `Награда: ${riddle.reward} конфет`.slice(0, 100),
          value: riddle.id,
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    );
  }
  if (pageCount > 1)
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${RIDDLE_PAGE_PREFIX}${page - 1}`)
          .setLabel('← Назад')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`${RIDDLE_PAGE_PREFIX}${page + 1}`)
          .setLabel('Далее →')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pageCount - 1),
      ),
    );

  return { embeds: [embed], components };
}

function answerModal(riddleId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${ANSWER_PREFIX}${riddleId}`)
    .setTitle('Ответ на загадку')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('answer')
          .setLabel('Ваш ответ')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function answerButtons(riddleId: string, includeHint: boolean) {
  const buttons = [
    ...(includeHint
      ? [
          new ButtonBuilder()
            .setCustomId(`${HINT_PREFIX}${riddleId}`)
            .setLabel('Получить подсказку')
            .setStyle(ButtonStyle.Secondary),
        ]
      : []),
    new ButtonBuilder()
      .setCustomId(`${RETRY_PREFIX}${riddleId}`)
      .setLabel('Ответить ещё раз')
      .setStyle(ButtonStyle.Primary),
  ];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function getRiddleId(customId: string, prefix: string): string | undefined {
  const id = customId.slice(prefix.length);
  return id && id.length <= 80 ? id : undefined;
}

export async function handleHalloweenRiddleInteraction(
  interaction: Interaction,
): Promise<boolean> {
  const isPageButton =
    interaction.isButton() && interaction.customId.startsWith(RIDDLE_PAGE_PREFIX);
  const isRiddleSelect =
    interaction.isStringSelectMenu() &&
    interaction.customId === RIDDLE_SELECT_ID;
  const isRetryButton =
    interaction.isButton() && interaction.customId.startsWith(RETRY_PREFIX);
  const isHintButton =
    interaction.isButton() && interaction.customId.startsWith(HINT_PREFIX);
  const isAnswerModal =
    interaction.isModalSubmit() && interaction.customId.startsWith(ANSWER_PREFIX);

  if (
    !isPageButton &&
    !isRiddleSelect &&
    !isRetryButton &&
    !isHintButton &&
    !isAnswerModal
  )
    return false;

  try {
    if (isPageButton) {
      const page = Number(interaction.customId.slice(RIDDLE_PAGE_PREFIX.length));
      if (!Number.isSafeInteger(page) || page < 0)
        throw new HalloweenError('Страница списка загадок не найдена.', 'invalid_page');
      const event = await getCurrentHalloween();
      if (!event)
        throw new HalloweenError('Событие «Проклятие Хэллоуина» не найдено.', 'event_missing');
      await interaction.update(
        await halloweenRiddleListMessage(event.id, interaction.user.id, page),
      );
      return true;
    }

    if (isRiddleSelect) {
      const riddleId = interaction.values[0];
      if (!riddleId)
        throw new HalloweenError('Выберите загадку из списка.', 'missing_riddle');
      await interaction.showModal(answerModal(riddleId));
      return true;
    }

    if (isRetryButton) {
      const riddleId = getRiddleId(interaction.customId, RETRY_PREFIX);
      if (!riddleId)
        throw new HalloweenError('Загадка не найдена.', 'missing_riddle');
      await interaction.showModal(answerModal(riddleId));
      return true;
    }

    if (isHintButton) {
      const riddleId = getRiddleId(interaction.customId, HINT_PREFIX);
      if (!riddleId)
        throw new HalloweenError('Загадка не найдена.', 'missing_riddle');
      const hint = await requestHalloweenHint(riddleId, interaction.user.id);
      const content = hint.solved
        ? 'Эта загадка уже разгадана.'
        : hint.hint
          ? `Подсказка: ${hint.hint}`
          : 'Для этой загадки больше нет подсказок.';
      const hintEmbed = new EmbedBuilder()
        .setColor(hint.solved ? 0x2ecc71 : hint.hint ? 0xf39c12 : 0x95a5a6)
        .setTitle(hint.solved ? 'Загадка разгадана' : 'Подсказка')
        .setDescription(content.slice(0, 4096))
        .setFooter({ text: 'Проклятие Хэллоуина' })
        .setTimestamp();
      await interaction.reply({
        embeds: [hintEmbed],
        components: answerButtons(riddleId, !hint.solved && Boolean(hint.hint)),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (isAnswerModal) {
      const riddleId = getRiddleId(interaction.customId, ANSWER_PREFIX);
      if (!riddleId)
        throw new HalloweenError('Загадка не найдена.', 'missing_riddle');
      const result = await answerHalloweenRiddle(
        riddleId,
        interaction.user.id,
        interaction.fields.getTextInputValue('answer'),
      );
      const answerEmbed = new EmbedBuilder()
        .setColor(result.correct ? 0x2ecc71 : 0xe67e22)
        .setTitle(result.correct ? 'Верный ответ!' : 'Попробуйте ещё раз')
        .setDescription(
          result.correct
            ? `Награда: **${result.reward} 🍬**${result.duplicate ? '\nЭта награда уже была начислена ранее.' : ''}`
            : 'Ответ пока не подошёл. Попробуйте ещё раз или возьмите подсказку.',
        )
        .setFooter({ text: 'Проклятие Хэллоуина' })
        .setTimestamp();
      await interaction.reply({
        embeds: [answerEmbed],
        components: result.correct ? [] : answerButtons(riddleId, true),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
  } catch (error) {
    logger.error('Halloween riddle interaction failed', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    const content =
      error instanceof HalloweenError
        ? error.message
        : 'Не удалось обработать загадку. Попробуйте ещё раз.';
    const errorEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Не удалось обработать загадку')
      .setDescription(content.slice(0, 4096))
      .setFooter({ text: 'Проклятие Хэллоуина' })
      .setTimestamp();
    if (interaction.deferred)
      await interaction
        .editReply({ embeds: [errorEmbed], components: [] })
        .catch(() => undefined);
    else if (interaction.replied)
      await interaction
        .followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    else
      await interaction
        .reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    return true;
  }

  return true;
}
