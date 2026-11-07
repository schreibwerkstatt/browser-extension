/**
 * Holt einmalig das Refresh-Token fuer die Chrome-Web-Store-API.
 *
 *   npm run store:auth
 *
 * Startet einen Server auf `127.0.0.1`, oeffnet den Zustimmungsbildschirm,
 * faengt den Autorisierungs-Code auf und schreibt das Refresh-Token in
 * `~/.config/schreibwerkstatt-cws.json` (Rechte 600, nie ins Repository).
 *
 * Der Loopback-Weg ist noetig, weil der frueher ueebliche
 * `urn:ietf:wg:oauth:2.0:oob`-Fluss („Code abschreiben") von Google
 * abgeschaltet ist. Fuer einen OAuth-Client des Typs „Desktop-App" ist jeder
 * Port auf der Loopback-Adresse `http://127.0.0.1` ohne Voranmeldung
 * zugelassen — die Portnummer muss also nirgends eingetragen werden. Die
 * IP-Form statt `localhost`, weil der Server nur auf IPv4 lauscht und
 * `localhost` im Browser auch `::1` sein kann.
 *
 * Abgesichert mit `state` (eine fremde Seite kann den Loopback-Port ebenfalls
 * aufrufen — ohne den richtigen Wert bricht der Befehl ab) und PKCE/S256 (der
 * `code_verifier` verlaesst den Prozess erst beim Code-Tausch).
 *
 * Ein einziges Mal noetig. Danach lebt das Token, **solange der
 * Zustimmungsbildschirm auf „In Produktion" steht**; im Status „Testing"
 * verfaellt es nach sieben Tagen und dieser Befehl ist wieder faellig.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertOutsideRepo, authUrl, exchangeCode, loopbackRedirectUri, missingFields, newState,
  pkcePair, readCallback, readConfig, updateConfig,
} from './lib/cws.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CWS_AUTH_PORT || 8976);

/** @param {string} message */
function fail(message) {
  process.stderr.write(`\nFEHLER: ${message}\n\n`);
  process.exit(1);
}

/** @param {string} line */
function say(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Oeffnet die Adresse im Standardbrowser. Scheitert das, bleibt die Adresse
 * auf der Konsole stehen — der Ablauf haengt nicht daran.
 *
 * @param {string} url
 */
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch { /* dann von Hand */ }
}

/**
 * Wartet auf die Weiterleitung des Zustimmungsbildschirms.
 *
 * Jede Anfrage beendet den Server — auch eine mit falschem `state`. Weiter zu
 * warten hiesse, einem Angreifer beliebig viele Versuche zu lassen; abbrechen
 * und neu starten kostet nur einen Klick.
 *
 * @param {string} redirectUri
 * @param {string} expectedState
 * @returns {Promise<string>} der Autorisierungs-Code
 */
function waitForCode(redirectUri, expectedState) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      // Browser holen gern ungefragt /favicon.ico — das ist keine Weiterleitung.
      if (url.pathname !== '/') {
        response.writeHead(404).end();
        return;
      }

      let code;
      let failure;
      try {
        code = readCallback(url.searchParams, expectedState);
      } catch (error) {
        failure = error;
      }

      response.writeHead(failure ? 400 : 200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(failure
        ? `${failure.message}\n`
        : 'Angemeldet. Fenster kann geschlossen werden.\n');

      server.close();
      if (failure) rejectPromise(failure);
      else resolvePromise(code);
    });

    server.on('error', rejectPromise);
    // Nur auf der Loopback-Adresse lauschen: der Code ist ein Geheimnis auf Zeit.
    server.listen(PORT, '127.0.0.1');
  });
}

// --- Ablauf -----------------------------------------------------------------

const config = await readConfig();

const inRepo = assertOutsideRepo(config.file, ROOT);
if (inRepo) fail(inRepo);

const missing = missingFields(config, { refreshToken: false });
if (missing.length) {
  fail([
    `In ${config.file} fehlt:`,
    ...missing.map((field) => `  - ${field}`),
    '',
    'Die Werte stammen aus der Google Cloud Console (OAuth-Client vom Typ',
    '„Desktop-App") und dem Developer Dashboard (Item-ID). Aufbau der Datei:',
    '',
    '  { "item_id": "…", "client_id": "…", "client_secret": "…" }',
  ].join('\n'));
}

if (config.refreshToken) {
  say('Hinweis: es liegt schon ein Refresh-Token. Es wird jetzt ersetzt.\n');
}

const redirectUri = loopbackRedirectUri(PORT);
const state = newState();
const pkce = pkcePair();
const url = authUrl({
  clientId: config.clientId, redirectUri, state, codeChallenge: pkce.challenge,
});

say('Zustimmungsbildschirm wird geoeffnet. Falls nichts passiert, diese Adresse');
say('von Hand aufrufen:\n');
say(`  ${url}\n`);
say('Der Warnhinweis „Google hat diese App nicht verifiziert" ist erwartbar —');
say('es ist deine eigene App. Ueber „Erweitert" fortfahren.\n');

openBrowser(url);

let code;
try {
  code = await waitForCode(redirectUri, state);
} catch (error) {
  fail(error.code === 'EADDRINUSE'
    ? `Port ${PORT} ist belegt. Mit CWS_AUTH_PORT einen anderen waehlen.`
    : error.message);
}

let tokens;
try {
  tokens = await exchangeCode({
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
    codeVerifier: pkce.verifier,
  });
} catch (error) {
  fail(error.message);
}

if (!tokens.refresh_token) {
  fail([
    'Google hat kein Refresh-Token geschickt, nur ein Access-Token.',
    'Das passiert, wenn die Zustimmung schon erteilt war; `prompt=consent` sollte',
    'das verhindern. Zugriff unter https://myaccount.google.com/permissions',
    'entziehen und den Befehl wiederholen.',
  ].join('\n'));
}

await updateConfig(config.file, { refresh_token: tokens.refresh_token });

say('');
say(`Refresh-Token in ${config.file} gespeichert (Rechte 600).`);
say('');
say('Naechster Schritt: `npm run store:publish -- --dry-run` prueft die');
say('Verbindung, ohne etwas zu senden.');
say('');
say('Wichtig, damit das Token nicht in sieben Tagen verfaellt: der');
say('OAuth-Zustimmungsbildschirm muss in der Cloud Console auf');
say('„In Produktion" stehen, nicht auf „Testing".');
say('');
