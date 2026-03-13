/**
 * Jackson Scheduling Agent — First-class scheduling sub-agent.
 *
 * Lifecycle: requested → availability_checked → options_sent → booked
 *
 * Jackson detects scheduling requests, checks calendar availability,
 * proposes meeting slots, sends scheduling emails, and books meetings.
 */

import { appendEvent, generateId } from '../../event-log/eventStore.js';
import type { ExecutionContext } from '../../event-log/eventStore.js';
import { getTool } from '../../tools/registry.js';
import { getKV } from '../../lib/kv.js';

// ── Types ──────────────────────────────────────────────────────────

export type JacksonState = 'requested' | 'availability_checked' | 'options_sent' | 'booked' | 'failed' | 'cancelled';

export interface SchedulingRequest {
  request_id: string;
  command_id: string;
  state: JacksonState;
  requester: string;           // who asked ("mike", "system")
  target_company: string;
  target_contact?: string;
  target_email?: string;
  deal_id?: string;
  meeting_type: 'intro' | 'demo' | 'followup' | 'closing' | 'check_in';
  duration_minutes: number;
  preferred_window?: { start: string; end: string };
  available_slots: TimeSlot[];
  proposed_slots: TimeSlot[];
  booked_slot?: TimeSlot;
  draft_id?: string;
  calendar_event_id?: string;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface TimeSlot {
  start: string;   // ISO
  end: string;     // ISO
  score: number;   // 0-1 preference score
}

// ── Constants ──────────────────────────────────────────────────────

const BUSINESS_HOURS = { start: 9, end: 17 };  // 9am-5pm
const DEFAULT_DURATION = 30;
const BUFFER_MINUTES = 15;
const MAX_SLOTS_TO_PROPOSE = 3;
const SCHEDULING_TTL = 7 * 86400; // 7 days

// ── Main Entry ─────────────────────────────────────────────────────

export async function handleSchedulingRequest(
  params: {
    command_id: string;
    company: string;
    contact_name?: string;
    contact_email?: string;
    deal_id?: string;
    meeting_type?: string;
    duration_minutes?: number;
    preferred_days?: number;     // how many days out to search
  },
  ctx: ExecutionContext
): Promise<SchedulingRequest> {
  const requestId = generateId('sched');
  const now = new Date();

  const request: SchedulingRequest = {
    request_id: requestId,
    command_id: params.command_id,
    state: 'requested',
    requester: 'mike',
    target_company: params.company,
    target_contact: params.contact_name,
    target_email: params.contact_email,
    deal_id: params.deal_id,
    meeting_type: (params.meeting_type as any) || 'followup',
    duration_minutes: params.duration_minutes || DEFAULT_DURATION,
    available_slots: [],
    proposed_slots: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  // Set search window
  const daysOut = params.preferred_days || 7;
  request.preferred_window = {
    start: now.toISOString(),
    end: new Date(now.getTime() + daysOut * 86400000).toISOString(),
  };

  // Emit scheduling requested event
  await appendEvent({
    event_type: 'jackson.scheduling.requested',
    source: 'agent',
    entity_type: 'scheduling',
    entity_id: requestId,
    correlation_id: params.command_id,
    actor: 'jackson',
    timestamp: now.toISOString(),
    payload: {
      request_id: requestId,
      company: params.company,
      contact: params.contact_name,
      meeting_type: request.meeting_type,
      duration: request.duration_minutes,
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
  });

  await saveSchedulingRequest(request);

  // Step 1: Check availability
  try {
    await checkAvailability(request, ctx);
  } catch (err: any) {
    request.state = 'failed';
    request.error = `Availability check failed: ${err.message}`;
    await saveSchedulingRequest(request);
    return request;
  }

  // Step 2: Propose slots
  try {
    await proposeSlots(request, ctx);
  } catch (err: any) {
    request.state = 'failed';
    request.error = `Slot proposal failed: ${err.message}`;
    await saveSchedulingRequest(request);
    return request;
  }

  // Step 3: Send scheduling email
  try {
    await sendSchedulingEmail(request, ctx);
  } catch (err: any) {
    // Non-fatal — slots are still proposed
    console.error(`[jackson] Email send failed: ${err.message}`);
  }

  return request;
}

// ── Step 1: Check Calendar Availability ────────────────────────────

async function checkAvailability(request: SchedulingRequest, ctx: ExecutionContext): Promise<void> {
  const calendarTool = await getTool('calendar.get_events');
  if (!calendarTool) {
    throw new Error('Calendar tool not available');
  }

  const result = await calendarTool.execute({
    start: request.preferred_window!.start,
    end: request.preferred_window!.end,
  }, ctx);

  if (!result.success) {
    throw new Error(result.error?.message || 'Calendar fetch failed');
  }

  const events = result.outputs.events || [];
  const busyBlocks = events.map((e: any) => ({
    start: new Date(e.start).getTime(),
    end: new Date(e.end).getTime(),
  }));

  // Find free slots during business hours
  const slots = findFreeSlots(
    new Date(request.preferred_window!.start),
    new Date(request.preferred_window!.end),
    busyBlocks,
    request.duration_minutes,
  );

  request.available_slots = slots;
  request.state = 'availability_checked';
  request.updated_at = new Date().toISOString();

  await appendEvent({
    event_type: 'jackson.availability.checked',
    source: 'agent',
    entity_type: 'scheduling',
    entity_id: request.request_id,
    correlation_id: request.command_id,
    actor: 'jackson',
    timestamp: new Date().toISOString(),
    payload: {
      request_id: request.request_id,
      slots_found: slots.length,
      window: request.preferred_window,
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      ...ctx,
    },
  });

  await saveSchedulingRequest(request);
}

// ── Step 2: Propose Best Slots ─────────────────────────────────────

async function proposeSlots(request: SchedulingRequest, ctx: ExecutionContext): Promise<void> {
  if (request.available_slots.length === 0) {
    throw new Error('No available slots found in the specified window');
  }

  // Score and rank slots
  const scored = request.available_slots.map(slot => ({
    ...slot,
    score: scoreSlot(slot),
  }));

  scored.sort((a, b) => b.score - a.score);
  request.proposed_slots = scored.slice(0, MAX_SLOTS_TO_PROPOSE);
  request.state = 'options_sent';
  request.updated_at = new Date().toISOString();

  await appendEvent({
    event_type: 'jackson.slots.proposed',
    source: 'agent',
    entity_type: 'scheduling',
    entity_id: request.request_id,
    correlation_id: request.command_id,
    actor: 'jackson',
    timestamp: new Date().toISOString(),
    payload: {
      request_id: request.request_id,
      proposed_count: request.proposed_slots.length,
      slots: request.proposed_slots,
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      ...ctx,
    },
  });

  await saveSchedulingRequest(request);
}

// ── Step 3: Send Scheduling Email ──────────────────────────────────

async function sendSchedulingEmail(request: SchedulingRequest, ctx: ExecutionContext): Promise<void> {
  if (!request.target_email) {
    console.log('[jackson] No target email — skipping email send');
    return;
  }

  const draftTool = await getTool('gmail.create_draft');
  if (!draftTool) return;

  const slotLines = request.proposed_slots.map((slot, i) => {
    const d = new Date(slot.start);
    const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return `  ${i + 1}. ${day} at ${time} (${request.duration_minutes} min)`;
  }).join('\n');

  const body = [
    `Hi ${request.target_contact || 'there'},`,
    '',
    `I'd like to schedule a ${request.meeting_type} meeting. Here are a few times that work on our end:`,
    '',
    slotLines,
    '',
    `Let me know which works best, or feel free to suggest an alternative.`,
    '',
    `Best,`,
    `Mike`,
  ].join('\n');

  const result = await draftTool.execute({
    to: request.target_email,
    subject: `Scheduling: ${request.meeting_type} — ${request.target_company}`,
    body,
  }, ctx);

  if (result.success) {
    request.draft_id = result.outputs.draft_id;
    await saveSchedulingRequest(request);
  }
}

// ── Book Meeting (called when user confirms a slot) ────────────────

export async function bookMeeting(
  requestId: string,
  slotIndex: number,
  ctx: ExecutionContext
): Promise<SchedulingRequest | null> {
  const request = await getSchedulingRequest(requestId);
  if (!request) return null;

  const slot = request.proposed_slots[slotIndex];
  if (!slot) return null;

  request.booked_slot = slot;
  request.state = 'booked';
  request.updated_at = new Date().toISOString();

  await appendEvent({
    event_type: 'jackson.meeting.booked',
    source: 'agent',
    entity_type: 'scheduling',
    entity_id: request.request_id,
    correlation_id: request.command_id,
    actor: 'jackson',
    timestamp: new Date().toISOString(),
    payload: {
      request_id: request.request_id,
      company: request.target_company,
      slot,
      deal_id: request.deal_id,
    },
    metadata: {
      version: 1,
      environment: process.env.VERCEL_ENV || 'development',
      ...ctx,
    },
  });

  await saveSchedulingRequest(request);
  return request;
}

// ── Cancel ─────────────────────────────────────────────────────────

export async function cancelScheduling(requestId: string): Promise<boolean> {
  const request = await getSchedulingRequest(requestId);
  if (!request) return false;

  request.state = 'cancelled';
  request.updated_at = new Date().toISOString();
  await saveSchedulingRequest(request);
  return true;
}

// ── Slot Finding ───────────────────────────────────────────────────

function findFreeSlots(
  windowStart: Date,
  windowEnd: Date,
  busyBlocks: { start: number; end: number }[],
  durationMinutes: number,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const slotMs = durationMinutes * 60000;
  const bufferMs = BUFFER_MINUTES * 60000;
  const stepMs = 30 * 60000; // 30-min increments

  // Sort busy blocks
  busyBlocks.sort((a, b) => a.start - b.start);

  let cursor = windowStart.getTime();
  const end = windowEnd.getTime();

  while (cursor + slotMs <= end && slots.length < 20) {
    const candidateStart = new Date(cursor);
    const candidateEnd = new Date(cursor + slotMs);

    // Check business hours
    const hour = candidateStart.getHours();
    const endHour = candidateEnd.getHours() + candidateEnd.getMinutes() / 60;

    if (hour >= BUSINESS_HOURS.start && endHour <= BUSINESS_HOURS.end) {
      // Check weekday
      const day = candidateStart.getDay();
      if (day >= 1 && day <= 5) {
        // Check no overlap with busy blocks (including buffer)
        const slotStart = cursor - bufferMs;
        const slotEnd = cursor + slotMs + bufferMs;
        const conflict = busyBlocks.some(b => b.start < slotEnd && b.end > slotStart);

        if (!conflict) {
          slots.push({
            start: candidateStart.toISOString(),
            end: candidateEnd.toISOString(),
            score: scoreSlot({ start: candidateStart.toISOString(), end: candidateEnd.toISOString(), score: 0 }),
          });
        }
      }
    }

    cursor += stepMs;

    // Skip to next business day if past business hours
    const cursorDate = new Date(cursor);
    if (cursorDate.getHours() >= BUSINESS_HOURS.end) {
      const nextDay = new Date(cursorDate);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(BUSINESS_HOURS.start, 0, 0, 0);
      // Skip weekends
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
        nextDay.setDate(nextDay.getDate() + 1);
      }
      cursor = nextDay.getTime();
    }
  }

  return slots;
}

function scoreSlot(slot: TimeSlot): number {
  const start = new Date(slot.start);
  const hour = start.getHours();

  // Prefer mid-morning and early afternoon
  if (hour >= 10 && hour <= 11) return 0.95;
  if (hour >= 14 && hour <= 15) return 0.90;
  if (hour === 9) return 0.80;
  if (hour >= 12 && hour <= 13) return 0.70; // lunch overlap
  if (hour >= 16) return 0.60;
  return 0.50;
}

// ── Persistence ────────────────────────────────────────────────────

async function saveSchedulingRequest(request: SchedulingRequest): Promise<void> {
  const kv = await getKV();
  const key = `jackson:sched:${request.request_id}`;
  await kv.set(key, JSON.stringify(request), { ex: SCHEDULING_TTL });

  const cmdKey = `jackson:cmd:${request.command_id}`;
  await kv.set(cmdKey, request.request_id, { ex: SCHEDULING_TTL });
}

export async function getSchedulingRequest(requestId: string): Promise<SchedulingRequest | null> {
  const kv = await getKV();
  const key = `jackson:sched:${requestId}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw as any;
}

export async function getSchedulingByCommand(commandId: string): Promise<SchedulingRequest | null> {
  const kv = await getKV();
  const cmdKey = `jackson:cmd:${commandId}`;
  const requestId = await kv.get(cmdKey);
  if (!requestId || typeof requestId !== 'string') return null;
  return getSchedulingRequest(requestId);
}
