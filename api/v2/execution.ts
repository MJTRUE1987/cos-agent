/**
 * /api/v2/execution — Execution run management.
 */

import { safeHandler } from './_handler.js';
import { getExecutionRun, cancelExecution } from '../../server/agent/executor.js';

export default safeHandler('execution', async (req, res) => {
  if (req.method === 'GET') {
    const { run_id } = req.query;
    if (!run_id) return res.status(400).json({ success: false, error: 'run_id required' });

    const data = await getExecutionRun(run_id as string);
    if (!data) return res.status(404).json({ success: false, error: 'Execution run not found' });

    return res.status(200).json({
      success: true,
      run: data.run,
      plan: {
        plan_id: data.plan.plan_id,
        steps: data.plan.steps.map(s => ({
          step_id: s.step_id,
          sequence: s.sequence,
          tool: s.tool,
          description: s.description,
          status: s.status,
          error: s.error,
        })),
      },
    });
  }

  if (req.method === 'POST') {
    const { action, run_id } = req.body || {};
    if (action === 'cancel') {
      if (!run_id) return res.status(400).json({ success: false, error: 'run_id required' });
      const cancelled = await cancelExecution(run_id);
      return res.status(200).json({ success: true, cancelled });
    }
    return res.status(400).json({ success: false, error: 'Unknown action', available: ['cancel'] });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
});
