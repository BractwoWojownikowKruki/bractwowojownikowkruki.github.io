// One-time interactive OAuth setup for KRKG-0046's Google Sheets backup. Walks through the
// standard OAuth2 authorization-code flow (a local HTTP server catches the redirect) and prints
// a refresh token scoped to https://www.googleapis.com/auth/spreadsheets - the same manual
// refresh-token exchange pattern this service already uses for Drive/Docs (see drive.ts's
// getAccessToken), just for a different scope. Not run in CI, not imported by the server; run
// once by hand, then set the printed value as the SHEETS_REFRESH_TOKEN secret.
//
// Prerequisites:
//   1. In Google Cloud Console (the same project as the other OAuth clients), enable the
//      Google Sheets API.
//   2. Create (or reuse) an OAuth 2.0 Client ID of type "Web application" with
//      http://localhost:8991/oauth2callback as an Authorized redirect URI.
//   3. Sign in as the account that should own the backup sheet (e.g.
//      bractwo.wojownikow.kruki@gmail.com) when the consent screen opens - that account becomes
//      the sheet's owner once it creates it, so no separate sharing step is needed.
//
// Usage:
//   cd upload-service
//   SHEETS_CLIENT_ID=... SHEETS_CLIENT_SECRET=... npx tsx scripts/get-sheets-refresh-token.ts
//
// The script opens (prints) a consent URL, starts a local server on :8991 to catch the redirect,
// exchanges the returned code for tokens, and prints the refresh token to stdout. It never
// writes the token to disk.
import { createServer } from 'node:http';

const REDIRECT_URI = 'http://localhost:8991/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const clientId = requireEnv('SHEETS_CLIENT_ID');
  const clientSecret = requireEnv('SHEETS_CLIENT_SECRET');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // forces a refresh token even on repeat consent

  console.log('Otwórz ten adres w przeglądarce (zaloguj się na konto, które ma być właścicielem arkusza backupu):\n');
  console.log(authUrl.toString());
  console.log('\nCzekam na przekierowanie na http://localhost:8991/oauth2callback ...');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const receivedCode = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(error ? `Błąd: ${error}. Można zamknąć tę kartę.` : 'Zalogowano. Można zamknąć tę kartę i wrócić do terminala.');
      server.close();
      if (error) reject(new Error(error));
      else if (receivedCode) resolve(receivedCode);
      else reject(new Error('Brak kodu autoryzacyjnego w odpowiedzi.'));
    });
    server.listen(8991);
  });

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!tokenRes.ok) {
    console.error(`Wymiana kodu na token nie powiodła się: HTTP ${tokenRes.status}`, await tokenRes.text());
    process.exit(1);
  }
  const body = (await tokenRes.json()) as { refresh_token?: string; access_token: string };
  if (!body.refresh_token) {
    console.error(
      'Odpowiedź nie zawiera refresh_token - to konto mogło już wcześniej wydać zgodę bez access_type=offline. ' +
        'Odwołaj dostęp aplikacji w ustawieniach konta Google (myaccount.google.com/permissions) i uruchom skrypt ponownie.',
    );
    process.exit(1);
  }

  console.log('\nSHEETS_REFRESH_TOKEN=' + body.refresh_token);
  console.log('\nUstaw tę wartość jako sekret SHEETS_REFRESH_TOKEN (patrz deploy-upload-service.yml).');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
