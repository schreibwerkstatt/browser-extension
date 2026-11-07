# Im Chrome Web Store veröffentlichen

Alles, was für die Einreichung gebraucht wird, liegt in diesem Ordner. Die Texte
sind zum Kopieren geschrieben, nicht zum Umschreiben.

| Datei | Inhalt |
|---|---|
| [listing-de.md](listing-de.md) | alle Formularfelder des Eintrags, deutsch — Beschreibung, Kategorie, Berechtigungsbegründungen, Datennutzungs-Angaben |
| [listing-en.md](listing-en.md) | dieselben Texte für die zweite Sprache des Eintrags |
| [privacy-policy.de.md](privacy-policy.de.md) · [privacy-policy.en.md](privacy-policy.en.md) | die Datenschutzerklärung, die unter einer öffentlichen URL stehen muss |
| [test-instructions.md](test-instructions.md) | Anleitung für den Prüfer — der wichtigste Text der Einreichung |
| `assets/` | Werbekacheln (`npm run promo`) und Screenshots (`npm run shots`) |

**Vorher lesen:** [Zwei Dinge, die hier schiefgehen können](#zwei-dinge-die-hier-schiefgehen-können).
Beide betreffen genau diese Erweiterung und nicht Erweiterungen im Allgemeinen.

---

## Inhalt

- [Zwei Dinge, die hier schiefgehen können](#zwei-dinge-die-hier-schiefgehen-können)
- [Brauchst du den Store überhaupt?](#brauchst-du-den-store-überhaupt)
- [1. Entwicklerkonto anlegen](#1-entwicklerkonto-anlegen)
- [2. Paket bauen](#2-paket-bauen)
- [3. Datenschutzerklärung veröffentlichen](#3-datenschutzerklärung-veröffentlichen)
- [4. Sichtbarkeit wählen](#4-sichtbarkeit-wählen)
- [5. Screenshots aufnehmen](#5-screenshots-aufnehmen)
- [6. Einreichen](#6-einreichen)
- [7. Die Prüfung](#7-die-prüfung)
- [8. Aktualisieren](#8-aktualisieren)
  - [Automatisch aktualisieren](#automatisch-aktualisieren)
- [Checkliste](#checkliste)

---

## Zwei Dinge, die hier schiefgehen können

### Der Prüfer kann die Erweiterung nicht bedienen

Ohne Schreibwerkstatt-Server und Gerätetoken tut die Erweiterung nichts. Wer das
Popup öffnet, sieht „Nicht verbunden" — und eine Erweiterung, die nicht tut, was
ihre Beschreibung ankündigt, wird abgelehnt.

**Das ist das größte Risiko dieser Einreichung, und der Plan dagegen steht:** eine
**Demo-Instanz** der Schreibwerkstatt im Mutterprojekt, mit geseedeten Büchern
und einem Gerätetoken, deren Werte in die Testanleitung wandern. Damit bedient
der Prüfer die echte Anwendung — der glatteste Weg durch die Prüfung, weil der
Formulartext dann keinen Vorbehalt braucht.

Worauf beim Seed zu achten ist (Details in
[test-instructions.md](test-instructions.md#was-die-demo-instanz-mitbringen-sollte)):
mindestens ein beschreibbares Buch, **keine echten E-Mail-Adressen** — denn
`GET /content/books` gibt zu jedem Buch die `owner_email` heraus und der Prüfer
sieht die Antwort —, ein Token mit Erfassungs-Berechtigung, das nicht in den
nächsten Wochen abläuft, HTTPS, und ein nächtliches Zurücksetzen der Demo-Daten.
Letzteres, weil der API-Vertrag kein `DELETE /research/:id` kennt und die
Einträge des Prüfers sonst liegenbleiben.

Falls die Demo-Instanz noch nicht steht, überbrückt
`npm run review-server` das ohne Mutterprojekt —
[tools/review-server.mjs](../tools/review-server.mjs) bietet denselben
API-Vertrag an, gegen den `test/integration.test.js` prüft. Das ist Variante B;
sie braucht im Formulartext einen Vorbehalt, weil es nicht die echte Anwendung
ist.

**Die Produktion ist der falsche Weg**, auch mit eigenem Token: sie leakt die
Titel aller Buchprojekte samt `owner_email` der Eigentümer, und die Testeinträge
des Prüfers musst du von Hand wegräumen. Begründung ausgeschrieben unter
[Variante C](test-instructions.md#variante-c--produktions-token).

### Das weite Host-Muster fällt auf

Im Manifest steht:

```json
"optional_host_permissions": [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://*.localhost/*"
]
```

`https://*/*` steht auf der Liste der Muster, die Google ausdrücklich genauer
ansieht — die Prüfung dauert dadurch länger. Dass es hier unter `optional_`
steht und zur Laufzeit nur **ein** Origin angefragt wird, ist der entscheidende
Unterschied, aber niemand sieht ihn, wenn er nicht dasteht. Die
Berechtigungsbegründung in [listing-de.md](listing-de.md#begründung-je-berechtigung)
erklärt es; kopiere sie vollständig, nicht gekürzt.

**Das weite `http://*/*` ist bereits entfernt.** Es war nur für eine lokale
Entwicklungsinstanz da; jetzt stehen dort ausschließlich localhost-Muster. Damit
lässt sich keine unverschlüsselte Adresse außerhalb von localhost mehr eintragen
— kein `http://192.168.1.20:3000`, kein `http://dev.intern`. Die Options-Seite
**lehnt** eine solche Adresse ab, statt sie nur zu bemängeln; sie ließe sich
ohnehin nicht anfordern. [test/manifest.test.js](../test/manifest.test.js) hält
Manifest und Options-Logik zusammen.

> In einem echten Chrome 150 nachgemessen: für `https://…`,
> `http://localhost:3000`, `http://127.0.0.1:8080` und
> `http://werkstatt.localhost` erscheint der Berechtigungsdialog;
> `http://192.168.1.20:3000` und `http://dev.intern` weist Chrome selbst ab
> („Only permissions specified in the manifest may be requested"). Die
> Options-Seite fängt diesen Fall schon vorher ab, damit niemand diese Meldung
> zu sehen bekommt.
>
> Was ein Skript nicht abnehmen kann, ist der Klick im Dialog. Also einmal von
> Hand: `http://localhost:3000` eintragen, „Zugriff erlauben" drücken, und die
> Zeile muss danach „ist erteilt" sagen.

> `https://*/*` selbst lässt sich **nicht** verengen. Bei einer selbst
> gehosteten App ist die Adresse pro Nutzer verschieden, und Manifest V3 kennt
> keinen Weg, ein zur Laufzeit bestimmtes Origin anzufordern, das nicht vorab im
> Manifest deklariert ist. Das ist der eigentliche Grund für das weite Muster
> und gehört genau so in die Begründung.

---

## Brauchst du den Store überhaupt?

Für dich allein: nein. `npm run build` und „Entpackte Erweiterung laden" in
`chrome://extensions` funktioniert dauerhaft. Preis dafür: der
Entwicklermodus-Hinweis bei jedem Chrome-Start, und Updates baust und lädst du
selbst.

Der Store bringt drei Dinge:

- automatische Updates
- Installation auf einem anderen Rechner mit einem Klick
- kein Entwicklermodus-Hinweis, keine dauerhaft eingeschaltete Warnung

Wenn du die Erweiterung auf mehr als einem Gerät benutzt, lohnt sich der Weg.
Für ein einziges Gerät ist er Zierde. Die 5 US-Dollar sind einmalig, nicht pro
Erweiterung.

---

## 1. Entwicklerkonto anlegen

1. <https://chrome.google.com/webstore/devconsole> öffnen.
2. Entwicklervertrag und Richtlinien annehmen.
3. **5 US-Dollar** einmalig zahlen. Das gilt für alle künftigen Erweiterungen,
   bis zu 20 veröffentlichte pro Konto.
4. Kontaktadresse eintragen und **bestätigen**. Unbestätigt lässt sich nichts
   veröffentlichen.
5. Bestätigung in zwei Schritten ist für das Konto Pflicht.

**Zwei Dinge, die sich später nicht mehr ändern lassen — beide sind entschieden:**

- **Die E-Mail-Adresse des Kontos:** `bede.berger@gmail.com`. Dieselbe Adresse
  steht als Verantwortlicher in der Datenschutzerklärung, und sie ist bereits
  ein Google-Konto — das Entwicklerkonto braucht eines. Nicht die
  Firmenadresse: Verantwortlicher ist David Berger persönlich, und Store-Konto
  und Datenschutzerklärung sollten dieselbe Person nennen.

  Der Wechsel wäre teuer: du brauchst dafür ein neues Konto und musst die
  Erweiterungen per Support-Formular übertragen. Die Adresse eines gelöschten
  Kontos ist danach dauerhaft verbrannt und nicht wiederverwendbar.
- **Der Publisher-Name:** `David Berger`. Steht unter dem Titel jeder deiner
  Erweiterungen und deckt sich so mit dem Verantwortlichen in der
  Datenschutzerklärung. Ein Prüfer, der beides vergleicht, findet dasselbe —
  genau das ist der Zweck.

---

## 2. Paket bauen

```bash
npm test
npm run package
```

Ergebnis: `store/schreibwerkstatt-chrome-<version>.zip`, dazu Dateizahl, Größe
und SHA-256 auf der Konsole.

Was `npm run package` dabei sicherstellt:

- baut vorher neu, damit nichts Altes mitgeht
- `manifest.json` liegt im Wurzelverzeichnis des Archivs (sonst weist der Store
  es ab)
- Version in Manifest und `package.json` stimmen überein
- die Versionsnummer ist store-tauglich (1–4 Zahlen von 0 bis 65535, keine
  führenden Nullen)
- keine Sourcemaps und keine versteckten Dateien im Paket

Das Archiv ist reproduzierbar: gleiches `dist/` ergibt Byte für Byte dasselbe
ZIP. Notier die SHA-256, dann kannst du später belegen, welcher Stand
hochgegangen ist.

> `npm run watch` erzeugt Inline-Sourcemaps. Vor dem Packen immer einmal
> `npm run build` — `npm run package` macht das von selbst.

Für einen versionierten Stand samt Tag und GitHub-Release gibt es den
Claude-Code-Befehl **`/release`**
([.claude/commands/release.md](../.claude/commands/release.md)): er prüft den
Arbeitsbaum, erhöht auf Wunsch die Version, lässt `npm test` und
`npm run package` laufen, taggt, pusht und hängt das ZIP an ein GitHub-Release.
Den Store-Upload nimmt er **nur mit `--store`** vor — ohne diesen Schalter endet
er am GitHub-Release, siehe [Automatisch aktualisieren](#automatisch-aktualisieren).
Nötig ist der Befehl nicht; er ersetzt nur das Von-Hand-Tippen dieser Schritte.

Die **erste** Einreichung geht nicht über die API: `POST …/items` kennt sie
nicht, und Eintragstexte, Screenshots, Datenschutzangaben und Sichtbarkeit füllt
ohnehin nur das Dashboard. Automatisieren lässt sich die *Aktualisierung* eines
Eintrags, der schon existiert.

Der Code ist bewusst nicht minifiziert. Minifizieren wäre erlaubt, macht die
Prüfung aber langsamer; Obfuskieren ist verboten. So bleibt es, wie es ist.

---

## 3. Datenschutzerklärung veröffentlichen

Pflichtfeld, weil die Erweiterung Nutzerdaten verarbeitet. Der Text steht
vollständig in [privacy-policy.de.md](privacy-policy.de.md) und
[privacy-policy.en.md](privacy-policy.en.md) — Verantwortlicher und
Kontaktadresse sind eingetragen, nichts mehr auszufüllen. Er muss nur noch unter
einer **öffentlich erreichbaren, dauerhaften** URL stehen.

Weil das Repository öffentlich ist, ist der kürzeste Weg schon gangbar:

```
https://github.com/schreibwerkstatt/browser-extension/blob/main/store/privacy-policy.de.md
```

Kein Setup, GitHub rendert das Markdown, der Link bleibt stabil, solange die
Datei auf `main` liegt. Das genügt dem Store — ein bestimmtes Format verlangt er
nicht. Nur pushen musst du vorher.

Schöner wird es so, falls dich die GitHub-Oberfläche um das Dokument herum
stört:

1. **Eine Seite auf deiner Schreibwerkstatt-Domain**, z. B.
   `https://schreibwerkstatt.example.org/extension-privacy`. Am stimmigsten:
   dieselbe Domain, die im Eintrag als Server-Beispiel auftaucht.
2. **GitHub Pages** für dieses Repo einschalten (Settings → Pages, Quelle
   `main`). Die Datei liegt dann als eigene Seite unter
   `schreibwerkstatt.github.io/browser-extension/store/privacy-policy.de`
   — sauberer, aber ein Schritt mehr.

Nicht geeignet: alles, was einen Login braucht, ablaufen kann oder nur über einen
Kurzlink erreichbar ist. Auch **nicht** die `raw.githubusercontent.com`-Variante:
die liefert `text/plain` und liest sich für einen Prüfer nicht wie ein
veröffentlichtes Dokument.

> Welche URL du auch nimmst: ruf sie vor dem Einreichen einmal in einem
> **abgemeldeten** Browserfenster auf. Die Prüfung ruft sie auf, und eine nicht
> erreichbare Datenschutz-URL ist ein Ablehnungsgrund.

---

## 4. Sichtbarkeit wählen

Alle drei Stufen gehen durch **dieselbe** Prüfung mit denselben
Richtlinienanforderungen — „nicht aufgeführt" ist keine Abkürzung.

| Stufe | Wer kann installieren | Passt hier |
|---|---|---|
| **Öffentlich** | jeder; erscheint in Suche und Kategorien | nur wenn du wirklich Fremde ansprechen willst |
| **Nicht aufgeführt** | jeder, der die URL kennt; nicht auffindbar | ✅ **Empfehlung** |
| **Privat** | nur benannte Test-Konten oder eine Google-Gruppe | wenn außer dir niemand ran soll |

**Empfehlung: nicht aufgeführt.** Die Erweiterung ist ohne eigene
Schreibwerkstatt-Installation nutzlos. Ein öffentlicher Eintrag holt sich
Installationen von Leuten, die keinen Server haben, und die schreiben dann
Ein-Stern-Bewertungen mit „geht nicht" — was sachlich stimmt und dir nichts
bringt. Du bekommst weiterhin automatische Updates und einen Link zum Teilen.

**Privat** ist die engste Stufe. Nachteil: du musst jedes Konto einzeln als
Tester eintragen, und die Erweiterung erscheint nur diesen Konten. Für „nur ich,
auf drei Rechnern" reicht das und ist sauberer als „nicht aufgeführt".

Umstellen kannst du jederzeit — von „privat" oder „nicht aufgeführt" auf
„öffentlich" braucht es allerdings eine erneute Prüfung.

Weitere Felder im Vertriebs-Tab: **kostenlos**, **alle Regionen**.

---

## 5. Screenshots aufnehmen

Mindestens einer ist Pflicht, bis zu fünf gehen. **1280 × 800 Pixel**, PNG oder
JPEG, randlos, keine abgerundeten Ecken, kein Rahmen.

Drei Motive nimmt ein Werkzeug ab:

```bash
SHOTS_TOKEN=swd_… npm run shots          # deutsch
SHOTS_LANG=en SHOTS_TOKEN=swd_… npm run shots   # englisch, Dateien mit -en
```

[tools/make-shots.mjs](../tools/make-shots.mjs) startet Chrome mit einem
Wegwerf-Profil, lädt `dist/`, richtet die Verbindung gegen die Demo-Instanz
**wirklich ein** — Adresse und Token in die Maske, speichern, Verbindung testen,
Bücher laden — und legt in `store/assets/` ab:

| Datei | Motiv |
|---|---|
| `shot-1-popup.png` | Popup über einem Fachartikel, Felder gefüllt, Herkunftszeile sichtbar |
| `shot-2-options.png` | Options-Seite mit Adresse, Token, Verbindungstest, Standardbuch |
| `shot-3-queue.png` | Serverfähigkeiten, Warteschlange, „Was verlässt den Browser" |

Stellschrauben: `SHOTS_SERVER`, `SHOTS_ARTICLE` (Vorgabe ist ein
arXiv-Abstract mit vollständigen `citation_*`-Metadaten), `SHOTS_THEME=dark`,
`SHOTS_PORT`, `SHOTS_DEBUG=1`.

Zwei Dinge daran sind erwähnenswert, weil sie sonst beim nächsten Lesen
verwundern:

- Das Werkzeug kopiert `dist/` und trägt in der Kopie Server- und Artikel-Origin
  unter `host_permissions` ein. Nicht um zu schummeln, sondern weil
  `chrome.permissions.request()` und `activeTab` eine echte Mausgeste
  verlangen, die sich nicht fernsteuern lässt. Gezeigt wird derselbe Code mit
  echten Daten vom Server.
- `--load-extension` gibt es seit Chrome 137 nicht mehr; entpackt geladen wird
  über `Extensions.loadUnpacked` im DevTools-Protokoll.

**Zwei Motive bleiben Handarbeit** — beide zeichnet das Betriebssystem, kein
Fernsteuerungsprotokoll bekommt sie zu fassen:

- **Kontextmenü** „Als Zitat erfassen" bei markiertem Text
- **Benachrichtigung** mit dem Rückgängig-Knopf (das Fenster sind 6 Sekunden)

Auf dem Mac: `Umschalt+Cmd+4`, dann Leertaste für das ganze Fenster. Danach auf
genau 1280 × 800 bringen (Rezept unten). Pflicht sind sie nicht — die drei
automatisch erzeugten Bilder reichen für die Einreichung.

### Genau 1280 × 800 treffen (für die beiden Bilder von Hand)

`npm run shots` misst seine Bilder selbst nach. Für die zwei Motive, die du
selbst aufnimmst, gilt: Chrome mit fester Fenstergröße und eigenem Profil, damit
keine anderen Erweiterungen ins Bild geraten. Auf dem Mac:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/cws-shots \
  --window-size=1280,800 \
  --window-position=0,0 \
  --force-device-scale-factor=1 \
  --enable-unsafe-extension-debugging \
  --no-first-run
```

Die Erweiterung lädst du darin von Hand über `chrome://extensions` →
„Entpackte Erweiterung laden" → `dist/`. Der frühere Weg über
`--load-extension` funktioniert seit Chrome 137 nicht mehr; der Schalter wird
stillschweigend ignoriert, und die Erweiterung fehlt einfach.

Auf einem HiDPI-Bildschirm ist `--force-device-scale-factor=1` nicht optional:
sonst liefert der Screenshot 2560 × 1600, und der Store lehnt das Bild ohne
brauchbare Meldung ab.

Der Fensterinhalt ist wegen der Titelleiste kleiner als 1280 × 800. Nimm also
den Bildschirm auf und schneide zu, oder — genauer — nimm den Inhaltsbereich mit
DevTools auf: `Cmd+Umschalt+P` → *Capture screenshot*. Danach immer die Maße
kontrollieren:

```bash
file screenshot.png    # muss "1280 x 800" zeigen
```

Passt es nicht:

```bash
# hochskalieren/beschneiden auf genau 1280x800, mit Papierfarbe auffüllen
convert screenshot.png -resize 1280x800 -background '#f7f4ee' \
  -gravity center -extent 1280x800 shot-1.png
```

### Für den englischen Eintrag

`SHOTS_LANG=en npm run shots` — die Dateien bekommen dann `-en` angehängt.

Von Hand ist es auf dem Mac umständlicher: `--lang=en-US` allein reicht nicht,
macOS zieht die Oberflächensprache aus den Systemeinstellungen. Chrome mit
`-AppleLanguages "(en-US)"` als zusätzlichem Argument starten — genau das macht
das Werkzeug.

### Beschriftung

Der Store zeigt keine Bildunterschriften. Wenn du erklären willst, was zu sehen
ist, muss es ins Bild — ein Balken oben mit einer kurzen Zeile in
`#22405f` auf `#f7f4ee` passt zu den Kacheln. Optional; unbeschriftete
Screenshots sind zulässig.

### Werbekacheln

```bash
npm run promo
```

Erzeugt `store/assets/promo-small-440x280.png` und
`store/assets/promo-marquee-1400x560.png`, gerendert mit dem installierten
Chrome, und prüft die Maße nach. Die kleine Kachel ist formal optional, aber ohne
sie wird der Eintrag in der Store-Suche schlechter platziert — also hochladen.
Das Motiv steht als Quelltext in [../tools/make-promo.mjs](../tools/make-promo.mjs)
und lässt sich dort ändern.

---

## 6. Einreichen

<https://chrome.google.com/webstore/devconsole> → **Neues Element hinzufügen** →
ZIP hochladen. Danach vier Tabs, in dieser Reihenfolge:

**Store-Eintrag** — Beschreibung, Kategorie, Sprache, Symbol, Screenshots,
Kacheln. Alles aus [listing-de.md](listing-de.md). Danach die Sprache `English`
hinzufügen und [listing-en.md](listing-en.md) einsetzen.

**Datenschutzpraktiken** — einziger Zweck, Begründung für **jede** Berechtigung,
nachgeladener Code (**nein**), Datennutzungs-Angaben, drei Zertifizierungen, URL
der Datenschutzerklärung. Ebenfalls alles in
[listing-de.md](listing-de.md#tab-datenschutzpraktiken). Keine Begründung
auslassen — eine leere Zeile ist ein Ablehnungsgrund.

**Vertrieb** — nicht aufgeführt, kostenlos, alle Regionen.

**Testanleitung** — aus [test-instructions.md](test-instructions.md),
Variante A. Nicht leer lassen, und vorher prüfen, dass die Demo-Instanz läuft:
Adresse und Token müssen in dem Moment funktionieren, in dem du einreichst, und
danach bis zum Abschluss weiter.

Dann **Zur Prüfung einreichen**. Zur Wahl steht außerdem, nach der Freigabe
nicht automatisch, sondern von Hand zu veröffentlichen — das Zeitfenster dafür
sind 30 Tage. Bei einer nicht aufgeführten Erweiterung bringt das nichts;
automatisch ist einfacher.

---

## 7. Die Prüfung

Die Bandbreite ist groß und die Angaben widersprechen sich, weil beides stimmt:
eine kleine Erweiterung mit engen Berechtigungen kann in unter einer Stunde
durch sein, die Mehrheit ist innerhalb eines Tages durch, und bei
Einreichungswellen dauert es Wochen. Im Frühjahr 2026 gab es eine solche Welle
mit Wartezeiten von über einem Monat.

Rechne bei dieser Erweiterung mit **mehreren Tagen bis zwei Wochen**: neues
Konto, neue Erweiterung und ein weites Host-Muster sind drei Gründe für einen
genaueren Blick.

**Nicht erneut einreichen, solange die Prüfung läuft.** Das setzt die Uhr auf
null und kann das Konto wegen schneller Wiedereinreichungen markieren. Warte ab.

Was hier für dich spricht: kein `eval`, kein `innerHTML`, keine externe Adresse
im Paket, kein nachgeladener Code, unminifizierter Quelltext, 230 durchlaufende
Tests und ausformulierte Begründungen für jede einzelne Berechtigung.

Bei einer Ablehnung nennt die E-Mail den verletzten Richtlinienabschnitt. Meist
geht es um eine schwache Berechtigungsbegründung oder eine unerreichbare
Datenschutz-URL; beides ist an einem Nachmittag zu beheben. Antworten kannst du
über das Formular im Dashboard.

---

## 8. Aktualisieren

```bash
# Version in package.json erhöhen — sie ist die einzige Quelle,
# build.mjs schreibt sie ins Manifest
npm version patch --no-git-tag-version

npm test
npm run package
```

Dieselben drei Schritte macht `/release` mit `patch`, `minor` oder `major` als
Argument — und legt zusätzlich Tag und GitHub-Release an.

Dann im Dashboard **Paket** → **Neues Paket hochladen** → einreichen.

- Die Version **muss** höher sein als die veröffentlichte. Der Store nimmt
  dieselbe Nummer nicht zweimal.
- Jede Aktualisierung geht erneut durch die Prüfung, meist schneller als die
  erste.
- Kommen **neue Berechtigungen** dazu, deaktiviert Chrome die Erweiterung bei
  allen Nutzern, bis sie zustimmen. Berechtigungen also möglichst nur nach unten
  ändern.
- Änderungen am Eintragstext allein brauchen kein neues Paket, gehen aber
  ebenfalls durch die Prüfung.

Ändert sich der Umfang der übertragenen Daten, gehören Datenschutzerklärung und
Datennutzungs-Angaben im selben Zug angepasst.

### Automatisch aktualisieren

Hochladen und Einreichen nimmt die **Chrome Web Store API** ab. Zwei Werkzeuge:

```bash
npm run store:auth                        # einmalig: Refresh-Token holen
npm run store:publish -- --dry-run        # prüfen, ohne etwas zu senden
npm run store:publish                     # hochladen und einreichen
```

Weitere Schalter von `store:publish`: `--upload-only` (Entwurf stehen lassen),
`--publish-only` (den vorhandenen Entwurf einreichen), `--target=trustedTesters`,
`--version=x.y.z`, `--zip=<pfad>`. Ohne Angabe nimmt es die Version aus
`package.json` und das dazu passende ZIP aus `store/`.

Denselben Aufruf hängt **`/release --store`** hinter das GitHub-Release. Ohne
`--store` geht nichts an den Store — der Schalter ist Absicht: `/release` läuft
ohne Rückfrage durch, und eine Einreichung ist nach außen wirksam und nicht
zurücknehmbar.

#### Einrichtung bei Google (einmalig)

1. **Item-ID** aus der Dashboard-URL des Eintrags notieren (32 Kleinbuchstaben).
2. Ein **Google-Cloud-Projekt** unter demselben Konto anlegen und darin die
   **Chrome Web Store API** aktivieren.
3. **OAuth-Zustimmungsbildschirm** einrichten, Nutzertyp „Extern", Scope
   `https://www.googleapis.com/auth/chromewebstore`.
4. **OAuth-Client-ID** vom Typ **„Desktop-App"** erzeugen → `client_id` und
   `client_secret`. Der Typ ist nicht beliebig: nur er darf auf die
   Loopback-Adresse `http://127.0.0.1` mit beliebigem Port zurückleiten, und
   genau das braucht `npm run store:auth` (mit `state` und PKCE).
5. Die drei Werte nach `~/.config/schreibwerkstatt-cws.json` schreiben:

   ```json
   {
     "item_id": "…",
     "client_id": "….apps.googleusercontent.com",
     "client_secret": "…"
   }
   ```

6. `npm run store:auth` — öffnet den Zustimmungsbildschirm, fängt den Code auf
   einer Loopback-Adresse auf und ergänzt das `refresh_token` in derselben
   Datei. Der Warnhinweis „Google hat diese App nicht verifiziert" ist erwartbar;
   es ist die eigene App, weiter über „Erweitert".

> **Zum Status „Testing".** Dort verfallen Refresh-Token nach **sieben Tagen** —
> der nächste Release scheitert dann mit `invalid_grant`. Auf „In Produktion"
> gestellt, hält das Token dauerhaft; eine Google-Verifizierung braucht dieser
> Scope nicht, der Warnhinweis beim eigenen Login bleibt und ist folgenlos.
>
> Geht das Umstellen nicht, ist das **kein Blocker**: `npm run store:auth` ist
> ein Browser-Klick und lässt sich vor jedem Release wiederholen. Damit das nicht
> erst nach dem Push auffällt, prüft `/release --store` das Token schon in
> Schritt 4, direkt nach dem Packen.

#### Wo die Zugangsdaten liegen — und wo nicht

**Nicht im Repository.** Es ist öffentlich, und `/release` committet mit
`git add -A` alles, was es findet; eine `.gitignore`-Zeile ist dagegen keine
Sicherung, sondern eine Bitte. Vorgabe ist deshalb
`~/.config/schreibwerkstatt-cws.json` mit Rechten 600 — die Werkzeuge setzen sie
selbst und **brechen ab**, wenn die Datei im Arbeitsbaum liegt.

Ein anderer Pfad geht mit `CWS_CONFIG`, einzelne Werte mit `CWS_ITEM_ID`,
`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` — die Umgebung gewinnt
über die Datei. Das Access-Token wird bei jedem Aufruf frisch geholt und nirgends
gespeichert.

#### Was die API nicht abnimmt

- **Sie veröffentlicht nicht.** Sie reicht ein; alles danach entscheidet die
  Prüfung. Die Regel [Nicht erneut einreichen, solange die Prüfung
  läuft](#7-die-prüfung) gilt unverändert — kommt `ITEM_PENDING_REVIEW`, bricht
  `store:publish` ab, statt es nochmal zu versuchen.
- **Eintragstexte, Screenshots, Datenschutzangaben und Sichtbarkeit** bleiben
  Dashboard-Arbeit.
- **Dieselbe Versionsnummer nimmt der Store nicht zweimal.** `store:publish`
  vergleicht vorher mit dem Entwurf im Store und bricht früh ab, statt den
  Upload-Fehler abzuwarten.
- **Neue Berechtigungen** deaktivieren die Erweiterung bei allen Nutzern, bis sie
  zustimmen — daran ändert der automatische Weg nichts, er macht es nur leichter
  zu übersehen. Vor `--store` also einmal auf das Manifest schauen.

---

## Checkliste

Vor dem Einreichen:

- [ ] Entwicklerkonto auf `bede.berger@gmail.com` angelegt, 5 USD bezahlt,
      E-Mail bestätigt, 2FA aktiv
- [ ] Publisher-Name `David Berger` gesetzt (nicht änderbar)
- [ ] `npm test` läuft durch
- [ ] `npm run package` erzeugt das ZIP, SHA-256 notiert
- [ ] Stand nach `main` gepusht, damit die Datenschutz-URL den fertigen Text zeigt
- [ ] Datenschutz-URL in einem abgemeldeten Browserfenster aufgerufen
- [ ] Demo-Instanz steht, über HTTPS erreichbar, Seed ohne echte
      E-Mail-Adressen, Token läuft nicht in den nächsten Wochen ab
- [ ] Testanleitung ausgefüllt: `<DEMO-URL>`, `<DEMO-TOKEN>` und `<DEMO-BUCH>`
      eingesetzt — Restliste in
      [test-instructions.md](test-instructions.md#vor-dem-absenden)
- [ ] Einrichtung in einem frischen Chrome-Profil einmal selbst durchgeklickt,
      so wie der Prüfer sie vorfindet
- [ ] `npm run promo` gelaufen, beide Kacheln vorhanden
- [ ] `npm run shots` gelaufen, drei Screenshots in genau 1280 × 800
      (das Werkzeug misst nach und meckert sonst)
- [ ] Begründung für jede der sechs Berechtigungen **und** für die
      Host-Berechtigung eingesetzt
- [ ] nachgeladener Code: **nein** angegeben
- [ ] Datennutzung: Website-Inhalte und Authentifizierungsdaten angehakt
- [ ] alle drei Zertifizierungen bestätigt
- [ ] Sichtbarkeit auf „nicht aufgeführt" gestellt
- [ ] `http`-Muster in einem echten Chrome nachgeprüft: localhost wird erteilt,
      eine nicht-lokale `http`-Adresse abgewiesen
      ([warum](#das-weite-host-muster-fällt-auf))

---

## Quellen

Stand Juli 2026. Google ändert die Formulare öfter als die Dokumentation.

- [Entwicklerkonto registrieren](https://developer.chrome.com/docs/webstore/register)
- [Veröffentlichen](https://developer.chrome.com/docs/webstore/publish)
- [Prüfprozess](https://developer.chrome.com/docs/webstore/review-process)
- [Grafische Anforderungen](https://developer.chrome.com/docs/webstore/images)
- [Tab „Store-Eintrag"](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Tab „Datenschutzpraktiken"](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Tab „Vertrieb"](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Programmrichtlinien](https://developer.chrome.com/docs/webstore/program-policies)
