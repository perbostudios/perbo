import { createClient } from "./client.js";

const client = createClient();

/** Bulk-corrects a profile field for support tooling, outside the normal write path. */
export async function adminWriteProfile(userId: string, field: string, value: string): Promise<void> {
  await client.set(`${userId}:${field}`, value);
}
