/**
 * slack.send_message — Post message to Slack channel or DM.
 * Wraps: api/slack.js (POST)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { buildIdempotencyKey } from '../types.js';

export const slackSendMessage: ToolAdapter = {
  contract: {
    name: 'slack.send_message',
    version: 1,
    description: 'Post a message to a Slack channel or DM',
    category: 'messaging',
    source_system: 'slack',
    risk_level: 'medium',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'slack:{target}:{text_hash}:{date}', ttl_seconds: 86400 },
    side_effects: ['Posts visible Slack message'],
    retry: { max_retries: 2, backoff: 'fixed', base_delay_ms: 3000, retryable_errors: ['503', 'rate_limited'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { target: string; text: string; blocks?: any[]; thread_ts?: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'NO_TOKEN', message: 'SLACK_BOT_TOKEN not configured', retryable: false },
      };
    }

    const botHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
      let channelId = inputs.target;
      let isDm = false;

      // Open DM if target is user ID
      if (inputs.target.startsWith('U')) {
        isDm = true;
        const userToken = process.env.SLACK_USER_TOKEN;
        const openHeaders = userToken
          ? { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' }
          : botHeaders;
        const openR = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST', headers: openHeaders,
          body: JSON.stringify({ users: inputs.target }),
        });
        const openData = await openR.json();
        if (!openData.ok) throw new Error(`DM open failed: ${openData.error}`);
        channelId = openData.channel.id;
      }

      const payload: any = { channel: channelId, text: inputs.text };
      if (inputs.blocks) payload.blocks = inputs.blocks;
      if (inputs.thread_ts) payload.thread_ts = inputs.thread_ts;

      const sendHeaders = (isDm && process.env.SLACK_USER_TOKEN)
        ? { Authorization: `Bearer ${process.env.SLACK_USER_TOKEN}`, 'Content-Type': 'application/json' }
        : botHeaders;

      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST', headers: sendHeaders,
        body: JSON.stringify(payload),
      });
      const data = await r.json();

      if (!data.ok) {
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: 'SLACK_ERROR', message: data.error, retryable: data.error === 'rate_limited' },
        };
      }

      return {
        success: true,
        outputs: { message_ts: data.ts, channel_id: data.channel },
        events: [{
          event_type: 'slack.message.sent',
          source: 'slack',
          entity_type: 'channel',
          entity_id: data.channel,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { channel: data.channel, text_preview: inputs.text.slice(0, 100) },
          metadata: {
            version: 1, environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id, execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id, step_id: ctx.step_id, tool_call_id: ctx.tool_call_id,
          },
        }],
        side_effects_performed: [`Posted message to ${channelId}`],
        idempotency_key: buildIdempotencyKey(this.contract.idempotency.key_template!, inputs),
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'SLACK_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
