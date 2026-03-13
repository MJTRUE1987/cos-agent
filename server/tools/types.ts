/**
 * Tool system types — contracts, adapters, results.
 */

import type { ExecutionContext, CosEvent } from '../event-log/eventStore.js';

// ── Tool Contract ─────────────────────────────────────────────────

export interface ToolContract {
  name: string;
  version: number;
  description: string;
  category: 'crm' | 'email' | 'calendar' | 'scheduling' | 'meeting' | 'analysis' | 'proposal' | 'messaging';
  source_system: string;
  risk_level: 'safe' | 'low' | 'medium' | 'high' | 'critical';
  approval_required: boolean;
  idempotency: {
    strategy: 'read_only' | 'natural' | 'key_based' | 'none';
    key_template?: string;
    ttl_seconds?: number;
  };
  side_effects: string[];
  retry: {
    max_retries: number;
    backoff: 'none' | 'fixed' | 'exponential';
    base_delay_ms: number;
    retryable_errors: string[];
  };
  timeout_ms: number;
}

// ── Tool Result ───────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  outputs: Record<string, any>;
  events: Array<Omit<CosEvent, 'event_id' | 'created_at'>>;
  side_effects_performed: string[];
  idempotency_key?: string;
  duration_ms: number;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

// ── Tool Adapter ──────────────────────────────────────────────────

export interface ToolAdapter {
  contract: ToolContract;
  execute(inputs: Record<string, any>, ctx: ExecutionContext): Promise<ToolResult>;
}

// ── Idempotency helpers ───────────────────────────────────────────

export function buildIdempotencyKey(template: string, inputs: Record<string, any>): string {
  const date = new Date().toISOString().split('T')[0];
  let key = template;

  // Replace {field} tokens
  key = key.replace(/\{(\w+)\}/g, (_, field) => {
    const val = inputs[field];
    return val != null ? String(val) : 'null';
  });

  // Replace {property_hash} with a simple hash of properties
  if (key.includes('{property_hash}') || key.includes('{body_hash}') || key.includes('{text_hash}') || key.includes('{focus_hash}') || key.includes('{pricing_hash}')) {
    const hash = simpleHash(JSON.stringify(inputs));
    key = key.replace(/\{(?:property|body|text|focus|pricing|attendees|title)_hash\}/g, hash);
  }

  key = key.replace('{date}', date);
  return key;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}
