/**
 * calendar.get_events — Fetch calendar events for a date range.
 * Wraps: api/calendar.js
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

export const calendarGetEvents: ToolAdapter = {
  contract: {
    name: 'calendar.get_events',
    version: 1,
    description: 'Fetch calendar events for a date range',
    category: 'calendar',
    source_system: 'google_calendar',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'read_only' },
    side_effects: [],
    retry: { max_retries: 3, backoff: 'exponential', base_delay_ms: 1000, retryable_errors: ['429', '503'] },
    timeout_ms: 10000,
  },

  async execute(inputs: { start: string; end: string }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();

    try {
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
      if (!tokenData.access_token) throw new Error('Calendar auth failed');

      const calR = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
        `timeMin=${encodeURIComponent(inputs.start)}&timeMax=${encodeURIComponent(inputs.end)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
      );

      if (!calR.ok) {
        const err = await calR.text();
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: String(calR.status), message: err, retryable: calR.status === 429 },
        };
      }

      const calData = await calR.json();
      const internalDomains = ['prescientai.com', 'prescient.ai'];

      const meetings = (calData.items || []).map((event: any) => {
        const attendees = (event.attendees || []).filter((a: any) => !a.self);
        const externalAttendees = attendees.filter((a: any) =>
          a.email && !internalDomains.some((d: string) => a.email.endsWith('@' + d))
        );

        return {
          event_id: event.id,
          title: event.summary || '(No title)',
          start: event.start?.dateTime || event.start?.date,
          end: event.end?.dateTime || event.end?.date,
          attendees: attendees.map((a: any) => ({
            name: a.displayName || a.email?.split('@')[0],
            email: a.email,
            response_status: a.responseStatus,
          })),
          is_external: externalAttendees.length > 0,
          location: event.location || '',
          meet_link: event.hangoutLink || '',
          html_link: event.htmlLink,
        };
      });

      return {
        success: true,
        outputs: { events: meetings },
        events: [],
        side_effects_performed: [],
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'CALENDAR_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
