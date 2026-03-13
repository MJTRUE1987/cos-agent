/**
 * Calendar Projection — Builds calendar insights from real Google Calendar data.
 *
 * Rules:
 * - Real Google Calendar data only — no fallbacks, no placeholder data
 * - Surfaces upcoming external meetings, prep-needed meetings, scheduling state
 * - If Calendar fails, throws with source attribution
 */

import { getTool } from '../tools/registry.js';
import { IntegrationError } from './pipelineProjection.js';

export interface CalendarMeeting {
  event_id: string;
  title: string;
  start: string;
  end: string;
  is_external: boolean;
  attendees: { name: string; email: string; response_status: string }[];
  location: string;
  meet_link: string;
  html_link: string;
  needs_prep: boolean;
  prep_reason?: string;
  time_until: string;     // human-readable
  time_until_ms: number;  // for sorting
}

export interface CalendarView {
  today: CalendarMeeting[];
  upcoming: CalendarMeeting[];   // next 3 business days
  external_count: number;
  needs_prep_count: number;
  next_external?: CalendarMeeting;
  generated_at: string;
  source: 'google_calendar';
}

export async function buildCalendarProjection(): Promise<CalendarView> {
  const calTool = await getTool('calendar.get_events');
  if (!calTool) {
    throw new IntegrationError('calendar', 'Calendar tool not available — check GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Fetch 4 business days ahead
  const futureEnd = new Date(now);
  futureEnd.setDate(futureEnd.getDate() + 5);  // 5 calendar days covers ~4 business days

  const result = await calTool.execute({
    start: todayStart.toISOString(),
    end: futureEnd.toISOString(),
  }, {
    command_id: 'projection',
    execution_run_id: 'projection',
    plan_id: 'projection',
    step_id: 'projection',
    tool_call_id: 'projection',
  });

  if (!result.success) {
    const msg = result.error?.message || 'Google Calendar API call failed';
    throw new IntegrationError('calendar', msg);
  }

  const rawEvents: any[] = result.outputs.events || [];
  const nowMs = now.getTime();

  const allMeetings: CalendarMeeting[] = rawEvents
    .filter(e => e.start)  // must have a start time
    .map(e => {
      const startMs = new Date(e.start).getTime();
      const diffMs = startMs - nowMs;
      const needsPrep = assessPrepNeeded(e, diffMs);

      return {
        event_id: e.event_id,
        title: e.title || '(No title)',
        start: e.start,
        end: e.end,
        is_external: e.is_external || false,
        attendees: e.attendees || [],
        location: e.location || '',
        meet_link: e.meet_link || '',
        html_link: e.html_link || '',
        needs_prep: needsPrep.needed,
        prep_reason: needsPrep.reason,
        time_until: formatTimeUntil(diffMs),
        time_until_ms: diffMs,
      };
    })
    .sort((a, b) => a.time_until_ms - b.time_until_ms);

  // Split into today vs upcoming
  const todayEndMs = todayEnd.getTime();
  const todayMeetings = allMeetings.filter(m => new Date(m.start).getTime() <= todayEndMs);
  const upcomingMeetings = allMeetings.filter(m => new Date(m.start).getTime() > todayEndMs);

  const externalCount = allMeetings.filter(m => m.is_external).length;
  const needsPrepCount = allMeetings.filter(m => m.needs_prep).length;
  const nextExternal = allMeetings.find(m => m.is_external && m.time_until_ms > 0);

  return {
    today: todayMeetings,
    upcoming: upcomingMeetings,
    external_count: externalCount,
    needs_prep_count: needsPrepCount,
    next_external: nextExternal,
    generated_at: new Date().toISOString(),
    source: 'google_calendar',
  };
}

function assessPrepNeeded(event: any, diffMs: number): { needed: boolean; reason?: string } {
  // Already passed
  if (diffMs < 0) return { needed: false };

  const isExternal = event.is_external || false;
  const hasMultipleAttendees = (event.attendees || []).length >= 3;
  const title = (event.title || '').toLowerCase();

  // External meetings within 24h need prep
  if (isExternal && diffMs < 24 * 3600000) {
    return { needed: true, reason: 'External meeting within 24h' };
  }

  // Demo/pitch/review meetings need prep
  if (title.includes('demo') || title.includes('pitch') || title.includes('review') || title.includes('presentation')) {
    return { needed: true, reason: 'Presentation-type meeting' };
  }

  // Large meetings need prep
  if (hasMultipleAttendees && isExternal) {
    return { needed: true, reason: 'Multi-party external meeting' };
  }

  return { needed: false };
}

function formatTimeUntil(ms: number): string {
  if (ms < 0) {
    const ago = -ms;
    if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
    if (ago < 86400000) return `${Math.floor(ago / 3600000)}h ago`;
    return `${Math.floor(ago / 86400000)}d ago`;
  }
  if (ms < 3600000) return `in ${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `in ${Math.floor(ms / 3600000)}h`;
  return `in ${Math.floor(ms / 86400000)}d`;
}
