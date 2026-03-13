/**
 * Command Interpreter — Converts natural language into structured intent.
 *
 * Input: raw text command
 * Output: { intent, entities, required_actions, confidence, clarifications }
 */

import { generateId } from '../event-log/eventStore.js';

// ── Types ──────────────────────────────────────────────────────────

export interface CommandIntent {
  command_id: string;
  raw_text: string;
  intent: string;
  entities: ResolvedEntity[];
  required_actions: string[];
  parameters: Record<string, any>;
  mode: 'analyze' | 'draft' | 'execute';
  confidence: number;
  clarifications: Clarification[];
}

export interface ResolvedEntity {
  raw_text: string;
  entity_type: 'company' | 'contact' | 'deal' | 'meeting' | 'thread' | 'rep' | 'time';
  resolved_name: string;
  resolved_id?: string;
  source?: string;
  confidence: number;
}

export interface Clarification {
  id: string;
  question: string;
  type: 'single_select' | 'confirm' | 'freeform';
  options: { label: string; value: string; is_recommended: boolean }[];
  required: boolean;
}

// ── Interpreter ───────────────────────────────────────────────────

export async function interpretCommand(
  text: string,
  context?: { deals?: any[]; meetings?: any[]; reps?: string[] }
): Promise<CommandIntent> {
  const commandId = generateId('cmd');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    // Fallback: rule-based parsing
    return fallbackInterpret(commandId, text);
  }

  try {
    const contextBlock = buildContextBlock(context);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are the command interpreter for a revenue operations system called COS Agent.

Given a user command, extract structured intent. Return ONLY valid JSON:

{
  "intent": "see intent list below",
  "entities": [
    { "raw_text": "ARMRA", "entity_type": "company", "resolved_name": "ARMRA", "confidence": 0.95 }
  ],
  "required_actions": [],
  "parameters": {},
  "mode": "execute",
  "confidence": 0.92,
  "clarifications": []
}

INTENT CLASSIFICATION — 3 LAYERS (evaluate in order):

=== LAYER 1: READ / QUERY (non-mutating, data-only) ===
If the command is asking to SEE, SHOW, FIND, LOOK UP, PULL UP, or OPEN data — classify as READ.
READ commands NEVER trigger workflows, automation, triage, or pipelines.

Intents:
- read.email — "pull up my latest email from X", "show email from X", "find last email from X", "what did X send me", "did X email me", "open newest message from X". Set parameters.query to the company/person name. Set parameters.max_results to 1-5 depending on "latest"/"last" (1) vs "show all" (5).
- read.deal — "show me the deal for X", "pull up X's deal", "what stage is X in". Set parameters.query to company name.
- read.pipeline — "show pipeline", "show Brian's deals", "show all deals in Disco Complete". Set parameters.query.
- read.calendar — "what meetings do I have tomorrow", "show my calendar", "what's on my schedule". Set parameters.time_range.
- read.contact — "show contact for X", "who is X". Set parameters.query.

READ verbs: show, pull up, find, open, get, look up, what is, what are, latest, last, newest, did X, display, check

=== LAYER 2: ASSIST (analysis, no mutation) ===
- email_context.recommendation — "I just got an email from X, what do you recommend?", "X emailed me, what should we do?", "I got a note from X, what's the move?", "What do you recommend I do about this X thread?", "I just heard from X, how should I respond?". This is for when the user has received communication and wants strategic guidance. Extract the company entity. Set parameters.query to the company name.
- assist.summarize — "summarize this email/thread/call", "what are the action items"
- assist.meeting_prep — "prep me for my meeting with X"
- assist.analyze — "analyze the pipeline", "what's the risk on X"
- inbox.triage — ONLY when user explicitly says "triage", "need a reply", "what needs a reply", "prioritize inbox". NOT for "show email" or "pull up email".
- oversight.daily_brief — "what matters today", "daily brief"
- pipeline.top_actions — "highest leverage actions", "top pipeline actions"
- pipeline.stale — "stale deals", "slip risk"
- pipeline.slip_risk — "which deals are slipping"

=== LAYER 3: WORKFLOW (mutating systems) ===
- postcall.full — "I just finished my call with X" (full post-call automation)
- email.draft — "draft a follow-up", "draft email to X"
- proposal.create — "create proposal for X"
- scheduling.request — "loop in Jackson", "schedule", "find a time", "book a meeting"
- pipeline.stage_change — "move X to [stage]", "change X to Closed Won"
- pipeline.stage_update_with_notes — "move X to [stage] and add Granola notes/summary/next steps"
- opportunity.create — "create opportunity/deal for X"

CRITICAL ROUTING RULES:
1. If the command does NOT contain an explicit mutating action verb (move, create, draft, update, schedule, add, change, set), DEFAULT TO READ.
2. "Pull up email from X" = read.email, NOT inbox.triage.
3. "Show my emails" = read.email, NOT inbox.triage.
4. "Find my last email from X" = read.email, NOT inbox.triage.
5. inbox.triage ONLY when user says "triage", "what needs a reply", or "emails that need a reply".
6. "Show pipeline" = read.pipeline, NOT pipeline.top_actions.
7. "What stage is X in" = read.deal, NOT pipeline.stage_change.
8. "I just got an email from X, what should we do?" = email_context.recommendation, NOT inbox.triage, NOT read.email. This applies when the user mentions receiving an email/message/note AND asks for advice/recommendation/next move.
9. "X emailed me, what's the move?" = email_context.recommendation, NOT inbox.triage.

For pipeline.stage_change: Set parameters.target_stage. Extract ONLY entities from user's command text. Set required_actions to ["hubspot.search_company", "hubspot.update_deal"].
For opportunity.create: Set parameters.target_stage, parameters.company_name. Set required_actions to ["hubspot.search_company", "hubspot.create_company", "hubspot.create_deal"].
For pipeline.stage_update_with_notes: Set parameters.target_stage. Set required_actions to ["hubspot.search_company", "granola.get_notes", "granola.summarize_for_crm", "hubspot.update_deal", "hubspot.create_note"].

CRITICAL ENTITY RESOLUTION RULES:
- Only return entities that appear verbatim in the user's command text.
- Never substitute a missing or duplicate entity with a different one.
- If the user mentions "Hotel Collection" twice, return ONE entity for "Hotel Collection", not a substitute.
- raw_text must be the exact substring from the user's command.

${contextBlock}`,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const data = await response.json();
    const rawText = (data.content?.[0]?.text || '{}')
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(rawText);

    // Deduplicate entities by resolved_name (case-insensitive)
    const rawEntities: ResolvedEntity[] = (parsed.entities || []).map((e: any) => ({
      raw_text: e.raw_text || '',
      entity_type: e.entity_type || 'company',
      resolved_name: e.resolved_name || e.raw_text || '',
      resolved_id: e.resolved_id,
      source: e.source,
      confidence: e.confidence || 0.5,
    }));
    const seen = new Set<string>();
    const dedupedEntities = rawEntities.filter(e => {
      const key = `${e.entity_type}:${(e.resolved_name || '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      command_id: commandId,
      raw_text: text,
      intent: parsed.intent || 'unknown',
      entities: dedupedEntities,
      required_actions: parsed.required_actions || [],
      parameters: parsed.parameters || {},
      mode: parsed.mode || 'execute',
      confidence: parsed.confidence || 0.5,
      clarifications: parsed.clarifications || [],
    };
  } catch (err) {
    console.error('[interpreter] AI interpretation failed, using fallback:', err);
    return fallbackInterpret(commandId, text);
  }
}

