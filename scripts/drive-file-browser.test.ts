import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('formats files and constructs only trusted Drive URLs', async () => {
  const browser = await import('../public/shared/drive-file-browser.js');
  assert.equal(browser.formatFileSize('1024'), '1 KB');
  assert.equal(browser.formatFileSize(undefined), '');
  assert.equal(browser.driveDownloadUrl('file id'), 'https://drive.google.com/uc?export=download&id=file%20id');
  assert.equal(browser.isAllowedThumbnailUrl('https://lh3.googleusercontent.com/a/s800'), true);
  assert.equal(browser.isAllowedThumbnailUrl('https://evil.example/a'), false);
  assert.equal(browser.isAllowedViewUrl('https://drive.google.com/file/d/x/view'), true);
  assert.equal(browser.isAllowedViewUrl('https://docs.google.com/document/d/x'), false);
});

test('builds a paginated direct-child Drive request', async () => {
  const browser = await import('../public/shared/drive-file-browser.js');
  const request = browser.createDriveListRequest('folder', 'next');
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('q'), "'folder' in parents");
  assert.equal(url.searchParams.get('orderBy'), 'folder,name_natural');
  assert.equal(url.searchParams.get('pageToken'), 'next');
  assert.equal(request.options.headers['X-Goog-Api-Key'], browser.DRIVE_API_KEY_PUBLIC);
});

test('updates breadcrumbs for child, history, and external navigation', async () => {
  const browser = await import('../public/shared/drive-file-browser.js');
  const root = [{ id: 'root', name: 'Root' }];
  assert.deepEqual(browser.nextBreadcrumbs(root, 'child', { id: 'child', name: 'Child', parentId: 'root' }), [...root, { id: 'child', name: 'Child' }]);
  assert.deepEqual(browser.nextBreadcrumbs([...root, { id: 'child', name: 'Child' }], 'root'), root);
  assert.deepEqual(browser.nextBreadcrumbs(root, 'external'), root);
});

test('aggregates every Drive result page and exposes the appropriate file action', async () => {
  const browser = await import('../public/shared/drive-file-browser.js');
  const requests: string[] = [];
  const files = await browser.fetchDriveFolderFiles('folder', async (url: string) => {
    requests.push(url);
    return { ok: true, json: async () => requests.length === 1
      ? { files: [{ id: 'one' }], nextPageToken: 'two' }
      : { files: [{ id: 'three' }] } };
  });
  assert.deepEqual(files, [{ id: 'one' }, { id: 'three' }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(browser.fileAction({ id: 'pdf', mimeType: 'application/pdf' }), { label: 'Pobierz', href: browser.driveDownloadUrl('pdf') });
  assert.deepEqual(browser.fileAction({ mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://drive.google.com/file/d/doc/view' }), { label: 'Otwórz', href: 'https://drive.google.com/file/d/doc/view' });
  assert.equal(browser.fileAction({ mimeType: 'application/vnd.google-apps.document' }), null);
});

test('builds a metadata request for an external deep-linked folder', async () => {
  const browser = await import('../public/shared/drive-file-browser.js');
  const request = browser.createDriveFolderMetadataRequest('nested');
  assert.equal(new URL(request.url).pathname, '/drive/v3/files/nested');
  assert.equal(new URL(request.url).searchParams.get('fields'), 'id,name');
  assert.equal(request.options.headers['X-Goog-Api-Key'], browser.DRIVE_API_KEY_PUBLIC);
});

test('wires both public Drive pages, the shared navigation partial, and sitemap', async () => {
  const [graphics, offers, nav, sitemap] = await Promise.all([
    readFile(new URL('../public/grafiki/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/oferty/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../templates/nav.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8'),
  ]);
  assert.match(graphics, /data-drive-root-id="1J5DaXEqHK8jqcFN0OBs9Ttv_7CSek4-1"/);
  assert.match(offers, /data-drive-root-id="13pJVzMWrQoApYoxCSOF1nFkQlfI_29QV"/);
  assert.match(nav, /href="\/grafiki\/"[^>]*>Zdjęcia i grafiki/);
  assert.match(nav, /href="\/oferty\/"[^>]*>Oferty handlowe/);
  assert.match(sitemap, /https:\/\/www\.kruki\.org\/grafiki\//);
  assert.match(sitemap, /https:\/\/www\.kruki\.org\/oferty\//);
});
