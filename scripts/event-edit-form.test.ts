import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/event-edit-form.js', import.meta.url), 'utf8');

class Element {
  hidden = false;
  value = '';
  textContent = '';
  private listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    (this.listeners.get(type) ?? []).forEach((listener) => listener());
  }
}

function loadHarness(idPrefix: string, event: { name: string; startDate: string }) {
  const elements = new Map<string, Element>();
  const getElementById = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id) ?? null;
  };
  const context: Record<string, unknown> = {
    window: {},
    String,
    URL,
    document: { getElementById },
  };
  vm.runInNewContext(source, context, { filename: 'event-edit-form.js' });
  const EventEditForm = (context.window as { EventEditForm: any }).EventEditForm;
  // Mirrors panelHtml's real markup: the name/date inputs start pre-filled with the event's own
  // values (value="..."), and the warning paragraph starts with the `hidden` attribute.
  const nameInput = getElementById(`${idPrefix}-name`)!;
  const dateInput = getElementById(`${idPrefix}-date`)!;
  const warning = getElementById(`${idPrefix}-url-warning`)!;
  nameInput.value = event.name;
  dateInput.value = event.startDate;
  warning.hidden = true;
  return { EventEditForm, nameInput, dateInput, warning };
}

test('panelHtml includes a hidden URL-change warning between Data and Opis', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  const html = EventEditForm.panelHtml(
    { id: 'e1', name: 'Wolin', startDate: '2027-01-01', description: null, status: 'active' },
    { idPrefix: 'event-edit' },
  );
  assert.match(html, /<p class="lw-event-edit-url-warning" id="event-edit-url-warning" hidden>/);
  // Between the date field and the description field, not before Nazwa/Data.
  const dateIdx = html.indexOf('event-edit-date');
  const warningIdx = html.indexOf('event-edit-url-warning');
  const descriptionIdx = html.indexOf('event-edit-description');
  assert.ok(dateIdx < warningIdx && warningIdx < descriptionIdx);
});

test('wireUrlWarning shows the warning once the name differs from the event', () => {
  const event = { name: 'Wolin', startDate: '2027-01-01' };
  const { EventEditForm, nameInput, warning } = loadHarness('event-edit', event);
  EventEditForm.wireUrlWarning('event-edit', event);
  assert.equal(warning.hidden, true);
  nameInput.value = 'Wolin Żarłoczny';
  nameInput.dispatch('input');
  assert.equal(warning.hidden, false);
  nameInput.value = 'Wolin';
  nameInput.dispatch('input');
  assert.equal(warning.hidden, true);
});

test('wireUrlWarning shows the warning once the date differs from the event', () => {
  const event = { name: 'Wolin', startDate: '2027-01-01' };
  const { EventEditForm, dateInput, warning } = loadHarness('event-edit', event);
  EventEditForm.wireUrlWarning('event-edit', event);
  assert.equal(warning.hidden, true);
  dateInput.value = '2027-02-01';
  dateInput.dispatch('input');
  assert.equal(warning.hidden, false);
});

test('wireUrlWarning trims the name before comparing (whitespace-only edits do not warn)', () => {
  const event = { name: 'Wolin', startDate: '2027-01-01' };
  const { EventEditForm, nameInput, warning } = loadHarness('event-edit', event);
  EventEditForm.wireUrlWarning('event-edit', event);
  nameInput.value = '  Wolin  ';
  nameInput.dispatch('input');
  assert.equal(warning.hidden, true);
});

test('panelHtml renders the "bez sprzętu obozowego" checkbox, checked only when the event has the flag', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  const base = { id: 'e1', name: 'Wolin', startDate: '2027-01-01', description: null, status: 'active' };
  const off = EventEditForm.panelHtml(base, { idPrefix: 'event-edit' });
  assert.match(off, /<input type="checkbox" id="event-edit-no-camp-equipment">/);
  const on = EventEditForm.panelHtml({ ...base, noCampEquipment: true }, { idPrefix: 'event-edit' });
  assert.match(on, /id="event-edit-no-camp-equipment" checked>/);
});

test('buildUpdateBody sends noCampEquipment only when it changed', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  const event = { name: 'Wolin', startDate: '2027-01-01', description: null };
  const form = { name: 'Wolin', startDate: '2027-01-01', description: '', noCampEquipment: false };
  assert.deepEqual({ ...EventEditForm.buildUpdateBody(event, form) }, {});
  assert.deepEqual({ ...EventEditForm.buildUpdateBody(event, { ...form, noCampEquipment: true }) }, { noCampEquipment: true });
});

test('panelHtml renders the Maps and Discord link fields between the URL warning and Opis, pre-filled', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  const html = EventEditForm.panelHtml(
    { id: 'e1', name: 'Wolin', startDate: '2027-01-01', description: null, status: 'active', mapUrl: 'https://maps.app.goo.gl/abc', discordUrl: null },
    { idPrefix: 'event-edit' },
  );
  assert.match(html, /id="event-edit-map-url"[^>]*value="https:\/\/maps\.app\.goo\.gl\/abc"/);
  assert.match(html, /id="event-edit-discord-url"[^>]*value=""/);
  assert.ok(html.indexOf('event-edit-map-url') < html.indexOf('event-edit-discord-url'));
  assert.ok(html.indexOf('event-edit-discord-url') < html.indexOf('event-edit-description'));
});

test('validateForm accepts empty and http(s) URLs and rejects anything else', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  assert.equal(EventEditForm.validateForm({ mapUrl: '', discordUrl: '  ' }), null);
  assert.equal(EventEditForm.validateForm({ mapUrl: 'https://maps.app.goo.gl/abc', discordUrl: 'https://discord.com/channels/1/2' }), null);
  assert.match(EventEditForm.validateForm({ mapUrl: 'jakieś miejsce', discordUrl: '' }), /Pinezka Google Maps/);
  assert.match(EventEditForm.validateForm({ mapUrl: '', discordUrl: 'javascript:alert(1)' }), /Discordzie/);
  assert.match(EventEditForm.validateForm({ mapUrl: '', discordUrl: 'https://localhost' }), /Discordzie/);
});

test('buildUpdateBody sends mapUrl/discordUrl only when changed, and null when cleared', () => {
  const { EventEditForm } = loadHarness('event-edit', { name: 'Wolin', startDate: '2027-01-01' });
  const event = { name: 'Wolin', startDate: '2027-01-01', description: null, mapUrl: 'https://maps.app.goo.gl/abc' };
  const form = { name: 'Wolin', startDate: '2027-01-01', description: '', mapUrl: 'https://maps.app.goo.gl/abc', discordUrl: '', noCampEquipment: false };
  assert.deepEqual({ ...EventEditForm.buildUpdateBody(event, form) }, {});
  assert.deepEqual({ ...EventEditForm.buildUpdateBody(event, { ...form, mapUrl: '' }) }, { mapUrl: null });
  assert.deepEqual({ ...EventEditForm.buildUpdateBody(event, { ...form, discordUrl: ' https://discord.com/channels/1/2 ' }) }, { discordUrl: 'https://discord.com/channels/1/2' });
});
