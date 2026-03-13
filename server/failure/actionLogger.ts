/**
 * Action Logger — Records every meaningful user action for debugging and replay.
 *
 * Storage: Vercel KV with key pattern `cos:actions:{date}` (JSON array per day).
 * Also indexes by command_id and session_id for fast lookup.
 */

import { getKV } from '../lib/kv.js';
import { generateId } from '../event-log/eventStore.js';

// ── Types ──────────────────────────────────────────────────────────

export type UserAction =
  | 'command_submit'
  | 'clarification_shown'
  | 'clarification_clicked'
  | 'approval_shown'
  | 'approve_clicked'
  | 'deny_clicked'
  | 'wizard_step_entered'
  | 'wizard_step_submitted'
  | 'execution_step_started'
  | 'execution_step_completed'
  | 'execution_step_failed';

export interface ActionRecord {
  action_id: string;
  action: UserAction;
  timestamp: string;
  command_id?: string;
  session_id?: string;
  step_id?: string;
  metadata?: Record<string, any>;
}

// ── Storage keys ──────────────────────────────────────────────────

const ACTIONS_PREFIX = 'cos:actions';
const ACTIONS_CMD_PREFIX = 'cos:actions:cmd';
const ACTIONS_SESSION_PREFIX = 'cos:actions:session';

function dateKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Core functions ────────────────────────────────────────────────

export async function logAction(
  action: UserAction,
  context: {
    command_id?: string;
    session_id?: string;
    step_id?: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  const kv = await getKV();
  const now = new Date().toISOString();
  const actionId = generateId('act');

  const record: ActionRecord = {
    action_id: actionId,
    action,
    timestamp: now,
    command_id: context.command_id,
    session_id: context.session_id,
    step_id: context.step_id,
    metadata: context.metadata,
  };

  const serialized = JSON.stringify(record);

  // Append to daily list
  await kv.lpush(`${ACTIONS_PREFIX}:${dateKey()}`, serialized);

  // Index by command_id
  if (context.command_id) {
    await kv.lpush(`${ACTIONS_CMD_PREFIX}:${context.command_id}`, serialized);
  }

  // Index by session_id
  if (context.session_id) {
    await kv.lpush(`${ACTIONS_SESSION_PREFIX}:${context.session_id}`, serialized);
  }
}

export async function getActions(opts?: {
  command_id?: string;
  session_id?: string;
  limit?: number;
}): Promise<ActionRecord[]> {
  const kv = await getKV();
  const limit = opts?.limit || 100;

  let key: string;

  if (opts?.command_id) {
    key = `${ACTIONS_CMD_PREFIX}:${opts.command_id}`;
  } else if (opts?.session_id) {
    key = `${ACTIONS_SESSION_PREFIX}:${opts.session_id}`;
  } else {
    // Default: today's actions
    key = `${ACTIONS_PREFIX}:${dateKey()}`;
  }

  const raw: string[] = await kv.lrange(key, 0, -1);
  if (!raw.length) return [];

  const records: ActionRecord[] = raw.map((entry: any) =>
    typeof entry === 'string' ? JSON.parse(entry) : entry
  );

  return records.slice(0, limit);
}
