/**
 * One-off tool: grants a drive.file-scoped credential access to specific pre-existing Google
 * Docs, via the Google Picker API - without ever consenting to drive.readonly (whole-Drive
 * read access). See upload-service/src/config.ts's wojownicyDocs comment for the full picture.
 *
 * The load-bearing line is PickerBuilder.setAppId(GCP_PROJECT_NUMBER) below - without it, Picker
 * lets you select files and the callback fires normally, but the actual drive.file grant this is
 * for silently never registers (confirmed: files.get kept 404ing afterwards, twice, until this
 * was added). Uses a dedicated "Web application" type OAuth client (not DRIVE_CLIENT_ID, which
 * is "Desktop" type) with an Authorized JavaScript origin matching where this page is served
 * from (http://localhost:8092) - that may also be required; wasn't isolated from the setAppId
 * fix, so kept out of caution rather than re-tested away.
 *
 * Gets its OAuth access token entirely in-browser via Google Identity Services' token client
 * (google.accounts.oauth2.initTokenClient) - no client secret involved in this step at all,
 * only the public Client ID.
 *
 * Usage:
 *   DOCS_CLIENT_ID=... PICKER_API_KEY=... npx tsx scripts/grant-docs-file-access.ts
 *
 * Open the printed URL, click the button, sign in as bractwo.wojownikow.kruki@gmail.com,
 * approve drive.file, then select the doc(s) to grant. Prints the picked file IDs - cross-check
 * those against config.ts's wojownicyDocs map.
 */
import { createServer } from 'node:http';

const DOCS_CLIENT_ID = process.env.DOCS_CLIENT_ID;
const PICKER_API_KEY = process.env.PICKER_API_KEY;
const PORT = 8092;

for (const [name, value] of Object.entries({ DOCS_CLIENT_ID, PICKER_API_KEY })) {
  if (!value) {
    console.error(`Brak ${name} w środowisku.`);
    process.exit(1);
  }
}

function renderPage(clientId: string, pickerApiKey: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Wybierz dokumenty</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <button id="start" style="font-size: 1.1rem; padding: 0.6rem 1.2rem;">Zaloguj i pokaż pliki</button>
  <p id="status"></p>

  <script src="https://accounts.google.com/gsi/client"></script>
  <script src="https://apis.google.com/js/api.js"></script>
  <script>
    const CLIENT_ID = ${JSON.stringify(clientId)};
    const PICKER_API_KEY = ${JSON.stringify(pickerApiKey)};
    let pickerLoaded = false;
    gapi.load('picker', () => { pickerLoaded = true; });

    document.getElementById('start').addEventListener('click', () => {
      document.getElementById('status').textContent = 'Czekam na logowanie...';
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: (response) => {
          if (response.error) {
            document.getElementById('status').textContent = 'Błąd logowania: ' + response.error;
            return;
          }
          showPicker(response.access_token);
        },
      });
      tokenClient.requestAccessToken();
    });

    function showPicker(accessToken) {
      if (!pickerLoaded) {
        document.getElementById('status').textContent = 'Picker jeszcze się ładuje, spróbuj ponownie za chwilę.';
        return;
      }
      document.getElementById('status').textContent = '';
      const view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
        .setIncludeFolders(false);
      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(PICKER_API_KEY)
        // GCP project number (krucze-galery-upload) - required for Picker to actually register
        // the drive.file grant, not just show the file-selection UI. See the file header.
        .setAppId('895090213384')
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
        document.getElementById('status').textContent = 'Gotowe, możesz wrócić do terminala.';
      });
    }
  </script>
</body>
</html>`;
}

const html = renderPage(DOCS_CLIENT_ID!, PICKER_API_KEY!);

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
});
