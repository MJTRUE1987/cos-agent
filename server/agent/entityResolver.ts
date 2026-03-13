/**
 * Entity Resolver — Context-aware entity resolution with session persistence.
 *
 * Entity types: brand_deal, agency_partner, company, contact, email_thread, calendar_event, granola_note
 *
 * Rules:
 * 1. In sales/CRM contexts, prefer brand_deal over agency_partner
 * 2. If name matches both brand and agency, hide agency by default
 * 3. Persist resolution in session so follow-ups reuse prior resolved entity
 * 4. Do not re-ask for same entity unless user changed topic
 * 5. Do not substitute missing entity with nearby match
 */

import type { ResolvedEntity } from './commandInterpreter.js';

// ── Types ──────────────────────────────────────────────────────────

export interface ResolvedEntityRecord {
  raw_text: string;
  entity_type: string;
  resolved_name: string;
  resolved_id?: string;
  source?: string;
  confidence: number;
  resolved_at: string;
}

export interface EntitySession {
  resolved_entities: Record<string, ResolvedEntityRecord>;  // key = lowercase name
  last_topic: string;
  last_command_id: string;
  clarification_history: Set<string>;  // entity names already clarified
}

export interface EntityResolutionResult {
  entities: ResolvedEntity[];
  session: EntitySession;
  needs_clarification: boolean;
  clarifications: EntityClarification[];
}

export interface EntityClarification {
  entity_name: string;
  question: string;
  type: 'single_select' | 'confirm' | 'freeform';
  options: { label: string; value: string; is_recommended: boolean }[];
  required: boolean;
}

// ── Agency detection ───────────────────────────────────────────────

const AGENCY_PATTERNS = [
  /\bvia\b/i,
  /\bagency\b/i,
  /\bpartner\b/i,
];

function isAgencyDeal(dealName: string): boolean {
  return AGENCY_PATTERNS.some(p => p.test(dealName));
}

// ── Follow-up pronoun resolution ───────────────────────────────────

const PRONOUN_PATTERNS = [
  /\b(it|that|this)\b/i,
  /\bthis\s+(thread|email|deal|company|meeting|note)\b/i,
  /\bthat\s+(thread|email|deal|company|meeting|note)\b/i,
];

export function resolveFollowUp(
  text: string,
  session: EntitySession
): { resolved: boolean; entity?: ResolvedEntity } {
  const lower = text.toLowerCase();

  // Check for pronoun references
  const hasPronoun = PRONOUN_PATTERNS.some(p => p.test(lower));
  if (!hasPronoun) return { resolved: false };

  // Look up last resolved entity from session
  const entries = Object.values(session.resolved_entities);
  if (entries.length === 0) return { resolved: false };

  // Sort by resolved_at descending, pick most recent
  entries.sort((a, b) => new Date(b.resolved_at).getTime() - new Date(a.resolved_at).getTime());
  const last = entries[0];

  // Determine entity type from pronoun context
  let expectedType: string | null = null;
  if (/\bthread\b/.test(lower)) expectedType = 'email_thread';
  else if (/\bemail\b/.test(lower)) expectedType = 'email_thread';
  else if (/\bdeal\b/.test(lower)) expectedType = 'company';
  else if (/\bcompany\b/.test(lower)) expectedType = 'company';
  else if (/\bmeeting\b/.test(lower)) expectedType = 'calendar_event';
  else if (/\bnote\b/.test(lower)) expectedType = 'granola_note';

  // If expected type matches, use it; otherwise use last resolved
  const match = expectedType
    ? entries.find(e => e.entity_type === expectedType) || last
    : last;

  return {
    resolved: true,
    entity: {
      raw_text: match.raw_text,
      entity_type: match.entity_type as any,
      resolved_name: match.resolved_name,
      resolved_id: match.resolved_id,
      source: match.source,
      confidence: match.confidence,
    },
  };
}

// ── Main entity resolution ─────────────────────────────────────────

