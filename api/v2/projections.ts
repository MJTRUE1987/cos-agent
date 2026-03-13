/**
 * GET /api/v2/projections — Read model endpoints.
 *
 * Every projection returns one of two states:
 * A. Real data: { success: true, source: "hubspot"|"gmail"|"calendar", ... }
 * B. Real failure: { success: false, error: "...", source: "hubspot"|"gmail"|"calendar" }
 *
 * Never returns fake success. Never returns fallback data.
 */

import { safeHandler } from './_handler.js';
import { buildPipelineProjection, IntegrationError } from '../../server/projections/pipelineProjection.js';
import { buildInboxProjection } from '../../server/projections/inboxProjection.js';
import { buildApprovalProjection } from '../../server/projections/approvalProjection.js';
import { buildDealTimeline } from '../../server/projections/dealTimelineProjection.js';
import { buildCalendarProjection } from '../../server/projections/calendarProjection.js';
import { getTool } from '../../server/tools/registry.js';

export default safeHandler('projections', async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { type, deal_id, query } = req.query;

  switch (type) {
    case 'pipeline': {
      try {
        const view = await buildPipelineProjection();
        return res.status(200).json({ success: true, ...view });
      } catch (err: any) {
        if (err instanceof IntegrationError) {
          return res.status(200).json({ success: false, error: err.message, source: err.source });
        }
        throw err;
      }
    }
    case 'inbox':
    case 'inbox_important': {
      try {
        // Both 'inbox' and 'inbox_important' use the same Important Inbox mode
        const view = await buildInboxProjection(query as string);
        return res.status(200).json({ success: true, ...view });
      } catch (err: any) {
        if (err instanceof IntegrationError) {
          return res.status(200).json({ success: false, error: err.message, source: err.source });
        }
        throw err;
      }
    }
    case 'calendar': {
      try {
        const view = await buildCalendarProjection();
        return res.status(200).json({ success: true, ...view });
      } catch (err: any) {
        if (err instanceof IntegrationError) {
          return res.status(200).json({ success: false, error: err.message, source: err.source });
        }
        throw err;
      }
    }
    case 'approvals': {
      const view = await buildApprovalProjection();
      return res.status(200).json({ success: true, ...view });
    }
    case 'deal_timeline': {
      if (!deal_id) return res.status(400).json({ success: false, error: 'deal_id required for deal_timeline' });
      const view = await buildDealTimeline(deal_id as string);
      return res.status(200).json({ success: true, ...view });
    }
    case 'health': {
      const health = await checkIntegrationHealth();
      return res.status(200).json({ success: true, ...health });
    }
    default:
      return res.status(400).json({
        success: false,
        error: 'Unknown projection type',
        available: ['pipeline', 'inbox', 'inbox_important', 'calendar', 'approvals', 'deal_timeline', 'health'],
      });
  }
});

/** Check real connectivity to each integration */
async function checkIntegrationHealth() {
  const results: Record<string, { status: 'connected' | 'failed'; error?: string; checked_at: string }> = {};

  // HubSpot
  try {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN not set');
    const r = await fetch('https://api.hubapi.com/crm/v3/objects/deals?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.hubspot = { status: 'connected', checked_at: new Date().toISOString() };
  } catch (err: any) {
    results.hubspot = { status: 'failed', error: err.message, checked_at: new Date().toISOString() };
  }

  // Gmail
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) throw new Error('Google OAuth credentials not set');
    const tokenR = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenR.json();
    if (!tokenData.access_token) throw new Error('OAuth token refresh failed');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.gmail = { status: 'connected', checked_at: new Date().toISOString() };
  } catch (err: any) {
    results.gmail = { status: 'failed', error: err.message, checked_at: new Date().toISOString() };
  }

  // Google Calendar
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) throw new Error('Google OAuth credentials not set');
    const tokenR = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenR.json();
    if (!tokenData.access_token) throw new Error('OAuth token refresh failed');
    const r = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary?fields=summary', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.calendar = { status: 'connected', checked_at: new Date().toISOString() };
  } catch (err: any) {
    results.calendar = { status: 'failed', error: err.message, checked_at: new Date().toISOString() };
  }

  // Granola
  try {
    const granolaToken = process.env.GRANOLA_API_KEY;
    if (!granolaToken) throw new Error('GRANOLA_API_KEY not set');
    const r = await fetch('https://api.granola.ai/v1/notes?limit=1', {
      headers: { Authorization: `Bearer ${granolaToken}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.granola = { status: 'connected', checked_at: new Date().toISOString() };
  } catch (err: any) {
    results.granola = { status: 'failed', error: err.message, checked_at: new Date().toISOString() };
  }

  return {
    integrations: results,
    generated_at: new Date().toISOString(),
  };
}
