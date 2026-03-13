/**
 * Safety Guards — Rate limiting, idempotency enforcement, and circuit breaking.
 */

import { getKV } from '../lib/kv.js';

// ── Idempotency Guard ──────────────────────────────────────────────

const IDEMPOTENCY_TTL = 3600;

export async function checkIdempotency(key: string): Promise<{ duplicate: boolean; previous_result?: any }> {
  if (!key) return { duplicate: false };
  const kv = await getKV();
  const existing = await kv.get(`idem:${key}`);
  if (existing) {
    return { duplicate: true, previous_result: typeof existing === 'string' ? JSON.parse(existing) : existing };
  }
  return { duplicate: false };
}

export async function recordIdempotency(key: string, result: any): Promise<void> {
  if (!key) return;
  const kv = await getKV();
  await kv.set(`idem:${key}`, JSON.stringify(result), { ex: IDEMPOTENCY_TTL });
}

// ── Rate Limiter ───────────────────────────────────────────────────

interface RateLimitConfig { window_seconds: number; max_requests: number; }

const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'command': { window_seconds: 60, max_requests: 10 },
  'tool_call': { window_seconds: 60, max_requests: 50 },
  'email_send': { window_seconds: 3600, max_requests: 20 },
  'crm_write': { window_seconds: 60, max_requests: 30 },
  'slack_message': { window_seconds: 60, max_requests: 10 },
};

export async function checkRateLimit(category: string, identifier?: string): Promise<{ allowed: boolean; remaining: number; reset_at: number }> {
  const config = RATE_LIMITS[category];
  if (!config) return { allowed: true, remaining: 999, reset_at: 0 };

  const kv = await getKV();
  const now = Math.floor(Date.now() / 1000);
  const countKey = `rl:${category}:${identifier || 'global'}:${Math.floor(now / config.window_seconds)}`;
  const count = await kv.incr(countKey);

  if (count === 1) await kv.expire(countKey, config.window_seconds + 1);

  return {
    allowed: count <= config.max_requests,
    remaining: Math.max(0, config.max_requests - count),
    reset_at: (Math.floor(now / config.window_seconds) + 1) * config.window_seconds,
  };
}

// ── Circuit Breaker ────────────────────────────────────────────────

interface CircuitState { failures: number; last_failure: number; state: 'closed' | 'open' | 'half_open'; }

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 60000;
const CIRCUIT_TTL = 300;

export async function checkCircuit(service: string): Promise<{ allowed: boolean; state: string }> {
  const kv = await getKV();
  const key = `circuit:${service}`;
  const raw = await kv.get(key);
  const circuit: CircuitState = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { failures: 0, last_failure: 0, state: 'closed' };

  if (circuit.state === 'open') {
    if (Date.now() - circuit.last_failure > CIRCUIT_RESET_MS) {
      circuit.state = 'half_open';
      await kv.set(key, JSON.stringify(circuit), { ex: CIRCUIT_TTL });
      return { allowed: true, state: 'half_open' };
    }
    return { allowed: false, state: 'open' };
  }
  return { allowed: true, state: circuit.state };
}

export async function recordCircuitSuccess(service: string): Promise<void> {
  const kv = await getKV();
  await kv.set(`circuit:${service}`, JSON.stringify({ failures: 0, last_failure: 0, state: 'closed' }), { ex: CIRCUIT_TTL });
}

export async function recordCircuitFailure(service: string): Promise<void> {
  const kv = await getKV();
  const key = `circuit:${service}`;
  const raw = await kv.get(key);
  const circuit: CircuitState = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { failures: 0, last_failure: 0, state: 'closed' };
  circuit.failures++;
  circuit.last_failure = Date.now();
  if (circuit.failures >= CIRCUIT_THRESHOLD) circuit.state = 'open';
  await kv.set(key, JSON.stringify(circuit), { ex: CIRCUIT_TTL });
}

// ── Approval Enforcement ───────────────────────────────────────────

const ALWAYS_REQUIRE_APPROVAL = new Set(['hubspot.update_deal', 'email.send', 'calendar.create_event']);
const NEVER_REQUIRE_APPROVAL = new Set(['hubspot.get_deal', 'hubspot.search_company', 'gmail.search_threads', 'granola.get_notes', 'calendar.get_events', 'pricing.calculate']);

export function requiresApproval(toolName: string, riskLevel: string): boolean {
  if (ALWAYS_REQUIRE_APPROVAL.has(toolName)) return true;
  if (NEVER_REQUIRE_APPROVAL.has(toolName)) return false;
  if (riskLevel === 'high') return true;
  return false;
}

// ── Execution Logging ──────────────────────────────────────────────

export async function logExecution(entry: {
  tool: string; command_id: string; execution_run_id: string; step_id: string;
  success: boolean; duration_ms: number; side_effects: string[]; error?: string;
}): Promise<void> {
  const kv = await getKV();
  const key = `execlog:${new Date().toISOString().split('T')[0]}`;
  const existing = await kv.get(key);
  const logs: any[] = existing ? (typeof existing === 'string' ? JSON.parse(existing) : existing) : [];
  logs.push({ ...entry, timestamp: new Date().toISOString() });
  await kv.set(key, JSON.stringify(logs.slice(-1000)), { ex: 7 * 86400 });
}
