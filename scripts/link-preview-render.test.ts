import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const wyjazdSource = readFileSync(
  new URL('../public/lista-wyjazdowa/wyjazd/wyjazd.js', import.meta.url),
  'utf8'
);
const linkPreviewSource = readFileSync(
  new URL('../public/shared/link-preview.js', import.meta.url),
  'utf8'
);

interface MockNode {
  nodeType: number;
  nodeName: string;
  textContent: string;
  className?: string;
  hidden?: boolean;
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
    hidden: false,
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

function setupHarness() {
  const elements = new Map<string, MockNode>();
  elements.set('event-description', createMockElement('p'));
  elements.set('event-description-panel', createMockElement('section'));

  const windowObj: Record<string, unknown> = {};
  const documentObj = {
    getElementById: (id: string) => elements.get(id) || null,
    createElement: (tag: string) => createMockElement(tag),
    createTextNode: (text: string) => createMockTextNode(text),
  };

  const context: Record<string, unknown> = {
    window: windowObj,
    globalThis: windowObj,
    document: documentObj,
    URL,
    RegExp,
  };

  // Run link-preview.js first
  vm.runInNewContext(linkPreviewSource, context, { filename: 'link-preview.js' });

  // Extract renderEventDescription function from wyjazd.js
  const renderFnMatch = wyjazdSource.match(/function renderEventDescription\(event\) \{[\s\S]*?\n\}/);
  assert.ok(renderFnMatch, 'renderEventDescription function must exist in wyjazd.js');
  vm.runInNewContext(renderFnMatch[0], context, { filename: 'wyjazd-render-desc.js' });

  const renderEventDescription = context.renderEventDescription as (event: { description?: string | null }) => void;

  return {
    elements,
    renderEventDescription,
  };
}

test('renderEventDescription renders standalone URL as a smart chip and unhides panel', () => {
  const { elements, renderEventDescription } = setupHarness();
  renderEventDescription({ description: 'https://maps.app.goo.gl/uX3b4c' });

  const descEl = elements.get('event-description')!;
  const panelEl = elements.get('event-description-panel')!;

  assert.equal(descEl.hidden, false);
  assert.equal(panelEl.hidden, false);
  assert.equal(descEl.children.length, 1);

  const chip = descEl.children[0];
  assert.equal(chip.nodeName, 'A');
  assert.equal(chip.className, 'lw-link-chip lw-link-chip--maps');
  assert.equal(chip.href, 'https://maps.app.goo.gl/uX3b4c');
  assert.equal(chip.target, '_blank');
  assert.equal(chip.rel, 'noopener noreferrer');
});

test('renderEventDescription renders inline URLs within sentences', () => {
  const { elements, renderEventDescription } = setupHarness();
  renderEventDescription({ description: 'Dojazd: https://maps.app.goo.gl/uX3b4c - do zobaczenia!' });

  const descEl = elements.get('event-description')!;
  assert.equal(descEl.hidden, false);
  assert.equal(descEl.children.length, 3);
  assert.equal(descEl.children[0].textContent, 'Dojazd: ');

  const inlineLink = descEl.children[1];
  assert.equal(inlineLink.nodeName, 'A');
  assert.equal(inlineLink.className, 'lw-link-inline lw-link-inline--maps');
  assert.equal(inlineLink.href, 'https://maps.app.goo.gl/uX3b4c');

  assert.equal(descEl.children[2].textContent, ' - do zobaczenia!');
});

test('renderEventDescription hides panel and description when description is empty or null', () => {
  const { elements, renderEventDescription } = setupHarness();

  renderEventDescription({ description: '' });
  assert.equal(elements.get('event-description')!.hidden, true);
  assert.equal(elements.get('event-description-panel')!.hidden, true);

  renderEventDescription({ description: null });
  assert.equal(elements.get('event-description')!.hidden, true);
  assert.equal(elements.get('event-description-panel')!.hidden, true);
});

test('renderEventDescription falls back gracefully when LinkPreview is absent', () => {
  const elements = new Map<string, MockNode>();
  const descEl = createMockElement('p');
  const panelEl = createMockElement('section');
  elements.set('event-description', descEl);
  elements.set('event-description-panel', panelEl);

  const windowObj: Record<string, unknown> = {};
  const documentObj = {
    getElementById: (id: string) => elements.get(id) || null,
  };
  const context: Record<string, unknown> = {
    window: windowObj,
    document: documentObj,
  };

  const renderFnMatch = wyjazdSource.match(/function renderEventDescription\(event\) \{[\s\S]*?\n\}/);
  vm.runInNewContext(renderFnMatch![0], context, { filename: 'wyjazd-render-desc.js' });
  const renderFn = context.renderEventDescription as (event: { description?: string | null }) => void;

  renderFn({ description: 'Zwykły opis bez biblioteki' });
  assert.equal(descEl.textContent, 'Zwykły opis bez biblioteki');
  assert.equal(descEl.hidden, false);
  assert.equal(panelEl.hidden, false);
});
