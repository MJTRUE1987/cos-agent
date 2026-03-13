// Claude AI text generation endpoint
// Used by other routes for drafting emails, proposals, summaries

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { prompt, system, maxTokens = 2048 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: system || 'You are ghostwriting emails AS Mike True, CEO of Prescient AI. First person only — "I", "me", "my". You ARE Mike. Never refer to Mike in third person.\n\nStyle rules:\n- Write like a busy CEO. 2-4 sentences MAX.\n- No fluff. No "I hope this finds you well." No "I wanted to circle back." No "Looking forward to connecting with you and discussing how Prescient AI can support your growth objectives."\n- No corporate buzzwords. No "growth objectives", "initiatives", "synergies", "leverage".\n- Warm but direct. Like texting a colleague, not writing a press release.\n- End with just your name. No "Best regards", no "Warm regards", no "Cheers". Just "Mike" or "- Mike".\n- If confirming a meeting: confirm it, say you\'ll send an invite, done. Nothing else.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: `Claude API error: ${err}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    return res.status(200).json({ text });
  } catch (err) {
    console.error('AI error:', err);
    return res.status(500).json({ error: 'AI generation failed' });
  }
}
