/**
 * Deal Timeline Projection — Builds a chronological activity timeline for a deal.
 */

import { getEventsByEntity } from '../event-log/eventStore.js';
import { getTool } from '../tools/registry.js';

export interface TimelineEntry {
  event_id: string;
  event_type: string;
  timestamp: string;
  actor: string;
  summary: string;
  detail?: any;
  source: 'agent' | 'external' | 'user';
}

export interface DealTimeline {
  deal_id: string;
  deal_name?: string;
  company?: string;
  entries: TimelineEntry[];
  generated_at: string;
}

export async function buildDealTimeline(dealId: string): Promise<DealTimeline> {
  // 1. Get all agent events for this deal
  const events = await getEventsByEntity('deal', dealId);

  const entries: TimelineEntry[] = events.map(evt => ({
    event_id: evt.event_id,
    event_type: evt.event_type,
    timestamp: evt.timestamp,
    actor: evt.actor || 'system',
    summary: describeEvent(evt),
    detail: evt.payload,
    source: evt.source === 'agent' ? 'agent' : 'external',
  }));

  // 2. Optionally enrich with live deal data
  let dealName: string | undefined;
  let company: string | undefined;

  const getDeal = await getTool('hubspot.get_deal');
  if (getDeal) {
    const result = await getDeal.execute({ deal_id: dealId }, {
      command_id: 'projection',
      execution_run_id: 'projection',
      plan_id: 'projection',
      step_id: 'projection',
      tool_call_id: 'projection',
    });
    if (result.success) {
      dealName = result.outputs.deal?.dealname;
      company = result.outputs.deal?.company;
    }
  }

  // Sort chronologically (newest first)
  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return {
    deal_id: dealId,
    deal_name: dealName,
    company,
    entries,
    generated_at: new Date().toISOString(),
  };
}

function describeEvent(evt: any): string {
  const p = evt.payload || {};
  switch (evt.event_type) {
    case 'hubspot.deal.observed': return 'Deal data fetched from HubSpot';
    case 'hubspot.deal.stage_changed': return `Stage changed: ${p.old_value} → ${p.new_value}`;
    case 'hubspot.deal.amount_changed': return `Amount updated: $${p.old_value} → $${p.new_value}`;
    case 'hubspot.deal.note_added': return 'Note added to CRM';
    case 'gmail.draft.created': return `Email draft created: "${p.subject || ''}"`;
    case 'proposal.created': return `Proposal generated (${p.proposal_id || ''})`;
    case 'granola.note.observed': return 'Meeting notes retrieved';
    case 'granola.note.analyzed': return 'Call transcript analyzed';
    case 'jackson.meeting.booked': return `Meeting booked for ${p.slot?.start || 'TBD'}`;
    case 'jackson.scheduling.requested': return 'Scheduling initiated';
    case 'agent.plan.started': return `Execution plan started (${p.step_count} steps)`;
    case 'agent.plan.completed': return `Plan completed: ${p.steps_completed}/${p.steps_completed + p.steps_failed} steps`;
    case 'agent.action.started': return `Running: ${p.description || p.tool}`;
    case 'agent.action.completed': return `Completed: ${p.tool} (${p.duration_ms}ms)`;
    case 'agent.action.failed': return `Failed: ${p.tool} — ${p.error || 'unknown'}`;
    default: return evt.event_type;
  }
}
