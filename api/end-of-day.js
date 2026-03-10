// End of Day Briefing API
// Generates daily recap: wins, deal changes, loose ends, tomorrow priorities, recommendations
// Consumes pipeline diff (snapshot comparison) + intelligence + current state

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { actions = [], meetings = [], pipeline = [], calendarEvents = [], diff = null, dealIntelligence = null } = req.body || {};

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY required' });

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Build context
  const openActions = actions.filter(a => a.status === 'open');
  const doneActions = actions.filter(a => a.status === 'done');
  const archivedActions = actions.filter(a => a.status === 'archived');

  const actionsContext = openActions.map(a => {
    const days = a.lastActivity ? Math.floor((today - new Date(a.lastActivity)) / 86400000) : '?';
    return `[id:${a.id}] ${a.company} (${a.cat}) — ${(a.task || '').substring(0, 100)} | ${days}d stale | ${a.dealValue ? '$' + (a.dealValue / 1000) + 'K' : 'no value'}`;
  }).join('\n');

  const completedContext = doneActions.map(a =>
    `[id:${a.id}] ${a.company} — ${(a.task || '').substring(0, 80)}`
  ).join('\n');

  const pipelineContext = pipeline
    .filter(d => d.stage !== 'Nurture' && d.stage !== 'Booking')
    .map(d => {
      const closeStr = d.close ? new Date(d.close).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no date';
      return `${d.name} — ${d.stage} | $${((d.amount || 0) / 1000).toFixed(0)}K | ${d.owner || 'unassigned'} | close: ${closeStr}`;
    })
    .join('\n');

  const diffContext = diff?.hasSnapshot ? [
    `NEW DEALS TODAY: ${diff.newDeals.length}`,
    ...diff.newDeals.map(d => `  + ${d.name} (${d.stage}) $${((d.amount || 0) / 1000).toFixed(0)}K`),
    `STAGE CHANGES: ${diff.stageChanges.length}`,
    ...diff.stageChanges.map(d => `  ${d.name}: ${d.from} → ${d.to}`),
    `CLOSED WON: ${diff.closedWon.length} ($${((diff.summary?.closedWonValue || 0) / 1000).toFixed(0)}K)`,
    ...diff.closedWon.map(d => `  ✓ ${d.name} $${((d.amount || 0) / 1000).toFixed(0)}K`),
    `CLOSED LOST: ${diff.closedLost.length} ($${((diff.summary?.closedLostValue || 0) / 1000).toFixed(0)}K)`,
    ...diff.closedLost.map(d => `  ✕ ${d.name} $${((d.amount || 0) / 1000).toFixed(0)}K`),
    `AMOUNT CHANGES: ${diff.amountChanges.length}`,
    ...diff.amountChanges.map(d => `  ${d.name}: $${((d.from || 0) / 1000).toFixed(0)}K → $${((d.to || 0) / 1000).toFixed(0)}K`),
    `ACTIONS COMPLETED: ${diff.actionsCompleted?.length || 0}`,
    ...((diff.actionsCompleted || []).map(a => `  ✓ ${a.company}`)),
    `NET PIPELINE CHANGE: $${((diff.summary?.netPipelineChange || 0) / 1000).toFixed(0)}K`,
  ].join('\n') : 'No daily snapshot available — showing current state only';

  const intelligenceContext = dealIntelligence
    ? `Pipeline Health: ${dealIntelligence.pipelineHealth?.score || '?'}/100\nAlerts:\n${(dealIntelligence.alerts || []).map(a => `- [${a.severity}] ${a.company || a.stage || 'General'}: ${a.recommendation}`).join('\n')}`
    : 'No deal intelligence available';

  const meetingsContext = meetings
    .filter(m => m.status === 'open' || m.upcoming)
    .map(m => `${m.date} — ${m.title} (${m.people}) | ${m.action || 'no action'} | ${m.upcoming ? 'UPCOMING' : 'needs follow-up'}`)
    .join('\n');

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You are the AI Chief of Staff for Mike True, Co-founder & CEO of Prescient AI. Today is ${todayStr}. Generate an end-of-day recap and tomorrow plan.

Return a JSON object:

