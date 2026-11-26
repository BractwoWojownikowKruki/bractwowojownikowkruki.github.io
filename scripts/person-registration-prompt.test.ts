import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/person-registration-prompt.js', import.meta.url), 'utf8');
const registrationRoutes = [
  ['../public/lista-wyjazdowa/index.html', '../public/lista-wyjazdowa/lista-wyjazdowa.js', '../shared/person-registration-prompt.js', 'eventRowAnchor(body.eventId)'],
  ['../public/lista-wyjazdowa/wyjazd/index.html', '../public/lista-wyjazdowa/wyjazd/wyjazd.js', '../../shared/person-registration-prompt.js', '.lw-attend-toggle[data-person-id='],
  ['../public/app/index.html', '../public/app/app.js', '../shared/person-registration-prompt.js', 'dashEventAnchor(body.eventId)'],
  ['../public/profil/index.html', '../public/profil/profil.js', '../shared/person-registration-prompt.js', '.person-row[data-person-id='],
  ['../public/admin/zarzadzanie-ludzmi/index.html', '../public/admin/zarzadzanie-ludzmi/zarzadzanie-ludzmi.js', '../../shared/person-registration-prompt.js', 'accountless-add-toggle'],
] as const;

class FakeElement {
  innerHTML = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event?: any) => void>> = {};
  removed = false;
  isConnected = true;
  focusCount = 0;
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener(type: string, listener: (event?: any) => void) { (this.listeners[type] ??= []).push(listener); }
  querySelector(selector: string) {
    const element = new FakeElement();
    element.selector = selector;
    return element;
  }
  selector = '';
  focus() { this.focusCount += 1; }
  showModal() {
    if (this.nextAction === 'escape') {
      for (const listener of this.listeners.cancel ?? []) listener({ preventDefault() {} });
      return;
    }
    const button = this.nextAction === 'confirm' ? '.person-registration-dialog__confirm' : '.person-registration-dialog__cancel';
    for (const listener of this.childListeners[button] ?? []) listener();
  }
  childListeners: Record<string, Array<() => void>> = {};
  close() {}
  remove() { this.removed = true; }
  nextAction: 'confirm' | 'cancel' | 'escape' = 'confirm';
}

function load(action: 'confirm' | 'cancel' | 'escape') {
  const dialogs: FakeElement[] = [];
  const trigger = new FakeElement();
  const context: Record<string, any> = {
    window: {},
    document: { activeElement: trigger, createElement: () => { const dialog = new FakeElement(); dialog.nextAction = action; dialog.querySelector = (selector: string) => {
      const button = new FakeElement();
      button.addEventListener = (type, listener) => { if (type === 'click') (dialog.childListeners[selector] ??= []).push(listener); };
      return button;
    }; dialogs.push(dialog); return dialog; }, body: { append: () => {} } },
    Promise, Object, String, Array,
  };
  vm.runInNewContext(source, context);
  return { prompt: context.window.PersonRegistrationPrompt, dialogs, trigger };
}

const matches = [{ firstName: 'Iga', lastName: 'Kruk', nickname: '<Wilk>', section: 'Sekcja A', owner: 'Właściciel' }];

test('a match opens an informational prompt and retries only after explicit confirmation', async () => {
  const { prompt, dialogs, trigger } = load('confirm');
  const calls: boolean[] = [];
  const result = await prompt.run(async (confirmed: boolean) => {
    calls.push(confirmed);
    if (!confirmed) throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
    return 'registered';
  });
  assert.equal(result, 'registered');
  assert.deepEqual(calls, [false, true]);
  assert.match(dialogs[0].innerHTML, /Czy ta osoba już istnieje\?/);
  assert.match(dialogs[0].innerHTML, /Tak, zarejestruj, to zupełnie inna osoba\./);
  assert.match(dialogs[0].innerHTML, /Właściciel: Właściciel/);
  assert.match(dialogs[0].innerHTML, /&lt;Wilk&gt;/);
  assert.doesNotMatch(dialogs[0].innerHTML, /<button[^>]*>Iga Kruk/);
  assert.equal(trigger.focusCount, 1);
});

test('cancelling a duplicate prompt does not retry registration', async () => {
  const { prompt, trigger } = load('cancel');
  let calls = 0;
  const result = await prompt.run(async () => {
    calls += 1;
    throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
  });
  assert.equal(calls, 1);
  assert.equal(prompt.wasCancelled(result), true);
  assert.equal(trigger.focusCount, 1);
});

test('Escape cancels the prompt and does not retry registration', async () => {
  const { prompt, trigger } = load('escape');
  let calls = 0;
  const result = await prompt.run(async () => {
    calls += 1;
    throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
  });
  assert.equal(calls, 1);
  assert.equal(prompt.wasCancelled(result), true);
  assert.equal(trigger.focusCount, 1);
});

test('a duplicate response after confirmation is surfaced without opening another prompt', async () => {
  const { prompt, dialogs } = load('confirm');
  let calls = 0;
  await assert.rejects(prompt.run(async () => {
    calls += 1;
    throw Object.assign(new Error('still duplicate'), { duplicateMatches: matches });
  }), /still duplicate/);
  assert.equal(calls, 2);
  assert.equal(dialogs.length, 1);
});

test('ordinary registration errors pass through without showing a prompt', async () => {
  const { prompt, dialogs } = load('confirm');
  await assert.rejects(prompt.run(async () => { throw new Error('validation'); }), /validation/);
  assert.equal(dialogs.length, 0);
});

test('every person registration page loads the shared prompt and invokes it from its create flow', () => {
  for (const [pagePath, scriptPath, promptPath, focusMarker] of registrationRoutes) {
    const page = readFileSync(new URL(pagePath, import.meta.url), 'utf8');
    const pageScript = readFileSync(new URL(scriptPath, import.meta.url), 'utf8');
    assert.ok(page.includes(`src="${promptPath}"`), `${pagePath} must load the shared prompt`);
    assert.match(pageScript, /PersonRegistrationPrompt\.run\(/, `${scriptPath} must invoke the shared prompt`);
    assert.match(pageScript, /duplicateConfirmed: true/, `${scriptPath} must confirm the retry to the server`);
    assert.match(pageScript, /skipApplyWhen:/, `${scriptPath} must leave the view unchanged when the prompt is cancelled`);
    assert.match(pageScript, /focusAfterApply:/, `${scriptPath} must restore focus after the new view is rendered`);
    assert.ok(pageScript.includes(focusMarker), `${scriptPath} must target its correct post-registration control`);
    if (scriptPath.includes('/profil/') || scriptPath.includes('/zarzadzanie-ludzmi/')) {
      assert.match(pageScript, /CompanionAdd\.categoryOptionsHtml\(/, `${scriptPath} must use the shared category option renderer`);
    }
  }
});
