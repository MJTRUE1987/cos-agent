/**
 * Inbox Projection — Superhuman-style Important inbox with smart filtering.
 *
 * 1. Query Gmail `is:important` (matches Superhuman's Important folder)
 * 2. Filter out: calendar invites/RSVPs, billing/invoices, spam/automated
 * 3. Cross-reference with HubSpot CRM — tag emails tied to active deals
 * 4. Show read AND unread, grouped by date
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
  date_group: string;
  reply_needed: boolean;
  agent_status: 'none' | 'draft_created' | 'replied' | 'triaged';
  // CRM enrichment
  crm_deal?: string;
  crm_stage?: string;
  crm_deal_id?: string;
}

export interface InboxView {
  threads: InboxThread[];
  total_count: number;
  total_unread: number;
  needs_reply: number;
  agent_drafted: number;
  filtered_count: number;
  generated_at: string;
  source: 'gmail';
  mode: 'important';
}

// My email domains
const MY_DOMAINS = ['prescientai.com', 'prescient-ai.io', 'prescient.ai'];

// HubSpot stage labels
const STAGE_LABELS: Record<string, string> = {
  '93124525': 'Disco Booked',
  '998751160': 'Disco Complete',
  'appointmentscheduled': 'Demo Scheduled',
  '123162712': 'Demo Completed',
  'decisionmakerboughtin': 'Negotiating Proposal',
  '227588384': 'Committed',
};

// ── Noise Classification ──────────────────────────────────────────────
// Uses subject, sender, AND snippet (business context) to classify

function isCalendarNoise(subject: string, from: string, snippet: string): boolean {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();
  const sn = snippet.toLowerCase();

  // Calendar invitation patterns
  if (s.match(/^(invitation|accepted|declined|tentative|updated invitation|canceled|cancelled):\s/)) return true;
  if (s.match(/@ (mon|tue|wed|thu|fri|sat|sun) /i) && s.match(/\d{1,2}(:\d{2})?\s*(am|pm)/i)) return true;
  if (f.includes('calendar-notification') || f.includes('calendar-server')) return true;
  if (sn.includes('has accepted this invitation') || sn.includes('has declined this invitation')) return true;
  if (sn.includes('join with google meet') && s.match(/@ .+ \d{4}/)) return true;
  if (sn.includes('has been invited by') && sn.includes('to attend an event')) return true;

  return false;
}

function isBillingNoise(subject: string, from: string, snippet: string): boolean {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();
  const sn = snippet.toLowerCase();

  // Sender-based billing signals
  const billingSenders = [
    'billing@', 'billing.', 'invoices@', 'invoice@', 'receipts@', 'receipt@',
    'payments@', 'payment@', 'accounts@', 'accounting@',
    '@brex.com', '@justworks.com', '@gusto.com', '@rippling.com',
    '@expensify.com', '@bill.com', '@ramp.com', '@stripe.com',
    'vitally billing', 'vitally.io',
  ];
  const isBillingSender = billingSenders.some(p => f.includes(p));

  // Subject-based billing signals
  const billingSubjects = [
    'invoice', 'receipt', 'payment confirmed', 'payment received', 'payment due',
    'billing statement', 'subscription renewed', 'subscription confirmation',
    'your bill', 'amount due', 'billing notice', 'payment reminder',
    'upcoming charge', 'card bill', 'credit memo',
    'contacts tier', 'plan limit', 'usage limit',
  ];
  const isBillingSubject = billingSubjects.some(p => s.includes(p));

  // Snippet-based billing context
  const billingSnippet = sn.includes('submit payment') || sn.includes('invoice totaling') ||
    sn.includes('invoice.stripe.com') || sn.includes('amount due') ||
    sn.includes('payment is due') || sn.includes('balance due') ||
    sn.includes('pay here') || sn.includes('view invoice');

  if (isBillingSender && (isBillingSubject || billingSnippet)) return true;
  if (isBillingSender && !s.startsWith('re:')) return true; // Non-reply from billing sender
  if (isBillingSubject && billingSnippet) return true; // Both subject and snippet confirm billing

  return false;
}

function isSpamNoise(subject: string, from: string, snippet: string): boolean {
  const s = subject.toLowerCase();
  const f = from.toLowerCase();
  const sn = snippet.toLowerCase();

  // Automated / noreply senders
  const autoSenders = [
    'noreply@', 'no-reply@', 'do-not-reply@', 'donotreply@',
    'mailer-daemon', 'postmaster@',
    'notifications@', 'notification@', 'alerts@', 'alert@',
  ];
  const isAutoSender = autoSenders.some(p => f.includes(p));
  if (isAutoSender && !s.startsWith('re:')) return true;

  // DocuSign
  if (f.includes('docusign') || s.includes('docusign') || s.includes('please sign')) return true;

  // Newsletter / marketing signals (subject + snippet together)
  const newsletterSubjects = [
    'newsletter', 'digest', 'weekly update', 'weekly recap', 'monthly update',
    'daily digest', 'weekly roundup', 'what\'s new', 'whats new',
    'product update', 'release notes', 'changelog',
    'welcome to', 'getting started with', 'resources to kickstart',
  ];
  if (newsletterSubjects.some(p => s.includes(p)) && !s.startsWith('re:')) return true;

  // Snippet says unsubscribe = newsletter (unless it's a reply)
  if (sn.includes('unsubscribe') && !s.startsWith('re:')) return true;

  // Status page / security
  if (s.includes('security alert') || s.includes('sign-in attempt') || s.includes('password reset')) return true;
  if (s.includes('verify your email') || s.includes('confirm your email')) return true;

  // SaaS product senders with non-reply subjects
  const saasMarketingSenders = [
    '@vercel.com', 'vercel.email', '@hubspot.com', '@intercom.io',
    '@notion.so', '@linear.app', '@figma.com', '@sendgrid.net',
    '@mailchimp.com', '@substack.com', '@beehiiv.com',
    'marketing@', 'newsletter@', 'news@', 'updates@', 'digest@',
  ];
  if (saasMarketingSenders.some(p => f.includes(p)) && !s.startsWith('re:')) return true;

  // HR / internal ops
  if (s.includes('requested time off') || s.includes('time off request') || s.includes('pto request')) return true;

  // GoingVC newsletters
  if (f.includes('goingvc')) return true;

  return false;
}

function shouldFilter(subject: string, from: string, snippet: string): boolean {
  return isCalendarNoise(subject, from, snippet) ||
         isBillingNoise(subject, from, snippet) ||
         isSpamNoise(subject, from, snippet);
}

// ── HubSpot CRM Cross-Reference ──────────────────────────────────────

interface CrmDeal {
  deal_id: string;
  name: string;
  stage_id: string;
  stage_label: string;
  company_name: string;
  contact_emails: string[];
  contact_domains: string[];
}

async function fetchCrmDeals(): Promise<CrmDeal[]> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return [];

  try {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Fetch active deals with contacts
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: 'pipeline', operator: 'EQ', value: 'default' },
          { propertyName: 'dealstage', operator: 'IN', values: Object.keys(STAGE_LABELS) },
        ],
      }],
      properties: ['dealname', 'dealstage'],
      associations: ['contacts', 'companies'],
      limit: 100,
    };

    const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers,
      body: JSON.stringify(searchBody),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const deals = data.results || [];

    // Build deal objects with associated contacts
    const crmDeals: CrmDeal[] = [];

    for (const deal of deals) {
      const props = deal.properties || {};
      const stageId = props.dealstage || '';
      const dealName = (props.dealname || '').trim();

      // Get associated contact IDs
      const contactAssocs = deal.associations?.contacts?.results || [];
      const contactIds = contactAssocs.map((a: any) => a.id);

      // Get associated company IDs
      const companyAssocs = deal.associations?.companies?.results || [];
      const companyIds = companyAssocs.map((a: any) => a.id);

      const contactEmails: string[] = [];
      const contactDomains: string[] = [];
      let companyName = '';

      // Fetch contact emails in batch (max 10 per deal to stay fast)
      for (const cid of contactIds.slice(0, 10)) {
        try {
          const cr = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${cid}?properties=email,firstname,lastname`, { headers });
          if (cr.ok) {
            const cd = await cr.json();
            const email = (cd.properties?.email || '').toLowerCase();
            if (email) {
              contactEmails.push(email);
              const domain = email.split('@')[1];
              if (domain) contactDomains.push(domain);
            }
          }
        } catch {}
      }

      // Fetch company name
      for (const compId of companyIds.slice(0, 1)) {
        try {
          const cr = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${compId}?properties=name,domain`, { headers });
          if (cr.ok) {
            const cd = await cr.json();
            companyName = cd.properties?.name || '';
            const domain = (cd.properties?.domain || '').toLowerCase();
            if (domain) contactDomains.push(domain);
          }
        } catch {}
      }

      crmDeals.push({
        deal_id: deal.id,
        name: dealName,
        stage_id: stageId,
        stage_label: STAGE_LABELS[stageId] || stageId,
        company_name: companyName || dealName,
        contact_emails: contactEmails,
        contact_domains: Array.from(new Set(contactDomains)),
      });
    }

    return crmDeals;
  } catch {
    return [];
  }
}

function matchDeal(fromEmail: string, fromName: string, subject: string, deals: CrmDeal[]): CrmDeal | null {
  const email = fromEmail.toLowerCase();
  const domain = email.split('@')[1] || '';
  const subjectLower = subject.toLowerCase();
  const nameLower = fromName.toLowerCase();

  // 1. Exact email match (strongest signal)
  for (const deal of deals) {
    if (deal.contact_emails.includes(email)) return deal;
  }

  // 2. Domain match (e.g., sender @thrivemarket.com matches deal "Thrive Market")
  if (domain && !isGenericDomain(domain)) {
    for (const deal of deals) {
      if (deal.contact_domains.includes(domain)) return deal;
    }
  }

  // 3. Company/deal name appears in subject (e.g., "Prescient AI x Thrive Market")
  for (const deal of deals) {
    const dealWords = deal.company_name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const nameInSubject = dealWords.length > 0 && dealWords.every(w => subjectLower.includes(w));
    if (nameInSubject) return deal;

    // Also check deal name (which is often "Company x Prescient")
    const dealNameWords = deal.name.toLowerCase().replace(/prescient\s*(ai)?/gi, '').trim().split(/\s+/).filter(w => w.length > 2);
    if (dealNameWords.length > 0 && dealNameWords.every(w => subjectLower.includes(w) || nameLower.includes(w))) return deal;
  }

  return null;
}

function isGenericDomain(domain: string): boolean {
  const generic = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com', 'live.com', 'msn.com'];
  return generic.includes(domain);
}

// ── Main Projection Builder ──────────────────────────────────────────

export async function buildInboxProjection(query?: string): Promise<InboxView> {
  const searchTool = await getTool('gmail.search_threads');
  if (!searchTool) {
    throw new IntegrationError('gmail', 'Gmail tool not available');
  }

  const gmailQuery = query || 'is:important';

  // Fetch Gmail threads AND HubSpot deals in parallel
  const [gmailResult, crmDeals] = await Promise.all([
    searchTool.execute({
      query: gmailQuery,
      max_results: 40,  // fetch extra to account for filtering
    }, {
      command_id: 'projection',
      execution_run_id: 'projection',
      plan_id: 'projection',
      step_id: 'projection',
      tool_call_id: 'projection',
    }),
    fetchCrmDeals(),
  ]);

  if (!gmailResult.success) {
    throw new IntegrationError('gmail', gmailResult.error?.message || 'Gmail API call failed');
  }

  const rawThreads: any[] = gmailResult.outputs.threads || [];

  // Agent status enrichment
  const recentEvents = await getEvents({ limit: 100 });
  const draftedThreads = new Set<string>();
  for (const evt of recentEvents) {
    if (evt.event_type === 'gmail.draft.created' && evt.payload?.thread_id) {
      draftedThreads.add(evt.payload.thread_id);
    }
  }

  const now = new Date();
  const threads: InboxThread[] = [];
  let filteredCount = 0;

  for (const t of rawThreads) {
    const subject = t.subject || '';
    const from = t.from || '';
    const snippet = t.snippet || '';
    const fromParsed = parseFrom(from);

    // Filter calendar, billing, spam using subject + sender + snippet context
    if (shouldFilter(subject, from, snippet)) {
      filteredCount++;
      continue;
    }

    const lastSenderIsMe = isMe(fromParsed.email);
    const isDraft = (t.labels || []).includes('DRAFT');

    let agentStatus: InboxThread['agent_status'] = 'none';
    if (draftedThreads.has(t.thread_id)) agentStatus = 'draft_created';

    const replyNeeded = !lastSenderIsMe && t.unread !== false && agentStatus === 'none';
    const dateGroup = getDateGroup(t.date, now);

    // CRM cross-reference
    const matchedDeal = matchDeal(fromParsed.email, fromParsed.name, subject, crmDeals);

    threads.push({
      thread_id: t.thread_id || t.id,
      subject: subject || '(no subject)',
      from: fromParsed.name,
      from_email: fromParsed.email,
      date: t.date || '',
      snippet,
      is_unread: t.unread !== false,
      is_draft: isDraft,
      draft_to: isDraft ? fromParsed.name : undefined,
      date_group: dateGroup,
      reply_needed: replyNeeded,
      agent_status: agentStatus,
      crm_deal: matchedDeal?.name,
      crm_stage: matchedDeal?.stage_label,
      crm_deal_id: matchedDeal?.deal_id,
    });
  }

  // Sort by date descending (newest first)
  threads.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    threads,
    total_count: threads.length,
    total_unread: threads.filter(t => t.is_unread).length,
    needs_reply: threads.filter(t => t.reply_needed).length,
    agent_drafted: threads.filter(t => t.agent_status === 'draft_created').length,
    filtered_count: filteredCount,
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
