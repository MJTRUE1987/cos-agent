// Slack API — Send messages, list channels, list users
// Supports: send to any channel or DM, list available targets

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not configured' });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // GET — list channels and users for the picker
  if (req.method === 'GET') {
    try {
      const [chRes, usrRes] = await Promise.all([
        fetch('https://slack.com/api/conversations.list?types=public_channel&limit=200&exclude_archived=true', { headers }),
        fetch('https://slack.com/api/users.list?limit=200', { headers }),
      ]);
      const [chData, usrData] = await Promise.all([chRes.json(), usrRes.json()]);

      const channels = (chData.channels || [])
        .filter(c => !c.is_archived)
        .map(c => ({ id: c.id, name: c.name, topic: c.topic?.value || '' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const users = (usrData.members || [])
        .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
        .map(u => ({ id: u.id, name: u.real_name || u.name, displayName: u.profile?.display_name || u.name }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return res.status(200).json({ success: true, channels, users });
    } catch (err) {
      console.error('Slack list error:', err);
      return res.status(500).json({ error: 'Failed to list Slack targets' });
    }
  }

  // POST — send a message
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { channel, userId, text, blocks } = req.body || {};
  const target = channel || userId;
  if (!target || !text) return res.status(400).json({ error: 'channel/userId and text required' });

  try {
    const payload = { channel: target, text };
    if (blocks) payload.blocks = blocks;

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await slackRes.json();

    if (!data.ok) {
      return res.status(400).json({ error: `Slack error: ${data.error}` });
    }

    return res.status(200).json({
      success: true,
      channel: data.channel,
      ts: data.ts,
      message: data.message?.text,
    });
  } catch (err) {
    console.error('Slack send error:', err);
    return res.status(500).json({ error: 'Failed to send Slack message' });
  }
}
