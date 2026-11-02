import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePumpkinInteraction } from './pumpkin-interaction.js';

const service = vi.hoisted(() => ({
  claim: vi.fn(),
  recordError: vi.fn(),
}));
vi.mock('@discord-bots/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discord-bots/shared')>();
  return {
    ...actual,
    claimSharedPumpkin: service.claim,
    recordPumpkinCheckError: service.recordError,
  };
});

function modalInteraction(link: string) {
  return {
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    customId: 'shared-pumpkin:link:12345678901234567:4',
    user: { id: '12345678901234567' },
    fields: { getTextInputValue: () => link },
    deferReply: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  } as never;
}

describe('mocked Discord API pumpkin verification', () => {
  beforeEach(() => vi.clearAllMocks());
  beforeEach(() => {
    service.recordError.mockResolvedValue(undefined);
  });

  it('fetches the linked Discord message and passes the API author to the reward service', async () => {
    service.claim.mockResolvedValue({
      duplicate: false,
      reward: 7,
      balance: 7,
      slot: 4,
    });
    const message = {
      id: '32345678901234567',
      guildId: '12345678901234567',
      channelId: '22345678901234567',
      author: { id: '42345678901234567' },
      content: 'Нашёл 🎃',
    };
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: message.guildId,
          isTextBased: () => true,
          messages: { fetch: vi.fn().mockResolvedValue(message) },
        }),
      },
    };
    await handlePumpkinInteraction(
      modalInteraction(
        `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
      ),
      client as never,
      vi.fn(),
    );
    expect(client.channels.fetch).toHaveBeenCalledWith(message.channelId);
    expect(service.claim).toHaveBeenCalledWith({
      slot: 4,
      userId: '12345678901234567',
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.author.id,
      content: message.content,
    });
  });

  it('does not claim if Discord cannot fetch the message and records a private verification error', async () => {
    const recordError = service.recordError;
    const report = vi.fn();
    const interaction = modalInteraction(
      'https://discord.com/channels/12345678901234567/22345678901234567/32345678901234567',
    ) as never;
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({
          guildId: '12345678901234567',
          isTextBased: () => true,
          messages: {
            fetch: vi.fn().mockRejectedValue(new Error('deleted')),
          },
        }),
      },
    };
    await handlePumpkinInteraction(interaction, client as never, report);
    expect(service.claim).not.toHaveBeenCalled();
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'message_unavailable' }),
    );
    expect(report).toHaveBeenCalledOnce();
  });
});
