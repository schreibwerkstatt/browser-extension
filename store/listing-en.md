# Store listing — English

Zweite Sprache des Eintrags. Im Dashboard unter „Store-Eintrag" die Sprache
`English` hinzufügen und diese Texte einsetzen. Die Angaben in den Tabs
„Datenschutzpraktiken" und „Vertrieb" gelten sprachunabhängig — die stehen nur
in [listing-de.md](listing-de.md).

---

## Name (max. 75 characters)

```
Schreibwerkstatt – Capture
```

> From `_locales/en/messages.json` → `ext_name`.

## Summary (max. 132 characters)

```
Send web pages to your Schreibwerkstatt as a research find or a citable source.
```

> 78 characters. From `_locales/en/messages.json` → `ext_description`.

## Detailed description (max. 16,000 characters)

```
Schreibwerkstatt – Capture is the browser companion for your self-hosted Schreibwerkstatt writing app. It sends the page you are reading there in one click — either as a research find on a book's knowledge board, or as a citable source in your bibliography.

IMPORTANT: This is a companion extension. It requires your own Schreibwerkstatt installation and a device token from it. Without both, it does nothing. There is no bundled service and no default server.

── WHAT IT DOES ───────────────────────────

Capture a page (toolbar click or Alt+Shift+S)
The form arrives pre-filled: title, authors, journal, publisher, year, DOI, ISBN, URL, access date and the body text. Above the book selector you can see where every field came from — publisher-supplied citation_* metadata is attested, an OpenGraph title is a guess. Correct it, pick a target (research / source / both), send.

Capture a quote (select text, right-click, or Alt+Shift+Q)
The wording is preserved exactly: no trimming, no smoothed line breaks, no normalised quotation marks. An undo button then stays up for 6 seconds; press it and no server record is ever created.

Fetch canonical metadata
If the page carries a DOI or ISBN, your server can fetch the vetted record from Crossref or OpenLibrary and replace the harvested values. The lookup runs server-side — your browser never talks to those services directly.

Attachments
Optionally include the visible tab area as a screenshot. If the page declares a citation_pdf_url on the same host, the PDF too.

A queue that loses nothing
If your server is unreachable, the capture goes into a retry queue with exponential backoff and is sent later. Nothing is ever dropped silently; failed items are shown on the toolbar icon.

Bilingual
German and English interface, following your browser language.

── PRIVACY ────────────────────────────────

Data goes only to the host you enter in the options yourself. Nowhere else.

No analytics. No telemetry. No crash reporting. No CDN, no external fonts, no third-party script. No remotely loaded code. Apart from relative API paths, the extension contains no hardcoded address at all.

No browsing history: there is no history and no tabs permission. The extension never learns which pages you visit.

No background activity: there is no persistent content script. The harvesting script is injected via activeTab at the exact moment you click.

No host permission granted up front: the manifest contains no <all_urls>. During setup the extension requests exactly one origin — that of your own installation.

The device token lives in chrome.storage.local, deliberately not in storage.sync, so it is not replicated to other machines through your Google account.

Uninstalling erases everything stored locally.

── OPEN SOURCE ────────────────────────────

MIT licensed. The shipped code is neither minified nor obfuscated; you can unpack the package and compare it line by line with the repository.

Source: https://github.com/schreibwerkstatt/browser-extension
```

> Repository-URL ist eingesetzt, das Repository ist öffentlich.

## Category

Die Kategorie wird nur einmal gesetzt, nicht je Sprache:
`Tools` primär, `Workflow & Planning` sekundär.

## Screenshots

Dieselben Bilder wie im deutschen Eintrag hochladen, sofern die Beschriftung im
Bild englisch ist. Andernfalls einen zweiten Satz mit `--lang=en-US`-Profil
aufnehmen (siehe [PUBLISHING.md](PUBLISHING.md#5-screenshots-aufnehmen)) — die
Erweiterung folgt der Browsersprache, du bekommst also ohne Zusatzaufwand eine
englische Oberfläche.
