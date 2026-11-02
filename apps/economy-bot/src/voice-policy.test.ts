import { describe, expect, it } from 'vitest';
import { isVoiceChannelAllowed } from './voice-policy.js';

describe('voice reward channel policy', () => {
  it('disables voice rewards when the allowlist is empty', () => {
    expect(isVoiceChannelAllowed('channel-1', '', '')).toBe(false);
    expect(isVoiceChannelAllowed('channel-1', ' , ', '')).toBe(false);
  });

  it('only allows listed, non-AFK channels', () => {
    expect(isVoiceChannelAllowed('channel-1', 'channel-1, channel-2', '')).toBe(
      true,
    );
    expect(
      isVoiceChannelAllowed('channel-1', 'channel-1,channel-2', 'channel-1'),
    ).toBe(false);
    expect(isVoiceChannelAllowed('channel-3', 'channel-1,channel-2', '')).toBe(
      false,
    );
  });
});
