import { describe, expect, it } from 'vitest';
import { commands } from './commands.js';

describe('Event Master slash command registration', () => {
  it('serializes only commands with implemented handlers', () => {
    expect(commands.map((command) => command.toJSON().name)).toEqual([
      'matrix',
      'panel',
      'ping',
      'eventhelp',
    ]);
  });
});
