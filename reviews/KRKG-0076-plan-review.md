# KRKG-0076 — recenzja planu przed implementacją

## Werdykt

Przeczytano `design.md` i `plan.md` ze story oraz aktualny backend i frontend. To jest recenzja planu, nie commita.

**Plan wymaga korekty przed rozpoczęciem batcha 1.** Architektura kolekcji Firestore, transakcyjnego delete i audytu Firestore jest zgodna z kierunkiem repo, ale obecna wersja nie przejdzie wszystkich bramek i otwiera XSS/SSRF.

## Findings

### 1. [blokujące] Nowe trasy mutujące nie są wpisane do inwentarza mutacji

> Plan, 925–938: dodaje `POST /files` i `DELETE /files` do dispatchu.
>
> Plan, 950–953: batch 2 commituj tylko `audit.ts`, `audit.test.ts`, `server.ts` i `server.test.ts`.
>
> Kod: `upload-service/src/mutation-inventory.test.ts:94–112` wymaga wpisu dla każdej uwierzytelnionej trasy mutującej; fixture jest w `upload-service/src/mutation-inventory.contract-table.md:25–39`.

Po dodaniu obu tras `npm test` batcha 2 zakończy się błędem pokrycia. Plan nie aktualizuje wersji inwentarza w repo ani kanonicznej tabeli „Mutation inventory”, z którą lokalny test porównuje fixture, gdy tracker istnieje (`mutation-inventory.test.ts:170–194`).

**Rekomendacja:** dodać POST/DELETE `/files` jako `businessWrite` z akcjami audytu do kanonicznego kontraktu, zsynchronizować fixture, objąć oba pliki stagingiem i testem pokrycia.

### 2. [blokujące] Plan omija deklaratywny kontrakt tras audytowanych

> Plan, 879–896 i 908–920: wywołuje bezpośrednio `executeAuditedFirestoreMutation(...)`.
>
> Kod: `upload-service/src/server.ts:189–252` wymaga deskryptora i `executeDeclaredAuditedMutation`; obecne deskryptory są w `server.ts:194–218`.

Sygnatura `executeAuditedFirestoreMutation` jest poprawnie rozpoznana (`audit.ts:737–756`), ale plan omija repozytoryjną bramkę wiążącą metodę, ścieżkę i akcję przed zapisem.

**Rekomendacja:** dodać deskryptory POST i DELETE `/files` do `AUDITED_MEMBER_MUTATION_ROUTES`, użyć `executeDeclaredAuditedMutation` i przetestować deklarację akcji, nie tylko `ACTION_REGISTRY`.

### 3. [blokujące bezpieczeństwo] „Dowolny syntaktycznie poprawny URL” daje stored XSS

> Design, 74–79: akceptuje dowolny URL.
>
> Plan, 870–876: waliduje tylko `new URL(rawUrl)`.
>
> Plan, 1176: renderuje `<a href="${escapeHtml(file.url)}" ...>`.

`new URL()` akceptuje `javascript:` i `data:`. Escapowanie HTML nie neutralizuje schematu `href`; kliknięcie takiego wpisu może wykonać skrypt w kontekście strony członka.

**Rekomendacja:** zmienić kontrakt na `https:` (ewentualnie świadomie `http:`), bez username/password, i odrzucać inne protokoły po parsowaniu. Frontend powinien defensywnie nie tworzyć linku dla niedozwolonego schematu. Dodać testy `javascript:`, `data:`, `file:` i URL z poświadczeniami.

### 4. [blokujące bezpieczeństwo] Whitelist hostów nie jest egzekwowana po redirectach

> Plan, 402–417: whitelistę opisuje jako ochronę przed SSRF.
>
> Plan, 448: używa `fetch(url, { signal })` bez polityki redirectów.

Fetch domyślnie podąża za redirectami. Zwłaszcza `1drv.ms` jest skracaczem, więc żądanie może wyjść poza zweryfikowany host; przeczy to ograniczeniu z planu 33–35. Plan dopuszcza też HTTP i dowolny port rozpoznanego hosta.

**Rekomendacja:** wymagać HTTPS i standardowego portu. Użyć `redirect: 'manual'` albo małej ograniczonej pętli redirectów, która na każdym `Location` ponownie sprawdza HTTPS, port i tę samą whitelistę. Testować redirect do nie-dozwolonego hosta, HTTP i custom port.

