# KRKG-0076 — recenzja planu (runda 2, OpenCode/DeepSeek)

## Preamble

Ta recenzja została wygenerowana przez OpenCode/DeepSeek. Nie wszystkie obserwacje muszą być trafne.
Jest to recenzja **planu/design docu** (drugi przebieg), nie recenzja commita — w repo nie ma jeszcze
żadnych zmian dla KRKG-0076. Czytano `reviews/.krkg-0076-docs/design.md`, `reviews/.krkg-0076-docs/plan.md`
oraz raport rundy Codeksa (`reviews/KRKG-0076-plan-review.md`) i weryfikowano względem rzeczywistego kodu
(`upload-service/src/*.ts`, `public/**`, `scripts/*`).

## Werdykt

Poprawki z rundy Codeksa (p.1–10 w `design.md` „Poprawki po recenzji”) są w większości **poprawnie
przeniesione** do planu — opisy sygnatur (`AUDITED_MEMBER_MUTATION_ROUTES` / `executeDeclaredAuditedMutation`,
`MutationFeedback.confirmed`, `GATED_PATH_PREFIXES` / `classifyPwaPage`), kontrakt URL-a https-only, redirect-safe
fetch tytułu, streamowany limit rozmiaru, kolizja delete/create w in-memory double i pełny before-state w audycie
są zgodne z kodem. Jednak obecna wersja planu **nie przejdzie swoich własnych bramek**: Batch 2 łamie istniejący
test `audit.test.ts`, a Batch 3 łamie dwa testy skryptów root (`scripts/audit-view-logic.test.ts`,
`scripts/mutation-feedback-coverage.test.ts`) i pozostawia zepsuty deep-link kategorii w `audit-view.js`.
Do tego test „concurrent DELETE → 404” testuje własność, której opisana implementacja nie gwarantuje.

---

## Findings

### 1. [wysokie] Test „drugi concurrent DELETE dostaje 404” nie testuje wyścigu i nie odpowiada implementacji

