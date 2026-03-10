// Proposal / Order Form Generator
// Generates order form and posts to Slack #commercial-dealdesk-agent
// When pricing data is provided, uses calculated pricing instead of AI estimation

import {
  normalizeChannel,
  calculatePricing,
  checkApprovalRules,
  formatPricingSummary,
  DISCOUNT_TYPES,
  PAYMENT_TERMS,
  APPROVAL_STATUSES,
} from './lib/pricing.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { company, contactName, contactEmail, dealValue, term, startDate, notes, products, hubspotDealId, pricing: pricingInput } = req.body || {};
  if (!company) return res.status(400).json({ error: 'company required' });

  const slackToken = process.env.SLACK_BOT_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const dealDeskChannel = process.env.DEALDESK_CHANNEL_ID; // #commercial-dealdesk-agent

  try {
    // If pricing input provided, calculate real pricing
    let pricingResult = null;
    let approvalResult = null;
    let pricingSummary = null;

    if (pricingInput && pricingInput.ltmMediaSpend && pricingInput.enabledChannels) {
      const normalizedChannels = (pricingInput.enabledChannels || [])
        .map(ch => normalizeChannel(ch))
        .filter(Boolean);

      const input = {
        brandName: pricingInput.brandName || company,
        ltmMediaSpend: pricingInput.ltmMediaSpend,
        enabledChannels: normalizedChannels,
        numberOfRetailChannels: pricingInput.numberOfRetailChannels || 1,
        retailerNames: pricingInput.retailerNames || null,
        dtcGmv: pricingInput.dtcGmv || null,
        amazonGmv: pricingInput.amazonGmv || null,
        retailGmv: pricingInput.retailGmv || null,
        tiktokGmv: pricingInput.tiktokGmv || null,
        requestedDiscountPercent: pricingInput.requestedDiscountPercent || null,
        discountType: pricingInput.discountType || DISCOUNT_TYPES.NONE,
        paymentTerms: pricingInput.paymentTerms || PAYMENT_TERMS.SEMI_ANNUAL_NET_7,
        termMonths: pricingInput.termMonths || 12,
        optOutMonths: pricingInput.optOutMonths != null ? pricingInput.optOutMonths : 6,
        customBaseFeeMonthly: pricingInput.customBaseFeeMonthly || null,
        variableRateMultiplier: pricingInput.variableRateMultiplier || null,
        additionalDiscountAmount: pricingInput.additionalDiscountAmount || null,
        excludedOrNonManagedSpend: pricingInput.excludedOrNonManagedSpend || null,
      };

      pricingResult = calculatePricing(input);
      approvalResult = checkApprovalRules(input, pricingResult);
      pricingSummary = formatPricingSummary(input, pricingResult, approvalResult);
    }

    // Generate order form with AI
    let orderForm = '';
    if (anthropicKey) {
      // Build system prompt — use calculated pricing when available
      let systemPrompt;
      let userContent;

      if (pricingResult) {
        systemPrompt = `You generate SaaS order forms for Prescient AI. IMPORTANT: Use the EXACT pricing numbers provided in the calculated pricing below. Do NOT calculate or estimate pricing yourself.

Use this exact format:

ORDER FORM — PRESCIENT AI
═══════════════════════════════
Customer: [Company Name]
Contact: [Name] ([Email])
HubSpot Deal: [ID or N/A]
───────────────────────────────
SUBSCRIPTION DETAILS
  Product: Prescient AI Platform
  Enabled Models: [List channels]
  Term: [Term months] months
  Payment Terms: [Payment terms]
  Start Date: [Date]
───────────────────────────────
PRICING (V3 Model)
  Model Fees: $[baseFeeMonthly]/mo ($[baseFeeAnnual]/yr)
${pricingResult.baseFeeBreakdown.map(b => `    ${b.channel}${b.gmvTier ? ` (${b.gmvTier})` : ''}: $${b.discountedMonthlyFee != null ? b.discountedMonthlyFee.toLocaleString() : b.monthlyFee.toLocaleString()}/mo`).join('\n')}
  Media Fee: $[variableFeeMonthly]/mo ($[variableFeeAnnual]/yr)
    Rate: ${pricingResult.tierBreakdown[0] ? (pricingResult.tierBreakdown[0].rate * 100).toFixed(2) : '0.50'}% of LTM Media Spend
  ───────────────────────────────
  Total Monthly: $${pricingResult.totalMonthly.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
  Total Annual: $${pricingResult.totalAnnual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
  Effective Rate: ${pricingResult.effectiveRatePercent.toFixed(3)}% of LTM Spend
${pricingResult.discountPercent ? `  Discount: ${pricingResult.discountPercent}% (-$${pricingResult.discountAmount.toLocaleString()})` : ''}
───────────────────────────────
NOTES
  [Any special terms, discounts, notes from user]
───────────────────────────────
STATUS: ${approvalResult.requiresDealdeskApproval ? 'Requires Deal Desk Approval' : 'Pending Review'}
Submitted by: Mike True
Date: ${new Date().toISOString().split('T')[0]}

Use the exact numbers from the pricing calculation. Fill in all fields.`;

        userContent = `Generate order form for:
Company: ${company}
Contact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})
LTM Media Spend: $${pricingResult.ltmMediaSpend.toLocaleString()}
Total Annual Investment: $${pricingResult.totalAnnual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Term: ${pricingResult.termMonths} months
Payment Terms: ${pricingResult.paymentTerms}
Start Date: ${startDate || 'TBD'}
HubSpot Deal ID: ${hubspotDealId || 'N/A'}
Notes: ${notes || 'None'}`;
      } else {
        // Original behavior — no calculated pricing
        systemPrompt = `You generate SaaS order forms for Prescient AI. Use this exact format:

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

Be precise with numbers. If deal value is provided, use it. If not, estimate based on context.`;

        userContent = `Generate order form for:\nCompany: ${company}\nContact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})\nDeal Value: ${dealValue || 'TBD'}\nTerm: ${term || '12 months'}\nStart Date: ${startDate || 'TBD'}\nProducts: ${products || 'Prescient AI Platform'}\nHubSpot Deal ID: ${hubspotDealId || 'N/A'}\nNotes: ${notes || 'None'}`;
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
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      const aiData = await aiRes.json();
      orderForm = aiData.content?.[0]?.text || '';
    } else {
      // Fallback: generate without AI
      if (pricingResult) {
        orderForm = [
          `ORDER FORM — PRESCIENT AI`,
          `═══════════════════════════════`,
          `Customer: ${company}`,
          `Contact: ${contactName || 'TBD'} (${contactEmail || 'TBD'})`,
          `HubSpot Deal: ${hubspotDealId || 'N/A'}`,
          `───────────────────────────────`,
          `SUBSCRIPTION DETAILS`,
          `  Product: Prescient AI Platform`,
          `  Enabled Models: ${pricingResult.baseFeeBreakdown.map(b => b.channel).join(', ')}`,
          `  Term: ${pricingResult.termMonths} months`,
          `  Payment Terms: ${pricingResult.paymentTerms}`,
          `  Start Date: ${startDate || 'TBD'}`,
          `───────────────────────────────`,
          `PRICING`,
          `  Model Fees: $${pricingResult.baseFeeMonthly.toLocaleString()}/mo ($${pricingResult.baseFeeAnnual.toLocaleString()}/yr)`,
          `  Media Fee: $${pricingResult.variableFeeMonthly.toLocaleString()}/mo ($${pricingResult.variableFeeAnnual.toLocaleString()}/yr)`,
          `  Total Monthly: $${pricingResult.totalMonthly.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          `  Total Annual: $${pricingResult.totalAnnual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          `  Effective Rate: ${pricingResult.effectiveRatePercent.toFixed(3)}%`,
          `───────────────────────────────`,
          `STATUS: ${approvalResult?.requiresDealdeskApproval ? 'Requires Deal Desk Approval' : 'Pending Review'}`,
          `Submitted by: Mike True`,
          `Date: ${new Date().toISOString().split('T')[0]}`,
        ].join('\n');
      } else {
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
    }

    // Build Slack blocks
    const slackBlocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Order Form: ${company}`, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '```' + orderForm + '```' },
      },
    ];

    // Add approval warning if deal desk review needed
    if (approvalResult?.requiresDealdeskApproval) {
      const dealdeskReasons = approvalResult.reasons
        .filter(r => r.severity === 'dealdesk')
        .map(r => `- ${r.message}`)
        .join('\n');
      slackBlocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Deal Desk Review Required:*\n${dealdeskReasons}` },
      });
    }

    slackBlocks.push({
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_order' },
        { type: 'button', text: { type: 'plain_text', text: 'Request Changes' }, action_id: 'request_changes' },
      ],
    });

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
          blocks: slackBlocks,
        }),
      });
      slackResult = await slackRes.json();
    }

    return res.status(200).json({
      success: true,
      orderForm,
      pricing: pricingResult || null,
      approval: approvalResult || null,
      pricingSummary: pricingSummary || null,
      slack: slackResult ? { posted: slackResult.ok, channel: dealDeskChannel, ts: slackResult.ts } : { posted: false, reason: 'Slack not configured' },
    });
  } catch (err) {
    console.error('Proposal error:', err);
    return res.status(500).json({ error: 'Failed to generate proposal' });
  }
}
