/**
 * granola.get_notes — Fetch meeting notes from Granola.
 * Wraps: api/granola.js (GET + POST)
 *
 * Multi-strategy matching (in priority order):
 * 1. Related calendar event (calendar_event field matches)
 * 2. Participant email (attendee email contains company domain)
 * 3. Participant name (attendee name contains search term)
 * 4. Title fuzzy match (word-boundary > substring)
 * 5. Recent meetings window (most recent within last 14 days)
 *
 * Returns all matches with scores; callers use notes[0] for best match.
 */

import type { ToolAdapter, ToolResult } from '../types.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';

const GRANOLA_BASE = 'https://public-api.granola.ai';

// ── Matching types ────────────────────────────────────────────────

type MatchStrategy =
  | 'calendar_event'
  | 'participant_email'
  | 'participant_name'
  | 'title_fuzzy'
  | 'recent_window';

interface ScoredNote {
  note: any;
  match_score: number;
  match_strategy: MatchStrategy;
}

// ── Multi-strategy matching ───────────────────────────────────────

function scoreNotes(notes: any[], companyName: string): ScoredNote[] {
  const q = companyName.toLowerCase();
  const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRe = new RegExp(`(?:^|\\W)${qEsc}(?:$|\\W)`, 'i');

  // Extract a likely domain fragment from the company name
  // e.g. "Thrive Market" → "thrivemarket", "ARMRA" → "armra"
  const domainFragment = q.replace(/[^a-z0-9]/g, '');

  const scored: ScoredNote[] = [];
  const seenIds = new Set<string>();

  for (const n of notes) {
    const attendees: { name: string; email: string }[] = (n.attendees || []).map((a: any) => ({
      name: (a.name || '').toLowerCase(),
      email: (a.email || '').toLowerCase(),
    }));
    const calTitle = (n.calendar_event?.title || '').toLowerCase();
    const noteTitle = (n.title || '').toLowerCase();

    // Strategy 1: Calendar event match
    if (n.calendar_event?.title) {
      const ct = n.calendar_event.title;
      if (ct.toLowerCase() === q) {
        pushUnique(scored, seenIds, { note: n, match_score: 100, match_strategy: 'calendar_event' });
      } else if (wordRe.test(ct)) {
        pushUnique(scored, seenIds, { note: n, match_score: 90, match_strategy: 'calendar_event' });
      } else if (calTitle.includes(q)) {
        pushUnique(scored, seenIds, { note: n, match_score: 75, match_strategy: 'calendar_event' });
      }
    }

    // Strategy 2: Participant email contains company domain
    if (domainFragment.length >= 3) {
      for (const a of attendees) {
        if (a.email && a.email.includes(domainFragment)) {
          const emailScore = a.email.split('@')[1]?.includes(domainFragment) ? 85 : 70;
          pushUnique(scored, seenIds, { note: n, match_score: emailScore, match_strategy: 'participant_email' });
          break; // one match per note is enough
        }
      }
    }

    // Strategy 3: Participant name contains search term
    for (const a of attendees) {
      if (a.name === q) {
        pushUnique(scored, seenIds, { note: n, match_score: 80, match_strategy: 'participant_name' });
        break;
      }
      if (wordRe.test(a.name)) {
        pushUnique(scored, seenIds, { note: n, match_score: 65, match_strategy: 'participant_name' });
        break;
      }
      if (a.name.includes(q)) {
        pushUnique(scored, seenIds, { note: n, match_score: 50, match_strategy: 'participant_name' });
        break;
      }
    }

    // Strategy 4: Title fuzzy match
    if (noteTitle === q) {
      pushUnique(scored, seenIds, { note: n, match_score: 100, match_strategy: 'title_fuzzy' });
    } else if (wordRe.test(n.title || '')) {
      pushUnique(scored, seenIds, { note: n, match_score: 80, match_strategy: 'title_fuzzy' });
    } else if (noteTitle.includes(q)) {
      pushUnique(scored, seenIds, { note: n, match_score: 40, match_strategy: 'title_fuzzy' });
    }
  }

  // Strategy 5: If no matches yet, fall back to most recent within 14-day window
  if (scored.length === 0 && notes.length > 0) {
    const fourteenDaysAgo = Date.now() - 14 * 86400000;
    const recent = notes.filter(n => {
      const created = new Date(n.created_at).getTime();
      return created >= fourteenDaysAgo;
    });
    if (recent.length > 0) {
      // Return the most recent note as a low-confidence fallback
      pushUnique(scored, seenIds, { note: recent[0], match_score: 20, match_strategy: 'recent_window' });
    }
  }

  // Sort by score descending, then by created_at descending for ties
  scored.sort((a, b) => {
    if (b.match_score !== a.match_score) return b.match_score - a.match_score;
    const aTime = new Date(a.note.created_at || 0).getTime();
    const bTime = new Date(b.note.created_at || 0).getTime();
    return bTime - aTime;
  });

  // Deduplicate: keep the highest-scoring entry per note ID
  const deduped: ScoredNote[] = [];
  const dedupIds = new Set<string>();
  for (const s of scored) {
    if (!dedupIds.has(s.note.id)) {
      dedupIds.add(s.note.id);
      deduped.push(s);
    }
  }

  return deduped;
}

