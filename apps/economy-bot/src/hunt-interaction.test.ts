import { describe, expect, it, vi } from 'vitest';
import { MessageFlags } from 'discord.js';
import { handleHuntAttackInteraction } from './hunt-interaction.js';

describe('mocked Discord hunt interaction', () => {
  it('uses Discord interaction ID as the attack key and responds privately', async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const attack = vi
      .fn()
      .mockResolvedValue({ duplicate: true, damage: 4, health: 8 });
    const interaction = {
      id: 'discord-interaction-42',
      user: { id: 'player-1' },
      reply,
    };
    await handleHuntAttackInteraction(interaction, 'event-1', 'claw', attack);
    expect(attack).toHaveBeenCalledWith({
      eventId: 'event-1',
      userId: 'player-1',
      interactionId: 'discord-interaction-42',
      action: 'claw',
    });
    expect(reply).toHaveBeenCalledWith({
      content: 'Это действие уже учтено.',
      flags: MessageFlags.Ephemeral,
    });
  });
});
