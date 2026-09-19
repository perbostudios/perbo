export interface AuditEntry {
  id: number;
  action: string;
}

const entries: AuditEntry[] = Array.from({ length: 140 }, (_, i) => ({
  id: i + 1,
  action: `action-${i + 1}`,
}));

/** Every audit entry, oldest first. */
export async function listAuditEntries(): Promise<AuditEntry[]> {
  return entries;
}
