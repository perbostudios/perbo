import { createCachedStore } from "./cache.js";

const store = createCachedStore();

/** Writes a user profile field through the cache-aware wrapper. */
export async function writeProfile(userId: string, field: string, value: string): Promise<void> {
  await store.set(`${userId}:${field}`, value);
}
