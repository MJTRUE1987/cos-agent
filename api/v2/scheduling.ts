/**
 * /api/v2/scheduling — Jackson scheduling agent endpoints.
 */

import { safeHandler } from './_handler.js';
import { handleSchedulingRequest, bookMeeting, cancelScheduling, getSchedulingRequest, getSchedulingByCommand } from '../../server/agents/jackson/scheduler.js';
import { generateId } from '../../server/event-log/eventStore.js';

export default safeHandler('scheduling', async (req, res) => {
  if (req.method === 'GET') {
    const { request_id, command_id } = req.query;
    if (request_id) {
      const data = await getSchedulingRequest(request_id as string);
      if (!data) return res.status(404).json({ success: false, error: 'Scheduling request not found' });
      return res.status(200).json({ success: true, ...data });
    }
    if (command_id) {
      const data = await getSchedulingByCommand(command_id as string);
      if (!data) return res.status(404).json({ success: false, error: 'No scheduling for this command' });
      return res.status(200).json({ success: true, ...data });
    }
    return res.status(400).json({ success: false, error: 'request_id or command_id required' });
  }

  if (req.method === 'POST') {
    const { action, request_id, slot_index, company, contact_name, contact_email, deal_id, meeting_type, duration_minutes } = req.body || {};

    if (action === 'schedule') {
      if (!company) return res.status(400).json({ success: false, error: 'company required' });
      const commandId = generateId('cmd');
      const ctx = { command_id: commandId, execution_run_id: generateId('run'), plan_id: generateId('plan'), step_id: generateId('step'), tool_call_id: generateId('tc') };
      const result = await handleSchedulingRequest({ command_id: commandId, company, contact_name, contact_email, deal_id, meeting_type, duration_minutes }, ctx);
      return res.status(200).json({ success: true, ...result });
    }

    if (action === 'book') {
      if (!request_id || slot_index === undefined) return res.status(400).json({ success: false, error: 'request_id and slot_index required' });
      const ctx = { command_id: generateId('cmd'), execution_run_id: generateId('run'), plan_id: generateId('plan'), step_id: generateId('step'), tool_call_id: generateId('tc') };
      const result = await bookMeeting(request_id, slot_index, ctx);
      if (!result) return res.status(404).json({ success: false, error: 'Request or slot not found' });
      return res.status(200).json({ success: true, ...result });
    }

    if (action === 'cancel') {
      if (!request_id) return res.status(400).json({ success: false, error: 'request_id required' });
      const cancelled = await cancelScheduling(request_id);
      return res.status(200).json({ success: true, cancelled });
    }

    return res.status(400).json({ success: false, error: 'Unknown action', available: ['schedule', 'book', 'cancel'] });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
});
