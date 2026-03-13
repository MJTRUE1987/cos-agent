// LinkedIn Integration API
// Generates connection request message and provides profile URL
// Note: LinkedIn API is restricted — this generates the message and opens the profile

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contactName, company, context, linkedinUrl, meetingType } = req.body || {};
  if (!contactName || !company) return res.status(400).json({ error: 'contactName and company required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  try {
    let message = '';
    let profileUrl = linkedinUrl || null;

    // Generate connection request message
    if (anthropicKey) {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: `Write a brief LinkedIn connection request message (under 300 characters) from Mike True, Co-founder & CEO of Prescient AI. Keep it personal, reference the meeting, and don't be salesy. No hashtags.`,
          messages: [{ role: 'user', content: `Write a LinkedIn connection request to ${contactName} at ${company}. Context: ${context || meetingType || 'initial call'}` }],
        }),
      });
      const aiData = await aiRes.json();
      message = aiData.content?.[0]?.text || '';
    } else {
      message = `Hi ${contactName.split(' ')[0]}, great connecting on our call. Looking forward to exploring how Prescient can help ${company}. — Mike`;
    }

    // Build LinkedIn search URL if no direct profile URL
    if (!profileUrl) {
      const searchQuery = encodeURIComponent(`${contactName} ${company}`);
      profileUrl = `https://www.linkedin.com/search/results/people/?keywords=${searchQuery}`;
    }

    return res.status(200).json({
      success: true,
      contactName,
      company,
      message,
      profileUrl,
      instructions: 'Open the LinkedIn URL, send connection request, paste the message.',
    });
  } catch (err) {
    console.error('LinkedIn error:', err);
    return res.status(500).json({ error: 'LinkedIn message generation failed' });
  }
}
