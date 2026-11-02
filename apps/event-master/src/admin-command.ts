export const adminCommandNames = [
  'help',
  'panel',
  'stats',
  'logs',
  'event',
  'events',
  'pumpkin',
  'riddle',
  'quest',
  'give',
  'take',
  'reset',
] as const;
export type AdminCommandName = (typeof adminCommandNames)[number];

export type ParsedAdminCommand =
  | { kind: 'ignored' }
  | { kind: 'invalid-arguments'; name: AdminCommandName; usage: string }
  | { kind: 'command'; name: AdminCommandName; args: string[] };

const usage: Record<AdminCommandName, string> = {
  help: '<help',
  panel: '<panel',
  stats: '<stats',
  logs: '<logs [count 1..50]',
  event: '<event start|pause|resume|end <event ID>',
  events: '<events',
  pumpkin: '<pumpkin (configure in panel)',
  riddle: '<riddle (configure in panel)',
  quest: '<quest (configure in panel)',
  give: '<give <Discord user ID> <amount>',
  take: '<take <Discord user ID> <amount>',
  reset: '<reset',
};

export function parseAdminCommand(content: string): ParsedAdminCommand {
  // Accept both prefixes for compatibility; '<' is the documented primary prefix.
  if (!content.startsWith('>') && !content.startsWith('<'))
    return { kind: 'ignored' };
  const [rawName, ...args] = content.slice(1).trim().split(/\s+/);
  const name = rawName?.toLowerCase() ?? '';
  if (!(adminCommandNames as readonly string[]).includes(name))
    return { kind: 'ignored' };
  const typedName = name as AdminCommandName;
  if (
    typedName === 'help' ||
    typedName === 'panel' ||
    typedName === 'stats' ||
    typedName === 'events' ||
    typedName === 'reset'
  ) {
    if (args.length)
      return {
        kind: 'invalid-arguments',
        name: typedName,
        usage: usage[typedName],
      };
  } else if (typedName === 'logs') {
    if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0])))
      return {
        kind: 'invalid-arguments',
        name: typedName,
        usage: usage[typedName],
      };
  } else if (typedName === 'event') {
    if (
      args.length !== 2 ||
      !['start', 'pause', 'resume', 'end'].includes(
        args[0]?.toLowerCase() ?? '',
      )
    )
      return {
        kind: 'invalid-arguments',
        name: typedName,
        usage: usage[typedName],
      };
  } else if (typedName === 'give' || typedName === 'take') {
    if (
      args.length !== 2 ||
      !/^\d{17,20}$/.test(args[0] ?? '') ||
      !/^\d+$/.test(args[1] ?? '')
    )
      return {
        kind: 'invalid-arguments',
        name: typedName,
        usage: usage[typedName],
      };
  } else if (args.length) {
    return {
      kind: 'invalid-arguments',
      name: typedName,
      usage: usage[typedName],
    };
  }
  return { kind: 'command', name: typedName, args };
}
