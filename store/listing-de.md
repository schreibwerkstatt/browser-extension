# Store-Listing — Deutsch (Standardsprache)

Alles hier ist zum Kopieren gedacht. Die Zeichenzahlen in Klammern sind die
Grenzen, die das Developer-Dashboard durchsetzt.

---

## Tab „Store-Eintrag"

### Name (max. 75 Zeichen)

```
Schreibwerkstatt – Erfassen
```

> Kommt aus `_locales/de/messages.json` → `ext_name`. Das Dashboard übernimmt
> den Manifest-Namen automatisch; du kannst ihn dort nicht abweichend setzen,
> solange `__MSG_ext_name__` im Manifest steht. Das ist erwünscht — sonst
> stehen im Store und in `chrome://extensions` zwei verschiedene Namen.

### Kurzbeschreibung (max. 132 Zeichen)

```
Webseiten als Recherche-Fundstück oder zitierfähige Quelle in deine Schreibwerkstatt schicken.
```

> 94 Zeichen. Kommt ebenfalls aus dem Manifest (`ext_description`).

### Ausführliche Beschreibung (max. 16 000 Zeichen)

```
Schreibwerkstatt – Erfassen ist die Browser-Erweiterung zu deiner selbst gehosteten Schreib-App „Schreibwerkstatt“. Sie schickt die Seite, die du gerade liest, mit einem Klick dorthin — entweder als Recherche-Fundstück auf das Wissensboard eines Buchs oder als zitierfähige Quelle in deine Literaturbibliothek.

WICHTIG: Diese Erweiterung ist ein Zubehör. Sie braucht eine eigene Schreibwerkstatt-Installation und ein Gerätetoken daraus. Ohne beides tut sie nichts. Sie hat keinen eigenen Dienst und keinen Standardserver.

── WAS SIE MACHT ──────────────────────────

Seite erfassen (Symbolklick oder Alt+Shift+S)
Das Formular ist schon ausgefüllt: Titel, Autor:innen, Zeitschrift, Verlag, Jahr, DOI, ISBN, URL, Abrufdatum und der Haupttext. Über der Buchauswahl steht, woher jede Angabe stammt — verlagsseitige citation_*-Metadaten sind belegt, ein OpenGraph-Titel ist geraten. Korrigieren, Ziel wählen (Recherche / Quelle / beides), senden.

Zitat erfassen (Text markieren, Rechtsklick, oder Alt+Shift+Q)
Der Wortlaut bleibt exakt erhalten: kein Trimmen, keine geglätteten Umbrüche, keine normalisierten Anführungszeichen. Danach erscheint 6 Sekunden lang ein Rückgängig-Knopf; drückst du ihn, entsteht auf dem Server gar kein Eintrag.

Kanonische Angaben holen
Trägt die Seite ein DOI oder eine ISBN, holt dein Server auf Zuruf die geprüften Daten von Crossref bzw. OpenLibrary und ersetzt damit die geernteten Werte. Die Abfrage läuft serverseitig — dein Browser spricht nie direkt mit diesen Diensten.

Anhänge
Optional den sichtbaren Tab-Bereich als Screenshot mitschicken. Gibt die Seite ein citation_pdf_url auf demselben Host an, auch das PDF.

Warteschlange, die nichts verliert
Ist der Server offline, wandert die Erfassung in eine Warteschlange mit exponentiellem Backoff und geht später raus. Nichts wird stillschweigend verworfen; gescheiterte Aufträge stehen sichtbar am Symbol.

Zweisprachig
Oberfläche auf Deutsch und Englisch, nach Browsersprache.

── DATENSCHUTZ ────────────────────────────

Gesendet wird ausschließlich an den Host, den du selbst in den Optionen einträgst. Sonst nirgends.

Kein Analytics. Keine Telemetrie. Kein Crash-Reporting. Kein CDN, keine externen Schriftarten, kein Drittanbieter-Skript. Kein nachgeladener Code. Außer den relativen API-Pfaden enthält die Erweiterung keine einzige fest verdrahtete Adresse.

Kein Browserverlauf: es gibt keine history- und keine tabs-Berechtigung. Die Erweiterung erfährt nicht, welche Seiten du besuchst.

Keine Hintergrundaktivität: es gibt kein dauerhaftes Content-Script. Das Ernte-Script wird über activeTab in genau dem Moment injiziert, in dem du klickst.

Keine Host-Berechtigung im Voraus: Das Manifest enthält kein <all_urls>. Beim Einrichten fragt die Erweiterung genau ein Origin ab — das deiner eigenen Installation.

Das Gerätetoken liegt in chrome.storage.local, ausdrücklich nicht in storage.sync: es soll nicht über dein Google-Konto auf andere Rechner wandern.

Deinstallieren löscht alles Lokale restlos.

── OFFENER QUELLCODE ──────────────────────

MIT-Lizenz. Der ausgelieferte Code ist nicht minifiziert und nicht obfuskiert; du kannst das Paket entpacken und Zeile für Zeile mit dem Repository vergleichen.

Quellcode: https://github.com/schreibwerkstatt/browser-extension
```

