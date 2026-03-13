// Post-Call Pipeline API
// Takes Granola notes + recording link and generates everything:
// 1. Call summary + analysis
// 2. Proposal / order form
// 3. Draft follow-up email (with recording link)
// 4. CRM update (notes + stage suggestion)
//
// Can be called for individual steps or the full pipeline

const HUBSPOT_BASE = 'https://api.hubapi.com';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    step,              // 'analyze' | 'proposal' | 'email' | 'crm' | 'all'
    company,
    contactName,
    contactEmail,
    granolaNotes,
    granolaUrl,        // Link to Granola recording
    hubspotDealId,
    dealValue,
    callAnalysis,      // Pass previous analysis to avoid re-analyzing
  } = req.body || {};

  if (!company) return res.status(400).json({ error: 'company required' });

  // SAFETY: Batch execution disabled — each step must be called individually
  if (step === 'all') {
    return res.status(400).json({ error: 'Batch execution (step=all) is disabled. Use individual steps: analyze, proposal, email, crm.' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const dealDeskChannel = process.env.DEALDESK_CHANNEL_ID;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY required' });

  const result = {};

  try {
    // ── STEP 1: Analyze call notes ──
    let analysis = callAnalysis;
    if (!analysis && granolaNotes && (step === 'analyze' || step === 'all')) {
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
          system: `You are a sales ops analyst for Prescient AI (marketing mix modeling / MMM platform). Analyze call notes and return a JSON object:
{
  "summary": "2-3 sentence executive summary",
  "keyPoints": ["bullet 1", "bullet 2", ...],
  "nextSteps": ["action 1", "action 2", ...],
  "objections": ["any concerns raised"],
  "buySignals": ["positive indicators"],
  "suggestedDealStage": "Disco Complete|Demo Scheduled|Demo Completed|Negotiating|Committed",
  "dealValueEstimate": "dollar amount if discussed, or null",
  "sentiment": "positive|neutral|negative",
  "shouldCreateProposal": true/false,
  "shouldDraftEmail": true/false,
  "shouldUpdateCrm": true/false,
  "emailTone": "warm followup|technical deep-dive|proposal push|gentle nudge",
  "keyPeople": [{"name": "...", "role": "...", "email": "..."}]
}
Return ONLY valid JSON.`,
          messages: [{ role: 'user', content: `Company: ${company}\nContact: ${contactName || 'Unknown'}\nExisting Deal: ${hubspotDealId || 'None'}\n\nCall Notes:\n${granolaNotes}` }],
        }),
      });
      const aiData = await aiRes.json();
      try {
        analysis = JSON.parse((aiData.content?.[0]?.text || '{}').replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim());
      } catch {
        analysis = { summary: aiData.content?.[0]?.text || '', error: 'Could not parse' };
      }
      result.analysis = analysis;
    }

    if (step === 'analyze') return res.status(200).json({ success: true, ...result });

    // ── STEP 2: Generate proposal → post to Slack ──
    if (step === 'proposal' || step === 'all') {
      const proposalPrompt = `Generate a Prescient AI order form for ${company}.
Contact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})
Deal Value: ${analysis?.dealValueEstimate || dealValue || 'TBD'}
HubSpot Deal: ${hubspotDealId || 'N/A'}
Call Summary: ${analysis?.summary || 'N/A'}
Key Points: ${(analysis?.keyPoints || []).join('; ')}
Next Steps: ${(analysis?.nextSteps || []).join('; ')}

Use this exact format:
ORDER FORM — PRESCIENT AI
═══════════════════════════════
Customer: [Company]
Contact: [Name] ([Email])
HubSpot Deal: [ID]
───────────────────────────────
SUBSCRIPTION DETAILS
  Product: Prescient AI Platform
  Term: 12 months
  Start Date: [suggest based on context]
  Annual Contract Value: [Amount]
───────────────────────────────
CALL CONTEXT
  [2-3 bullet summary from call]
───────────────────────────────
NEXT STEPS
  [Action items from call]
───────────────────────────────
STATUS: Pending Review
Submitted by: Mike True
Date: ${new Date().toISOString().split('T')[0]}`;

      const proposalRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: proposalPrompt }],
        }),
      });
      const proposalData = await proposalRes.json();
      const orderForm = proposalData.content?.[0]?.text || '';
      result.proposal = { orderForm };

      // Post to Slack #commercial-dealdesk-agent
      if (slackToken && dealDeskChannel) {
        const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: dealDeskChannel,
            text: `New order form: *${company}*`,
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: `Order Form: ${company}` } },
              { type: 'section', text: { type: 'mrkdwn', text: '```' + orderForm + '```' } },
              ...(granolaUrl ? [{ type: 'section', text: { type: 'mrkdwn', text: `📹 <${granolaUrl}|Call Recording>` } }] : []),
              {
                type: 'actions',
                elements: [
                  { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_order' },
                  { type: 'button', text: { type: 'plain_text', text: 'Request Changes' }, action_id: 'request_changes' },
                ],
              },
            ],
          }),
        });
        const slackData = await slackRes.json();
        result.proposal.slackPosted = slackData.ok;
        result.proposal.slackTs = slackData.ts;
      }
    }

    if (step === 'proposal') return res.status(200).json({ success: true, ...result });

    // ── STEP 3: Draft follow-up email (with recording link) ──
    if (step === 'email' || step === 'all') {
      const emailPrompt = `Draft a follow-up email from Mike True (CEO, Prescient AI) to ${contactName || 'the team'} at ${company}.
Email: ${contactEmail || 'TBD'}

Call Summary: ${analysis?.summary || 'We just had a productive call.'}
Key Points Discussed: ${(analysis?.keyPoints || []).join('; ')}
Next Steps: ${(analysis?.nextSteps || []).join('; ')}
Tone: ${analysis?.emailTone || 'warm followup'}
${granolaUrl ? `Include this meeting recording link: ${granolaUrl}` : ''}

CC Brian (brian@prescientai.com) on the email.

Write in a professional but warm CEO tone. Reference specific points from the call. Include clear next steps. Keep it concise.
Return ONLY the email body in HTML format using <p> tags. Do not include subject line.`;

      const emailRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: emailPrompt }],
        }),
      });
      const emailData = await emailRes.json();
      const emailBody = emailData.content?.[0]?.text || '';
      const emailTo = contactEmail || '';
      const emailSubject = `${company} — Follow Up`;
      result.email = {
        body: emailBody,
        to: emailTo,
        cc: 'brian@prescientai.com',
        subject: emailSubject,
        granolaUrl,
      };

      // Actually create Gmail draft (not just return the text)
      const gClientId = process.env.GOOGLE_CLIENT_ID;
      const gClientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const gRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
      if (gClientId && gClientSecret && gRefreshToken && emailTo) {
        try {
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: gClientId, client_secret: gClientSecret,
              refresh_token: gRefreshToken, grant_type: 'refresh_token',
            }),
          });
          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            const rawEmail = [
              `To: ${emailTo}`,
              `Cc: brian@prescientai.com`,
              `Subject: ${emailSubject}`,
              `Content-Type: text/html; charset=utf-8`,
              '',
              emailBody,
            ].join('\r\n');
            const encoded = Buffer.from(rawEmail).toString('base64url');
            const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
              method: 'POST',
              headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: { raw: encoded } }),
            });
            const draftData = await draftRes.json();
            if (draftData.id) {
              result.email.draftId = draftData.id;
              result.email.draftCreated = true;
              console.log(`[post-call] Gmail draft created: ${draftData.id} for ${company}`);
            }
          }
        } catch (draftErr) {
          console.error('[post-call] Gmail draft creation failed:', draftErr.message || draftErr);
          // Non-fatal — email body is still returned for manual use
        }
      }
    }

    if (step === 'email') return res.status(200).json({ success: true, ...result });

    // ── STEP 4: Update HubSpot CRM ──
    if ((step === 'crm' || step === 'all') && hubspotToken) {
      const noteBody = [
        `**Call Summary** — ${new Date().toISOString().split('T')[0]}`,
        analysis?.summary || '',
        '',
        '**Key Points:**',
        ...(analysis?.keyPoints || []).map(p => `• ${p}`),
        '',
        '**Next Steps:**',
        ...(analysis?.nextSteps || []).map(p => `• ${p}`),
        '',
        analysis?.objections?.length ? `**Objections:** ${analysis.objections.join('; ')}` : '',
        analysis?.buySignals?.length ? `**Buy Signals:** ${analysis.buySignals.join('; ')}` : '',
        granolaUrl ? `\n📹 Recording: ${granolaUrl}` : '',
      ].filter(Boolean).join('\n');

      const headers = { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' };

      // Create note
      const noteRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          properties: { hs_timestamp: new Date().toISOString(), hs_note_body: noteBody },
        }),
      });
      const noteData = await noteRes.json();
      result.crm = { noteCreated: !!noteData.id, noteId: noteData.id };

      // Associate with deal
      if (hubspotDealId && noteData.id) {
        await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes/${noteData.id}/associations/deals/${hubspotDealId}/note_to_deal`, {
          method: 'PUT', headers,
        }).catch(() => {});
        result.crm.associatedToDeal = true;
      }

      // Suggest stage update
      result.crm.suggestedStage = analysis?.suggestedDealStage || null;
    }

    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('Post-call pipeline error:', err);
    return res.status(500).json({ error: 'Pipeline failed: ' + err.message });
  }
}
