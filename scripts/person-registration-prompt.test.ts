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
  busyAtOpen = 0;
  isConnected = true;
  focusCount = 0;
  disabled = false;
  open = false;
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
    this.open = true;
    if (this.nextAction === 'close') { this.close(); return; }
    if (this.nextAction === 'escape') {
      for (const listener of this.listeners.cancel ?? []) listener({ preventDefault() {} });
      return;
    }
    const button = this.nextAction === 'done'
      ? '.person-registration-success-dialog__done'
      : this.nextAction === 'confirm' ? '.person-registration-dialog__confirm' : '.person-registration-dialog__cancel';
    for (const listener of this.childListeners[button] ?? []) listener();
  }
  childListeners: Record<string, Array<() => void>> = {};
  close() {
    if (!this.open) return;
    this.open = false;
    for (const listener of this.listeners.close ?? []) listener();
  }
  remove() { this.removed = true; }
  nextAction: 'confirm' | 'cancel' | 'escape' | 'close' | 'done' = 'confirm';
}

function load(action: 'confirm' | 'cancel' | 'escape' | 'close' | 'done' | Array<'confirm' | 'cancel' | 'escape' | 'close' | 'done'>) {
  const dialogs: FakeElement[] = [];
  const trigger = new FakeElement();
  const actions = Array.isArray(action) ? action : [action];
  let dialogIndex = 0;
  let busyCount = 0;
  const context: Record<string, any> = {
    window: {},
    document: { activeElement: trigger, body: {}, createElement: () => { const dialog = new FakeElement(); dialog.nextAction = actions[dialogIndex++] ?? actions.at(-1)!; dialog.busyAtOpen = busyCount; dialog.querySelector = (selector: string) => {
      const button = new FakeElement();
      button.addEventListener = (type, listener) => { if (type === 'click') (dialog.childListeners[selector] ??= []).push(listener); };
      return button;
    }; dialogs.push(dialog); return dialog; }, body: { append: () => {} } },
    Promise, Object, String, Array,
  };
  context.window.MutationFeedback = {
    showBusy: () => {
      busyCount += 1;
      let hidden = false;
      return () => { if (!hidden) { hidden = true; busyCount -= 1; } };
    },
    confirmed: async (options: any) => {
      const result = await options.execute();
      if (!options.skipApplyWhen?.(result)) await options.apply?.(result);
      return result;
    },
  };
  vm.runInNewContext(source, context);
  return { prompt: context.window.PersonRegistrationPrompt, dialogs, trigger, getBusyCount: () => busyCount };
}

const matches = [
  { firstName: 'Iga', lastName: 'Kruk', nickname: '<Wilk>', section: 'Sekcja A', owner: 'Właściciel' },
  { firstName: 'Jan', lastName: 'Nowak', nickname: null, section: null, owner: null },
];

