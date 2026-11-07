/**
 * Nagelt die Entscheidungen der Store-Werkzeuge fest — die Teile, die ohne Netz
 * pruefbar sind.
 *
 * Der Rest von `tools/store-publish.mjs` ist HTTP gegen Google und gehoert
 * nicht in `npm test`. Wichtig ist hier zweierlei: dass die Zugangsdaten nie
 * im oeffentlichen Repository landen koennen, und dass ein unbekannter
 * Statuscode sich selbst nennt statt zu verschwinden — dieselbe Regel wie bei
 * `err_unmapped_code` im Client.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import {
  DRAFT_STATES,
  PUBLISH_STATES,
  UPLOAD_STATES,
  assertOutsideRepo,
  authUrl,
  configPath,
  describeStatus,
  exchangeCode,
  loopbackRedirectUri,
  missingFields,
  newState,
  pkceChallenge,
  pkcePair,
  readCallback,
  readConfig,
  readZipEntry,
  stillProcessing,
  updateConfig,
  zipManifestVersion,
} from '../tools/lib/cws.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('configPath', () => {
  it('nimmt CWS_CONFIG, wenn gesetzt', () => {
    assert.equal(configPath({ CWS_CONFIG: '/somewhere/cws.json' }), '/somewhere/cws.json');
  });

  it('folgt XDG_CONFIG_HOME', () => {
    assert.equal(
      configPath({ XDG_CONFIG_HOME: '/xdg' }),
      '/xdg/schreibwerkstatt-cws.json',
    );
  });

  it('ignoriert ein relatives XDG_CONFIG_HOME', () => {
    // Sonst haenge der Pfad der Zugangsdaten am Arbeitsverzeichnis.
    assert.ok(configPath({ XDG_CONFIG_HOME: 'relativ' }).endsWith('/.config/schreibwerkstatt-cws.json'));
  });
});

describe('assertOutsideRepo', () => {
  it('laesst einen Pfad ausserhalb durch', () => {
    assert.equal(assertOutsideRepo('/home/x/.config/schreibwerkstatt-cws.json', '/repo'), null);
  });

  it('meldet einen Pfad im Repository', () => {
    const message = assertOutsideRepo('/repo/store/cws.json', '/repo');
    assert.match(message, /oeffentlich/);
    assert.match(message, /store\/cws\.json/);
  });

  it('meldet auch die Wurzel selbst', () => {
    assert.ok(assertOutsideRepo('/repo/cws.json', '/repo'));
  });

  it('faellt nicht auf einen Nachbarordner mit gleichem Anfang herein', () => {
    assert.equal(assertOutsideRepo('/repo-privat/cws.json', '/repo'), null);
  });
});

describe('missingFields', () => {
  const full = {
    itemId: 'i', clientId: 'c', clientSecret: 's', refreshToken: 'r',
  };

  it('ist leer, wenn alles da ist', () => {
    assert.deepEqual(missingFields(full), []);
  });

  it('zaehlt alle Luecken auf, nicht nur die erste', () => {
    assert.equal(missingFields({}).length, 4);
  });

  it('laesst das Refresh-Token auf Wunsch aus — vor `store:auth` gibt es keines', () => {
    assert.deepEqual(missingFields({ ...full, refreshToken: undefined }, { refreshToken: false }), []);
  });
});

describe('authUrl', () => {
  const redirectUri = loopbackRedirectUri(8976);
  const url = new URL(authUrl({
    clientId: 'abc.apps.googleusercontent.com', redirectUri, state: 'zustand', codeChallenge: 'herausforderung',
  }));

  it('fragt ein Refresh-Token an', () => {
    // Ohne access_type=offline kommt keines, ohne prompt=consent nur beim
    // allerersten Mal. Beide sind noetig.
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
  });

  it('verlangt genau den Store-Scope', () => {
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/chromewebstore');
  });

  it('schickt den Code an die IPv4-Loopback-Adresse zurueck, auf der der Server lauscht', () => {
    // Der Server lauscht auf 127.0.0.1; `localhost` koennte der Browser zu ::1
    // aufloesen und liefe ins Leere.
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8976');
    assert.equal(url.searchParams.get('response_type'), 'code');
  });

  it('traegt state und PKCE-Challenge (S256)', () => {
    assert.equal(url.searchParams.get('state'), 'zustand');
    assert.equal(url.searchParams.get('code_challenge'), 'herausforderung');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  });

  it('baut ohne state oder Challenge keine Adresse', () => {
    assert.throws(() => authUrl({ clientId: 'c', redirectUri, state: '', codeChallenge: 'x' }), /state/);
    assert.throws(() => authUrl({ clientId: 'c', redirectUri, state: 'x', codeChallenge: '' }), /codeChallenge/);
  });
});

describe('PKCE und state', () => {
  it('Challenge ist base64url(SHA-256(verifier)) — Beispiel aus RFC 7636, Anhang B', () => {
    assert.equal(
      pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('erzeugt je Aufruf ein neues, gueltiges Paar', () => {
    const a = pkcePair();
    const b = pkcePair();
    assert.notEqual(a.verifier, b.verifier);
    // RFC 7636: 43–128 Zeichen aus [A-Za-z0-9-._~].
    assert.match(a.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.equal(a.challenge, pkceChallenge(a.verifier));
    assert.notEqual(newState(), newState());
    assert.ok(newState().length >= 43);
  });
});

describe('readCallback', () => {
  /** @param {Record<string, string>} q */
  const params = (q) => new URLSearchParams(q);

  it('gibt den Code bei passendem state heraus', () => {
    assert.equal(readCallback(params({ code: 'c0de', state: 's1' }), 's1'), 'c0de');
  });

  it('bricht bei falschem oder fehlendem state ab — auch wenn ein Code dabei ist', () => {
    assert.throws(() => readCallback(params({ code: 'c0de', state: 's2' }), 's1'), /state/);
    assert.throws(() => readCallback(params({ code: 'c0de' }), 's1'), /state/);
    assert.throws(() => readCallback(params({ code: 'c0de', state: '' }), ''), /state/);
  });

  it('meldet den OAuth-Fehler und den fehlenden Code', () => {
    assert.throws(() => readCallback(params({ error: 'access_denied', state: 's1' }), 's1'), /access_denied/);
    assert.throws(() => readCallback(params({ state: 's1' }), 's1'), /ohne Code/);
  });
});

