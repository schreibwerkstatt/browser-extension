# Sicherheit

## Eine Lücke melden

**Bitte nicht über ein öffentliches Issue.** Nutze stattdessen die private
Meldefunktion von GitHub:

→ [Security → Report a vulnerability](https://github.com/schreibwerkstatt/browser-extension/security/advisories/new)

Damit landet die Meldung in einem privaten Advisory, das nur du und ich sehen,
bis ein Fix bereitsteht.

Hilfreich in der Meldung:

- betroffene Version (steht in `src/manifest.json`) und Chrome-Version
- was passiert, und was stattdessen passieren müsste
- ein möglichst kurzer Reproduktionsweg

Ich melde mich innerhalb von **14 Tagen** zurück. Das Projekt entsteht in der
Freizeit — es gibt keine Bereitschaft rund um die Uhr und kein Bug-Bounty.
Wenn du magst, nenne ich dich im Fix-Commit und im Advisory.

## Unterstützte Versionen

Gefixt wird nur auf `main`. Die Erweiterung wird nicht über den Chrome Web Store
verteilt, sondern lokal gebaut und als entpackte Erweiterung geladen — ein Update
heißt also: `git pull`, `npm run build`, in `chrome://extensions` neu laden.

## Was in den Geltungsbereich fällt

Der Code in diesem Repository. Besonders interessant:

- **Umgang mit dem Geräte-Token.** Es liegt in `chrome.storage.local` und darf
  nur im `Authorization`-Header an den konfigurierten Host gehen — nirgends
  sonst hin, und nie in ein Log. Siehe [README.md](README.md#wo-das-token-liegt).
- **Das Ernte-Script.** Es wird per `activeTab` in eine fremde Seite injiziert
  und verarbeitet deren Inhalt. Wege, über die eine bösartige Seite daraus mehr
  macht als das Auslesen von Metadaten und Text, sind relevant.
- **URL-Normalisierung** (`src/shared/url.js`). Sie entscheidet, an welchen
  Origin gesendet wird; eine Umgehung wäre gravierend.
- **Content Security Policy** des Manifests und alles, was sie aushebelt.

## Was nicht in den Geltungsbereich fällt

- **Der Schreibwerkstatt-Server.** Eigenes Projekt, eigener Meldeweg.
- **Fremde Webseiten**, auf denen die Erweiterung eingesetzt wird.
- **Abhängigkeiten** (`@mozilla/readability`, `esbuild`, `jsdom`). Melde diese
  bitte den jeweiligen Projekten. Wenn eine Lücke dort *hier* konkret ausnutzbar
  ist, ist das sehr wohl eine Meldung wert.
- **Bekannte und dokumentierte Entwürfe**, etwa dass das Token unverschlüsselt
  in `chrome.storage.local` liegt (Chrome bietet Erweiterungen keinen
  Schlüsselbund) oder dass `http://` für lokale Server erlaubt bleibt. Beides
  steht so im README. Ein Weg, wie eine *andere* Erweiterung oder eine Webseite
  an diesen Speicher kommt, wäre dagegen ein Fund.
