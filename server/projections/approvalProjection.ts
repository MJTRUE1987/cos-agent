/**
 * Approval Projection — Tracks pending approvals and their resolution.
 */

import { getEvents } from '../event-log/eventStore.js';

export interface PendingApproval {
  step_id: string;
  plan_id: string;
  command_id: string;
  execution_run_id: string;
  tool: string;
  description: string;
  risk_level: string;
  requested_at: string;
  status: 'pending' | 'approved' | 'denied';
  resolved_at?: string;
  resolved_by?: string;
}

export interface ApprovalView {
  pending: PendingApproval[];
  recent_resolved: PendingApproval[];
  generated_at: string;
}

export async function buildApprovalProjection(): Promise<ApprovalView> {
  const events = await getEvents({ limit: 200 });

  const approvals = new Map<string, PendingApproval>();

  for (const evt of events) {
    if (evt.event_type === 'agent.action.started' && evt.payload?.approval_required) {
      approvals.set(evt.payload.step_id, {
        step_id: evt.payload.step_id,
        plan_id: evt.metadata?.plan_id || '',
        command_id: evt.correlation_id || '',
        execution_run_id: evt.metadata?.execution_run_id || '',
        tool: evt.payload.tool,
        description: evt.payload.description || '',
        risk_level: evt.payload.risk_level || 'medium',
        requested_at: evt.timestamp,
        status: 'pending',
      });
    }

    if (evt.event_type === 'agent.action.completed' && approvals.has(evt.payload?.step_id)) {
      const a = approvals.get(evt.payload.step_id)!;
      a.status = 'approved';
      a.resolved_at = evt.timestamp;
    }

    if (evt.event_type === 'agent.action.failed' && approvals.has(evt.payload?.step_id)) {
      const a = approvals.get(evt.payload.step_id)!;
      a.status = 'denied';
      a.resolved_at = evt.timestamp;
    }
  }

  const all = Array.from(approvals.values());

  return {
    pending: all.filter(a => a.status === 'pending'),
    recent_resolved: all.filter(a => a.status !== 'pending').slice(0, 20),
    generated_at: new Date().toISOString(),
  };
}
