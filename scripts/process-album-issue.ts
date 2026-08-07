import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isDuplicate, parseIssueForm, validateAlbumDate, validateAlbumUrl } from './album-issue-utils.ts';
import { AlbumEntry } from './utils.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const ALBUMS_JSON = join(ROOT, 'albums.json');

function writeOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  const delimiter = `EOF_${Math.random().toString(36).slice(2)}`;
  const line = `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  if (outputFile) {
    appendFileSync(outputFile, line);
  } else {
    console.log(line);
  }
}

function main(): void {
  const body = process.env.ISSUE_BODY ?? '';
  const { url, name, date } = parseIssueForm(body);

  const urlError = validateAlbumUrl(url);
  if (urlError) {
    writeOutput('status', 'invalid');
    writeOutput('message', urlError);
    return;
  }

  const dateError = validateAlbumDate(date);
  if (dateError) {
    writeOutput('status', 'invalid');
    writeOutput('message', dateError);
    return;
  }

  const albumsJsonContent = readFileSync(ALBUMS_JSON, 'utf8');
  if (isDuplicate(url!, albumsJsonContent)) {
    writeOutput('status', 'invalid');
    writeOutput('message', `Ten album jest już na liście: ${url}`);
    return;
  }

  const entries: AlbumEntry[] = JSON.parse(albumsJsonContent);
  entries.push({
    url: url!,
    ...(name ? { nameOverride: name } : {}),
    dateOverride: date!,
  });
  writeFileSync(ALBUMS_JSON, JSON.stringify(entries, null, 2) + '\n');

  writeOutput('status', 'valid');
  writeOutput('title', name ?? date!);
  writeOutput('message', 'Dzięki! Album trafi na stronę po zatwierdzeniu PR-a przez administratora.');
}

main();
