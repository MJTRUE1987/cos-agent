/**
 * GET /api/v2/events — Query the event log.
 */

import { safeHandler } from './_handler.js';
import { getEvents, getEventsByEntity, getEventsByCorrelation, getEventsByCommand } from '../../server/event-log/eventStore.js';

export default safeHandler('events', async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const { command_id, entity_type, entity_id, correlation_id, limit, after } = req.query;
  const maxResults = Math.min(parseInt(limit as string) || 50, 200);

  let events: any[];

  if (command_id) {
    events = await getEventsByCommand(command_id as string);
  } else if (entity_type && entity_id) {
    events = await getEventsByEntity(entity_type as string, entity_id as string);
  } else if (correlation_id) {
    events = await getEventsByCorrelation(correlation_id as string);
  } else {
    events = await getEvents({ limit: maxResults });
  }

  if (after) {
    const idx = events.findIndex((e: any) => e.event_id === after);
    if (idx >= 0) events = events.slice(idx + 1);
  }

  events = events.slice(0, maxResults);

  return res.status(200).json({
    success: true,
    events,
    count: events.length,
    has_more: events.length === maxResults,
    cursor: events.length > 0 ? events[events.length - 1].event_id : null,
  });
});
