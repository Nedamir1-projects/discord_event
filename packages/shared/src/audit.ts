export interface AuditRecord {
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  result: 'success' | 'failure';
  details?: Record<string, unknown>;
}

export interface AuditLogWriter {
  create(args: { data: AuditRecord }): Promise<unknown>;
}

export async function appendAuditRecord(
  writer: AuditLogWriter,
  record: AuditRecord,
): Promise<void> {
  await writer.create({ data: { ...record, details: record.details ?? {} } });
}
