// Live Data Sync API
// Pulls fresh data from Gmail, HubSpot, and Granola
// Merges into existing data and persists to KV

const HUBSPOT_BASE = 'https://api.hubapi.com';
const GRANOLA_BASE = 'https://public-api.granola.ai';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { lastSyncedAt } = req.body || {};
  const syncStart = new Date();

  // Cold start guard: limit lookback
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
    syncHubSpot(sinceDate, summary),
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

  // Persist to KV if available
  try {
    const kvModule = await import('@vercel/kv');
    const kv = kvModule.kv;

    if (newActions.length > 0) {
      const existing = (await kv.get('actions')) || [];
      const merged = upsertById(existing, newActions);
      await kv.set('actions', merged);
    }
    if (updatedPipeline.length > 0) {
      const existing = (await kv.get('pipeline')) || [];
      const merged = upsertById(existing, updatedPipeline);
      await kv.set('pipeline', merged);
    }
    if (newMeetings.length > 0) {
      const existing = (await kv.get('meetings')) || [];
      const merged = upsertByTitle(existing, newMeetings);
      await kv.set('meetings', merged);
    }
    // Store sync timestamp
    const meta = (await kv.get('metadata')) || {};
    meta.lastSyncedAt = syncStart.toISOString();
    await kv.set('metadata', meta);
  } catch {
    // KV not configured — data returned to frontend for local merge
  }

  return res.status(200).json({
    success: true,
    syncedAt: syncStart.toISOString(),
    newActions,
    updatedPipeline,
    newMeetings,
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
  if (!tokenData.access_token) return [];

  const headers = { Authorization: `Bearer ${tokenData.access_token}` };
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

  // Get recent unread inbox messages
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`is:inbox is:unread after:${sinceEpoch}`)}&maxResults=10`,
    { headers }
  );
  if (!listRes.ok) return [];
  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) return [];

  // Fetch message details (limit to 10 to stay within timeout)
  const details = await Promise.all(
    messages.slice(0, 10).map(m =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers })
        .then(r => r.json())
        .catch(() => null)
    )
  );

  const validMessages = details.filter(Boolean).map(msg => {
    const fromHeader = (msg.payload?.headers || []).find(h => h.name === 'From');
    const subjectHeader = (msg.payload?.headers || []).find(h => h.name === 'Subject');
    return {
      id: msg.id,
      from: fromHeader?.value || '',
      subject: subjectHeader?.value || '',
      snippet: msg.snippet || '',
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
    `Email ${i + 1}:\nFrom: ${m.from}\nSubject: ${m.subject}\nSnippet: ${m.snippet}`
  ).join('\n\n');

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
      system: `You are a sales ops assistant. Analyze inbound emails and determine which ones warrant action items for the CEO. Return a JSON array:
[
  {
    "emailIndex": 0,
    "isActionable": true/false,
    "company": "extracted company name",
    "task": "1-line summary of what needs to happen",
    "category": "inbound|sales|partnerships|strategic",
    "urgency": "high|medium|low",
    "draftPrompt": "Brief instruction for drafting a reply",
    "crmPrompt": "Brief instruction for CRM logging"
  }
]
Skip newsletters, marketing emails, automated notifications. Focus on real people reaching out about business.
Return ONLY valid JSON array.`,
      messages: [{ role: 'user', content: emailList }],
    }),
  });

  const aiData = await aiRes.json();
  let parsed;
  try {
    parsed = JSON.parse((aiData.content?.[0]?.text || '[]').replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim());
  } catch {
    return [];
  }

  const newActions = [];
  const baseId = Date.now(); // Use timestamp-based IDs for new actions

  parsed.filter(p => p.isActionable).forEach((p, i) => {
    const email = externalMessages[p.emailIndex];
    if (!email) return;

    newActions.push({
      id: baseId + i,
      cat: p.category || 'inbound',
      company: p.company || 'Unknown',
      color: p.urgency === 'high' ? 'tg' : p.urgency === 'medium' ? 'ta' : 'tb',
      status: 'open',
      lastActivity: email.date,
      task: p.task || email.subject,
      meta: `${email.from} | ${email.subject}`,
      emailSummary: `<strong>From:</strong> ${email.from}<br><strong>Subject:</strong> ${email.subject}<br><br>${email.snippet}`,
      emailUrl: `https://mail.google.com/mail/u/0/#inbox/${email.id}`,
      dealValue: null,
      granola: null,
      hubspot: null,
      draftPrompt: p.draftPrompt || `Draft a reply to ${email.from} about: ${email.subject}`,
      crmPrompt: p.crmPrompt || `Log in HubSpot: ${p.company} inbound from ${email.from}`,
      aiRec: p.urgency === 'high' ? 'Respond ASAP' : 'Review when ready',
      _syncSource: 'gmail',
    });
    summary.emailsProcessed++;
  });

  return newActions;
}

// ── HubSpot Sync ──
async function syncHubSpot(sinceDate, summary) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return [];

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    const searchRes = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: 'hs_lastmodifieddate',
            operator: 'GTE',
            value: sinceDate.getTime().toString(),
          }],
        }],
        properties: ['dealname', 'dealstage', 'amount', 'closedate', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 50,
      }),
    });

    if (!searchRes.ok) return [];
    const searchData = await searchRes.json();
    const deals = searchData.results || [];

    // Owner mapping
    const OWNERS = { '151853665': 'Mike', '82490290': 'Brian', '743878021': 'Will', '1003618676': 'Jason', '84289936': 'Michael O', '82544484': 'Jason N' };

    const STAGE_MAP = {
      '93124525': 'Disco Booked', '998751160': 'Disco Complete', 'appointmentscheduled': 'Demo Scheduled',
      '123162712': 'Demo Completed', 'decisionmakerboughtin': 'Negotiating', '227588384': 'Committed',
      'closedwon': 'Closed Won', 'closedlost': 'Closed Lost', '60237411': 'Nurture', '53401375': 'Booking',
    };

    const updatedDeals = deals.map(d => ({
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
    if (!map.has(key)) {
      map.set(key, m);
    }
  }
  return Array.from(map.values());
}
