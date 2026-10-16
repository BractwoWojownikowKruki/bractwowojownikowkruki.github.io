import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const linkPreviewSource = readFileSync(
  new URL('../public/shared/link-preview.js', import.meta.url),
  'utf8'
);

interface UrlInfo {
  service: string;
  label: string;
  displayUrl: string;
  href: string;
}

interface MockNode {
  nodeType: number; // 1 for element, 3 for text
  nodeName: string;
  textContent: string;
  className?: string;
  href?: string;
  target?: string;
  rel?: string;
  children: MockNode[];
  firstChild?: MockNode | null;
  appendChild(child: MockNode): void;
  removeChild(child: MockNode): void;
}

function createMockElement(tag: string): MockNode {
  const node: MockNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    textContent: '',
    className: '',
    children: [],
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(child: MockNode) {
      this.children.push(child);
      if (child.nodeType === 3) {
        this.textContent += child.textContent;
      }
    },
    removeChild(child: MockNode) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
      }
      this.textContent = this.children
        .filter(c => c.nodeType === 3)
        .map(c => c.textContent)
        .join('');
    },
  };
  return node;
}

function createMockTextNode(text: string): MockNode {
  return {
    nodeType: 3,
    nodeName: '#text',
    textContent: text,
    children: [],
    appendChild() {},
    removeChild() {},
  };
}

function loadHelper() {
  const window: Record<string, unknown> = {};
  const document = {
    createElement: (tag: string) => createMockElement(tag),
    createTextNode: (text: string) => createMockTextNode(text),
  };
  const context: Record<string, unknown> = {
    window,
    globalThis: window,
    document,
    URL,
    RegExp,
  };
  vm.runInNewContext(linkPreviewSource, context, { filename: 'link-preview.js' });
  return (window.LinkPreview as {
    classifyUrl: (url: string) => UrlInfo | null;
    renderInto: (target: MockNode, text: string | null | undefined) => void;
  });
}

test('classifyUrl recognizes Google Maps URLs and extracts service label', () => {
  const { classifyUrl } = loadHelper();
  const maps1 = classifyUrl('https://maps.app.goo.gl/uX3b4c');
  assert.ok(maps1);
  assert.equal(maps1.service, 'maps');
  assert.equal(maps1.label, 'Google Maps');
  assert.equal(maps1.href, 'https://maps.app.goo.gl/uX3b4c');

  const maps2 = classifyUrl('https://maps.google.com/?q=52.2,21.0');
  assert.ok(maps2);
  assert.equal(maps2.service, 'maps');
  assert.equal(maps2.label, 'Google Maps');

  const maps3 = classifyUrl('https://www.google.com/maps/place/Krakow');
  assert.ok(maps3);
  assert.equal(maps3.service, 'maps');
});

test('classifyUrl recognizes Google Drive, Docs, and Sheets', () => {
  const { classifyUrl } = loadHelper();
  const drive = classifyUrl('https://drive.google.com/drive/folders/1a2b3c');
  assert.ok(drive);
  assert.equal(drive.service, 'drive');
  assert.equal(drive.label, 'Dysk Google');

  const doc = classifyUrl('https://docs.google.com/document/d/1x2y3z/edit');
  assert.ok(doc);
  assert.equal(doc.service, 'drive');
  assert.equal(doc.label, 'Dokumenty Google');

  const sheet = classifyUrl('https://docs.google.com/spreadsheets/d/1x2y3z/edit');
  assert.ok(sheet);
  assert.equal(sheet.service, 'drive');
  assert.equal(sheet.label, 'Arkusze Google');
});

test('classifyUrl recognizes Facebook and YouTube links', () => {
  const { classifyUrl } = loadHelper();
  const fb = classifyUrl('https://facebook.com/events/123456');
  assert.ok(fb);
  assert.equal(fb.service, 'facebook');
  assert.equal(fb.label, 'Facebook');

  const yt = classifyUrl('https://youtu.be/abcdef123');
  assert.ok(yt);
  assert.equal(yt.service, 'youtube');
  assert.equal(yt.label, 'YouTube');
});

test('classifyUrl classifies generic external web links', () => {
  const { classifyUrl } = loadHelper();
  const generic = classifyUrl('https://wolin.pl/festiwal');
  assert.ok(generic);
  assert.equal(generic.service, 'generic');
  assert.equal(generic.label, 'wolin.pl');
});

test('classifyUrl rejects dangerous or unsupported protocols', () => {
  const { classifyUrl } = loadHelper();
  assert.equal(classifyUrl('javascript:alert(1)'), null);
  assert.equal(classifyUrl('data:text/html,<b>xss</b>'), null);
  assert.equal(classifyUrl('ftp://example.com/file.zip'), null);
  assert.equal(classifyUrl('not-a-url'), null);
});

test('renderInto handles null or empty input safely', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, '');
  assert.equal(el.children.length, 0);

  renderInto(el, null);
  assert.equal(el.children.length, 0);
});

test('renderInto renders plain text without links as literal text nodes preserving newlines', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, 'Zbiórka w piątek.\nZabierzcie tarcze.');

  assert.equal(el.children.length, 3);
  assert.equal(el.children[0].nodeType, 3);
  assert.equal(el.children[0].textContent, 'Zbiórka w piątek.');
  assert.equal(el.children[1].nodeType, 3);
  assert.equal(el.children[1].textContent, '\n');
  assert.equal(el.children[2].nodeType, 3);
  assert.equal(el.children[2].textContent, 'Zabierzcie tarcze.');
});

