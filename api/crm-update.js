// HubSpot CRM Update API
// Supports: update deal stage, create deal, add notes, create contacts

const HUBSPOT_BASE = 'https://api.hubapi.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'HUBSPOT_ACCESS_TOKEN not configured' });

  const { action, dealId, properties, contactEmail, contactProperties, note, granolaNotes, companyName } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required (update_stage, create_deal, add_note, create_contact, summarize_call)' });

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    let result = {};

    switch (action) {
      case 'update_stage':
      case 'update_deal': {
        if (!dealId) {
          return res.status(400).json({ error: 'dealId required' });
        }
        if (!properties || Object.keys(properties).length === 0) {
          return res.status(400).json({ error: 'properties required' });
        }
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ properties }),
        });
        result = await r.json();
        break;
      }

      case 'search_emails': {
        // Search Gmail for messages matching a company name
        const query = req.body.query;
        const maxResults = req.body.maxResults || 10;
        if (!query) return res.status(400).json({ error: 'query required' });

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
        if (!clientId || !clientSecret || !refreshToken) {
          return res.status(500).json({ error: 'Gmail not configured' });
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.status(500).json({ error: 'Gmail auth failed' });

        const gmailHeaders = { Authorization: `Bearer ${tokenData.access_token}` };
        const listRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
          { headers: gmailHeaders }
        );
        if (!listRes.ok) return res.status(500).json({ error: 'Gmail search failed' });
        const listData = await listRes.json();
        const messages = listData.messages || [];

        const details = await Promise.all(
          messages.slice(0, maxResults).map(m =>
            fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers: gmailHeaders })
              .then(r2 => r2.json())
              .catch(() => null)
          )
        );

        result = details.filter(Boolean).map(msg => {
          const getHeader = (name) => (msg.payload?.headers || []).find(h => h.name === name)?.value || '';
          return {
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader('From'),
            to: getHeader('To'),
            subject: getHeader('Subject'),
            date: getHeader('Date'),
            snippet: msg.snippet || '',
          };
        });
        break;
      }

      case 'create_deal': {
        if (!properties?.dealname) {
          return res.status(400).json({ error: 'properties.dealname required' });
        }
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ properties: { pipeline: 'default', ...properties } }),
        });
        result = await r.json();
        break;
      }

      case 'add_note': {
        if (!note && !granolaNotes) {
          return res.status(400).json({ error: 'note or granolaNotes required' });
        }

        let noteBody = note || '';

        // If Granola notes provided, summarize them with AI
        if (granolaNotes) {
          const anthropicKey = process.env.ANTHROPIC_API_KEY;
          if (anthropicKey) {
            const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': anthropicKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: 'Summarize sales call notes into a concise CRM note. Include: key discussion points, objections raised, next steps, and action items. Format with bullet points.',
                messages: [{ role: 'user', content: `Summarize these call notes for the CRM:\n\nCompany: ${companyName || 'Unknown'}\n\n${granolaNotes}` }],
              }),
            });
            const aiData = await aiRes.json();
            noteBody = aiData.content?.[0]?.text || granolaNotes;
          } else {
            noteBody = granolaNotes;
          }
        }

        // Create engagement note
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            properties: {
              hs_timestamp: new Date().toISOString(),
              hs_note_body: noteBody,
            },
          }),
        });
        result = await r.json();

        // Associate with deal if provided
        if (dealId && result.id) {
          await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${result.id}/associations/deals/${dealId}/note_to_deal`, {
            method: 'PUT',
            headers,
          });
        }

        result.summarizedNote = noteBody;
        break;
      }

      case 'create_contact': {
        // Accept both { contactEmail, contactProperties } and { email, name, company } from frontend
        const cEmail = contactEmail || req.body.email;
        if (!cEmail) {
          return res.status(400).json({ error: 'contactEmail or email required' });
        }
        const contactProps = { email: cEmail };
        if (contactProperties) Object.assign(contactProps, contactProperties);
        // Map frontend field names
        if (req.body.name) {
          const nameParts = req.body.name.trim().split(/\s+/);
          contactProps.firstname = nameParts[0] || '';
          contactProps.lastname = nameParts.slice(1).join(' ') || '';
        }
        if (req.body.company) contactProps.company = req.body.company;
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ properties: contactProps }),
        });
        result = await r.json();
        break;
      }

      case 'summarize_call': {
        // Takes Granola notes, summarizes, and returns options for what to do next
        if (!granolaNotes) {
          return res.status(400).json({ error: 'granolaNotes required' });
        }

        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (!anthropicKey) {
          return res.status(500).json({ error: 'ANTHROPIC_API_KEY needed for summarization' });
        }

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: `You are a sales ops assistant. Analyze call notes and return a JSON object with:
{
  "summary": "2-3 sentence summary",
  "keyPoints": ["bullet point 1", "bullet point 2"],
  "nextSteps": ["action item 1", "action item 2"],
  "suggestedDealStage": "one of: Disco Booked, Disco Complete, Demo Scheduled, Demo Completed, Negotiating, Committed",
  "shouldCreateOpportunity": true/false,
  "shouldUpdateStage": true/false,
  "sentiment": "positive/neutral/negative",
  "dealValueSignals": "any pricing discussed or budget mentioned"
}
Return ONLY valid JSON, no markdown.`,
            messages: [{ role: 'user', content: `Company: ${companyName || 'Unknown'}\nExisting Deal ID: ${dealId || 'None'}\n\nCall Notes:\n${granolaNotes}` }],
          }),
        });
        const aiData = await aiRes.json();
        const analysisText = (aiData.content?.[0]?.text || '{}').replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        try {
          result = JSON.parse(analysisText);
        } catch {
          result = { summary: analysisText, error: 'Failed to parse structured response' };
        }
        break;
      }

      case 'get_deal': {
        if (!dealId) return res.status(400).json({ error: 'dealId required' });
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,amount,closedate,hubspot_owner_id,notes_last_updated`, {
          headers,
        });
        result = await r.json();
        break;
      }

      case 'search_company': {
        // Search HubSpot for companies, deals, and contacts matching a name
        const query = req.body.query;
        if (!query) return res.status(400).json({ error: 'query required' });
        console.log(`[crm:search_company] Searching HubSpot for: ${query}`);

        const searches = await Promise.allSettled([
          // Search deals
          fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
            method: 'POST', headers,
            body: JSON.stringify({
              query,
              properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'],
              limit: 5,
            }),
          }).then(r2 => r2.json()),
          // Search companies
          fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
            method: 'POST', headers,
            body: JSON.stringify({
              query,
              properties: ['name', 'domain', 'industry', 'city', 'state'],
              limit: 5,
            }),
          }).then(r2 => r2.json()),
          // Search contacts
          fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
            method: 'POST', headers,
            body: JSON.stringify({
              query,
              properties: ['email', 'firstname', 'lastname', 'company', 'jobtitle'],
              limit: 5,
            }),
          }).then(r2 => r2.json()),
        ]);

        const deals = searches[0].status === 'fulfilled' ? (searches[0].value.results || []) : [];
        const companies = searches[1].status === 'fulfilled' ? (searches[1].value.results || []) : [];
        const contacts = searches[2].status === 'fulfilled' ? (searches[2].value.results || []) : [];

        console.log(`[crm:search_company] Found: ${deals.length} deals, ${companies.length} companies, ${contacts.length} contacts`);

        result = {
          deals: deals.map(d => ({ id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, amount: d.properties.amount })),
          companies: companies.map(c => ({ id: c.id, name: c.properties.name, domain: c.properties.domain, industry: c.properties.industry })),
          contacts: contacts.map(c => ({ id: c.id, email: c.properties.email, firstName: c.properties.firstname, lastName: c.properties.lastname, company: c.properties.company, title: c.properties.jobtitle })),
          hasMatch: deals.length > 0 || companies.length > 0 || contacts.length > 0,
        };
        break;
      }

      case 'create_lead': {
        // Create a new deal + contact + company for a warm intro / new lead
        const { dealName, contactEmail: leadEmail, contactName: leadName, introContext, stage: leadStage } = req.body;
        if (!dealName) return res.status(400).json({ error: 'dealName required' });
        console.log(`[crm:create_lead] Creating lead: ${dealName}, contact: ${leadName} <${leadEmail}>`);

        // Dedup check — search for existing company/contact/deal before creating
        const dedupResults = {};
        try {
          const [compSearch, contactSearch] = await Promise.all([
            fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/search`, {
              method: 'POST', headers,
              body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: dealName }] }], limit: 5 }),
            }).then(r => r.json()).catch(() => ({ results: [] })),
            leadEmail ? fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
              method: 'POST', headers,
              body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: leadEmail }] }], limit: 5 }),
            }).then(r => r.json()).catch(() => ({ results: [] })) : Promise.resolve({ results: [] }),
          ]);
          dedupResults.existingCompanies = compSearch.results || [];
          dedupResults.existingContacts = contactSearch.results || [];
          if (dedupResults.existingCompanies.length > 0 || dedupResults.existingContacts.length > 0) {
            console.warn(`[crm:create_lead] Potential duplicates found for "${dealName}": ${dedupResults.existingCompanies.length} companies, ${dedupResults.existingContacts.length} contacts`);
          }
        } catch (e) {
          console.error('[crm:create_lead] Dedup check failed:', e.message);
        }

        const results = { dedupWarning: (dedupResults.existingCompanies?.length > 0 || dedupResults.existingContacts?.length > 0) ? `Found ${dedupResults.existingCompanies?.length || 0} existing companies and ${dedupResults.existingContacts?.length || 0} existing contacts matching "${dealName}"` : null };

        // 1. Create company
        try {
          const companyRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies`, {
            method: 'POST', headers,
            body: JSON.stringify({ properties: { name: dealName } }),
          });
          results.company = await companyRes.json();
          console.log(`[crm:create_lead] Company created: ${results.company.id}`);
        } catch (e) {
          console.error('[crm:create_lead] Company creation failed:', e.message);
        }

        // 2. Create contact if email provided
        if (leadEmail) {
          try {
            const nameParts = (leadName || '').split(' ');
            const contactRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
              method: 'POST', headers,
              body: JSON.stringify({
                properties: {
                  email: leadEmail,
                  firstname: nameParts[0] || '',
                  lastname: nameParts.slice(1).join(' ') || '',
                  company: dealName,
                },
              }),
            });
            results.contact = await contactRes.json();
            console.log(`[crm:create_lead] Contact created: ${results.contact.id}`);
          } catch (e) {
            console.error('[crm:create_lead] Contact creation failed:', e.message);
          }
        }

        // 3. Create deal
        try {
          const dealProps = {
            dealname: dealName,
            dealstage: leadStage || '93124525', // Default: Disco Booked
            hubspot_owner_id: '151853665', // Mike
            pipeline: 'default',
          };
          const dealRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals`, {
            method: 'POST', headers,
            body: JSON.stringify({ properties: dealProps }),
          });
          results.deal = await dealRes.json();
          console.log(`[crm:create_lead] Deal created: ${results.deal.id}`);

          // Associate deal with company and contact
          if (results.company?.id && results.deal?.id) {
            await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${results.deal.id}/associations/companies/${results.company.id}/deal_to_company`, {
              method: 'PUT', headers,
            }).catch(() => {});
          }
          if (results.contact?.id && results.deal?.id) {
            await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${results.deal.id}/associations/contacts/${results.contact.id}/deal_to_contact`, {
              method: 'PUT', headers,
            }).catch(() => {});
          }
        } catch (e) {
          console.error('[crm:create_lead] Deal creation failed:', e.message);
        }

        // 4. Add intro context as a note
        if (introContext && results.deal?.id) {
          try {
            const noteRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
              method: 'POST', headers,
              body: JSON.stringify({
                properties: {
                  hs_timestamp: new Date().toISOString(),
                  hs_note_body: introContext,
                },
              }),
            });
            const noteResult = await noteRes.json();
            if (noteResult.id) {
              await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${noteResult.id}/associations/deals/${results.deal.id}/note_to_deal`, {
                method: 'PUT', headers,
              }).catch(() => {});
            }
            results.note = noteResult;
            console.log(`[crm:create_lead] Note attached to deal`);
          } catch (e) {
            console.error('[crm:create_lead] Note creation failed:', e.message);
          }
        }

        result = results;
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}. Use: update_stage, create_deal, add_note, create_contact, create_lead, search_company, summarize_call, get_deal` });
    }

    return res.status(200).json({ success: true, action, result });
  } catch (err) {
    console.error('CRM update error:', err);
    return res.status(500).json({ error: 'CRM operation failed' });
  }
}
