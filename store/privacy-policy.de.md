# Datenschutzerklärung — Schreibwerkstatt – Erfassen (Chrome-Erweiterung)

**Stand:** 31. Juli 2026
**Verantwortlich:** David Berger, bede.berger@gmail.com

> Diese Datei ist der Text, der unter der im Chrome Web Store angegebenen URL
> erreichbar sein muss. Sobald der aktuelle Stand auf `main` liegt, erfüllt
> <https://github.com/schreibwerkstatt/browser-extension/blob/main/store/privacy-policy.de.md>
> diese Anforderung — weitere Wege in
> [PUBLISHING.md](PUBLISHING.md#3-datenschutzerklärung-veröffentlichen).
> Der Text ist vollständig; nichts mehr einzutragen.

---

## Kurz gesagt

Diese Erweiterung sendet Daten ausschließlich an den Server, den du selbst in
ihren Einstellungen eingetragen hast. Die Entwicklung dieser Erweiterung erhebt,
empfängt, speichert und verarbeitet keinerlei Daten über dich. Es gibt keinen
Dienst, der dahintersteht, und keine Adresse, an die sonst etwas ginge.

## 1. Wer verarbeitet was

Die Erweiterung ist ein Zubehör zu einer **selbst gehosteten** Schreib-App
namens Schreibwerkstatt. Du betreibst diesen Server oder hast Zugang zu ihm; die
Adresse trägst du in den Einstellungen der Erweiterung ein.

Damit gibt es zwei getrennte Rollen:

- **Die Erweiterung** überträgt Daten von deinem Browser an genau diesen einen
  Server. Sie leitet nichts weiter, spiegelt nichts und meldet nichts nach Hause.
- **Der Server**, den du eingetragen hast, verarbeitet die dort ankommenden
  Daten. Wofür er sie verwendet und wie lange er sie behält, richtet sich nach
  der Konfiguration und der Datenschutzerklärung dieser Installation — nicht
  nach dieser hier.

Für den Betreiber dieser Erweiterung besteht **kein Zugriff** auf die von dir
erfassten Inhalte.

## 2. Welche Daten die Erweiterung überträgt

Ausschließlich das, was zu einem einzelnen, von dir ausgelösten
Erfassungsvorgang gehört:

| Datum | Wann |
|---|---|
| Titel, Haupttext oder markiertes Zitat der offenen Seite | bei jeder Erfassung |
| URL der Seite (um bekannte Tracking-Parameter bereinigt) und Abrufdatum | bei jeder Erfassung |
| Bibliografische Angaben, die auf der Seite stehen: Autor:innen, Zeitschrift, Verlag, Jahr, DOI, ISBN | bei jeder Erfassung, sofern vorhanden |
| Deine eigenen Eingaben: Schlagwörter, Notiz, Zitierschlüssel, Buchauswahl | bei jeder Erfassung |
| Screenshot des sichtbaren Tab-Bereichs | nur wenn du das Häkchen setzt |
| PDF der Seite | nur wenn du das Häkchen setzt und die Seite ein `citation_pdf_url` auf demselben Host angibt |
| Dein Gerätetoken im `Authorization`-Header | bei jeder Anfrage — er authentifiziert dich gegenüber deinem eigenen Server |
| `X-Client-Platform` (`chrome`), `X-Client-Device` (Browsername, -version, Betriebssystem, z. B. `Google Chrome 131 / Linux`), `X-Client-Version` (Plattform und Version der Erweiterung, z. B. `chrome/1.1.1`) | bei jeder Anfrage — damit dein Server erkennt, woher ein Eintrag kam |

**Empfänger:** allein der von dir eingetragene Host. Es existiert keine weitere
Gegenstelle.

## 3. Welche Daten die Erweiterung nicht anfasst

- **Kein Browserverlauf.** Es gibt keine `history`- und keine
  `tabs`-Berechtigung. Die Erweiterung erfährt nicht, welche Seiten du besuchst.
  Übertragen wird nur die einzelne Seite, die du ausdrücklich erfasst.
- **Keine automatische Erfassung.** Der Service Worker wird nur durch deine
  Aktion aktiv — oder durch die fällige Wiederholung eines Eintrags, den du
  selbst erzeugt hast.
- **Kein Zugriff auf Seiten, auf denen du nichts auslöst.** Es gibt kein
  dauerhaft registriertes Content-Script. Das Ernte-Script wird über die
  `activeTab`-Berechtigung genau in dem Moment injiziert, in dem du klickst,
  und verschwindet mit dem nächsten Seitenwechsel.
- **Keine Cookies, keine Formularfelder, kein `localStorage`** der besuchten
  Seite. Das Ernte-Script liest `<meta>`-Elemente, JSON-LD, den Seitentext und
  die aktuelle Textmarkierung. Eigene Netzwerkanfragen stellt es nicht.
- **Kein Tracking, kein Analytics, keine Telemetrie, kein Crash-Reporting.**
- **Kein Drittanbieter-Code, kein CDN, keine externen Schriftarten.** Es wird
  kein Code nachgeladen; die Content-Security-Policy der Erweiterung erlaubt
  als Skriptquelle nur `'self'`.
- **Keine Werbung, kein Verkauf und keine Weitergabe von Daten.** An niemanden,
  zu keinem Zweck.

## 4. DOI- und ISBN-Recherche

Fragst du in der Erweiterung kanonische Angaben ab, geht diese Anfrage an
**deinen** Server (`GET /sources/lookup`). Er befragt Crossref bzw. OpenLibrary
serverseitig. Dein Browser spricht nie direkt mit diesen Diensten; sie sehen
deine IP-Adresse nicht.

## 5. Was lokal gespeichert wird

In `chrome.storage.local` auf deinem Gerät:

- die Serveradresse und dein Gerätetoken
- die vom Server geladene Buchliste
- deine Einstellungen (Standardbuch, Länge des Rückgängig-Fensters,
  Benachrichtigungen an oder aus)
- die Warteschlange noch nicht gesendeter Erfassungen

Ausdrücklich **nicht** in `chrome.storage.sync`: das Token soll nicht über dein
Google-Konto auf andere Rechner wandern. Chrome bietet Erweiterungen keinen
Schlüsselbund, das Token liegt also unverschlüsselt — wie jedes andere
Erweiterungsgeheimnis in Chrome. Es wird nur im `Authorization`-Header an den
von dir eingetragenen Host geschickt und nirgends protokolliert.

Anhänge (Screenshot, PDF), die du ausdrücklich mitschickst, liegen in der
IndexedDB der Erweiterung auf deinem Gerät — nur so lange, bis ihr Eintrag
gesendet ist oder du ihn verwirfst. Danach werden sie gelöscht. Das dient allein
dazu, dass ein Anhang eine Wiederholung nach einem Verbindungsfehler übersteht.

## 6. Berechtigungen und warum sie nötig sind

| Berechtigung | Zweck |
|---|---|
| `storage` | Adresse, Token, Buchliste, Einstellungen und Warteschlange lokal ablegen |
| `activeTab` | die Seite lesen, die du gerade erfasst — nur im Moment deiner Aktion |
| `scripting` | das Ernte-Script in genau diesem Moment injizieren |
| `contextMenus` | den Eintrag „Als Zitat erfassen" bei markiertem Text anbieten |
| `notifications` | Bestätigung samt Rückgängig-Knopf anzeigen; abschaltbar |
| `alarms` | den Service Worker für eine fällige Wiederholung wecken; kein Netzverkehr |
| Host-Berechtigung | genau ein Origin: das deiner Schreibwerkstatt-Installation. Das Manifest enthält kein `<all_urls>`; die Erweiterung fragt beim Einrichten nach diesem einen Origin, und Chrome zeigt dir den Dialog dazu. |

## 7. Löschung

- **Lokale Daten:** Erweiterung deinstallieren. Chrome löscht
  `chrome.storage.local` und die IndexedDB der Erweiterung vollständig — Token,
  Buchliste, Warteschlange und zwischengelagerte Anhänge inklusive. Einzelne Werte kannst du auch auf der Options-Seite zurücksetzen.
- **Bereits gesendete Einträge:** die verwaltest du in der Web-App deiner
  Schreibwerkstatt. Die Erweiterung kann sie nicht löschen; die API der App
  kennt dafür keinen Endpunkt.

## 8. Kinder

Die Erweiterung richtet sich nicht an Kinder und erhebt keine Altersangaben.

## 9. Rechtsgrundlage und deine Rechte (DSGVO)

Da diese Erweiterung selbst keine personenbezogenen Daten an ihren Entwickler
übermittelt, entsteht ihm gegenüber keine Verarbeitung, auf die sich Auskunfts-,
Löschungs- oder Widerspruchsrechte richten könnten. Für die Daten auf **deinem**
Schreibwerkstatt-Server ist der Betreiber dieses Servers verantwortlich — in der
Regel du selbst.

Die Übertragung an deinen Server erfolgt auf deine ausdrückliche Handlung hin:
sie beginnt erst mit deinem Klick.

## 10. Änderungen

Wesentliche Änderungen erscheinen hier mit neuem Stand-Datum. Änderungen, die
den Umfang der übertragenen Daten erweitern, gehen zusammen mit einer neuen
Version der Erweiterung durch die Prüfung des Chrome Web Store.

## 11. Kontakt

`bede.berger@gmail.com`
