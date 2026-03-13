/**
 * /api/v2/failures — Failure capture, listing, resolution, and replay.
 *
 * GET  ?failure_id=xxx         → single failure
 * GET  ?type=repeated          → repeated failures
 * GET  ?limit=N&unresolved_only=true&error_type=xxx → list failures
 * POST { action: 'resolve', failure_id, resolution }
 * POST { action: 'replay', failure_id }
 * POST { action: 'capture_frontend', ... }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { safeHandler } from './_handler.js';
import {
  captureFailure,
  getFailures,
  getFailure,
  getRepeatedFailures,
  resolveFailure,
} from '../../server/failure/failureStore.js';
import { replayFailure } from '../../server/failure/replayEngine.js';

export default safeHandler('failures', async (req: VercelRequest, res: VercelResponse) => {
  // ── GET ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { failure_id, type, limit, unresolved_only, error_type } = req.query;

    // Single failure lookup
    if (failure_id && typeof failure_id === 'string') {
      const record = await getFailure(failure_id);
      if (!record) {
        return res.status(404).json({ success: false, error: 'Failure not found' });
      }
      return res.status(200).json({ success: true, failure: record });
    }

    // Repeated failures
    if (type === 'repeated') {
      const repeated = await getRepeatedFailures();
      return res.status(200).json({ success: true, repeated });
    }

    // List failures with filters
    const records = await getFailures({
      limit: limit ? parseInt(String(limit), 10) : undefined,
      unresolved_only: unresolved_only === 'true',
      error_type: error_type ? String(error_type) : undefined,
    });

    return res.status(200).json({ success: true, failures: records, count: records.length });
  }

  // ── POST ────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { action } = body;

    // Resolve a failure
    if (action === 'resolve') {
      const { failure_id, resolution } = body;
      if (!failure_id || !resolution) {
        return res.status(400).json({
          success: false,
          error: 'Missing failure_id or resolution',
        });
      }
      const ok = await resolveFailure(failure_id, resolution);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Failure not found' });
      }
      return res.status(200).json({ success: true, resolved: true });
    }

    // Replay a failure
    if (action === 'replay') {
      const { failure_id } = body;
      if (!failure_id) {
        return res.status(400).json({ success: false, error: 'Missing failure_id' });
      }
      const result = await replayFailure(failure_id);
      return res.status(200).json({ success: true, replay: result });
    }

    // Capture a frontend error
    if (action === 'capture_frontend') {
      const record = await captureFailure({
        error_type: body.error_type || 'frontend_error',
        error_message: body.error_message || 'Unknown frontend error',
        stack: body.stack,
        severity: body.severity || 'medium',
        session_id: body.session_id,
        ui_snapshot: body.ui_snapshot,
        backend_snapshot: body.metadata,
      });
      return res.status(201).json({ success: true, failure_id: record.failure_id });
    }

    return res.status(400).json({
      success: false,
      error: `Unknown action: ${action}. Expected: resolve, replay, capture_frontend`,
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
});
