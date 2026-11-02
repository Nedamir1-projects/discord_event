import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { castHalloweenVote, listOpenHalloweenPolls } from '@discord-bots/shared';

const shorten = (value: string, max = 100): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export async function startHalloweenPollVote(
  interaction: ChatInputCommandInteraction,
  eventId: string,
): Promise<void> {
  const polls = await listOpenHalloweenPolls(eventId);
  if (!polls.length) {
    await interaction.reply({
      content: 'Сейчас нет открытых голосований.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`hpv:p:${interaction.user.id}:${eventId}`)
    .setPlaceholder('Выберите опрос')
    .addOptions(
      polls.slice(0, 25).map((poll) => ({
        label: shorten(poll.title),
        description: shorten(poll.prompt),
        value: poll.id,
      })),
    );
  await interaction.reply({
    content: 'Выберите опрос, в котором хотите проголосовать:',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleHalloweenPollInteraction(
  interaction: StringSelectMenuInteraction,
): Promise<boolean> {
  if (!interaction.customId.startsWith('hpv:')) return false;
  const parts = interaction.customId.split(':');
  const [prefix, step, ownerId, eventId, pollId] = parts;
  if (prefix !== 'hpv' || !ownerId || !eventId) return true;
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      content: 'Это меню голосования открыто другим пользователем. Запустите `/halloween vote` для своего голоса.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (step === 'p') {
    const selectedPollId = interaction.values[0];
    const poll = (await listOpenHalloweenPolls(eventId)).find(
      (item) => item.id === selectedPollId,
    );
    if (!poll) {
      await interaction.update({
        content: 'Этот опрос уже закрыт. Запустите `/halloween vote`, чтобы выбрать открытый опрос.',
        components: [],
      });
      return true;
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`hpv:c:${ownerId}:${eventId}:${poll.id}`)
      .setPlaceholder('Выберите вариант ответа')
      .addOptions(
        poll.options.map((choice, index) => ({
          label: shorten(choice),
          value: String(index),
        })),
      );
    await interaction.update({
      content: `**${poll.title}**\n${poll.prompt}\n\nВыберите вариант:`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
    return true;
  }

  if (step === 'c' && pollId) {
    const poll = (await listOpenHalloweenPolls(eventId)).find(
      (item) => item.id === pollId,
    );
    const selectedIndex = Number(interaction.values[0]);
    const choice = Number.isInteger(selectedIndex) ? poll?.options[selectedIndex] : undefined;
    if (!poll || choice === undefined) {
      await interaction.update({
        content: 'Этот опрос уже закрыт. Запустите `/halloween vote`, чтобы выбрать открытый опрос.',
        components: [],
      });
      return true;
    }
    await castHalloweenVote(poll.id, interaction.user.id, choice);
    await interaction.update({
      content: 'Голос принят. Ваш выбор сохранён.',
      components: [],
    });
    return true;
  }

  return true;
}
