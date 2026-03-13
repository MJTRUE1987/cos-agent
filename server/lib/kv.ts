/**
 * KV Wrapper — Lazy-loads @vercel/kv with in-memory fallback.
 *
 * When KV_REST_API_URL and KV_REST_API_TOKEN are not set,
 * falls back to a simple in-memory Map so the app still works.
 */

// In-memory fallback store
const memStore = new Map<string, { value: string; expiresAt?: number }>();
const memSets = new Map<string, Set<string>>();

interface KVLike {
  get(key: string): Promise<any>;
  set(key: string, value: any, opts?: { ex?: number }): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  lpush(key: string, ...values: string[]): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<void>;
  sismember(key: string, member: string): Promise<number>;
}

const memoryKV: KVLike = {
  async get(key: string) {
    const entry = memStore.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      memStore.delete(key);
      return null;
    }
    try { return JSON.parse(entry.value); } catch { return entry.value; }
  },
  async set(key: string, value: any, opts?: { ex?: number }) {
    const expiresAt = opts?.ex ? Date.now() + opts.ex * 1000 : undefined;
    memStore.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), expiresAt });
  },
  async del(key: string) { memStore.delete(key); },
  async incr(key: string) {
    const entry = memStore.get(key);
    const current = entry ? parseInt(entry.value) || 0 : 0;
    const next = current + 1;
    memStore.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  },
  async expire(key: string, seconds: number) {
    const entry = memStore.get(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
  },
  async lpush(key: string, ...values: string[]) {
    const entry = memStore.get(key);
    const list: string[] = entry ? (JSON.parse(entry.value) || []) : [];
    list.unshift(...values);
    memStore.set(key, { value: JSON.stringify(list), expiresAt: entry?.expiresAt });
  },
  async lrange(key: string, start: number, stop: number) {
    const entry = memStore.get(key);
    if (!entry) return [];
    const list: string[] = JSON.parse(entry.value) || [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  },
  async sadd(key: string, ...members: string[]) {
    if (!memSets.has(key)) memSets.set(key, new Set());
    const s = memSets.get(key)!;
    for (const m of members) s.add(m);
  },
  async sismember(key: string, member: string) {
    return memSets.has(key) && memSets.get(key)!.has(member) ? 1 : 0;
  },
};

let _kv: KVLike | null = null;

export async function getKV(): Promise<KVLike> {
  if (_kv) return _kv;

  // Check if KV env vars are present
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const mod = await import('@vercel/kv');
      _kv = mod.kv as any;
      return _kv!;
    } catch (e) {
      console.warn('[kv] Failed to load @vercel/kv, using in-memory fallback:', (e as Error).message);
    }
  }

  console.log('[kv] Using in-memory store (KV env vars not configured)');
  _kv = memoryKV;
  return _kv;
}

// Convenience: synchronous access after first init (returns memory fallback if not yet loaded)
export function getKVSync(): KVLike {
  return _kv || memoryKV;
}
