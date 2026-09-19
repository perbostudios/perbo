/** The raw key-value store client. Every read and write goes through here. */
export interface StoreClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const data = new Map<string, string>();

export function createClient(): StoreClient {
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}
