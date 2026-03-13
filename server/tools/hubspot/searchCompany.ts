/**
 * hubspot.search_company — Find company, deals, contacts by name/domain.
 * Wraps: api/crm-update.js (action: search_company)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export const hubspotSearchCompany: ToolAdapter = {
  contract: {
    name: 'hubspot.search_company',
    version: 1,
    description: 'Find company by name or domain in HubSpot',
    category: 'crm',
    source_system: 'hubspot',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'read_only' },
    side_effects: [],
    retry: { max_retries: 3, backoff: 'exponential', base_delay_ms: 1000, retryable_errors: ['429', '503'] },
    timeout_ms: 15000,
  },

  async execute(inputs: { name?: string; domain?: string; query?: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const query = inputs.query || inputs.name || inputs.domain || '';
    const headers = {
      Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    };

    try {
      const [dealsR, companiesR, contactsR] = await Promise.allSettled([
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query, properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'], limit: 5 }),
        }).then(r => r.json()),
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query, properties: ['name', 'domain', 'industry'], limit: 5 }),
        }).then(r => r.json()),
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
          method: 'POST', headers,
          body: JSON.stringify({ query, properties: ['email', 'firstname', 'lastname', 'company', 'jobtitle'], limit: 5 }),
        }).then(r => r.json()),
      ]);

      const deals = dealsR.status === 'fulfilled' ? (dealsR.value.results || []) : [];
      const companies = companiesR.status === 'fulfilled' ? (companiesR.value.results || []) : [];
      const contacts = contactsR.status === 'fulfilled' ? (contactsR.value.results || []) : [];

      return {
        success: true,
        outputs: {
          deals: deals.map((d: any) => ({ id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, amount: d.properties.amount })),
          companies: companies.map((c: any) => ({ id: c.id, name: c.properties.name, domain: c.properties.domain })),
          contacts: contacts.map((c: any) => ({ id: c.id, email: c.properties.email, name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(), role: c.properties.jobtitle })),
          has_match: deals.length > 0 || companies.length > 0 || contacts.length > 0,
        },
        events: [],
        side_effects_performed: [],
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
