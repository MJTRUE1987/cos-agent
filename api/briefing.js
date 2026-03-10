// AI Daily Briefing API
// Analyzes full dashboard state and returns a prioritized daily game plan
// Consumes deal intelligence alerts when available

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { actions = [], meetings = [], pipeline = [], calendarEvents = [], dealIntelligence = null } = req.body || {};

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY required' });

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Build context for Claude — compact format to stay under token limits
  const openActions = actions.filter(a => a.status === 'open');
  const actionsContext = openActions.map(a => {
    const days = a.lastActivity ? Math.floor((today - new Date(a.lastActivity)) / 86400000) : '?';
    return `[id:${a.id}] ${a.company} (${a.cat}) — ${a.task.substring(0, 120)} | ${days}d stale | ${a.dealValue ? '$' + (a.dealValue / 1000) + 'K' : 'no value'} | AI rec: ${a.aiRec || 'none'}`;
  }).join('\n');

  const meetingsContext = meetings
    .filter(m => m.upcoming || m.status === 'open')
    .map(m => `${m.date} — ${m.title} (${m.people}) | ${m.action || 'no action'} | ${m.upcoming ? 'UPCOMING' : 'needs follow-up'}`)
    .join('\n');

  const pipelineContext = pipeline
    .filter(d => d.stage !== 'Nurture' && d.stage !== 'Booking')
    .map(d => {
      const closeStr = d.close ? new Date(d.close).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'no date';
      return `${d.name} — ${d.stage} | $${((d.amount || 0) / 1000).toFixed(0)}K | ${d.owner || 'unassigned'} | close: ${closeStr}`;
    })
    .join('\n');

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
        max_tokens: 3000,
        system: `You are the AI Chief of Staff for Mike True, Co-founder & CEO of Prescient AI (marketing mix modeling platform). Today is ${todayStr}.

Analyze Mike's full dashboard state and create a prioritized daily briefing. Return a JSON object:

{
  "summary": "2-3 sentence executive summary of the day — what matters most and why",
  "priorities": [
    {
      "rank": 1,
      "actionId": <matching action id from the list>,
      "company": "Company Name",
      "reason": "Why this is priority #1 — be specific about urgency, deal value, or relationship context",
      "urgency": "critical|high|medium",
      "suggestedAction": "draft|prep|post-call|crm|slack|linkedin"
    }
  ],
  "risks": [
    {
      "type": "stalled_deal|overdue|missed_followup|pipeline_gap",
      "company": "Company Name",
      "detail": "What's at risk and why"
    }
  ],
  "todaysMeetings": [
    {
      "title": "Meeting title",
      "time": "Time from the date field",
      "prepSuggestion": "1-sentence prep recommendation"
    }
  ],
  "triageOrder": [100, 103, 104, ...],
  "quickWins": ["1-2 things that take <2 min and clear the deck"]
}

Rules:
- Top 5 priorities max. Be ruthless about what matters TODAY.
- Consider: deal value, staleness, meeting timing, referral relationships, inbound freshness
- triageOrder should list ALL open action IDs in recommended order
- Meetings happening TODAY are always mentioned
- Quick wins = things like "bump Jupiter (they said they'd book this week)" or "archive stale internal ops"

Return ONLY valid JSON.`,
        messages: [{
          role: 'user',
          content: `TODAY: ${todayStr}\n\n` +
            `OPEN ACTIONS (${openActions.length}):\n${actionsContext}\n\n` +
            `MEETINGS:\n${meetingsContext}\n\n` +
            `PIPELINE:\n${pipelineContext}\n\n` +
            `DEAL INTELLIGENCE:\n${intelligenceContext}`,
        }],
      }),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Claude API error: ${err}` });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '{}';

    let briefing;
    try {
      briefing = JSON.parse(text);
    } catch {
      // If Claude returns non-JSON, wrap it
      briefing = {
        summary: text,
        priorities: [],
        risks: [],
        todaysMeetings: [],
        triageOrder: openActions.map(a => a.id),
        quickWins: [],
      };
    }

    return res.status(200).json({ success: true, briefing });
  } catch (err) {
    console.error('Briefing error:', err);
    return res.status(500).json({ error: 'Briefing generation failed' });
  }
}
