/**
 * hubspot.get_deal — Fetch full deal record with associations.
 * Wraps: api/crm-update.js (action: get_deal + search_company)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

function getHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export const hubspotGetDeal: ToolAdapter = {
  contract: {
    name: 'hubspot.get_deal',
    version: 1,
    description: 'Fetch full deal record with associations from HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'read_only' },
    side_effects: [],
    retry: { max_retries: 3, backoff: 'exponential', base_delay_ms: 1000, retryable_errors: ['429', '503', 'ETIMEDOUT'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { deal_id: string; include_contacts?: boolean; include_notes?: boolean; include_company?: boolean }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = getHeaders();

    try {
      // Fetch deal
      const props = 'dealname,dealstage,amount,closedate,hubspot_owner_id,notes_last_updated,hs_next_step,description';
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${inputs.deal_id}?properties=${props}`, { headers });
      if (!r.ok) {
        const err = await r.text();
        return {
          success: false,
          outputs: {},
          events: [],
          side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: String(r.status), message: err, retryable: r.status === 429 || r.status >= 500 },
        };
      }
      const dealData = await r.json();

      // Fetch contacts if requested
      let contacts: any[] = [];
      if (inputs.include_contacts !== false) {
        try {
          const assocR = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${inputs.deal_id}/associations/contacts`, { headers });
          if (assocR.ok) {
            const assocData = await assocR.json();
            const contactIds = (assocData.results || []).map((a: any) => a.toObjectId);
            contacts = await Promise.all(
              contactIds.slice(0, 10).map(async (cid: string) => {
                const cr = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${cid}?properties=email,firstname,lastname,jobtitle,company`, { headers });
                if (!cr.ok) return null;
                const cd = await cr.json();
                return {
                  id: cd.id,
                  name: `${cd.properties.firstname || ''} ${cd.properties.lastname || ''}`.trim(),
                  email: cd.properties.email || '',
                  role: cd.properties.jobtitle || null,
                };
              })
            );
            contacts = contacts.filter(Boolean);
          }
        } catch { /* non-fatal */ }
      }

      const deal = {
        id: dealData.id,
        name: dealData.properties.dealname,
        stage: dealData.properties.dealstage,
        amount: dealData.properties.amount ? Number(dealData.properties.amount) : null,
        close_date: dealData.properties.closedate || null,
        owner_id: dealData.properties.hubspot_owner_id || '',
        owner_name: null, // resolved by caller if needed
        next_step: dealData.properties.hs_next_step || null,
        last_activity_at: dealData.properties.notes_last_updated || null,
        contacts,
      };

      return {
        success: true,
        outputs: { deal },
        events: [{
          event_type: 'hubspot.deal.observed',
          source: 'hubspot',
          entity_type: 'deal',
          entity_id: inputs.deal_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { deal_name: deal.name, stage: deal.stage, amount: deal.amount },
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
        side_effects_performed: [],
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
