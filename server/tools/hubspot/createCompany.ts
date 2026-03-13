/**
 * hubspot.create_company — Create a company in HubSpot.
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotCreateCompany: ToolAdapter = {
  contract: {
    name: 'hubspot.create_company',
    version: 1,
    description: 'Create a new company in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'medium',
    approval_required: true,
    idempotency: { strategy: 'key_based', key_template: 'hubspot:create_company:{name}:{date}', ttl_seconds: 86400 },
    side_effects: ['Creates company in HubSpot'],
    retry: { max_retries: 2, backoff: 'exponential', base_delay_ms: 2000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: {
    name: string;
    domain?: string;
    website?: string;
    industry?: string;
    notes?: string;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      const properties: Record<string, string> = { name: inputs.name };
      if (inputs.domain) properties.domain = inputs.domain;
      if (inputs.website) properties.website = inputs.website;
      if (inputs.industry) properties.industry = inputs.industry;
      if (inputs.notes) properties.description = inputs.notes;

      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies`, {
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

      return {
        success: true,
        outputs: {
          company_id: result.id,
          name: inputs.name,
          domain: inputs.domain,
        },
        events: [{
          event_type: 'hubspot.company.created',
          source: 'hubspot',
          entity_type: 'company',
          entity_id: result.id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { company_id: result.id, name: inputs.name, domain: inputs.domain },
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
        side_effects_performed: [`Created company ${result.id}: ${inputs.name}`],
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