### 5. [blokujące] Batch 3 nie sklasyfikuje strony PWA i root build się zatrzyma

> Plan, 1022–1027: tworzy `public/pliki/index.html`, ale nie zmienia `scripts/pwa-policy.ts` ani testu.
>
> Kod: `scripts/inject-pwa.ts:5–10, 33–41` odwiedza każdy HTML i rzuca `Unclassified PWA document` dla ścieżki niepublicznej i niegated.
>
> Kod: `scripts/pwa-policy.ts:46–78` ma zamknięte `GATED_PATH_PREFIXES`.

`/pliki/` nie należy do obecnych list. `npm run build` batcha 3 nie przejdzie, choć `npx serve public` tego nie wykryje.

**Rekomendacja:** w batchu 3 dodać `/pliki/` do `GATED_PATH_PREFIXES` i asercję w `scripts/pwa-policy.test.ts`; wymagane są root `npm test` oraz `npm run build`, nie sama weryfikacja manualna.

### 6. [wysokie] Link Historia nie filtruje kategorii, a shared audit view nie zna `files`

> Design, 117–120 i plan, 36–39: link ma filtrować centralną Historię do `files`.
>
> Plan, 1090: ustawia `href="/audyt/?resourceKey="`.
>
> Kod: `public/audyt/audyt.js:26–30` przekazuje wyłącznie `resourceKey`; `public/shared/audit-view.js:218–233, 561–570` obsługuje initial filter tylko dla resourceKey.

Pusty `resourceKey` daje globalny domyślnie ograniczony datą widok, nie historię plików. `audit-view.js:54–168` nie ma ponadto etykiet, member-visible kategorii ani mapy akcji dla `files`, więc wpisy nie będą właściwie filtrowalne/opisane w UI.

**Rekomendacja:** zaplanować zmianę `audit-view.js` i jego testów: `files`, etykiety obu akcji oraz initial category filter; potem użyć `/audyt/?category=files` i ustawić filtr przed pierwszym fetch.

### 7. [wysokie] Batch 3 omija mechanizm potwierdzonej mutacji

> Plan, 1218–1225 i 1230–1235: POST/DELETE wykonują `apiFetch`, potem `loadFiles()`, bez `MutationFeedback.confirmed`.
>
> Kod: `public/mutation-feedback.js:86–119` pokazuje sukces dopiero po `execute` i lokalnym `apply`.

Plan nie ładuje też `mutation-feedback.js`. POST nie daje potwierdzenia po lokalnym zastosowaniu wyniku, a błąd DELETE jest nieobsłużonym odrzuceniem.

**Rekomendacja:** włączyć skrypt i użyć `MutationFeedback.confirmed` dla obu write routes z `apply`/`refreshFragment`, trwałą kotwicą i wpisami w rejestrze pokrycia mutation feedback; przetestować sukces, błąd mutacji i błąd odświeżenia.

### 8. [wysokie] Testy deleteDoc nie pokrywają zmienianej semantyki buforowania

> Plan, 181–213: delete kasuje pending write, set/create kasują pending delete, a commit wykonuje deletes przed writes.
>
> Plan, 83–109: testuje tylko top-level delete, rollback i pojedynczy commit.
>
> Kod: `upload-service/src/firestore.ts:217–252` deklaruje model commit-on-success.

Sama kolejność jest rozsądna dla delete-then-write, lecz plan nie testuje write-then-delete, delete-then-set, delete-then-create i rollbacku tych sekwencji. Co ważniejsze, proponowane `createDoc` nadal sprawdza stan mapy przed uwzględnieniem `pendingDeletes` (plan 200; obecny kod `firestore.ts:240–245`), więc `deleteDoc(existing); createDoc(same id)` rzuci kolizję mimo obietnicy „delete-then-recreate behaves sanely”.

**Rekomendacja:** wybrać i udokumentować semantykę zgodną z Firestore. Jeśli recreate ma działać, uwzględnić pending delete przy collision check; jeśli nie, nie kasować pending delete w create i usunąć obietnicę z planu. Dodać wymienione testy oraz delete nieistniejącego dokumentu.

