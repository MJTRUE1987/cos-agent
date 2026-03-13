/**
 * Execution Engine — Runs plans step by step.
 *
 * For each step:
 * 1. Check dependencies are met
 * 2. Check approval if required
 * 3. Call tool adapter
 * 4. Emit events
 * 5. Store result
 * 6. Update checkpoint
 */

import { appendEvent, generateId } from '../event-log/eventStore.js';
import type { ExecutionContext } from '../event-log/eventStore.js';
import { getTool } from '../tools/registry.js';
import type { ExecutionPlan, PlanStep } from './planner.js';
import { getKV } from '../lib/kv.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ExecutionRun {
  execution_run_id: string;
  command_id: string;
  plan_id: string;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  steps_total: number;
  steps_completed: number;
  steps_failed: number;
  current_step_id: string | null;
  results: Record<string, any>;  // step_id → output
  artifacts: any[];
  events_emitted: string[];
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

// ── Run Plan ──────────────────────────────────────────────────────

export async function runPlan(plan: ExecutionPlan): Promise<ExecutionRun> {
  const runId = generateId('run');
  const startTime = Date.now();

  const run: ExecutionRun = {
    execution_run_id: runId,
    command_id: plan.command_id,
    plan_id: plan.plan_id,
    status: 'running',
    steps_total: plan.steps.length,
    steps_completed: 0,
    steps_failed: 0,
    current_step_id: null,
    results: {},
    artifacts: [],
    events_emitted: [],
    started_at: new Date().toISOString(),
    completed_at: null,
    duration_ms: null,
  };

  // Emit plan started event
  const startEvent = await appendEvent({
    event_type: 'agent.plan.started',
    source: 'agent',
    correlation_id: plan.command_id,
    actor: 'agent',
    timestamp: new Date().toISOString(),
    payload: {
      plan_id: plan.plan_id,
      step_count: plan.steps.length,
      tools: plan.steps.map(s => s.tool),
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      command_id: plan.command_id,
      execution_run_id: runId,
      plan_id: plan.plan_id,
    },
  });
  run.events_emitted.push(startEvent.event_id);

  // Execute steps in dependency order
  const completedSteps = new Set<string>();

  for (const step of plan.steps) {
    run.current_step_id = step.step_id;

    // Check dependencies
    const depsReady = step.depends_on.every(dep => completedSteps.has(dep));
    if (!depsReady) {
      // Check if any dependency failed
      const depFailed = step.depends_on.some(dep => {
        const depStep = plan.steps.find(s => s.step_id === dep);
        return depStep?.status === 'failed';
      });
      if (depFailed) {
        step.status = 'skipped';
        continue;
      }
      // This shouldn't happen with sequential execution, but guard anyway
      step.status = 'skipped';
      continue;
    }

    // Check approval
    if (step.approval_required) {
      // For now: auto-approve in Phase 1 (will add approval flow later)
      // In production this would pause and wait for user input
      console.log(`[executor] Step ${step.step_id} requires approval — auto-approving in Phase 1`);
    }

    // Resolve dynamic inputs from previous step outputs
    const resolvedInputs = resolveInputs(step.inputs, run.results, plan.steps);

    // Build execution context
    const toolCallId = generateId('tc');
    const ctx: ExecutionContext = {
      command_id: plan.command_id,
      execution_run_id: runId,
      plan_id: plan.plan_id,
      step_id: step.step_id,
      tool_call_id: toolCallId,
    };

    // Get tool adapter
    const tool = await getTool(step.tool);
    if (!tool) {
      step.status = 'failed';
      step.error = `Tool not found: ${step.tool}`;
      run.steps_failed++;

      await appendEvent({
        event_type: 'agent.action.failed',
        source: 'agent',
        correlation_id: plan.command_id,
        actor: 'agent',
        timestamp: new Date().toISOString(),
        payload: { step_id: step.step_id, tool: step.tool, error: step.error },
        metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', ...ctx },
      });
      continue;
    }

    // Execute
    step.status = 'running';
    const stepStartEvent = await appendEvent({
      event_type: 'agent.action.started',
      source: 'agent',
      correlation_id: plan.command_id,
      actor: 'agent',
      timestamp: new Date().toISOString(),
      payload: { step_id: step.step_id, tool: step.tool, description: step.description },
      metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', ...ctx },
    });
    run.events_emitted.push(stepStartEvent.event_id);

    try {
      const result = await tool.execute(resolvedInputs, ctx);

      if (result.success) {
        step.status = 'completed';
        step.output = result.outputs;
        run.results[step.step_id] = result.outputs;
        run.steps_completed++;
        completedSteps.add(step.step_id);

        // Emit tool events
        for (const evt of result.events) {
          const emitted = await appendEvent(evt);
          run.events_emitted.push(emitted.event_id);
        }

        // Track artifacts
        if (result.outputs.proposal_id || result.outputs.draft_id || result.outputs.analysis) {
          run.artifacts.push({
            step_id: step.step_id,
            tool: step.tool,
            type: result.outputs.proposal_id ? 'proposal' :
                  result.outputs.draft_id ? 'email_draft' : 'analysis',
            data: result.outputs,
          });
        }

        await appendEvent({
          event_type: 'agent.action.completed',
          source: 'agent',
          correlation_id: plan.command_id,
          actor: 'agent',
          timestamp: new Date().toISOString(),
          payload: {
            step_id: step.step_id,
            tool: step.tool,
            duration_ms: result.duration_ms,
            side_effects: result.side_effects_performed,
          },
          metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', ...ctx },
        });
      } else {
        step.status = 'failed';
        step.error = result.error?.message || 'Unknown error';
        run.steps_failed++;

        // Retry logic
        if (result.error?.retryable && tool.contract.retry.max_retries > 0) {
          console.log(`[executor] Step ${step.step_id} failed (retryable), attempting retry...`);
          const delay = tool.contract.retry.base_delay_ms;
          await new Promise(resolve => setTimeout(resolve, delay));

          const retryResult = await tool.execute(resolvedInputs, ctx);
          if (retryResult.success) {
            step.status = 'completed';
            step.output = retryResult.outputs;
            step.error = undefined;
            run.results[step.step_id] = retryResult.outputs;
            run.steps_completed++;
            run.steps_failed--;
            completedSteps.add(step.step_id);

            for (const evt of retryResult.events) {
              const emitted = await appendEvent(evt);
              run.events_emitted.push(emitted.event_id);
            }
          }
        }

        if (step.status === 'failed') {
          await appendEvent({
            event_type: 'agent.action.failed',
            source: 'agent',
            correlation_id: plan.command_id,
            actor: 'agent',
            timestamp: new Date().toISOString(),
            payload: { step_id: step.step_id, tool: step.tool, error: step.error, retryable: result.error?.retryable },
            metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', ...ctx },
          });
        }
      }
    } catch (err: any) {
      step.status = 'failed';
      step.error = err.message;
      run.steps_failed++;

      await appendEvent({
        event_type: 'agent.action.failed',
        source: 'agent',
        correlation_id: plan.command_id,
        actor: 'agent',
        timestamp: new Date().toISOString(),
        payload: { step_id: step.step_id, tool: step.tool, error: err.message },
        metadata: { version: 1, environment: process.env.VERCEL_ENV || 'development', ...ctx },
      });
    }

    // Save checkpoint after each step
    await saveCheckpoint(run, plan);
  }

  // Finalize run
  run.current_step_id = null;
  run.completed_at = new Date().toISOString();
  run.duration_ms = Date.now() - startTime;
  run.status = run.steps_failed > 0
    ? (run.steps_completed > 0 ? 'completed' : 'failed') // partial success still "completed"
    : 'completed';

  // Save final state
  await saveCheckpoint(run, plan);

  // Emit completion event
  await appendEvent({
    event_type: 'agent.plan.completed',
    source: 'agent',
    correlation_id: plan.command_id,
    actor: 'agent',
    timestamp: new Date().toISOString(),
    payload: {
      plan_id: plan.plan_id,
      status: run.status,
      steps_completed: run.steps_completed,
      steps_failed: run.steps_failed,
      duration_ms: run.duration_ms,
      artifacts_count: run.artifacts.length,
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      command_id: plan.command_id,
      execution_run_id: run.execution_run_id,
      plan_id: plan.plan_id,
    },
  });

  return run;
}

