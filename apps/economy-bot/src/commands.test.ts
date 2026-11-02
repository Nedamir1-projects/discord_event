import { describe, expect, it } from 'vitest';
import { commands } from './commands.js';

describe('Economy Bot slash command registration', () => {
  it('registers all economy commands', () => {
    expect(commands.map((command) => command.toJSON().name)).toEqual([
      'balance',
      'profile',
      'shop',
      'buy',
      'race',
      'abilities',
      'leaderboard',
      'ping',
      'bite',
      'curse',
      'possess',
      'hunt',
      'halloween',
      'pumpkin',
    ]);
  });
  it('provides status, join and attack interactions for the event', () => {
    const hunt = commands.find((command) => command.name === 'hunt')!;
    const json = hunt.toJSON();
    expect(json.options?.map((option) => option.name)).toEqual([
      'status',
      'join',
      'attack',
    ]);
    const attack = json.options?.[2];
    expect(
      attack && 'options' in attack ? attack.options?.[0]?.name : undefined,
    ).toBe('action');
  });
});
