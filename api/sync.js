// Live Data Sync API
// Pulls fresh data from Gmail, HubSpot, and Granola
// Merges into existing data and persists to KV

import { acquireLock, releaseLock } from './lib/kv-lock.js';

const HUBSPOT_BASE = 'https://api.hubapi.com';
const GRANOLA_BASE = 'https://public-api.granola.ai';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lastSyncedAt, fullSync: requestedFullSync } = req.body || {};
  const syncStart = new Date();

  // Full sync when explicitly requested or on cold start (no prior sync)
  const fullSync = requestedFullSync || !lastSyncedAt;

  // Cold start guard: limit lookback for incremental
  const sinceDate = lastSyncedAt
    ? new Date(lastSyncedAt)
    : new Date(Date.now() - 48 * 3600000); // 48 hours for first sync

  const summary = { emailsProcessed: 0, dealsUpdated: 0, meetingsFound: 0, errors: [] };
  const newActions = [];
  const updatedPipeline = [];
  const newMeetings = [];

  // Run all three syncs in parallel
  const [gmailResult, hubspotResult, granolaResult] = await Promise.allSettled([
    syncGmail(sinceDate, summary),
    syncHubSpot(sinceDate, summary, fullSync),
    syncGranola(sinceDate, summary),
  ]);

  if (gmailResult.status === 'fulfilled' && gmailResult.value) {
    newActions.push(...gmailResult.value);
  } else if (gmailResult.status === 'rejected') {
    summary.errors.push('Gmail: ' + (gmailResult.reason?.message || 'failed'));
  }

  if (hubspotResult.status === 'fulfilled' && hubspotResult.value) {
    updatedPipeline.push(...hubspotResult.value);
  } else if (hubspotResult.status === 'rejected') {
    summary.errors.push('HubSpot: ' + (hubspotResult.reason?.message || 'failed'));
  }

  if (granolaResult.status === 'fulfilled' && granolaResult.value) {
    newMeetings.push(...granolaResult.value);
  } else if (granolaResult.status === 'rejected') {
    summary.errors.push('Granola: ' + (granolaResult.reason?.message || 'failed'));
  }

  // ── Generate feed events by diffing against previous snapshot ──
  const feedEvents = [];

  // Persist to KV if available (with distributed lock to prevent race conditions)
  try {
    const kvModule = await import('@vercel/kv');
    const kv = kvModule.kv;

    const lockId = await acquireLock(kv);
    if (!lockId) {
      return res.status(409).json({ error: 'Sync already in progress, try again shortly' });
    }

    try {
      // Load previous snapshot for diffing
      const prevPipeline = (await kv.get('pipeline')) || [];
      const prevPipeMap = new Map(prevPipeline.map(d => [String(d.id), d]));
      const emittedIds = new Set((await kv.get('cos_feed_emitted')) || []);

      // Diff deals: detect created, stage changes, owner changes
      for (const deal of updatedPipeline) {
        const prev = prevPipeMap.get(String(deal.id));
        if (!prev) {
          const evId = `hubspot_deal_created_${deal.id}`;
          if (!emittedIds.has(evId)) {
            feedEvents.push({ id: evId, type: 'deal_created', text: `<strong>${deal.name}</strong> — new deal created (${deal.stage})`, ts: syncStart.toISOString(), expiresAt: new Date(syncStart.getTime() + 24*3600000).toISOString() });
            emittedIds.add(evId);
          }
        } else {
          if (prev.stage && deal.stage && prev.stage !== deal.stage) {
            const evId = `hubspot_stage_change_${deal.id}_${deal.stage.replace(/\s+/g,'_')}`;
            if (!emittedIds.has(evId)) {
              feedEvents.push({ id: evId, type: 'deal_stage', text: `<strong>${deal.name}</strong> — moved to <strong>${deal.stage}</strong> (was ${prev.stage})`, ts: syncStart.toISOString(), expiresAt: new Date(syncStart.getTime() + 24*3600000).toISOString() });
              emittedIds.add(evId);
            }
          }
          if (prev.owner && deal.owner && prev.owner !== deal.owner) {
            const evId = `hubspot_owner_change_${deal.id}_${deal.owner}`;
            if (!emittedIds.has(evId)) {
              feedEvents.push({ id: evId, type: 'deal_owner', text: `<strong>${deal.name}</strong> — owner changed to ${deal.owner}`, ts: syncStart.toISOString(), expiresAt: new Date(syncStart.getTime() + 24*3600000).toISOString() });
              emittedIds.add(evId);
            }
          }
        }
      }

      // Diff emails: new action items
      for (const action of newActions) {
        const evId = `gmail_action_${action.threadId || action.id}`;
        if (!emittedIds.has(evId)) {
          const label = action.isIntro
            ? `<strong style="color:#10b981;">🤝 WARM INTRO</strong> <strong>${action.company}</strong> — ${action.task}`
            : `<strong>${action.company}</strong> — ${action.task}`;
          feedEvents.push({ id: evId, type: action.isIntro ? 'intro' : 'email', text: label, ts: action.lastActivity ? new Date(action.lastActivity).toISOString() : syncStart.toISOString(), actionId: action.id, expiresAt: new Date(syncStart.getTime() + 24*3600000).toISOString() });
          emittedIds.add(evId);
        }
      }

      // Diff meetings: new from Granola
      for (const mtg of newMeetings) {
        const evId = `granola_meeting_${mtg.granolaId || (mtg.title + '_' + mtg.date).replace(/\s+/g,'_')}`;
        if (!emittedIds.has(evId)) {
          feedEvents.push({ id: evId, type: 'meeting', text: `<strong>${mtg.title}</strong> — ${mtg.people}`, ts: syncStart.toISOString(), expiresAt: new Date(syncStart.getTime() + 24*3600000).toISOString() });
          emittedIds.add(evId);
        }
      }

      // Persist data
      if (newActions.length > 0) {
        const existing = (await kv.get('actions')) || [];
        const merged = upsertById(existing, newActions);
        await kv.set('actions', merged);
      }
      if (updatedPipeline.length > 0) {
        if (fullSync) {
          await kv.set('pipeline', updatedPipeline);
          console.log(`[sync] Full pipeline sync: replaced with ${updatedPipeline.length} deals from HubSpot`);
        } else {
          const existing = (await kv.get('pipeline')) || [];
          const merged = upsertById(existing, updatedPipeline);
          await kv.set('pipeline', merged);
        }
      }
      if (newMeetings.length > 0) {
        const existing = (await kv.get('meetings')) || [];
        const merged = upsertByTitle(existing, newMeetings);
        await kv.set('meetings', merged);
      }

      // Prune emitted IDs older than 48h (keep set manageable)
      // Store as array — KV handles serialization
      const emittedArray = Array.from(emittedIds).slice(-500);
      await kv.set('cos_feed_emitted', emittedArray);

      // Store sync timestamp
      const meta = (await kv.get('metadata')) || {};
      meta.lastSyncedAt = syncStart.toISOString();
      await kv.set('metadata', meta);
    } finally {
      await releaseLock(kv, lockId);
    }
  } catch (kvErr) {
    console.error('[sync] KV persistence failed:', kvErr.message || kvErr);
    // Data still returned to frontend for local merge
  }

  console.log(`[sync] Feed events generated: ${feedEvents.length}`);

  return res.status(200).json({
    success: true,
    syncedAt: syncStart.toISOString(),
    newActions,
    updatedPipeline,
    newMeetings,
    feedEvents,
    summary: {
      emailsProcessed: summary.emailsProcessed,
      dealsUpdated: summary.dealsUpdated,
      meetingsFound: summary.meetingsFound,
      errors: summary.errors,
    },
  });
}

