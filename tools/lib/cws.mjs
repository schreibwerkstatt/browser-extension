/**
 * Gemeinsamer Unterbau der beiden Store-Werkzeuge:
 *
 *   `store-auth.mjs`     holt einmalig das Refresh-Token
 *   `store-publish.mjs`  laedt das Paket hoch und reicht es ein
 *
 * Enthaelt nichts, was ins Paket geht, und keine Zugangsdaten. Die drei Werte
 * (Item-ID, Client-ID, Client-Secret) plus das Refresh-Token liegen **ausserhalb
 * dieses Repositories**, weil es oeffentlich ist und `/release` mit `git add -A`
 * committet: Vorgabe ist `~/.config/schreibwerkstatt-cws.json` mit Rechten 600.
 * `assertOutsideRepo()` bricht ab, falls die Datei doch im Arbeitsbaum landet.
 *
 * API-Vertrag: <https://developer.chrome.com/docs/webstore/using-api>. Das ist
 * eine fremde API, also gilt hier nicht die Prompt-Regel des Mutterprojekts —
 * wohl aber deren Geist: unbekannte Statuscodes werden nicht verschluckt,
 * sondern **nennen sich selbst**.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API_BASE = 'https://www.googleapis.com/chromewebstore/v1.1';
export const UPLOAD_BASE = 'https://www.googleapis.com/upload/chromewebstore/v1.1';

/** Die API verlangt diesen Header bei jedem Aufruf; ohne ihn antwortet sie v1. */
const API_VERSION_HEADER = { 'x-goog-api-version': '2' };

/** Vorgabename der Konfigurationsdatei, unter `$XDG_CONFIG_HOME` bzw. `~/.config`. */
export const CONFIG_FILENAME = 'schreibwerkstatt-cws.json';

/**
 * `uploadState` aus der Antwort des **Uploads**.
 *
 * `IN_PROGRESS` heisst: der Store verarbeitet das Archiv noch. Das ist kein
 * Fehler, aber auch keine Zusage — Einreichen erst danach.
 */
export const UPLOAD_STATES = {
  SUCCESS: 'Paket angenommen.',
  IN_PROGRESS: 'Paket wird noch verarbeitet — noch nicht eingereicht.',
  FAILURE: 'Paket abgewiesen.',
  NOT_FOUND: 'Item-ID unbekannt — gehoert sie zu diesem Entwicklerkonto?',
};

/**
 * Dasselbe Feld, **anderer Aufruf, andere Bedeutung**: der `uploadState` der
 * Item-Abfrage beschreibt einen laufenden Upload, nicht das Item.
 *
 * Am 2026-08-04 gegen den echten Store nachgemessen: die Abfrage antwortete
 * `NOT_FOUND` **zusammen mit** einer `crxVersion` — das Item war also da. Wer
 * `NOT_FOUND` hier wie beim Upload liest („Item-ID unbekannt"), meldet einen
 * Fehler, wo der Normalzustand steht. Deshalb zwei Tabellen und nicht eine.
 */
export const DRAFT_STATES = {
  SUCCESS: 'letzter Upload angenommen.',
  IN_PROGRESS: 'ein Upload wird gerade verarbeitet.',
  FAILURE: 'letzter Upload abgewiesen.',
  NOT_FOUND: 'kein Upload in Arbeit — der Normalzustand zwischen zwei Releases.',
};

/**
 * Verarbeitet der Store gerade noch? Nur `IN_PROGRESS` heisst warten; alles
 * andere — auch das `NOT_FOUND` von oben — heisst fertig.
 *
 * @param {string | undefined} state
 * @returns {boolean}
 */
export function stillProcessing(state) {
  return state === 'IN_PROGRESS';
}

/**
 * `status` aus der Antwort des Einreichens. Die Liste ist die dokumentierte;
 * alles darueber hinaus faellt in `describeStatus` durch und nennt sich selbst.
 */
export const PUBLISH_STATES = {
  OK: 'Eingereicht.',
  ITEM_PENDING_REVIEW: 'Eine Pruefung laeuft bereits — nicht erneut einreichen, das setzt die Uhr auf null.',
  PUBLISHED_WITH_FRICTION_WARNING: 'Eingereicht, aber mit Warnung des Stores.',
  NOT_AUTHORIZED: 'Zugangsdaten reichen fuer dieses Item nicht.',
  INVALID_DEVELOPER: 'Kein gueltiges Entwicklerkonto.',
  DEVELOPER_NO_OWNERSHIP: 'Dieses Konto besitzt das Item nicht.',
  DEVELOPER_SUSPENDED: 'Entwicklerkonto gesperrt.',
  ITEM_NOT_FOUND: 'Item-ID unbekannt.',
  ITEM_TAKEN_DOWN: 'Item wurde vom Store entfernt.',
  PUBLISHER_SUSPENDED: 'Publisher gesperrt.',
};

