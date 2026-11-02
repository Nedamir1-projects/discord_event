import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'),
});

const commonSchema = z.object({
  DATABASE_URL: z.string().url(),
  GUILD_ID: z.string().regex(/^\d+$/).optional().or(z.literal('')),
  ADMIN_IDS: z.string().default(''),
  BOT_CONTROL_CHANNEL_ID: z.string().default(''),
  TIMEZONE: z.string().default('UTC'),
});

const economySchema = commonSchema.extend({
  ECONOMY_BOT_TOKEN: z.string().min(1),
  ECONOMY_CLIENT_ID: z.string().regex(/^\d+$/),
  BOT_PREFIX: z.string().min(1).max(5).default('!'),
  VOICE_CHANNEL_IDS: z.string().default(''),
  VOICE_AFK_CHANNEL_IDS: z.string().default(''),
  VOICE_IGNORE_SELF_DEAF: z.coerce.boolean().default(true),
  VOICE_REWARD_EVERY_MINUTES: z.coerce.number().int().positive().default(5),
  VOICE_REWARD_CANDIES: z.coerce.number().int().positive().default(1),
  TEXT_CHANNEL_IDS: z.string().default(''),
  TEXT_REWARD_EVERY: z.coerce.number().int().positive().default(20),
  TEXT_REWARD_CANDIES: z.coerce.number().int().positive().default(10),
  TEXT_MIN_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(10),
  TEXT_MAX_PER_HOUR: z.coerce.number().int().positive().default(30),
  TEXT_REPEAT_WINDOW: z.coerce.number().int().positive().default(5),
  TEXT_REPEAT_LIMIT: z.coerce.number().int().positive().default(3),
  WITCH_CURSE_EFFECT: z.string().default('status'),
  WITCH_CURSE_ROLE_ID: z.string().default(''),
  GHOST_EFFECT_ROLE_ID: z.string().default(''),
});

const eventsSchema = commonSchema.extend({
  EVENT_MASTER_BOT_TOKEN: z.string().min(1),
  EVENT_MASTER_CLIENT_ID: z.string().regex(/^\d+$/),
});

export type CommonConfig = z.infer<typeof commonSchema>;
export type EconomyConfig = z.infer<typeof economySchema>;
export type EventMasterConfig = z.infer<typeof eventsSchema>;

function parseConfig<T>(schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new Error(
      `Invalid environment configuration. Check required settings: ${fields}`,
    );
  }
  return parsed.data;
}

export function loadEconomyConfig(): EconomyConfig {
  return parseConfig(economySchema);
}

export function loadEventMasterConfig(): EventMasterConfig {
  return parseConfig(eventsSchema);
}