// ── Gmail Sync ──
async function syncGmail(sinceDate, summary) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return [];

  // Get access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('[sync:gmail] Token refresh failed:', JSON.stringify(tokenData).substring(0, 200));
    return [];
  }

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

  // Get recent inbox messages (including read)
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`is:inbox after:${sinceEpoch}`)}&maxResults=10`,
    { headers }
  );
  if (!listRes.ok) {
    console.error('[sync:gmail] Message list failed:', listRes.status, listRes.statusText);
    return [];
  }
  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) return [];

  // Fetch message details (limit to 10 to stay within timeout)
  // Use format=full to get body text for better classification (intros, warm leads)
  const details = await Promise.all(
    messages.slice(0, 10).map(m =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers })
        .then(r => r.json())
        .catch(() => null)
    )
  );

  const validMessages = details.filter(Boolean).map(msg => {
    const getHeader = (name) => (msg.payload?.headers || []).find(h => h.name === name)?.value || '';
    const bodyText = extractEmailBody(msg.payload);
    return {
      id: msg.id,
      from: getHeader('From'),
      to: getHeader('To'),
      cc: getHeader('Cc'),
      subject: getHeader('Subject'),
      snippet: msg.snippet || '',
      body: bodyText.substring(0, 1500), // cap body for prompt size
      date: msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    };
  });

  if (validMessages.length === 0) return [];

  // Filter out internal emails
  const externalMessages = validMessages.filter(m =>
    !m.from.includes('prescientai.com') && !m.from.includes('prescient.ai')
  );

  if (externalMessages.length === 0) return [];

  // Batch summarize with Claude
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return [];

  const emailList = externalMessages.map((m, i) =>
    `Email ${i + 1}:\nFrom: ${m.from}\nTo: ${m.to}\nCC: ${m.cc}\nSubject: ${m.subject}\nBody:\n${m.body || m.snippet}`
  ).join('\n\n---\n\n');

  console.log(`[sync:gmail] Classifying ${externalMessages.length} emails with AI`);

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
      system: `You are a sales ops assistant for Mike True, CEO of Prescient AI. Analyze inbound emails and determine which ones warrant action items. Return a JSON array:
