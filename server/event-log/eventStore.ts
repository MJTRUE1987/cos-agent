/**
 * Event Log — Append-only event store.
 *
 * Two tables:
 *   events           — immutable facts
 *   event_processing — mutable per-consumer processing state
 *
 * Storage: Vercel KV (JSON arrays) for Phase 1.
 * Falls back to in-memory store when KV is not configured.
 */

import { getKV } from '../lib/kv.js';

// ── Types ──────────────────────────────────────────────────────────

export interface CosEvent {
  event_id: string;
  event_type: string;
  source: string;
  entity_type?: string;
  entity_id?: string;
  correlation_id: string;
  causation_id?: string;
  actor: string;
  timestamp: string;
  payload: Record<string, any>;
  metadata: EventMetadata;
  created_at: string;
}

export interface EventMetadata {
  dedup_key?: string;
  version: number;
  environment: string;
  command_id?: string;
  execution_run_id?: string;
  plan_id?: string;
  step_id?: string;
  tool_call_id?: string;
}

export interface ProcessingRecord {
  event_id: string;
  consumer: string;
  status: 'pending' | 'processing' | 'processed' | 'failed' | 'dead_letter';
  retry_count: number;
  max_retries: number;
  last_error?: string;
  scheduled_at?: string;
  started_at?: string;
  processed_at?: string;
  created_at: string;
}

export interface EventFilter {
  event_type?: string;
  event_types?: string[];
  source?: string;
  entity_type?: string;
  entity_id?: string;
  correlation_id?: string;
  command_id?: string;
  execution_run_id?: string;
  actor?: string;
  after?: string;
  before?: string;
  limit?: number;
}

// ── ULID-like ID generator (time-sortable) ────────────────────────

const ENCODING = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len; i > 0; i--) {
    const mod = now % ENCODING.length;
    str = ENCODING[mod] + str;
    now = Math.floor(now / ENCODING.length);
  }
  return str;
}

function randomChar(): string {
  return ENCODING[Math.floor(Math.random() * ENCODING.length)];
}

export function generateId(prefix: string = 'evt'): string {
  const time = encodeTime(Date.now(), 10);
  let rand = '';
  for (let i = 0; i < 6; i++) rand += randomChar();
  return `${prefix}_${time}${rand}`;
}

// ── Storage keys ──────────────────────────────────────────────────

const EVENTS_KEY = 'cos:events';
const EVENTS_INDEX_PREFIX = 'cos:eidx';
const DEDUP_KEY = 'cos:event_dedup';

// ── Core functions ────────────────────────────────────────────────

export async function appendEvent(
  event: Omit<CosEvent, 'event_id' | 'created_at'> & { event_id?: string; created_at?: string }
): Promise<CosEvent> {
  const kv = await getKV();
  const now = new Date().toISOString();
  const fullEvent: CosEvent = {
    event_id: event.event_id || generateId('evt'),
    event_type: event.event_type,
    source: event.source,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    correlation_id: event.correlation_id,
    causation_id: event.causation_id,
    actor: event.actor,
    timestamp: event.timestamp || now,
    payload: event.payload,
    metadata: {
      ...event.metadata,
      version: event.metadata?.version ?? 1,
      environment: event.metadata?.environment ?? (process.env.VERCEL_ENV || 'development'),
    },
    created_at: event.created_at || now,
  };

  // Dedup check
  if (fullEvent.metadata.dedup_key) {
    const existing = await kv.sismember(DEDUP_KEY, fullEvent.metadata.dedup_key);
    if (existing) {
      return fullEvent;
    }
  }

  // Append to main list
  await kv.lpush(EVENTS_KEY, JSON.stringify(fullEvent));

  // Index by entity
  if (fullEvent.entity_type && fullEvent.entity_id) {
    await kv.lpush(
      `${EVENTS_INDEX_PREFIX}:entity:${fullEvent.entity_type}:${fullEvent.entity_id}`,
      fullEvent.event_id
    );
  }

  // Index by correlation
  if (fullEvent.correlation_id) {
    await kv.lpush(
      `${EVENTS_INDEX_PREFIX}:corr:${fullEvent.correlation_id}`,
      fullEvent.event_id
    );
  }

  // Index by command
  if (fullEvent.metadata.command_id) {
    await kv.lpush(
      `${EVENTS_INDEX_PREFIX}:cmd:${fullEvent.metadata.command_id}`,
      fullEvent.event_id
    );
  }

  // Track dedup key
  if (fullEvent.metadata.dedup_key) {
    await kv.sadd(DEDUP_KEY, fullEvent.metadata.dedup_key);
  }

  return fullEvent;
}