describe('exchangeCode', () => {
  it('schickt den code_verifier beim Tausch mit', async () => {
    /** @type {URLSearchParams | undefined} */
    let sent;
    /** @type {typeof fetch} */
    const fetchImpl = async (_url, init) => {
      sent = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), { status: 200 });
    };
    const tokens = await exchangeCode({
      code: 'c0de', clientId: 'c', clientSecret: 's', redirectUri: loopbackRedirectUri(8976), codeVerifier: 'v'.repeat(43), fetchImpl,
    });
    assert.equal(tokens.refresh_token, 'r');
    assert.equal(sent?.get('code_verifier'), 'v'.repeat(43));
    assert.equal(sent?.get('redirect_uri'), 'http://127.0.0.1:8976');
    assert.equal(sent?.get('grant_type'), 'authorization_code');
  });

  it('tauscht ohne Verifier gar nicht erst', async () => {
    await assert.rejects(
      exchangeCode({ code: 'c', clientId: 'c', clientSecret: 's', redirectUri: 'x', codeVerifier: '' }),
      /codeVerifier/,
    );
  });
});

describe('describeStatus', () => {
  it('uebersetzt bekannte Codes', () => {
    assert.deepEqual(describeStatus(['OK'], PUBLISH_STATES), ['OK — Eingereicht.']);
  });

  it('laesst einen unbekannten Code sich selbst nennen', () => {
    const [line] = describeStatus(['WAS_AUCH_IMMER'], PUBLISH_STATES);
    assert.match(line, /^WAS_AUCH_IMMER — unbekannter Code/);
  });

  it('vertraegt eine fehlende Liste', () => {
    assert.deepEqual(describeStatus(undefined, PUBLISH_STATES), []);
  });

  it('kennt die laufende Pruefung — der Fall, der nicht wiederholt werden darf', () => {
    assert.match(PUBLISH_STATES.ITEM_PENDING_REVIEW, /nicht erneut einreichen/);
  });
});

