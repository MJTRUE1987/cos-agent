// Prep Notes API
// Aggregates research from HubSpot, web search, and internal data

const HUBSPOT_BASE = 'https://api.hubapi.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contactName, contactEmail, hubspotDealId, hubspotCompanyId } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });

  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const prep = {
    company,
    hubspot: null,
    companyInfo: null,
    contactInfo: null,
    recentActivity: null,
    aiSummary: null,
    linkedinUrl: null,
  };

  try {
    const headers = hubspotToken ? { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' } : null;

    // Parallel fetches
    const promises = [];

    // 1. HubSpot deal info
    if (headers && hubspotDealId) {
      promises.push(
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${hubspotDealId}?properties=dealname,dealstage,amount,closedate,hubspot_owner_id,description,notes_last_updated`, { headers })
          .then(r => r.json())
          .then(d => { prep.hubspot = d; })
          .catch(() => {})
      );
    }

    // 2. HubSpot company info
    if (headers && hubspotCompanyId) {
      promises.push(
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/companies/${hubspotCompanyId}?properties=name,domain,industry,numberofemployees,annualrevenue,description,city,state`, { headers })
          .then(r => r.json())
          .then(d => { prep.companyInfo = d; })
          .catch(() => {})
      );
    }

    // 3. HubSpot contact search
    if (headers && contactEmail) {
      promises.push(
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: contactEmail }] }],
            properties: ['firstname', 'lastname', 'jobtitle', 'company', 'linkedin_url', 'phone', 'hs_lead_status', 'notes_last_updated'],
          }),
        })
          .then(r => r.json())
          .then(d => {
            if (d.results?.length) {
              prep.contactInfo = d.results[0];
              if (d.results[0].properties?.linkedin_url) {
                prep.linkedinUrl = d.results[0].properties.linkedin_url;
              }
            }
          })
          .catch(() => {})
      );
    }

    // 4. HubSpot recent engagements
    if (headers && hubspotDealId) {
      promises.push(
        fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${hubspotDealId}/associations/notes`, { headers })
          .then(r => r.json())
          .then(async (assoc) => {
            if (assoc.results?.length) {
              const noteIds = assoc.results.slice(0, 5).map(r => r.id);
              const notes = await Promise.all(
                noteIds.map(id =>
                  fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${id}?properties=hs_note_body,hs_timestamp`, { headers })
                    .then(r => r.json())
                    .catch(() => null)
                )
              );
              prep.recentActivity = notes.filter(Boolean);
            }
          })
          .catch(() => {})
      );
    }

    await Promise.all(promises);

    // 5. Generate AI prep brief
    if (anthropicKey) {
      const context = [
        `Company: ${company}`,
        contactName ? `Contact: ${contactName}` : null,
        prep.hubspot?.properties ? `Deal Stage: ${prep.hubspot.properties.dealstage}, Value: ${prep.hubspot.properties.amount}` : null,
        prep.companyInfo?.properties ? `Industry: ${prep.companyInfo.properties.industry}, Size: ${prep.companyInfo.properties.numberofemployees} employees, Revenue: ${prep.companyInfo.properties.annualrevenue}` : null,
        prep.contactInfo?.properties ? `Title: ${prep.contactInfo.properties.jobtitle}` : null,
        prep.recentActivity?.length ? `Recent notes: ${prep.recentActivity.map(n => n.properties?.hs_note_body?.substring(0, 200)).join(' | ')}` : null,
      ].filter(Boolean).join('\n');

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          system: `You're prepping the CEO of Prescient AI (MMM/marketing analytics platform) for a meeting. Generate a concise prep brief with:

## Company Overview
Brief on what they do, size, relevant context

## Contact Background
Who they are, role, likely priorities

## Prescient Angle
Why Prescient is relevant to them, potential pain points we solve

## Talking Points
3-4 bullet points for the conversation

## Watch Out For
Any potential objections or sensitive topics

## Suggested Ask
What to push for as next step

Be concise and actionable. Use what data is available.`,
          messages: [{ role: 'user', content: `Prepare me for a meeting:\n${context}` }],
        }),
      });
      const aiData = await aiRes.json();
      prep.aiSummary = aiData.content?.[0]?.text || null;
    }

    return res.status(200).json({ success: true, prep });
  } catch (err) {
    console.error('Prep error:', err);
    return res.status(500).json({ error: 'Prep generation failed' });
  }
}
