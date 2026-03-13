/**
 * hubspot.create_deal — Create a deal in HubSpot.
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotCreateDeal: ToolAdapter = {
  contract: {
    name: 'hubspot.create_deal',
    version: 1,
    description: 'Create a new deal in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'high',
    approval_required: true,
    idempotency: { strategy: 'key_based', key_template: 'hubspot:create_deal:{dealname}:{date}', ttl_seconds: 86400 },
    side_effects: ['Creates deal in HubSpot'],
    retry: { max_retries: 2, backoff: 'exponential', base_delay_ms: 2000, retryable_errors: ['429', '503'] },
    timeout_ms: 15000,
  },

  async execute(inputs: {
    dealname: string;
    dealstage?: string;
    amount?: string;
    closedate?: string;
    hubspot_owner_id?: string;
    pipeline?: string;
    next_step?: string;
    notes?: string;
    company_id?: string;
    contact_id?: string;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      const properties: Record<string, string> = { dealname: inputs.dealname };
      if (inputs.dealstage) properties.dealstage = inputs.dealstage;
      if (inputs.amount) properties.amount = inputs.amount;
      if (inputs.closedate) properties.closedate = inputs.closedate;
      if (inputs.hubspot_owner_id) properties.hubspot_owner_id = inputs.hubspot_owner_id;
      if (inputs.pipeline) properties.pipeline = inputs.pipeline;
      if (inputs.next_step) properties.hs_next_step = inputs.next_step;
      if (inputs.notes) properties.description = inputs.notes;

      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ properties }),
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
      const sideEffects: string[] = [`Created deal ${result.id}: ${inputs.dealname}`];

      if (inputs.company_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${result.id}/associations/companies/${inputs.company_id}/deal_to_company`, {
          method: 'PUT', headers,
        }).catch(() => {});
        sideEffects.push(`Associated deal with company ${inputs.company_id}`);
      }

      if (inputs.contact_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${result.id}/associations/contacts/${inputs.contact_id}/deal_to_contact`, {
          method: 'PUT', headers,
        }).catch(() => {});
        sideEffects.push(`Associated deal with contact ${inputs.contact_id}`);
      }

      return {
        success: true,
        outputs: {
          deal_id: result.id,
          dealname: inputs.dealname,
          dealstage: inputs.dealstage,
        },
        events: [{
          event_type: 'hubspot.deal.created',
          source: 'hubspot',
          entity_type: 'deal',
          entity_id: result.id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: {
            deal_id: result.id,
            dealname: inputs.dealname,
            dealstage: inputs.dealstage,
            amount: inputs.amount,
            company_id: inputs.company_id,
            contact_id: inputs.contact_id,
          },
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
        side_effects_performed: sideEffects,
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
