/**
 * Execution Planner — Converts interpreted commands into step DAGs.
 *
 * Input: CommandIntent
 * Output: ExecutionPlan with ordered steps
 */

import { generateId } from '../event-log/eventStore.js';
import type { CommandIntent } from './commandInterpreter.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ExecutionPlan {
  plan_id: string;
  command_id: string;
  steps: PlanStep[];
  requires_approval: boolean;
  status: 'draft' | 'approved' | 'executing' | 'completed' | 'failed' | 'partially_completed';
  created_at: string;
}

export interface PlanStep {
  step_id: string;
  plan_id: string;
  sequence: number;
  tool: string;
  description: string;
  inputs: Record<string, any>;
  depends_on: string[];     // step IDs this depends on
  approval_required: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_approval';
  output?: any;
  error?: string;
}

// ── Approval rules ────────────────────────────────────────────────

const APPROVAL_REQUIRED_TOOLS = new Set([
  'hubspot.update_deal',
  'email.send',
  'calendar.create_event',
]);

const SAFE_AUTO_RUN = new Set([
  'hubspot.get_deal',
  'hubspot.search_company',
  'gmail.search_threads',
  'granola.get_notes',
  'granola.analyze_note',
  'calendar.get_events',
  'pricing.calculate',
  'gmail.create_draft',
  'hubspot.create_note',
  'proposal.generate',
  'granola.summarize_for_crm',
]);

function needsApproval(toolName: string): boolean {
  if (SAFE_AUTO_RUN.has(toolName)) return false;
  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) return true;
  return false; // default: don't require approval for unknown tools
}

// ── Plan templates ────────────────────────────────────────────────

export function generatePlan(intent: CommandIntent): ExecutionPlan {
  const planId = generateId('plan');
  const now = new Date().toISOString();

  let steps: PlanStep[];

  switch (intent.intent) {
    case 'postcall.full':
      steps = buildPostCallPlan(planId, intent);
      break;
    case 'inbox.triage':
      steps = buildInboxTriagePlan(planId, intent);
      break;
    case 'pipeline.top_actions':
    case 'oversight.daily_brief':
      steps = buildDailyBriefPlan(planId, intent);
      break;
    case 'email.draft':
      steps = buildEmailDraftPlan(planId, intent);
      break;
    case 'meeting.prep':
      steps = buildMeetingPrepPlan(planId, intent);
      break;
    case 'proposal.create':
      steps = buildProposalPlan(planId, intent);
      break;
    case 'scheduling.request':
      steps = buildSchedulingPlan(planId, intent);
      break;
    case 'opportunity.create':
      steps = buildCreateOpportunityPlan(planId, intent);
      break;
    case 'pipeline.stage_update_with_notes':
      steps = buildStageUpdateWithNotesPlan(planId, intent);
      break;
    case 'pipeline.stage_change':
      steps = buildStageChangePlan(planId, intent);
      break;
    case 'pipeline.stale':
    case 'pipeline.slip_risk':
      steps = buildStaleDealPlan(planId, intent);
      break;
    case 'oversight.intervention':
    case 'oversight.rep_review':
      steps = buildTeamOversightPlan(planId, intent);
      break;
    default:
      // Generic: use required_actions from interpreter
      steps = intent.required_actions.map((tool, i) => ({
        step_id: generateId('step'),
        plan_id: planId,
        sequence: i + 1,
        tool,
        description: `Execute ${tool}`,
        inputs: {},
        depends_on: i > 0 ? [steps?.[i - 1]?.step_id].filter(Boolean) : [],
        approval_required: needsApproval(tool),
        status: 'pending' as const,
      }));
  }

  return {
    plan_id: planId,
    command_id: intent.command_id,
    steps,
    requires_approval: steps.some(s => s.approval_required),
    status: 'draft',
    created_at: now,
  };
}

// ── Post-call full flow ───────────────────────────────────────────

function buildPostCallPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const company = intent.entities.find(e => e.entity_type === 'company')?.resolved_name || 'Unknown';
  const steps: PlanStep[] = [];

  // Step 1: Search HubSpot for company context
  const searchStep = makeStep(planId, 1, 'hubspot.search_company', 'Search HubSpot for company', {
    query: company,
  });
  steps.push(searchStep);

  // Step 2: Fetch Granola notes
  const granolaStep = makeStep(planId, 2, 'granola.get_notes', 'Fetch Granola meeting notes', {
    company_name: company,
    include_transcript: true,
  });
  steps.push(granolaStep);

  // Step 3: Analyze the call
  const analyzeStep = makeStep(planId, 3, 'granola.analyze_note', 'Analyze call transcript', {
    company: company,
    // note_id and content will be filled from step 2 output
    _resolve_from: { note_id: 'step:2:notes.0.note_id', content: 'step:2:notes.0.content' },
  }, [granolaStep.step_id]);
  steps.push(analyzeStep);

  // Step 4: Generate proposal
  const proposalStep = makeStep(planId, 4, 'proposal.generate', 'Generate proposal', {
    company,
    _resolve_from: { deal_id: 'step:1:deals.0.id', meeting_analysis: 'step:3:analysis' },
  }, [searchStep.step_id, analyzeStep.step_id]);
  steps.push(proposalStep);

  // Step 5: Draft follow-up email
  const emailStep = makeStep(planId, 5, 'gmail.create_draft', 'Draft follow-up email', {
    subject: `Follow up: ${company}`,
    _resolve_from: { to: 'step:3:analysis.key_people.0.email' },
    body: '', // Generated by executor from analysis context
  }, [analyzeStep.step_id]);
  steps.push(emailStep);

  // Step 6: Update HubSpot deal stage (requires approval)
  const updateStep = makeStep(planId, 6, 'hubspot.update_deal', 'Update HubSpot deal stage', {
    _resolve_from: {
      deal_id: 'step:1:deals.0.id',
      properties: { dealstage: 'step:3:analysis.recommended_stage' },
    },
  }, [searchStep.step_id, analyzeStep.step_id]);
  updateStep.approval_required = true;
  steps.push(updateStep);

  // Step 7: Add CRM note
  const noteStep = makeStep(planId, 7, 'hubspot.create_note', 'Add call summary to CRM', {
    _resolve_from: {
      deal_id: 'step:1:deals.0.id',
      body: 'step:3:analysis.summary',
    },
  }, [searchStep.step_id, analyzeStep.step_id]);
  steps.push(noteStep);

  return steps;
}

// ── Inbox triage ──────────────────────────────────────────────────

function buildInboxTriagePlan(planId: string, intent: CommandIntent): PlanStep[] {
  return [
    makeStep(planId, 1, 'gmail.search_threads', 'Search for important emails needing reply', {
      query: 'is:inbox is:unread newer_than:1d is:important',
      max_results: 30,
    }),
  ];
}

// ── Daily brief ───────────────────────────────────────────────────

function buildDailyBriefPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59).toISOString();
  const today = now.toISOString().split('T')[0];

  const calStep = makeStep(planId, 1, 'calendar.get_events', 'Fetch today\'s calendar', {
    start: todayStart,
    end: tomorrowEnd,
  });

  const pipelineStep = makeStep(planId, 2, 'hubspot.search_company', 'Check active pipeline deals', {
    query: 'deal',
  });

  const emailStep = makeStep(planId, 3, 'gmail.search_threads', 'Check important inbox threads needing reply', {
    query: `is:inbox is:unread after:${today} is:important`,
    max_results: 15,
  });

  return [calStep, pipelineStep, emailStep];
}

// ── Email draft ───────────────────────────────────────────────────

function buildEmailDraftPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const company = intent.entities.find(e => e.entity_type === 'company')?.resolved_name;

  const steps: PlanStep[] = [];

  if (company) {
    const searchStep = makeStep(planId, 1, 'hubspot.search_company', 'Look up company in HubSpot', { query: company });
    steps.push(searchStep);

    const threadStep = makeStep(planId, 2, 'gmail.search_threads', 'Find recent email thread', {
      query: company,
      max_results: 5,
    }, [searchStep.step_id]);
    steps.push(threadStep);

    const draftStep = makeStep(planId, 3, 'gmail.create_draft', 'Create follow-up draft', {
      subject: `Follow up: ${company}`,
      body: '', // Will be generated by executor
      _resolve_from: { to: 'step:2:threads.0.from', thread_id: 'step:2:threads.0.thread_id' },
    }, [threadStep.step_id]);
    steps.push(draftStep);
  }

  return steps;
}

