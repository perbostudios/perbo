import { paginate } from "./page.js";

/** GET /audit?page=N — calls the paginator and returns its rows as JSON. */
export async function handleAuditRequest(query: { page?: string }): Promise<{ status: number; body: unknown }> {
  const page = Number(query.page ?? "1");
  const rows = await paginate(page);
  return { status: 200, body: { rows } };
}
