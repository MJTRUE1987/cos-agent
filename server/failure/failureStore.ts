/**
 * Failure Store — Captures, indexes, and retrieves failure records.
 *
 * Storage: Vercel KV with key pattern `cos:failure:{failure_id}`
 * Index: `cos:failure:index` (JSON array of failure IDs, newest first)
 */

import { getKV } from '../lib/kv.js';
import { generateId } from '../event-log/eventStore.js';

// ── Types ──────────────────────────────────────────────────────────

export interface FailureRecord {
  failure_id: string;
  event_id?: string;
  timestamp: string;
  command_id?: string;
  execution_run_id?: string;
  plan_id?: string;
  step_id?: string;
  tool_call_id?: string;
  session_id?: string;
  user_action?: string;
  intent?: string;
  entity_snapshot?: any;
  ui_snapshot?: string;
  backend_snapshot?: any;
  error_type: 'api_error' | 'tool_error' | 'parse_error' | 'runtime_error' | 'frontend_error' | 'timeout' | 'unknown';
  error_message: string;
  stack?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reproducible_input?: any;
  resolved: boolean;
  resolution?: string;
}

// ── Storage keys ──────────────────────────────────────────────────

const FAILURE_PREFIX = 'cos:failure';
const FAILURE_INDEX = 'cos:failure:index';

// ── Core functions ────────────────────────────────────────────────

export async function captureFailure(
  failure: Omit<FailureRecord, 'failure_id' | 'timestamp' | 'resolved'>
): Promise<FailureRecord> {
  const kv = await getKV();
  const failureId = generateId('fail');
  const now = new Date().toISOString();

  const record: FailureRecord = {
    ...failure,
    failure_id: failureId,
    timestamp: now,
    resolved: false,
  };

  // Store the failure record
  await kv.set(`${FAILURE_PREFIX}:${failureId}`, record);

  // Add to index (newest first)
  await kv.lpush(FAILURE_INDEX, failureId);

  return record;
}

export async function getFailures(opts?: {
  limit?: number;
  unresolved_only?: boolean;
  error_type?: string;
}): Promise<FailureRecord[]> {
  const kv = await getKV();
  const limit = opts?.limit || 50;

  // Get all failure IDs from index
  const ids: string[] = await kv.lrange(FAILURE_INDEX, 0, -1);
  if (!ids.length) return [];

  // Load each failure record
  const records: FailureRecord[] = [];
  for (const id of ids) {
    const raw = await kv.get(`${FAILURE_PREFIX}:${id}`);
    if (raw) {
      const record: FailureRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
      records.push(record);
    }
  }

  // Apply filters
  let filtered = records;
  if (opts?.unresolved_only) {
    filtered = filtered.filter(r => !r.resolved);
  }
  if (opts?.error_type) {
    filtered = filtered.filter(r => r.error_type === opts.error_type);
  }

  return filtered.slice(0, limit);
}

export async function getFailure(failureId: string): Promise<FailureRecord | null> {
  const kv = await getKV();
  const raw = await kv.get(`${FAILURE_PREFIX}:${failureId}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function resolveFailure(failureId: string, resolution: string): Promise<boolean> {
  const kv = await getKV();
  const raw = await kv.get(`${FAILURE_PREFIX}:${failureId}`);
  if (!raw) return false;

  const record: FailureRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;
  record.resolved = true;
  record.resolution = resolution;

  await kv.set(`${FAILURE_PREFIX}:${failureId}`, record);
  return true;
}

export async function getRepeatedFailures(): Promise<{
  error_message: string;
  count: number;
  latest: FailureRecord;
}[]> {
  const all = await getFailures({ limit: 500 });

  // Group by error_message
  const groups = new Map<string, FailureRecord[]>();
  for (const record of all) {
    const key = record.error_message;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(record);
  }

  // Filter to repeated (2+) and sort by count descending
  const repeated: { error_message: string; count: number; latest: FailureRecord }[] = [];
  for (const [message, records] of groups) {
    if (records.length >= 2) {
      // Records are already newest-first from the index order
      repeated.push({
        error_message: message,
        count: records.length,
        latest: records[0],
      });
    }
  }

  repeated.sort((a, b) => b.count - a.count);
  return repeated;
}
