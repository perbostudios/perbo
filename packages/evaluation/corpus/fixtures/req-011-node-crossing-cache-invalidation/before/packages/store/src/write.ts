import { createClient } from "./client.js";

const client = createClient();

/** Writes a user profile field directly through the store client. */
export async function writeProfile(userId: string, field: string, value: string): Promise<void> {
  await client.set(`${userId}:${field}`, value);
}