// ── Fallback rule-based interpreter ───────────────────────────────

function fallbackInterpret(commandId: string, text: string): CommandIntent {
  const lower = text.toLowerCase();
  let intent = 'unknown';
  let actions: string[] = [];
  let mode: 'analyze' | 'draft' | 'execute' = 'execute';
  const parameters: Record<string, any> = {};

  // ── LAYER 1: READ / QUERY (non-mutating) — check FIRST ──────────
  const READ_VERBS = /\b(show|pull\s*up|find|open|get|look\s*up|display|check|what\s+is|what\s+are|what\s+did|did\s+\w+\s+(email|send|message)|latest|last|newest)\b/i;
  const MUTATE_VERBS = /\b(move|create|draft|update|schedule|add|change|set|book|loop\s*in|send|generate|triage)\b/i;
  const isReadLike = READ_VERBS.test(lower) && !MUTATE_VERBS.test(lower);

  // Read: email queries — "pull up my latest email from X", "show email from X", "find last email from X", "what did X send me", "did X email me today"
  if (isReadLike && (lower.includes('email') || lower.includes('message') || lower.match(/\b(send|sent)\s+me\b/) || lower.match(/\bemail\s*me\b/))) {
    intent = 'read.email';
    actions = ['gmail.search_threads'];
    mode = 'analyze';
    parameters.max_results = (lower.includes('latest') || lower.includes('last') || lower.includes('newest') || lower.includes('most recent')) ? 1 : 5;
    // Extract company/person for Gmail query
    const fromMatch = text.match(/\bfrom\s+(.+?)(?:\s*$|\s+(?:today|yesterday|this week|last week))/i);
    if (fromMatch) parameters.query = fromMatch[1].trim();
  }
  // Read: deal queries — "show me the deal for X", "what stage is X in"
  else if (isReadLike && (lower.includes('deal') || lower.match(/\bstage\b.*\bin\b/) || lower.match(/\bwhat\s+stage\b/))) {
    intent = 'read.deal';
    actions = ['hubspot.search_company'];
    mode = 'analyze';
  }
  // Read: pipeline — "show pipeline", "show Brian's deals"
  else if (isReadLike && (lower.includes('pipeline') || lower.match(/\b\w+'s\s+deals\b/))) {
    intent = 'read.pipeline';
    actions = ['hubspot.search_company'];
    mode = 'analyze';
  }
  // Read: calendar — "what meetings do I have", "show my calendar"
  else if (isReadLike && (lower.includes('meeting') || lower.includes('calendar') || lower.includes('schedule'))) {
    intent = 'read.calendar';
    actions = ['calendar.get_events'];
    mode = 'analyze';
  }
  // Read: contact — "show contact for X", "who is X"
  else if (isReadLike && (lower.includes('contact') || lower.match(/\bwho\s+is\b/))) {
    intent = 'read.contact';
    actions = ['hubspot.search_company'];
    mode = 'analyze';
  }

  // ── LAYER 2: ASSIST (analysis, no mutation) ────────────────────
  // Email context recommendation — "I just got an email from X, what should we do?"
  // Must be checked BEFORE inbox.triage since both mention email
  else if (
    (lower.match(/\b(got|received|just\s+got|just\s+heard|just\s+received|heard\s+from)\b/) ||
     lower.match(/\b\w+\s+emailed\s+me\b/) ||
     lower.match(/\b(got|received)\s+a\s+(note|email|message)\b/) ||
     (lower.match(/\b(this|the|that)\s+(?:\w+\s+)?(thread|email|message|conversation)\b/) && lower.match(/\b(recommend|should|what.+do|what.+move|how\s+should|advise)\b/))) &&
    lower.match(/\b(recommend|should|what.+do|what.+move|how\s+should|what.+next|what.+think|advise|suggest|respond)\b/)
  ) {
    intent = 'email_context.recommendation';
    actions = ['gmail.search_threads', 'hubspot.search_company', 'granola.get_notes', 'calendar.get_events'];
    mode = 'analyze';
    // Extract company name from "email from X" or "X emailed me"
    const fromRec = text.match(/\b(?:from|about)\s+(?:this\s+)?(.+?)(?:\s*[.?!]|\s+(?:what|how|should|thread|email))/i);
    const emailedMe = text.match(/\b(.+?)\s+emailed\s+me\b/i);
    if (fromRec) parameters.query = fromRec[1].trim();
    else if (emailedMe) parameters.query = emailedMe[1].replace(/^i\s+just\s+/i, '').trim();
  }
  // Inbox triage — ONLY when explicitly requesting triage/reply-needed
  else if (lower.match(/\b(triage|need.+repl|needs?\s+a?\s*reply|prioritize\s+inbox)\b/)) {
    intent = 'inbox.triage';
    actions = ['gmail.search_threads'];
    mode = 'analyze';
  }
  // Daily brief / what matters
  else if (lower.includes('what matters') || lower.match(/\bdaily\s*brief\b/)) {
    intent = 'oversight.daily_brief';
    actions = ['hubspot.search_company', 'calendar.get_events'];
    mode = 'analyze';
  }
  // Top pipeline actions
  else if (lower.includes('highest leverage') || lower.includes('top actions')) {
    intent = 'pipeline.top_actions';
    actions = ['hubspot.search_company', 'calendar.get_events'];
    mode = 'analyze';
  }
  // Stale / slip risk
  else if (lower.includes('stale') || lower.includes('slip')) {
    intent = 'pipeline.stale';
    actions = ['hubspot.search_company'];
    mode = 'analyze';
  }
  // Meeting prep
  else if (lower.includes('prep') && lower.includes('meeting')) {
    intent = 'meeting.prep';
    actions = ['calendar.get_events', 'hubspot.get_deal', 'gmail.search_threads', 'granola.get_notes'];
    mode = 'analyze';
  }
  // Team oversight
  else if (lower.includes('intervention') || lower.includes('step in')) {
    intent = 'oversight.intervention';
    actions = ['hubspot.search_company'];
    mode = 'analyze';
  }

  // ── LAYER 3: WORKFLOW (mutating systems) ────────────────────────
  // Post-call
  else if (lower.includes('just finished') || lower.includes('post-call') || lower.includes('postcall')) {
    intent = 'postcall.full';
    actions = ['granola.get_notes', 'granola.analyze_note', 'proposal.generate', 'gmail.create_draft', 'hubspot.update_deal', 'hubspot.create_note'];
  }
  // Draft email
  else if (lower.includes('draft') && (lower.includes('email') || lower.includes('follow'))) {
    intent = 'email.draft';
    actions = ['hubspot.get_deal', 'gmail.search_threads', 'gmail.create_draft'];
  }
  // Proposal
  else if (lower.includes('proposal') || lower.includes('order form')) {
    intent = 'proposal.create';
    actions = ['hubspot.get_deal', 'pricing.calculate', 'proposal.generate'];
  }
  // Scheduling / Jackson
  else if (lower.includes('jackson') || lower.match(/\bschedule\b/) || lower.includes('find a time') || lower.includes('book a meeting')) {
    intent = 'scheduling.request';
    actions = ['calendar.get_events', 'gmail.create_draft'];
  }
  // Stage update WITH Granola notes/summary/next steps
  else if (
    lower.match(/\b(move|update|change|set)\b/) &&
    (lower.includes('granola') || lower.match(/\bsummar/) || lower.match(/\bnotes?\b/) || lower.includes('next step') || lower.includes('action item') || lower.includes('call summary'))
  ) {
    intent = 'pipeline.stage_update_with_notes';
    actions = ['hubspot.search_company', 'granola.get_notes', 'granola.summarize_for_crm', 'hubspot.update_deal', 'hubspot.create_note'];
    mode = 'execute';

    const stageMatch = lower.match(/\b(?:to|as)\s+(closed\s*lost|closed\s*won|contract\s*sent|committed|negotiating|demo\s*completed|demo\s*scheduled|disco\s*booked|disco\s*complete|presentation\s*scheduled|qualified\s*to\s*buy|nurture)/i);
    if (stageMatch) {
      parameters.target_stage = normalizeStage(stageMatch[1]);
    }
  }
  // Opportunity/deal creation
  else if (lower.match(/\b(create|add|new)\b.*(opportunity|deal|opp)\b/i) || lower.match(/\badd\b.*\bto\s+hubspot\b/i)) {
    intent = 'opportunity.create';
    actions = ['hubspot.search_company', 'hubspot.create_company', 'hubspot.create_deal'];
    mode = 'execute';

    const stageMatch = lower.match(/\b(?:under|in|at|stage)\s+(closed\s*lost|closed\s*won|contract\s*sent|committed|negotiating|demo\s*completed|demo\s*scheduled|disco\s*booked|disco\s*complete|presentation\s*scheduled|qualified\s*to\s*buy|nurture)/i);
    if (stageMatch) {
      parameters.target_stage = normalizeStage(stageMatch[1]);
      parameters.target_stage_label = stageMatch[1].trim();
    }

    const forMatch = text.match(/\bfor\s+(.+?)(?:\s*$|\s+(?:under|in|at|stage)\b)/i);
    if (forMatch) {
      parameters.company_name = forMatch[1].trim();
    } else {
      const addMatch = text.match(/\badd\s+(.+?)\s+to\s+hubspot/i);
      if (addMatch) {
        parameters.company_name = addMatch[1].trim();
      }
    }
  }
  // Stage change: "move X to Closed Lost"
  else if (lower.match(/\b(move|change|set|update)\b.*\b(to|as)\b.*\b(closed.?lost|closed.?won|contract.?sent|committed|negotiating|demo.?completed|demo.?scheduled|disco.?booked|disco.?complete|presentation|qualified|nurture)\b/i)) {
    intent = 'pipeline.stage_change';
    actions = ['hubspot.search_company', 'hubspot.update_deal'];
    mode = 'execute';
  }

  // Extract company entities (capitalized words that aren't common words)
  const rawEntities = extractEntities(text);

  // Deduplicate entities by resolved_name
  const seenFb = new Set<string>();
  const entities = rawEntities.filter(e => {
    const key = `${e.entity_type}:${(e.resolved_name || '').toLowerCase()}`;
    if (seenFb.has(key)) return false;
    seenFb.add(key);
    return true;
  });

  // Extract target stage for stage change commands
  if (intent === 'pipeline.stage_change') {
    const stageMatch = lower.match(/\b(?:to|as)\s+(closed\s*lost|closed\s*won|contract\s*sent|committed|negotiating|demo\s*completed|demo\s*scheduled|disco\s*booked|disco\s*complete|presentation\s*scheduled|qualified\s*to\s*buy|nurture)/i);
    if (stageMatch) {
      parameters.target_stage = normalizeStage(stageMatch[1]);
    }
  }

  return {
    command_id: commandId,
    raw_text: text,
    intent,
    entities,
    required_actions: actions,
    parameters,
    mode,
    confidence: intent === 'unknown' ? 0.2 : 0.7,
    clarifications: [],
  };
}

function extractEntities(text: string): ResolvedEntity[] {
  const entities: ResolvedEntity[] = [];
  const commonWords = new Set([
    'i', 'my', 'me', 'the', 'a', 'an', 'just', 'finished', 'call', 'with',
    'review', 'granola', 'notes', 'create', 'proposal', 'draft', 'email',
    'update', 'hubspot', 'stage', 'pull', 'all', 'emails', 'today', 'that',
    'need', 'reply', 'show', 'five', 'highest', 'leverage', 'pipeline',
    'actions', 'for', 'every', 'overdue', 'deal', 'closing', 'this', 'month',
    'prep', 'tomorrow', 'meetings', 'what', 'changed', 'in', 'find', 'where',
    'looping', 'jackson', 'help', 'time', 'deals', 'send', 'follow', 'up',
    'and', 'set', 'next', 'step', 'to', 'about', 'it', 'get', 'now',
    'generate', 'pricing', 'check', 'on', 'from',
  ]);

  // Match capitalized words/phrases that aren't at sentence start
  const words = text.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/[.,!?;:'"]/g, '');
    if (
      word.length > 1 &&
      word[0] === word[0].toUpperCase() &&
      !commonWords.has(word.toLowerCase()) &&
      i > 0 // Skip first word (sentence start)
    ) {
      // Check if this is part of a multi-word entity
      let entityName = word;
      while (i + 1 < words.length) {
        const next = words[i + 1].replace(/[.,!?;:'"]/g, '');
        if (next.length > 1 && next[0] === next[0].toUpperCase() && !commonWords.has(next.toLowerCase())) {
          entityName += ' ' + next;
          i++;
        } else break;
      }

      entities.push({
        raw_text: entityName,
        entity_type: 'company',
        resolved_name: entityName,
        confidence: 0.7,
      });
    }
  }

  // Check for rep names
  const repNames = ['jason', 'brian', 'will', 'mike'];
  for (const rep of repNames) {
    if (text.toLowerCase().includes(rep) && !entities.some(e => e.raw_text.toLowerCase() === rep)) {
      entities.push({
        raw_text: rep,
        entity_type: 'rep',
        resolved_name: rep.charAt(0).toUpperCase() + rep.slice(1),
        confidence: 0.8,
      });
    }
  }

  return entities;
}

function normalizeStage(raw: string): string {
  const s = raw.toLowerCase().replace(/\s+/g, '');
  const map: Record<string, string> = {
    'closedlost': 'closedlost',
    'closedwon': 'closedwon',
    'contractsent': 'contractsent',
    'committed': '227588384',
    'negotiating': 'decisionmakerboughtin',
    'democompleted': '123162712',
    'demoscheduled': 'appointmentscheduled',
    'discobooked': '93124525',
    'discocomplete': '998751160',
    'presentationscheduled': 'presentationscheduled',
    'qualifiedtobuy': 'qualifiedtobuy',
    'nurture': '60237411',
  };
  return map[s] || s;
}

function buildContextBlock(context?: { deals?: any[]; meetings?: any[]; reps?: string[] }): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.deals?.length) {
    parts.push(`Active deals: ${context.deals.slice(0, 10).map((d: any) => `${d.name} (${d.stage})`).join(', ')}`);
  }
  if (context.meetings?.length) {
    parts.push(`Recent meetings: ${context.meetings.slice(0, 5).map((m: any) => m.title).join(', ')}`);
  }
  if (context.reps?.length) {
    parts.push(`Team members: ${context.reps.join(', ')}`);
  }
  return parts.length ? `\nContext:\n${parts.join('\n')}` : '';
}
