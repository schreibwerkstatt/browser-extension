# Schreibwerkstatt – Browser-Erweiterung

Chrome-Erweiterung (Manifest V3), mit der du beim Surfen Webseiten erfasst und in
deine selbst gehostete Schreib-App „Schreibwerkstatt“ schickst — entweder als
**Recherche-Fundstück** auf dem Wissensboard eines Buchs oder als **zitierfähige
Quelle** in deiner Literaturbibliothek.

Die Server-App wird nicht in diesem Repository entwickelt. Die Erweiterung spricht
ausschließlich deren REST-JSON-API an, unter der Adresse, die du selbst einträgst.

---

## Inhalt

- [Einrichtung](#einrichtung)
- [Benutzung](#benutzung)
- [Berechtigungen und ihre Begründung](#berechtigungen-und-ihre-begründung)
- [Datenschutz: was verlässt den Browser, was nicht](#datenschutz-was-verlässt-den-browser-was-nicht)
- [Entwicklung](#entwicklung)
- [Aufbau](#aufbau)
- [Verhalten im Detail](#verhalten-im-detail)
- [Getroffene Annahmen](#getroffene-annahmen)
- [Drittcode und Lizenzen](#drittcode-und-lizenzen)
- [Veröffentlichen](#veröffentlichen)

---

## Einrichtung

### 1. Erweiterung bauen und laden

```bash
npm install
npm run build
```

Danach in Chrome:

1. `chrome://extensions` öffnen
2. **Entwicklermodus** oben rechts einschalten
3. **Entpackte Erweiterung laden** → den Ordner `dist/` wählen

`dist/` ist unmittelbar ladbar; es wird nichts nachgeladen und nichts minifiziert.

### 2. Geräte-Token erzeugen

In der Web-App der Schreibwerkstatt:

**Einstellungen → Geräte → Neues Gerät** → als Art **Erfassung** (`capture`) wählen
→ Token kopieren. Der Klartext wird genau einmal angezeigt.

Das Token beginnt mit `swd_` und trägt die Scopes `content:read,capture:write`.
Damit darf es genau das, was diese Erweiterung tut: Bücher lesen, Fundstücke und
Quellen anlegen, Anhänge hochladen. Alles andere — Manuskripttext, `/me/*`,
`/admin/*`, jedes `DELETE` — beantwortet der Server mit `403
DEVICE_SCOPE_FORBIDDEN`.

Die Einschränkung ist der Punkt: die Erweiterung lebt in fremden Tabs, und ein dort
entwendetes Token darf nicht am Buch schreiben können. Ein Token der Art **Gerät**
(`device`, für die macOS- und Android-Clients) funktioniert hier zwar auch, gibt
aber unnötig viel Recht in einen Browser-Tab.

### 3. Erweiterung verbinden

Die Options-Seite öffnen (Rechtsklick auf das Symbol → *Optionen*, oder das
Zahnrad im Popup) und der Reihe nach:

1. **Server-Adresse** eintragen, z. B. `https://schreibwerkstatt.example.com`
   (ein Unterpfad hinter einem Reverse-Proxy funktioniert ebenfalls).
2. **Token** einfügen und **Speichern**.
3. **Zugriff auf diesen Host erlauben** klicken. Chrome fragt jetzt nach der
   Host-Berechtigung für genau dieses eine Origin. Ohne sie kann nichts gesendet
   werden — siehe [Berechtigungen](#berechtigungen-und-ihre-begründung).
4. **Verbindung testen**. Das lädt deine Bücher und prüft nebenbei, welche
   Endpunkte dein Server schon kennt.
5. **Standardbuch** wählen. Dorthin gehen Zitate aus dem Kontextmenü.

---

## Benutzung

### Popup — Seite erfassen

Symbolklick oder <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>. Das Formular ist
bereits aus der Seite ausgefüllt: Titel, Autor:innen, Zeitschrift, Jahr, DOI, URL,
Abrufdatum und der Haupttext. Über der Buchauswahl steht, **woher** die Angaben
stammen — `citation_*`-Metadaten sind verlagsseitig belegt, ein OpenGraph-Titel ist
geraten. Korrigieren, Ziel wählen (Recherche / Quelle / Beides), senden.

Trägt die Seite ein DOI, bietet das Popup **Kanonische Angaben holen** an. Das ruft
`GET /sources/lookup` auf und ersetzt die geernteten Werte durch die aus
Crossref/OpenLibrary. Nimm das, wann immer es angeboten wird.

### Kontextmenü — Zitat erfassen

Text markieren → Rechtsklick → **Als Zitat erfassen**. Kein Popup: das Zitat geht
mit dem Standardbuch und `kind: quote` direkt in die Recherche.

Der Wortlaut bleibt **exakt** erhalten — kein Trim, keine Normalisierung von
Anführungszeichen, keine Umbruchglättung. Dafür liest die Erweiterung die Auswahl
selbst aus der Seite statt Chromes `selectionText` zu nehmen, das kürzt und
Whitespace zusammenzieht.

Sofort danach erscheint ein Hinweis mit **Rückgängig**. Der Request geht erst nach
Ablauf des Undo-Fensters (Voreinstellung 6 Sekunden, in den Optionen einstellbar)
tatsächlich raus. Klickst du vorher auf Rückgängig, entsteht **gar kein**
Server-Eintrag. Das ist bewusst so gelöst, weil der API-Vertrag kein
`DELETE /research/:id` kennt.

Tastenkürzel für dasselbe: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Q</kbd>.

### Anhänge

- **Screenshot mitschicken** — der sichtbare Bereich des Tabs als JPEG, geht an
  `POST /research/:id/image` (max. 12 MB).
- **PDF mitschicken** — erscheint nur, wenn die Seite ein `citation_pdf_url`
  angibt. Liegt das PDF auf einem **anderen** Host als die Seite, ist die Option
  ausgegraut: dafür fehlt die Berechtigung, und `<all_urls>` gibt es hier nicht.
  Same-Origin-PDFs holt das Content-Script im Seitenkontext (max. 25 MB).

Anhänge werden **nicht** mit in die Warteschlange geschrieben: ein 25-MB-PDF wäre
als base64 rund 33 MB, `chrome.storage.local` fasst aber nur etwa 10 MB — ein
Überlauf würde den ganzen Auftrag mitreißen. Sie liegen stattdessen getrennt in
der IndexedDB der Erweiterung, bis ihr Auftrag gesendet oder verworfen ist. So
überstehen sie auch Wiederholungen, zwischen denen Chrome den Service Worker
beendet hat. Kann IndexedDB nicht schreiben (Kontingent, gesperrter Speicher),
bleibt der Anhang nur im Arbeitsspeicher. Geht er damit verloren, sagt die
Erweiterung das an jeder Stelle, an der sie sonst „gesichert“ meldet: am Eintrag
in der Warteschlange, in der Quittung im Popup **und** in der
Erfolgs-Benachrichtigung. Letztere ist der wichtigere Weg — ein Auftrag, der beim
späten Versuch gelingt, verlässt die Warteschlange, und mit ihm verschwände der
Vermerk. Der eigentliche Eintrag ist davon nie betroffen.

### Wenn etwas nicht durchgeht

Offline, Serverfehler oder Zeitüberschreitung: der Eintrag landet in einer
Warteschlange in `chrome.storage.local`, das Symbol zeigt die Anzahl, und die
Erweiterung versucht es mit wachsendem Abstand erneut (15 s, 1 min, 5 min, 30 min,
2 h, 6 h, danach alle 6 h, maximal 12 Versuche).

**Nichts wird stillschweigend verworfen.** Auch endgültig gescheiterte Einträge
bleiben in der Liste stehen, bis du sie in den Optionen ausdrücklich verwirfst.
Fehler, bei denen ein Wiederholen sinnlos ist — abgelaufenes Token, fehlender
Scope, abgelehnte Angaben — werden gar nicht erst wiederholt, sondern gemeldet.

Jede Fehlermeldung nennt den `error_code` in Klammern, damit du im Server-Log
danach suchen kannst.

---

## Berechtigungen und ihre Begründung

| Berechtigung | Wofür | Warum nicht weniger |
|---|---|---|
| `storage` | Server-Adresse, Token, Buchliste, Einstellungen, Warteschlange | Ohne lokalen Speicher müsstest du das Token bei jedem Klick neu eingeben; die Warteschlange muss einen Neustart des Browsers überleben. Ausdrücklich `local`, nicht `sync` — das Token ist ein Geheimnis und soll nicht über dein Google-Konto repliziert werden. |
| `activeTab` | Zugriff auf die Seite, die gerade offen ist, **im Moment deiner Aktion** | Die Alternative wäre eine Host-Berechtigung für alle Seiten. `activeTab` gewährt Zugriff nur auf den aktiven Tab und nur, nachdem du das Symbol, das Tastenkürzel oder das Kontextmenü benutzt hast — danach erlischt er wieder. |
| `scripting` | Injiziert das Ernte-Script per `chrome.scripting.executeScript` | Ein statisch registriertes Content-Script würde auf *jeder* Seite laufen, auch wenn du die Erweiterung nie benutzt. So läuft Code nur dort, wo du ihn auslöst. |
| `contextMenus` | Der Eintrag „Als Zitat erfassen“ bei markiertem Text | Der einzige Weg, ein Zitat ohne Popup-Umweg zu erfassen. Der Eintrag erscheint nur bei einer Textmarkierung. |
| `notifications` | Erfolgsmeldung und der **Rückgängig**-Knopf nach einem Zitat | Ohne Popup gibt es keine andere Fläche für die Rückmeldung — und ohne Knopf kein Undo. In den Optionen abschaltbar. |
| `alarms` | Weckt den Service Worker für die Retry-Warteschlange | Siehe Anmerkung unten. |

### Anmerkung zu `alarms`

Diese Berechtigung stand nicht in der ursprünglichen Anforderungsliste, ist für die
geforderte Retry-Warteschlange mit exponentiellem Backoff aber unumgänglich: ein
MV3-Service-Worker wird nach etwa 30 Sekunden Untätigkeit beendet, und ein
`setTimeout` hält ihn nicht am Leben. Ohne `alarms` würde ein Eintrag, der in zwei
Stunden erneut versucht werden soll, erst beim nächsten manuellen Klick weiterlaufen
— was der Zusage „nie stillschweigend verwerfen“ zwar nicht widerspricht, sie aber
praktisch aushöhlt.

`alarms` erzeugt keinen Netzverkehr und keine Datenerhebung; im
Berechtigungsdialog von Chrome wird sie dem Nutzer nicht einmal angezeigt.

### Host-Berechtigungen

Im Manifest steht **keine** feste `host_permissions` und insbesondere kein
`<all_urls>`. Stattdessen:

```json
"optional_host_permissions": [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://*.localhost/*"
]
```

Das ist eine *Erlaubnis zu fragen*, keine erteilte Berechtigung. Beim Einrichten
ruft die Options-Seite `chrome.permissions.request()` mit **genau einem** Muster auf
— dem Origin deiner Schreibwerkstatt, z. B. `https://schreibwerkstatt.example.com/*`.
Nur dieses Origin wird gewährt. Der Umweg ist nötig, weil der Host bei einer
selbst gehosteten App pro Nutzer verschieden ist und deshalb nicht im Manifest
stehen kann.

Die `http`-Muster sind bewusst auf localhost verengt: sie sind nur da, damit eine
lokale Entwicklungsinstanz (`http://localhost:3000`) funktioniert. Eine
`http`-Adresse außerhalb von localhost lehnt die Options-Seite ab statt sie zu
speichern — anfordern ließe sie sich ohnehin nicht, und ohne TLS ginge das Token
im Klartext über die Leitung. [test/manifest.test.js](test/manifest.test.js) hält
beide Seiten zusammen.

Diese Host-Berechtigung befreit den Service Worker außerdem von CORS. Deshalb — und
nur deshalb — laufen **alle** Netzwerkanfragen im Worker. Aus einem Content-Script
würde derselbe Request an denselben Server scheitern.

---

## Datenschutz: was verlässt den Browser, was nicht

### Was gesendet wird

Ausschließlich das, was du für einen einzelnen Erfassungsvorgang ausgelöst hast:

- Titel, Haupttext oder markiertes Zitat der Seite, die gerade offen ist
- ihre URL (tracking-bereinigt) und das Abrufdatum
- bibliografische Angaben, die auf der Seite stehen: Autor:innen, Zeitschrift,
  Verlag, Jahr, DOI, ISBN
- deine eigenen Eingaben: Schlagwörter, Notiz, Zitierschlüssel, Buchauswahl
- optional ein Screenshot des sichtbaren Bereichs oder ein PDF, aber nur wenn du
  das Häkchen setzt
- die Kopfzeilen `X-Client-Platform` (`chrome`), `X-Client-Device`
  (Browsername, -version und Betriebssystem, z. B. `Google Chrome 131 / Linux`)
  und `X-Client-Version` (Plattform und Version dieser Erweiterung, z. B.
  `chrome/1.1.1`)

### Wohin

**Nur an den Host, den du selbst in den Optionen eingetragen hast.** Sonst nirgends.

Kein Analytics, kein Telemetrie-Ping, kein Crash-Reporting, kein CDN, keine
Schriftarten von außen, kein Drittanbieter-Skript. Die Erweiterung enthält keine
einzige fest verdrahtete Adresse außer den relativen API-Pfaden.

Der DOI-/ISBN-Lookup geht ebenfalls an **deinen** Server (`GET /sources/lookup`);
er befragt Crossref und OpenLibrary serverseitig. Dein Browser spricht nie direkt
mit einem dieser Dienste.

### Was nicht gesendet und nicht einmal gelesen wird

- **Kein Browserverlauf.** Die Erweiterung hat keine `history`- und keine
  `tabs`-Berechtigung und erfährt nie, welche Seiten du besuchst.
- **Keine automatische Erfassung, kein Hintergrund-Crawling.** Der Service Worker
  wird ausschließlich durch deine Aktion oder durch eine fällige Wiederholung eines
  von dir erzeugten Eintrags aktiv.
- **Kein Zugriff auf Seiten, auf denen du nichts auslöst.** Es gibt kein
  dauerhaftes Content-Script. Das Ernte-Script wird per `activeTab` in dem Moment
  injiziert, in dem du klickst, und verschwindet mit dem nächsten Seitenwechsel.
- **Kein Lesen von Formularfeldern, Cookies oder `localStorage`** der besuchten
  Seite. Das Ernte-Script liest `<meta>`-Elemente, JSON-LD, den Seitentext und die
  aktuelle Textmarkierung — mehr nicht. Netzwerkanfragen macht es keine.

### Wo das Token liegt

In `chrome.storage.local`, unverschlüsselt (Chrome bietet Erweiterungen keinen
Schlüsselbund). Es ist bewusst **nicht** in `chrome.storage.sync`, damit es nicht
über dein Google-Konto auf andere Rechner wandert. Es wird nur im
`Authorization`-Header an den konfigurierten Host geschickt und nie geloggt.

Antwortet der Server mit `401 NOT_LOGGED_IN`, markiert die Erweiterung das Token
als ungültig, färbt das Symbol rot und verlinkt die Options-Seite. Es wird kein
stillschweigender Wiederholungsversuch unternommen.

### Datenlöschung

Erweiterung deinstallieren entfernt `chrome.storage.local` vollständig — Token,
Buchliste und Warteschlange inklusive. Bereits an den Server gesendete Einträge
verwaltest du in der Web-App.

---

## Entwicklung

```bash
npm install
npm run build      # dist/ erzeugen
npm run watch      # dist/ beobachten (statische Dateien nur beim Start kopiert)
npm test           # alle Tests, kein Server nötig
npm run typecheck  # JSDoc-Typen prüfen (tsc, erzeugt nichts)
npm run icons      # Symbole aus tools/make-icons.mjs neu erzeugen
npm run package    # store-fertiges ZIP unter store/ erzeugen
npm run promo      # Werbekacheln für den Store rendern (braucht Chrome)
npm run shots      # Store-Screenshots aufnehmen (SHOTS_TOKEN=… nötig)
npm run review-server   # Referenz-Server für die Store-Prüfung (REVIEW_TOKEN setzen)
npm run clean      # dist/ löschen
```

Voraussetzung: Node ≥ 22 (getestet mit 22 und 24).

### Tests

Alles läuft mit `node:test`, ohne Netz und ohne echten Server.

| Datei | Prüft |
|---|---|
| `test/harvest.test.js` | Metadaten-Ernte gegen zehn HTML-Fixtures: Wissenschaftsverlag mit `citation_*`, Nachrichtenseite mit JSON-LD im `@graph`, Blog nur mit OpenGraph, nackte Seite ohne Metadaten, Dublin Core, erfundener Wikipedia-Artikel, WordPress ohne SEO-Plugin, HubSpot-Blog mit `@id`-Verweisen, Tageszeitung mit SEO-Titel und Platzhalter-Autor, Magazin mit Entities im JSON-LD und CSS-Modul-Byline. Dazu das Abtrennen von Site-Namen am Titel. Prüft insbesondere die **Prioritätsreihenfolge** — dass `citation_title` gegen ein gleichzeitig vorhandenes `og:title` gewinnt. |
| `test/people.test.js` | Personen-Parsing: „Nachname, Vorname“, „Vorname Nachname“, Partikel (`van der Meer`), Versalien-Konvention, Titel, Suffixe, Körperschaften, Listen — und dass im Zweifel `{ literal }` herauskommt. |
| `test/url.test.js` | URL-Normalisierung, Tracking-Parameter, Server-URL, Origin-Muster. |
| `test/text.test.js` | Kürzen an Satzgrenzen, DOI-/ISBN-/Jahr-Extraktion, Datumsformate. |
| `test/errors.test.js` | Fehlercode → Text, Wiederholbarkeit, Auth-Erkennung. |
| `test/limits.test.js` | Clientseitige Prüfung gegen die Serverlimits. |
| `test/queue.test.js` | Backoff-Kurve, Undo-Fenster, Fortschrittserhalt, kein stilles Verwerfen. |
| `test/intent.test.js` | Erntedaten → Auftrag, Readability-Extraktion, Lookup-Übernahme, Wortlauttreue des Zitats. |
| `test/integration.test.js` | Vollständiger Ablauf gegen einen Mock-Server (`test/helpers/mock-server.js`), der den API-Vertrag nachbaut — inklusive 401-, 403-, 409- und 503-Pfaden, Fähigkeits-Erkennung und Wiederholung ohne Duplikate. |
| `test/i18n.test.js` | Beide Sprachdateien deckungsgleich und vollständig; keine hartcodierten Strings, keine Inline-Styles, keine externen Ressourcen im HTML. |

---

## Aufbau

```
src/
  manifest.json
  _locales/{de,en}/messages.json   UI-Sprachen, Voreinstellung Deutsch
  background/
    service-worker.js              Ereignisse, Nachrichten, Badge, Kontextmenü
    api-client.js                  REST-Client, Kopfzeilen, Fehlerabbildung
    capture-runner.js              Erfassungsablauf (beide Pfade)
    capabilities.js                Erkennung der noch nicht deployten Endpunkte
    queue.js                       Retry-Warteschlange
    state.js                       chrome.storage.local
  content/
    harvest.js                     injizierter Einstiegspunkt
    extract-meta.js                Metadaten-Ernte (rein, DOM-basiert)
    article-text.js                Haupttext via Readability
  popup/                           popup.html / .css / .js
  options/                         options.html / .css / .js
  shared/
    config.js  intent.js  limits.js  errors.js  backoff.js
    people.js  text.js  url.js  i18n.js  messages.js  ui.css
```

Vanilla JS als ESM, kein Framework. esbuild bündelt — nötig ist es nur wegen
Readability, aber es hält auch die Importpfade sauber. Kein TypeScript; die Typen
stehen als JSDoc-Annotationen im Code.

**Trennlinie:** alles unter `shared/` und `content/extract-meta.js` ist frei von
`chrome`-APIs und deshalb direkt testbar. `service-worker.js` ist die einzige
Datei, die Chrome-Ereignisse verdrahtet.

---

## Verhalten im Detail

### Prioritätsreihenfolge der Ernte

0. Seitenrezept für **MediaWiki** (Wikipedia und andere Wikis) — siehe unten
1. Highwire / `citation_*` — was Verlage und Google Scholar liefern
2. JSON-LD, `schema.org/Article` und Verwandte (auch im `@graph`)
3. Dublin Core
4. OpenGraph / `article:*`
5. Fallback: `<title>`, `<link rel=canonical>`, erstes `<h1>`, Autorenzeile und
   `<time datetime>` aus dem Markup (siehe unten)

Jedes Feld wird einzeln aufgelöst und merkt sich seine Herkunft; das Popup zeigt
sie an. Findet sich in keiner Schicht ein DOI, wird zusätzlich der Seitentext per
Regex durchsucht. Eine ISBN zählt im Seitentext nur mit vorangestelltem „ISBN“
und gültiger Prüfziffer — sonst wären Zeitstempel und Beitragsnummern Bücher,
und jede elfte zufällige Zahl hat eine gültige ISBN-10-Prüfziffer.

JSON-LD-Verweise per `@id` werden im `@graph` aufgelöst; Yoast (WordPress) und
HubSpot legen Autor, Verlag und Website nur so ab. Der Knoten `WebSite` liefert
den Namen der Website; ein `isPartOf`, das auf die eigene `WebPage` zeigt, ist
kein Container.

Titel aus OpenGraph und `<title>` verlieren einen angehängten Site-Namen
(„… – Abendpost“, „… | Kestrel Notes“), aber nur, wenn er sich belegen lässt:
der Rest gleicht der `<h1>`, oder das abgetrennte Stück gleicht `og:site_name`,
dem Verlag aus JSON-LD oder exakt einem Label des Hostnamens. Der Doppelpunkt
trennt nie — er leitet Untertitel ein.

Die `<h1>` ist der Titel, den Leser:innen sehen und zitieren. Sie gewinnt gegen
`og:title` und JSON-LD `headline`, wenn diese ihr die Dachzeile abschneiden
(„Breakpoint: …“) oder eine eigene SEO-Fassung nach demselben Stichwort vor dem
Doppelpunkt sind (nzz.ch: „Die Geschichte der Huthi: Von einer …“ gegen gedruckt
„Die Geschichte der Huthi: Wie aus einer …“). Teilt die `<h1>` nichts mit dem
Metadaten-Titel — oft ist sie das Logo —, bleibt er.

HTML-Entities in JSON-LD (`&ldquo;` bei hbr.org) werden dekodiert.

### Autor:innen bei Zeitungen und Magazinen

Aus jeder Schicht fallen heraus: Profil-URLs, Handles, E-Mail-Adressen, die
Zeitung als ihr eigener Autor („The Economist“ bei The Economist, der
anonym nach Hausstil schreibt) und Platzhalter im Plural („Auswärtige Autoren
NZZ“, „Contributors“, „Agenturen“). Bleibt nichts übrig, kommt die nächste
Schicht zum Zug — bei der NZZ `<meta name="author">`. Eine benannte Redaktion
(„Redaktion Beispiel-Zeitung“) bleibt als Körperschaft stehen.

Ein `isPartOf` vom Typ `Product` ist Googles Paywall-Markup, nicht die
Publikation, und macht keinen Beitrag zum Zeitschriftenartikel.

### Blogs ohne Autor in den Metadaten

WordPress ohne SEO-Plugin und viele HubSpot-Themes nennen die Autorin nur im
Beitragskopf. Die Fallback-Schicht liest dort gezielt markierte Stellen: den
Core-Block `.wp-block-post-author-name`, Microdata und Microformats
(`itemprop=author`, `.author.vcard`, `.h-entry .p-author`), klassische Themes
(`.byline .author`, `.entry-author`), HubSpot (`.blog-post__author-name`,
`.hs-author-name`), zuletzt jede Klasse, die auf `author-name` endet, Kinder auf
`…author` in einem Element auf `…byline` (CSS-Module, etwa hbr.org), und
`rel=author`. Kommentare, verwandte Beiträge, Karten, Seitenleisten und Fußzeilen
sind ausgenommen; Einleitungen wie „von“ und „Written by:“ fallen weg; Einträge
mit Ziffern oder URLs zählen nicht. Genauso das Datum aus `<time datetime>` im
Beitrag. Jede Meta-Angabe schlägt diese Schicht.

### Wikipedia und andere MediaWiki-Seiten

Erkannt am `<meta name="generator" content="MediaWiki …">` zusammen mit
`h1#firstHeading`. Die allgemeinen Metadaten führen dort nachweislich in die Irre,
deshalb gilt die Seitenstruktur:

| Feld | Quelle | statt |
|---|---|---|
| Titel | `h1#firstHeading` (auch kursive Anzeigetitel) | JSON-LD `headline` — das ist die Wikidata-Kurzbeschreibung |
| Jahr | JSON-LD `dateModified`, sonst `#footer-info-lastmod` — der Stand der gelesenen Fassung | `datePublished`, die Anlage des Artikels; ohne Stand bleibt das Jahr leer |
| Autor:innen | keine — Zitierstile setzen bei Wikipedia keinen Autor | „Autoren der Wikimedia-Projekte“ |
| Website/Container | Name aus dem `<title>` („Wikipedia“, „Wikipédia“) | — |
| DOI/ISBN | keine | Treffer aus der Literaturliste, die jeden Artikel zum Buch machten |
| Permalink | `#t-permalink` (`oldid=`), als `urls[]`-Eintrag `permalink` | — |

Als Quelle zählt weiter die kanonische Adresse, damit die Dublettenprüfung greift;
der Permalink hält fest, welche Fassung gelesen wurde.

### Personen

„Nachname, Vorname“ und „Vorname Nachname“ werden beide erkannt, ebenso Partikel
(`van der Meer`, `von Beethoven`, `de la Cruz`) und die Verlagskonvention
`MUSTER Max`. Bei Suffixen (`Jr.`, `PhD`), mehreren Kommas, Einzelnamen oder
Körperschaften (`Verlag AG`, `Universität …`, `The Guardian`) wird bewusst nicht
geraten, sondern `{ literal: "…" }` gesetzt — ein Literal fällt im
Literaturverzeichnis auf, ein vertauschter Vor- und Nachname nicht.

### URL-Normalisierung

Schema und Host klein, Standardports weg, bekannte Tracking-Parameter (`utm_*`,
`fbclid`, `gclid`, …) entfernt, restliche Parameter sortiert, Fragment verworfen
(außer `#!`-Routen), Zugangsdaten entfernt. Inhaltstragende Parameter wie `?id=42`
bleiben stehen.

### Zwei Wege zum Server

Ist `POST /capture` verfügbar, genügt **ein** Request. Sonst der dokumentierte
Fallback: `POST /research`, `POST /sources`, `POST /sources/:id/link` und die
Anhänge einzeln.

Beide Endpunkte — `POST /capture` und `GET /sources/by-url` — sind im Mutterprojekt
inzwischen vorhanden. Die Erkennung bleibt trotzdem: eine selbst gehostete Instanz
kann auf einem älteren Stand laufen, und dann muss der lange Weg greifen, statt dass
die Erfassung an einem `404` scheitert.

Die Erkennung nutzt aus, dass jede *Route* der App ihre Fehler als JSON
`{ error_code }` beantwortet, eine unbekannte Route bei Express dagegen als
HTML-Seite:

| Antwort auf die Probe | Schluss |
|---|---|
| `404`/`405` **ohne** JSON-Körper | Endpunkt fehlt |
| `4xx` **mit** `error_code` | Endpunkt ist da, nur die Probe war ungültig |
| `401`, `403`, `429` | keine Aussage — das entscheidet die Middleware vor dem Routing |
| `5xx`, Netzfehler | keine Aussage |

Zwei Fehlerantworten kommen allerdings **nicht** von einer Route, sondern vom
Body-Parser davor, und tragen deshalb keinen `error_code`: `413` bei zu großem
Körper und `400` bei syntaktisch kaputtem JSON. Beide sind HTML. Der Client darf
daran nicht zerbrechen — er liest die Antwort als Text, versucht `JSON.parse` und
fällt sonst auf den HTTP-Status zurück. Größen prüft er ohnehin vorher, damit die
Meldung „Datei zu groß“ lautet und nicht „Übertragung abgebrochen“.

Die `/capture`-Probe schickt einen **leeren** Body und muss deshalb mit `400`
abgewiesen werden; es entsteht kein Datensatz (ein Test prüft das). Geprobt wird
beim Verbindungstest und danach höchstens einmal täglich, jeweils im Rahmen einer
von dir ausgelösten Aktion. In den Optionen lässt sich der Befund pro Endpunkt
überschreiben.

Stellt sich beim Senden heraus, dass `/capture` doch fehlt, fällt derselbe Auftrag
sofort auf den langen Weg zurück und der Befund wird korrigiert.

### Duplikate

Ist `GET /sources/by-url` verfügbar, prüft das Popup vor dem Senden und meldet
„ist schon in deiner Bibliothek“ bzw. „ist schon in diesem Buch“. Auch beim
tatsächlichen Senden wird die vorhandene Quelle wiederverwendet und nur die
Verknüpfung zum Buch nachgezogen, statt eine zweite anzulegen.

### Wiederholung ohne Duplikate

Jeder Auftrag führt Buch darüber, welche Teilschritte schon beim Server angekommen
sind (`researchItemId`, `sourceId`, verknüpfte Bücher, Anhänge). Scheitert der
dritte von vier Requests, setzt der nächste Versuch genau dort fort. Ein
`409 CITEKEY_TAKEN` wird vertragsgemäß behandelt: derselbe Request geht ohne
`citekey` erneut raus, damit der Server einen vergibt.

### Grenzen, die clientseitig geprüft werden

Es sind drei Sorten Grenze, und sie verlangen unterschiedliches Verhalten.

**Textfelder kürzt der Server still** — er lehnt nicht ab, er schneidet ab und
antwortet `2xx`. Wer das nicht spiegelt, quittiert einen Text, der so nie
gespeichert wurde. Die Erweiterung kürzt deshalb vorher auf dieselben Längen und
zeigt es im Popup an:

| Feld | Grenze |
|---|---|
| Titel | 300 Zeichen |
| Text | 20 000 Zeichen |
| Herkunfts-URL (`source`) | 1 000 Zeichen |
| Schlagwörter | 60 Zeichen, 20 Stück |
| URLs | 20 Stück; Label 300 Zeichen |
| Anhang-Dateiname | 200 Zeichen |

**Adressen kürzt niemand.** Eine URL über 2 000 Zeichen oder ohne `http(s)`
weist der Server mit `400 INVALID_URL` ab — den ganzen Request, seit Vertrag
`api 6`. Eine abgeschnittene Adresse zeigt auf eine andere Seite; die Erweiterung
lehnt sie deshalb vorher sichtbar ab, statt sie zu kürzen.

**Ausnahme Wortlauttreue:** ein markiertes **Zitat** über 20 000 Zeichen wird nie
beschnitten, sondern sichtbar abgelehnt. Geernteter Haupttext dagegen wird an
einer Satzgrenze gekürzt und das im Popup vermerkt.

**Uploads und der JSON-Körper** laufen in den Body-Parser des Servers, und der
antwortet bei Überschreitung mit einem nackten `413` als HTML-Seite — ohne
`error_code`, aus dem sich eine Meldung bauen ließe. Die Erweiterung prüft deshalb
**vor** dem Request: Bild 12 MB, PDF 25 MB, JSON-Körper von `POST /capture`
256 kB. Sonst stünde dort „Übertragung abgebrochen“ statt „das PDF ist zu groß“.

---

## Getroffene Annahmen

Fünf Stellen des Vertrags waren nicht eindeutig oder haben sich geändert. Alle
sind gegen den Server geprüft; so steht es jetzt:

1. **`source` in `POST /research`** trägt die Herkunfts-URL als String
   (die normalisierte Fassung). Zusätzliche Links — kanonische URL, PDF — gehen
   in `urls: [{ url, label }]`. **Bestätigt:** das Feld ist serverseitig Freitext
   bis 1000 Zeichen und wird mitindexiert; eine URL darin ist vertragsgemäß.
2. **`book_id` in `POST /sources`** wird **nicht** mitgeschickt; die Verknüpfung
   erfolgt im eigenen `POST /sources/:id/link`. **Geklärt:** `POST /sources`
   nimmt ein `book_id` entgegen und verknüpft dann direkt. Der getrennte Weg
   bleibt trotzdem — er ist der Ablauf, den die Warteschlange schrittweise
   wiederaufnehmen kann, und er kostet nur auf dem Fallback-Pfad einen Request,
   den der Normalfall (`POST /capture`) ohnehin nicht geht.

3. **Die Dublettenprüfung sagt nie „nicht vorhanden“, wenn sie es nicht wissen
   kann.** Sie fragt `GET /research` nach dem Buch und vergleicht die URL gegen
   `urls[].url` der Antwort. Der Server liefert höchstens 200 Zeilen, und mit
   einem Suchbegriff schneidet sein FTS5-Vorfilter schon bei 500 Treffern ab —
   beides *bevor* sortiert und begrenzt wird. Kommt die Antwort randvoll zurück,
   meldet das Popup „nur die zuletzt geänderten Einträge geprüft“ statt
   Entwarnung. Ein *gefundener* Treffer ist dagegen immer belastbar.

4. **`POST /capture` nimmt keinen `citekey`.** Der dokumentierte Körper führt das
   Feld nicht auf — obwohl `409 CITEKEY_TAKEN` als Fehlercode dieses Endpunkts
   dasteht. **Geklärt:** der Endpunkt nimmt bewusst keinen; der Zitierschlüssel
   ist Sache der Autorin oder des Autors, und `409 CITEKEY_TAKEN` deckt dort nur
   den Wettlauf zweier gleichzeitiger Anfragen ab. Ein Auftrag mit eigenem
   Zitierschlüssel nimmt deshalb dauerhaft nicht den Ein-Request-Pfad, sondern
   den Fallback, wo `POST /sources` den `citekey` annimmt. Kein erfundenes Feld,
   kein stiller Verlust — ein Request mehr, und das bleibt so. Ist der Schlüssel
   dort schon vergeben, sendet die Erweiterung vertragsgemäß ohne ihn erneut und
   der Server vergibt einen eigenen; **auch das steht dann in der Quittung**,
   sonst wäre der Verlust an der letzten Stelle doch noch still geworden.

5. **Ein zweites Fundstück zur selben Seite ist gewollt.** `POST /research`
   antwortet seit Server v4.15.0 auf eine URL, die im Buch schon an einem
   Fundstück hängt, mit `409 DUPLICATE_URL`. Auf dem Fallback-Pfad sendet die
   Erweiterung dann **einmal** mit `allow_duplicate: true` nach — zwei Zitate aus
   derselben Seite sind zwei Funde, genau wie bei `POST /capture`, und das Popup
   hat vorher schon auf den Bestand hingewiesen. Das Feld geht nur im zweiten
   Anlauf mit, ein älterer Server bekommt es also nie zu sehen.

Die ersten beiden, die vierte und die fünfte stecken in `src/background/capture-runner.js`,
die dritte in `src/shared/duplicates.js`; alle sind mit Tests in
`test/integration.test.js` (und `test/duplicates.test.js`) festgenagelt — eine
Änderung ist an einer Stelle erledigt.

---

## Drittcode und Lizenzen

| Paket | Lizenz | Wofür |
|---|---|---|
| [`@mozilla/readability`](https://github.com/mozilla/readability) | **Apache-2.0** | Haupttext-Extraktion; wird beim Build eingebunden |
| `esbuild` | MIT | nur Build-Werkzeug, nicht ausgeliefert |
| `jsdom` | MIT | nur Test-Werkzeug, nicht ausgeliefert |

**Abweichung von der Vorgabe:** die Spezifikation nannte „MIT-Lizenz“ für den
Readability-Port. Mozillas Readability steht unter **Apache-2.0**. Einen
gleichwertigen MIT-lizenzierten Port gibt es nicht. Apache-2.0 ist ebenso permissiv
und für den Chrome Web Store unproblematisch; entscheidend ist, dass der Code
**lokal mitgeliefert** und nichts zur Laufzeit nachgeladen wird — das ist erfüllt.
Der Lizenzkopf bleibt im Bundle erhalten (`legalComments: 'inline'`).

Eigener Code: MIT, siehe [LICENSE](LICENSE). Die Lizenztexte des mitgelieferten Drittcodes
schreibt der Build nach `dist/THIRD_PARTY_LICENSES.txt`.

---

## Veröffentlichen

Alles für den Chrome Web Store liegt in [`store/`](store/):

```bash
npm run package    # store/schreibwerkstatt-chrome-<version>.zip
npm run promo      # store/assets/ — die beiden Werbekacheln
SHOTS_TOKEN=swd_… npm run shots   # store/assets/ — drei Screenshots in 1280×800
```

Die Anleitung mit allen paste-fertigen Formulartexten steht in
[store/PUBLISHING.md](store/PUBLISHING.md). Zwei Punkte betreffen ausgerechnet
diese Erweiterung und sollten vor dem Einreichen gelesen sein:

1. **Ohne Server und Token tut die Erweiterung nichts.** Ein Prüfer, der das
   nicht überbrücken kann, hat keinen Grund anzunehmen, dass sie funktioniert.
   Vorgesehener Weg: eine **Demo-Instanz** der Schreibwerkstatt mit geseedeten
   Büchern und Token, deren Werte in die Testanleitung wandern. Wichtig beim
   Seed: keine echten E-Mail-Adressen, denn `GET /content/books` gibt zu jedem
   Buch die `owner_email` heraus. Steht die Instanz noch nicht, überbrückt
   `npm run review-server` ([tools/review-server.mjs](tools/review-server.mjs))
   das ohne Mutterprojekt — derselbe API-Vertrag, gegen den
   `test/integration.test.js` prüft. Alle Varianten samt Formulartexten:
   [store/test-instructions.md](store/test-instructions.md).
2. **`https://*/*` unter `optional_host_permissions` verlängert die Prüfung.**
   Unvermeidbar bei einer selbst gehosteten App, aber die Begründung muss
   vollständig ins Formular — sie steht ausformuliert in
   [store/listing-de.md](store/listing-de.md).

Die Datenschutzerklärung liegt fertig in
[store/privacy-policy.de.md](store/privacy-policy.de.md) und
[store/privacy-policy.en.md](store/privacy-policy.en.md); sie muss unter einer
öffentlichen URL erreichbar sein, sonst nimmt der Store die Einreichung nicht an.

Wenn du die Erweiterung nur auf einem Rechner benutzt, brauchst du den Store
nicht: „Entpackte Erweiterung laden" funktioniert dauerhaft. Der Store bringt
automatische Updates und die Installation per Klick auf weiteren Geräten.
