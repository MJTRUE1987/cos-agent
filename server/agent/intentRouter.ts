/**
 * Intent Router — Strict deterministic classifier for command intent.
 *
 * 4 top-level classes:
 *   read_query        — fetch + display data, no side effects
 *   assist_recommend   — aggregate context + advise, no mutations
 *   workflow_mutation   — mutate external systems, safety checks required
 *   create_wizard      — enter structured wizard mode
 *
 * Default rule: if no explicit mutation verb is present, classify as read_query.
 */

// ── Types ──────────────────────────────────────────────────────────

export type TopLevelIntent = 'read_query' | 'assist_recommend' | 'workflow_mutation' | 'create_wizard';

export interface IntentClass {
  top_level: TopLevelIntent;
  sub_intent: string;
  confidence: number;
}

// ── Verb sets ──────────────────────────────────────────────────────

const MUTATION_VERBS = /\b(move|create|draft|update|schedule|add|change|set|book|loop\s*in|send|generate|triage)\b/i;

// ── Matchers (evaluated in priority order) ─────────────────────────

interface Matcher {
  top_level: TopLevelIntent;
  sub_intent: string;
  test: (lower: string, raw: string) => boolean;
  confidence: number;
}

const MATCHERS: Matcher[] = [
  // ── CREATE / WIZARD ─────────────────────────────────────────
  {
    top_level: 'create_wizard',
    sub_intent: 'opportunity.create',
    test: (l) => {
      // Don't match if this is a stage change command (e.g. "Move X - New Deal to Disco Complete")
      const isStageChange = /\b(move|change|set|update)\b/.test(l) &&
        /\b(to|as)\b/.test(l) &&
        /\b(closed.?lost|closed.?won|contract.?sent|committed|negotiating|demo.?completed|demo.?scheduled|disco.?booked|disco.?complete|presentation|qualified|nurture)\b/.test(l);
      if (isStageChange) return false;

      return /\b(create|add)\b.*(opportunity|deal|opp)\b/.test(l) ||
        /\badd\b.*\bto\s+hubspot\b/.test(l) ||
        /\bcreate\b.*\b(contact|company)\b/.test(l);
    },
    confidence: 0.85,
  },

  // ── READ / QUERY (check BEFORE assist to avoid over-classifying) ─
  {
    top_level: 'read_query',
    sub_intent: 'read.email',
    test: (l) => {
      const hasReadVerb = /\b(show|pull\s*up|find|open|get|look\s*up|display|check|what\s+did|did\s+\w+\s+(email|send)|latest|last|newest)\b/.test(l);
      const hasEmailRef = /\b(email|message)\b/.test(l) || /\b(send|sent)\s+me\b/.test(l) || /\bemail\s*me\b/.test(l);
      return hasReadVerb && hasEmailRef && !MUTATION_VERBS.test(l);
    },
    confidence: 0.85,
  },
  {
    top_level: 'read_query',
    sub_intent: 'read.deal',
    test: (l) => {
      const hasReadVerb = /\b(show|pull\s*up|find|open|get|look\s*up|display|check|what\s+is|what\s+are|what\s+stage)\b/.test(l);
      return hasReadVerb && (/\bdeal\b/.test(l) || /\bstage\b.*\bin\b/.test(l) || /\bwhat\s+stage\b/.test(l)) && !MUTATION_VERBS.test(l);
    },
    confidence: 0.8,
  },
  {
    top_level: 'read_query',
    sub_intent: 'read.pipeline',
    test: (l) => {
      const hasReadVerb = /\b(show|pull\s*up|find|open|get|look\s*up|display|check)\b/.test(l);
      return hasReadVerb && (/\bpipeline\b/.test(l) || /\b\w+'s\s+deals\b/.test(l)) && !MUTATION_VERBS.test(l);
    },
    confidence: 0.8,
  },
  {
    top_level: 'read_query',
    sub_intent: 'read.calendar',
    test: (l) => {
      const hasReadVerb = /\b(show|pull\s*up|find|open|get|look\s*up|display|check|what)\b/.test(l);
      return hasReadVerb && (/\bmeeting/.test(l) || /\bcalendar\b/.test(l) || /\bschedule\b/.test(l)) && !MUTATION_VERBS.test(l);
    },
    confidence: 0.8,
  },
  {
    top_level: 'read_query',
    sub_intent: 'read.contact',
    test: (l) => {
      const hasReadVerb = /\b(show|pull\s*up|find|open|get|look\s*up|display|check|who\s+is)\b/.test(l);
      return hasReadVerb && /\bcontact\b/.test(l) && !MUTATION_VERBS.test(l);
    },
    confidence: 0.8,
  },

  // ── ASSIST / RECOMMEND ──────────────────────────────────────
  {
    top_level: 'assist_recommend',
    sub_intent: 'email_context.recommendation',
    test: (l) =>
      (/\b(got|received|just\s+got|just\s+heard|just\s+received|heard\s+from)\b/.test(l) ||
       /\b\w+\s+emailed\s+me\b/.test(l) ||
       /\b(got|received)\s+a\s+(note|email|message)\b/.test(l) ||
       (/\b(this|the|that)\s+(?:\w+\s+)?(thread|email|message|conversation)\b/.test(l) && /\b(recommend|should|what.+do|what.+move|how\s+should|advise)\b/.test(l))) &&
      /\b(recommend|should|what.+do|what.+move|how\s+should|what.+next|what.+think|advise|suggest|respond)\b/.test(l),
    confidence: 0.85,
  },
  {
    top_level: 'assist_recommend',
    sub_intent: 'assist.meeting_prep',
    test: (l) => /\bprep\b/.test(l) && /\bmeeting/.test(l),
    confidence: 0.8,
  },
  {
    top_level: 'assist_recommend',
    sub_intent: 'pipeline.top_actions',
    test: (l) => /\b(highest\s+leverage|top\s+actions|top\s+pipeline)\b/.test(l),
    confidence: 0.8,
  },
  {
    top_level: 'assist_recommend',
    sub_intent: 'oversight.daily_brief',
    test: (l) => /\bwhat\s+matters\b/.test(l) || /\bdaily\s*brief\b/.test(l),
    confidence: 0.8,
  },
  {
    top_level: 'assist_recommend',
    sub_intent: 'pipeline.stale',
    test: (l) => /\b(stale|slip)\b/.test(l) && !MUTATION_VERBS.test(l),
    confidence: 0.75,
  },
  {
    top_level: 'assist_recommend',
    sub_intent: 'inbox.triage',
    test: (l) => /\b(triage|need.+repl|needs?\s+a?\s*reply|prioritize\s+inbox)\b/.test(l),
    confidence: 0.8,
  },

  // ── WORKFLOW / MUTATION ─────────────────────────────────────
  {
    top_level: 'workflow_mutation',
    sub_intent: 'pipeline.stage_update_with_notes',
    test: (l) =>
      /\b(move|update|change|set)\b/.test(l) &&
      (/\bgranola\b/.test(l) || /\bsummar/.test(l) || /\bnotes?\b/.test(l) || /\bnext\s+step/.test(l) || /\baction\s+item/.test(l)),
    confidence: 0.85,
  },
  {
    top_level: 'workflow_mutation',
    sub_intent: 'pipeline.stage_change',
    test: (l) =>
      /\b(move|change|set|update)\b/.test(l) &&
      /\b(to|as)\b/.test(l) &&
      /\b(closed.?lost|closed.?won|contract.?sent|committed|negotiating|demo.?completed|demo.?scheduled|disco.?booked|disco.?complete|presentation|qualified|nurture)\b/.test(l),
    confidence: 0.85,
  },
  {
    top_level: 'workflow_mutation',
    sub_intent: 'postcall.full',
    test: (l) => /\bjust\s+finished\b/.test(l) || /\bpost-?call\b/.test(l),
    confidence: 0.85,
  },
  {
    top_level: 'workflow_mutation',
    sub_intent: 'email.draft',
    test: (l) => /\bdraft\b/.test(l) && (/\bemail\b/.test(l) || /\bfollow/.test(l) || /\breply\b/.test(l)),
    confidence: 0.8,
  },
  {
    top_level: 'workflow_mutation',
    sub_intent: 'proposal.create',
    test: (l) => /\bproposal\b/.test(l) || /\border\s+form\b/.test(l),
    confidence: 0.8,
  },
  {
    top_level: 'workflow_mutation',
    sub_intent: 'scheduling.request',
    test: (l) => /\bjackson\b/.test(l) || /\bschedule\b/.test(l) || /\bfind\s+a\s+time\b/.test(l) || /\bbook\s+a\s+meeting\b/.test(l),
    confidence: 0.8,
  },

  // ── GENERIC MUTATION (catch-all for mutation verbs) ─────────
  {
    top_level: 'workflow_mutation',
    sub_intent: 'unknown_mutation',
    test: (l) => MUTATION_VERBS.test(l),
    confidence: 0.5,
  },
];

// ── Main classifier ────────────────────────────────────────────────

export function classifyIntent(text: string): IntentClass {
  const lower = text.toLowerCase().trim();

  for (const matcher of MATCHERS) {
    if (matcher.test(lower, text)) {
      return {
        top_level: matcher.top_level,
        sub_intent: matcher.sub_intent,
        confidence: matcher.confidence,
      };
    }
  }

  // Default: read_query if no mutation verb, otherwise low-confidence mutation
  if (MUTATION_VERBS.test(lower)) {
    return { top_level: 'workflow_mutation', sub_intent: 'unknown_mutation', confidence: 0.4 };
  }

  // Advice-seeking patterns without mutation verbs
  if (/\b(what\s+should|how\s+should|recommend|advise|suggest)\b/.test(lower)) {
    return { top_level: 'assist_recommend', sub_intent: 'unknown_assist', confidence: 0.5 };
  }

  return { top_level: 'read_query', sub_intent: 'unknown_read', confidence: 0.3 };
}

// ── Helpers for use by command.ts ──────────────────────────────────

export function isReadOnly(topLevel: TopLevelIntent): boolean {
  return topLevel === 'read_query';
}

export function requiresApprovalGate(topLevel: TopLevelIntent): boolean {
  return topLevel === 'workflow_mutation';
}

export function isWizardMode(topLevel: TopLevelIntent): boolean {
  return topLevel === 'create_wizard';
}