### 9. [średnie] DELETE ma wyścig i niepełny before-state w audycie

> Plan, 904–919: odczytuje/autoryzuje poza transakcją, potem kasuje bez `tx.getDoc`; audit delete zawiera tylko name i URL.
>
> Design, 111–114: `filesFields` obejmuje także description i docType.

Równoległe DELETE może zostawić audyt usunięcia dokumentu, który już nie istniał, a zapis dowodowy nie zachowuje całej usuwanej treści.

**Rekomendacja:** audit-input factory powinna odczytać plik przez `tx`, zwrócić 404 gdy zniknął, ponownie sprawdzić własność i przed delete zapisać `before` dla name, url, description oraz docType. Dodać test równoległych DELETE i eventu.

### 10. [średnie] Fetch title ma luki odporności i brakujące testy

> Plan, 399–400: timeout 4 s oraz limit 200 000 B.
>
> Plan, 454–463: dołącza cały chunk, a następnie ocenia limit; `cleanTitle` może zwrócić pusty string.

Pojedynczy duży chunk przekracza limit zanim zostanie odrzucony. Brakuje kontroli `Content-Type`/`Content-Length` i obiecanego testu timeoutu (design 154–156). Pusty title daje `name: ''`, bo `title ?? fallback` nie stosuje fallbacku dla pustego stringa.

**Rekomendacja:** ograniczyć czytanie do pozostałego limitu, odrzucać za duży Content-Length i nietekstowy content type, normalizować pusty title do `null`. Dodać test timeoutu, zbyt dużego chunku, pustego title, content type i suffixów o różnych wielkościach liter.

### 11. [średnie] Kontrakt listy i requestu potrzebuje domknięcia

> Plan, 496–499: pełny scan `sharedFiles` i sortowanie w procesie.
>
> Plan, 869–877: ogranicza body, ale DELETE przyjmuje dowolne niepuste id.
>
> Plan, 1253–1258: zakłada, że `apiFetch` ustawia Content-Type.
>
> Kod: `public/auth.js:88–101` ustawia tylko `credentials: 'include'`.

GET i odpowiedź są nieograniczone wraz ze wzrostem kolekcji. ID generowane przez UUID należy walidować (co najmniej format/długość). POST działa, ponieważ `readJsonBody` nie sprawdza Content-Type (`server.ts:570–580`), ale plan opisuje API błędnie.

**Rekomendacja:** zdefiniować limit/paginację (najlepiej `addedAt` plus cursor), walidować UUID i jawnie dodać `Content-Type: application/json`; przetestować długości URL/opisu i błędne ID.

## Sprawdzone zgodne założenia

- `FirestoreTransaction` jest argumentem mutacji audytowanej (`audit.ts:737–753`), więc `deleteDoc` w obu interfejsach jest właściwym kierunkiem.
- Rzeczywisty klient powinien użyć `DocumentReference.delete()` i `transaction.delete()`; double już buforuje writes do sukcesu (`firestore.ts:115–130, 217–259`).
- `getGrantedRoles` normalizuje e-mail, a `satisfiesRole(..., 'moderator')` obejmuje moderatora i admina (`roles.ts:46–49, 64–69`), więc serwerowe `canDelete` jest poprawne.
- `readJsonBody`, `sendJson`, `requireTrimmedString`, `optionalTrimmedString` istnieją w `server.ts`; `apiFetch(path, options, showReauthUI, hideReauthUI)` istnieje w `public/auth.js`. Trzeba tylko skorygować założenie o headerach.

## Zalecany podział po korekcie

1. Data layer: deleteDoc z ustaloną semantyką double oraz bezpieczny URL/title-fetch; pełne testy i typecheck upload-service.
2. API/audyt: registry, deskryptory, kanoniczny inwentarz, audytowy before-state oraz testy permission/race; pełne testy i typecheck.
3. Frontend/integracja: `/pliki`, centralny audit view/deep-link, MutationFeedback i PWA classification/test; upload-service tests, root `npm test`, root `npm run build`, potem preview.

Wtedy każdy batch będzie kompilowalny i testowalny osobno. W aktualnym planie batch 2 nie przejdzie `npm test`, a batch 3 root build.
