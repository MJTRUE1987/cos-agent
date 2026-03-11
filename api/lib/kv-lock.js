// Distributed lock using Vercel KV
// Uses SET NX EX pattern for atomic lock acquisition

const LOCK_KEY = 'cos_sync_lock';
const LOCK_TTL = 120; // seconds — increased from 30 to cover full sync (Gmail+HubSpot+Granola+Claude)
const RETRY_DELAY = 1000; // ms
const MAX_RETRIES = 3;

function generateLockId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function acquireLock(kv) {
  const lockId = generateLockId();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // SET key value NX EX ttl — only sets if key does not exist
    const result = await kv.set(LOCK_KEY, lockId, { nx: true, ex: LOCK_TTL });
    if (result === 'OK') {
      return lockId;
    }
    // Lock held by someone else — wait and retry
    if (attempt < MAX_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }

  return null; // Failed to acquire
}

export async function releaseLock(kv, lockId) {
  // Check-then-delete — not fully atomic (TOCTOU), but with 120s TTL the race window is minimal.
  // Vercel KV does not support Lua scripts for true atomic release.
  try {
    const currentValue = await kv.get(LOCK_KEY);
    if (currentValue === lockId) {
      await kv.del(LOCK_KEY);
    }
  } catch (e) {
    console.error('[lock] Release failed:', e.message || e);
  }
}
