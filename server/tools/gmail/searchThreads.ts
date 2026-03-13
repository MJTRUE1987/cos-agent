/**
 * gmail.search_threads — Search email threads.
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

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
  if (!data.access_token) throw new Error('Gmail auth failed');
  return data.access_token;
}

export const gmailSearchThreads: ToolAdapter = {
  contract: {
    name: 'gmail.search_threads',
    version: 1,
    description: 'Search email threads by Gmail query syntax',
    category: 'email',
    source_system: 'gmail',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'read_only' },
    side_effects: [],
    retry: { max_retries: 3, backoff: 'exponential', base_delay_ms: 1000, retryable_errors: ['429', '503'] },
    timeout_ms: 15000,
  },

  async execute(inputs: { query: string; max_results?: number; after?: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();

    try {
      const token = await getGmailToken();
      const headers = { Authorization: `Bearer ${token}` };
      const maxResults = inputs.max_results || 20;

      let query = inputs.query;
      if (inputs.after) query += ` after:${inputs.after}`;

      const listR = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
        { headers }
      );
      if (!listR.ok) {
        const err = await listR.text();
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: String(listR.status), message: err, retryable: listR.status === 429 },
        };
      }

      const listData = await listR.json();
      const messages = listData.messages || [];

      // Fetch metadata for each message
      const details = await Promise.all(
        messages.slice(0, maxResults).map((m: any) =>
          fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers }
          ).then(r => r.json()).catch(() => null)
        )
      );

      const threads = details.filter(Boolean).map((msg: any) => {
        const getHeader = (name: string) => (msg.payload?.headers || []).find((h: any) => h.name === name)?.value || '';
        return {
          thread_id: msg.threadId,
          message_id: msg.id,
          subject: getHeader('Subject'),
          from: getHeader('From'),
          to: getHeader('To'),
          date: getHeader('Date'),
          snippet: msg.snippet || '',
          last_message_at: getHeader('Date'),
          last_message_from: getHeader('From'),
        };
      });

      // Dedupe by thread_id
      const seen = new Set<string>();
      const uniqueThreads = threads.filter((t: any) => {
        if (seen.has(t.thread_id)) return false;
        seen.add(t.thread_id);
        return true;
      });

      return {
        success: true,
        outputs: { threads: uniqueThreads },
        events: [],
        side_effects_performed: [],
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