// ── Input resolution ──────────────────────────────────────────────

/**
 * Resolve dynamic inputs that reference previous step outputs.
 * Pattern: { _resolve_from: { field: "step:N:path.to.value" } }
 */
function resolveInputs(
  inputs: Record<string, any>,
  results: Record<string, any>,
  steps: PlanStep[]
): Record<string, any> {
  const resolved = { ...inputs };

  if (resolved._resolve_from) {
    const refs = resolved._resolve_from;
    for (const [field, path] of Object.entries(refs)) {
      if (typeof path === 'string' && path.startsWith('step:')) {
        const value = resolveStepRef(path, results, steps);
        if (value !== undefined) {
          resolved[field] = value;
        }
      } else if (typeof path === 'object' && path !== null) {
        // Nested resolution (e.g., properties object)
        const resolvedNested: Record<string, any> = {};
        for (const [nk, nv] of Object.entries(path)) {
          if (typeof nv === 'string' && nv.startsWith('step:')) {
            resolvedNested[nk] = resolveStepRef(nv, results, steps);
          } else {
            resolvedNested[nk] = nv;
          }
        }
        resolved[field] = resolvedNested;
      }
    }
    delete resolved._resolve_from;
  }

  return resolved;
}

function resolveStepRef(ref: string, results: Record<string, any>, steps: PlanStep[]): any {
  // ref format: "step:N:path.to.value"
  const parts = ref.split(':');
  if (parts.length < 3) return undefined;

  const stepNum = parseInt(parts[1]);
  const path = parts.slice(2).join(':');
  const step = steps[stepNum - 1]; // 1-indexed
  if (!step) return undefined;

  const output = results[step.step_id];
  if (!output) return undefined;

  // Navigate path
  return getNestedValue(output, path);
}

function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    // Handle array index: "items.0.name"
    const idx = parseInt(part);
    if (!isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else {
      current = current[part];
    }
  }
  return current;
}

// ── Checkpoint ────────────────────────────────────────────────────

async function saveCheckpoint(run: ExecutionRun, plan: ExecutionPlan): Promise<void> {
  const kv = await getKV();
  const key = `exec:run:${run.execution_run_id}`;
  await kv.set(key, JSON.stringify({ run, plan }), { ex: 86400 });
}

export async function getExecutionRun(runId: string): Promise<{ run: ExecutionRun; plan: ExecutionPlan } | null> {
  const kv = await getKV();
  const key = `exec:run:${runId}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw as any;
}

// ── Cancel ────────────────────────────────────────────────────────

export async function cancelExecution(runId: string): Promise<boolean> {
  const data = await getExecutionRun(runId);
  if (!data) return false;

  data.run.status = 'cancelled';
  data.run.completed_at = new Date().toISOString();

  // Mark pending steps as skipped
  for (const step of data.plan.steps) {
    if (step.status === 'pending' || step.status === 'running') {
      step.status = 'skipped';
    }
  }

  await saveCheckpoint(data.run, data.plan);
  return true;
}