function pushUnique(scored: ScoredNote[], seenIds: Set<string>, entry: ScoredNote) {
  // Allow multiple entries per note ID at this stage; dedup happens after sorting
  scored.push(entry);
}

// ── Tool adapter ──────────────────────────────────────────────────

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
      // ── Direct fetch by ID ──────────────────────────────────────
      if (inputs.note_id) {
        const r = await fetch(`${GRANOLA_BASE}/v1/notes/${inputs.note_id}?include=transcript`, { headers });
        if (!r.ok) {
          return {
            success: false, outputs: {}, events: [], side_effects_performed: [],
            duration_ms: Date.now() - start,
            error: { code: String(r.status), message: 'Note not found', retryable: false },
          };
        }
        const note = await r.json();
        return buildSuccessResult([{ note, match_score: 100, match_strategy: 'direct' as MatchStrategy }], inputs, ctx, start, headers);
      }

      // ── Search recent notes with multi-strategy matching ────────
      const params = new URLSearchParams({ page_size: '30' });
      const after = inputs.created_after || new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
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
      const allNotes = listData.notes || [];

      let matches: ScoredNote[] = [];

      if (inputs.company_name) {
        matches = scoreNotes(allNotes, inputs.company_name);
      } else if (allNotes.length > 0) {
        // No search term: return most recent
        matches = [{ note: allNotes[0], match_score: 100, match_strategy: 'recent_window' }];
      }

      if (matches.length === 0) {
        return {
          success: false, outputs: {}, events: [], side_effects_performed: [],
          duration_ms: Date.now() - start,
          error: { code: '404', message: 'No matching note found', retryable: false },
        };
      }

      return buildSuccessResult(matches, inputs, ctx, start, headers);

    } catch (err: any) {
      return {
        success: false, outputs: {}, events: [], side_effects_performed: [],
        duration_ms: Date.now() - start,
        error: { code: 'GRANOLA_ERROR', message: err.message, retryable: true },
      };
    }
  },
};

/**
 * Build the success result, fetching full note details for top matches.
 * Returns all matches in `notes` array, with the best match first.
 */
async function buildSuccessResult(
  matches: ScoredNote[],
  inputs: { include_transcript?: boolean },
  ctx: ExecutionContext,
  start: number,
  headers: Record<string, string>,
): Promise<ToolResult> {
  // Fetch full details for the top matches (up to 5 to avoid excessive API calls)
  const topMatches = matches.slice(0, 5);
  const fullNotes = await Promise.all(
    topMatches.map(async (m) => {
      try {
        const fullR = await fetch(`${GRANOLA_BASE}/v1/notes/${m.note.id}?include=transcript`, { headers });
        if (!fullR.ok) return null;
        const fullNote = await fullR.json();
        return { fullNote, match_score: m.match_score, match_strategy: m.match_strategy };
      } catch {
        return null;
      }
    })
  );

  const results = fullNotes.filter(Boolean).map((entry) => {
    const note = entry!.fullNote;
    let fullTranscriptText = '';
    if (note.transcript && Array.isArray(note.transcript)) {
      fullTranscriptText = note.transcript.map((t: any) => `[${t.speaker || 'unknown'}] ${t.text}`).join('\n');
    }

    return {
      note_id: note.id,
      title: note.title,
      created_at: note.created_at,
      attendees: note.attendees || [],
      summary: note.summary_text || note.summary_markdown || '',
      content: note.summary_markdown || note.summary_text || '',
      transcript: inputs.include_transcript ? fullTranscriptText : null,
      calendar_event: note.calendar_event,
      match_strategy: entry!.match_strategy,
      match_score: entry!.match_score,
    };
  });

  if (results.length === 0) {
    return {
      success: false, outputs: {}, events: [], side_effects_performed: [],
      duration_ms: Date.now() - start,
      error: { code: '404', message: 'No matching note found', retryable: false },
    };
  }

  const bestNote = results[0];

  return {
    success: true,
    outputs: { notes: results },
    events: [{
      event_type: 'granola.note.observed',
      source: 'granola',
      entity_type: 'meeting',
      entity_id: bestNote.note_id,
      correlation_id: ctx.command_id,
      actor: 'agent',
      timestamp: new Date().toISOString(),
      payload: {
        note_id: bestNote.note_id,
        title: bestNote.title,
        participants: (bestNote.attendees || []).map((a: any) => a.name),
        match_strategy: bestNote.match_strategy,
        match_score: bestNote.match_score,
        total_matches: results.length,
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
}
