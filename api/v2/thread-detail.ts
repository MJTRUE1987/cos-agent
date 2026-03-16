/**
 * GET /api/v2/thread-detail?thread_id=...
 *
 * Fetches a full Gmail thread with all message bodies, headers, and metadata.
 * Also looks up CRM context (HubSpot deal) and generates an AI-recommended reply.
 */

import { safeHandler } from './_handler.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HUBSPOT_BASE = 'https://api.hubapi.com';

export default safeHandler('thread-detail', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  // POST actions: archive, delete
  if (req.method === 'POST') {
    const { thread_id: actionThreadId, action } = req.body || {};
    if (!actionThreadId || !action) return res.status(400).json({ success: false, error: 'thread_id and action required' });

    const token = await getGmailToken();

    if (action === 'archive') {
      const r = await fetch(`${GMAIL_BASE}/threads/${actionThreadId}/modify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });
      if (!r.ok) return res.status(r.status).json({ success: false, error: await r.text() });
      return res.status(200).json({ success: true, action: 'archived', thread_id: actionThreadId });
    }

    if (action === 'delete') {
      const r = await fetch(`${GMAIL_BASE}/threads/${actionThreadId}/trash`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return res.status(r.status).json({ success: false, error: await r.text() });
      return res.status(200).json({ success: true, action: 'trashed', thread_id: actionThreadId });
    }

    if (action === 'draft') {
      const { to, subject, body, cc } = req.body;
      if (!to || !body) return res.status(400).json({ success: false, error: 'to and body required for draft' });

      const headers_list = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${subject || '(no subject)'}`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
      ].filter(Boolean).join('\r\n');
      const rawMessage = `${headers_list}\r\n\r\n${body}`;
      const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const draftBody: any = { message: { raw: encodedMessage } };
      if (actionThreadId) draftBody.message.threadId = actionThreadId;

      const r = await fetch(`${GMAIL_BASE}/drafts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftBody),
      });
      if (!r.ok) return res.status(r.status).json({ success: false, error: await r.text() });
      const draft = await r.json();
      return res.status(200).json({
        success: true,
        action: 'draft_created',
        draftId: draft.id,
        messageId: draft.message?.id,
        url: `https://mail.google.com/mail/u/0/#drafts/${draft.message?.id}`,
      });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  }

  const threadId = req.query.thread_id as string;
  if (!threadId) return res.status(400).json({ success: false, error: 'thread_id required' });

  // Get Gmail access token
  const gmailToken = await getGmailToken();

  // Fetch full thread with all messages
  const threadRes = await fetch(`${GMAIL_BASE}/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${gmailToken}` },
  });
  if (!threadRes.ok) {
    const err = await threadRes.text();
    return res.status(threadRes.status).json({ success: false, error: `Gmail API error: ${err}` });
  }
  const thread = await threadRes.json();

  // Parse all messages
  const messages = (thread.messages || []).map((msg: any) => {
    const getHeader = (name: string) =>
      (msg.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const bodyText = extractEmailBody(msg.payload);
    const bodyHtml = extractEmailHtml(msg.payload);

    return {
      id: msg.id,
      thread_id: msg.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      cc: getHeader('Cc'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      timestamp: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : null,
      snippet: msg.snippet || '',
      body_text: bodyText,
      body_html: bodyHtml,
      labels: msg.labelIds || [],
      is_unread: (msg.labelIds || []).includes('UNREAD'),
      is_draft: (msg.labelIds || []).includes('DRAFT'),
    };
  });

  // Extract participants for CRM lookup
  const externalEmails = new Set<string>();
  const senderNames: Record<string, string> = {};
  for (const msg of messages) {
    const fromMatch = msg.from.match(/<([^>]+)>/) || [null, msg.from];
    const email = (fromMatch[1] || '').toLowerCase().trim();
    const nameMatch = msg.from.match(/^([^<]+)/);
    const name = nameMatch ? nameMatch[1].trim().replace(/"/g, '') : email;
    if (email && !email.includes('prescientai.com') && !email.includes('prescient.ai')) {
      externalEmails.add(email);
      senderNames[email] = name;
    }
  }

  // CRM context lookup (parallel, non-blocking)
  let crmContext: any = null;
  const hsToken = process.env.HUBSPOT_ACCESS_TOKEN;
  if (hsToken && externalEmails.size > 0) {
    try {
      const firstEmail = Array.from(externalEmails)[0];
      const contactRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: firstEmail }] }],
          properties: ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'phone', 'lifecyclestage'],
          limit: 1,
        }),
      });
      if (contactRes.ok) {
        const contactData = await contactRes.json();
        const contact = contactData.results?.[0];
        if (contact) {
          // Search for associated deals
          const dealsRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/${contact.id}/associations/deals`, {
            headers: { Authorization: `Bearer ${hsToken}` },
          });
          let deals: any[] = [];
          if (dealsRes.ok) {
            const dealsData = await dealsRes.json();
            const dealIds = (dealsData.results || []).map((d: any) => d.id).slice(0, 3);
            if (dealIds.length > 0) {
              const dealDetails = await Promise.all(
                dealIds.map((id: string) =>
                  fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/${id}?properties=dealname,dealstage,amount,closedate,pipeline`, {
                    headers: { Authorization: `Bearer ${hsToken}` },
                  }).then(r => r.json()).catch(() => null)
                )
              );
              deals = dealDetails.filter(Boolean).map((d: any) => ({
                id: d.id,
                name: d.properties?.dealname,
                stage: d.properties?.dealstage,
                amount: d.properties?.amount,
                close_date: d.properties?.closedate,
              }));
            }
          }

          crmContext = {
            contact_id: contact.id,
            name: `${contact.properties?.firstname || ''} ${contact.properties?.lastname || ''}`.trim(),
            email: contact.properties?.email,
            title: contact.properties?.jobtitle,
            company: contact.properties?.company,
            phone: contact.properties?.phone,
            lifecycle_stage: contact.properties?.lifecyclestage,
            deals,
          };
        }
      }
    } catch (e) {
      // CRM lookup is non-critical
      console.error('[thread-detail] CRM lookup failed:', (e as Error).message);
    }
  }

  // Generate AI recommended reply
  let recommendedReply: any = null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && messages.length > 0) {
    try {
      const lastMsg = messages[messages.length - 1];
      const threadContext = messages.map((m: any) =>
        `From: ${m.from}\nDate: ${m.date}\n${m.body_text?.substring(0, 800) || m.snippet}`
      ).join('\n---\n');

      const crmInfo = crmContext
        ? `\nCRM Context: ${crmContext.name} (${crmContext.title || 'no title'}) at ${crmContext.company || 'unknown company'}. ${
            crmContext.deals?.length ? `Active deals: ${crmContext.deals.map((d: any) => `${d.name} (${d.stage})`).join(', ')}` : 'No active deals.'
          }`
        : '';

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `You are drafting a reply for Mike True, CEO of Prescient AI. Write a concise, professional reply to this email thread. First person. Warm but direct.${crmInfo}

Thread:
${threadContext}

Write ONLY the reply body text (no subject, no greeting like "Hi [name]" unless natural). Keep it under 150 words. If this email doesn't need a reply (e.g. newsletter, auto-notification), respond with exactly: NO_REPLY_NEEDED`,
          }],
        }),
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const replyText = aiData.content?.[0]?.text?.trim() || '';
        if (replyText && replyText !== 'NO_REPLY_NEEDED') {
          recommendedReply = {
            body: replyText,
            to: lastMsg.from.match(/<([^>]+)>/)?.[1] || lastMsg.from,
            subject: lastMsg.subject?.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject}`,
          };
        }
      }
    } catch (e) {
      console.error('[thread-detail] AI reply generation failed:', (e as Error).message);
    }
  }

  // Mark as read
  try {
    await fetch(`${GMAIL_BASE}/threads/${threadId}/modify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gmailToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  } catch { /* non-critical */ }

  return res.status(200).json({
    success: true,
    thread_id: threadId,
    subject: messages[0]?.subject || '(no subject)',
    messages,
    participants: Array.from(externalEmails).map(e => ({ email: e, name: senderNames[e] || e })),
    crm: crmContext,
    recommended_reply: recommendedReply,
    labels: thread.messages?.[0]?.labelIds || [],
  });
});

// ── Helpers ──

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

function extractEmailBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    } catch { /* fall through */ }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try { return Buffer.from(part.body.data, 'base64url').toString('utf-8').trim(); } catch { /* continue */ }
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf-8')
            .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        } catch { /* continue */ }
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractEmailBody(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

function extractEmailHtml(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    try { return Buffer.from(payload.body.data, 'base64url').toString('utf-8'); } catch { /* fall through */ }
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        try { return Buffer.from(part.body.data, 'base64url').toString('utf-8'); } catch { /* continue */ }
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractEmailHtml(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}
