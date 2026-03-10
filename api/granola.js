// Granola API — Fetch meeting notes and transcripts
// Docs: https://docs.granola.ai
// Base: https://public-api.granola.ai

const GRANOLA_BASE = 'https://public-api.granola.ai';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GRANOLA_API_KEY;
  if (!token) return res.status(500).json({ error: 'GRANOLA_API_KEY not configured' });

  const headers = { Authorization: `Bearer ${token}` };

  // GET — list recent notes, optionally filtered
  if (req.method === 'GET') {
    const { created_after, created_before, updated_after, page_size, cursor, company } = req.query || {};

    try {
      const params = new URLSearchParams();
      if (created_after) params.set('created_after', created_after);
      if (created_before) params.set('created_before', created_before);
      if (updated_after) params.set('updated_after', updated_after);
      params.set('page_size', page_size || '20');
      if (cursor) params.set('cursor', cursor);

      const r = await fetch(`${GRANOLA_BASE}/v1/notes?${params}`, { headers });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: `Granola API error: ${err}` });
      }
      const data = await r.json();

      // If company filter provided, filter client-side
      let notes = data.notes || [];
      if (company) {
        const q = company.toLowerCase();
        notes = notes.filter(n =>
          (n.title || '').toLowerCase().includes(q) ||
          (n.attendees || []).some(a => (a.email || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q))
        );
      }

      return res.status(200).json({
        success: true,
        notes,
        hasMore: data.hasMore,
        cursor: data.cursor,
      });
    } catch (err) {
      console.error('Granola list error:', err);
      return res.status(500).json({ error: 'Failed to list Granola notes' });
    }
  }

  // POST — get a specific note with transcript + optional AI analysis
  if (req.method === 'POST') {
    const { noteId, granolaUrl, analyze, company } = req.body || {};

    // Extract note ID from URL if provided instead of noteId
    let id = noteId;
    if (!id && granolaUrl) {
      // URL format: https://notes.granola.ai/d/{uuid} — but API needs not_{14chars}
      // The URL UUID won't match the API ID format, so we need to search by date/title
    }

    if (!id && !granolaUrl && !company) {
      return res.status(400).json({ error: 'noteId or granolaUrl or company required' });
    }

    try {
      let note = null;

      if (id) {
        // Direct fetch by ID
        const r = await fetch(`${GRANOLA_BASE}/v1/notes/${id}?include=transcript`, { headers });
        if (!r.ok) {
          const err = await r.text();
          return res.status(r.status).json({ error: `Granola API error: ${err}` });
        }
        note = await r.json();
      } else {
        // Search recent notes for a match (by company name or recent)
        const params = new URLSearchParams({ page_size: '30' });
        // Look at notes from last 7 days
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        params.set('created_after', weekAgo);

        const listRes = await fetch(`${GRANOLA_BASE}/v1/notes?${params}`, { headers });
        if (listRes.ok) {
          const listData = await listRes.json();
          const notes = listData.notes || [];

          // Find best match
          let match = null;
          if (company) {
            const q = company.toLowerCase();
            match = notes.find(n =>
              (n.title || '').toLowerCase().includes(q) ||
              (n.attendees || []).some(a => (a.name || '').toLowerCase().includes(q))
            );
          }
          // If no company match, get the most recent note
          if (!match && notes.length > 0) {
            match = notes[0];
          }

          if (match) {
            // Fetch full note with transcript
            const fullRes = await fetch(`${GRANOLA_BASE}/v1/notes/${match.id}?include=transcript`, { headers });
            if (fullRes.ok) {
              note = await fullRes.json();
            }
          }
        }
      }

      if (!note) {
        return res.status(404).json({ error: 'Note not found' });
      }

      // Build structured response
      const result = {
        id: note.id,
        title: note.title,
        createdAt: note.created_at,
        owner: note.owner,
        attendees: note.attendees || [],
        summaryText: note.summary_text || '',
        summaryMarkdown: note.summary_markdown || '',
        calendarEvent: note.calendar_event,
        transcript: null,
        fullTranscriptText: '',
      };

      // Flatten transcript to readable text
      if (note.transcript && Array.isArray(note.transcript)) {
        result.transcript = note.transcript;
        result.fullTranscriptText = note.transcript
          .map(t => `[${t.speaker || 'unknown'}] ${t.text}`)
          .join('\n');
      }

      // Optional: AI analysis of the call
      if (analyze) {
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        if (anthropicKey) {
          const callContent = result.summaryText || result.fullTranscriptText.substring(0, 8000);

          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 2048,
              system: `You are a sales ops analyst for Prescient AI (marketing mix modeling platform). Analyze call notes and return a JSON object:
{
  "summary": "2-3 sentence executive summary",
  "keyPoints": ["bullet 1", "bullet 2"],
  "nextSteps": ["action 1", "action 2"],
  "objections": ["any concerns raised"],
  "buySignals": ["positive indicators"],
  "suggestedDealStage": "Disco Complete|Demo Scheduled|Demo Completed|Negotiating|Committed",
  "dealValueEstimate": "dollar amount if discussed, or null",
  "sentiment": "positive|neutral|negative",
  "proposalReady": true/false,
  "emailTone": "warm followup|technical deep-dive|proposal push|gentle nudge",
  "keyPeople": [{"name":"...","role":"...","email":"..."}],
  "shouldUpdateCrm": true/false,
  "shouldDraftEmail": true/false,
  "shouldCreateProposal": true/false
}
Return ONLY valid JSON.`,
              messages: [{ role: 'user', content: `Company: ${company || note.title || 'Unknown'}\nAttendees: ${(note.attendees || []).map(a => `${a.name} (${a.email})`).join(', ')}\n\nCall Notes:\n${callContent}` }],
            }),
          });
          const aiData = await aiRes.json();
          try {
            result.analysis = JSON.parse(aiData.content?.[0]?.text || '{}');
          } catch {
            result.analysis = { summary: aiData.content?.[0]?.text || '', error: 'Could not parse' };
          }
        }
      }

      return res.status(200).json({ success: true, note: result });
    } catch (err) {
      console.error('Granola fetch error:', err);
      return res.status(500).json({ error: 'Failed to fetch Granola note' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
