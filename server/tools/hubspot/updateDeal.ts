/**
 * hubspot.update_deal — Update deal properties in HubSpot.
 * Wraps: api/crm-update.js (action: update_stage / update_deal)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { buildIdempotencyKey } from '../types.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotUpdateDeal: ToolAdapter = {
  contract: {
    name: 'hubspot.update_deal',
    version: 1,
    description: 'Update deal properties in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'medium',
    approval_required: true, // evaluated by policy engine per-field
    idempotency: { strategy: 'key_based', key_template: 'hubspot:update:{deal_id}:{property_hash}:{date}', ttl_seconds: 86400 },
    side_effects: ['Modifies deal record in HubSpot'],
    retry: { max_retries: 1, backoff: 'fixed', base_delay_ms: 5000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { deal_id: string; properties: Record<string, any> }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      // Fetch current values for rollback tracking
      const propNames = Object.keys(inputs.properties).join(',');
      const currentR = await fetch(
        `${HUBSPOT_BASE}/crm/v3/objects/deals/${inputs.deal_id}?properties=${propNames}`,
        { headers }
      );
      const currentData = currentR.ok ? await currentR.json() : null;
      const previousValues: Record<string, any> = {};
      if (currentData?.properties) {
        for (const key of Object.keys(inputs.properties)) {
          previousValues[key] = currentData.properties[key] ?? null;
        }
      }

      // Apply update
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${inputs.deal_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ properties: inputs.properties }),
      });

      if (!r.ok) {
        const err = await r.text();
        return {
          success: false,
          outputs: {},
          events: [],
          side_effects_performed: [],
          idempotency_key: buildIdempotencyKey(this.contract.idempotency.key_template!, inputs),
          duration_ms: Date.now() - start,
          error: { code: String(r.status), message: err, retryable: r.status === 429 || r.status >= 500 },
        };
      }

      const result = await r.json();

      // Build events for each changed property
      const events: any[] = [];
      const dealName = result.properties?.dealname || currentData?.properties?.dealname || 'Unknown';

      if (inputs.properties.dealstage) {
        events.push({
          event_type: 'hubspot.deal.stage_changed',
          source: 'hubspot',
          entity_type: 'deal',
          entity_id: inputs.deal_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: {
            deal_name: dealName,
            old_stage: previousValues.dealstage,
            new_stage: inputs.properties.dealstage,
          },
          metadata: {
            version: 1,
            environment: process.env.VERCEL_ENV || 'development',
            dedup_key: `${inputs.deal_id}:stage:${inputs.properties.dealstage}:${new Date().toISOString().split('T')[0]}`,
            command_id: ctx.command_id,
            execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id,
            step_id: ctx.step_id,
            tool_call_id: ctx.tool_call_id,
          },
        });
      }

      if (inputs.properties.amount) {
        events.push({
          event_type: 'hubspot.deal.amount_changed',
          source: 'hubspot',
          entity_type: 'deal',
          entity_id: inputs.deal_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { deal_name: dealName, old_amount: previousValues.amount, new_amount: inputs.properties.amount },
          metadata: {
            version: 1,
            environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id,
            execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id,
            step_id: ctx.step_id,
            tool_call_id: ctx.tool_call_id,
          },
        });
      }

      return {
        success: true,
        outputs: {
          deal_id: inputs.deal_id,
          updated_properties: inputs.properties,
          previous_values: previousValues,
        },
        events,
        side_effects_performed: [`Updated deal ${inputs.deal_id}: ${Object.keys(inputs.properties).join(', ')}`],
        idempotency_key: buildIdempotencyKey(this.contract.idempotency.key_template!, inputs),
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false,
        outputs: {},
        events: [],
        side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'FETCH_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