/**
 * Uebersetzt Statuscodes in Klartext. Ein unbekannter Code wird **nicht**
 * geschluckt: er erscheint mit seinem eigenen Namen, damit der naechste
 * Abgleich mit der Google-Doku nicht raten muss.
 *
 * @param {string[]} codes
 * @param {Record<string, string>} table
 * @returns {string[]}
 */
export function describeStatus(codes, table) {
  return (codes ?? []).map((code) => (
    table[code] ? `${code} — ${table[code]}` : `${code} — unbekannter Code, in der Google-Doku nachsehen`
  ));
}

/**
 * Pfad der Konfigurationsdatei. `CWS_CONFIG` gewinnt, sonst XDG.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function configPath(env = process.env) {
  if (env.CWS_CONFIG) return resolve(env.CWS_CONFIG);
  const base = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(homedir(), '.config');
  return join(base, CONFIG_FILENAME);
}

/**
 * Bricht ab, wenn die Zugangsdaten im Arbeitsbaum liegen wuerden.
 *
 * Das Repository ist oeffentlich und `/release` committet mit `git add -A`
 * alles, was es findet — eine `.gitignore`-Zeile ist dagegen kein Schutz,
 * sondern nur eine Bitte. Also gar nicht erst hier hinein.
 *
 * @param {string} file  Pfad der Konfigurationsdatei
 * @param {string} root  Wurzel des Repositories
 * @returns {string | null} Fehlermeldung oder `null`
 */
export function assertOutsideRepo(file, root) {
  const inside = relative(resolve(root), resolve(file));
  if (inside.startsWith('..') || isAbsolute(inside)) return null;
  return `Die Zugangsdaten liegen mit ${inside} im Repository — das ist oeffentlich. `
    + `Datei nach ${join(homedir(), '.config', CONFIG_FILENAME)} verschieben oder CWS_CONFIG auf einen Pfad ausserhalb setzen.`;
}

/**
 * Liest die Konfiguration. Umgebungsvariablen ueberschreiben die Datei — so
 * laesst sich ein Einzelwert austauschen, ohne die Datei anzufassen.
 *
 * @param {{ env?: Record<string, string | undefined>, file?: string }} [options]
 * @returns {Promise<{ itemId?: string, clientId?: string, clientSecret?: string, refreshToken?: string, file: string, fileExists: boolean }>}
 */
