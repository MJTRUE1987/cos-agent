// Proposal / Order Form Generator
// Generates order form and posts to Slack #commercial-dealdesk-agent

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contactName, contactEmail, dealValue, term, startDate, notes, products, hubspotDealId } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const dealDeskChannel = process.env.DEALDESK_CHANNEL_ID; // #commercial-dealdesk-agent

  try {
    // Generate order form with AI
    let orderForm = '';
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
          max_tokens: 2048,
          system: `You generate SaaS order forms for Prescient AI. Use this exact format:

ORDER FORM — PRESCIENT AI
═══════════════════════════════
Customer: [Company Name]
Contact: [Name] ([Email])
HubSpot Deal: [ID or N/A]
───────────────────────────────
SUBSCRIPTION DETAILS
  Product: Prescient AI Platform
  Plan: [Based on deal value]
  Term: [12 months default]
  Start Date: [Date]
  Annual Contract Value: [Amount]
───────────────────────────────
PRICING
  Platform License: [Amount]/yr
  Onboarding Fee: [if applicable]
  Total Year 1: [Amount]
───────────────────────────────
NOTES
  [Any special terms, discounts, pilot details]
───────────────────────────────
STATUS: Pending Review
Submitted by: Mike True
Date: ${new Date().toISOString().split('T')[0]}

Be precise with numbers. If deal value is provided, use it. If not, estimate based on context.`,
          messages: [{ role: 'user', content: `Generate order form for:\nCompany: ${company}\nContact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})\nDeal Value: ${dealValue || 'TBD'}\nTerm: ${term || '12 months'}\nStart Date: ${startDate || 'TBD'}\nProducts: ${products || 'Prescient AI Platform'}\nHubSpot Deal ID: ${hubspotDealId || 'N/A'}\nNotes: ${notes || 'None'}` }],
        }),
      });
      const aiData = await aiRes.json();
      orderForm = aiData.content?.[0]?.text || '';
    } else {
      // Fallback: generate without AI
      orderForm = [
        `ORDER FORM — PRESCIENT AI`,
        `═══════════════════════════════`,
        `Customer: ${company}`,
        `Contact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})`,
        `HubSpot Deal: ${hubspotDealId || 'N/A'}`,
        `───────────────────────────────`,
        `SUBSCRIPTION DETAILS`,
        `  Product: ${products || 'Prescient AI Platform'}`,
        `  Term: ${term || '12 months'}`,
        `  Start Date: ${startDate || 'TBD'}`,
        `  Annual Contract Value: ${dealValue || 'TBD'}`,
        `───────────────────────────────`,
        `STATUS: Pending Review`,
        `Submitted by: Mike True`,
        `Date: ${new Date().toISOString().split('T')[0]}`,
      ].join('\n');
    }

    // Post to Slack if configured
    let slackResult = null;
    if (slackToken && dealDeskChannel) {
      const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${slackToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: dealDeskChannel,
          text: `New order form submitted for *${company}*`,
          blocks: [
            {
              type: 'header',
              text: { type: 'plain_text', text: `Order Form: ${company}`, emoji: true },
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '```' + orderForm + '```' },
            },
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
      slackResult = await slackRes.json();
    }

    return res.status(200).json({
      success: true,
      orderForm,
      slack: slackResult ? { posted: slackResult.ok, channel: dealDeskChannel, ts: slackResult.ts } : { posted: false, reason: 'Slack not configured' },
    });
  } catch (err) {
    console.error('Proposal error:', err);
    return res.status(500).json({ error: 'Failed to generate proposal' });
  }
}