describe('NOT_FOUND heisst zweierlei', () => {
  /**
   * Am 2026-08-04 am echten Store gemessen: `GET items/:id?projection=DRAFT`
   * antwortete `uploadState: NOT_FOUND` **zusammen mit** `crxVersion: 1.0.0`.
   * Das Item war also da — „kein Upload in Arbeit" ist der Ruhezustand.
   * Derselbe Wert in der Upload-Antwort heisst dagegen „Item unbekannt".
   */
  it('meldet im Upload eine unbekannte Item-ID', () => {
    assert.match(UPLOAD_STATES.NOT_FOUND, /Item-ID unbekannt/);
  });

  it('ist in der Abfrage der Normalzustand', () => {
    assert.match(DRAFT_STATES.NOT_FOUND, /Normalzustand/);
    assert.doesNotMatch(DRAFT_STATES.NOT_FOUND, /unbekannt/);
  });

  it('haelt nur IN_PROGRESS die Warteschleife am Laufen', () => {
    // Der Fehler, der hier lauerte: NOT_FOUND als Fehlschlag zu lesen und einen
    // geglueckten Upload abzubrechen.
    assert.equal(stillProcessing('IN_PROGRESS'), true);
    for (const state of ['SUCCESS', 'NOT_FOUND', 'FAILURE', undefined]) {
      assert.equal(stillProcessing(state), false, `${state} darf nicht warten`);
    }
  });
});

describe('readConfig und updateConfig', () => {
  it('liest die Datei und laesst die Umgebung gewinnen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cws-test-'));
    const file = join(dir, 'cws.json');
    await updateConfig(file, { item_id: 'aus-datei', client_id: 'c', client_secret: 's' });

    const plain = await readConfig({ env: {}, file });
    assert.equal(plain.itemId, 'aus-datei');
    assert.equal(plain.fileExists, true);

    const overridden = await readConfig({ env: { CWS_ITEM_ID: 'aus-umgebung' }, file });
    assert.equal(overridden.itemId, 'aus-umgebung');
    assert.equal(overridden.clientId, 'c');
  });

  it('ergaenzt Felder, ohne die vorhandenen zu verlieren', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cws-test-'));
    const file = join(dir, 'cws.json');
    await updateConfig(file, { item_id: 'i', client_secret: 's' });
    await updateConfig(file, { refresh_token: 'r' });

    const config = await readConfig({ env: {}, file });
    assert.equal(config.itemId, 'i');
    assert.equal(config.clientSecret, 's');
    assert.equal(config.refreshToken, 'r');
  });

  it('schreibt die Datei mit Rechten 600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cws-test-'));
    const file = join(dir, 'cws.json');
    await updateConfig(file, { refresh_token: 'geheim' });
    // Ein zweites Mal, weil `mode` bei writeFile nur beim Anlegen greift: eine
    // schon vorhandene, weltlesbare Datei muss trotzdem eng werden.
    await updateConfig(file, { refresh_token: 'geheim' });

    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, 'utf8'), /geheim/);
  });

  it('meldet eine fehlende Datei als fehlend, statt zu werfen', async () => {
    const config = await readConfig({ env: {}, file: join(tmpdir(), 'gibt-es-nicht', 'cws.json') });
    assert.equal(config.fileExists, false);
    assert.equal(config.refreshToken, undefined);
  });
});

/**
 * Minimales ZIP fuer die Tests — bewusst unabhaengig von tools/package.mjs,
 * damit der Leser nicht nur gegen seinen eigenen Schreiber geprueft wird.
 *
 * @param {Array<{ name: string, data: Buffer, stored?: boolean }>} entries
 * @param {string} [comment] Archivkommentar, verschiebt das Verzeichnisende
 */
