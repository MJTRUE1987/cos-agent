/**
 * granola.get_notes — Fetch meeting notes from Granola.
 * Wraps: api/granola.js (GET + POST)
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const GRANOLA_BASE = 'https://public-api.granola.ai';

export const granolaGetNotes: ToolAdapter = {
  contract: {
    name: 'granola.get_notes',
    version: 1,
    description: 'Fetch meeting notes from Granola',
    category: 'meeting',
    source_system: 'granola',
    risk_level: 'safe',
    approval_required: false,
    idempotency: { strategy: 'read_only' },
    side_effects: [],
    retry: { max_retries: 3, backoff: 'exponential', base_delay_ms: 1000, retryable_errors: ['429', '503', 'ETIMEDOUT'] },
    timeout_ms: 15000,
  },

  async execute(inputs: { note_id?: string; company_name?: string; created_after?: string; include_transcript?: boolean }, ctx: ExecutionContext): Promise<ToolResult> {
    const start = Date.now();
    const headers = { Authorization: `Bearer ${process.env.GRANOLA_API_KEY}` };

    try {
      let note: any = null;

      if (inputs.note_id) {
        // Direct fetch
        const r = await fetch(`${GRANOLA_BASE}/v1/notes/${inputs.note_id}?include=transcript`, { headers });
        if (!r.ok) {
          return {
            success: false, outputs: {}, events: [], side_effects_performed: [],
            duration_ms: Date.now() - start,
            error: { code: String(r.status), message: 'Note not found', retryable: false },
          };
        }
        note = await r.json();
      } else {
        // Search recent notes
        const params = new URLSearchParams({ page_size: '30' });
        const after = inputs.created_after || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        params.set('created_after', after);

        const listR = await fetch(`${GRANOLA_BASE}/v1/notes?${params}`, { headers });
        if (!listR.ok) {
          return {
            success: false, outputs: {}, events: [], side_effects_performed: [],
            duration_ms: Date.now() - start,
            error: { code: String(listR.status), message: 'Failed to list notes', retryable: true },
          };
        }

        const listData = await listR.json();
        const notes = listData.notes || [];

        // Find match
        let match = null;
        if (inputs.company_name) {
          const q = inputs.company_name.toLowerCase();
          match = notes.find((n: any) =>
            (n.title || '').toLowerCase().includes(q) ||
            (n.attendees || []).some((a: any) =>
              (a.name || '').toLowerCase().includes(q) ||
              (a.email || '').toLowerCase().includes(q)
            ) ||
            (n.calendar_event?.title || '').toLowerCase().includes(q)
          );
        }
        if (!match && notes.length > 0) match = notes[0];

        if (match) {
          const fullR = await fetch(`${GRANOLA_BASE}/v1/notes/${match.id}?include=transcript`, { headers });
          if (fullR.ok) note = await fullR.json();
        }
      }

      if (!note) {
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: '404', message: 'No matching note found', retryable: false },
        };
      }

      // Build structured output
      let fullTranscriptText = '';
      if (note.transcript && Array.isArray(note.transcript)) {
        fullTranscriptText = note.transcript.map((t: any) => `[${t.speaker || 'unknown'}] ${t.text}`).join('\n');
      }

      const result = {
        note_id: note.id,
        title: note.title,
        created_at: note.created_at,
        attendees: note.attendees || [],
        summary: note.summary_text || note.summary_markdown || '',
        content: note.summary_markdown || note.summary_text || '',
        transcript: inputs.include_transcript ? fullTranscriptText : null,
        calendar_event: note.calendar_event,
      };

      return {
        success: true,
        outputs: { notes: [result] },
        events: [{
          event_type: 'granola.note.observed',
          source: 'granola',
          entity_type: 'meeting',
          entity_id: note.id,
          correlation_id: ctx.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: { note_id: note.id, title: note.title, participants: (note.attendees || []).map((a: any) => a.name) },
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
        error: { code: 'GRANOLA_ERROR', message: err.message, retryable: true },
      };
    }
  },
};
