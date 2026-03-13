/**
 * Inbox Projection — Builds an "Important Inbox" from real Gmail data.
 *
 * Emulates Superhuman Important behavior using Gmail Important + Primary.
 *
 * Rules:
 * - Real Gmail threads only — no fallbacks, no demo data
 * - Strict noise suppression: billing, DocuSign, newsletters, alerts,
 *   receipts, system messages, noreply senders, event invites — all excluded
 * - Only surfaces real human business conversations
 * - Bias toward under-including rather than over-including
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
  priority: 'high' | 'medium' | 'low';
  priority_reason?: string;
  reply_needed: boolean;
  agent_status: 'none' | 'draft_created' | 'replied' | 'triaged';
  classification: 'important_human' | 'transactional' | 'promotional' | 'system' | 'calendar_notification' | 'low_signal_noise';
  why_it_matters?: string;
}

export interface InboxView {
  threads: InboxThread[];
  total_unread: number;
  needs_reply: number;
  agent_drafted: number;
  total_filtered_out: number;
  generated_at: string;
  source: 'gmail';
  mode: 'important' | 'all';
}

// ── Gmail Query Filters ──────────────────────────────────────────────
// Superhuman-style "Important" inbox: Primary + Important, strict exclusions

const IMPORTANT_INBOX_QUERY = [
  // Base: important or primary category only
  '(category:primary OR is:important)',
  // Exclude promotional/social/updates/forums categories
  '-category:promotions',
  '-category:social',
  '-category:updates',
  '-category:forums',
  // Exclude automated/noreply senders
  '-from:noreply',
  '-from:no-reply',
  '-from:do-not-reply',
  '-from:donotreply',
  '-from:notifications@',
  '-from:notification@',
  '-from:mailer-daemon',
  '-from:calendar-notification',
  '-from:reply@',
  // Exclude known noise senders
  '-from:billing@',
  '-from:invoices@',
  '-from:receipts@',
  '-from:support@hubspot.com',
  '-from:@docusign.net',
  '-from:dse@docusign.net',
  '-from:@vercel.com',
  '-from:@statuspage.io',
  '-from:calendar-server@google.com',
  // Known noise senders from production
  '-from:@brex.com',
  '-from:@justworks.com',
  '-from:@vitally.io',
  '-from:@goingvc.com',
  '-from:@gusto.com',
  '-from:@rippling.com',
  '-from:@stripe.com',
  '-from:@intercom.io',
  '-from:@linear.app',
  '-from:@substack.com',
  // Exclude labels
  '-label:promotions',
  '-label:social',
].join(' ');

// ── Sender Noise Lists ────────────────────────────────────────────
// Post-query server-side filtering for things Gmail query can't catch

const NOISE_SENDER_PATTERNS = [
  // Automated / system senders
  'noreply', 'no-reply', 'do-not-reply', 'donotreply',
  'notifications@', 'notification@', 'alerts@', 'alert@',
  'mailer-daemon', 'postmaster@',
  'calendar-notification', 'calendar-server',
  // Billing / transactional
  'billing@', 'invoices@', 'invoice@', 'receipts@', 'receipt@',
  'payments@', 'payment@', 'accounts@', 'accounting@',
  'support@',
  // DocuSign
  'docusign.net', 'dse@docusign', 'docusign.com',
  // Specific SaaS/billing senders seen in production
  '@brex.com', 'brex.com',
  '@justworks.com', 'justworks.com',
  '@vitally.io', 'vitally.io',
  '@goingvc.com', 'goingvc.com',
  '@gusto.com', 'gusto.com',
  '@rippling.com', 'rippling.com',
  '@expensify.com',
  '@bill.com',
  '@ramp.com',
  // Product / marketing
  '@vercel.com', 'vercel.email',
  '@hubspot.com',
  '@intercom.io', 'intercom-mail',
  '@notion.so',
  '@linear.app',
  '@slack.com',
  '@figma.com',
  '@stripe.com',
  '@sendgrid.net',
  '@mailchimp.com', '@mail.mailchimp.com',
  '@createsend.com',
  '@substack.com',
  '@beehiiv.com',
  '@convertkit.com',
  'marketing@', 'newsletter@', 'news@', 'updates@', 'digest@',
  'hello@',  // often marketing
  'team@',   // often product updates
  'info@',   // often automated
  // Event platforms
  'invites.', '.eventbrite.', 'clubexpress',
  'calendly.com', 'calend.ly',
  'zoom.us', '@zoom.us',
  '@luma.com', '@lu.ma',
  // Status pages
  '-status.com', 'statuspage',
  // Social media notifications
  '@facebookmail.com', '@linkedin.com', '@twitter.com', '@x.com',
];

const NOISE_SUBJECT_PATTERNS = [
  // Newsletters / digests
  'newsletter', 'digest', 'weekly update', 'weekly recap', 'monthly update',
  'daily digest', 'weekly digest', 'your weekly', 'your monthly',
  'weekly roundup', 'weekly summary', 'daily summary',
  'what you need to know',
  // Billing / receipts / financial
  'invoice', 'receipt', 'payment confirmed', 'payment received',
  'billing statement', 'subscription renewed', 'subscription confirmation',
  'your bill', 'payment due', 'amount due', 'billing notice',
  'payment reminder', 'upcoming charge',
  'card bill', 'credit memo', 'credit card statement',
  'contacts tier', 'contact tier', 'plan limit', 'usage limit',
  'been upgraded to the next', 'upgraded to the next',
  // HR / internal ops
  'requested time off', 'time off request', 'pto request', 'out of office',
  // DocuSign
  'docusign', 'please sign', 'completed: please review',
  'viewed complete with docusign',
  // Product announcements
  'product update', 'new feature', 'feature update', 'release notes',
  'what\'s new', 'whats new', 'changelog', 'just shipped',
  'welcome to', 'getting started with',
  'resources to kickstart',
  // Event/calendar
  'invitation:', 'accepted:', 'declined:', 'tentative:',
  'rsvp', 'event reminder',
  // System notifications
  'security alert', 'sign-in attempt', 'password reset',
  'verify your email', 'confirm your email', 'activate your account',
  // Unsubscribe indicators (strong newsletter signal)
  'unsubscribe',
];

// My email domains (used to detect "last sender was me" = awaiting their reply)
const MY_DOMAINS = ['prescientai.com', 'prescient-ai.io', 'prescient.ai'];

// ── Main Projection Builder ──────────────────────────────────────────

export async function buildInboxProjection(query?: string): Promise<InboxView> {
  const searchTool = await getTool('gmail.search_threads');
  if (!searchTool) {
    throw new IntegrationError('gmail', 'Gmail tool not available — check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }

  const gmailQuery = query || `is:inbox is:unread ${IMPORTANT_INBOX_QUERY}`;

  const result = await searchTool.execute({
    query: gmailQuery,
    max_results: 50,   // fetch more, filter aggressively
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

  // Classify every thread, then filter
  let filteredOutCount = 0;
  const threads: InboxThread[] = [];

  for (const t of rawThreads) {
    const fromParsed = parseFrom(t.from || '');
    const lastSenderIsMe = isMe(fromParsed.email);
    const classification = classifyEmail(t, fromParsed);

    // Only include important_human by default
    if (classification !== 'important_human') {
      filteredOutCount++;
      continue;
    }

    let agentStatus: InboxThread['agent_status'] = 'none';
    if (draftedThreads.has(t.thread_id)) agentStatus = 'draft_created';

    const { level, reason } = classifyPriority(t, fromParsed, lastSenderIsMe);
    const replyNeeded = !lastSenderIsMe && level !== 'low' && agentStatus === 'none';
    const whyItMatters = buildWhyItMatters(t, fromParsed, level, reason);

    threads.push({
      thread_id: t.thread_id || t.id,
      subject: t.subject || '(no subject)',
      from: fromParsed.name,
      from_email: fromParsed.email,
      date: t.date || '',
      snippet: t.snippet || '',
      is_unread: t.unread !== false,
      priority: level,
      priority_reason: reason,
      reply_needed: replyNeeded,
      agent_status: agentStatus,
      classification,
      why_it_matters: whyItMatters,
    });
  }

  // Sort: reply-needed first, then high > medium > low, then by date
  threads.sort((a, b) => {
    if (a.reply_needed !== b.reply_needed) return a.reply_needed ? -1 : 1;
    const pOrder = { high: 0, medium: 1, low: 2 };
    const pDiff = pOrder[a.priority] - pOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return {
    threads,
    total_unread: threads.filter(t => t.is_unread).length,
    needs_reply: threads.filter(t => t.reply_needed).length,
    agent_drafted: threads.filter(t => t.agent_status === 'draft_created').length,
    total_filtered_out: filteredOutCount,
    generated_at: new Date().toISOString(),
    source: 'gmail',
    mode: 'important',
  };
}

// ── Email Classification (Noise Suppression Layer) ───────────────────

function classifyEmail(
  thread: any,
  fromParsed: { name: string; email: string }
): InboxThread['classification'] {
  const from = (thread.from || '').toLowerCase();
  const fromEmail = fromParsed.email.toLowerCase();
  const subject = (thread.subject || '').toLowerCase();
  const snippet = (thread.snippet || '').toLowerCase();

  // Calendar notifications
  if (
    from.includes('calendar-notification') ||
    from.includes('calendar-server') ||
    subject.match(/^(invitation|accepted|declined|tentative):/) ||
    (from.includes('calendar') && subject.includes('event'))
  ) {
    return 'calendar_notification';
  }

  // System / automated senders — check sender patterns
  const isNoiseSender = NOISE_SENDER_PATTERNS.some(pattern => {
    if (pattern.startsWith('@')) return fromEmail.includes(pattern);
    return from.includes(pattern) || fromEmail.includes(pattern);
  });

  if (isNoiseSender) {
    // ALWAYS block billing/transactional senders — even in reply chains
    const isBillingSender = from.includes('billing') || from.includes('invoice') || from.includes('receipt') || from.includes('payment');
    const isDocuSign = from.includes('docusign');
    const isMarketingSender = from.includes('marketing') || from.includes('newsletter') || from.includes('news@') || from.includes('promo');

    if (isBillingSender || subject.includes('invoice') || subject.includes('billing') || subject.includes('credit memo') || subject.includes('payment')) {
      return 'transactional';
    }
    if (isDocuSign || subject.includes('docusign')) {
      return 'transactional';
    }
    if (isMarketingSender) {
      return 'promotional';
    }

    // For non-transactional noise senders: allow genuine reply chains through
    // (e.g., a real person at a SaaS company replying to you in a thread)
    // But NOT if it's clearly automated
    if (subject.startsWith('re:') && !isDefinitelyAutomated(from, subject) && !isSubjectNoise(subject)) {
      return 'important_human';
    }

    return 'system';
  }

  // Subject-based noise detection
  const isNoiseSubject = NOISE_SUBJECT_PATTERNS.some(pattern => {
    // "unsubscribe" only counts if not in a reply chain
    if (pattern === 'unsubscribe') {
      return subject.includes(pattern) && !subject.startsWith('re:');
    }
    return subject.includes(pattern);
  });

  if (isNoiseSubject) {
    // DocuSign
    if (subject.includes('docusign') || subject.includes('please sign')) {
      return 'transactional';
    }
    // Billing
    if (subject.match(/\b(invoice|receipt|billing|payment|subscription|charge|bill)\b/)) {
      return 'transactional';
    }
    // Newsletter / marketing
    if (subject.match(/\b(newsletter|digest|weekly update|monthly update|what'?s new|product update|welcome to|getting started)\b/)) {
      return 'promotional';
    }
    // Calendar
    if (subject.match(/^(invitation|accepted|declined|tentative|rsvp|event reminder)/i)) {
      return 'calendar_notification';
    }
    // System
    if (subject.match(/\b(security alert|password reset|verify your|confirm your|activate your)\b/)) {
      return 'system';
    }
    return 'low_signal_noise';
  }

  // Snippet-based noise check (catches things subject/sender miss)
  if (snippet.includes('unsubscribe') && !subject.startsWith('re:')) {
    return 'promotional';
  }

  // If we got here, it's a real human email
  return 'important_human';
}

function isDefinitelyAutomated(from: string, subject: string): boolean {
  return (
    from.includes('noreply') ||
    from.includes('no-reply') ||
    from.includes('do-not-reply') ||
    from.includes('donotreply') ||
    from.includes('mailer-daemon') ||
    subject.includes('unsubscribe') ||
    subject.match(/^(invitation|accepted|declined):/) !== null
  );
}

function isSubjectNoise(subject: string): boolean {
  return NOISE_SUBJECT_PATTERNS.some(pattern => {
    if (pattern === 'unsubscribe') return false; // handled elsewhere
    // For re: chains, strip the "re: " prefix and check the underlying subject
    const stripped = subject.replace(/^re:\s*/i, '');
    return stripped.includes(pattern);
  });
}