> Die Repository-URL ist eingesetzt und das Repository ist öffentlich, der
> Absatz ist also nachprüfbar — genau darum steht er drin.

### Kategorie

- **Primär:** `Werkzeuge` (englisch: *Tools*)
- **Sekundär:** `Workflow und Planung` (englisch: *Workflow & Planning*)

> Nicht `Produktivität`: die Kategorie ist überlaufen. Für ein Werkzeug ohne
> eigenen Dienst passt *Werkzeuge* besser und wird plausibler eingeordnet.

### Sprache

`Deutsch` als Sprache des Eintrags. Zusätzlich `English` anlegen und die Texte
aus [listing-en.md](listing-en.md) einsetzen — die Erweiterung liefert beide
Locales mit, also sollte der Eintrag das auch.

---

## Grafiken

| Element | Maße | Pflicht | Datei |
|---|---|---|---|
| Store-Symbol | 128 × 128 PNG | ja | `../src/icons/icon-128.png` |
| Screenshots | 1280 × 800 PNG | ja, min. 1, max. 5 | selbst aufnehmen, siehe [PUBLISHING.md](PUBLISHING.md#5-screenshots-aufnehmen) |
| Kleine Kachel | 440 × 280 PNG | faktisch ja | `assets/promo-small-440x280.png` (`npm run promo`) |
| Marquee | 1400 × 560 PNG | nein | `assets/promo-marquee-1400x560.png` (`npm run promo`) |
| YouTube-Video | — | nein | entfällt |

> Die kleine Kachel ist formal optional. Ohne sie wird der Eintrag in der
> Store-Suche schlechter platziert, also behandle sie als Pflicht.

### Bildunterschriften für die Screenshots

Screenshots tragen im Store keine eigenen Beschriftungen. Setz die Erklärung
also ins Bild (siehe [PUBLISHING.md](PUBLISHING.md#5-screenshots-aufnehmen)) und
verwende diese Reihenfolge:

1. Popup über einem Fachartikel, Felder gefüllt, Herkunftszeile sichtbar
2. Kontextmenü „Als Zitat erfassen" bei markiertem Text
3. Benachrichtigung mit dem Rückgängig-Knopf
4. Options-Seite: Serveradresse, Token, Verbindungstest, Standardbuch
5. Warteschlange mit einem wartenden und einem gescheiterten Eintrag

---

## Tab „Datenschutzpraktiken"

### Einziger Zweck (single purpose)

```
Die Erweiterung erfasst die Webseite, die der Nutzer gerade offen hat, und sendet sie an eine vom Nutzer selbst betriebene Schreibwerkstatt-Installation — als Recherchenotiz oder als bibliografische Quelle. Das ist ihr einziger Zweck. Jede Berechtigung dient genau diesem Erfassungsvorgang; er wird ausschließlich durch eine Nutzeraktion ausgelöst (Symbolklick, Tastenkürzel oder Kontextmenü). Die Erweiterung hat keine zweite Funktion und keinen Hintergrundbetrieb.
```

### Begründung je Berechtigung

Jeweils in das Feld der betreffenden Berechtigung kopieren. Kurz, konkret, und
es steht drin, warum es nicht weniger sein kann — genau darauf schaut die
Prüfung.

**`storage`**
```
Speichert die vom Nutzer eingetragene Serveradresse, sein Gerätetoken, die Buchliste des Servers und die Warteschlange nicht gesendeter Erfassungen. Ohne lokalen Speicher müsste das Token bei jeder Aktion neu eingegeben werden, und die Warteschlange würde einen Browserneustart nicht überleben. Bewusst nur storage.local, nicht storage.sync, damit das Token nicht über das Google-Konto des Nutzers auf andere Geräte repliziert wird.
```

**`activeTab`**
```
Liest die bibliografischen Metadaten, den Haupttext und die aktuelle Textmarkierung der Seite, die der Nutzer gerade erfassen will. activeTab ist hier absichtlich die engste verfügbare Wahl: der Zugriff gilt nur für den aktiven Tab und nur nach einer ausdrücklichen Nutzeraktion, und er erlischt danach wieder. Die Alternative wäre eine Host-Berechtigung für alle Seiten, die diese Erweiterung ausdrücklich nicht verlangt.
```

**`scripting`**
```
Injiziert das Ernte-Script per chrome.scripting.executeScript in dem Moment, in dem der Nutzer die Erfassung auslöst. Es gibt bewusst kein statisch registriertes Content-Script: ein solches würde auf jeder besuchten Seite laufen, auch wenn die Erweiterung nie benutzt wird. So läuft Code nur dort, wo der Nutzer ihn auslöst.
```

**`contextMenus`**
```
Stellt den Eintrag „Als Zitat erfassen“ bereit, der nur bei markiertem Text erscheint. Er ist der einzige Weg, eine Textmarkierung ohne Umweg über das Popup zu erfassen.
```

**`notifications`**
```
Zeigt nach dem Erfassen eines Zitats die Bestätigung samt Rückgängig-Knopf. Für Zitate aus dem Kontextmenü öffnet sich kein Popup, es gibt also keine andere Fläche für die Rückmeldung — und ohne Knopf kein Rückgängig. In den Optionen abschaltbar.
```

**`alarms`**
```
Weckt den Service Worker, wenn eine gescheiterte Erfassung erneut versucht werden soll. Ein MV3-Service-Worker wird nach etwa 30 Sekunden Untätigkeit beendet, und setTimeout hält ihn nicht am Leben; ohne alarms würde ein Eintrag mit zwei Stunden Backoff bis zur nächsten manuellen Aktion liegenbleiben. Erzeugt keinen Netzverkehr und erhebt keine Daten.
```

**Host-Berechtigungen (`https://*/*` sowie die localhost-Muster — optional)**
```
Diese Muster stehen unter optional_host_permissions, nicht unter host_permissions. Sie sind also eine Erlaubnis zu fragen, keine erteilte Berechtigung; das Manifest enthält kein <all_urls>.

Beim Einrichten ruft die Options-Seite chrome.permissions.request() mit genau EINEM Muster auf: dem Origin der Schreibwerkstatt-Installation, die der Nutzer selbst eingetragen hat, z. B. https://schreibwerkstatt.example.org/*. Nur dieses Origin wird gewährt. Chrome zeigt dabei seinen eigenen Bestätigungsdialog.

Der Umweg über ein weites optionales Muster ist unvermeidbar, weil die Schreibwerkstatt selbst gehostet wird: die Adresse ist bei jedem Nutzer eine andere und kann daher nicht im Manifest stehen. Manifest V3 kennt keine Möglichkeit, ein zur Laufzeit bestimmtes Origin anzufordern, das nicht vorab im Manifest deklariert ist.

Unverschlüsselte Adressen sind bewusst auf die lokale Entwicklung begrenzt: das Manifest führt dafür nur http://localhost/*, http://127.0.0.1/* und http://*.localhost/* — kein weites http-Muster. Eine nicht-lokale http-Adresse lehnt die Options-Seite ab, statt sie zu speichern.

Diese Host-Berechtigung befreit den Service Worker außerdem von CORS. Deshalb — und nur deshalb — laufen alle Netzwerkanfragen im Service Worker und keine im Content-Script.
```

### Nachgeladener Code (remote code)

Auswählen: **„Nein, ich verwende keinen nachgeladenen Code."**

> Das stimmt und ist nachprüfbar: kein `eval`, kein `new Function`, kein
> `innerHTML`, kein externes `<script>`. Der Bundler schreibt alles in das
> Paket; die CSP im Manifest verbietet ohnehin jede andere Quelle als `'self'`.
> Die Erweiterung holt vom Server nur JSON-**Daten** sowie das PDF und den
> Screenshot als Anhang. Daten sind kein Code — die Antwort bleibt „Nein".

### Datennutzung — welche Daten werden erhoben?

Anhaken:

- [x] **Website-Inhalte** — Titel, Haupttext, markiertes Zitat, bibliografische
      Metadaten und URL der Seite, die der Nutzer erfasst; auf Wunsch ein
      Screenshot des sichtbaren Bereichs oder das PDF der Seite.
- [x] **Authentifizierungsdaten** — das Gerätetoken der Schreibwerkstatt wird im
      `Authorization`-Header an die Installation des Nutzers übertragen.

Nicht anhaken, mit Begründung, falls nachgefragt wird:

| Nicht angehakt | Warum |
|---|---|
| Personenbezogene Daten | Es werden keine erfragt und keine ausgelesen. Namen von Autor:innen können in den Metadaten der erfassten Publikation stehen; sie sind Teil des Website-Inhalts und darüber abgedeckt. |
| Gesundheitsdaten | Werden nicht erhoben. |
| Finanz- und Zahlungsdaten | Werden nicht erhoben. |
| Persönliche Kommunikation | Werden nicht erhoben. |
| Standort | Werden nicht erhoben; keine Geolocation-Berechtigung. |
| Browserverlauf | Es gibt keine `history`- und keine `tabs`-Berechtigung. Übertragen wird nur die einzelne Seite, die der Nutzer ausdrücklich erfasst — keine Liste besuchter Seiten. |
| Nutzeraktivität | Keine Klick-, Maus-, Scroll- oder Tastenaufzeichnung. |

### Zertifizierungen

Alle drei bestätigen — alle drei sind hier wahr:

- [x] Ich verkaufe oder übertrage keine Nutzerdaten an Dritte, abgesehen von den
      genehmigten Anwendungsfällen.
- [x] Ich verwende oder übertrage Nutzerdaten nicht für Zwecke, die nichts mit
      dem einzigen Zweck des Artikels zu tun haben.
- [x] Ich verwende oder übertrage Nutzerdaten nicht, um die Kreditwürdigkeit zu
      bestimmen oder für Kreditvergabezwecke.

### URL der Datenschutzerklärung

```
https://github.com/schreibwerkstatt/browser-extension/blob/main/store/privacy-policy.de.md
```

> Pflichtfeld, sobald Nutzerdaten verarbeitet werden — hier also unvermeidbar.
> Die URL oben funktioniert, sobald der Stand gepusht ist: das Repository ist
> öffentlich, GitHub rendert die Datei, und der Link bleibt stabil. Voraussetzung
> ist nur, dass in [privacy-policy.de.md](privacy-policy.de.md) der
> Verantwortliche eingetragen ist.
>
> Hübscher wäre eine eigene Seite auf deiner Schreibwerkstatt-Domain oder GitHub
> Pages — beides optional, siehe
> [PUBLISHING.md](PUBLISHING.md#3-datenschutzerklärung-veröffentlichen).
> **Vor dem Einreichen die URL einmal im Browser aufrufen.** Ist sie nicht
> erreichbar, ist das ein Ablehnungsgrund.

---

## Tab „Vertrieb"

| Feld | Wert |
|---|---|
| Sichtbarkeit | **Nicht aufgeführt** (*Unlisted*) — Begründung: [PUBLISHING.md](PUBLISHING.md#4-sichtbarkeit-wählen) |
| Vertrieb | Alle Regionen |
| Preis | Kostenlos |
| Für Chrome-Nutzer verfügbar | ja |
| Für ChromeOS-Nutzer verfügbar | ja (schadet nicht, die Erweiterung läuft dort unverändert) |

---

## Tab „Testanleitung"

Text steht in [test-instructions.md](test-instructions.md). Dieses Feld nicht
leer lassen: ohne Serveradresse und Token kann der Prüfer die Erweiterung nicht
bedienen, und was sich nicht bedienen lässt, wird abgelehnt.
