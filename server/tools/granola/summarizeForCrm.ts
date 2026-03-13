/**
 * granola.summarize_for_crm — Summarize a Granola meeting note into
 * structured CRM-ready content: a commercial summary for HubSpot notes
 * and concrete action items for Next Steps.
 *
 * Does NOT dump raw transcript. Extracts only:
 *   - objections, buyer intent, decision criteria
 *   - stakeholders, follow-ups promised
 *   - implementation/timing, pricing/scope, risks/blockers
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

export const granolaSummarizeForCrm: ToolAdapter = {
  contract: {
    name: 'granola.summarize_for_crm',
    version: 1,
    description: 'Summarize Granola meeting into CRM note + next steps',
    category: 'analysis',
    source_system: 'granola',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'granola:crm_summary:{note_id}:{date}', ttl_seconds: 3600 },
    side_effects: [],
    retry: { max_retries: 2, backoff: 'fixed', base_delay_ms: 3000, retryable_errors: ['503', 'ETIMEDOUT'] },
    timeout_ms: 45000,
  },

  async execute(inputs: {
    note_id: string;
    content: string;
    company?: string;
    attendees?: string[];
    current_next_steps?: string;
  }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'NO_API_KEY', message: 'ANTHROPIC_API_KEY not configured', retryable: false },
      };
    }

    try {
      const callContent = inputs.content.substring(0, 12000);

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: `You are a sales ops analyst for Prescient AI. Given meeting notes or transcript, produce two outputs as JSON:

{
  "crm_note": "A concise, structured summary for HubSpot notes. Cover ONLY commercially relevant content: objections raised, buyer intent signals, decision criteria discussed, stakeholders mentioned and their roles, follow-ups promised by either side, implementation or timing details, pricing or scope mentions, risks or blockers. Do NOT include small talk, logistics, or raw transcript. Format as a readable paragraph with key sections. Keep under 500 words.",

  "next_steps": [
    "Send proposal by Friday",
    "Schedule follow-up with VP Engineering",
    "Share case study on similar deployment"
  ],

  "next_steps_text": "A single string combining all action items for the HubSpot Next Steps field, separated by semicolons",

  "stakeholders": [
    { "name": "Jane Smith", "role": "VP Marketing", "sentiment": "positive" }
  ],

  "objections": ["Concerned about implementation timeline", "Budget not confirmed for Q2"],

  "buying_signals": ["Asked about pricing tiers", "Mentioned board presentation next week"],

  "urgency": "low|medium|high",

  "recommended_stage": "Disco Complete|Demo Scheduled|Demo Completed|Negotiating|Committed|null"
}

RULES:
- next_steps must be ACTIONABLE items only: send proposal, schedule follow-up, share pricing, loop in stakeholder, send case study, review contract, confirm timeline, etc.
- Do not include vague items like "continue conversation" or "think about it"
- crm_note must be a polished summary, not raw transcript
- Return ONLY valid JSON`,
          messages: [{
            role: 'user',
            content: `Company: ${inputs.company || 'Unknown'}
Attendees: ${(inputs.attendees || []).join(', ')}
${inputs.current_next_steps ? `Current Next Steps in CRM: ${inputs.current_next_steps}` : ''}

Meeting Notes/Transcript:
${callContent}`,
          }],
        }),
      });

      const aiData = await aiRes.json();
      const rawText = (aiData.content?.[0]?.text || '{}')
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      let summary;
      try {
        summary = JSON.parse(rawText);
      } catch {
        summary = {
          crm_note: rawText.slice(0, 2000),
          next_steps: [],
          next_steps_text: '',
          stakeholders: [],
          objections: [],
          buying_signals: [],
          urgency: 'medium',
          recommended_stage: null,
          error: 'Could not parse structured response',
        };
      }

      return {
        success: true,
        outputs: {
          crm_note: summary.crm_note || '',
          next_steps: summary.next_steps || [],
          next_steps_text: summary.next_steps_text || (summary.next_steps || []).join('; '),
          stakeholders: summary.stakeholders || [],
          objections: summary.objections || [],
          buying_signals: summary.buying_signals || [],
          urgency: summary.urgency || 'medium',
          recommended_stage: summary.recommended_stage || null,
        },
        events: [{
          event_type: 'granola.note.summarized_for_crm',
          source: 'agent',
          entity_type: 'meeting',
          entity_id: inputs.note_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: {
            note_id: inputs.note_id,
            company: inputs.company,
            next_steps_count: (summary.next_steps || []).length,
            urgency: summary.urgency,
            recommended_stage: summary.recommended_stage,
          },
          metadata: {
            version: 1,
            environment: process.env.VERCEL_ENV || 'development',
            command_id: ctx.command_id,
            execution_run_id: ctx.execution_run_id,
            plan_id: ctx.plan_id,
            step_id: ctx.step_id,
            tool_call_id: ctx.tool_call_id,
          },
        }],
        side_effects_performed: [],
        duration_ms: Date.now() - start,
      };
    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'SUMMARIZE_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