function makeTestZip(entries, comment = '') {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.stored ? entry.data : deflateRawSync(entry.data);
    const method = entry.stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const note = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, dir, end, note]);
}

/** @param {string} version */
const manifestZip = (version) => makeTestZip([
  { name: 'background/service-worker.js', data: Buffer.from('// nichts') },
  { name: 'manifest.json', data: Buffer.from(JSON.stringify({ manifest_version: 3, version })) },
]);

describe('readZipEntry / zipManifestVersion', () => {
  it('liest deflate- und unkomprimierte Eintraege, auch hinter einem Archivkommentar', () => {
    const zip = makeTestZip([
      { name: 'a.txt', data: Buffer.from('gepackt '.repeat(50)) },
      { name: 'b.txt', data: Buffer.from('roh'), stored: true },
    ], 'Kommentar am Ende');
    assert.equal(readZipEntry(zip, 'a.txt')?.toString(), 'gepackt '.repeat(50));
    assert.equal(readZipEntry(zip, 'b.txt')?.toString(), 'roh');
    assert.equal(readZipEntry(zip, 'c.txt'), null);
  });

  it('liest die Version aus dem Manifest im Paket', () => {
    assert.equal(zipManifestVersion(manifestZip('9.8.7')), '9.8.7');
  });

  it('meldet ein Paket ohne Manifest und Nicht-ZIPs', () => {
    assert.throws(() => zipManifestVersion(makeTestZip([{ name: 'x', data: Buffer.from('y') }])), /manifest\.json/);
    assert.throws(() => zipManifestVersion(Buffer.from('kein zip, nur Text, lang genug fuer den Kopf')), /Kein ZIP/);
  });

  it('liest auch das ZIP, das tools/package.mjs schreibt, wenn eines da ist', async (t) => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    let zip;
    try {
      zip = await readFile(join(ROOT, 'store', `schreibwerkstatt-chrome-${pkg.version}.zip`));
    } catch {
      t.skip('kein gepacktes ZIP vorhanden (`npm run package`)');
      return;
    }
    assert.match(zipManifestVersion(zip), /^\d+(\.\d+){0,3}$/);
  });
});

describe('store-publish prueft die Paketversion vor jedem Netzzugriff', () => {
  /**
   * Startet das Werkzeug mit Attrappen-Zugangsdaten und `--zip=`. Die
   * Versionspruefung liegt vor `accessToken()`; schlaegt sie an, geht keine
   * Anfrage hinaus.
   *
   * @param {Buffer} zip
   */
  async function publishWithZip(zip) {
    const dir = await mkdtemp(join(tmpdir(), 'cws-publish-'));
    const zipFile = join(dir, 'paket.zip');
    await writeFile(zipFile, zip);
    return spawnSync(process.execPath, [join(ROOT, 'tools', 'store-publish.mjs'), '--dry-run', `--zip=${zipFile}`], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        CWS_CONFIG: join(dir, 'cws.json'),
        CWS_ITEM_ID: 'attrappe',
        CWS_CLIENT_ID: 'attrappe',
        CWS_CLIENT_SECRET: 'attrappe',
        CWS_REFRESH_TOKEN: 'attrappe',
      },
    });
  }

  it('bricht bei --zip= mit abweichender Manifest-Version ab', async () => {
    const zip = manifestZip('0.0.1');
    const result = await publishWithZip(zip);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /manifest\.json im Paket 0\.0\.1/);
    // Abbruch vor der Zusammenfassung und vor dem Item-Abruf.
    assert.doesNotMatch(result.stdout, /Entwurf im Store/);
    assert.doesNotMatch(result.stdout, new RegExp(createHash('sha256').update(zip).digest('hex')));
  });

  it('bricht bei einem Archiv ohne Manifest ab', async () => {
    const result = await publishWithZip(makeTestZip([{ name: 'x.js', data: Buffer.from('1') }]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /kein manifest\.json/);
  });
});
