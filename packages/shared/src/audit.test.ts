import { describe, expect, it, vi } from 'vitest';
import { appendAuditRecord } from './audit.js';

describe('audit records', () => {
  it('persists actor, action, object, result, and details', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'audit-1' });
    await appendAuditRecord(
      { create },
      {
        actorId: 'admin-1',
        action: 'event.start',
        objectType: 'event',
        objectId: 'event-1',
        result: 'success',
        details: { status: 'running' },
      },
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-1',
        action: 'event.start',
        objectType: 'event',
        objectId: 'event-1',
        result: 'success',
        details: { status: 'running' },
      },
    });
  });
});
