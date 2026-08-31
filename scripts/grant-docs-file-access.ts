/**
 * One-off tool: grants the EXISTING drive.file-scoped Drive credential (the same one used for
 * gallery uploads - DRIVE_REFRESH_TOKEN) access to specific pre-existing Google Docs, via the
 * Google Picker API - without minting any new OAuth credential or broadening any scope.
 *
 * This works because of how drive.file is documented to behave: the app can only ever see files
 * it created itself, OR files a user has explicitly "opened" with it through Picker - and Picker
 * selection is exactly the mechanism Google provides for granting a drive.file-scoped app access
 * to a handful of specific pre-existing files, permanently, without drive.readonly's
 * whole-Drive-account visibility. See https://developers.google.com/drive/picker/guides/overview
 *
 * Usage (all three from the existing Drive credential, never new ones):
 *   DRIVE_CLIENT_ID=... DRIVE_CLIENT_SECRET=... DRIVE_REFRESH_TOKEN=... PICKER_API_KEY=... \
 *     npx tsx scripts/grant-docs-file-access.ts
 *
 * Opens a local page with the Google Picker widget (signed in as whichever account
 * DRIVE_REFRESH_TOKEN belongs to - no separate browser login needed, the token itself carries
 * the identity). Select the doc(s) to grant access to, confirm, and this prints their file IDs -
 * cross-check those against config.ts's wojownicyDocs map.
 */
import { createServer } from 'node:http';

const CLIENT_ID = process.env.DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.DRIVE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.DRIVE_REFRESH_TOKEN;
const PICKER_API_KEY = process.env.PICKER_API_KEY;
const PORT = 8092;

for (const [name, value] of Object.entries({ DRIVE_CLIENT_ID: CLIENT_ID, DRIVE_CLIENT_SECRET: CLIENT_SECRET, DRIVE_REFRESH_TOKEN: REFRESH_TOKEN, PICKER_API_KEY })) {
  if (!value) {
    console.error(`Brak ${name} w środowisku.`);
    process.exit(1);
  }
}

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Nie udało się odświeżyć tokenu Drive: HTTP ${res.status}\n${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function renderPage(accessToken: string, pickerApiKey: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Wybierz dokumenty</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <p>Ładowanie selektora plików Google...</p>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    const ACCESS_TOKEN = ${JSON.stringify(accessToken)};
    const PICKER_API_KEY = ${JSON.stringify(pickerApiKey)};

    function onApiLoad() {
      gapi.load('picker', onPickerApiLoad);
    }

    function onPickerApiLoad() {
      document.body.innerHTML = '';
      const view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
        .setIncludeFolders(false);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(ACCESS_TOKEN)
        .setDeveloperKey(PICKER_API_KEY)
        .addView(view)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setCallback(pickerCallback)
        .build();
      picker.setVisible(true);
    }

    function pickerCallback(data) {
      if (data.action !== google.picker.Action.PICKED) return;
      fetch('/picked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: data.docs.map(d => ({ id: d.id, name: d.name })) }),
      }).then(() => {
        document.body.innerHTML = '<p>Gotowe, możesz wrócić do terminala.</p>';
      });
    }

    onApiLoad();
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const accessToken = await getAccessToken();
  const html = renderPage(accessToken, PICKER_API_KEY!);

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (req.method === 'POST' && req.url === '/picked') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { docs } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { docs: { id: string; name: string }[] };
      res.writeHead(200).end('ok');
      console.log('\nWybrane pliki (te ID trafiły właśnie do drive.file grantu):\n');
      for (const doc of docs) {
        console.log(`  ${doc.name}: ${doc.id}`);
      }
      console.log('\nPorównaj z upload-service/src/config.ts\'s wojownicyDocs.');
      server.close();
      process.exit(0);
    }
    res.writeHead(404).end();
  });

  server.listen(PORT, () => {
    console.log(`\nOtwórz w przeglądarce: http://localhost:${PORT}/\n`);
    console.log('(token należy do konta DRIVE_REFRESH_TOKEN - nie musisz się nigdzie osobno logować,');
    console.log('picker pokaże Dysk tego konta bezpośrednio)\n');
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
