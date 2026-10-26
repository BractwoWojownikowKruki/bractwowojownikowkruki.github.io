import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/event-link-actions.js', import.meta.url), 'utf8');

function loadActions() {
  const context: Record<string, any> = {
    URL,
    window: {},
  };
  vm.runInNewContext(source, context, { filename: 'event-link-actions.js' });
  return context.window.EventLinkActions;
}

test('event link actions render accessible icon-only links and missing-link triggers', () => {
  const actions = loadActions();
  const html = actions.html({ id: 'event-1', mapUrl: 'https://maps.app.goo.gl/abc', discordUrl: 'https://discord.com/channels/1/2' });

  assert.match(html, /aria-label="Otwórz pinezkę Google Maps"/);
  assert.match(html, /href="https:\/\/maps\.app\.goo\.gl\/abc"/);
  assert.match(html, /aria-label="Otwórz wątek na Discordzie"/);
  assert.match(html, /href="https:\/\/discord\.com\/channels\/1\/2"/);
  assert.match(html, /data-event-link-field="discordUrl"/);
  assert.doesNotMatch(html, /data-link-missing="true"/);
  assert.doesNotMatch(html, />\s*(?:Pinezka Google Maps z dojazdem|Wątek na Discordzie)\s*</);
});

test('the missing map dialog names the missing pin and saves the link through its callback', async () => {
  const nodes = new Map<string, any>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        textContent: '', hidden: false, value: '', placeholder: '', listeners: new Map<string, Function[]>(),
        addEventListener(type: string, listener: Function) {
          this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        },
        focus() {},
      });
    }
    return nodes.get(selector);
  };
  let removed = false;
  const root = {
    id: '', className: '', innerHTML: '',
    querySelector: node,
    remove() { removed = true; },
  };
  const context: Record<string, any> = {
    URL,
    window: {},
    document: {
      body: { append: () => {} },
      getElementById: () => null,
      createElement: () => root,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  };
  vm.runInNewContext(source, context, { filename: 'event-link-actions.js' });
  let saved: unknown[] | null = null;
  const event = { id: 'event-1' };
  const link = {
    dataset: { eventLinkField: 'mapUrl', linkMissing: 'true' },
  };
  link.closest = (selector: string) => selector === '[data-event-link-field]' ? link : null;
  const listeners = new Map<string, Function>();
  const container = {
    addEventListener: (type: string, listener: Function) => listeners.set(type, listener),
    contains: () => true,
  };
  context.window.EventLinkActions.wire(container, () => event, async (...args: unknown[]) => { saved = args; });
  let prevented = false;
  listeners.get('click')!({ target: link, preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(node('#event-link-modal-title').textContent, 'Nikt nie podał pinezki z dojazdem do Google Maps.');
  assert.equal(node('label').textContent, 'Pinezka Google Maps z dojazdem');
  node('#event-link-modal-input').value = 'https://maps.app.goo.gl/abc';
  await node('#event-link-modal-save').listeners.get('click')[0]();

  assert.deepEqual(saved, [{ id: 'event-1' }, 'mapUrl', 'https://maps.app.goo.gl/abc']);
  assert.equal(removed, true);
});
