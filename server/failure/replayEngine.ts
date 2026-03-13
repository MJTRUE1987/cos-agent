/**
 * Replay Engine — Replays a captured failure to check if it's resolved.
 *
 * Loads the failure record, reconstructs the original command context,
 * re-runs intent parsing and entity resolution, and diffs the results.
 */

import { getFailure, captureFailure } from './failureStore.js';
import { interpretCommand } from '../agent/commandInterpreter.js';
import { generateId } from '../event-log/eventStore.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ReplayResult {
  failure_id: string;
  replay_id: string;
  original_error: string;
  replay_status: 'success' | 'same_failure' | 'different_failure';
  replay_error?: string;
  diff: {
    intent_match: boolean;
    entity_match: boolean;
    execution_match: boolean;
  };
  timestamp: string;
}

// ── Core function ─────────────────────────────────────────────────

export async function replayFailure(failureId: string): Promise<ReplayResult> {
  const replayId = generateId('rpl');
  const now = new Date().toISOString();

  // 1. Load the failure record
  const failure = await getFailure(failureId);
  if (!failure) {
    return {
      failure_id: failureId,
      replay_id: replayId,
      original_error: 'unknown',
      replay_status: 'different_failure',
      replay_error: `Failure record ${failureId} not found`,
      diff: { intent_match: false, entity_match: false, execution_match: false },
      timestamp: now,
    };
  }

  // 2. Reconstruct the command and context from reproducible_input
  const input = failure.reproducible_input;
  if (!input || !input.raw_text) {
    return {
      failure_id: failureId,
      replay_id: replayId,
      original_error: failure.error_message,
      replay_status: 'different_failure',
      replay_error: 'No reproducible_input.raw_text available for replay',
      diff: { intent_match: false, entity_match: false, execution_match: false },
      timestamp: now,
    };
  }

  try {
    // 3. Re-run the intent parser
    const replayResult = await interpretCommand(input.raw_text, input.context);

    // 4. Compare current result vs the original snapshot
    const originalIntent = failure.intent;
    const originalEntities = failure.entity_snapshot;

    const intentMatch = replayResult.intent === originalIntent;

    // Entity comparison: check if resolved names match
    const entityMatch = compareEntities(
      originalEntities,
      replayResult.entities
    );

    // 5. Check if same error would occur
    // If the original error was a parse_error and we got a valid intent, it's resolved
    // If the original error was something else, we can only confirm intent/entity match
    const executionMatch = replayResult.confidence > 0.5 && replayResult.intent !== 'unknown';

    const sameFailure =
      failure.error_type === 'parse_error' && replayResult.intent === 'unknown';

    const replayStatus: ReplayResult['replay_status'] = sameFailure
      ? 'same_failure'
      : executionMatch
        ? 'success'
        : 'different_failure';

    return {
      failure_id: failureId,
      replay_id: replayId,
      original_error: failure.error_message,
      replay_status: replayStatus,
      diff: {
        intent_match: intentMatch,
        entity_match: entityMatch,
        execution_match: executionMatch,
      },
      timestamp: now,
    };
  } catch (err: any) {
    // Replay itself failed — capture that as well
    const replayError = err?.message || 'Unknown replay error';

    const sameError = replayError === failure.error_message;

    return {
      failure_id: failureId,
      replay_id: replayId,
      original_error: failure.error_message,
      replay_status: sameError ? 'same_failure' : 'different_failure',
      replay_error: replayError,
      diff: {
        intent_match: false,
        entity_match: false,
        execution_match: false,
      },
      timestamp: now,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function compareEntities(original: any, replayed: any[]): boolean {
  if (!original || !Array.isArray(original)) return false;
  if (!Array.isArray(replayed)) return false;
  if (original.length !== replayed.length) return false;

  const origNames = new Set(
    original.map((e: any) => (e.resolved_name || '').toLowerCase())
  );
  const replayNames = new Set(
    replayed.map((e: any) => (e.resolved_name || '').toLowerCase())
  );

  if (origNames.size !== replayNames.size) return false;
  for (const name of origNames) {
    if (!replayNames.has(name)) return false;
  }
  return true;
}
