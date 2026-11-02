import { getDatabase } from './database.js';

export async function setBotStatus(
  botId: string,
  status: 'online' | 'offline' | 'error',
): Promise<void> {
  await getDatabase().botStatus.upsert({
    where: { botId },
    create: { botId, status },
    update: { status },
  });
}
