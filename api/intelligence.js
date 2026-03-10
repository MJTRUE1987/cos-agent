// Deal Intelligence API
// Analyzes pipeline data: stalled deals, overdue close dates, stage concentration, velocity
// Combines deterministic checks with Claude synthesis for recommendations

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pipeline = [], actions = [], meetings = [] } = req.body || {};
  if (!pipeline.length) return res.status(400).json({ error: 'pipeline required' });

  const today = new Date();
  const alerts = [];

  // ── Deterministic Analysis ──

  const activeStages = ['Disco Booked', 'Disco Complete', 'Demo Scheduled', 'Demo Completed', 'Negotiating', 'Committed'];
  const activePipeline = pipeline.filter(d => activeStages.includes(d.stage));

  // 1. Stalled deals — no activity in 5+ days
  activePipeline.forEach(deal => {
    const companyLower = (deal.name || '').toLowerCase();
    // Cross-reference with actions to find most recent activity
    const relatedActions = actions.filter(a =>
      a.company && companyLower.includes(a.company.toLowerCase())
    );
    const latestActivity = relatedActions.reduce((latest, a) => {
      if (!a.lastActivity) return latest;
      const d = new Date(a.lastActivity);
      return d > latest ? d : latest;
    }, new Date(0));

    // Also check deal's own close date as a proxy for last touch
    const daysSinceActivity = latestActivity.getTime() > 0
      ? Math.floor((today - latestActivity) / 86400000)
      : null;

    if (daysSinceActivity !== null && daysSinceActivity >= 5 && deal.stage !== 'Committed') {
      alerts.push({
        type: 'stalled_deal',
        severity: daysSinceActivity >= 10 ? 'high' : 'medium',
        dealId: deal.id,
        company: deal.name,
        stage: deal.stage,
        amount: deal.amount,
        daysSinceActivity,
        recommendation: `${daysSinceActivity} days since last activity in ${deal.stage}. Follow up now.`,
      });
    }
  });

  // 2. Overdue close dates
  activePipeline.forEach(deal => {
    if (!deal.close) return;
    const closeDate = new Date(deal.close);
    if (closeDate < today && deal.stage !== 'Committed' && deal.stage !== 'Closed Won') {
      const daysOverdue = Math.floor((today - closeDate) / 86400000);
      alerts.push({
        type: 'overdue_close',
        severity: daysOverdue >= 14 ? 'high' : 'medium',
        dealId: deal.id,
        company: deal.name,
        stage: deal.stage,
        amount: deal.amount,
        expectedClose: deal.close,
        daysOverdue,
        recommendation: `Close date was ${closeDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (${daysOverdue}d ago). Update timeline or push to close.`,
      });
    }
  });

  // 3. Stage concentration (>40% of active deals in one stage)
  if (activePipeline.length >= 8) {
    const stageCounts = {};
    activePipeline.forEach(d => {
      stageCounts[d.stage] = (stageCounts[d.stage] || 0) + 1;
    });
    Object.entries(stageCounts).forEach(([stage, count]) => {
      const pct = Math.round((count / activePipeline.length) * 100);
      if (pct > 40) {
        alerts.push({
          type: 'concentration_risk',
          severity: 'medium',
          stage,
          count,
          total: activePipeline.length,
          percentage: pct,
          recommendation: `${pct}% of active deals (${count}/${activePipeline.length}) are in ${stage}. Potential conversion bottleneck.`,
        });
      }
    });
  }

  // 4. No-owner deals
  activePipeline.forEach(deal => {
    if (!deal.owner) {
      alerts.push({
        type: 'no_owner',
        severity: 'low',
        dealId: deal.id,
        company: deal.name,
        stage: deal.stage,
        amount: deal.amount,
        recommendation: `No owner assigned. Someone needs to own this deal.`,
      });
    }
  });

  // ── Pipeline Health Metrics ──
  const stageDistribution = {};
  const stageAmounts = {};
  activePipeline.forEach(d => {
    stageDistribution[d.stage] = (stageDistribution[d.stage] || 0) + 1;
    stageAmounts[d.stage] = (stageAmounts[d.stage] || 0) + (d.amount || 0);
  });

  const totalActive = activePipeline.length;
  const totalValue = activePipeline.reduce((s, d) => s + (d.amount || 0), 0);
  const atRiskValue = alerts
    .filter(a => a.severity === 'high' && a.amount)
    .reduce((s, a) => s + (a.amount || 0), 0);

  // Sort alerts: high first, then medium, then low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));

  // ── Claude Synthesis (optional) ──
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let aiSummary = null;
  let healthScore = null;

  if (anthropicKey && activePipeline.length > 0) {
    try {
      const context = [
        `Active pipeline: ${totalActive} deals, ${formatMoney(totalValue)} total value`,
        `Stage distribution: ${Object.entries(stageDistribution).map(([s, c]) => `${s}: ${c} (${formatMoney(stageAmounts[s])})`).join(', ')}`,
        `Alerts found: ${alerts.length} (${alerts.filter(a => a.severity === 'high').length} high, ${alerts.filter(a => a.severity === 'medium').length} medium)`,
        `At-risk value: ${formatMoney(atRiskValue)}`,
        '',
        'Alerts:',
        ...alerts.map(a => `- [${a.severity.toUpperCase()}] ${a.company || a.stage}: ${a.recommendation}`),
      ].join('\n');

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: `You are a sales ops analyst for Prescient AI. Given pipeline data and alerts, return a JSON object:
{
  "healthScore": 0-100 (100 = healthy, 0 = critical),
  "summary": "1-2 sentence executive summary of pipeline health",
  "topRecommendation": "The single most important action to take today"
}
Return ONLY valid JSON.`,
          messages: [{ role: 'user', content: context }],
        }),
      });
      const aiData = await aiRes.json();
      try {
        const parsed = JSON.parse(aiData.content?.[0]?.text || '{}');
        healthScore = parsed.healthScore;
        aiSummary = parsed.summary;
        if (parsed.topRecommendation) {
          // Prepend as a special alert
          alerts.unshift({
            type: 'ai_recommendation',
            severity: 'high',
            recommendation: parsed.topRecommendation,
          });
        }
      } catch {
        aiSummary = aiData.content?.[0]?.text || null;
      }
    } catch (err) {
      console.error('Intelligence AI error:', err);
    }
  }

  // Fallback health score if AI didn't provide one
  if (healthScore === null) {
    const highAlerts = alerts.filter(a => a.severity === 'high').length;
    const medAlerts = alerts.filter(a => a.severity === 'medium').length;
    healthScore = Math.max(0, Math.min(100, 100 - (highAlerts * 15) - (medAlerts * 5)));
  }

  return res.status(200).json({
    success: true,
    intelligence: {
      alerts,
      pipelineHealth: {
        score: healthScore,
        totalActive,
        totalValue,
        totalAtRisk: atRiskValue,
        stageDistribution,
        stageAmounts,
      },
      summary: aiSummary || `${alerts.filter(a => a.severity === 'high').length} high-priority alerts. ${formatMoney(atRiskValue)} at risk.`,
    },
  });
}

function formatMoney(n) {
  if (!n) return '$0';
  return '$' + (n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : (n / 1000).toFixed(0) + 'K');
}
