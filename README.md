# Bractwo Wojowników Kruki — strona główna

Główna strona Bractwa Wojowników Kruki, wraz z sekcją galerii albumów (Google Photos i Google
Drive) oraz panelem administracyjnym sekcji "O nas".  
Strona dostępna pod adresem: **https://bractwowojownikowkruki.github.io/**
Galerie: **https://bractwowojownikowkruki.github.io/galerie/**

## PWA

Publiczne strony można zainstalować jako aplikację PWA. Jej cache offline zawiera wyłącznie mały, jawnie wskazany shell; nie zapisuje galerii, miniatur, zdjęć z mediów społecznościowych, uploadów, danych członków ani odpowiedzi z usług zewnętrznych. Strony członkowskie (`/admin/`, `/galerie/`, `/logowanie/`, `/wojownicy/wrzuc/`) nie są obsługiwane offline.

Na GitHub Pages cache ma identyfikator oparty o standardowe `GITHUB_SHA`; lokalny build używa deterministycznego hasha zawartości shella. Na publicznej stronie użyj przycisku **Zainstaluj** w Strefie Członków. Chrome i Edge pokażą natywny dialog tylko wtedy, gdy przeglądarka go udostępni. W iOS/iPadOS Safari wybierz **Udostępnij → Dodaj do ekranu początkowego**. Po zainstalowaniu aplikacji kontrolka instalacji jest ukryta. W Firefox weryfikuj nawigację i stronę offline, bez oczekiwania desktopowego przycisku instalacji. W Chrome DevTools lub Safari Web Inspector sprawdź Cache Storage: powinny występować tylko elementy shella, bez plików galerii, mediów społecznościowych i innych dużych zasobów.

---

## Jak dodać album

Wypełnij formularz: **https://bractwowojownikowkruki.github.io/galerie/dodaj-galerie.html**

Podaj link do udostępnionego albumu Google Photos lub folderu Google Drive, opcjonalnie własną
nazwę (jeśli pominięta, użyty zostanie tytuł albumu/folderu), i datę. Po
kliknięciu „Prześlij" zostaniesz przeniesiony na GitHuba, gdzie potwierdzasz zgłoszenie
(wymagane jest konto na GitHubie — rejestracja bezpłatna na https://github.com). Administrator
przejrzy zgłoszenie i zatwierdzi je; album pojawi się na stronie automatycznie po zatwierdzeniu
(synchronizacja trwa ok. 1–2 minut).

### Przesyłanie zdjęć bezpośrednio (dla wybranych osób)

Jeśli Twoje konto Google jest na liście uprawnionych, po zalogowaniu się przyciskiem Google na
stronie „Dodaj galerię" pojawi się opcja „Prześlij pliki zamiast linku". Wybierz zdjęcia, podaj
nazwę i datę — album zostanie utworzony i opublikowany automatycznie, bez zatwierdzania przez
administratora.

### Edycja ręczna (dla osób technicznych)

Albumy są przechowywane w [`albums.json`](https://github.com/BractwoWojownikowKruki/bractwowojownikowkruki.github.io/blob/main/albums.json)
— tablicy obiektów `{ "url": "...", "nameOverride": "...", "dateOverride": "YYYY-MM-DD", "hiddenComment": "..." }`
(wszystkie pola poza `url` opcjonalne). Można edytować bezpośrednio przez GitHub (fork + PR),
podobnie jak każdy inny plik w repozytorium.

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
