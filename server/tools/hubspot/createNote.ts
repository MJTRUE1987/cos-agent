/**
 * hubspot.create_note — Add a note to a deal/contact in HubSpot.
 * Wraps: api/crm-update.js (action: add_note)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { buildIdempotencyKey } from '../types.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotCreateNote: ToolAdapter = {
  contract: {
    name: 'hubspot.create_note',
    version: 1,
    description: 'Add a note to a deal, contact, or company in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'low',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'hubspot:note:{deal_id}:{body_hash}:{date}', ttl_seconds: 86400 },
    side_effects: ['Creates note in HubSpot'],
    retry: { max_retries: 2, backoff: 'exponential', base_delay_ms: 2000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { body: string; deal_id?: string; contact_id?: string; company_id?: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          properties: {
            hs_timestamp: new Date().toISOString(),
            hs_note_body: inputs.body,
          },
        }),
      });

      if (!r.ok) {
        const err = await r.text();
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: String(r.status), message: err, retryable: r.status === 429 || r.status >= 500 },
        };
      }

      const result = await r.json();

      // Associate with deal
      if (inputs.deal_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${result.id}/associations/deals/${inputs.deal_id}/note_to_deal`, {
          method: 'PUT', headers,
        }).catch(() => {});
      }

      // Associate with contact
      if (inputs.contact_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${result.id}/associations/contacts/${inputs.contact_id}/note_to_contact`, {
          method: 'PUT', headers,
        }).catch(() => {});
      }

      const entityId = inputs.deal_id || inputs.contact_id || inputs.company_id || '';

      return {
        success: true,
        outputs: { note_id: result.id },
        events: [{
          event_type: 'hubspot.deal.note_added',
          source: 'hubspot',
          entity_type: inputs.deal_id ? 'deal' : 'contact',
          entity_id: entityId,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { note_id: result.id, body_preview: inputs.body.slice(0, 200) },
          metadata: {
            version: 1,
            environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id,
            execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id,
            step_id: ctx.step_id,
            tool_call_id: ctx.tool_call_id,
          },
        }],
        side_effects_performed: [`Created note ${result.id} on ${inputs.deal_id ? 'deal' : 'entity'} ${entityId}`],
        idempotency_key: buildIdempotencyKey(this.contract.idempotency.key_template!, inputs),
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'FETCH_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
