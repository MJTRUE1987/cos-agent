// End of Week Briefing API
// Generates weekly recap: pipeline movement, wins/losses, next week priorities, recommendations
// Consumes weekly pipeline diff (snapshot comparison) + intelligence + current state

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { actions = [], meetings = [], pipeline = [], calendarEvents = [], diff = null, dealIntelligence = null } = req.body || {};

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY required' });

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const weekStart = getWeekStart(today);
  const weekStr = `Week of ${weekStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;

  // Build context
  const openActions = actions.filter(a => a.status === 'open');
  const weekAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const allDone = actions.filter(a => a.status === 'done');
  const doneActions = allDone.filter(a => a.lastActivity && a.lastActivity >= weekAgoStr);
  const doneForPrompt = doneActions.length > 0 ? doneActions : allDone;

  const actionsContext = openActions.map(a => {
    const days = a.lastActivity ? Math.floor((today - new Date(a.lastActivity)) / 86400000) : '?';
    return `[id:${a.id}] ${a.company} (${a.cat}) — ${(a.task || '').substring(0, 100)} | ${days}d stale | ${a.dealValue ? '$' + (a.dealValue / 1000) + 'K' : 'no value'}`;
  }).join('\n');

  const pipelineContext = pipeline
    .filter(d => d.stage !== 'Nurture' && d.stage !== 'Booking')
    .map(d => {
      const closeStr = d.close ? new Date(d.close).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no date';
      return `${d.name} — ${d.stage} | $${((d.amount || 0) / 1000).toFixed(0)}K | ${d.owner || 'unassigned'} | close: ${closeStr}`;
    })
    .join('\n');

  const diffContext = diff?.hasSnapshot ? [
    `NEW DEALS THIS WEEK: ${diff.newDeals.length}`,
    ...diff.newDeals.map(d => `  + ${d.name} (${d.stage}) $${((d.amount || 0) / 1000).toFixed(0)}K`),
    `STAGE MOVEMENTS: ${diff.stageChanges.length}`,
    ...diff.stageChanges.map(d => `  ${d.name}: ${d.from} → ${d.to}`),
    `CLOSED WON: ${diff.closedWon.length} ($${((diff.summary?.closedWonValue || 0) / 1000).toFixed(0)}K)`,
    ...diff.closedWon.map(d => `  ✓ ${d.name} $${((d.amount || 0) / 1000).toFixed(0)}K from ${d.previousStage}`),
    `CLOSED LOST: ${diff.closedLost.length} ($${((diff.summary?.closedLostValue || 0) / 1000).toFixed(0)}K)`,
    ...diff.closedLost.map(d => `  ✕ ${d.name} $${((d.amount || 0) / 1000).toFixed(0)}K from ${d.previousStage}`),
    `AMOUNT CHANGES: ${diff.amountChanges.length}`,
    ...diff.amountChanges.map(d => `  ${d.name}: $${((d.from || 0) / 1000).toFixed(0)}K → $${((d.to || 0) / 1000).toFixed(0)}K (${d.delta > 0 ? '+' : ''}$${(d.delta / 1000).toFixed(0)}K)`),
    `ACTIONS COMPLETED THIS WEEK: ${diff.actionsCompleted?.length || 0}`,
    `ACTIONS CREATED THIS WEEK: ${diff.actionsCreated?.length || 0}`,
    `NET PIPELINE CHANGE: $${((diff.summary?.netPipelineChange || 0) / 1000).toFixed(0)}K`,
  ].join('\n') : 'No weekly snapshot available — showing current state only';

  const intelligenceContext = dealIntelligence
    ? `Pipeline Health: ${dealIntelligence.pipelineHealth?.score || '?'}/100\nAlerts:\n${(dealIntelligence.alerts || []).map(a => `- [${a.severity}] ${a.company || a.stage || 'General'}: ${a.recommendation}`).join('\n')}`
    : 'No deal intelligence available';

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
        max_tokens: 5000,
        system: `You are the AI Chief of Staff for Mike True, Co-founder & CEO of Prescient AI. Today is ${todayStr} (${weekStr}). Generate an end-of-week recap and next week plan.

Return a JSON object:

