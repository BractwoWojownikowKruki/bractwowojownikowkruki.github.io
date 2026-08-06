import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isDuplicate, parseIssueForm, validateAlbumName, validateAlbumUrl } from './album-issue-utils.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const ALBUMS_TXT = join(ROOT, 'albums.txt');

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
  const { url, name } = parseIssueForm(body);

  const urlError = validateAlbumUrl(url);
  if (urlError) {
    writeOutput('status', 'invalid');
    writeOutput('message', urlError);
    return;
  }

  const nameError = validateAlbumName(name);
  if (nameError) {
    writeOutput('status', 'invalid');
    writeOutput('message', nameError);
    return;
  }

  const albumsTxtContent = readFileSync(ALBUMS_TXT, 'utf8');
  if (isDuplicate(url!, albumsTxtContent)) {
    writeOutput('status', 'invalid');
    writeOutput('message', `Ten album jest już na liście: ${url}`);
    return;
  }

  const line = name ? `${url} | ${name}` : url!;
  const separator = albumsTxtContent.endsWith('\n') ? '' : '\n';
  writeFileSync(ALBUMS_TXT, `${albumsTxtContent}${separator}${line}\n`);

  writeOutput('status', 'valid');
  writeOutput('title', name ?? 'nowy album');
  writeOutput('message', 'Dzięki! Album trafi na stronę po zatwierdzeniu PR-a przez administratora.');
}

main();
