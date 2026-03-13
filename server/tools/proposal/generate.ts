/**
 * proposal.generate — Generate a proposal document and post to deal desk.
 * Wraps: api/proposal.js
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { generateId } from '../../event-log/eventStore.js';

export const proposalGenerate: ToolAdapter = {
  contract: {
    name: 'proposal.generate',
    version: 1,
    description: 'Generate a proposal document for a deal',
    category: 'proposal',
    source_system: 'internal',
    risk_level: 'low',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'proposal:{deal_id}:{pricing_hash}', ttl_seconds: 3600 },
    side_effects: ['Creates proposal artifact'],
    retry: { max_retries: 2, backoff: 'fixed', base_delay_ms: 3000, retryable_errors: ['ETIMEDOUT'] },
    timeout_ms: 30000,
  },

  async execute(inputs: {
    deal_id: string;
    company: string;
    contact_name?: string;
    contact_email?: string;
    pricing_summary?: string;
    deal_value?: string;
    meeting_analysis?: any;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;

    try {
      const proposalId = generateId('prop');
      let content = '';

      if (apiKey) {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: `You generate SaaS order forms for Prescient AI. Use a clean, professional format with clear sections for: Customer Info, Subscription Details, Pricing, Notes, and Status. Be precise with numbers. If pricing details are provided, use them exactly. Today's date: ${new Date().toISOString().split('T')[0]}`,
            messages: [{
              role: 'user',
              content: [
                `Generate order form for:`,
                `Company: ${inputs.company}`,
                `Contact: ${inputs.contact_name || 'TBD'} (${inputs.contact_email || 'TBD'})`,
                `Deal Value: ${inputs.deal_value || 'TBD'}`,
                `HubSpot Deal ID: ${inputs.deal_id || 'N/A'}`,
                inputs.pricing_summary ? `\nPricing Details:\n${inputs.pricing_summary}` : '',
                inputs.meeting_analysis ? `\nCall Analysis:\n${JSON.stringify(inputs.meeting_analysis, null, 2)}` : '',
              ].filter(Boolean).join('\n'),
            }],
          }),
        });
        const aiData = await aiRes.json();
        content = aiData.content?.[0]?.text || '';
      } else {
        content = [
          `ORDER FORM — PRESCIENT AI`,
          `═══════════════════════════════`,
          `Customer: ${inputs.company}`,
          `Contact: ${inputs.contact_name || 'TBD'} (${inputs.contact_email || 'TBD'})`,
          `HubSpot Deal: ${inputs.deal_id || 'N/A'}`,
          `───────────────────────────────`,
          `Deal Value: ${inputs.deal_value || 'TBD'}`,
          `───────────────────────────────`,
          `STATUS: Pending Review`,
          `Date: ${new Date().toISOString().split('T')[0]}`,
        ].join('\n');
      }

      // Post to Slack deal desk channel if configured
      let slackResult: any = null;
      const slackToken = process.env.SLACK_BOT_TOKEN;
      const dealDeskChannel = process.env.DEALDESK_CHANNEL_ID;

      if (slackToken && dealDeskChannel) {
        const slackR = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: dealDeskChannel,
            text: `New order form submitted for *${inputs.company}*`,
            blocks: [
              { type: 'header', text: { type: 'plain_text', text: `Order Form: ${inputs.company}` } },
              { type: 'section', text: { type: 'mrkdwn', text: '```' + content.slice(0, 2900) + '```' } },
              { type: 'actions', elements: [
                { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve_order' },
                { type: 'button', text: { type: 'plain_text', text: 'Request Changes' }, action_id: 'request_changes' },
              ]},
            ],
          }),
        });
        slackResult = await slackR.json();
      }

      return {
        success: true,
        outputs: {
          proposal_id: proposalId,
          content,
          content_type: 'markdown',
          version: 1,
          slack: slackResult ? { posted: slackResult.ok, channel: dealDeskChannel } : { posted: false },
        },
        events: [{
          event_type: 'proposal.created',
          source: 'agent',
          entity_type: 'deal',
          entity_id: inputs.deal_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { proposal_id: proposalId, company: inputs.company, deal_id: inputs.deal_id },
          metadata: {
            version: 1, environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id, execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id, step_id: ctx.step_id, tool_call_id: ctx.tool_call_id,
          },
        }],
        side_effects_performed: [
          'Generated proposal',
          slackResult?.ok ? `Posted to #deal-desk (${dealDeskChannel})` : '',
        ].filter(Boolean),
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'PROPOSAL_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
