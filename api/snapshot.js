// Pipeline Snapshot API
// Saves and retrieves point-in-time snapshots for diff comparison
// Used by End My Day (daily diff) and End of Week (weekly diff)

let kv = null;
try {
  const kvModule = await import('@vercel/kv');
  kv = kvModule.kv;
} catch (e) {
  // KV not configured
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body || {};

  try {
    switch (action) {
      case 'save_daily': {
        // Save end-of-day snapshot — called at Start My Day or first load
        const { pipeline = [], actions = [] } = req.body;
        const snapshot = {
          timestamp: new Date().toISOString(),
          date: new Date().toISOString().split('T')[0],
          pipeline: pipeline.map(d => ({
            id: d.id, name: d.name, stage: d.stage, dealstage: d.dealstage,
            amount: d.amount, close: d.close, owner: d.owner,
          })),
          actions: actions.map(a => ({
            id: a.id, company: a.company, status: a.status, cat: a.cat,
          })),
          pipelineSummary: {
            totalDeals: pipeline.length,
            totalValue: pipeline.reduce((s, d) => s + (d.amount || 0), 0),
            stageDistribution: countByField(pipeline, 'stage'),
          },
        };

        if (kv) {
          await kv.set('snapshot_daily', snapshot);
          // Also rotate: keep yesterday's snapshot
          const prev = await kv.get('snapshot_daily');
          if (prev && prev.date !== snapshot.date) {
            await kv.set('snapshot_daily_prev', prev);
          }
          await kv.set('snapshot_daily', snapshot);
        }
        return res.status(200).json({ success: true, snapshot });
      }

      case 'save_weekly': {
        // Save start-of-week snapshot — called on Monday or first End of Week request
        const { pipeline = [], actions = [] } = req.body;
        const snapshot = {
          timestamp: new Date().toISOString(),
          weekStart: getWeekStart(new Date()).toISOString().split('T')[0],
          pipeline: pipeline.map(d => ({
            id: d.id, name: d.name, stage: d.stage, dealstage: d.dealstage,
            amount: d.amount, close: d.close, owner: d.owner,
          })),
          actions: actions.map(a => ({
            id: a.id, company: a.company, status: a.status, cat: a.cat,
          })),
          pipelineSummary: {
            totalDeals: pipeline.length,
            totalValue: pipeline.reduce((s, d) => s + (d.amount || 0), 0),
            stageDistribution: countByField(pipeline, 'stage'),
          },
        };

        if (kv) {
          await kv.set('snapshot_weekly', snapshot);
        }
        return res.status(200).json({ success: true, snapshot });
      }

      case 'get_daily': {
        if (!kv) return res.status(200).json({ success: true, snapshot: null });
        const snapshot = await kv.get('snapshot_daily');
        return res.status(200).json({ success: true, snapshot });
      }

      case 'get_weekly': {
        if (!kv) return res.status(200).json({ success: true, snapshot: null });
        const snapshot = await kv.get('snapshot_weekly');
        return res.status(200).json({ success: true, snapshot });
      }

      case 'diff_daily': {
        // Compare current state against daily snapshot
        const { pipeline = [], actions = [] } = req.body;
        const snapshot = kv ? await kv.get('snapshot_daily') : null;
        const diff = computeDiff(snapshot, pipeline, actions);
        return res.status(200).json({ success: true, diff, snapshotDate: snapshot?.date || null });
      }

      case 'diff_weekly': {
        // Compare current state against weekly snapshot
        const { pipeline = [], actions = [] } = req.body;
        const snapshot = kv ? await kv.get('snapshot_weekly') : null;
        const diff = computeDiff(snapshot, pipeline, actions);
        return res.status(200).json({ success: true, diff, snapshotWeekStart: snapshot?.weekStart || null });
      }

      default:
        return res.status(400).json({ error: 'Unknown action. Use: save_daily, save_weekly, get_daily, get_weekly, diff_daily, diff_weekly' });
    }
  } catch (err) {
    console.error('Snapshot error:', err);
    return res.status(500).json({ error: 'Snapshot operation failed' });
  }
}

