import { describe, expect, it } from 'vitest';
import { qualifiesText, voiceBonusSeconds } from './activity-service.js';
describe('activity rules', () => {
  it('filters bot, command and blank messages', () => {
    expect(qualifiesText('hello', false, false)).toBe(true);
    expect(qualifiesText(' ', false, false)).toBe(false);
    expect(qualifiesText('hi', true, false)).toBe(false);
    expect(qualifiesText('/x', false, true)).toBe(false);
  });
  it('counts Werewolf bonus minutes across midnight in configured timezone', () => {
    expect(
      voiceBonusSeconds(
        new Date('2026-01-01T16:00:00Z'),
        new Date('2026-01-01T17:00:00Z'),
        'Asia/Qyzylorda',
      ),
    ).toBe(3600);
  });
});
