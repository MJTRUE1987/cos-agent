/**
 * Safe JSON handler wrapper for all v2 API routes.
 * Guarantees:
 * - Always returns JSON, never HTML
 * - CORS headers on every response
 * - Catches all errors including import/init failures
 * - Consistent error shape: { success: false, error: "...", details?: ... }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<any>;

export function safeHandler(name: string, fn: Handler): Handler {
  return async (req: VercelRequest, res: VercelResponse) => {
    // CORS on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    try {
      return await fn(req, res);
    } catch (err: any) {
      console.error(`[v2/${name}] Unhandled error:`, err?.message || err);
      // Always return JSON
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          error: err?.message || 'Internal server error',
          endpoint: `/api/v2/${name}`,
          details: process.env.VERCEL_ENV !== 'production' ? err?.stack : undefined,
        });
      }
    }
  };
}
