import { listAuditEntries, type AuditEntry } from "./store.js";

const PAGE_SIZE = 25;

/** Page N of the audit log: PAGE_SIZE rows starting at offset (N-1)*PAGE_SIZE. */
export async function paginate(page: number): Promise<AuditEntry[]> {
  const entries = await listAuditEntries();
  const offset = page * PAGE_SIZE;
  return entries.slice(offset, offset + PAGE_SIZE);
}