function computeDiff(snapshot, currentPipeline, currentActions) {
  if (!snapshot) {
    return {
      hasSnapshot: false,
      newDeals: [], stageChanges: [], closedWon: [], closedLost: [],
      amountChanges: [], reopened: [], removed: [],
      actionsCompleted: [], actionsCreated: [],
      summary: { newDealsCount: 0, stageChangesCount: 0, closedWonCount: 0, closedLostCount: 0, closedWonValue: 0, closedLostValue: 0, amountChangesCount: 0, netPipelineChange: 0 },
    };
  }

  const prevMap = new Map(snapshot.pipeline.map(d => [d.id, d]));
  const currMap = new Map(currentPipeline.map(d => [d.id, d]));

  const newDeals = [];
  const stageChanges = [];
  const closedWon = [];
  const closedLost = [];
  const amountChanges = [];
  const reopened = [];
  const removed = [];

  // Check current deals against snapshot
  for (const deal of currentPipeline) {
    const prev = prevMap.get(deal.id);
    if (!prev) {
      newDeals.push({ id: deal.id, name: deal.name, stage: deal.stage, amount: deal.amount });
      continue;
    }
    // Stage change
    const prevStage = prev.stage || prev.dealstage;
    const currStage = deal.stage || deal.dealstage;
    if (prevStage !== currStage) {
      if (currStage === 'Closed Won' || currStage === 'closedwon') {
        closedWon.push({ id: deal.id, name: deal.name, amount: deal.amount, previousStage: prevStage });
      } else if (currStage === 'Closed Lost' || currStage === 'closedlost') {
        closedLost.push({ id: deal.id, name: deal.name, amount: deal.amount, previousStage: prevStage });
      } else if ((prevStage === 'Closed Lost' || prevStage === 'closedlost' || prevStage === 'Closed Won' || prevStage === 'closedwon') && currStage !== prevStage) {
        reopened.push({ id: deal.id, name: deal.name, stage: currStage, amount: deal.amount, previousStage: prevStage });
      } else {
        stageChanges.push({ id: deal.id, name: deal.name, from: prevStage, to: currStage, amount: deal.amount });
      }
    }
    // Amount change
    if (prev.amount !== deal.amount && (prev.amount || deal.amount)) {
      amountChanges.push({ id: deal.id, name: deal.name, from: prev.amount, to: deal.amount, delta: (deal.amount || 0) - (prev.amount || 0) });
    }
  }

  // Deals in snapshot but not in current = removed
  for (const prev of snapshot.pipeline) {
    if (!currMap.has(prev.id)) {
      removed.push({ id: prev.id, name: prev.name, stage: prev.stage, amount: prev.amount });
    }
  }

  // Action diffs
  const prevActionMap = new Map((snapshot.actions || []).map(a => [a.id, a]));
  const actionsCompleted = [];
  const actionsCreated = [];
  for (const a of currentActions) {
    const prev = prevActionMap.get(a.id);
    if (!prev) {
      actionsCreated.push({ id: a.id, company: a.company, status: a.status });
    } else if (prev.status === 'open' && (a.status === 'done' || a.status === 'archived')) {
      actionsCompleted.push({ id: a.id, company: a.company, status: a.status });
    }
  }

  const closedWonValue = closedWon.reduce((s, d) => s + (d.amount || 0), 0);
  const closedLostValue = closedLost.reduce((s, d) => s + (d.amount || 0), 0);
  const prevTotal = snapshot.pipelineSummary?.totalValue || 0;
  const currTotal = currentPipeline.reduce((s, d) => s + (d.amount || 0), 0);

  return {
    hasSnapshot: true,
    newDeals, stageChanges, closedWon, closedLost, amountChanges, reopened, removed,
    actionsCompleted, actionsCreated,
    summary: {
      newDealsCount: newDeals.length,
      stageChangesCount: stageChanges.length,
      closedWonCount: closedWon.length,
      closedLostCount: closedLost.length,
      closedWonValue,
      closedLostValue,
      amountChangesCount: amountChanges.length,
      netPipelineChange: currTotal - prevTotal,
      actionsCompletedCount: actionsCompleted.length,
      actionsCreatedCount: actionsCreated.length,
    },
  };
}

function countByField(arr, field) {
  const counts = {};
  arr.forEach(item => { counts[item[field]] = (counts[item[field]] || 0) + 1; });
  return counts;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