export function resolveEntities(
  entities: ResolvedEntity[],
  session: EntitySession,
  context?: { deals?: any[]; intent?: string }
): EntityResolutionResult {
  const updatedSession: EntitySession = {
    ...session,
    resolved_entities: { ...session.resolved_entities },
    clarification_history: new Set(session.clarification_history),
  };

  const resolvedEntities: ResolvedEntity[] = [];
  const clarifications: EntityClarification[] = [];
  let needsClarification = false;

  const isSalesCrmContext = context?.intent
    ? /\b(pipeline|stage|deal|hubspot|crm)\b/.test(context.intent)
    : true; // default to sales context

  for (const entity of entities) {
    const key = entity.resolved_name.toLowerCase();

    // 1. Check if already resolved in this session
    const cached = updatedSession.resolved_entities[key];
    if (cached && cached.resolved_id) {
      // Reuse prior resolution
      resolvedEntities.push({
        ...entity,
        resolved_name: cached.resolved_name,
        resolved_id: cached.resolved_id,
        source: cached.source,
        confidence: cached.confidence,
      });
      continue;
    }

    // 2. If we have deal context, try to resolve against known deals
    if (context?.deals) {
      const matches = context.deals.filter(d => {
        const dealName = (d.name || d.dealname || '').toLowerCase();
        return dealName.includes(key) || key.includes(dealName);
      });

      if (matches.length === 1) {
        const match = matches[0];
        const isAgency = isAgencyDeal(match.name || match.dealname || '');

        // In sales context, prefer brand over agency
        if (isSalesCrmContext && isAgency) {
          // Look for non-agency match
          const brandMatch = context.deals.find(d => {
            const n = (d.name || d.dealname || '').toLowerCase();
            return (n.includes(key) || key.includes(n)) && !isAgencyDeal(d.name || d.dealname || '');
          });
          if (brandMatch) {
            const resolved: ResolvedEntity = {
              ...entity,
              resolved_name: brandMatch.name || brandMatch.dealname,
              resolved_id: brandMatch.id,
              source: 'hubspot',
              confidence: 0.9,
            };
            resolvedEntities.push(resolved);
            updatedSession.resolved_entities[key] = {
              ...resolved,
              resolved_at: new Date().toISOString(),
              entity_type: resolved.entity_type,
            };
            continue;
          }
        }

        const resolved: ResolvedEntity = {
          ...entity,
          resolved_name: match.name || match.dealname,
          resolved_id: match.id,
          source: 'hubspot',
          confidence: isAgency && isSalesCrmContext ? 0.6 : 0.9,
        };
        resolvedEntities.push(resolved);
        updatedSession.resolved_entities[key] = {
          ...resolved,
          resolved_at: new Date().toISOString(),
          entity_type: resolved.entity_type,
        };
        continue;
      }

      if (matches.length > 1) {
        // Filter out agency matches in sales context
        const filteredMatches = isSalesCrmContext
          ? matches.filter(m => !isAgencyDeal(m.name || m.dealname || ''))
          : matches;

        const finalMatches = filteredMatches.length > 0 ? filteredMatches : matches;

        if (finalMatches.length === 1) {
          const match = finalMatches[0];
          const resolved: ResolvedEntity = {
            ...entity,
            resolved_name: match.name || match.dealname,
            resolved_id: match.id,
            source: 'hubspot',
            confidence: 0.85,
          };
          resolvedEntities.push(resolved);
          updatedSession.resolved_entities[key] = {
            ...resolved,
            resolved_at: new Date().toISOString(),
            entity_type: resolved.entity_type,
          };
          continue;
        }

        // Multiple matches — need clarification, but only if not already asked
        if (!updatedSession.clarification_history.has(key)) {
          needsClarification = true;
          updatedSession.clarification_history.add(key);
          clarifications.push({
            entity_name: entity.resolved_name,
            question: `Multiple matches found for "${entity.resolved_name}". Which one?`,
            type: 'single_select',
            options: finalMatches.map(m => ({
              label: `${m.name || m.dealname}${m.stage ? ` (${m.stage})` : ''}`,
              value: m.name || m.dealname,
              is_recommended: false,
            })),
            required: true,
          });
        }

        // Use first match tentatively
        resolvedEntities.push(entity);
        continue;
      }
    }

    // 3. No context match — pass through unresolved
    // Do NOT substitute with a nearby match
    resolvedEntities.push(entity);

    // Cache the unresolved entity so we don't re-ask
    if (!updatedSession.resolved_entities[key]) {
      updatedSession.resolved_entities[key] = {
        raw_text: entity.raw_text,
        entity_type: entity.entity_type,
        resolved_name: entity.resolved_name,
        confidence: entity.confidence,
        resolved_at: new Date().toISOString(),
      };
    }
  }

  return {
    entities: resolvedEntities,
    session: updatedSession,
    needs_clarification: needsClarification,
    clarifications,
  };
}

// ── Session factory ────────────────────────────────────────────────

export function createEntitySession(): EntitySession {
  return {
    resolved_entities: {},
    last_topic: '',
    last_command_id: '',
    clarification_history: new Set(),
  };
}

export function hasTopicChanged(newText: string, session: EntitySession): boolean {
  if (!session.last_topic) return false;
  const newLower = newText.toLowerCase();
  const lastLower = session.last_topic.toLowerCase();

  // If the new command mentions a completely different entity, topic has changed
  // Simple heuristic: no overlap in capitalized words
  const newWords = new Set(newText.split(/\s+/).filter(w => w[0] === w[0]?.toUpperCase() && w.length > 2));
  const lastWords = new Set(session.last_topic.split(/\s+/).filter(w => w[0] === w[0]?.toUpperCase() && w.length > 2));

  let overlap = 0;
  for (const w of newWords) {
    if (lastWords.has(w)) overlap++;
  }

  return overlap === 0 && newWords.size > 0 && lastWords.size > 0;
}
