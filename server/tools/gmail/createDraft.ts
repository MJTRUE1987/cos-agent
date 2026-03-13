/**
 * gmail.create_draft — Create email draft in Gmail.
 * Wraps: api/draft-email.js
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { buildIdempotencyKey } from '../types.js';

async function getGmailToken(): Promise<string> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`Gmail auth failed: ${data.error || 'unknown'}`);
  return data.access_token;
}

export const gmailCreateDraft: ToolAdapter = {
  contract: {
    name: 'gmail.create_draft',
    version: 1,
    description: 'Create email draft in Gmail',
    category: 'email',
    source_system: 'gmail',
    risk_level: 'low',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'gmail:draft:{thread_id}:{body_hash}:{date}', ttl_seconds: 86400 },
    side_effects: ['Creates draft in Gmail (not sent)'],
    retry: { max_retries: 2, backoff: 'exponential', base_delay_ms: 2000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { to: string | string[]; cc?: string; subject: string; body: string; thread_id?: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();

    try {
      const token = await getGmailToken();
      const toStr = Array.isArray(inputs.to) ? inputs.to.join(', ') : inputs.to;

      // Build RFC 2822 email
      const headerLines = [
        `To: ${toStr}`,
        inputs.cc ? `Cc: ${inputs.cc}` : null,
        `Subject: ${inputs.subject || '(no subject)'}`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
      ].filter(Boolean).join('\r\n');

      const rawMessage = `${headerLines}\r\n\r\n${inputs.body}`;
      const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const draftBody: any = { message: { raw: encodedMessage } };
      if (inputs.thread_id) draftBody.message.threadId = inputs.thread_id;

      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
      });

      if (!r.ok) {
        const err = await r.text();
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: String(r.status), message: err, retryable: r.status === 429 || r.status >= 500 },
        };
      }

      const draft = await r.json();

      return {
        success: true,
        outputs: {
          draft_id: draft.id,
          message_id: draft.message?.id,
          thread_id: draft.message?.threadId,
          url: `https://mail.google.com/mail/u/0/#drafts/${draft.message?.id}`,
        },
        events: [{
          event_type: 'gmail.draft.created',
          source: 'gmail',
          entity_type: 'thread',
          entity_id: draft.message?.threadId || draft.id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { draft_id: draft.id, to: toStr, subject: inputs.subject },
          metadata: {
            version: 1,
            environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id,
            execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id,
            step_id: ctx.step_id,
            tool_call_id: ctx.tool_call_id,
          },
        }],
        side_effects_performed: [`Created Gmail draft to ${toStr}`],
        idempotency_key: buildIdempotencyKey(this.contract.idempotency.key_template!, inputs),
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'GMAIL_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