export async function readConfig({ env = process.env, file = configPath(env) } = {}) {
  let stored = {};
  let fileExists = false;
  try {
    stored = JSON.parse(await readFile(file, 'utf8'));
    fileExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return {
    itemId: env.CWS_ITEM_ID || stored.item_id || undefined,
    clientId: env.CWS_CLIENT_ID || stored.client_id || undefined,
    clientSecret: env.CWS_CLIENT_SECRET || stored.client_secret || undefined,
    refreshToken: env.CWS_REFRESH_TOKEN || stored.refresh_token || undefined,
    file,
    fileExists,
  };
}

/**
 * Schreibt Felder in die Konfigurationsdatei, ohne die uebrigen zu verlieren,
 * und setzt die Rechte auf 600. `writeFile`s `mode` gilt nur beim Anlegen,
 * deshalb zusaetzlich `chmod` — sonst bliebe eine vorhandene Datei
 * weltlesbar.
 *
 * @param {string} file
 * @param {Record<string, string | null>} fields
 */
export async function updateConfig(file, fields) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const merged = { ...stored, ...fields };
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * Zaehlt auf, was fuer einen Aufruf fehlt — als Liste, nicht als erster
 * Treffer: wer drei Werte einrichtet, will alle drei Luecken auf einmal sehen.
 *
 * @param {{ itemId?: string, clientId?: string, clientSecret?: string, refreshToken?: string }} config
 * @param {{ refreshToken?: boolean }} [options]
 * @returns {string[]}
 */
export function missingFields(config, { refreshToken = true } = {}) {
  const missing = [];
  if (!config.clientId) missing.push('client_id (CWS_CLIENT_ID)');
  if (!config.clientSecret) missing.push('client_secret (CWS_CLIENT_SECRET)');
  if (!config.itemId) missing.push('item_id (CWS_ITEM_ID)');
  if (refreshToken && !config.refreshToken) missing.push('refresh_token — `npm run store:auth` holt es');
  return missing;
}

/**
 * Redirect-URI fuer den Loopback-Weg.
 *
 * Bewusst `127.0.0.1` und nicht `localhost`: der Server in `store-auth.mjs`
 * lauscht nur auf der IPv4-Loopback-Adresse. `localhost` kann der Browser zu
 * `::1` aufloesen und liefe dann ins Leere — und Google empfiehlt fuer
 * Desktop-Clients ohnehin die IP-Form; jeder Port ist ohne Voranmeldung
 * zugelassen.
 *
 * @param {number} port
 * @returns {string}
 */
export function loopbackRedirectUri(port) {
  return `http://127.0.0.1:${port}`;
}

/** @param {Buffer} buffer */
function base64url(buffer) {
  return buffer.toString('base64url');
}

/**
 * Zufaelliger `state` gegen untergeschobene Weiterleitungen: jede andere Seite
 * im Browser kann `http://127.0.0.1:<port>/?code=…` aufrufen. Nur eine
 * Weiterleitung mit genau diesem Wert wird angenommen.
 *
 * @returns {string}
 */
export function newState() {
  return base64url(randomBytes(32));
}

/**
 * PKCE-Paar (RFC 7636, Verfahren S256). Der `code_verifier` bleibt im Prozess
 * und geht erst beim Code-Tausch mit; wer den Code unterwegs abfaengt, kann
 * ihn ohne den Verifier nicht einloesen.
 *
 * @returns {{ verifier: string, challenge: string }}
 */
export function pkcePair() {
  // 32 Byte -> 43 Zeichen base64url, die Untergrenze von RFC 7636.
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

/**
 * @param {string} verifier
 * @returns {string}
 */
export function pkceChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * Adresse des Zustimmungsbildschirms.
 *
 * `access_type=offline` **und** `prompt=consent` sind beide noetig: ohne das
 * erste kommt kein Refresh-Token, ohne das zweite nur beim allerersten Mal.
 * `state` und `code_challenge` sind Pflicht — ohne sie gibt es keine Adresse.
 *
 * @param {{ clientId: string, redirectUri: string, state: string, codeChallenge: string }} options
 * @returns {string}
 */
export function authUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (!state) throw new Error('authUrl: state fehlt.');
  if (!codeChallenge) throw new Error('authUrl: codeChallenge fehlt.');
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${OAUTH_AUTH_URL}?${query}`;
}

/**
 * Wertet die Weiterleitung auf den Loopback-Server aus. Ein fehlender oder
 * falscher `state` ist ein Abbruch, kein „nochmal warten": wer so etwas
 * schickt, ist nicht Google.
 *
 * @param {URLSearchParams} params
 * @param {string} expectedState
 * @returns {string} der Autorisierungs-Code
 */
export function readCallback(params, expectedState) {
  const state = params.get('state') ?? '';
  const a = Buffer.from(state);
  const b = Buffer.from(expectedState);
  if (!expectedState || a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Weiterleitung mit falschem oder fehlendem state — abgebrochen.');
  }
  const error = params.get('error');
  if (error) throw new Error(`Abgebrochen: ${error}`);
  const code = params.get('code');
  if (!code) throw new Error('Weiterleitung ohne Code.');
  return code;
}

/**
 * Wirft mit lesbarer Meldung. OAuth-Fehler stecken in `error` und
 * `error_description`, API-Fehler in `error.message` — beide Formen abfangen,
 * sonst steht am Ende nur „400".
 *
 * @param {Response} response
 * @param {string} what
 */
async function readError(response, what) {
  const body = await response.text();
  let detail = body.slice(0, 500);
  try {
    const json = JSON.parse(body);
    detail = json.error_description || json.error?.message || json.error || detail;
  } catch { /* HTML oder leer — dann bleibt der Rohtext */ }
  throw new Error(`${what} scheiterte (HTTP ${response.status}): ${detail}`);
}

/**
 * Tauscht den Autorisierungs-Code gegen ein Refresh-Token. `codeVerifier` ist
 * das Gegenstueck zur `code_challenge` aus `authUrl()`.
 *
 * @param {{ code: string, clientId: string, clientSecret: string, redirectUri: string, codeVerifier: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ refresh_token?: string, access_token: string }>}
 */
export async function exchangeCode({
  code, clientId, clientSecret, redirectUri, codeVerifier, fetchImpl = fetch,
}) {
  if (!codeVerifier) throw new Error('exchangeCode: codeVerifier fehlt.');
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) await readError(response, 'Der Tausch des Autorisierungs-Codes');
  return response.json();
}

/**
 * Holt ein frisches Access-Token. Es gilt eine Stunde und wird nirgends
 * gespeichert — dauerhaft ist nur das Refresh-Token.
 *
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} options
 * @returns {Promise<string>}
 */
export async function accessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    // `invalid_grant` heisst hier fast immer: der Zustimmungsbildschirm steht
    // noch auf „Testing", dort verfallen Refresh-Token nach sieben Tagen.
    await readError(response, 'Das Erneuern des Access-Tokens');
  }
  const json = await response.json();
  if (!json.access_token) throw new Error('Antwort ohne access_token.');
  return json.access_token;
}

/**
 * Zustand des Entwurfs. Liefert `uploadState` und — wenn der Store ihn
 * mitschickt — `crxVersion`, die zuletzt hochgeladene Nummer.
 *
 * **Kein Pruefungs-Status.** Ob eine Pruefung laeuft, sagt diese API nicht;
 * das erfaehrt man erst aus `ITEM_PENDING_REVIEW` beim Einreichen.
 *
 * @param {{ token: string, itemId: string }} options
 * @returns {Promise<{ uploadState?: string, crxVersion?: string, itemError?: Array<{ error_detail?: string }> }>}
 */
export async function fetchItem({ token, itemId }) {
  const response = await fetch(`${API_BASE}/items/${itemId}?projection=DRAFT`, {
    headers: { authorization: `Bearer ${token}`, ...API_VERSION_HEADER },
  });
  if (!response.ok) await readError(response, 'Die Abfrage des Item-Zustands');
  return response.json();
}

/**
 * Laedt das ZIP als neues Paket hoch. Ersetzt den Entwurf; veroeffentlicht
 * nichts.
 *
 * @param {{ token: string, itemId: string, zip: Buffer }} options
 * @returns {Promise<{ uploadState?: string, itemError?: Array<{ error_detail?: string }> }>}
 */
export async function uploadPackage({ token, itemId, zip }) {
  const response = await fetch(`${UPLOAD_BASE}/items/${itemId}?uploadType=media`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      ...API_VERSION_HEADER,
      'content-type': 'application/zip',
      'content-length': String(zip.length),
    },
    body: zip,
  });
  if (!response.ok) await readError(response, 'Der Upload');
  return response.json();
}

/**
 * Reicht den Entwurf zur Pruefung ein.
 *
 * `target` ist `default` (der im Dashboard eingestellte Kanal, hier „nicht
 * aufgefuehrt") oder `trustedTesters`.
 *
 * @param {{ token: string, itemId: string, target?: string }} options
 * @returns {Promise<{ status?: string[], statusDetail?: string[] }>}
 */
export async function publishItem({ token, itemId, target = 'default' }) {
  const query = target === 'default' ? '' : `?publishTarget=${encodeURIComponent(target)}`;
  const response = await fetch(`${API_BASE}/items/${itemId}/publish${query}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...API_VERSION_HEADER,
      'content-length': '0',
    },
  });
  if (!response.ok) await readError(response, 'Das Einreichen');
  return response.json();
}

