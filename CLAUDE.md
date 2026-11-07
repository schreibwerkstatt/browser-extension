# schreibwerkstatt-browser-extension

Chrome-Erweiterung (Manifest V3), die Webseiten als **Recherche-Fundstück** oder
**zitierfähige Quelle** in eine selbst gehostete Schreibwerkstatt-Instanz schickt.
Vanilla JS als ESM, esbuild als Bündler, `node:test` für Tests. Funktionsumfang,
Berechtigungen und Datenschutz: [README.md](README.md) — diese Datei enthält nur
die Arbeitsregeln.

```bash
npm install
npm run build     # dist/ erzeugen (unmittelbar in chrome://extensions ladbar)
npm run watch     # dist/ beobachten
npm test          # alle Tests, kein Netz und kein Server nötig
npm run typecheck # JSDoc-Typen prüfen (tsc über jsconfig.json, erzeugt nichts)
npm run icons     # Symbole neu erzeugen
npm run package   # store-fertiges ZIP unter store/ (baut vorher)
npm run promo     # Werbekacheln für den Store
npm run shots     # Store-Screenshots (braucht SHOTS_TOKEN, siehe store/PUBLISHING.md)
npm run review-server  # Referenz-Server für die Store-Prüfung (REVIEW_TOKEN setzen)
npm run store:auth     # einmalig: Refresh-Token für die Chrome-Web-Store-API
npm run store:publish  # Paket hochladen und einreichen (--dry-run prüft nur)
npm run clean     # dist/ löschen
```

Node ≥ 22. `npm test` und `npm run typecheck` müssen vor jedem Commit grün sein.
[.github/workflows/ci.yml](.github/workflows/ci.yml) wiederholt Test,
Typprüfung **und** Build bei jedem Push auf `main` und bei jedem PR, auf Node 22
und 24. Der
eigentliche Zweck ist der frische Klon: dort baut nur, was wirklich in Git liegt
— eine vergessene, nicht getrackte Datei fällt lokal nie auf und hier immer.

Ein versionierter Stand entsteht mit dem Befehl `/release`
([.claude/commands/release.md](.claude/commands/release.md)): Vorprüfungen, Test,
`npm run package`, **Commit und Push des gesamten Arbeitsstands**, Tag,
GitHub-Release mit dem ZIP als Anhang. Das geschieht ohne Rückfrage — wer den
Ablauf folgenlos sehen will, nimmt `--dry-run`. Weil `git add -A` nicht nach
Herkunft fragt, ist die Sichtprüfung des Arbeitsstands in Schritt 1 die einzige
Bremse vor einem öffentlichen Push; die Liste, was dort nie hineingehört, steht
unten unter *Öffentliches Repository*. Der Upload in den Chrome Web Store
geschieht nur mit `--store` und reicht dort zur **Prüfung ein**, veröffentlicht
also nicht; die Zugangsdaten dafür liegen außerhalb dieses Repositories
([store/PUBLISHING.md](store/PUBLISHING.md), Abschnitt
*Automatisch aktualisieren*).

---

## Verhältnis zum Mutterprojekt

Die Server-App **schreibwerkstatt** ist das Mutterprojekt und wird in einem eigenen
Repository entwickelt: <https://github.com/schreibwerkstatt/schreibwerkstatt> (lokal
üblicherweise als Geschwisterordner `../schreibwerkstatt` ausgecheckt).

Dieses Repository enthält **ausschließlich den Client**. Der API-Vertrag ist dort
die Single Source of Truth, nicht hier:

