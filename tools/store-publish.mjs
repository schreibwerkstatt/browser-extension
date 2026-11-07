/**
 * Laedt das gepackte ZIP in den Chrome Web Store und reicht es zur Pruefung ein.
 *
 *   npm run store:publish                     hochladen und einreichen
 *   npm run store:publish -- --dry-run        nur pruefen, nichts senden
 *   npm run store:publish -- --upload-only    hochladen, Entwurf stehen lassen
 *   npm run store:publish -- --publish-only   den vorhandenen Entwurf einreichen
 *
 * Weitere Schalter: `--version=x.y.z` (Vorgabe: aus `package.json`),
 * `--zip=<pfad>`, `--target=trustedTesters`.
 *
 * Zugangsdaten kommen aus `~/.config/schreibwerkstatt-cws.json` oder aus
 * `CWS_*` — **nie aus dem Repository**, das ist oeffentlich. Einrichtung:
 * `npm run store:auth`, Ablauf in store/PUBLISHING.md.
 *
 * Zwei Dinge nimmt der Befehl bewusst nicht ab:
 *
 * - **Er veroeffentlicht nicht.** Einreichen heisst Pruefung; wann die
 *   Erweiterung erscheint, entscheidet der Store.
 * - **Er raeumt keine laufende Pruefung aus dem Weg.** Kommt
 *   `ITEM_PENDING_REVIEW`, bricht er ab, statt es nochmal zu versuchen — eine
 *   zweite Einreichung setzt die Uhr auf null und kann das Konto markieren.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DRAFT_STATES, PUBLISH_STATES, UPLOAD_STATES, accessToken, assertOutsideRepo,
  describeStatus, fetchItem, missingFields, publishItem, readConfig,
  stillProcessing, uploadPackage, zipManifestVersion,
} from './lib/cws.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** So oft und so lange wird auf ein `IN_PROGRESS` gewartet. */
const POLL_TRIES = 10;
const POLL_DELAY_MS = 3000;

/** @param {string} message */
function fail(message) {
  process.stderr.write(`\nFEHLER: ${message}\n\n`);
  process.exit(1);
}

/** @param {string} [line] */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, uploadOnly: boolean, publishOnly: boolean, target: string, version?: string, zip?: string }}
 */
function parseArgs(argv) {
  const flags = {
    dryRun: false, uploadOnly: false, publishOnly: false, target: 'default',
  };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--upload-only') flags.uploadOnly = true;
    else if (arg === '--publish-only') flags.publishOnly = true;
    else if (arg.startsWith('--target=')) flags.target = arg.slice('--target='.length);
    else if (arg.startsWith('--version=')) flags.version = arg.slice('--version='.length);
    else if (arg.startsWith('--zip=')) flags.zip = arg.slice('--zip='.length);
    else fail(`Unbekanntes Argument: ${arg}`);
  }
  if (flags.uploadOnly && flags.publishOnly) fail('--upload-only und --publish-only schliessen sich aus.');
  return flags;
}

// --- Ablauf -----------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const version = args.version ?? pkg.version;

const config = await readConfig();

const inRepo = assertOutsideRepo(config.file, ROOT);
if (inRepo) fail(inRepo);

const missing = missingFields(config);
if (missing.length) {
  fail([
    config.fileExists ? `In ${config.file} fehlt:` : `${config.file} fehlt. Gebraucht wird:`,
    ...missing.map((field) => `  - ${field}`),
    '',
    'Einrichtung: store/PUBLISHING.md, Abschnitt „Automatisch aktualisieren".',
  ].join('\n'));
}

// ZIP zuerst lesen, vor jedem Netzzugriff: fehlt es, ist alles andere umsonst.
let zip;
let zipFile;
if (!args.publishOnly) {
  zipFile = args.zip ? resolve(ROOT, args.zip) : join(ROOT, 'store', `schreibwerkstatt-chrome-${version}.zip`);
  try {
    zip = await readFile(zipFile);
  } catch {
    fail(`${relative(ROOT, zipFile)} fehlt. Erst \`npm run package\` ausfuehren.`);
  }

  // Massgeblich ist das Manifest IM Paket, nicht dist/ und nicht der
  // Dateiname: genau dieses Archiv geht hoch. Gilt auch fuer `--zip=` — ein
  // altes oder fremdes ZIP soll nicht unter der aktuellen Versionsnummer
  // eingereicht werden.
  let zipVersion;
  try {
    zipVersion = zipManifestVersion(zip);
  } catch (error) {
    fail(`${relative(ROOT, zipFile)}: ${error.message}`);
  }
  if (zipVersion !== pkg.version) {
    fail(`Version laeuft auseinander: manifest.json im Paket ${zipVersion}, package.json ${pkg.version}. `
      + 'Neu packen mit `npm run package`.');
  }
  if (version !== zipVersion) {
    fail(`--version=${version} passt nicht zum Paket (manifest.json: ${zipVersion}).`);
  }
}

const sha256 = zip ? createHash('sha256').update(zip).digest('hex') : null;

say();
say(`Item:     ${config.itemId}`);
say(`Version:  ${version}`);
if (zip) {
  say(`Paket:    ${relative(ROOT, zipFile)} (${(zip.length / 1024).toFixed(1)} KiB)`);
  say(`SHA-256:  ${sha256}`);
}
say(`Ziel:     ${args.target}`);
say();