[
  {
    "emailIndex": 0,
    "isActionable": true/false,
    "isIntro": true/false,
    "company": "target company name (the PROSPECT, not the introducer)",
    "introducer": "name of person making the intro (if isIntro)",
    "introducerCompany": "company of the introducer (if isIntro)",
    "prospects": [{"name": "prospect name", "email": "prospect@co.com", "role": "title if known"}],
    "task": "1-line summary of what needs to happen",
    "category": "inbound|sales|partnerships|strategic",
    "urgency": "high|medium|low",
    "draftPrompt": "Brief instruction for drafting a reply",
    "crmPrompt": "Brief instruction for CRM logging",
    "proposedTimes": [{"raw": "exact text like 'March 12th at 3pm EST'", "date": "ISO 8601 datetime", "timezone": "EST/CST/PST/etc"}]
  }
]

SCHEDULING TIME EXTRACTION — if the email proposes a specific meeting time:
- Extract ALL proposed date/times into the "proposedTimes" array
- Include the exact raw text, ISO 8601 date with timezone offset, and timezone abbreviation
- Examples: "Can you do March 12th at 3pm EST?" → {"raw": "March 12th at 3pm EST", "date": "2026-03-12T15:00:00-05:00", "timezone": "EST"}
- If no specific time is proposed, set proposedTimes to []
- Also detect: "How about Tuesday at 2pm?", "Let's do 3/15 at 10am PST", "I'm free Wednesday afternoon"

INTRO EMAIL DETECTION — mark isIntro=true if ANY of these apply:
- Subject contains "intro", "introduction", "meet", "connect", "introducing"
- Body says "I want to connect you with", "meet [name]", "introducing you to", "let me introduce", "putting you in touch"
- Multiple recipients where the sender is making a connection between two parties
- Someone is vouching for / recommending Prescient to a prospect
- The email reads as a warm handoff between people

For intro emails:
- ALWAYS set isActionable=true, urgency="high", category="inbound"
- Set "company" to the PROSPECT's company (the person being introduced TO Mike), not the introducer's
- Extract ALL people mentioned with their emails from To/CC/body
- Set draftPrompt to: "Reply-all to warm intro from [introducer]. Thank [introducer], express excitement to connect with [prospect name] at [company]. Include Calendly link to schedule a call."
- Set task to: "Warm intro from [introducer] — schedule call with [prospect] at [company]"

