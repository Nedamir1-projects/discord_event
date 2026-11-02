import { MessageFlags } from 'discord.js';

export interface HuntAttackInteraction {
  id: string;
  user: { id: string };
  reply(payload: {
    content: string;
    flags: MessageFlags.Ephemeral;
  }): Promise<unknown>;
}

export async function handleHuntAttackInteraction(
  interaction: HuntAttackInteraction,
  eventId: string,
  action: string,
  attack: (input: {
    eventId: string;
    userId: string;
    interactionId: string;
    action: string;
  }) => Promise<{ duplicate: boolean; damage: number; health?: number }>,
): Promise<void> {
  const result = await attack({
    eventId,
    userId: interaction.user.id,
    interactionId: interaction.id,
    action,
  });
  await interaction.reply({
    content: result.duplicate
      ? 'Это действие уже учтено.'
      : `Нанесено урона: ${result.damage}. Здоровье босса: ${result.health ?? 'обновляется'}.`,
    flags: MessageFlags.Ephemeral,
  });
}