let token;
try {
  token = await accessToken(config);
} catch (error) {
  fail([
    error.message,
    '',
    'Sagt Google „invalid_grant", ist meist der OAuth-Zustimmungsbildschirm',
    'noch im Status „Testing" — dort verfallen Refresh-Token nach sieben Tagen.',
    'In der Cloud Console auf „In Produktion" stellen, dann `npm run store:auth`.',
  ].join('\n'));
}

let item;
try {
  item = await fetchItem({ token, itemId: config.itemId });
} catch (error) {
  fail(error.message);
}

const draftState = item.uploadState ?? 'unbekannt';
say(`Entwurf im Store: Version ${item.crxVersion ?? 'unbekannt'}`);
say(`                  ${draftState} — ${DRAFT_STATES[draftState] ?? 'unbekannter Zustand, in der Google-Doku nachsehen'}`);

// Der Store nimmt dieselbe Nummer nicht zweimal. Frueh abbrechen, damit die
// Meldung von hier kommt und nicht als Upload-Fehler aus Googles Wortschatz.
if (!args.publishOnly && item.crxVersion && item.crxVersion === version) {
  fail([
    `Der Entwurf im Store traegt bereits Version ${version}.`,
    '',
    'Entweder ist dieser Stand schon eingereicht — dann `npm version patch',
    '--no-git-tag-version` und neu packen —, oder er wurde mit --upload-only',
    'hochgelegt und nie eingereicht: dann `npm run store:publish -- --publish-only`.',
  ].join('\n'));
}

if (args.dryRun) {
  say();
  say('--dry-run: Zugangsdaten, Paket und Item-Zustand sind geprueft, gesendet');
  say('wurde nichts. Ohne den Schalter wuerde jetzt hochgeladen'
    + `${args.uploadOnly ? '' : ' und eingereicht'}.`);
  say();
  process.exit(0);
}

if (!args.publishOnly) {
  say();
  say('Lade hoch …');
  let result;
  try {
    result = await uploadPackage({ token, itemId: config.itemId, zip });
  } catch (error) {
    fail(error.message);
  }

  // Der Zustand **dieser Antwort** wird nach `UPLOAD_STATES` gelesen: hier
  // heisst `NOT_FOUND` „Item unbekannt" und ist ein Abbruch.
  let state = result.uploadState;
  const errors = (result.itemError ?? []).map((entry) => entry.error_detail ?? JSON.stringify(entry));

  say(`  ${state} — ${UPLOAD_STATES[state] ?? 'unbekannter Zustand, in der Google-Doku nachsehen'}`);
  for (const detail of errors) say(`  ${detail}`);

  if (state !== 'SUCCESS' && !stillProcessing(state)) {
    fail('Upload nicht angenommen — nichts wurde eingereicht.');
  }

  // `IN_PROGRESS` ist kein Fehler, nur noch keine Zusage: abfragen, bis der
  // Store fertig ist. Ab hier zaehlt `DRAFT_STATES`, **nicht** `UPLOAD_STATES` —
  // dieselbe Zeichenkette `NOT_FOUND` bedeutet in der Abfrage „kein Upload mehr
  // in Arbeit", also fertig. Wer die Tabellen verwechselt, bricht nach einem
  // geglueckten Upload ab (am 2026-08-04 am echten Store gesehen).
  for (let waited = 0; stillProcessing(state) && waited < POLL_TRIES; waited += 1) {
    await sleep(POLL_DELAY_MS);
    try {
      state = (await fetchItem({ token, itemId: config.itemId })).uploadState;
    } catch (error) {
      fail(error.message);
    }
    say(`  ${state} — ${DRAFT_STATES[state] ?? 'unbekannter Zustand'}`);
  }

  if (stillProcessing(state)) {
    fail(`Der Store verarbeitet das Archiv nach ${(POLL_TRIES * POLL_DELAY_MS) / 1000} Sekunden noch. `
      + 'Spaeter `npm run store:publish -- --publish-only`.');
  }

  if (state === 'FAILURE') fail('Verarbeitung fehlgeschlagen — nichts wurde eingereicht.');
}

if (args.uploadOnly) {
  say();
  say('--upload-only: Paket liegt als Entwurf im Dashboard, eingereicht ist es');
  say('nicht. Einreichen mit `npm run store:publish -- --publish-only` oder von');
  say('Hand im Developer Dashboard.');
  say();
  process.exit(0);
}

say();
say('Reiche ein …');
let published;
try {
  published = await publishItem({ token, itemId: config.itemId, target: args.target });
} catch (error) {
  fail(error.message);
}

const states = published.status ?? [];
for (const line of describeStatus(states, PUBLISH_STATES)) say(`  ${line}`);
for (const detail of published.statusDetail ?? []) say(`  ${detail}`);

if (!states.includes('OK') && !states.includes('PUBLISHED_WITH_FRICTION_WARNING')) {
  fail(states.includes('ITEM_PENDING_REVIEW')
    ? 'Das Paket liegt hochgeladen im Entwurf, eingereicht wurde es nicht. Laufende Pruefung abwarten, dann --publish-only.'
    : 'Einreichen abgelehnt. Das Paket liegt als Entwurf im Dashboard.');
}

say();
say(`Version ${version} ist eingereicht. Ab hier entscheidet die Pruefung, wann`);
say('sie erscheint — ueblicherweise schneller als bei der ersten Einreichung.');
if (sha256) say(`Hochgeladen wurde SHA-256 ${sha256}.`);
say('Stand: https://chrome.google.com/webstore/devconsole');
say();
