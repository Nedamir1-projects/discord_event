import { getDatabase } from '../database.js';

/** Minimal persistence probe used to verify the shared PostgreSQL connection. */
export async function checkDatabaseConnection(): Promise<void> {
  await getDatabase().$queryRaw`SELECT 1`;
}
