# Krucze Galery

Galeria albumów Google Photos dla Bractwa Wojowników Kruki.  
Strona dostępna pod adresem: **https://bractwowojownikowkruki.github.io/krucze-galery/**

---

## Jak dodać album

Nie trzeba instalować niczego. Potrzebne jest tylko **konto na GitHubie** (rejestracja bezpłatna na https://github.com).

### Krok 1 — Otwórz plik `albums.txt`

Przejdź do:  
**https://github.com/BractwoWojownikowKruki/krucze-galery/blob/main/albums.txt**

### Krok 2 — Kliknij ikonę ołówka ✏️

W prawym górnym rogu widoku pliku kliknij ikonę ołówka („Edit this file").

GitHub wyświetli komunikat: *„You're editing a file in a project you don't have write access to"* — to normalne. GitHub automatycznie utworzy kopię repozytorium na Twoim koncie (tzw. fork).

### Krok 3 — Dodaj URL albumu

Na końcu pliku dopisz link do udostępnionego albumu Google Photos:

```
https://photos.app.goo.gl/XYZ
```

Nazwa i data zostaną pobrane automatycznie z tytułu albumu w Google Photos.

#### Własna nazwa (opcjonalnie)

Jeśli chcesz nadać albumowi inną nazwę niż w Google Photos, dopisz ją po pionowej kresce `|`:

```
https://photos.app.goo.gl/XYZ | 2024-08-03 Wolin
```

Przydatne gdy:
- tytuł albumu w Google Photos jest nieczytelny lub pusty
- album obejmuje kilka dni: `2024-08-03-05 Wolin` (sortuje po 3 sie, wyświetla „Wolin")

#### Komentarz (opcjonalnie)

Aby dodać notatkę do linku, która nie trafi na stronę, dopisz ją po podwójnej pionowej kresce `||`:

```
https://photos.app.goo.gl/XYZ | 2024-08-03 Wolin || nieaktualny, poprosić o nowy link
```

Wszystko po `||` jest ignorowane. Pojedyncza kreska `|` nadal służy tylko do własnej nazwy.

### Krok 4 — Wyślij propozycję zmiany

Kliknij zielony przycisk **„Propose changes"**, a następnie **„Create pull request"**.

Właściciel galerii otrzyma powiadomienie, przejrzy zmianę i zatwierdzi ją. Po zatwierdzeniu album pojawi się na stronie automatycznie (synchronizacja trwa ok. 1–2 minut).

---

## Format nazwy albumu

Data jest wykrywana automatycznie i służy do sortowania. Obsługiwane formaty:

| Format w nazwie | Przykład |
|---|---|
| `YYYY-MM-DD` | `2024-08-03 Wolin` |
| `YYYY.MM.DD` | `2024.08.03 Wolin` |
| `YYYY/MM/DD` | `2024/08/03 Wolin` |
| `YYYY-MM` (sam miesiąc) | `2024-08 Obozy letnie` |
| `YYYY.MM` | `Radzim 2025.05` |
| Data na końcu tytułu | `Wolin 2024-08-03` |
| Zakres dni | `2024-08-03-05 Wolin` |
| Zakres dni `DD-DD.MM.YYYY` | `12-14.06.2026` |

---

*Strona stworzona przez [CardioCanWait](https://www.cardiocanwait.com) dla Bractwa Wojowników Kruki.*