{
  "summary": "2-3 sentence executive summary of the day — what was accomplished, what moved",
  "wins": [
    { "title": "Short win title", "detail": "Why this matters" }
  ],
  "dealChanges": [
    { "company": "Name", "change": "What changed", "significance": "high|medium|low" }
  ],
  "looseEnds": [
    { "company": "Name", "issue": "What's unresolved", "urgency": "high|medium|low" }
  ],
  "crmHygiene": [
    { "company": "Name", "issue": "What needs updating in HubSpot", "actionType": "update_stage|add_note|update_close_date" }
  ],
  "tomorrowPriorities": [
    {
      "rank": 1,
      "actionId": <matching action id or null>,
      "company": "Name",
      "reason": "Why this should be first tomorrow",
      "urgency": "critical|high|medium",
      "suggestedAction": "draft|prep|post-call|crm|slack|linkedin|proposal"
    }
  ],
  "recommendations": [
    {
      "type": "suggested_email|update_hubspot|move_stage|log_notes|pull_email_thread|pull_call_notes|draft_proposal|draft_follow_up|archive_item|prep_meeting",
      "title": "Short action title",
      "reason": "Why this is recommended",
      "priority": "high|medium|low",
      "targetCompany": "Company Name",
      "targetId": <action id or null>,
      "actionable": true,
      "actionType": "open_crm_editor|preset_deal_stage|pull_email_thread|pull_call_notes|draft_email_reply|draft_follow_up|draft_proposal|select_item|archive_item",
      "actionPayload": { "stage": "Closed Lost" }
    }
  ],
  "tomorrowOrder": [100, 103, ...],
  "metrics": {
    "actionsHandled": <number>,
    "dealsProgressed": <number>,
    "closedWonValue": <number>,
    "closedLostValue": <number>,
    "netPipelineChange": <number>,
    "openRemaining": <number>
  }
}

Rules:
- 3-7 recommendations, high-signal, actionable
- tomorrowPriorities: max 5, ranked by urgency for tomorrow morning
- If diff data is available, use REAL changes, not inference
- Be specific about which deals moved, what notes are missing, what emails need replies
- CRM hygiene: flag deals with outdated stages, missing notes, or wrong close dates
- tomorrowOrder: all open action IDs in recommended order for tomorrow
- Only reference actionTypes that exist: open_crm_editor, preset_deal_stage, pull_email_thread, pull_call_notes, draft_email_reply, draft_follow_up, draft_proposal, select_item, archive_item

Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `TODAY: ${todayStr}\n\n` +
            `COMPLETED TODAY (${doneActions.length}):\n${completedContext || 'None'}\n\n` +
            `STILL OPEN (${openActions.length}):\n${actionsContext}\n\n` +
            `PIPELINE DIFF:\n${diffContext}\n\n` +
            `PIPELINE (${pipeline.length} deals):\n${pipelineContext}\n\n` +
            `MEETINGS:\n${meetingsContext || 'None'}\n\n` +
            `DEAL INTELLIGENCE:\n${intelligenceContext}\n\n` +
            `ARCHIVED TODAY: ${archivedActions.length}`,
        }],
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Claude API error: ${err}` });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '{}';

    let endOfDay;
    try {
      endOfDay = JSON.parse(text);
    } catch {
      endOfDay = { summary: text, wins: [], dealChanges: [], looseEnds: [], crmHygiene: [], tomorrowPriorities: [], recommendations: [], tomorrowOrder: openActions.map(a => a.id), metrics: {} };
    }

    // Inject diff metrics if AI didn't compute them
    if (!endOfDay.metrics || !endOfDay.metrics.actionsHandled) {
      endOfDay.metrics = {
        actionsHandled: doneActions.length + archivedActions.length,
        dealsProgressed: diff?.summary?.stageChangesCount || 0,
        closedWonValue: diff?.summary?.closedWonValue || 0,
        closedLostValue: diff?.summary?.closedLostValue || 0,
        netPipelineChange: diff?.summary?.netPipelineChange || 0,
        openRemaining: openActions.length,
        ...endOfDay.metrics,
      };
    }

    return res.status(200).json({ success: true, endOfDay, diff: diff || null });
  } catch (err) {
    console.error('End of day error:', err);
    return res.status(500).json({ error: 'End of day generation failed' });
  }
}
