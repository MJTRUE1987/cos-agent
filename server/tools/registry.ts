/**
 * Tool Registry — Central registry of all tool adapters.
 * Uses lazy loading so a failure in one adapter doesn't crash all endpoints.
 */

import type { ToolAdapter } from './types.js';

// ── Registry ──────────────────────────────────────────────────────

const registry = new Map<string, ToolAdapter>();
let initialized = false;

function register(adapter: ToolAdapter): void {
  registry.set(adapter.contract.name, adapter);
}

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const loaders: Array<[string, () => Promise<any>]> = [
    ['hubspot.get_deal', () => import('./hubspot/getDeal.js').then(m => m.hubspotGetDeal)],
    ['hubspot.update_deal', () => import('./hubspot/updateDeal.js').then(m => m.hubspotUpdateDeal)],
    ['hubspot.create_note', () => import('./hubspot/createNote.js').then(m => m.hubspotCreateNote)],
    ['hubspot.search_company', () => import('./hubspot/searchCompany.js').then(m => m.hubspotSearchCompany)],
    ['hubspot.create_contact', () => import('./hubspot/createContact.js').then(m => m.hubspotCreateContact)],
    ['hubspot.create_company', () => import('./hubspot/createCompany.js').then(m => m.hubspotCreateCompany)],
    ['hubspot.create_deal', () => import('./hubspot/createDeal.js').then(m => m.hubspotCreateDeal)],
    ['gmail.create_draft', () => import('./gmail/createDraft.js').then(m => m.gmailCreateDraft)],
    ['gmail.search_threads', () => import('./gmail/searchThreads.js').then(m => m.gmailSearchThreads)],
    ['granola.get_notes', () => import('./granola/getNotes.js').then(m => m.granolaGetNotes)],
    ['granola.analyze_note', () => import('./granola/analyzeNote.js').then(m => m.granolaAnalyzeNote)],
    ['granola.summarize_for_crm', () => import('./granola/summarizeForCrm.js').then(m => m.granolaSummarizeForCrm)],
    ['slack.send_message', () => import('./slack/sendMessage.js').then(m => m.slackSendMessage)],
    ['calendar.get_events', () => import('./calendar/getEvents.js').then(m => m.calendarGetEvents)],
    ['pricing.calculate', () => import('./pricing/calculate.js').then(m => m.pricingCalculate)],
    ['proposal.generate', () => import('./proposal/generate.js').then(m => m.proposalGenerate)],
  ];

  await Promise.all(loaders.map(async ([name, loader]) => {
    try {
      const adapter = await loader();
      if (adapter) register(adapter);
    } catch (err: any) {
      console.warn(`[registry] Failed to load tool "${name}": ${err.message}`);
    }
  }));
}

// ── Public API ────────────────────────────────────────────────────

export async function getTool(name: string): Promise<ToolAdapter | undefined> {
  await ensureInitialized();
  return registry.get(name);
}

export async function getAllTools(): Promise<ToolAdapter[]> {
  await ensureInitialized();
  return Array.from(registry.values());
}

export async function getToolNames(): Promise<string[]> {
  await ensureInitialized();
  return Array.from(registry.keys());
}

export async function getToolsByCategory(category: string): Promise<ToolAdapter[]> {
  await ensureInitialized();
  return Array.from(registry.values()).filter(t => t.contract.category === category);
}

export async function getToolContract(name: string) {
  await ensureInitialized();
  return registry.get(name)?.contract;
}

export { registry };
