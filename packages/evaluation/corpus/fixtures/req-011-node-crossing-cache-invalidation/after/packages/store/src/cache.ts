import { createClient, type StoreClient } from "./client.js";

/**
 * A write-through cache in front of the store client: a write updates the
 * client and invalidates this key's cache entry, so the next read is never
 * stale.
 */
export interface CachedStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createCachedStore(client: StoreClient = createClient()): CachedStore {
  const cache = new Map<string, string>();
  return {
    async get(key) {
      if (cache.has(key)) return cache.get(key)!;
      const value = await client.get(key);
      if (value !== null) cache.set(key, value);
      return value;
    },
    async set(key, value) {
      await client.set(key, value);
      cache.delete(key);
    },
  };
}
