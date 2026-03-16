// Gmail Archive Email API
// Archives emails by removing the INBOX label (Gmail's archive behavior)

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const cosApiKey = process.env.COS_API_KEY;
  if (!cosApiKey) return res.status(500).json({ error: 'COS_API_KEY not configured on server' });
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${cosApiKey}`) return res.status(401).json({ error: 'Unauthorized' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { threadId, messageId } = req.body || {};
  if (!threadId && !messageId) return res.status(400).json({ error: 'threadId or messageId required' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(500).json({ error: 'Google OAuth credentials not configured.' });
  }

  try {
    // Get fresh access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Google token refresh failed:', JSON.stringify(tokenData));
      return res.status(500).json({ error: `Failed to refresh Google token: ${tokenData.error_description || tokenData.error || 'unknown'}` });
    }

    // Archive by modifying thread labels — remove INBOX
    if (threadId) {
      const archiveRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
      });

      if (!archiveRes.ok) {
        const err = await archiveRes.text();
        return res.status(archiveRes.status).json({ error: `Gmail API error: ${err}` });
      }

      return res.status(200).json({ success: true, threadId, archived: true });
    }

    // Fallback: archive single message
    const archiveRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
    });

    if (!archiveRes.ok) {
      const err = await archiveRes.text();
      return res.status(archiveRes.status).json({ error: `Gmail API error: ${err}` });
    }

    return res.status(200).json({ success: true, messageId, archived: true });
  } catch (err) {
    console.error('Archive email error:', err);
    return res.status(500).json({ error: 'Failed to archive email' });
  }
}