test('confirmed registration keeps busy active through apply and shows the created person details', async () => {
  const { prompt, dialogs, trigger, getBusyCount } = load(['confirm', 'done']);
  const calls: boolean[] = [];
  let applyBusyCount = 0;
  const control = new FakeElement();
  const result = await prompt.confirmed({
    control,
    fallbackFocus: () => trigger,
    execute: async (duplicateConfirmed: boolean) => {
      calls.push(duplicateConfirmed);
      assert.equal(control.disabled, true);
      if (!duplicateConfirmed) throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
      return { person: { firstName: 'Ewa', lastName: 'Kruk', nickname: '<Sowa>', categoryId: 'niewiasta', sectionId: 's1' } };
    },
    apply: async () => { applyBusyCount = getBusyCount(); },
    successDetails: (saved: any) => ({ person: saved.person, statusLabel: 'Niewiasta', sectionLabel: 'Sekcja A' }),
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(result.person.firstName, 'Ewa');
  assert.equal(applyBusyCount, 1, 'the busy overlay stays active while the refreshed view is applied');
  assert.equal(getBusyCount(), 0, 'the busy overlay is hidden after the success dialog closes');
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[0].busyAtOpen, 0, 'the duplicate warning is not covered by the busy overlay');
  assert.equal(dialogs[1].busyAtOpen, 0, 'the success popup is shown after the busy overlay is removed');
  assert.match(dialogs[1].innerHTML, /Osoba została zarejestrowana w apce/);
  assert.match(dialogs[1].innerHTML, /Imię i nazwisko:<\/strong> Ewa Kruk/);
  assert.match(dialogs[1].innerHTML, /Ksywka:<\/strong> &lt;Sowa&gt;/);
  assert.match(dialogs[1].innerHTML, /Status:<\/strong> Niewiasta/);
  assert.match(dialogs[1].innerHTML, /Sekcja:<\/strong> Sekcja A/);
  assert.match(dialogs[1].innerHTML, />Gotowe</);
  assert.equal(control.disabled, false);
  assert.equal(trigger.focusCount, 2);
});

test('a second submission using the same control is ignored until registration finishes', async () => {
  const { prompt, getBusyCount } = load('done');
  const control = new FakeElement();
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const options = {
    control,
    execute: async () => { calls += 1; start(); await gate; return { person: { firstName: 'A', lastName: 'B' } }; },
    apply: async () => {},
  };
  const first = prompt.confirmed(options);
  await started;
  assert.equal(control.disabled, true);
  assert.equal(getBusyCount(), 1);
  await prompt.confirmed({ ...options, execute: async () => { calls += 1; return {}; } });
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(getBusyCount(), 0);
  assert.equal(control.disabled, false);
});

test('a failed registration releases busy state, re-enables the control and restores focus', async () => {
  const { prompt, dialogs, trigger, getBusyCount } = load('confirm');
  const control = new FakeElement();
  await assert.rejects(prompt.confirmed({
    control,
    fallbackFocus: () => trigger,
    execute: async () => { throw new Error('network'); },
  }), /network/);
  assert.equal(getBusyCount(), 0);
  assert.equal(control.disabled, false);
  assert.equal(trigger.focusCount, 1);
  assert.equal(dialogs.length, 0);
});

test('cancelling a duplicate prompt releases busy state and does not apply or show success', async () => {
  const { prompt, dialogs, trigger, getBusyCount } = load('cancel');
  const control = new FakeElement();
  let applied = false;
  const result = await prompt.confirmed({
    control,
    fallbackFocus: () => trigger,
    execute: async () => { throw Object.assign(new Error('duplicate'), { duplicateMatches: matches }); },
    apply: async () => { applied = true; },
    successDetails: () => ({ person: { firstName: 'New', lastName: 'Person' } }),
  });
  assert.equal(prompt.wasCancelled(result), true);
  assert.equal(applied, false);
  assert.equal(getBusyCount(), 0);
  assert.equal(control.disabled, false);
  assert.equal(trigger.focusCount, 1);
  assert.equal(dialogs.length, 1);
});

test('existing-person mutations can suppress the busy overlay and success dialog', async () => {
  const { prompt, dialogs, getBusyCount } = load('done');
  const control = new FakeElement();
  let applied = false;
  const result = await prompt.confirmed({
    control,
    busyMessage: null,
    execute: async () => { assert.equal(getBusyCount(), 0); return { person: { personId: 'existing' } }; },
    apply: async () => { applied = true; },
    successDetails: () => null,
  });
  assert.equal(result.person.personId, 'existing');
  assert.equal(applied, true);
  assert.equal(getBusyCount(), 0);
  assert.equal(dialogs.length, 0);
});

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
  assert.match(dialogs[0].innerHTML, /Osoba towarzysząca od: Właściciel/);
  assert.match(dialogs[0].innerHTML, /&lt;Wilk&gt;/);
  const janCandidate = dialogs[0].innerHTML.match(/<li class="person-registration-match">\s*<strong>Jan Nowak<\/strong>[\s\S]*?<\/li>/)?.[0] ?? '';
  assert.match(janCandidate, /<span>Sekcja: —<\/span>/);
  assert.doesNotMatch(janCandidate, /Osoba towarzysząca od:/);
  assert.doesNotMatch(janCandidate, /Ksywka:/, 'a missing nickname is omitted for this person');
  const candidateList = dialogs[0].innerHTML.match(/<ul class="person-registration-dialog__matches"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(candidateList, 'matches are rendered in the informational list');
  assert.doesNotMatch(candidateList, /<button\b/, 'existing matches cannot be selected');
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

test('a direct dialog close settles registration as cancelled', async () => {
  const { prompt } = load('close');
  let calls = 0;
  const result = await prompt.run(async () => {
    calls += 1;
    throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
  });
  assert.equal(calls, 1);
  assert.equal(prompt.wasCancelled(result), true);
});

test('a disabled submit button can fall back to the still-enabled form field on cancel', async () => {
  const { prompt, trigger } = load('cancel');
  trigger.disabled = true;
  const field = new FakeElement();
  const result = await prompt.run(async () => {
    throw Object.assign(new Error('duplicate'), { duplicateMatches: matches });
  }, { fallbackFocus: () => field });
  assert.equal(prompt.wasCancelled(result), true);
  assert.equal(trigger.focusCount, 0);
  assert.equal(field.focusCount, 1);
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
    assert.match(pageScript, /PersonRegistrationPrompt\.confirmed\(/, `${scriptPath} must invoke the shared registration lifecycle`);
    assert.match(pageScript, /successDetails:/, `${scriptPath} must provide details for a newly registered person`);
    assert.match(pageScript, /duplicateConfirmed: true/, `${scriptPath} must confirm the retry to the server`);
    assert.match(source, /skipApplyWhen: \(result\) => wasCancelled\(result\)/, 'the shared lifecycle must leave the view unchanged when the prompt is cancelled');
    assert.match(pageScript, scriptPath.includes('/zarzadzanie-ludzmi/') ? /focusAfterApply,/ : /focusAfterApply:/, `${scriptPath} must restore focus after the new view is rendered`);
    assert.ok(pageScript.includes(focusMarker), `${scriptPath} must target its correct post-registration control`);
    if (scriptPath.includes('/profil/') || scriptPath.includes('/zarzadzanie-ludzmi/')) {
      assert.match(pageScript, /CompanionAdd\.categoryOptionsHtml\(/, `${scriptPath} must use the shared category option renderer`);
    }
    if (scriptPath.includes('/lista-wyjazdowa/')) {
      assert.match(pageScript, /busyMessage: body\.mode === 'new' \? undefined : null/);
    }
    if (scriptPath.includes('/lista-wyjazdowa/lista-wyjazdowa.js')) {
      assert.match(pageScript, /categoryOptions\.find\([\s\S]*sectionOptions\.find\(/);
    } else if (scriptPath.includes('/lista-wyjazdowa/wyjazd/')) {
      assert.match(pageScript, /categoryLabelById\.get\([\s\S]*sectionLabelById\.get\(/);
    } else if (scriptPath.includes('/app/')) {
      assert.match(pageScript, /dash\.categories\.find\([\s\S]*dash\.sections\.find\(/);
    } else if (scriptPath.includes('/profil/')) {
      assert.match(pageScript, /personLookupLists\.categories\.find\([\s\S]*personLookupLists\.sections\.find\(/);
    } else {
      assert.match(pageScript, /accountlessCache\.categories\.find\([\s\S]*accountlessCache\.sections\.find\(/);
    }
  }
  assert.match(source, /busyMessage = BUSY_MESSAGE/);
  const styles = readFileSync(new URL('../public/member-area.css', import.meta.url), 'utf8');
  assert.match(styles, /\.person-registration-success-dialog\s*\{/);
  assert.match(styles, /\.person-registration-success-dialog__done\s*\{/);
});