// ── Meeting prep ──────────────────────────────────────────────────

function buildMeetingPrepPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const now = new Date();
  // Use a generous window: from now through 48 hours to catch "tomorrow" regardless of timezone
  const windowEnd = new Date(now.getTime() + 48 * 3600000);

  const calStep = makeStep(planId, 1, 'calendar.get_events', 'Fetch upcoming meetings (next 48h)', {
    start: now.toISOString(),
    end: windowEnd.toISOString(),
  });

  const emailStep = makeStep(planId, 2, 'gmail.search_threads', 'Find recent important emails from meeting attendees', {
    query: 'is:inbox newer_than:7d is:important',
    max_results: 20,
  });

  return [calStep, emailStep];
}

// ── Proposal ──────────────────────────────────────────────────────

function buildProposalPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const company = intent.entities.find(e => e.entity_type === 'company')?.resolved_name || 'Unknown';

  const searchStep = makeStep(planId, 1, 'hubspot.search_company', 'Look up company', { query: company });
  const proposalStep = makeStep(planId, 2, 'proposal.generate', 'Generate proposal', {
    company,
    _resolve_from: { deal_id: 'step:1:deals.0.id' },
  }, [searchStep.step_id]);

  return [searchStep, proposalStep];
}

// ── Scheduling (Jackson) ──────────────────────────────────────────

function buildSchedulingPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const now = new Date();
  const weekOut = new Date(now.getTime() + 7 * 86400000);

  const calStep = makeStep(planId, 1, 'calendar.get_events', 'Check calendar availability', {
    start: now.toISOString(),
    end: weekOut.toISOString(),
  });

  return [calStep];
}

// ── Stage change (bulk) ──────────────────────────────────────

function buildStageChangePlan(planId: string, intent: CommandIntent): PlanStep[] {
  const companies = intent.entities.filter(e => e.entity_type === 'company' || e.entity_type === 'deal');
  const targetStage = intent.parameters?.target_stage || 'closedlost';
  const steps: PlanStep[] = [];

  // For each entity: if deal ID already resolved (from validation), skip search; otherwise search → update
  companies.forEach((company, i) => {
    if (company.resolved_id) {
      // Deal ID already validated against HubSpot — go straight to update
      const seq = steps.length + 1;
      const updateStep = makeStep(planId, seq, 'hubspot.update_deal', `Update "${company.resolved_name}" to ${targetStage}`, {
        deal_id: company.resolved_id,
        properties: { dealstage: targetStage },
      });
      updateStep.approval_required = true;
      steps.push(updateStep);
    } else {
      // Need to search first
      const seq = steps.length + 1;
      const searchStep = makeStep(planId, seq, 'hubspot.search_company', `Search HubSpot for "${company.resolved_name}"`, {
        query: company.resolved_name,
      });
      steps.push(searchStep);

      const updateStep = makeStep(planId, seq + 1, 'hubspot.update_deal', `Update "${company.resolved_name}" deal stage`, {
        _resolve_from: { deal_id: `step:${seq}:deals.0.id` },
        properties: { dealstage: targetStage },
      }, [searchStep.step_id]);
      updateStep.approval_required = true;
      steps.push(updateStep);
    }
  });

  return steps;
}

// ── Stage update with Granola notes ──────────────────────────────

function buildStageUpdateWithNotesPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const companies = intent.entities.filter(e => e.entity_type === 'company');
  const company = companies[0]?.resolved_name || '';
  const targetStage = intent.parameters?.target_stage || '';
  const steps: PlanStep[] = [];

  // Step 1: Resolve deal in HubSpot
  const searchStep = makeStep(planId, 1, 'hubspot.search_company', `Resolve deal for "${company}"`, {
    query: company,
  });
  steps.push(searchStep);

  // Step 2: Fetch Granola meeting notes
  const granolaStep = makeStep(planId, 2, 'granola.get_notes', `Fetch Granola notes for "${company}"`, {
    company_name: company,
    include_transcript: true,
  });
  steps.push(granolaStep);

  // Step 3: Summarize meeting for CRM (commercial content + next steps extraction)
  const summarizeStep = makeStep(planId, 3, 'granola.summarize_for_crm', 'Summarize meeting for CRM', {
    company,
    _resolve_from: {
      note_id: 'step:2:notes.0.note_id',
      content: 'step:2:notes.0.content',
      attendees: 'step:2:notes.0.attendees',
    },
  }, [granolaStep.step_id]);
  steps.push(summarizeStep);

  // Step 4: Update deal stage (requires approval)
  const updateStageStep = makeStep(planId, 4, 'hubspot.update_deal', 'Update deal stage', {
    _resolve_from: { deal_id: 'step:1:deals.0.id' },
    properties: { dealstage: targetStage },
  }, [searchStep.step_id, summarizeStep.step_id]);
  updateStageStep.approval_required = true;
  steps.push(updateStageStep);

  // Step 5: Append CRM note with Granola summary
  const noteStep = makeStep(planId, 5, 'hubspot.create_note', 'Append meeting summary to HubSpot notes', {
    _resolve_from: {
      deal_id: 'step:1:deals.0.id',
      body: 'step:3:crm_note',
    },
  }, [searchStep.step_id, summarizeStep.step_id]);
  steps.push(noteStep);

  // Step 6: Update Next Steps field with extracted action items
  const nextStepStep = makeStep(planId, 6, 'hubspot.update_deal', 'Update Next Steps with action items', {
    _resolve_from: {
      deal_id: 'step:1:deals.0.id',
      properties: { hs_next_step: 'step:3:next_steps_text' },
    },
  }, [searchStep.step_id, summarizeStep.step_id, updateStageStep.step_id]);
  nextStepStep.approval_required = true;
  steps.push(nextStepStep);

  return steps;
}

// ── Create opportunity (wizard mode) ──────────────────────────────

function buildCreateOpportunityPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const company = intent.parameters?.company_name || intent.entities.find(e => e.entity_type === 'company')?.resolved_name || '';
  const steps: PlanStep[] = [];

  const searchStep = makeStep(planId, 1, 'hubspot.search_company', `Search existing records for "${company}"`, {
    query: company,
  });
  steps.push(searchStep);

  const createContactStep = makeStep(planId, 2, 'hubspot.create_contact', 'Create contact', {}, [searchStep.step_id]);
  createContactStep.approval_required = true;
  steps.push(createContactStep);

  const createCompanyStep = makeStep(planId, 3, 'hubspot.create_company', 'Create company', {
    name: company,
  }, [searchStep.step_id]);
  createCompanyStep.approval_required = true;
  steps.push(createCompanyStep);

  const createDealStep = makeStep(planId, 4, 'hubspot.create_deal', 'Create deal', {
    dealstage: intent.parameters?.target_stage,
    _resolve_from: { company_id: 'step:3:company_id', contact_id: 'step:2:contact_id' },
  }, [createContactStep.step_id, createCompanyStep.step_id]);
  createDealStep.approval_required = true;
  steps.push(createDealStep);

  return steps;
}

// ── Stale deals ───────────────────────────────────────────────────

function buildStaleDealPlan(planId: string, intent: CommandIntent): PlanStep[] {
  return [
    makeStep(planId, 1, 'hubspot.search_company', 'Search for stale deals', {
      query: 'deal',
    }),
  ];
}

// ── Team oversight ────────────────────────────────────────────────

function buildTeamOversightPlan(planId: string, intent: CommandIntent): PlanStep[] {
  const rep = intent.entities.find(e => e.entity_type === 'rep')?.resolved_name;
  return [
    makeStep(planId, 1, 'hubspot.search_company', `Search ${rep || 'team'} deals`, {
      query: rep || 'deal',
    }),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────

function makeStep(
  planId: string,
  seq: number,
  tool: string,
  description: string,
  inputs: Record<string, any>,
  dependsOn: string[] = []
): PlanStep {
  return {
    step_id: generateId('step'),
    plan_id: planId,
    sequence: seq,
    tool,
    description,
    inputs,
    depends_on: dependsOn,
    approval_required: needsApproval(tool),
    status: 'pending',
  };
}
