import { REST, Routes } from 'discord.js';
import { loadEconomyConfig, logger } from '@discord-bots/shared';
import { commands } from './commands.js';

async function main(): Promise<void> {
  const config = loadEconomyConfig();
  const rest = new REST({ version: '10' }).setToken(config.ECONOMY_BOT_TOKEN);
  const route = config.GUILD_ID
    ? Routes.applicationGuildCommands(config.ECONOMY_CLIENT_ID, config.GUILD_ID)
    : Routes.applicationCommands(config.ECONOMY_CLIENT_ID);
  await rest.put(route, { body: commands.map((command) => command.toJSON()) });
  logger.info('Economy slash commands registered', {
    scope: config.GUILD_ID ? 'guild' : 'global',
  });
}

main().catch((error: unknown) => {
  logger.error('Command registration failed', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exitCode = 1;
});