export async function getEvents(filter: EventFilter = {}): Promise<CosEvent[]> {
  const kv = await getKV();
  const limit = filter.limit || 100;

  if (filter.entity_type && filter.entity_id) {
    return getEventsByEntity(filter.entity_type, filter.entity_id, limit);
  }
  if (filter.correlation_id) {
    return getEventsByCorrelation(filter.correlation_id, limit);
  }
  if (filter.command_id) {
    return getEventsByCommand(filter.command_id, limit);
  }

  const rawEvents = await kv.lrange(EVENTS_KEY, 0, -1);
  let events: CosEvent[] = (rawEvents || []).map((raw: any) =>
    typeof raw === 'string' ? JSON.parse(raw) : raw
  );

  if (filter.event_type) events = events.filter(e => e.event_type === filter.event_type);
  if (filter.event_types?.length) {
    const types = new Set(filter.event_types);
    events = events.filter(e => types.has(e.event_type));
  }
  if (filter.source) events = events.filter(e => e.source === filter.source);
  if (filter.actor) events = events.filter(e => e.actor === filter.actor);
  if (filter.execution_run_id) events = events.filter(e => e.metadata.execution_run_id === filter.execution_run_id);
  if (filter.after) events = events.filter(e => e.timestamp >= filter.after!);
  if (filter.before) events = events.filter(e => e.timestamp <= filter.before!);

  return events.slice(0, limit);
}

export async function getEventsByEntity(entityType: string, entityId: string, limit: number = 100): Promise<CosEvent[]> {
  const kv = await getKV();
  const key = `${EVENTS_INDEX_PREFIX}:entity:${entityType}:${entityId}`;
  const eventIds: string[] = await kv.lrange(key, 0, -1);
  if (!eventIds.length) return [];

  const allRaw = await kv.lrange(EVENTS_KEY, 0, -1);
  const allEvents: CosEvent[] = (allRaw || []).map((raw: any) => typeof raw === 'string' ? JSON.parse(raw) : raw);
  const idSet = new Set(eventIds);
  return allEvents.filter(e => idSet.has(e.event_id)).slice(0, limit);
}

export async function getEventsByCorrelation(correlationId: string, limit: number = 100): Promise<CosEvent[]> {
  const kv = await getKV();
  const key = `${EVENTS_INDEX_PREFIX}:corr:${correlationId}`;
  const eventIds: string[] = await kv.lrange(key, 0, -1);
  if (!eventIds.length) return [];

  const allRaw = await kv.lrange(EVENTS_KEY, 0, -1);
  const allEvents: CosEvent[] = (allRaw || []).map((raw: any) => typeof raw === 'string' ? JSON.parse(raw) : raw);
  const idSet = new Set(eventIds);
  return allEvents.filter(e => idSet.has(e.event_id)).slice(0, limit);
}

export async function getEventsByCommand(commandId: string, limit: number = 100): Promise<CosEvent[]> {
  const kv = await getKV();
  const key = `${EVENTS_INDEX_PREFIX}:cmd:${commandId}`;
  const eventIds: string[] = await kv.lrange(key, 0, -1);
  if (!eventIds.length) return [];

  const allRaw = await kv.lrange(EVENTS_KEY, 0, -1);
  const allEvents: CosEvent[] = (allRaw || []).map((raw: any) => typeof raw === 'string' ? JSON.parse(raw) : raw);
  const idSet = new Set(eventIds);
  return allEvents.filter(e => idSet.has(e.event_id)).slice(0, limit);
}

// ── Execution context builder ─────────────────────────────────────

export interface ExecutionContext {
  command_id: string;
  execution_run_id: string;
  plan_id: string;
  step_id?: string;
  tool_call_id?: string;
}

export function buildEventWithContext(
  ctx: ExecutionContext,
  partial: Omit<CosEvent, 'event_id' | 'created_at' | 'metadata' | 'correlation_id'> & {
    metadata?: Partial<EventMetadata>;
    correlation_id?: string;
  }
): Omit<CosEvent, 'event_id' | 'created_at'> {
  return {
    ...partial,
    correlation_id: partial.correlation_id || ctx.command_id,
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      command_id: ctx.command_id,
      execution_run_id: ctx.execution_run_id,
      plan_id: ctx.plan_id,
      step_id: ctx.step_id,
      tool_call_id: ctx.tool_call_id,
      ...partial.metadata,
    },
  };
}
