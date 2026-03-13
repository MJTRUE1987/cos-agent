/**
 * POST /api/v2/wizard — Execute wizard steps for CRM creation flows.
 *
 * Actions:
 *   search_contact  — Search HubSpot for existing contact
 *   search_company  — Search HubSpot for existing company
 *   create_contact  — Create contact in HubSpot
 *   create_company  — Create company in HubSpot
 *   create_deal     — Create deal and associate records
 */

import { safeHandler } from './_handler.js';
import { appendEvent, generateId } from '../../server/event-log/eventStore.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';

export default safeHandler('wizard', async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { action, data, command_id } = req.body || {};
  if (!action) return res.status(400).json({ success: false, error: 'Missing "action" field' });

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const cmdId = command_id || generateId('cmd');

  // ── Search Contact ──
  if (action === 'search_contact') {
    const query = data?.query || '';
    if (!query) return res.status(200).json({ success: true, results: [] });

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
        method: 'POST', headers,
        body: JSON.stringify({
          query,
          properties: ['email', 'firstname', 'lastname', 'company', 'jobtitle', 'phone'],
          limit: 10,
        }),
      });
      const d = await r.json();
      const contacts = (d.results || []).map((c: any) => ({
        id: c.id,
        name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim(),
        email: c.properties.email,
        title: c.properties.jobtitle,
        company: c.properties.company,
        phone: c.properties.phone,
      }));
      return res.status(200).json({ success: true, results: contacts });
    } catch (err: any) {
      return res.status(200).json({ success: false, error: err.message, results: [] });
    }
  }

  // ── Search Company ──
  if (action === 'search_company') {
    const query = data?.query || '';
    if (!query) return res.status(200).json({ success: true, results: [] });

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
        method: 'POST', headers,
        body: JSON.stringify({
          query,
          properties: ['name', 'domain', 'industry', 'website', 'description'],
          limit: 10,
        }),
      });
      const d = await r.json();
      const companies = (d.results || []).map((c: any) => ({
        id: c.id,
        name: c.properties.name,
        domain: c.properties.domain,
        industry: c.properties.industry,
        website: c.properties.website,
      }));
      return res.status(200).json({ success: true, results: companies });
    } catch (err: any) {
      return res.status(200).json({ success: false, error: err.message, results: [] });
    }
  }

  // ── Create Contact ──
  if (action === 'create_contact') {
    const props: Record<string, string> = {};
    if (data.email) props.email = data.email;
    if (data.firstname) props.firstname = data.firstname;
    if (data.lastname) props.lastname = data.lastname;
    if (data.jobtitle) props.jobtitle = data.jobtitle;
    if (data.phone) props.phone = data.phone;
    if (data.linkedin_url) props.hs_linkedin_url = data.linkedin_url;

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
        method: 'POST', headers,
        body: JSON.stringify({ properties: props }),
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(200).json({ success: false, error: err });
      }
      const result = await r.json();

      await appendEvent({
        event_type: 'hubspot.contact.created',
        source: 'hubspot',
        entity_type: 'contact',
        entity_id: result.id,
        correlation_id: cmdId,
        actor: 'user',
        timestamp: new Date().toISOString(),
        payload: { contact_id: result.id, email: data.email, name: `${data.firstname || ''} ${data.lastname || ''}`.trim() },
        metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', command_id: cmdId },
      });

      return res.status(200).json({
        success: true,
        contact_id: result.id,
        name: `${data.firstname || ''} ${data.lastname || ''}`.trim(),
      });
    } catch (err: any) {
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  // ── Create Company ──
  if (action === 'create_company') {
    const props: Record<string, string> = {};
    if (data.name) props.name = data.name;
    if (data.domain) props.domain = data.domain;
    if (data.website) props.website = data.website;
    if (data.industry) props.industry = data.industry;
    if (data.notes) props.description = data.notes;

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies`, {
        method: 'POST', headers,
        body: JSON.stringify({ properties: props }),
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(200).json({ success: false, error: err });
      }
      const result = await r.json();

      await appendEvent({
        event_type: 'hubspot.company.created',
        source: 'hubspot',
        entity_type: 'company',
        entity_id: result.id,
        correlation_id: cmdId,
        actor: 'user',
        timestamp: new Date().toISOString(),
        payload: { company_id: result.id, name: data.name, domain: data.domain },
        metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', command_id: cmdId },
      });

      return res.status(200).json({
        success: true,
        company_id: result.id,
        name: data.name,
      });
    } catch (err: any) {
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  // ── Create Deal ──
  if (action === 'create_deal') {
    const props: Record<string, string> = {};
    if (data.dealname) props.dealname = data.dealname;
    if (data.dealstage) props.dealstage = data.dealstage;
    if (data.amount) props.amount = data.amount;
    if (data.closedate) props.closedate = data.closedate;
    if (data.hubspot_owner_id) props.hubspot_owner_id = data.hubspot_owner_id;
    if (data.pipeline) props.pipeline = data.pipeline;
    if (data.next_step) props.hs_next_step = data.next_step;
    if (data.notes) props.description = data.notes;

    try {
      const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
        method: 'POST', headers,
        body: JSON.stringify({ properties: props }),
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(200).json({ success: false, error: err });
      }
      const result = await r.json();
      const trace: string[] = [];

      // Associate with company
      if (data.company_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${result.id}/associations/companies/${data.company_id}/deal_to_company`, {
          method: 'PUT', headers,
        }).catch(() => {});
        trace.push(`Associated deal with company ${data.company_id}`);
      }

      // Associate with contact
      if (data.contact_id && result.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${result.id}/associations/contacts/${data.contact_id}/deal_to_contact`, {
          method: 'PUT', headers,
        }).catch(() => {});
        trace.push(`Associated deal with contact ${data.contact_id}`);
      }

      await appendEvent({
        event_type: 'hubspot.deal.created',
        source: 'hubspot',
        entity_type: 'deal',
        entity_id: result.id,
        correlation_id: cmdId,
        actor: 'user',
        timestamp: new Date().toISOString(),
        payload: {
          deal_id: result.id,
          dealname: data.dealname,
          dealstage: data.dealstage,
          amount: data.amount,
          company_id: data.company_id,
          contact_id: data.contact_id,
        },
        metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', command_id: cmdId },
      });

      return res.status(200).json({
        success: true,
        deal_id: result.id,
        dealname: data.dealname,
        trace,
      });
    } catch (err: any) {
      return res.status(200).json({ success: false, error: err.message });
    }
  }

  return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
});