Skip newsletters, marketing emails, automated notifications. Focus on real people reaching out about business.
Return ONLY valid JSON array.`,
      messages: [{ role: 'user', content: emailList }],
    }),
  });

  const aiData = await aiRes.json();
  let parsed;
  try {
    parsed = JSON.parse((aiData.content?.[0]?.text || '[]').replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim());
  } catch (parseErr) {
    console.error('[sync:gmail] AI classification parse failed:', parseErr.message, 'Raw:', aiData.content?.[0]?.text?.substring(0, 200));
    return [];
  }

  const newActions = [];
  const baseId = Date.now(); // Use timestamp-based IDs for new actions

  parsed.filter(p => p.isActionable).forEach((p, i) => {
    const email = externalMessages[p.emailIndex];
    if (!email) return;

    // Collect all email addresses from To/CC for reply-all
    const allRecipients = [email.from, email.to, email.cc].filter(Boolean).join(', ');
    const allEmails = allRecipients.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
    // Remove Mike's own email addresses
    const externalEmails = allEmails.filter(e => !e.includes('prescientai.com') && !e.includes('prescient.ai'));

    // Build enhanced draft prompt for intros
    let draftPrompt = p.draftPrompt || `Draft a reply to ${email.from} about: ${email.subject}`;
    if (p.isIntro) {
      const prospectEmails = (p.prospects || []).map(pr => pr.email).filter(Boolean);
      const replyEmails = [...new Set([...externalEmails, ...prospectEmails])];
      draftPrompt = `INTRO EMAIL — Reply-all to warm intro.\n` +
        `From: ${email.from}\nTo: ${replyEmails.join(', ')}\nSubject: Re: ${email.subject}\n\n` +
        `Introducer: ${p.introducer || 'unknown'} (${p.introducerCompany || ''})\n` +
        `Prospect: ${(p.prospects || []).map(pr => `${pr.name} <${pr.email}>`).join(', ')}\n\n` +
        `Instructions: Thank ${p.introducer || 'the introducer'} for the connection. Express excitement to connect with the prospect at ${p.company}. ` +
        `Include Calendly link for "MT Open 30 minutes" to schedule a call. Keep it warm, brief, and professional.`;
    }

    const action = {
      id: baseId + i,
      cat: p.category || 'inbound',
      company: p.company || 'Unknown',
      color: p.urgency === 'high' ? 'tg' : p.urgency === 'medium' ? 'ta' : 'tb',
      status: 'open',
      lastActivity: email.date,
      task: p.task || email.subject,
      meta: `${email.from} | ${email.subject}`,
      emailSummary: `<strong>From:</strong> ${email.from}<br><strong>Subject:</strong> ${email.subject}${p.isIntro ? '<br><strong style="color:#10b981;">🤝 Warm Intro</strong>' : ''}<br><br>${email.snippet}`,
      emailUrl: `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
      dealValue: null,
      granola: null,
      hubspot: null,
      draftPrompt,
      crmPrompt: p.crmPrompt || `Log in HubSpot: ${p.company} inbound from ${email.from}`,
      aiRec: p.isIntro ? 'Warm intro — reply + schedule ASAP' : (p.urgency === 'high' ? 'Respond ASAP' : 'Review when ready'),
      _syncSource: 'gmail',
      // Intro-specific metadata
      isIntro: !!p.isIntro,
      introducer: p.introducer || null,
      introducerCompany: p.introducerCompany || null,
      prospects: p.prospects || [],
      replyTo: externalEmails,
      threadId: email.id,
      // Scheduling data from AI classification
      proposedTimes: p.proposedTimes || [],
      latestReply: email.snippet || '',
      latestReplyFrom: email.from.replace(/<[^>]*>/g, '').trim(),
      latestReplyDate: email.date,
    };

    console.log(`[sync:gmail] ${p.isIntro ? 'INTRO' : 'email'} classified: company=${p.company}, urgency=${p.urgency}, cat=${p.category}, isIntro=${!!p.isIntro}${p.proposedTimes?.length ? ', proposedTimes=' + p.proposedTimes.length : ''}`);

    newActions.push(action);
    summary.emailsProcessed++;
  });

  return newActions;
}

