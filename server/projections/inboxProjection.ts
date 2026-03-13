/**
 * Inbox Projection — Mirrors Superhuman "Important" inbox exactly.
 *
 * Superhuman's Important/Other split is powered entirely by Gmail's
 * `is:important` flag. There is no public Superhuman API.
 *
 * Rules:
 * - Query Gmail for `is:important` — that's it
 * - NO server-side noise filtering — if Gmail says important, show it
 * - Show read AND unread (Superhuman Important shows both)
 * - Group by date (Today, Yesterday, date)
 * - If Gmail fails, throws with source attribution
 */

import { getEvents } from '../event-log/eventStore.js';
import { getTool } from '../tools/registry.js';
import { IntegrationError } from './pipelineProjection.js';

export interface InboxThread {
  thread_id: string;
  subject: string;
  from: string;
  from_email: string;
  date: string;
  snippet: string;
  is_unread: boolean;
  is_draft: boolean;
  draft_to?: string;
  date_group: string;  // "Today", "Yesterday", "Mar 11"
  reply_needed: boolean;
  agent_status: 'none' | 'draft_created' | 'replied' | 'triaged';
}

export interface InboxView {
  threads: InboxThread[];
  total_count: number;
  total_unread: number;
  needs_reply: number;
  agent_drafted: number;
  generated_at: string;
  source: 'gmail';
  mode: 'important';
}

// My email domains (used to detect "last sender was me" = awaiting their reply)
const MY_DOMAINS = ['prescientai.com', 'prescient-ai.io', 'prescient.ai'];

// ── Main Projection Builder ──────────────────────────────────────────

export async function buildInboxProjection(query?: string): Promise<InboxView> {
  const searchTool = await getTool('gmail.search_threads');
  if (!searchTool) {
    throw new IntegrationError('gmail', 'Gmail tool not available — check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }

  // Superhuman Important = Gmail is:important. That's it.
  // No is:unread — Superhuman shows read AND unread in Important.
  const gmailQuery = query || 'is:important';

  const result = await searchTool.execute({
    query: gmailQuery,
    max_results: 30,
  }, {
    command_id: 'projection',
    execution_run_id: 'projection',
    plan_id: 'projection',
    step_id: 'projection',
    tool_call_id: 'projection',
  });

  if (!result.success) {
    throw new IntegrationError('gmail', result.error?.message || 'Gmail API call failed');
  }

  const rawThreads: any[] = result.outputs.threads || [];

  // Agent status enrichment from event log
  const recentEvents = await getEvents({ limit: 100 });
  const draftedThreads = new Set<string>();
  for (const evt of recentEvents) {
    if (evt.event_type === 'gmail.draft.created' && evt.payload?.thread_id) {
      draftedThreads.add(evt.payload.thread_id);
    }
  }

  const now = new Date();
  const threads: InboxThread[] = [];

  for (const t of rawThreads) {
    const fromParsed = parseFrom(t.from || '');
    const lastSenderIsMe = isMe(fromParsed.email);

    // Detect drafts (Superhuman shows "Draft to Name, ID")
    const isDraft = (t.labels || []).includes('DRAFT') || (t.subject || '').toLowerCase().startsWith('draft');

    let agentStatus: InboxThread['agent_status'] = 'none';
    if (draftedThreads.has(t.thread_id)) agentStatus = 'draft_created';

    const replyNeeded = !lastSenderIsMe && t.unread !== false && agentStatus === 'none';
    const dateGroup = getDateGroup(t.date, now);

    threads.push({
      thread_id: t.thread_id || t.id,
      subject: t.subject || '(no subject)',
      from: fromParsed.name,
      from_email: fromParsed.email,
      date: t.date || '',
      snippet: t.snippet || '',
      is_unread: t.unread !== false,
      is_draft: isDraft,
      draft_to: isDraft ? fromParsed.name : undefined,
      date_group: dateGroup,
      reply_needed: replyNeeded,
      agent_status: agentStatus,
    });
  }

  // Sort by date descending (newest first) — Superhuman default
  threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    threads,
    total_count: threads.length,
    total_unread: threads.filter(t => t.is_unread).length,
    needs_reply: threads.filter(t => t.reply_needed).length,
    agent_drafted: threads.filter(t => t.agent_status === 'draft_created').length,
    generated_at: new Date().toISOString(),
    source: 'gmail',
    mode: 'important',
  };
}

// ── Date Grouping ────────────────────────────────────────────────────

function getDateGroup(dateStr: string, now: Date): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const threadDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (threadDay.getTime() === today.getTime()) return 'Today';
  if (threadDay.getTime() === yesterday.getTime()) return 'Yesterday';

  // "Mar 11", "Mar 10", etc.
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseFrom(raw: string): { name: string; email: string } {
  const match = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].trim().replace(/^"/, '').replace(/"$/, ''), email: match[2] };
  if (raw.includes('@')) return { name: raw.split('@')[0], email: raw };
  return { name: raw, email: '' };
}

function isMe(email: string): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return MY_DOMAINS.some(d => lower.endsWith('@' + d)) || lower.includes('mike@');
}
