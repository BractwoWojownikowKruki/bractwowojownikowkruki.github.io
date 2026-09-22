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