{
  "weeklySummary": "3-4 sentence executive summary of the week — key wins, pipeline movement, overall health",
  "biggestWins": [
    { "title": "Short win title", "detail": "Why this matters", "value": <dollar amount or null> }
  ],
  "newDeals": [
    { "company": "Name", "stage": "Current Stage", "amount": <value>, "source": "inbound|outbound|referral|unknown" }
  ],
  "stageMovements": [
    { "company": "Name", "from": "Previous Stage", "to": "Current Stage", "direction": "forward|backward", "significance": "high|medium|low" }
  ],
  "closedWon": [
    { "company": "Name", "amount": <value>, "previousStage": "Stage before closing" }
  ],
  "closedLost": [
    { "company": "Name", "amount": <value>, "reason": "Likely reason based on context" }
  ],
  "stalledDeals": [
    { "company": "Name", "stage": "Stage", "amount": <value>, "daysSinceActivity": <number>, "risk": "Description of risk" }
  ],
  "crmHygiene": [
    { "company": "Name", "issue": "What needs cleanup", "actionType": "update_stage|add_note|update_close_date" }
  ],
  "nextWeekPriorities": [
    {
      "rank": 1,
      "actionId": <matching action id or null>,
      "company": "Name",
      "reason": "Why this should be priority next week",
      "urgency": "critical|high|medium",
      "suggestedAction": "draft|prep|post-call|crm|slack|linkedin|proposal"
    }
  ],
  "recommendations": [
    {
      "type": "suggested_email|update_hubspot|move_stage|log_notes|pull_email_thread|pull_call_notes|draft_proposal|draft_follow_up|archive_item|prep_meeting|reorder_priorities",
      "title": "Short action title",
      "reason": "Why this is recommended",
      "priority": "high|medium|low",
      "targetCompany": "Company Name",
      "targetId": <action id or null>,
      "actionable": true,
      "actionType": "open_crm_editor|preset_deal_stage|pull_email_thread|pull_call_notes|draft_email_reply|draft_follow_up|draft_proposal|select_item|archive_item|accept_next_week_plan",
      "actionPayload": {}
    }
  ],
  "nextWeekOrder": [100, 103, ...],
  "metrics": {
    "actionsHandledThisWeek": <number>,
    "newDealsCount": <number>,
    "dealsProgressed": <number>,
    "closedWonCount": <number>,
    "closedWonValue": <number>,
    "closedLostCount": <number>,
    "closedLostValue": <number>,
    "netPipelineChange": <number>,
    "openRemaining": <number>,
    "pipelineHealth": <0-100>
  }
}

Rules:
- 3-7 recommendations, high-signal, actionable
- nextWeekPriorities: max 7, ranked by urgency for Monday morning
- If diff data is available, use REAL changes, not inference
- Stalled deals: anything in active stage with 7+ days since activity
- CRM hygiene: flag outdated stages, missing notes, wrong close dates, no-owner deals
- nextWeekOrder: all open action IDs in recommended order for next week
- Only reference actionTypes that exist: open_crm_editor, preset_deal_stage, pull_email_thread, pull_call_notes, draft_email_reply, draft_follow_up, draft_proposal, select_item, archive_item, accept_next_week_plan

Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `TODAY: ${todayStr} (${weekStr})\n\n` +
            `COMPLETED THIS WEEK (${doneForPrompt.length}):\n${doneForPrompt.map(a => `  ✓ ${a.company} — ${(a.task || '').substring(0, 60)}`).join('\n') || 'None'}\n\n` +
            `STILL OPEN (${openActions.length}):\n${actionsContext}\n\n` +
            `WEEKLY PIPELINE DIFF:\n${diffContext}\n\n` +
            `PIPELINE (${pipeline.length} deals):\n${pipelineContext}\n\n` +
            `CALENDAR EVENTS:\n${(calendarEvents || []).slice(0, 15).map(e => `${e.date || e.start || ''} | ${e.title || e.summary || ''} | ${(e.attendees || e.people || '').toString().substring(0, 100)}${e.isExternal ? ' [EXTERNAL]' : ''}`).join('\n') || 'No calendar events'}\n\n` +
            `DEAL INTELLIGENCE:\n${intelligenceContext}`,
        }],
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Claude API error: ${err}` });
    }

    const aiData = await aiRes.json();
    let text = aiData.content?.[0]?.text || '{}';
    // Strip markdown code fences if Claude wraps JSON in ```json ... ```
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    let endOfWeek;
    try {
      endOfWeek = JSON.parse(text);
    } catch {
      endOfWeek = { weeklySummary: text, biggestWins: [], newDeals: [], stageMovements: [], closedWon: [], closedLost: [], stalledDeals: [], crmHygiene: [], nextWeekPriorities: [], recommendations: [], nextWeekOrder: openActions.map(a => a.id), metrics: {} };
    }

    // Inject diff metrics
    if (!endOfWeek.metrics || !endOfWeek.metrics.actionsHandledThisWeek) {
      endOfWeek.metrics = {
        actionsHandledThisWeek: doneActions.length,
        newDealsCount: diff?.summary?.newDealsCount || 0,
        dealsProgressed: diff?.summary?.stageChangesCount || 0,
        closedWonCount: diff?.summary?.closedWonCount || 0,
        closedWonValue: diff?.summary?.closedWonValue || 0,
        closedLostCount: diff?.summary?.closedLostCount || 0,
        closedLostValue: diff?.summary?.closedLostValue || 0,
        netPipelineChange: diff?.summary?.netPipelineChange || 0,
        openRemaining: openActions.length,
        pipelineHealth: dealIntelligence?.pipelineHealth?.score || null,
        ...endOfWeek.metrics,
      };
    }

    return res.status(200).json({ success: true, endOfWeek, diff: diff || null });
  } catch (err) {
    console.error('End of week error:', err);
    return res.status(500).json({ error: 'End of week generation failed' });
  }
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