// --- ZIP lesen ----------------------------------------------------------------

/**
 * Liest eine einzelne Datei aus einem ZIP — gerade genug, um das Manifest im
 * Paket zu pruefen. Kein Zip64, kein mehrteiliges Archiv, nur „gespeichert"
 * und Deflate; das deckt `tools/package.mjs` ab und jedes uebliche Werkzeug.
 * Gelesen wird ueber das Zentralverzeichnis, weil nur dort die Groessen
 * verlaesslich stehen (bei Bit 3 sind sie im lokalen Kopf null).
 *
 * @param {Buffer} zip
 * @param {string} name Pfad im Archiv, mit `/` als Trenner
 * @returns {Buffer | null} Inhalt, oder `null`, wenn es den Eintrag nicht gibt
 */
export function readZipEntry(zip, name) {
  // Ende des Zentralverzeichnisses: 22 Byte plus hoechstens 65535 Kommentar.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Kein ZIP: Ende des Zentralverzeichnisses nicht gefunden.');

  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP-Zentralverzeichnis beschaedigt.');
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const entryName = zip.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    pos += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP-Eintrag ${name}: lokaler Kopf beschaedigt.`);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return inflateRawSync(data);
    throw new Error(`ZIP-Eintrag ${name}: Verfahren ${method} wird nicht gelesen.`);
  }
  return null;
}

/**
 * Version aus dem `manifest.json` **im Paket** — nicht aus `dist/`. Genau das
 * ZIP wird hochgeladen, also muss genau dessen Manifest stimmen.
 *
 * @param {Buffer} zip
 * @returns {string}
 */
export function zipManifestVersion(zip) {
  const raw = readZipEntry(zip, 'manifest.json');
  if (!raw) throw new Error('Das Paket traegt kein manifest.json im Wurzelverzeichnis.');
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('manifest.json im Paket ist kein gueltiges JSON.');
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('manifest.json im Paket hat keine Version.');
  }
  return manifest.version;
}
