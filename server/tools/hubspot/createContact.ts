/**
 * hubspot.create_contact — Create a contact in HubSpot.
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotCreateContact: ToolAdapter = {
  contract: {
    name: 'hubspot.create_contact',
    version: 1,
    description: 'Create a new contact in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'medium',
    approval_required: true,
    idempotency: { strategy: 'key_based', key_template: 'hubspot:create_contact:{email}:{date}', ttl_seconds: 86400 },
    side_effects: ['Creates contact in HubSpot'],
    retry: { max_retries: 2, backoff: 'exponential', base_delay_ms: 2000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: {
    email?: string;
    firstname?: string;
    lastname?: string;
    jobtitle?: string;
    phone?: string;
    linkedin_url?: string;
    notes?: string;
    company_id?: string;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      const properties: Record<string, string> = {};
      if (inputs.email) properties.email = inputs.email;
      if (inputs.firstname) properties.firstname = inputs.firstname;
      if (inputs.lastname) properties.lastname = inputs.lastname;
      if (inputs.jobtitle) properties.jobtitle = inputs.jobtitle;
      if (inputs.phone) properties.phone = inputs.phone;
      if (inputs.linkedin_url) properties.hs_linkedin_url = inputs.linkedin_url;

      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
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

      if (inputs.company_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${result.id}/associations/companies/${inputs.company_id}/contact_to_company`, {
          method: 'PUT', headers,
        }).catch(() => {});
      }

      return {
        success: true,
        outputs: {
          contact_id: result.id,
          name: `${inputs.firstname || ''} ${inputs.lastname || ''}`.trim(),
          email: inputs.email,
        },
        events: [{
          event_type: 'hubspot.contact.created',
          source: 'hubspot',
          entity_type: 'contact',
          entity_id: result.id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { contact_id: result.id, email: inputs.email, name: `${inputs.firstname || ''} ${inputs.lastname || ''}`.trim() },
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
        side_effects_performed: [`Created contact ${result.id}`],
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
