/**
 * Referenz-Server fuer die Chrome-Web-Store-Pruefung.
 *
 *   REVIEW_TOKEN=swd_… node tools/review-server.mjs
 *
 * Warum es das gibt: die Erweiterung ist ohne Schreibwerkstatt-Server
 * funktionslos, und eine Erweiterung, die sich nicht bedienen laesst, wird
 * abgelehnt. Der Pruefer braucht also eine erreichbare Gegenstelle — aber
 * ausgerechnet die Produktion ist dafuer die schlechteste Wahl:
 * `GET /content/books` gibt alle Buchtitel **und** die `owner_email` der
 * Mitarbeitenden heraus, und der API-Vertrag kennt kein `DELETE /research/:id`,
 * die Testeintraege des Pruefers muesste man also von Hand wegraeumen.
 *
 * Deshalb wird hier derselbe Vertrag angeboten, gegen den auch
 * `test/integration.test.js` prueft — mit Beispieldaten statt echter.
 * Kein Zugriff auf irgendetwas Echtes, nichts wegzuraeumen, nichts zu
 * widerrufen: Prozess beenden und die Sache ist erledigt.
 *
 * Der Zustand liegt ausschliesslich im Arbeitsspeicher. Ein Neustart setzt
 * alles zurueck; es wird nichts auf Platte geschrieben.
 *
 * Umgebungsvariablen:
 *   REVIEW_TOKEN  Pflicht. Das Token, das der Pruefer eintraegt. Muss mit
 *                 `swd_` beginnen: die Options-Seite speichert zwar auch
 *                 anderes, zeigt dann aber einen Formathinweis — und der
 *                 soll im Einrichtungsdialog des Pruefers nicht stehen.
 *   PORT          Voreinstellung 8787
 *   HOST          Voreinstellung 0.0.0.0
 *
 * Der Pruefer braucht **HTTPS**: eine nicht-lokale `http`-Adresse laesst die
 * Options-Seite gar nicht speichern (`isBlockedHttp` in
 * src/options/options.js) — das Manifest kann fuer solche Origins keine
 * Host-Berechtigung anfordern. Also hinter einen Reverse-Proxy mit Zertifikat.
 */

import { startMockServer } from '../test/helpers/mock-server.js';

const token = process.env.REVIEW_TOKEN;
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

if (!token) {
  process.stderr.write([
    '',
    'FEHLER: REVIEW_TOKEN fehlt.',
    '',
    'Ohne Token wuerde dieser Server jede Anfrage annehmen. Setz eines:',
    '',
    '  REVIEW_TOKEN=swd_pruefung_$(openssl rand -hex 12) node tools/review-server.mjs',
    '',
  ].join('\n'));
  process.exit(1);
}

if (!token.startsWith('swd_')) {
  process.stderr.write('\nFEHLER: REVIEW_TOKEN muss mit "swd_" beginnen — sonst zeigt die Options-Seite dem Pruefer einen Formathinweis.\n\n');
  process.exit(1);
}

/** @param {any} entry */
function logRequest(entry) {
  const stamp = new Date().toISOString().slice(11, 19);
  const size = entry.rawLength ? ` ${entry.rawLength} B` : '';
  process.stdout.write(`  ${stamp}  ${entry.route}${size}\n`);
}

const server = await startMockServer({
  token,
  port,
  host,
  // Alle Endpunkte anbieten, damit der Pruefer den vollen Funktionsumfang
  // sieht und nicht die Degradationspfade fuer aeltere Server.
  hasCapture: true,
  hasByUrl: true,
  hasResearchList: true,
  // Ein vorhandener Eintrag, damit die Dublettenpruefung im Popup etwas
  // zu melden hat, sobald dieselbe Seite ein zweites Mal erfasst wird.
  researchIndex: [
    {
      id: 4711,
      book_id: 1,
      kind: 'link',
      title: 'Citation',
      source: 'https://en.wikipedia.org/wiki/Citation',
      body: 'Beispieleintrag des Referenz-Servers.',
      urls: [{ url: 'https://en.wikipedia.org/wiki/Citation', label: '' }],
      tags: [],
      links: [],
      pinned: false,
      archived: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  onRequest: logRequest,
});

process.stdout.write([
  '',
  'Referenz-Server fuer die Store-Pruefung laeuft.',
  '',
  `  Adresse (lokal):  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.port}`,
  `  Token:            ${token}`,
  '',
  'Beides gehoert in das Feld „Testanleitung" im Developer-Dashboard —',
  'die Adresse aber als oeffentliche https-URL, nicht als die hier gezeigte.',
  'Vorlage: store/test-instructions.md',
  '',
  'Angebotene Buecher: Nordlicht (owner) · Mitschrift (editor) ·',
  'Fremdes Buch (viewer — liefert absichtlich 403 INSUFFICIENT_ROLE mit',
  'detail {actual: viewer, required: editor}, damit die Fehlerbehandlung',
  'sichtbar ist: die Erweiterung nennt die Ursache, nicht nur „verweigert").',
  '',
  'Jede Anfrage wird unten protokolliert. Daran siehst du auch, ob der Pruefer',
  'die Erweiterung wirklich ausprobiert hat.',
  '',
  'Beenden mit Strg+C. Der Zustand ist nur im Arbeitsspeicher und dann weg.',
  '',
].join('\n'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.close();
    process.stdout.write('\nBeendet.\n');
    process.exit(0);
  });
}