> `plan.md:1183–1207` (komentarz i test):
> „A delegated review ... flagged that two concurrent DELETEs of the same file could otherwise both appear
> to succeed. The route reads ownership before mutating ... so the second request's read-before-mutate step is
> what must now observe the deletion.”
>
> `plan.md:1199–1206`:
> ```ts
> const [first, second] = await Promise.all([
>   fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' }),
>   fetch(`${baseUrl}/files?id=${fileId}`, { method: 'DELETE' }),
> ]);
> const statuses = [first.status, second.status].sort();
> assert.deepEqual(statuses, [200, 404]);
> ```
>
> `design.md:81–90` (świadome odrzucenie fixu z rundy Codeksa, finding #9):
> „p.9 z raportu sugerował odczyt pliku do usunięcia przez `tx.getDoc` wewnątrz transakcji ... Poprawiony jest
> tylko realny błąd: brakujące pola w `before`.”

`handleDeleteFile` (`plan.md:1290–1315`) czyta plik przez `getFile(deps.firestore, id)` **poza** transakcją,
a `deleteFileInTransaction` → `tx.deleteDoc` (`plan.md:797–799`, `plan.md:267–273`) nie sprawdza istnienia
dokumentu — delete nieistniejącego dokumentu to no-op. Nie ma więc żadnego atomowego mechanizmu, który zwróciłby
404, gdy plik zniknął między odczytem a commit-em. Co gorsza, sam test nie wymusza wyścigu: `Promise.all` dwóch
gołych `fetch` do jednego node:http serwera w praktyce **serializuje** żądania (drugie żądanie zaczyna obsługę po
tym, jak pierwsze w pełni zakończy handler — tak samo jak to robi istniejący test `/upload` w
`server.test.ts:4054–4101`, który do wymuszenia przeplotu używa jawnie `setTimeout` + bramki). W efekcie ten test
przechodzi trywialnie, bo jest to w praktyce „drugi **sekwencyjny** DELETE tego samego id → 404” — dokładnie to,
co już pokrywa test `DELETE /files returns 404 for an unknown id` (`plan.md:1175–1181`).

W produkcji (realny Firestore + możliwie >1 instancja Cloud Run) dwa równoległe DELETE naprawdę mogą **obie**
zwrócić 200, bo odczyt jest poza transakcją a `transaction.delete()` jest idempotentny. Zatem twierdzenie planu
(„drugie żądanie dostaje 404, nie 200”) nie jest własnością implementacji, tylko artefaktem test-double.

**Rekomendacja:** (a) usunąć/przepisać ten test — albo jako jawny test idempotencji przyjmujący `[200, 200]`
(delete nieistniejącego jest bezpieczny), albo (b) jeśli zależy nam na 404 pod współbieżnością, przekształcić
audit-input w factory `(tx) => …`, które wewnątrz transakcji robi `tx.getDoc` i rzuca `AuthError(..., 404)` gdy
plik zniknął (i ponownie sprawdza własność) — czyli dokładnie rekomendacja #9 z rundy Codeksa, którą design
świadomie odrzucił. Obecny stan jest wewnętrznie sprzeczny: odrzucono fix, a test nadal obiecuje jego skutek.

### 2. [blokujące] Deep-link `?category=files` nie zadziała — `mount()` nie obsługuje selektora `categoryAction`

> `plan.md:1473–1497` (Task 5, Step 2): zmienia **wyłącznie** `defaultAuditState`, dodając:
> ```js
> if (initialFilters && initialFilters.category) {
>   return { selector: { kind: 'categoryAction', category: initialFilters.category }, fromDate: '', toDate: '' };
> }
> ```
> `plan.md:1441–1447`: lista plików Task 5 to `audit-view.js` (ACTION_LABELS/CATEGORY_LABELS/
> MEMBER_VISIBLE_CATEGORIES/ACTIONS_BY_CATEGORY/defaultAuditState) i `audyt.js` — **bez** `mount()`.
>
> Kod: `public/shared/audit-view.js:558–571`:
> ```js
> const initialState = defaultAuditState(opts.initialFilters);
> els.fromInput.value = initialState.fromDate;
> els.toInput.value = initialState.toDate;
> if (initialState.selector.kind === 'resourceKey') {
>   els.selectorKind.value = 'resourceKey';
>   showSelectorValue('resourceKey');
>   els.resourceInput.value = initialState.selector.key;
> } else {
>   showSelectorValue('none');
> }
> fetchPage(undefined);
> ```

`defaultAuditState` zwróci `{ kind: 'categoryAction', category: 'files' }`, ale `mount()` rozpoznaje **tylko**
`resourceKey`. Selektor `categoryAction` wpada w `else` → `showSelectorValue('none')`, a `fetchPage` →
`currentSelector()` czyta `els.selectorKind.value` (nadal domyślne `'none'`) → wysyła zapytanie **bez filtra
kategorii**. Link „◷ Historia” (`/audyt/?category=files`) pokaże więc domyślny, ograniczony datą widok globalny,
nie historię plików — wbrew `design.md:242–245` i weryfikacji manualnej w `plan.md:1963–1965`
(„the category filter is pre-selected to 'Pliki'”).

**Rekomendacja:** w Task 5 dodać zmianę `mount()` — po ustawieniu dat obsłużyć też gałąź `categoryAction`:
`els.selectorKind.value = 'categoryAction'; showSelectorValue('categoryAction');`
`els.categorySelect.value = initialState.selector.category;` (i, opcjonalnie, zasilić `actionSelect`). Bez tego
Batch 3 nie spełnia własnego kryterium akceptacji.

### 3. [blokujące] Batch 2 łamie istniejący test `audit.test.ts` (twarda lista kategorii)

> `plan.md:968–972` (Task 3, Step 5): „Run the full suite and typecheck ... Expected: PASS”.
>
> Kod: `upload-service/src/audit.test.ts:34–38`:
> ```ts
> assert.deepEqual(
>   [...new Set(Object.values(ACTION_REGISTRY).map(action => action.category))].sort(),
>   ['application', 'dues', 'events', 'gallery', 'membership', 'permissions', 'profile', 'session', 'signups', 'site'],
> );
> ```

Dodanie kategorii `files` (poprzez `file.added`/`file.deleted` w `ACTION_REGISTRY`) sprawia, że zbiór kategorii
staje się `[... , 'files', ...]` i ta asercja (posortowana lista) **przestaje się zgadzać**. Plan dodaje nowy test
do `audit.test.ts` (`plan.md:892–900`), ale nie aktualizuje tej istniejącej asercji — `cd upload-service && npm test`
w Batchu 2 będzie czerwony, mimo deklarowanego „PASS”.

**Rekomendacja:** dodać `'files'` do tej twardej listy kategorii w `audit.test.ts:37` w tym samym kroku co
rozszerzenie `AuditCategory` (Task 3, Step 3).

### 4. [blokujące] Batch 3 łamie `scripts/audit-view-logic.test.ts` (twarde listy akcji/kategorii member-visible)

> `plan.md:1532–1537` (Task 5, Step 4): „find public/shared -iname "audit-view*.test.*" to check whether one exists”.
>
> Kod: test nie leży w `public/shared`, tylko w `scripts/audit-view-logic.test.ts`:
> ```ts
> // scripts/audit-view-logic.test.ts:47
> assert.equal(registeredActions.length, Object.keys(AuditView.ACTION_LABELS).length);
> // scripts/audit-view-logic.test.ts:205–206
> assert.deepEqual(AuditView.MEMBER_VISIBLE_CATEGORIES, ['events', 'signups', 'gallery']);
> ```

Po dodaniu `file.added`/`file.deleted` do `ACTION_LABELS` (`plan.md:1453–1456`) długość `ACTION_LABELS` wzrasta o 2
względem twardej tablicy `registeredActions` (`scripts/audit-view-logic.test.ts:25–43`), więc asercja `:47` pada.
Dodanie `'files'` do `MEMBER_VISIBLE_CATEGORIES` (`plan.md:1464`) łamie asercję `:206`. Plik `scripts/*.test.ts`
wchodzi w root `npm test` (`package.json`: `"test": "tsx --test scripts/*.test.ts"`), wymagany w Batchu 3
(`plan.md:1934–1938`). Plan nie wymienia `scripts/audit-view-logic.test.ts` ani w liście plików Task 5, ani w
`git add` Batcha 3 (`plan.md:1970`) — jego instrukcja `find public/shared -iname "audit-view*.test.*"` po prostu
tego pliku nie znajdzie.

**Rekomendacja:** w Batchu 3 (Task 5) zaktualizować `scripts/audit-view-logic.test.ts`: dodać `file.added`/
`file.deleted` do `registeredActions`, dodać `'files'` do listy kategorii w teście labeli oraz do asercji
`MEMBER_VISIBLE_CATEGORIES`.

### 5. [blokujące] Batch 3 łamie `mutation-feedback-coverage.test.ts` — `POST/DELETE /files` nie są oznaczone jako „wired”

> `plan.md:1543–1547` (Task 6, Files): Create `public/pliki/*`, Modify `public/nav.js`, `public/member-area.css`,
> `scripts/pwa-policy.ts`, `scripts/pwa-policy.test.ts` — **bez** `scripts/mutation-feedback-coverage.registry.ts`.
>
> Kod: `scripts/mutation-feedback-coverage.registry.ts:39–81` — `mutationFeedbackWiredRoutes` to zamknięty zbiór;
> nowa trasa nieujęta w nim dostaje domyślnie `wiring: 'planned'` (`registry.ts:104–108`).
>
> Kod: `scripts/mutation-feedback-coverage.test.ts:148–166`:
> ```ts
> assert.equal(registry.filter(entry => entry.wiring === 'planned').length, 0, 'all planned routes are completed by batch five');
> ```

Po Batchu 2 wiersz `POST/DELETE /files` trafia do `mutation-inventory.contract-table.md`
(`plan.md:1345`), więc `parseMutationInventoryRoutes` zwraca `POST /files` i `DELETE /files`. Obie dostają
`coverage: 'check', wiring: 'planned'`. W Batchu 3 plan faktycznie włącza `MutationFeedback` w `pliki.js`
(`plan.md:1775–1805`), ale **nie** dodaje tych tras do `mutationFeedbackWiredRoutes` — test „all canonical write
routes are wired by batch five” nadal widzi je jako `planned` i root `npm test` pada. (Analogicznie jak w rundzie
Codeksa finding #1/#5: bramka root-testowa łapie lukę, której plan nie domyka.)

**Rekomendacja:** w Batchu 3 dodać `'POST /files'` i `'DELETE /files'` do `mutationFeedbackWiredRoutes` w
`scripts/mutation-feedback-coverage.registry.ts` (i objąć ten plik `git add`).

### 6. [średnie] Timeout fetch-u tytułu pozostaje nietestowany (i nieiniekcyjny)

> `design.md:165`: „Timeout ok. 4s”.
> `plan.md:289–294` (files.test.ts): testy obejmują sukces, host spoza listy, brak/pusty `<title>`, redirecty,
> oversized chunk, zły `Content-Type`, niedozwolony schemat — **brak testu timeoutu**.
> Runda Codeksa (finding #10) wprost: „Brakuje ... obiecanego testu timeoutu”.

`TITLE_FETCH_TIMEOUT_MS = 4000` jest hardkodowaną stałą (`plan.md:635`), a `AbortController`/`setTimeout` są
tworzone lokalnie w `detectDocTypeAndFetchTitle` (`plan.md:745–746`) bez punktu wstrzyknięcia zegara. Test timeoutu
wymagałby albo mock-timerów `node:test`, albo (prościej) uczynienia timeoutu parametrem `dependencies`. Poprawka z
rundy Codeksa domknęła pozostałe luki z finding #10 (oversized chunk, pusty title, content-type), ale timeout
wciąż nie ma pokrycia. **Rekomendacja:** dodać test timeoutu przez wstrzyknięcie krótkiego timeoutu (np. opcjonalny
argument `timeoutMs` w `detectDocTypeAndFetchTitle`) i mock `fetch` wieszający się do czasu `abort`.

---

## Podział na 3 batche po poprawkach

- **Batch 1 (firestore + files.ts):** samowystarczalny. Dodane testy `firestore.test.ts` (deleteDoc, kolizja
  delete/create, rollback) i `files.test.ts` kompilują się względem `node:test`, `createInMemoryFirestoreClient`,
  `runTransaction`. Zmiana `createDoc`/`setDoc` w double jest addytywna (gałęzie aktywne tylko przy `pendingDeletes`),
  więc nie łamie istniejących testów. ✓
- **Batch 2 (API + audyt + inwentarz):** **nie przechodzi** — finding #3 (`audit.test.ts` twarda lista kategorii)
  czerwieni `npm test` upload-service. Test „concurrent DELETE” (finding #1) jest mylący.
- **Batch 3 (frontend + PWA):** **nie przechodzi** — findings #4 i #5 czerwienią root `npm test`, a finding #2
  psuje deep-link kategorii. Po ich naprawieniu granice batchy są sensowne: Batch 2 dostarcza cały kontrakt API
  (w tym `mutation-inventory` w tym samym commicie, zgodnie z bramką `mutation-inventory.test.ts`), Batch 3 — całą
  warstwę frontend + rejestry pokrycia.

---

## Sprawdzone i zgodne (nie wymagają zmian)

- `AUDITED_MEMBER_MUTATION_ROUTES` (`server.ts:194–216`) i `executeDeclaredAuditedMutation` (`server.ts:225–252`)
  — dokładne sygnatury zgodne z planem; `auditedRoute()` + `as const`; `executeDeclaredAuditedMutation` nie jest
  eksportowana (plan to poprawnie odnotowuje). Dodanie `filesAdd`/`filesDelete` po `yearFee` jest spójne.
- `MutationFeedback.confirmed({ execute, apply, refreshFragment, control, anchor, rollback, shouldShowCheck, viewRoot })`
  (`public/mutation-feedback.js:86–120`) — plan używa `execute/apply/refreshFragment/control/viewRoot`, wszystkie
  istnieją.
- `GATED_PATH_PREFIXES`/`isPwaExcludedPath`/`classifyPwaPage` (`scripts/pwa-policy.ts:47–78`, `scripts/inject-pwa.ts:6–11`)
  — `/pliki/` faktycznie musi tam trafić; `pwa-policy.test.ts` używa asercji per-ścieżka (nie twardej listy), więc
  dodanie `/pliki/` go nie łamie.
- `deleteDoc` w obu interfejsach i obu implementacjach (`firestore.ts:45–85, 94–131, 135–260`) — plan wiernie
  opisuje miejsca wstawienia i semantykę `pendingDeletes`; kolizja `createDoc` naprawiona poprawnie.
- Konwencje testowe: `makeDeps`/`withServer`/`fakeSessionClaims` (`server.test.ts:145–203`), `createInMemoryFirestoreClient`
  + `.seed` (`firestore.ts:135–216`), `readJsonBody`/`sendJson`/`optionalTrimmedString`/`AuthError` (`server.ts:553–581,
  1771–1781`) — wszystkie sygnatury zgodne z użyciem w planie.
- Kontrakt URL-a https-only + no-credentials i whitelist hostów + `redirect: 'manual'` — logicznie spójne i
  testowane; `parseAllowedUrl` odrzuca `javascript:`/`data:`/`file:`/`http:`/credentials (finding #3 Codeksa domknięty).
- Regex `mutation-inventory.test.ts` (`:82`) i `mutation-feedback-coverage.registry.ts` (`:85`) poprawnie parsują
  wiersz `POST/DELETE \`/files\`` (rozbijają na dwie trasy).
- Precedens `handleListaWyjazdowaDeleteProfilePhoto` (`server.ts:2052–2076`) faktycznie czyta stan przed transakcją —
  cytat w `design.md:81–90` jest wierny (ale to nie daje gwarancji 404, patrz finding #1).
- Stale `LIVE_CONTRACT_PATH` w `mutation-inventory.test.ts:145–146` (`2-InProgress/...`) — folder istry jest już w
  `4-Done/`, więc drift-check po cichu skipsuje; plan poprawnie to identyfikuje i zakresuje poza story (pre-existing).

## Poza zakresem (świadomie nie flaguję)

- Walidacja „czy URL prowadzi do pliku”, edycja wpisu, prawdziwa paginacja — jawnie poza zakresem (`design.md:307–317`).
- Brak step-up na `DELETE /files` (zwykły `deps.authenticate`) — niższa stawka niż usuwanie galerii; decyzja
  produktowa, nie błąd bezpieczeństwa.
- `GET /files` robi pełny `listDocs` + sort w procesie przed `slice(0, 500)` — twardy limit dotyczy odpowiedzi,
  nie odczytu; akceptowalne przy skali klubu (odnotowane w designie jako świadomy brak paginacji).
- POST/DELETE z frontu bez `Content-Type: application/json` (domyślne `text/plain`) — działa, bo `readJsonBody`
  nie sprawdza Content-Type; zgodne z istniejącą konwencją (`auth.js:88–102`).

---

Review completed by OpenCode/DeepSeek (runda 2)
