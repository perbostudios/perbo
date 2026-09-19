import { listAuditEntries } from "./store.js";

/** GET /audit — every entry, unpaginated. */
export async function handleAuditRequest(): Promise<{ status: number; body: unknown }> {
  const rows = await listAuditEntries();
  return { status: 200, body: { rows } };
}
