import { describe, expect, it } from 'vitest';
import { parseAdminCommand } from './admin-command.js';
import { isAdmin } from '../../../packages/shared/src/permissions.js';
import {
  nextCandyBalance,
  parseBoundedInteger,
  parseDiscordId,
} from './admin-service.js';
import { canUsePanel } from './panel-policy.js';

describe('Event Master admin commands', () => {
  it('recognizes valid commands and ignores ordinary messages', () => {
    expect(parseAdminCommand('<help')).toEqual({
      kind: 'command',
      name: 'help',
      args: [],
    });
    expect(parseAdminCommand('hello')).toEqual({ kind: 'ignored' });
  });

  it('silently ignores unknown prefixes and mentions, and validates known command arguments', () => {
    expect(parseAdminCommand('<unknown')).toEqual({ kind: 'ignored' });
    expect(parseAdminCommand('<@&12345678901234567>')).toEqual({ kind: 'ignored' });
    expect(parseAdminCommand('> @everyone')).toEqual({ kind: 'ignored' });
    expect(parseAdminCommand('<stats now')).toMatchObject({
      kind: 'invalid-arguments',
      name: 'stats',
    });
  });

  it('parses the documented prefix command syntax and rejects malformed arguments', () => {
    expect(parseAdminCommand('<event pause evt_123')).toEqual({
      kind: 'command',
      name: 'event',
      args: ['pause', 'evt_123'],
    });
    expect(parseAdminCommand('<give 12345678901234567 100')).toMatchObject({
      kind: 'command',
      name: 'give',
    });
    expect(parseAdminCommand('<take not-a-user 100')).toMatchObject({
      kind: 'invalid-arguments',
      name: 'take',
    });
    expect(parseAdminCommand('<event launch evt_123')).toMatchObject({
      kind: 'invalid-arguments',
      name: 'event',
    });
  });

  it('lists events with the left-angle prefix and also accepts the alternate prefix', () => {
    expect(parseAdminCommand('<events')).toEqual({
      kind: 'command',
      name: 'events',
      args: [],
    });
    expect(parseAdminCommand('>events')).toEqual({
      kind: 'command',
      name: 'events',
      args: [],
    });
  });

  it('recognizes the destructive reset command only without arguments', () => {
    expect(parseAdminCommand('<reset')).toEqual({
      kind: 'command',
      name: 'reset',
      args: [],
    });
    expect(parseAdminCommand('<reset now')).toMatchObject({
      kind: 'invalid-arguments',
      name: 'reset',
    });
  });

  it('authorizes exact Discord IDs only', () => {
    expect(isAdmin('123', '123,456')).toBe(true);
    expect(isAdmin('12', '123,456')).toBe(false);
    expect(isAdmin('admin', 'Admin')).toBe(false);
  });

  it.each(['button', 'select', 'modal'])(
    'denies unauthorized %s panel interactions',
    () => {
      const session = { ownerId: '123', expiresAt: 1000 };
      expect(canUsePanel('999', '123', session, 500)).toBe(false);
      expect(canUsePanel('123', '999', session, 500)).toBe(false);
      expect(
        canUsePanel('123', '123', { ...session, expiresAt: 499 }, 500),
      ).toBe(false);
      expect(canUsePanel('123', '123', session, 500)).toBe(true);
    },
  );

  it('validates IDs and bounded integer arguments', () => {
    expect(parseBoundedInteger('100', 1, 100)).toBe(100);
    expect(() => parseBoundedInteger('-1', 0, 100)).toThrow();
    expect(() => parseBoundedInteger('101', 0, 100)).toThrow();
    expect(parseDiscordId('<@12345678901234567>')).toBe('12345678901234567');
    expect(() => parseDiscordId('abc')).toThrow();
  });

  it('never allows a candy balance below zero or above the database range', () => {
    expect(nextCandyBalance(50, 20, 'take')).toBe(30);
    expect(nextCandyBalance(50, 20, 'give')).toBe(70);
    expect(() => nextCandyBalance(10, 11, 'take')).toThrow(/Недостаточно/);
    expect(() => nextCandyBalance(2_147_483_640, 10, 'give')).toThrow(/предел/);
  });
});
