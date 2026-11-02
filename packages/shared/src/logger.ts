type LogLevel = 'info' | 'warn' | 'error';

function write(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.info(output);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>): void =>
    write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>): void =>
    write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>): void =>
    write('error', message, context),
};
