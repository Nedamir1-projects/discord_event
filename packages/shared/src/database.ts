import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

let client: PrismaClient | undefined;

export function getDatabase(): PrismaClient {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const adapter = new PrismaPg({ connectionString });
  client = new PrismaClient({ adapter });
  return client;
}

export async function closeDatabase(): Promise<void> {
  if (!client) return;
  const activeClient = client;
  client = undefined;
  await activeClient.$disconnect();
}
