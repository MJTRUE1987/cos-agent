// HubSpot CRM Update API
// Supports: update deal stage, create deal, add notes, create contacts

const HUBSPOT_BASE = 'https://api.hubapi.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
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
      case 'update_stage': {
        if (!dealId || !properties?.dealstage) {
          return res.status(400).json({ error: 'dealId and properties.dealstage required' });
        }
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${dealId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ properties }),
        });
        result = await r.json();
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
        if (!contactEmail) {
          return res.status(400).json({ error: 'contactEmail required' });
        }
        const r = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            properties: {
              email: contactEmail,
              ...contactProperties,
            },
          }),
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
        const analysisText = aiData.content?.[0]?.text || '{}';
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

      default:
        return res.status(400).json({ error: `Unknown action: ${action}. Use: update_stage, create_deal, add_note, create_contact, summarize_call, get_deal` });
    }

    return res.status(200).json({ success: true, action, result });
  } catch (err) {
    console.error('CRM update error:', err);
    return res.status(500).json({ error: 'CRM operation failed' });
  }
}