test('renderInto renders standalone URL on its own line as a compact smart chip', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, 'https://maps.app.goo.gl/uX3b4c');

  assert.equal(el.children.length, 1);
  const chip = el.children[0];
  assert.equal(chip.nodeName, 'A');
  assert.equal(chip.className, 'lw-link-chip lw-link-chip--maps');
  assert.equal(chip.href, 'https://maps.app.goo.gl/uX3b4c');
  assert.equal(chip.target, '_blank');
  assert.equal(chip.rel, 'noopener noreferrer');

  // Verify chip structure has icon, body, and arrow
  assert.ok(chip.children.some(c => c.className === 'lw-link-chip-icon'));
  assert.ok(chip.children.some(c => c.className === 'lw-link-chip-body'));
  assert.ok(chip.children.some(c => c.className === 'lw-link-chip-arrow'));
});

test('renderInto renders inline URLs within sentences as .lw-link-inline', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, 'Pinezka: https://maps.app.goo.gl/uX3b4c - do zobaczenia!');

  assert.equal(el.children.length, 3);
  assert.equal(el.children[0].nodeType, 3);
  assert.equal(el.children[0].textContent, 'Pinezka: ');

  const inlineLink = el.children[1];
  assert.equal(inlineLink.nodeName, 'A');
  assert.equal(inlineLink.className, 'lw-link-inline lw-link-inline--maps');
  assert.equal(inlineLink.href, 'https://maps.app.goo.gl/uX3b4c');
  assert.equal(inlineLink.target, '_blank');
  assert.equal(inlineLink.rel, 'noopener noreferrer');

  assert.equal(el.children[2].nodeType, 3);
  assert.equal(el.children[2].textContent, ' - do zobaczenia!');
});

test('renderInto excludes trailing sentence punctuation from the URL', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, 'Sprawdź https://maps.app.goo.gl/uX3b4c.');

  assert.equal(el.children.length, 3);
  assert.equal(el.children[1].href, 'https://maps.app.goo.gl/uX3b4c');
  assert.equal(el.children[2].nodeType, 3);
  assert.equal(el.children[2].textContent, '.');
});

test('renderInto prevents XSS by keeping raw HTML tags as text nodes', () => {
  const { renderInto } = loadHelper();
  const el = createMockElement('p');
  renderInto(el, '<script>alert("xss")</script> <img src=x onerror=alert(1)>');

  // All children must be pure text nodes; no script or img elements created!
  assert.ok(el.children.length > 0);
  assert.ok(el.children.every(c => c.nodeType === 3));
  assert.equal(el.children.some(c => c.nodeName === 'SCRIPT'), false);
  assert.equal(el.children.some(c => c.nodeName === 'IMG'), false);
});

test('renderInto handles real Facebook event URL with JSON query params as a clean chip', () => {
  const { renderInto, classifyUrl } = loadHelper();
  const rawFbUrl =
    'https://www.facebook.com/events/2306691303503399/?post_id=2317678229071373&acontext=%7B"source"%3A"29"%2C"ref_notif_type"%3A"admin_plan_mall_activity"%2C"action_history"%3A"null"%7D';

  const info = classifyUrl(rawFbUrl);
  assert.ok(info);
  assert.equal(info.service, 'facebook');
  assert.equal(info.label, 'Facebook');
  assert.equal(info.displayUrl, 'facebook.com/events/2306691303503399');
  assert.ok(info.href.startsWith('https://www.facebook.com/events/2306691303503399/?post_id=2317678229071373&acontext=%7B'));

  const el = createMockElement('p');
  renderInto(el, rawFbUrl);

  assert.equal(el.children.length, 1);
  const chip = el.children[0];
  assert.equal(chip.nodeName, 'A');
  assert.equal(chip.className, 'lw-link-chip lw-link-chip--facebook');
  assert.ok(chip.href?.includes('2306691303503399'));
});

test('renderInto recognizes standalone URLs wrapped in quotes, angle brackets, or trailing dots', () => {
  const { renderInto } = loadHelper();

  const el1 = createMockElement('p');
  renderInto(el1, '"https://maps.app.goo.gl/uX3b4c"');
  assert.equal(el1.children.length, 1);
  assert.equal(el1.children[0].className, 'lw-link-chip lw-link-chip--maps');

  const el2 = createMockElement('p');
  renderInto(el2, '<https://maps.app.goo.gl/uX3b4c>');
  assert.equal(el2.children.length, 1);
  assert.equal(el2.children[0].className, 'lw-link-chip lw-link-chip--maps');

  const el3 = createMockElement('p');
  renderInto(el3, 'https://maps.app.goo.gl/uX3b4c.');
  assert.equal(el3.children.length, 1);
  assert.equal(el3.children[0].className, 'lw-link-chip lw-link-chip--maps');
});

test('classifyUrl strips tracking parameters (utm, fbclid, gclid) from displayUrl', () => {
  const { classifyUrl } = loadHelper();
  const info = classifyUrl('https://wolin.pl/festiwal?utm_source=fb&utm_medium=cpc&fbclid=IwAR123');
  assert.ok(info);
  assert.equal(info.displayUrl, 'wolin.pl/festiwal');
});

test('renderInto renders Facebook URL inline without breaking subsequent sentence text', () => {
  const { renderInto } = loadHelper();
  const rawFbUrl =
    'https://www.facebook.com/events/2306691303503399/?post_id=2317678229071373&acontext=%7B"source"%3A"29"%2C"ref_notif_type"%3A"admin_plan_mall_act';
  const el = createMockElement('p');
  renderInto(el, `Więcej szczegółów: ${rawFbUrl} - zapraszamy!`);

  assert.equal(el.children.length, 3);
  assert.equal(el.children[0].textContent, 'Więcej szczegółów: ');
  assert.equal(el.children[1].nodeName, 'A');
  assert.equal(el.children[1].className, 'lw-link-inline lw-link-inline--facebook');
  assert.equal(el.children[2].textContent, ' - zapraszamy!');
});
