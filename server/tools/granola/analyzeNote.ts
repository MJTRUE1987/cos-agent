/**
 * granola.analyze_note — AI analysis of a Granola meeting note.
 * Wraps: api/granola.js (POST with analyze: true)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

export const granolaAnalyzeNote: ToolAdapter = {
  contract: {
    name: 'granola.analyze_note',
    version: 1,
    description: 'AI analysis of a Granola meeting note/transcript',
    category: 'analysis',
    source_system: 'granola',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'key_based', key_template: 'granola:analysis:{note_id}:{focus_hash}', ttl_seconds: 3600 },
    side_effects: [],
    retry: { max_retries: 2, backoff: 'fixed', base_delay_ms: 3000, retryable_errors: ['503', 'ETIMEDOUT'] },
    timeout_ms: 30000,
  },

  async execute(inputs: { note_id: string; content: string; company?: string; attendees?: string[]; focus_areas?: string[] }, ctx: ExecutionContext): Promise<ToolResult> {
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
      const callContent = inputs.content.substring(0, 8000);
      const focusInstruction = inputs.focus_areas?.length
        ? `Focus especially on: ${inputs.focus_areas.join(', ')}.`
        : '';

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
          system: `You are a sales ops analyst for Prescient AI. Analyze call notes and return a JSON object:
{
  "summary": "2-3 sentence executive summary",
  "key_points": ["bullet 1", "bullet 2"],
  "business_need": "what the prospect needs",
  "stakeholders": ["name (role)"],
  "objections": ["any concerns raised"],
  "buying_signals": ["positive indicators"],
  "urgency": "low|medium|high",
  "pricing_discussed": true/false,
  "pricing_details": "what was discussed about pricing or null",
  "competitors_mentioned": ["competitor names"],
  "recommended_next_step": "specific next action",
  "recommended_stage": "Disco Complete|Demo Scheduled|Demo Completed|Negotiating|Committed|null",
  "sentiment": "positive|neutral|negative"
}
${focusInstruction}
Return ONLY valid JSON.`,
          messages: [{
            role: 'user',
            content: `Company: ${inputs.company || 'Unknown'}\nAttendees: ${(inputs.attendees || []).join(', ')}\n\nCall Notes:\n${callContent}`,
          }],
        }),
      });

      const aiData = await aiRes.json();
      const rawText = (aiData.content?.[0]?.text || '{}')
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      let analysis;
      try {
        analysis = JSON.parse(rawText);
      } catch {
        analysis = { summary: rawText, error: 'Could not parse structured response' };
      }

      return {
        success: true,
        outputs: { analysis },
        events: [{
          event_type: 'granola.note.analyzed',
          source: 'agent',
          entity_type: 'meeting',
          entity_id: inputs.note_id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: {
            note_id: inputs.note_id,
            summary: analysis.summary?.slice(0, 200),
            recommended_stage: analysis.recommended_stage,
            sentiment: analysis.sentiment,
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
        error: { code: 'ANALYSIS_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
