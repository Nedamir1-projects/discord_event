import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDatabase } from './database.js';
import {
  buyItem,
  buyRace,
  changeBalance,
  configureShopItem,
  getBalanceHistory,
  getProfile,
  getRaces,
  grantReward,
  processPendingRewards,
  queueReward,
} from './economy-service.js';

const enabled = Boolean(process.env.DATABASE_URL);
let user = `economy-test-${crypto.randomUUID()}`;
const testUsers: string[] = [];
const db = enabled ? getDatabase() : undefined;
const execFileAsync = promisify(execFile);

describe.skipIf(!enabled)('economy service PostgreSQL integration', () => {
  beforeEach(() => {
    user = `economy-test-${crypto.randomUUID()}`;
    testUsers.push(user);
    return configureShopItem({
      id: `test-${user}`,
      name: 'Integration test item',
      description: 'Temporary test fixture',
      price: 40,
      limit: 1,
    });
  });
  afterAll(async () => {
    if (!db) return;
    await db.purchase.deleteMany({ where: { userId: { in: testUsers } } });
    await db.balanceTransaction.deleteMany({
      where: { userId: { in: testUsers } },
    });
    await db.pendingOperation.deleteMany({
      where: { userId: { in: testUsers } },
    });
    await db.playerProfile.deleteMany({ where: { userId: { in: testUsers } } });
    await db.shopItem.deleteMany({
      where: { id: { in: testUsers.map((id) => `test-${id}`) } },
    });
  });

  it('atomically grants, rejects overdrafts, and deduplicates an operation', async () => {
    const reward = {
      userId: user,
      amount: 100,
      reason: 'test grant',
      operationId: `grant-${user}`,
    };
    await expect(grantReward(reward)).resolves.toMatchObject({
      balance: 100,
      duplicate: false,
    });
    await expect(grantReward(reward)).resolves.toMatchObject({
      balance: 100,
      duplicate: true,
    });
    await expect(
      changeBalance({
        ...reward,
        amount: 110,
        delta: -110,
        operationId: `overdraft-${user}`,
      }),
    ).rejects.toThrow();
    expect(
      (await getBalanceHistory(user)).filter(
        (x) => x.operationId === reward.operationId,
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent debits without a negative balance', async () => {
    await grantReward({
      userId: user,
      amount: 100,
      reason: 'concurrency fixture',
      operationId: `concurrency-seed-${user}`,
    });
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        changeBalance({
          userId: user,
          amount: 80,
          delta: -80,
          reason: 'parallel spend',
          operationId: `parallel-${n}-${user}`,
        }),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      await getProfile(user).then((x) => x.candies),
    ).toBeGreaterThanOrEqual(0);
  });

  it('deduplicates the same reward sent by two independent Node processes', async () => {
    const userId = `economy-process-test-${crypto.randomUUID()}`;
    const operationId = `process-race-${userId}`;
    testUsers.push(userId);
    const env = {
      ...process.env,
      DATABASE_URL: process.env.HUNT_TEST_DATABASE_URL!,
      AUDIT_USER_ID: userId,
      AUDIT_OPERATION_ID: operationId,
    };
    const worker = `
      import { closeDatabase, grantReward } from '@discord-bots/shared';
      let result;
      try {
        result = await grantReward({
          userId: process.env.AUDIT_USER_ID,
          amount: 23,
          reason: 'multi-process integration test',
          operationId: process.env.AUDIT_OPERATION_ID,
        });
      } finally {
        await closeDatabase();
      }
      process.stdout.write(JSON.stringify(result));
    `;
    const [first, second] = await Promise.all([
      execFileAsync(process.execPath, ['--input-type=module', '-e', worker], {
        cwd: process.cwd(),
        env,
      }),
      execFileAsync(process.execPath, ['--input-type=module', '-e', worker], {
        cwd: process.cwd(),
        env,
      }),
    ]);
    const parseResult = (stdout: string) =>
      JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
    const results = [parseResult(first.stdout), parseResult(second.stdout)];
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(1);
    expect(await getProfile(userId).then((profile) => profile.candies)).toBe(
      23,
    );
    expect(await db!.balanceTransaction.count({ where: { operationId } })).toBe(
      1,
    );
  }, 20_000);

  it('buys a catalog item once and rejects insufficient funds', async () => {
    await grantReward({
      userId: user,
      amount: 100,
      reason: 'shop fixture',
      operationId: `shop-seed-${user}`,
    });
    const id = `shop-purchase-${user}`;
    await expect(buyItem(user, `test-${user}`, 1, id)).resolves.toMatchObject({
      balance: 60,
      duplicate: false,
    });
    await expect(buyItem(user, `test-${user}`, 1, id)).resolves.toMatchObject({
      balance: 60,
      duplicate: true,
    });
    await expect(
      buyItem(user, `test-${user}`, 1, `shop-again-${user}`),
    ).rejects.toThrow();
  });

  it('purchases a race once and processes pending rewards idempotently', async () => {
    await getRaces();
    await grantReward({
      userId: user,
      amount: 300,
      reason: 'race fixture',
      operationId: `race-seed-${user}`,
    });
    const raceOp = `race-purchase-${user}`;
    await expect(buyRace(user, 'Witch', raceOp)).resolves.toMatchObject({
      race: 'Witch',
      balance: 200,
    });
    await expect(buyRace(user, 'Witch', raceOp)).resolves.toMatchObject({
      race: 'Witch',
      balance: 200,
      duplicate: true,
    });
    const reward = {
      userId: user,
      amount: 25,
      reason: 'pending test reward',
      operationId: `pending-${user}`,
    };
    await queueReward(reward);
    await processPendingRewards();
    await processPendingRewards();
    expect(await getProfile(user).then((x) => x.candies)).toBe(225);
    expect(
      await db!.pendingOperation.findUnique({
        where: { operationId: reward.operationId },
      }),
    ).toMatchObject({ status: 'processed' });
  });
});