| Was | Wo im Mutterprojekt |
|---|---|
| Vertrag der Erweiterung, Begründungen, Idempotenz-Regeln | [`docs/clients.md`](https://github.com/schreibwerkstatt/schreibwerkstatt/blob/main/docs/clients.md) → Abschnitt *„Dritter Client: Browser-Erweiterung"* |
| `POST /capture` (transaktionaler Ein-Request-Pfad) | `routes/capture.js` |
| `POST /research`, `GET /research`, `POST /research/:id/{image,doc}` | `routes/research.js` |
| `POST /sources`, `GET /sources/{lookup,by-url}`, `POST /sources/:id/link` | `routes/sources.js` |
| PDF-Anhang einer Quelle: `POST /sources/:id/doc` | `routes/sources-doc.js` (Unterrouter, unter `/sources` gemountet) |
| Geräte-Token `swd_…` und die durchgesetzte Scope-Allowlist | `lib/device-scopes.js`, `lib/device-auth.js` |
| Token ausstellen (`POST /me/device-tokens`, `kind: 'capture'`) | `routes/usersettings.js` |
| URL-Normalisierung serverseitig (Dublettenvergleich) | `lib/url-normalize.js` |
| Grenzwerte: Titel/Text/Tags | `lib/research-validate.js` |
| Grenzwerte: PDF (25 MB, `MAX_INPUT_BYTES`) | `lib/pdf-extract.js` |

Die Erweiterung darf nur Pfade ansprechen, die in der `capture:write`-Allowlist
stehen; alles andere antwortet `403 DEVICE_SCOPE_FORBIDDEN`. Kein `DELETE`, kein
`/me/*`, kein `/jobs/*`, kein Zugriff auf den Manuskripttext. Die clientseitig
verwendeten Endpunkte stehen gesammelt in
[src/background/api-client.js](src/background/api-client.js).

Die Allowlist (`CAPTURE_ALLOW` in `lib/device-scopes.js`) erlaubt mehr, als der
Client heute nutzt — die Lesepfade `GET /research/tags`, `GET /sources`,
`GET /sources/{pool,stats}` sind offen. Wer sie in Anspruch nimmt, braucht
**keine** Serveränderung.

> **Die Allowlist ist keine Routenliste.** Sie sagt, was ein Token *dürfte*,
> nicht was es gibt. Ein Eintrag `POST /sources/:id/pdf` hat dort einmal einen
> Client-Aufruf auf einen Pfad erzeugt, den es nie gab (Abweichung 1); der Server
> hat ihn inzwischen entfernt und die Liste als Rechte-Liste kenntlich gemacht.
> **Pfade kommen aus `docs/clients.md`, nie aus der Allowlist.**

> **Stand:** gegen `../schreibwerkstatt` bei Commit `4dca4a54` (2026-11-07,
> Vertrag `api 6` laut `contract/version.json`) abgeglichen — Fehlercodes,
> Grenzwerte und Anlege-Regeln gegen `docs/clients.md` und
> `contract/CHANGELOG.md`. Vorher zuletzt `ff4e3cae` (2026-08-01/02). Wer den
> Vertrag erneut abgleicht, aktualisiert diese Zeile mit; der maschinenlesbare
> Vertrag liegt seit Kurzem unter `contract/` im Mutterprojekt, die Änderungen
> stehen je Version in `contract/CHANGELOG.md`.

### `GET /research` — Lesepfad

Serverseitig fix; hier nur gespiegelt. Der Client nutzt ihn für die
Dublettenprüfung vor dem Erfassen.

```
GET /research
Auth:  Authorization: Bearer swd_…       (X-Client-Platform: chrome)
Scope: content:read                      — capture:write allein genügt NICHT
ACL:   Rolle `editor` auf book_id
Idempotenz: reiner Lesepfad, keine Nebenwirkung
```

| Query | Typ | Bemerkung |
|---|---|---|
| `book_id` | int | **Pflicht** |
| `q` | string | FTS5-Syntax — siehe 500er-Deckel unten |
| `kind` | enum | `note\|link\|quote\|fact\|image\|document`; Unbekanntes wird ignoriert, nicht abgelehnt |
| `tag` | string | |
| `linked` | string | `"<kind>:<id>"` |
| `sort` | enum | `updated` (Default) \| `created` \| `title` \| `kind` \| `link:<dimension>` |
| `archived` | `"1"` | sonst nur nicht-archivierte |
| `limit` | int | Default 50, Max 200. 0, negativ oder Text → Default, **kein 400** |

Antwort `200`: Array, angeheftete zuerst, dann nach `sort`.

```jsonc
[{
  "id": 1, "kind": "quote",
  "title": null, "source": null,
  "body_snippet": "…",              // max 200 Zeichen, "…" wenn gekürzt
  "urls": [{ "url": "…", "label": "…" }],
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-02T00:00:00.000Z"
}]
```

Nicht enthalten: `body`, `tags`, `links`, `doc_*`, `image_mime`, `pinned`,
`archived`, `book_id`, `user_email`.

| Status | `error_code` | Bedeutung |
|---|---|---|
| 400 | `INVALID_ID` | `book_id` fehlt oder ist ungültig |
| 401 | `NOT_LOGGED_IN` | Token ungültig, widerrufen oder abgelaufen |
| 403 | `DEVICE_SCOPE_FORBIDDEN` | `content:read` fehlt (Gate greift vor der Route) |
| 403 | `NO_BOOK_ACCESS` | kein Zugriff auf dieses Buch |
| 403 | `INSUFFICIENT_ROLE` | nur `viewer`; `detail: { actual, required }` |

**Der 500er-Deckel.** Mit `q` läuft die Anfrage durch einen FTS5-Vorfilter, der
nach **500 Treffern** abschneidet — und zwar *bevor* `kind`, `tag`, `sort` und
`limit` greifen. In einem großen Buch ist „nichts gefunden“ nach einer breiten
Query deshalb keine Aussage über den Bestand. Die Erweiterung muss ein solches
Ergebnis als **unvollständig** kennzeichnen und darf es nie als „nicht
vorhanden“ zeigen. Dasselbe gilt, wenn eine Antwort genau `limit` Zeilen lang
ist. Der Wert steht als `RESEARCH_LIST.FTS_PREFILTER_CAP` in
[src/shared/limits.js](src/shared/limits.js), die Auswertung in
[src/shared/duplicates.js](src/shared/duplicates.js).

**Dublettenprüfung geht über die URL, nicht über `q`.** Verglichen wird gegen
`urls[].url` und `source` der Antwort. Beide Seiten laufen durch
`serverNormalizeUrl` ([src/shared/url.js](src/shared/url.js)), einen
zeichengenauen Nachbau von `lib/url-normalize.js`. Das reguläre `normalizeUrl`
desselben Moduls taugt dafür **nicht** — es behält `www.`, das Schema und
`#!`-Routen; siehe die offene Abweichung 8.

**Archivierte Fundstücke zählen nicht.** Die Prüfung fragt ohne `archived=1`,
ein archiviertes Fundstück derselben Seite bleibt also unsichtbar. Das ist
gewollt und deckt sich mit dem Server: auch `findDuplicateItem` und
`409 DUPLICATE_URL` betrachten nur nicht-archivierte Einträge. Wer das ändert,
ändert es auf beiden Seiten.

Der Client ruft den Pfad über `api.listResearch()`
([api-client.js](src/background/api-client.js)) auf, hinter der Fähigkeit
`researchList` ([capabilities.js](src/background/capabilities.js)): ein Server
ohne die Route antwortet mit dem HTML-404 von Express, dann bleibt die Prüfung
einfach aus. `403 DEVICE_SCOPE_FORBIDDEN` ist dagegen ein Befund über das Token
und wird gemeldet, nicht wiederholt — und färbt den globalen Token-Zustand
nicht ein, weil das Erfassen davon unberührt bleibt.

### Abgearbeitete Abweichungen Client → Server

Aus dem Abgleich vom 2026-08-01. Alle waren **clientseitig** zu beheben; keine
davon verlangte eine Serveränderung.

**Es ist derzeit keine offen** — die Punkte 1–7 am 2026-08-01, die Punkte 8 und
9 am 2026-08-02, die Punkte 10–12 am 2026-11-07. Die Liste bleibt trotzdem stehen: jeder Punkt hinterlässt eine
Regel, an die sich der nächste Abgleich halten soll. Sie ist eine Regelsammlung,
keine Aufgabenliste. Wer eine neue Abweichung findet, hängt sie hier an.

1. ~~**`POST /sources/:id/pdf` existiert nicht.**~~ *Erledigt.* Der Endpunkt heißt
   `doc` (`routes/sources-doc.js`); `api.uploadSourceDoc()` ruft ihn auf, mit
   Dateiname als `?name=`. **Regel:** Pfade kommen aus der Vertragstabelle, nie
   aus der Scope-Allowlist des Servers — die ist eine Rechte-Liste. Genau diese
   Verwechslung hat den Phantom-Pfad erzeugt.
2. ~~**Scope-Fehlercode.**~~ *Erledigt.* `DEVICE_SCOPE_FORBIDDEN` ist der einzige
   Code, an dem `isScopeError` anschlägt; `CAPTURE_SCOPE_REQUIRED` ist aus Client,
   Attrappen und Sprachdateien entfernt. Welcher Scope fehlt, sagt der Code nicht
   — dafür trägt `ApiError.path` den Pfad.
3. ~~**ACL-Codes.**~~ *Erledigt.* `NO_BOOK_ACCESS`, `INSUFFICIENT_ROLE` und
   `INVALID_BOOK_ID` sind abgebildet, `BOOK_NOT_FOUND` und `BOOK_ACCESS_DENIED`
   sind weg. `INSUFFICIENT_ROLE` nennt Ist- und Soll-Rolle aus `detail`, in
   festgelegter Platzhalter-Reihenfolge (`SUBSTITUTION_FIELDS` in
   [errors.js](src/shared/errors.js)) — sonst hinge die Meldung an der
   Schlüsselreihenfolge des JSON.
4. ~~**`/capture`-Payload ist unvollständig.**~~ *Erledigt.* `buildCapturePayload`
   ([capture-runner.js](src/background/capture-runner.js)) überträgt alle Felder
   der Vertragstabelle; ein Test vergleicht sie Feld für Feld gegen
   `buildSourcePayload`, damit der bessere Weg nicht wieder das schlechtere
   Ergebnis liefert.
5. ~~**Antwortflags werden nicht gelesen.**~~ *Erledigt.* `research_created`,
   `source_created` und `source_linked` landen in `job.progress`; das Popup
   unterscheidet damit „angelegt" von „war schon drin". Ein `created` gibt es
   nicht und gab es nie.
6. ~~**Nicht abgebildete Fehlercodes.**~~ *Erledigt.* `ERROR_MESSAGE_KEYS` deckt
   die Vertragstabelle vollständig ab; ein Test hält die Map gegen die Liste und
   schlägt in beide Richtungen an — fehlender Code **und** erfundener Code.
   Ein unbekannter Code fällt auf `err_unmapped_code` und **nennt sich selbst**,
   damit der nächste Abgleich nicht wieder raten muss.
7. ~~**Die Attrappen bilden den falschen Vertrag nach.**~~ *Erledigt.*
   [test/helpers/mock-server.js](test/helpers/mock-server.js) spricht jetzt nur
   Codes und Pfade des Vertrags und bildet zusätzlich die beiden HTML-Antworten
   des Body-Parsers nach (413 ohne `error_code`, 400 bei kaputtem JSON) sowie das
   stille Kürzen der Textfelder. [tools/review-server.mjs](tools/review-server.mjs)
   zieht daraus. **Regel:** Die Attrappe ist der Vertrag, gegen den geprüft wird —
   wer sie mit dem Client zusammen falsch macht, macht die Tests wertlos.
8. ~~**`normalizeUrl` ist nicht die Normalisierung des Servers.**~~ *Erledigt.*
   Die beiden Funktionen bleiben verschieden — das ist Absicht: `normalizeUrl`
   ist die Form, die **gesendet** wird, `serverNormalizeUrl` die Form, in der
   **verglichen** wird. **Regel:** jeder Vergleich zweier Adressen läuft über
   `serverNormalizeUrl` bzw. `sameServerResource`, auch ein rein lokaler. Nach
   Client-Regeln zu vergleichen behauptet Unterschiede, die der Server nicht
   sieht. Umgestellt sind die kanonische Adresse gegen die Seiten-URL
   ([intent.js](src/shared/intent.js)) und die Entdopplung von `urls[]` vor dem
   Senden (`buildResearchPayload` in
   [capture-runner.js](src/background/capture-runner.js)); `sameResource` ist
   ersatzlos entfernt, weil es genau diese Falle war. „Warteschlangen-Dubletten"
   und „Doppelklick-Schutz" standen hier zu Unrecht: beides entscheidet der
   Server (`GET /sources/by-url`, Idempotenzfenster), der Client vergleicht dort
   nichts.
9. ~~**Der Serverwechsel setzt die Fähigkeits-Befunde nicht zurück.**~~
   *Erledigt.* `resetDetectedCapabilities()` in
   [state.js](src/background/state.js) schreibt `detected` hart auf `null`,
   `scopeMissing` auf `false` und `probedAt` auf `0`; `SAVE_CREDENTIALS` in
   [handlers.js](src/background/handlers.js) ruft es auf, ein Test in
   [test/handlers.test.js](test/handlers.test.js) nagelt die Verdrahtung fest.
   **Regel:** `saveDetectedCapabilities` ist kein Reset — `pick()` liest `null`
   als „keine Aussage" und behält den alten Wert. Wer „vergiss alles" meint,
   braucht eine eigene Funktion. **Zweite Regel:** zurückgesetzt werden nur
   *Befunde*. `mode` ist die Vorgabe des Nutzers aus den Optionen und bleibt
   stehen — zumal `SAVE_CREDENTIALS` auch feuert, wenn nur der Token neu ist.
10. ~~**URLs wurden auf 2000 Zeichen gekürzt.**~~ *Erledigt.* Seit `api 6` weist
    der Server eine URL über `URL_MAX` oder ohne `http(s)` mit
    `400 INVALID_URL` (`params.max`) ab — den ganzen Request, in `urls[]` von
    `POST /research` wie in `url` von `POST /capture`. Der Client hat sie
    gekürzt und damit auf eine andere Seite zeigen lassen. Jetzt prüft
    `validateUrls` ([limits.js](src/shared/limits.js)) vorher und lehnt sichtbar
    ab (`validation_url_too_long`); `clamp*Payload` fasst Adressen nicht mehr an.
    `POST /sources` kennt **keine** Längengrenze für `url` — die Prüfung steckt
    deshalb nicht in `validateSourcePayload`, sondern läuft für `/capture` eigens.
    **Regel:** „der Server kürzt still" gilt nur für die Felder, für die es im
    Vertrag steht. Für jedes andere Feld ist eine Kürzung eine Erfindung.
11. ~~**`409 DUPLICATE_URL` auf dem Fallback-Pfad war nicht abgebildet.**~~
    *Erledigt.* `POST /research` lehnt seit Server v4.15.0 eine im Buch schon
    erfasste URL ab; der Client kannte den Code nicht und ließ den Auftrag mit
    `err_unmapped_code` scheitern — bei jedem zweiten Zitat derselben Seite mit
    `citekey`. Jetzt sendet `createResearchItem`
    ([capture-runner.js](src/background/capture-runner.js)) einmal mit
    `allow_duplicate: true` nach, und zwar nur im zweiten Anlauf. **Regel:** ein
    Feld, das ein älterer Server nicht kennt, geht erst mit, wenn die Antwort
    beweist, dass der Server es kennt.
12. ~~**Neue Codes, eine Altlast.**~~ *Erledigt.* `INVALID_FIELD` (400,
    `params.field`), `SEARCH_FAILED` (503, vorübergehend) und `SHUTTING_DOWN`
    (503, `Retry-After`, vorübergehend) sind abgebildet; `csl_type` kennt
    `newspaper`. `LOGIN_REQ` sendet der heutige Server nicht mehr (die 401 kommt
    auf `/research` aus dem Buch-Guard als `NOT_LOGGED_IN`) — der Code bleibt
    als ausgewiesene Altlast gemappt, weil selbst gehostete Instanzen
    nachhinken; [test/errors.test.js](test/errors.test.js) führt ihn getrennt
    unter `LEGACY_CODES`. `EMPTY` zählt wie der Server nur `urls[]` bzw. `url`
    als Adresse, nicht das Freitextfeld `source`.

### `POST /capture` und der `citekey` — geklärt

Die Frage war: der dokumentierte Body von `POST /capture` führt kein `citekey`,
obwohl `409 CITEKEY_TAKEN` als Fehlercode *dieses* Endpunkts in der Tabelle steht.

**Beantwortet am 2026-08-02:** die Route nimmt bewusst keinen `citekey` an —
`routes/capture.js` baut ihn nicht. Der Zitierschlüssel ist Sache der Autorin
oder des Autors; `409 CITEKEY_TAKEN` deckt dort nur den Wettlauf zweier
gleichzeitiger Anfragen ab. Der Fehlercode ist also richtig und der Body
vollständig.

Damit ist `unifiedCaptureFits()` in
[capture-runner.js](src/background/capture-runner.js) kein Provisorium mehr,
sondern die dauerhaft richtige Regel: liegt ein `citekey` vor, geht der Auftrag
über den Fallback-Pfad, wo `POST /sources` ihn annimmt. Ein Request mehr, und
das bleibt so. Kein Prompt ans Mutterprojekt nötig.

---

Erlaubt, aber ungenutzt: `GET /research/tags`, `GET /sources`,
`GET /sources/{pool,stats}`. `GET /research` ist seit dem 2026-08-01 in Gebrauch.

Geprüft und **stimmig** (Stand `api 6`): Titel 300, Text 20 000, `source`
1 000, Tags 60/20, URLs 2 000 (abgewiesen, nicht gekürzt)/20, URL-Label 300,
Anhang-Dateiname 200, JSON-Body von `/capture` 256 kB, Bild 12 MB, PDF 25 MB,
die zwölf `csl_type`-Werte, `401 NOT_LOGGED_IN`, `409 CITEKEY_TAKEN`,
`409 DUPLICATE_URL`, `limit` 50/200, FTS-Vorfilter 500.

Bewusst **nicht** übernommen: `issued_date` (genaues Erscheinungsdatum) in
`POST /capture` und `POST /sources` ist optional; der Client schickt weiter nur
`year`. Wer es nachzieht, sendet `YYYY[-MM[-DD]]` — Unlesbares beantwortet der
Server mit `400 INVALID_VALUE` (`field: 'issued_date'`). Ebenso
`POST /research/:id/scrape`: steht nicht im `capture:write`-Scope und wäre mit
dem Token der Erweiterung `403 DEVICE_SCOPE_FORBIDDEN`; die Erweiterung liest
das gerenderte Dokument ohnehin selbst.

**Zwei Sorten Grenze, und die Unterscheidung ist der Punkt** (siehe
[limits.js](src/shared/limits.js)):

- **Textfelder kürzt der Server still** und antwortet 2xx. Der Client kürzt
  deshalb vorher auf dieselben Längen und sagt es im Popup — sonst quittiert er
  einen Text, der so nie gespeichert wurde. Ausnahmen: die Wortlauttreue (ein
  markiertes Zitat über 20 000 Zeichen wird **abgelehnt**, nicht beschnitten)
  und **Adressen** — eine URL über 2 000 Zeichen weist der Server seit `api 6`
  mit `INVALID_URL` ab, der Client lehnt sie vorher ab (Abweichung 10).
- **Uploads und der JSON-Body laufen in den Body-Parser.** Der Server hat keinen
  globalen Express-Fehler-Handler, also antwortet der Parser mit Express' Default:
  **HTML ohne `error_code`** — 413 bei zu großem Körper, 400 bei kaputtem JSON.
  `res.json()` ist auf diesem Pfad verboten; der Client prüft Größen **vor** dem
  Request und fällt sonst auf den HTTP-Status zurück.

  Folge, die leicht zu übersehen ist: **`DOC_TOO_LARGE` wird in der Praxis nie
  ankommen.** Parser-Limit und Server-Limit liegen beide bei 25 MB, der Parser
  gewinnt. Wer nur auf diesen Code prüft, fängt den Fall nie.

---

## Harte Regel: API-Änderungen nur als Prompt für das Mutterprojekt

**In diesem Repository wird nie eine Serveränderung implementiert, angenommen oder
vorausgesetzt.** Auch nicht „nur schnell das Feld mitschicken" — die App weist
unbekannte Felder und Pfade ab, und ein hier erfundener Vertrag driftet
unbemerkt.

Sobald eine Aufgabe eine Änderung am Server verlangt — neuer Endpunkt, neues Feld
in Request oder Response, geänderter `error_code`, geändertes Limit, neuer Scope,
andere Idempotenz-Regel, ein Serverfehler, der nicht clientseitig gehört —, gilt:

1. **Anhalten** vor dem Client-Code, der davon abhängt.
2. Die Serveränderung als **fertigen Prompt** ausgeben, den der Nutzer in eine
   Claude-Code-Sitzung im Mutterprojekt einsetzen kann (Vorlage unten). Nicht als
   Prosa-Vorschlag, nicht als Patch, nicht als Issue-Text — als Prompt.
3. Erst danach die Client-Seite bauen, und zwar so, dass sie **gegen den heutigen
   Server weiterläuft**: hinter Fähigkeits-Erkennung
   ([src/background/capabilities.js](src/background/capabilities.js)) mit
   dokumentiertem Fallback, oder als klar gemeldete Ablehnung. Nie ein Pfad, der
   ohne die noch nicht deployte Änderung stillschweigend scheitert.

Zum Prompt gehört immer die Pflege von `docs/clients.md` im Mutterprojekt mit —
ein Vertrag ohne Doku ist der nächste Drift.

Umgekehrt gilt dasselbe passiv: fällt beim Arbeiten auf, dass Server und
Erweiterung auseinanderlaufen (Limit, Fehlercode, Feldname), ist das ein Befund
plus Prompt — nicht ein Workaround, der die Abweichung hier verewigt.

### Vorlage

````markdown
```
Kontext: Die Browser-Erweiterung `schreibwerkstatt-browser-extension` braucht eine
Serveränderung. Sie authentisiert per Geräte-Token mit `kind: 'capture'`
(`capture:write`-Scope, Allowlist in lib/device-scopes.js) und ist in
docs/clients.md unter „Dritter Client: Browser-Erweiterung" dokumentiert.

Anlass: <was die Erweiterung tun soll und warum es heute nicht geht>

Gewünschte Änderung:
- Endpunkt/Route: <Methode + Pfad, betroffene Datei in routes/>
- Request: <Felder, Typen, Pflicht/optional>
- Response: <Felder>
- Fehlerfälle: <error_code + HTTP-Status je Fall>
- Scope: <steht der Pfad schon in der capture-Allowlist? sonst dort ergänzen>
- Limits/Validierung: <Grenzen, damit der Client sie spiegeln kann>
- Idempotenz: <Verhalten bei Wiederholung desselben Requests>

Bitte zusätzlich:
- docs/clients.md im Abschnitt zur Browser-Erweiterung nachziehen
- Tests für die neuen Pfade inkl. Fehlerfälle
- am Ende den fertigen Vertrag in der Form zurückgeben, die ich in die
  Erweiterung übernehmen kann (Pfad, Body, Response, error_codes)
```
````

Der Client-Teil im Anschluss gehört in
[src/background/api-client.js](src/background/api-client.js) (Requests),
[src/background/capture-runner.js](src/background/capture-runner.js) (Ablauf),
[src/shared/limits.js](src/shared/limits.js) (gespiegelte Grenzen) und
[src/shared/errors.js](src/shared/errors.js) (Fehlercode → Text), mit einem Test in
[test/integration.test.js](test/integration.test.js) gegen den Mock-Server
[test/helpers/mock-server.js](test/helpers/mock-server.js), der den Vertrag nachbaut.

---

## Client-Konventionen

- **Trennlinie:** alles unter [src/shared/](src/shared/) und
  [src/content/extract-meta.js](src/content/extract-meta.js) ist frei von
  `chrome`-APIs und deshalb direkt testbar.
  [src/background/service-worker.js](src/background/service-worker.js) ist die
  einzige Datei, die Chrome-Ereignisse verdrahtet.
- **Alle Netzwerkanfragen laufen im Service Worker.** Nur er ist durch die
  Host-Berechtigung von CORS befreit; derselbe Request aus einem Content-Script
  scheitert.
- **Keine feste Server-Adresse, keine externe Ressource.** Keine Schrift, kein
  CDN, kein Analytics, kein Crash-Reporting. Beispieladressen in Code, Tests und
  Sprachdateien immer `schreibwerkstatt.example.com`.
- **Kein stilles Verwerfen.** Gescheiterte Aufträge bleiben in der Warteschlange,
  bis der Nutzer sie verwirft; jede Fehlermeldung nennt den `error_code`.
  Das gilt auch für Aufträge, die **gelingen und dabei etwas verlieren** — ein
  Anhang, der den Worker-Neustart nicht überlebt hat, ein schon vergebener
  `citekey`. Solche Vorbehalte stehen in [outcome.js](src/shared/outcome.js) und
  gehören an *jede* Stelle, die sonst „gesichert" meldet. Die Warteschlange
  allein genügt nicht: ein erfolgreicher Auftrag verlässt sie, und der Vermerk
  ginge mit ihm — deshalb trägt die Erfolgs-Benachrichtigung ihn mit.
- **i18n:** keine hartcodierten Strings, keine Inline-Styles, beide
  `_locales/{de,en}/messages.json` deckungsgleich —
  [test/i18n.test.js](test/i18n.test.js) erzwingt das.
- **Wortlauttreue:** ein markiertes Zitat wird nie beschnitten oder normalisiert,
  sondern im Grenzfall sichtbar abgelehnt.
- Getroffene Annahmen zum Vertrag stehen im README unter *Getroffene Annahmen* und
  sind je mit einem Test festgenagelt; ändert der Server sie, gilt die Prompt-Regel.

---

## Öffentliches Repository

Dieses Repository ist öffentlich. Entsprechend gehört nichts davon hinein:

- Geräte-Token, Zugangsdaten, `.env`-Dateien (in Tests nur Attrappen wie
  `swd_gueltig`)
- echte Hostnamen, IP-Adressen oder Instanzpfade des Nutzers
- lokale absolute Pfade (`/home/…`) in Code, Doku oder Kommentaren
- Logs, Datenbanken, `dist/`-Artefakte, Test-Ausgaben
- Test-Fixtures oder Screenshots mit personenbezogenen Daten — die HTML-Fixtures
  unter [test/fixtures/](test/fixtures/) sind bewusst erfunden