// ── Priority Classification ──────────────────────────────────────────

function classifyPriority(
  thread: any,
  fromParsed: { name: string; email: string },
  lastSenderIsMe: boolean
): { level: 'high' | 'medium' | 'low'; reason?: string } {
  const subject = (thread.subject || '').toLowerCase();
  const from = (thread.from || '').toLowerCase();
  const snippet = (thread.snippet || '').toLowerCase();

  // If I was the last sender, lower priority (awaiting their reply)
  if (lastSenderIsMe) {
    return { level: 'low', reason: 'Awaiting their reply' };
  }

  // HIGH: deal documents, urgent, introductions, active deal signals
  if (subject.includes('urgent') || subject.includes('asap') || subject.includes('time sensitive')) {
    return { level: 'high', reason: 'Marked urgent' };
  }
  if (subject.match(/\b(contract|order form|sow|agreement|msa|nda)\b/)) {
    return { level: 'high', reason: 'Deal document' };
  }
  if (subject.includes('proposal') && !subject.includes('newsletter')) {
    return { level: 'high', reason: 'Proposal' };
  }
  if (subject.match(/\b(intro|introduction|connecting)\b/) || subject.includes('meet ')) {
    return { level: 'high', reason: 'Introduction' };
  }
  if (snippet.match(/\b(can we schedule|are you free|available for|let'?s set up|find a time)\b/)) {
    return { level: 'high', reason: 'Scheduling request' };
  }
  if (snippet.match(/\b(pricing|quote|discount|budget|cost)\b/) && subject.startsWith('re:')) {
    return { level: 'high', reason: 'Pricing discussion' };
  }
  if (snippet.match(/\b(close|closing|sign|signed|ready to move|ready to go)\b/) && subject.startsWith('re:')) {
    return { level: 'high', reason: 'Close signal' };
  }

  // MEDIUM: replies, active threads, human conversations
  if (subject.startsWith('re:')) {
    return { level: 'medium', reason: 'Active thread' };
  }
  if (subject.startsWith('fwd:')) {
    return { level: 'medium', reason: 'Forwarded' };
  }

  // Default for human email that passed all filters
  return { level: 'medium', reason: 'New message' };
}

// ── Why It Matters ───────────────────────────────────────────────────

function buildWhyItMatters(
  thread: any,
  fromParsed: { name: string; email: string },
  level: string,
  reason?: string
): string {
  const subject = (thread.subject || '').toLowerCase();
  const snippet = (thread.snippet || '').toLowerCase();

  if (level === 'high') {
    if (reason === 'Deal document') return 'Contains deal documentation that likely needs review/signature';
    if (reason === 'Introduction') return 'New introduction — respond within 24h';
    if (reason === 'Scheduling request') return 'Someone is trying to book time with you';
    if (reason === 'Pricing discussion') return 'Active pricing conversation — revenue impact';
    if (reason === 'Close signal') return 'Deal may be ready to close — high priority';
    if (reason === 'Marked urgent') return 'Sender flagged this as urgent';
    if (reason === 'Proposal') return 'Proposal in progress — respond to keep momentum';
  }

  if (subject.startsWith('re:')) return 'Active conversation — someone replied to you';
  return '';
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
