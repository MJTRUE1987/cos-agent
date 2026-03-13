// Google OAuth2 Authorization Flow
// GET: redirects to Google consent screen
// GET ?code=...: exchanges code for refresh token and returns it

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Safety gate: OAuth setup endpoint is disabled by default in production.
  // Set ENABLE_OAUTH_SETUP=true in Vercel env vars to re-enable temporarily.
  if (process.env.ENABLE_OAUTH_SETUP !== 'true') {
    return res.status(410).json({
      error: 'OAuth setup endpoint is disabled in production.',
      hint: 'Set ENABLE_OAUTH_SETUP=true in Vercel environment variables and redeploy to re-enable.',
    });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set' });
  }

  // Determine redirect URI from request
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/google-auth`;

  const { code, error: oauthError } = req.query || {};

  // If Google returned an error
  if (oauthError) {
    return res.status(400).send(`<html><body>
      <h2>OAuth Error</h2>
      <p>${oauthError}: ${req.query.error_description || ''}</p>
      <a href="/api/google-auth">Try again</a>
    </body></html>`);
  }

  // Step 2: Exchange code for tokens
  if (code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const data = await tokenRes.json();

      if (data.error) {
        return res.status(400).send(`<html><body>
          <h2>Token Exchange Failed</h2>
          <p>${data.error}: ${data.error_description || ''}</p>
          <a href="/api/google-auth">Try again</a>
        </body></html>`);
      }

      // Show the refresh token — user needs to save this as GOOGLE_REFRESH_TOKEN
      return res.status(200).send(`<html><body style="font-family:monospace; padding:20px;">
        <h2>Google OAuth Success</h2>
        <p><strong>Refresh Token</strong> (save this as GOOGLE_REFRESH_TOKEN in Vercel):</p>
        <textarea rows="5" cols="80" onclick="this.select()">${data.refresh_token || 'NO REFRESH TOKEN — you may need to revoke access at https://myaccount.google.com/permissions and re-authorize'}</textarea>
        <br><br>
        <p><strong>Access Token</strong> (temporary, valid ~1hr):</p>
        <textarea rows="3" cols="80">${data.access_token || 'none'}</textarea>
        <br><br>
        <p><strong>Scopes granted:</strong> ${data.scope || 'unknown'}</p>
        <p><strong>Token type:</strong> ${data.token_type || 'unknown'}</p>
        ${data.refresh_token ? `
        <h3>Next steps:</h3>
        <ol>
          <li>Copy the refresh token above</li>
          <li>Run: <code>printf '${data.refresh_token}' | vercel env add GOOGLE_REFRESH_TOKEN production preview development</code></li>
          <li>Redeploy: <code>vercel --prod</code></li>
        </ol>
        ` : `
        <h3>No refresh token returned</h3>
        <p>This usually means you already authorized this app before. To get a new refresh token:</p>
        <ol>
          <li>Go to <a href="https://myaccount.google.com/permissions">Google Account Permissions</a></li>
          <li>Remove access for your app</li>
          <li><a href="/api/google-auth">Re-authorize here</a></li>
        </ol>
        `}
      </body></html>`);
    } catch (err) {
      return res.status(500).send(`<html><body>
        <h2>Error</h2><p>${err.message}</p>
        <a href="/api/google-auth">Try again</a>
      </body></html>`);
    }
  }

  // Step 1: Redirect to Google consent screen
  const scopes = [
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=code&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `access_type=offline&` +
    `prompt=consent`;

  return res.redirect(302, authUrl);
}