// ── HubSpot Sync ──
async function syncHubSpot(sinceDate, summary, fullSync = false) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return [];

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Owner mapping
  const OWNERS = { '151853665': 'Mike', '82490290': 'Brian', '743878021': 'Will', '1003618676': 'Jason', '84289936': 'Michael O', '82544484': 'Jason N' };

  const STAGE_MAP = {
    '93124525': 'Disco Booked', '998751160': 'Disco Complete', 'appointmentscheduled': 'Demo Scheduled',
    '123162712': 'Demo Completed', 'decisionmakerboughtin': 'Negotiating', '227588384': 'Committed',
    'closedwon': 'Closed Won', 'closedlost': 'Closed Lost', '60237411': 'Nurture', '53401375': 'Booking',
  };

  // Build filter: full sync gets all non-closed deals; incremental gets recently modified
  const filterGroups = fullSync
    ? [{
        filters: [{
          propertyName: 'dealstage',
          operator: 'NOT_IN',
          values: ['closedwon', 'closedlost'],
        }],
      }]
    : [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator: 'GTE',
          value: sinceDate.getTime().toString(),
        }],
      }];

  const properties = ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'];
  const sorts = [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }];

  try {
    // Paginate to fetch all matching deals
    let allDeals = [];
    let after = undefined;
    do {
      const body = { filterGroups, properties, sorts, limit: 100 };
      if (after) body.after = after;

      const searchRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!searchRes.ok) {
        console.error(`[sync:hubspot] Search failed: ${searchRes.status} ${searchRes.statusText}`);
        return [];
      }

      const searchData = await searchRes.json();
      allDeals.push(...(searchData.results || []));
      after = searchData.paging?.next?.after;
    } while (after);

    console.log(`[sync:hubspot] ${fullSync ? 'Full' : 'Incremental'} sync fetched ${allDeals.length} deals`);

    const updatedDeals = allDeals.map(d => ({
      id: d.id,
      name: d.properties.dealname || '',
      stage: STAGE_MAP[d.properties.dealstage] || d.properties.dealstage || '',
      amount: d.properties.amount ? parseFloat(d.properties.amount) : null,
      close: d.properties.closedate || null,
      owner: OWNERS[d.properties.hubspot_owner_id] || null,
      _syncSource: 'hubspot',
    }));

    summary.dealsUpdated = updatedDeals.length;
    return updatedDeals;
  } catch (err) {
    console.error('HubSpot sync error:', err);
    return [];
  }
}

// ── Granola Sync ──
async function syncGranola(sinceDate, summary) {
  const token = process.env.GRANOLA_API_KEY;
  if (!token) return [];

  const headers = { Authorization: `Bearer ${token}` };
  // Limit Granola lookback to 7 days max
  const granolaAfter = new Date(Math.max(sinceDate.getTime(), Date.now() - 7 * 86400000));

  try {
    const params = new URLSearchParams({
      page_size: '20',
      created_after: granolaAfter.toISOString().split('T')[0],
    });

    const listRes = await fetch(`${GRANOLA_BASE}/v1/notes?${params}`, { headers });
    if (!listRes.ok) return [];
    const listData = await listRes.json();
    const notes = listData.notes || [];

    const newMeetings = notes.map(note => {
      const startDate = note.calendar_event?.start ? new Date(note.calendar_event.start) : new Date(note.created_at);
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
      const dateStr = `${dayNames[startDate.getDay()]} ${startDate.getMonth() + 1}/${startDate.getDate()} · ${timeStr}`;

      const externalAttendees = (note.attendees || []).filter(a =>
        a.email && !a.email.includes('prescientai.com') && !a.email.includes('prescient.ai')
      );

      return {
        date: dateStr,
        title: note.title || 'Untitled Meeting',
        people: (note.attendees || []).map(a => a.name || a.email).join(', '),
        upcoming: false,
        external: externalAttendees.length > 0,
        summary: note.summary_text?.substring(0, 200) || '',
        action: 'Post-call follow-up needed',
        status: 'open',
        granolaId: note.id,
        _syncSource: 'granola',
      };
    });

    summary.meetingsFound = newMeetings.length;
    return newMeetings;
  } catch (err) {
    console.error('Granola sync error:', err);
    return [];
  }
}

// ── Helpers ──
function upsertById(existing, incoming, key = 'id') {
  const map = new Map(existing.map(item => [item[key], item]));
  const noKeyItems = [];
  for (const item of incoming) {
    if (item[key] !== undefined) {
      map.set(item[key], { ...map.get(item[key]), ...item });
    } else {
      noKeyItems.push(item);
    }
  }
  return [...Array.from(map.values()), ...noKeyItems];
}

function upsertByTitle(existing, incoming) {
  const map = new Map(existing.map(m => [(m.date + '|' + m.title).toLowerCase(), m]));
  for (const m of incoming) {
    const key = (m.date + '|' + m.title).toLowerCase();
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, ...m } : m);
  }
  return Array.from(map.values());
}

// Extract plain text body from Gmail message payload (handles multipart)
function extractEmailBody(payload) {
  if (!payload) return '';

  // Direct body on the payload
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    } catch { /* fall through */ }
  }

  // Multipart — recurse into parts, prefer text/plain
  if (payload.parts) {
    // Try text/plain first
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf-8').trim();
        } catch { /* continue */ }
      }
    }
    // Fallback to text/html stripped
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64url').toString('utf-8')
            .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        } catch { /* continue */ }
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractEmailBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}
