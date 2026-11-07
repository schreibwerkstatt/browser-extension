/**
 * Integrationstest: API-Client, Faehigkeits-Erkennung, Erfassungsablauf
 * und Warteschlange gegen einen Mock-Server, der den Vertrag nachbaut.
 *
 * Es wird kein echter Server gebraucht — der Mock laeuft auf 127.0.0.1.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { clientVersion, createApiClient, describeDevice } from '../src/background/api-client.js';
import { probeCapabilities, probeResearchList } from '../src/background/capabilities.js';
import {
  buildResearchPayload,
  buildSourcePayload,
  runCaptureJob,
  toBase64,
  toBinary,
} from '../src/background/capture-runner.js';
import { createQueue } from '../src/background/queue.js';
import { startMockServer } from './helpers/mock-server.js';
import { JOB_STATE } from '../src/shared/config.js';
import { LIMITS } from '../src/shared/limits.js';
import { summarizeDuplicates } from '../src/shared/duplicates.js';
import { describeError, isRetryable, isScopeError, messageKeyForError } from '../src/shared/errors.js';
import { incompleteNotices } from '../src/shared/outcome.js';

const CLIENT_INFO = { platform: 'chrome', device: 'Chrome 131 / Linux', version: '0.1.0' };

/**
 * @param {{url: string}} server
 * @param {object} [overrides]
 */
function makeClient(server, overrides = {}) {
  const events = { auth: 0, scope: 0 };
  const api = createApiClient({
    getConfig: () => ({ serverUrl: server.url, token: 'swd_gueltig', ...overrides }),
    getClientInfo: () => CLIENT_INFO,
    onAuthError: () => {
      events.auth += 1;
    },
    onScopeError: () => {
      events.scope += 1;
    },
  });
  return { api, events };
}

function makeJob(intent, id = 'job_1') {
  return {
    id,
    createdAt: 0,
    attempts: 0,
    runAfter: 0,
    state: JOB_STATE.PENDING,
    lastError: null,
    intent,
    progress: {
      researchItemId: null,
      sourceId: null,
      linkedBookIds: [],
      imageUploaded: false,
      pdfUploaded: false,
      researchCreated: null,
      sourceCreated: null,
      sourceLinked: null,
      via: null,
    },
  };
}

const baseIntent = (overrides = {}) => ({
  mode: 'research',
  bookId: 1,
  bookName: 'Nordlicht',
  url: 'https://press.example.org/articles/jfs-2019-0417',
  normalizedUrl: 'https://press.example.org/articles/jfs-2019-0417',
  kind: 'quote',
  title: 'Sediment transport under partial ice cover',
  body: 'Transport rates diverged sharply from open-water predictions.',
  tags: ['eis', 'fluss'],
  urls: [{ url: 'https://press.example.org/articles/jfs-2019-0417/pdf', label: 'PDF' }],
  source: {
    csl_type: 'article',
    title: 'Sediment transport under partial ice cover',
    authors: [{ family: 'Halvorsen', given: 'Ingrid M.' }],
    editors: [],
    container_title: 'Journal of Fluvial Studies',
    publisher: 'Northfield Academic Press',
    place: '',
    year: 2019,
    url: 'https://press.example.org/articles/jfs-2019-0417',
    doi: '10.1234/jfs.2019.0417',
    isbn: '',
    accessed_at: '2026-07-31',
    note: '',
  },
  attachments: {},
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('API-Client', () => {
  /** @type {any} */
  let server;

  before(async () => {
    server = await startMockServer();
  });
  after(async () => server.close());

  it('schickt die vereinbarten Kopfzeilen mit', async () => {
    const { api } = makeClient(server);
    await api.getBooks();
    const call = server.calls('GET /content/books').at(-1);
    assert.equal(call.headers.authorization, 'Bearer swd_gueltig');
    assert.equal(call.headers['x-client-platform'], 'chrome');
    assert.equal(call.headers['x-client-device'], 'Chrome 131 / Linux');
    // Mit Praefix, obwohl `CLIENT_INFO.version` nackt ist: der Server liest die
    // Plattform eines Geraete-Tokens NUR aus dieser Zeichenkette
    // (`/chrome/i` auf `client_version`), weil `device_tokens.platform` bei
    // Erweiterungs-Tokens NULL bleibt. Eine nackte `0.1.0` waere fuer ihn die
    // macOS-App — mitsamt falschem „veraltet" im Admin-Tab.
    assert.equal(CLIENT_INFO.version, '0.1.0');
    assert.equal(call.headers['x-client-version'], 'chrome/0.1.0');
    assert.match(call.headers['x-client-version'], /^chrome\//);
    assert.equal(clientVersion('chrome', '1.1.1'), 'chrome/1.1.1');
  });

  it('liefert die Buecher inklusive Rollen', async () => {
    const { api } = makeClient(server);
    const books = await api.getBooks();
    assert.equal(books.length, 3);
    assert.deepEqual(
      books.map((b) => b.role),
      ['owner', 'editor', 'viewer'],
    );
  });

  it('meldet 401 NOT_LOGGED_IN und ruft onAuthError — ohne Retry', async () => {
    const { api, events } = makeClient(server, { token: 'swd_falsch' });
    await assert.rejects(
      () => api.getBooks(),
      (error) => {
        assert.equal(error.status, 401);
        assert.equal(error.code, 'NOT_LOGGED_IN');
        return true;
      },
    );
    assert.equal(events.auth, 1);
  });

  it('meldet 403 DEVICE_SCOPE_FORBIDDEN und ruft onScopeError', async () => {
    const scoped = await startMockServer({ tokenHasCaptureScope: false });
    try {
      const { api, events } = makeClient(scoped);
      await assert.rejects(
        () => api.createResearchItem({ book_id: 1, title: 'x' }),
        (error) => {
          assert.equal(error.status, 403);
          // Der Code, den der Server wirklich sendet. `CAPTURE_SCOPE_REQUIRED`
          // gab es nie — dadurch feuerte `onScopeError` nie, und der Nutzer sah
          // den allgemeinen 403-Text statt des Hinweises auf die Token-Art.
          assert.equal(error.code, 'DEVICE_SCOPE_FORBIDDEN');
          assert.equal(isScopeError(error), true);
          return true;
        },
      );
      assert.equal(events.scope, 1);
    } finally {
      await scoped.close();
    }
  });

  it('die Meldung zum fehlenden Scope spricht ueber das TOKEN, nicht ueber das Buch', async () => {
    const scoped = await startMockServer({ tokenHasCaptureScope: false });
    try {
      const { api } = makeClient(scoped);
      const error = await api.createResearchItem({ book_id: 1, title: 'x' }).then(() => null, (e) => e);
      const described = describeError(error, (key) => key);
      assert.equal(described.key, 'err_device_scope_forbidden');
      assert.equal(described.scope, true);
      assert.equal(described.retryable, false);
    } finally {
      await scoped.close();
    }
  });

  it('zerbricht nicht an einer HTML-Antwort ohne error_code (413 vom Body-Parser)', async () => {
    // Der Server hat keinen globalen Express-Fehler-Handler: ein zu grosser
    // Koerper wird vom Body-Parser mit HTML abgewiesen. `res.json()` waere hier
    // gescheitert und der Auftrag aus dem falschen Grund verloren.
    const big = await startMockServer();
    try {
      const { api } = makeClient(big);
      const error = await api
        .createResearchItem({ book_id: 1, body: 'x'.repeat(300 * 1024) })
        .then(() => null, (e) => e);
      assert.equal(error.status, 413);
      assert.equal(error.code, '', 'der Parser schickt keinen error_code');
      assert.equal(error.jsonBody, false);
      // Trotzdem eine brauchbare Meldung — ueber den HTTP-Status.
      assert.equal(messageKeyForError(error), 'err_payload_too_large');
      assert.equal(isRetryable(error), false, 'die Datei wird nicht kleiner');
    } finally {
      await big.close();
    }
  });

  it('zerbricht nicht an einer HTML-Antwort ohne error_code (400 bei kaputtem JSON)', async () => {
    const server2 = await startMockServer();
    try {
      const { api } = makeClient(server2);
      const error = await api
        .request('/research', { method: 'POST', body: '{kaputt', contentType: 'application/json' })
        .then(() => null, (e) => e);
      assert.equal(error.status, 400);
      assert.equal(error.code, '');
      assert.equal(error.jsonBody, false);
      assert.equal(messageKeyForError(error), 'err_status_400');
      // Der HTML-Rumpf darf nicht als Meldung durchsickern.
      assert.equal(/<html/i.test(describeError(error, (key) => key).text), false);
    } finally {
      await server2.close();
    }
  });

  it('verweigert Anfragen ohne Server oder Token, bevor es ins Netz geht', async () => {
    const noServer = createApiClient({
      getConfig: () => ({ serverUrl: '', token: 'swd_x' }),
      getClientInfo: () => CLIENT_INFO,
    });
    await assert.rejects(() => noServer.getBooks(), { code: 'NO_SERVER_CONFIGURED' });

    const noToken = createApiClient({
      getConfig: () => ({ serverUrl: server.url, token: '' }),
      getClientInfo: () => CLIENT_INFO,
    });
    await assert.rejects(() => noToken.getBooks(), { code: 'NO_TOKEN_CONFIGURED' });
  });

  it('meldet einen Netzfehler als solchen', async () => {
    const dead = createApiClient({
      getConfig: () => ({ serverUrl: 'http://127.0.0.1:1', token: 'swd_x' }),
      getClientInfo: () => CLIENT_INFO,
    });
    await assert.rejects(
      () => dead.getBooks(),
      (error) => {
        assert.equal(error.networkError, true);
        assert.equal(error.status, 0);
        return true;
      },
    );
  });

  it('schlaegt DOIs nach', async () => {
    const { api } = makeClient(server);
    const result = await api.lookup({ doi: '10.1234/jfs.2019.0417' });
    assert.equal(result.source.container_title, 'Journal of Fluvial Studies');
    assert.equal(server.calls('GET /sources/lookup').at(-1).query.doi, '10.1234/jfs.2019.0417');
  });
});

// ---------------------------------------------------------------------------

describe('Faehigkeits-Erkennung', () => {
  it('erkennt einen Server ohne die neuen Endpunkte', async () => {
    const server = await startMockServer({ hasCapture: false, hasByUrl: false, hasResearchList: false });
    try {
      const { api } = makeClient(server);
      assert.deepEqual(await probeCapabilities(api), {
        capture: false,
        byUrl: false,
        researchList: false,
        researchScopeMissing: false,
      });
    } finally {
      await server.close();
    }
  });

  it('erkennt einen Server mit den neuen Endpunkten', async () => {
    const server = await startMockServer({ hasCapture: true, hasByUrl: true, hasResearchList: true });
    try {
      const { api } = makeClient(server);
      // /capture antwortet auf den leeren Probe-Body mit 400 + error_code,
      // /sources/by-url mit 404 + error_code, /research mit 400 INVALID_ID —
      // alle drei heissen „Route ist da".
      assert.deepEqual(await probeCapabilities(api), {
        capture: true,
        byUrl: true,
        researchList: true,
        researchScopeMissing: false,
      });
    } finally {
      await server.close();
    }
  });

  it('legt beim Proben nichts an', async () => {
    const server = await startMockServer({ hasCapture: true, hasByUrl: true, hasResearchList: true });
    try {
      const { api } = makeClient(server);
      await probeCapabilities(api);
      assert.equal(server.state.researchItems.size, 0);
      assert.equal(server.state.sources.size, 0);
    } finally {
      await server.close();
    }
  });

  it('sagt bei einem Auth-Problem „unbekannt" statt „nicht vorhanden"', async () => {
    const server = await startMockServer({ hasCapture: true, hasByUrl: true, hasResearchList: true });
    try {
      const { api } = makeClient(server, { token: 'swd_falsch' });
      assert.deepEqual(await probeCapabilities(api), {
        capture: null,
        byUrl: null,
        researchList: null,
        researchScopeMissing: false,
      });
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Erfassung: Fallback-Pfad (ohne /capture)', () => {
  /** @type {any} */
  let server;
  const caps = { capture: false, byUrl: false };

  before(async () => {
    server = await startMockServer({ hasCapture: false, hasByUrl: false });
  });
  after(async () => server.close());

  it('mode=research schickt genau einen POST /research mit der URL in `source`', async () => {
    const { api } = makeClient(server);
    const job = makeJob(baseIntent({ mode: 'research' }));
    await runCaptureJob(job, { api, capabilities: caps });

    const call = server.calls('POST /research').at(-1);
    assert.equal(call.body.book_id, 1);
    assert.equal(call.body.kind, 'quote');
    assert.equal(call.body.source, 'https://press.example.org/articles/jfs-2019-0417');
    assert.deepEqual(call.body.tags, ['eis', 'fluss']);
    assert.deepEqual(call.body.urls, [
      { url: 'https://press.example.org/articles/jfs-2019-0417/pdf', label: 'PDF' },
    ]);
    assert.ok(job.progress.researchItemId);
    assert.equal(job.progress.sourceId, null);
    assert.equal(job.progress.via, 'split');
  });

  it('mode=source geht den Zwei-Request-Pfad: POST /sources, dann /link', async () => {
    const { api } = makeClient(server);
    const job = makeJob(baseIntent({ mode: 'source' }), 'job_source');
    await runCaptureJob(job, { api, capabilities: caps });

    const create = server.calls('POST /sources').at(-1);
    assert.equal(create.body.csl_type, 'article');
    assert.equal(create.body.doi, '10.1234/jfs.2019.0417');
    // book_id gehoert laut Vertrag in den eigenen /link-Request.
    assert.equal(create.body.book_id, undefined);

    const link = server.calls(`POST /sources/${job.progress.sourceId}/link`).at(-1);
    assert.equal(link.body.book_id, 1);
    assert.deepEqual(job.progress.linkedBookIds, [1]);
  });

  it('mode=both legt beides an', async () => {
    const { api } = makeClient(server);
    const before = server.calls('POST /research').length;
    const job = makeJob(
      baseIntent({
        mode: 'both',
        url: 'https://press.example.org/articles/beides',
        normalizedUrl: 'https://press.example.org/articles/beides',
        urls: [],
      }),
      'job_both',
    );
    await runCaptureJob(job, { api, capabilities: caps });

    assert.equal(server.calls('POST /research').length, before + 1);
    assert.ok(job.progress.researchItemId);
    assert.ok(job.progress.sourceId);
  });

  it('409 DUPLICATE_URL: zweites Zitat derselben Seite wird mit allow_duplicate nachgesendet', async () => {
    // Seit Server v4.15.0 lehnt POST /research eine schon erfasste URL ab.
    // Zwei Zitate aus derselben Seite sind zwei Funde — wie bei /capture.
    const { api } = makeClient(server);
    const intent = baseIntent({
      mode: 'research',
      url: 'https://press.example.org/articles/doppelt',
      normalizedUrl: 'https://press.example.org/articles/doppelt',
      urls: [{ url: 'https://press.example.org/articles/doppelt', label: '' }],
    });
    await runCaptureJob(makeJob(intent, 'job_dup_1'), { api, capabilities: caps });

    const before = server.calls('POST /research').length;
    const second = makeJob({ ...intent, body: 'Ein anderes Zitat von derselben Seite.' }, 'job_dup_2');
    await runCaptureJob(second, { api, capabilities: caps });

    const calls = server.calls('POST /research').slice(before);
    assert.equal(calls.length, 2);
    // Erster Anlauf OHNE das Feld — ein aelterer Server bekommt es nie zu sehen.
    assert.equal(calls[0].body.allow_duplicate, undefined);
    assert.equal(calls[1].body.allow_duplicate, true);
    assert.ok(second.progress.researchItemId);
    assert.equal(second.progress.researchCreated, true);
  });

  it('eine URL ueber 2000 Zeichen wird abgelehnt, nicht gekuerzt — und nie gesendet', async () => {
    const { api } = makeClient(server);
    const long = `https://press.example.org/${'a'.repeat(2100)}`;
    const before = server.log.length;
    await assert.rejects(
      runCaptureJob(
        makeJob(baseIntent({ mode: 'research', urls: [{ url: long, label: '' }] }), 'job_long_url'),
        { api, capabilities: caps },
      ),
      (error) => {
        const err = /** @type {any} */ (error);
        assert.equal(err.code, 'CLIENT_VALIDATION_FAILED');
        assert.equal(err.params.rule, 'validation_url_too_long');
        assert.equal(isRetryable(err), false);
        return true;
      },
    );
    assert.equal(server.log.length, before);
  });

  it('bei CITEKEY_TAKEN wird ohne citekey erneut gesendet', async () => {
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'source' });
    intent.source = { ...intent.source, citekey: 'muster2019', url: 'https://example.org/anders' };
    const job = makeJob(intent, 'job_citekey');

    const before = server.calls('POST /sources').length;
    await runCaptureJob(job, { api, capabilities: caps });
    const calls = server.calls('POST /sources').slice(before);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.citekey, 'muster2019');
    assert.equal('citekey' in calls[1].body, false);
    assert.ok(job.progress.sourceId);

    // Der Auftrag gelingt — und verliert dabei den Schluessel, den der Nutzer
    // selbst eingetippt hat. Er verlaesst gleich darauf die Warteschlange,
    // also muss der Vermerk hier stehen, sonst gibt es ihn nirgends mehr.
    assert.equal(job.progress.citekeyDropped, 'muster2019');
    assert.deepEqual(incompleteNotices(job.progress), [
      { key: 'notice_citekey_dropped', substitutions: ['muster2019'] },
    ]);
  });

  it('ohne Kollision bleibt der Zitierschluessel unvermerkt', async () => {
    // Gegenprobe: der Vermerk darf nicht am blossen Vorhandensein eines
    // Schluessels haengen, sonst meldet jede Quelle einen Verlust.
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'source' });
    intent.source = { ...intent.source, citekey: 'frei2026', url: 'https://example.org/frei' };
    const job = makeJob(intent, 'job_citekey_frei');

    await runCaptureJob(job, { api, capabilities: caps });

    assert.equal(job.progress.citekeyDropped, undefined);
    assert.deepEqual(incompleteNotices(job.progress), []);
  });

  it('lehnt eine Quelle ohne Titel und ohne Person clientseitig ab', async () => {
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'source' });
    intent.source = { ...intent.source, title: '', authors: [], editors: [] };
    const job = makeJob(intent, 'job_leer');

    const before = server.calls('POST /sources').length;
    await assert.rejects(
      () => runCaptureJob(job, { api, capabilities: caps }),
      (error) => {
        assert.equal(error.code, 'CLIENT_VALIDATION_FAILED');
        assert.equal(error.status, 400);
        assert.equal(error.params.rule, 'validation_source_identity');
        return true;
      },
    );
    // Nicht gesendet — der 400 wird gar nicht erst provoziert.
    assert.equal(server.calls('POST /sources').length, before);
  });

  it('lehnt ein zu langes Zitat clientseitig ab', async () => {
    const { api } = makeClient(server);
    const job = makeJob(baseIntent({ mode: 'research', body: 'x'.repeat(20001) }), 'job_lang');

    const before = server.calls('POST /research').length;
    await assert.rejects(() => runCaptureJob(job, { api, capabilities: caps }), {
      code: 'CLIENT_VALIDATION_FAILED',
    });
    assert.equal(server.calls('POST /research').length, before);
  });

  it('ein Buch mit nur viewer-Rolle endet in INSUFFICIENT_ROLE — mit Begruendung', async () => {
    // Das ist der Fehlerpfad, den die Store-Pruefung sehen soll. Der Client
    // erwartete hier lange `BOOK_ACCESS_DENIED`; den Code sendet niemand.
    const { api } = makeClient(server);
    const job = makeJob(baseIntent({ mode: 'research', bookId: 3 }), 'job_viewer');
    const error = await runCaptureJob(job, { api, capabilities: caps }).then(() => null, (e) => e);

    assert.equal(error.status, 403);
    assert.equal(error.code, 'INSUFFICIENT_ROLE');
    assert.deepEqual(error.params, { actual: 'viewer', required: 'editor' });

    // Die Meldung nennt Ist- und Soll-Rolle, nicht bloss „Zugriff verweigert".
    const described = describeError(error, (key, subs) => `${key}:${(subs || []).join('/')}`);
    assert.equal(described.text, 'err_insufficient_role:viewer/editor (INSUFFICIENT_ROLE)');
    assert.equal(described.retryable, false);
    // Eine Buchrolle ist kein Token-Problem: der globale Token-Zustand bleibt.
    assert.equal(described.scope, false);
  });

  it('ein unbekanntes Buch endet in NO_BOOK_ACCESS — ohne zu verraten, ob es existiert', async () => {
    const { api } = makeClient(server);
    const job = makeJob(baseIntent({ mode: 'research', bookId: 99 }), 'job_fremd');
    await assert.rejects(() => runCaptureJob(job, { api, capabilities: caps }), {
      code: 'NO_BOOK_ACCESS',
      status: 403,
    });
  });

  it('haengt Screenshot und PDF an — das PDF an /sources/:id/doc, nicht /pdf', async () => {
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'both' });
    intent.source = { ...intent.source, url: 'https://example.org/mit-anhang' };
    intent.attachments = {
      screenshot: { bytes: toBase64(new Uint8Array([1, 2, 3, 4])), contentType: 'image/jpeg' },
      pdf: { bytes: toBase64(new Uint8Array(new Array(64).fill(7))), name: 'bericht.pdf' },
    };
    const job = makeJob(intent, 'job_anhang');
    await runCaptureJob(job, { api, capabilities: caps });

    const image = server.state.attachments.find((a) => a.kind === 'image');
    assert.equal(image.bytes, 4);
    assert.equal(image.contentType, 'image/jpeg');

    // Der Anhang-Endpunkt der Quelle heisst `doc`. `/sources/:id/pdf` gibt es
    // nicht; der Aufruf lief in ein HTML-404 und liess den ganzen Auftrag
    // scheitern, obwohl Fundstueck und Quelle schon standen.
    const pdf = server.state.attachments.find((a) => a.kind === 'source-doc');
    assert.equal(pdf.bytes, 64);
    assert.equal(pdf.id, job.progress.sourceId);
    assert.equal(pdf.contentType, 'application/pdf');
    // Dateiname als `?name=`, wie der Vertrag es vorsieht.
    assert.equal(pdf.name, 'bericht.pdf');
    assert.equal(job.progress.imageUploaded, true);
    assert.equal(job.progress.pdfUploaded, true);

    assert.deepEqual(
      server.routes().filter((route) => /\/pdf$/.test(route)),
      [],
      'kein einziger Aufruf auf den Phantom-Pfad /pdf',
    );
  });

  it('ohne Quelle geht das PDF an /research/:id/doc', async () => {
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'research' });
    intent.attachments = { pdf: { bytes: toBase64(new Uint8Array(new Array(32).fill(7))) } };
    const job = makeJob(intent, 'job_research_doc');
    await runCaptureJob(job, { api, capabilities: caps });

    const call = server.calls(`POST /research/${job.progress.researchItemId}/doc`).at(-1);
    assert.ok(call, 'der Anhang geht an das Fundstueck');
    assert.equal(job.progress.pdfUploaded, true);
  });

  it('ein zu grosses PDF wird VOR dem Request abgelehnt', async () => {
    // Sonst antwortet der Body-Parser mit HTML und der Nutzer liest
    // „Uebertragung abgebrochen" statt „das PDF ist zu gross".
    const { api } = makeClient(server);
    const intent = baseIntent({ mode: 'research' });
    intent.attachments = { pdf: { bytes: new Uint8Array(LIMITS.DOC_MAX_BYTES + 1) } };
    const job = makeJob(intent, 'job_pdf_gross');

    const before = server.log.length;
    const error = await runCaptureJob(job, { api, capabilities: caps }).then(() => null, (e) => e);
    assert.equal(error.code, 'CLIENT_DOC_TOO_LARGE');
    assert.equal(error.status, 413);
    assert.equal(isRetryable(error), false);
    // Das Fundstueck steht, aber die 25 MB gingen nie ins Netz.
    assert.equal(
      server.log.slice(before).some((entry) => /\/doc$/.test(entry.route)),
      false,
    );
  });
});

// ---------------------------------------------------------------------------

describe('Erfassung: /capture-Pfad', () => {
  it('nutzt einen einzigen Request, wenn der Endpunkt da ist', async () => {
    const server = await startMockServer({ hasCapture: true, hasByUrl: true });
    try {
      const { api } = makeClient(server);
      const job = makeJob(baseIntent({ mode: 'both' }));
      await runCaptureJob(job, { api, capabilities: { capture: true, byUrl: true } });

      assert.equal(server.calls('POST /capture').length, 1);
      assert.equal(server.calls('POST /research').length, 0);
      assert.equal(server.calls('POST /sources').length, 0);
      assert.equal(job.progress.via, 'capture');
      assert.ok(job.progress.researchItemId);
      assert.ok(job.progress.sourceId);
      assert.deepEqual(job.progress.linkedBookIds, [1]);
    } finally {
      await server.close();
    }
  });

  it('schickt ALLE Quellenfelder mit — der bessere Weg darf nicht das schlechtere Ergebnis liefern', async () => {
    // `/capture` trug lange nur die Haelfte: ohne `csl_type` setzte der Server
    // `website`, und `editors`, `publisher`, `place`, `isbn`, `note` fielen weg.
    // Ein Buch mit ISBN verlor auf dem Ein-Request-Pfad also Angaben, die der
    // Fallback-Pfad vollstaendig uebertrug.
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const intent = baseIntent({ mode: 'both' });
      intent.source = {
        ...intent.source,
        csl_type: 'book',
        editors: [{ family: 'Okonkwo', given: 'Chidi' }],
        publisher: 'Northfield Academic Press',
        place: 'Northfield',
        isbn: '9780306406157',
        note: 'Signatur 12/4',
      };
      await runCaptureJob(makeJob(intent, 'job_voll'), {
        api,
        capabilities: { capture: true, byUrl: false },
      });

      const body = server.calls('POST /capture').at(-1).body;
      assert.equal(body.csl_type, 'book', 'sonst legt der Server stillschweigend `website` an');
      assert.equal(body.isbn, '9780306406157');
      assert.equal(body.publisher, 'Northfield Academic Press');
      assert.equal(body.place, 'Northfield');
      assert.equal(body.note, 'Signatur 12/4');
      assert.deepEqual(body.editors, [{ family: 'Okonkwo', given: 'Chidi' }]);
      assert.equal(body.source, intent.normalizedUrl);
      assert.equal(body.mode, 'both');
      assert.equal(body.kind, 'quote');
      assert.deepEqual(body.tags, ['eis', 'fluss']);
      assert.equal(body.accessed_at, '2026-07-31');

      // Gegenprobe: der Fallback-Pfad kennt kein Feld, das `/capture` fehlt.
      const fallback = buildSourcePayload(intent).payload;
      for (const field of ['csl_type', 'publisher', 'place', 'isbn', 'note', 'doi', 'year', 'editors']) {
        assert.ok(field in body, `\`${field}\` fehlt in der /capture-Payload`);
        assert.deepEqual(body[field], fallback[field], `\`${field}\` weicht vom Fallback-Pfad ab`);
      }
    } finally {
      await server.close();
    }
  });

  /**
   * `urls[]` wird nach SERVER-Regeln entdoppelt, gesendet wird der Wortlaut.
   * Vorher war der Schluessel die getrimmte Zeichenkette — damit gingen zwei
   * Verweise raus, die der Server als eine Adresse liest.
   */
  it('entdoppelt urls[] so, wie der Server sie zusammenlegt', () => {
    const intent = baseIntent({ mode: 'research' });
    intent.urls = [
      { url: 'https://example.org/a/b/', label: 'canonical' },
      { url: 'http://www.example.org/a/b?utm_source=rss', label: 'spiegel' },
      { url: 'https://example.org/a/b.pdf', label: 'PDF' },
      { url: 'nicht-parsbar', label: 'kaputt' },
      { url: 'nicht-parsbar', label: 'kaputt' },
    ];

    const { payload } = buildResearchPayload(intent);

    assert.deepEqual(payload.urls, [
      // Der Wortlaut, nicht die normalisierte Form.
      { url: 'https://example.org/a/b/', label: 'canonical' },
      { url: 'https://example.org/a/b.pdf', label: 'PDF' },
      { url: 'nicht-parsbar', label: 'kaputt' },
    ]);
  });

  it('liest die Antwortflags: neu angelegt', async () => {
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const job = makeJob(baseIntent({ mode: 'both' }), 'job_neu');
      await runCaptureJob(job, { api, capabilities: { capture: true, byUrl: false } });

      assert.equal(job.progress.researchCreated, true);
      assert.equal(job.progress.sourceCreated, true);
      assert.equal(job.progress.sourceLinked, true);
    } finally {
      await server.close();
    }
  });

  it('liest die Antwortflags: „war schon drin" ist als solches erkennbar', async () => {
    // Ohne diese Flags gibt es keine Grundlage fuer die Auskunft, dass der
    // Server eine vorhandene Quelle wiederverwendet hat. Der Client protokollierte
    // stattdessen `result.created` — ein Feld, das der Vertrag nicht kennt.
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const caps = { capture: true, byUrl: false };

      const first = makeJob(baseIntent({ mode: 'both' }), 'job_erst');
      await runCaptureJob(first, { api, capabilities: caps });
      assert.equal(first.progress.sourceCreated, true);

      // Dieselbe Seite, dasselbe Buch, ein zweites Mal.
      const second = makeJob(baseIntent({ mode: 'both' }), 'job_zweit');
      await runCaptureJob(second, { api, capabilities: caps });

      assert.equal(second.progress.sourceId, first.progress.sourceId, 'Quelle wiederverwendet');
      assert.equal(second.progress.sourceCreated, false);
      // Die Quelle hing schon am Buch — nichts zu verknuepfen.
      assert.equal(second.progress.sourceLinked, false);
      // Ein wortgleiches Fundstueck im 10-Minuten-Fenster ist der Doppelklick.
      assert.equal(second.progress.researchCreated, false);
      assert.equal(second.progress.researchItemId, first.progress.researchItemId);
    } finally {
      await server.close();
    }
  });

  it('dieselbe Quelle in einem ANDEREN Buch wird verknuepft, nicht neu angelegt', async () => {
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const caps = { capture: true, byUrl: false };

      const first = makeJob(baseIntent({ mode: 'source' }), 'job_buch1');
      await runCaptureJob(first, { api, capabilities: caps });

      const second = makeJob(baseIntent({ mode: 'source', bookId: 2 }), 'job_buch2');
      await runCaptureJob(second, { api, capabilities: caps });

      assert.equal(second.progress.sourceCreated, false, 'Quelle existiert pro Dokument nur einmal');
      assert.equal(second.progress.sourceLinked, true, 'aber am neuen Buch haengt sie jetzt');
      assert.deepEqual([...server.state.links.get(first.progress.sourceId)].sort(), [1, 2]);
    } finally {
      await server.close();
    }
  });

  it('mit citekey nimmt der Auftrag den Fallback-Pfad — /capture kennt das Feld nicht', async () => {
    // `/capture` nimmt bewusst keinen `citekey` — der Zitierschluessel ist
    // Sache des Autors, `409 CITEKEY_TAKEN` deckt dort nur den Wettlauf ab
    // (geklaert am 2026-08-02). Ihn mitzuschicken waere ein erfundenes Feld,
    // ihn wegzulassen stiller Datenverlust. Also dauerhaft den Weg nehmen,
    // der ihn uebertraegt — das ist kein Provisorium.
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const intent = baseIntent({ mode: 'source' });
      intent.source = { ...intent.source, citekey: 'halvorsen2019' };
      const job = makeJob(intent, 'job_citekey_capture');

      await runCaptureJob(job, { api, capabilities: { capture: true, byUrl: false } });

      assert.equal(server.calls('POST /capture').length, 0, '/capture wuerde den citekey verlieren');
      assert.equal(server.calls('POST /sources').at(-1).body.citekey, 'halvorsen2019');
      assert.equal(job.progress.via, 'split');
    } finally {
      await server.close();
    }
  });

  it('kuerzt die Payload auf die Serverlimits, bevor sie hinausgeht', async () => {
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const intent = baseIntent({ mode: 'research', kind: 'link', title: 'T'.repeat(400) });
      intent.body = 'B'.repeat(LIMITS.BODY_MAX + 500);
      await runCaptureJob(makeJob(intent, 'job_lang_capture'), {
        api,
        capabilities: { capture: true, byUrl: false },
      });

      const body = server.calls('POST /capture').at(-1).body;
      // Was ankommt, ist auch, was gespeichert wird — keine Quittung ueber
      // einen Text, den der Server danach still abgeschnitten haette.
      assert.equal(body.title.length, LIMITS.TITLE_MAX);
      assert.equal(body.body.length, LIMITS.BODY_MAX);
    } finally {
      await server.close();
    }
  });

  it('ein Zitat ueber dem Limit wird abgelehnt, nicht heimlich gekuerzt', async () => {
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const intent = baseIntent({ mode: 'research', kind: 'quote' });
      intent.body = 'Z'.repeat(LIMITS.BODY_MAX + 1);
      const job = makeJob(intent, 'job_zitat_lang');

      await assert.rejects(() => runCaptureJob(job, { api, capabilities: { capture: true, byUrl: false } }), {
        code: 'CLIENT_VALIDATION_FAILED',
      });
      // Nichts gesendet: der Wortlaut haette dabei Schaden genommen.
      assert.equal(server.calls('POST /capture').length, 0);
      assert.equal(server.calls('POST /research').length, 0);
    } finally {
      await server.close();
    }
  });

  it('mode=source: eine zu lange `url` wird auch hier vorher abgelehnt', async () => {
    // `validateResearchPayload` laeuft im Quellen-Modus nicht — die Adress-
    // pruefung muss trotzdem greifen, denn `/capture` weist sie ab (api 6).
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      const intent = baseIntent({ mode: 'source' });
      intent.source = { ...intent.source, url: `https://press.example.org/${'a'.repeat(2100)}` };
      const job = makeJob(intent, 'job_quelle_lang');

      await assert.rejects(() => runCaptureJob(job, { api, capabilities: { capture: true, byUrl: false } }), {
        code: 'CLIENT_VALIDATION_FAILED',
      });
      assert.equal(server.calls('POST /capture').length, 0);
    } finally {
      await server.close();
    }
  });

  it('der Mock spiegelt api 6: /capture weist eine zu lange URL mit INVALID_URL ab', async () => {
    // Gegenprobe, dass die Attrappe den Vertrag kennt — sonst waere der Test
    // darueber wertlos.
    const server = await startMockServer({ hasCapture: true });
    try {
      const { api } = makeClient(server);
      await assert.rejects(
        () => api.capture({ book_id: 1, mode: 'research', url: `https://example.org/${'a'.repeat(2100)}`, title: 'T' }),
        (error) => {
          const err = /** @type {any} */ (error);
          assert.equal(err.code, 'INVALID_URL');
          assert.equal(err.params.max, 2000);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it('faellt auf den langen Weg zurueck, wenn der Endpunkt doch fehlt', async () => {
    const server = await startMockServer({ hasCapture: false, hasByUrl: false });
    try {
      const { api } = makeClient(server);
      const missing = [];
      const job = makeJob(baseIntent({ mode: 'both' }));

      // Die Faehigkeit ist faelschlich als vorhanden gemeldet.
      await runCaptureJob(job, {
        api,
        capabilities: { capture: true, byUrl: false },
        onCapabilityMissing: (name) => missing.push(name),
      });

      assert.deepEqual(missing, ['capture']);
      assert.equal(server.calls('POST /research').length, 1);
      assert.equal(server.calls('POST /sources').length, 1);
      assert.ok(job.progress.researchItemId);
      assert.ok(job.progress.sourceId);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Doppelklick-Schutz ueber /sources/by-url', () => {
  it('verwendet eine vorhandene Quelle wieder, statt sie doppelt anzulegen', async () => {
    const server = await startMockServer({ hasByUrl: true });
    try {
      const { api } = makeClient(server);
      const caps = { capture: false, byUrl: true };

      const first = makeJob(baseIntent({ mode: 'source' }), 'job_a');
      await runCaptureJob(first, { api, capabilities: caps });

      const before = server.calls('POST /sources').length;
      const second = makeJob(baseIntent({ mode: 'source', bookId: 2 }), 'job_b');
      await runCaptureJob(second, { api, capabilities: caps });

      // Keine zweite Quelle, aber eine Verknuepfung zum anderen Buch.
      assert.equal(server.calls('POST /sources').length, before);
      assert.equal(second.progress.sourceId, first.progress.sourceId);
      assert.deepEqual(second.progress.linkedBookIds, [2]);
      assert.deepEqual([...server.state.links.get(first.progress.sourceId)], [1, 2]);
    } finally {
      await server.close();
    }
  });

  it('ein 404 heisst schlicht „noch nicht da"', async () => {
    const server = await startMockServer({ hasByUrl: true });
    try {
      const { api } = makeClient(server);
      const job = makeJob(baseIntent({ mode: 'source' }));
      await runCaptureJob(job, { api, capabilities: { capture: false, byUrl: true } });
      assert.equal(server.calls('POST /sources').length, 1);
      assert.ok(job.progress.sourceId);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Lesepfad GET /research', () => {
  /** @param {Partial<Record<string, any>>} [overrides] */
  const row = (overrides = {}) => ({
    id: 1,
    book_id: 1,
    kind: 'link',
    title: 'Sediment transport under partial ice cover',
    source: 'https://press.example.org/articles/jfs-2019-0417',
    body: 'Transport rates diverged sharply from open-water predictions.',
    urls: [{ url: 'https://press.example.org/articles/jfs-2019-0417/pdf', label: 'PDF' }],
    tags: ['eis'],
    links: [],
    pinned: false,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  });

  /** @param {Record<string, any>} [options] */
  const withServer = async (options, run) => {
    const server = await startMockServer({ hasResearchList: true, ...options });
    try {
      return await run(server, makeClient(server));
    } finally {
      await server.close();
    }
  };

  it('liefert genau die vertraglich zugesagten Felder', async () => {
    await withServer({ researchIndex: [row()] }, async (server, { api }) => {
      const items = await api.listResearch({ bookId: 1 });
      assert.equal(items.length, 1);
      assert.deepEqual(Object.keys(items[0]).sort(), [
        'body_snippet',
        'created_at',
        'id',
        'kind',
        'source',
        'title',
        'updated_at',
        'urls',
      ]);
      // Weder `body` noch `tags`, `pinned`, `archived` oder `book_id`.
      assert.equal('body' in items[0], false);
      assert.equal('tags' in items[0], false);
      assert.match(items[0].created_at, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      assert.equal(server.calls('GET /research').length, 1);
    });
  });

  it('schickt Bearer-Token und X-Client-Platform mit', async () => {
    await withServer({ researchIndex: [row()] }, async (server, { api }) => {
      await api.listResearch({ bookId: 1 });
      const headers = server.calls('GET /research')[0].headers;
      assert.equal(headers.authorization, 'Bearer swd_gueltig');
      assert.equal(headers['x-client-platform'], 'chrome');
    });
  });

  it('kuerzt body_snippet auf 200 Zeichen mit Auslassung', async () => {
    await withServer({ researchIndex: [row({ body: 'x'.repeat(500) })] }, async (_server, { api }) => {
      const [item] = await api.listResearch({ bookId: 1 });
      assert.equal(item.body_snippet.length, 201);
      assert.ok(item.body_snippet.endsWith('…'));
    });
  });

  it('liefert Angeheftetes zuerst', async () => {
    const index = [
      row({ id: 1, updated_at: '2026-05-01T00:00:00.000Z' }),
      row({ id: 2, updated_at: '2026-01-01T00:00:00.000Z', pinned: true }),
    ];
    await withServer({ researchIndex: index }, async (_server, { api }) => {
      const items = await api.listResearch({ bookId: 1, sort: 'updated' });
      assert.deepEqual(items.map((i) => i.id), [2, 1]);
    });
  });

  it('liefert ohne archived=1 nur nicht-archivierte', async () => {
    const index = [row({ id: 1 }), row({ id: 2, archived: true })];
    await withServer({ researchIndex: index }, async (_server, { api }) => {
      assert.deepEqual((await api.listResearch({ bookId: 1 })).map((i) => i.id), [1]);
      assert.deepEqual(
        (await api.listResearch({ bookId: 1, archived: true })).map((i) => i.id).sort(),
        [1, 2],
      );
    });
  });

  it('ignoriert ein unbekanntes kind, statt zu scheitern', async () => {
    await withServer({ researchIndex: [row()] }, async (_server, { api }) => {
      const items = await api.listResearch({ bookId: 1, kind: 'gibtsnicht' });
      assert.equal(items.length, 1);
    });
  });

  // ------------------------------------------------------------- Grenzwerte

  it('schickt nie mehr als limit=200, egal was der Aufrufer will', async () => {
    await withServer({ researchIndex: [row()] }, async (server, { api }) => {
      await api.listResearch({ bookId: 1, limit: 5000 });
      assert.equal(server.calls('GET /research')[0].query.limit, '200');
    });
  });

  it('laesst limit weg, wenn der Wert unbrauchbar ist', async () => {
    await withServer({ researchIndex: [row()] }, async (server, { api }) => {
      await api.listResearch({ bookId: 1, limit: 0 });
      await api.listResearch({ bookId: 1, limit: -3 });
      await api.listResearch({ bookId: 1, limit: /** @type {any} */ ('viele') });
      for (const call of server.calls('GET /research')) {
        assert.equal('limit' in call.query, false);
      }
    });
  });

  it('der 500er-Vorfilter greift VOR limit — deshalb ist ein leeres q-Ergebnis nichts wert', async () => {
    // 600 Eintraege, die alle auf `q` passen. Der Vorfilter kappt bei 500,
    // erst danach zieht `limit`. Der gesuchte 550. Eintrag ist damit
    // unerreichbar, obwohl er im Buch steht und auf die Query passt.
    const index = Array.from({ length: 600 }, (_, i) =>
      row({
        id: i + 1,
        title: `Eis ${i}`,
        body: 'eis',
        source: `https://press.example.org/artikel/${i}`,
        urls: [],
        updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      }),
    );
    await withServer({ researchIndex: index }, async (_server, { api }) => {
      const items = await api.listResearch({ bookId: 1, q: 'eis', limit: 200 });
      assert.equal(items.length, 200);

      const gesehen = new Set(items.map((i) => i.id));
      const alle = await api.listResearch({ bookId: 1, q: 'eis', limit: 200, sort: 'created' });
      assert.equal(alle.length, 200);
      // Der Beweis: mit q sieht der Client nie den vollen Bestand.
      assert.ok(gesehen.size < 600);
    });
  });

  // ----------------------------------------------------------- Fehlerfaelle

  it('400 INVALID_ID ohne book_id', async () => {
    await withServer({}, async (_server, { api }) => {
      const error = await api.listResearch({}).then(() => null, (e) => e);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'INVALID_ID');
      assert.equal(isRetryable(error), false);
    });
  });

  it('401 NOT_LOGGED_IN bei ungueltigem Token', async () => {
    await withServer({}, async (server) => {
      const { api, events } = makeClient(server, { token: 'swd_falsch' });
      const error = await api.listResearch({ bookId: 1 }).then(() => null, (e) => e);
      assert.equal(error.status, 401);
      assert.equal(error.code, 'NOT_LOGGED_IN');
      assert.equal(events.auth, 1);
    });
  });

  it('403 DEVICE_SCOPE_FORBIDDEN ohne content:read — endgueltig, kein Retry', async () => {
    await withServer({ tokenHasReadScope: false }, async (_server, { api }) => {
      const error = await api.listResearch({ bookId: 1 }).then(() => null, (e) => e);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'DEVICE_SCOPE_FORBIDDEN');
      assert.equal(isScopeError(error), true);
      assert.equal(isRetryable(error), false);
      assert.equal(error.path, '/research');
    });
  });

  it('ein fehlender Lese-Scope faerbt den globalen Token-Zustand nicht ein', async () => {
    await withServer({ tokenHasReadScope: false }, async (server) => {
      const { api, events } = makeClient(server);
      await api.listResearch({ bookId: 1 }).catch(() => {});
      // Das Token darf weiterhin erfassen — `onScopeError` waere hier falsch.
      assert.equal(events.scope, 0);

      // Auf dem Schreibpfad greift der Haken dagegen wie bisher.
      const write = await startMockServer({ tokenHasCaptureScope: false });
      try {
        const second = makeClient(write);
        await second.api.createResearchItem({ book_id: 1, title: 'x' }).catch(() => {});
        assert.equal(second.events.scope, 1);
      } finally {
        await write.close();
      }
    });
  });

  it('403 NO_BOOK_ACCESS bei fremdem Buch', async () => {
    await withServer({}, async (_server, { api }) => {
      const error = await api.listResearch({ bookId: 9 }).then(() => null, (e) => e);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'NO_BOOK_ACCESS');
    });
  });

  it('403 INSUFFICIENT_ROLE nennt Ist- und Soll-Rolle aus `detail`', async () => {
    await withServer({}, async (_server, { api }) => {
      const error = await api.listResearch({ bookId: 3 }).then(() => null, (e) => e);
      assert.equal(error.code, 'INSUFFICIENT_ROLE');
      // Der Server nennt das Feld `detail`, nicht `params` — der Client muss
      // beides in dieselbe Ablage legen, sonst steht die Rolle nirgends.
      assert.deepEqual(error.params, { actual: 'viewer', required: 'editor' });
      const described = describeError(error, (key, subs) => `${key}:${(subs || []).join('/')}`);
      assert.equal(described.text, 'err_insufficient_role:viewer/editor (INSUFFICIENT_ROLE)');
    });
  });

  it('ein Server ohne die Route antwortet mit HTML — daran haengt die Probe', async () => {
    await withServer({ hasResearchList: false }, async (_server, { api }) => {
      const error = await api.listResearch({ bookId: 1 }).then(() => null, (e) => e);
      assert.equal(error.status, 404);
      assert.equal(error.jsonBody, false);
    });
  });

  // -------------------------------------------------- Faehigkeits-Erkennung

  it('Probe erkennt den vorhandenen Endpunkt am fachlichen 400', async () => {
    await withServer({}, async (server, { api }) => {
      assert.deepEqual(await probeResearchList(api), { detected: true, scopeMissing: false });
      assert.equal(server.calls('GET /research')[0].query.book_id, undefined);
    });
  });

  it('Probe erkennt den fehlenden Endpunkt am HTML-404', async () => {
    await withServer({ hasResearchList: false }, async (_server, { api }) => {
      assert.deepEqual(await probeResearchList(api), { detected: false, scopeMissing: false });
    });
  });

  it('Probe unterscheidet „Endpunkt fehlt" von „Scope fehlt"', async () => {
    await withServer({ tokenHasReadScope: false }, async (_server, { api }) => {
      assert.deepEqual(await probeResearchList(api), { detected: true, scopeMissing: true });
    });
  });
});

// ---------------------------------------------------------------------------

describe('Dublettenpruefung ueber den Lesepfad', () => {
  it('findet den vorhandenen Eintrag ueber die URL, ohne q zu benutzen', async () => {
    const index = [
      {
        id: 7,
        book_id: 1,
        kind: 'link',
        title: 'Citation',
        // Der Bestand haelt die Roh-URL: www., http, Trailing-Slash.
        source: 'http://www.press.example.org/articles/jfs-2019-0417/',
        body: '',
        urls: [],
        tags: [],
        links: [],
        pinned: false,
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const server = await startMockServer({ hasResearchList: true, researchIndex: index });
    try {
      const { api } = makeClient(server);
      const items = await api.listResearch({ bookId: 1, sort: 'updated', limit: 200 });
      const report = summarizeDuplicates({
        items,
        url: 'https://press.example.org/articles/jfs-2019-0417',
        limit: 200,
      });

      assert.equal(report.found, true);
      assert.equal(report.complete, true);
      // Kein Textbegriff im Spiel — sonst haenge der 500er-Deckel mit dran.
      assert.equal('q' in server.calls('GET /research')[0].query, false);
    } finally {
      await server.close();
    }
  });

  it('volles Ergebnis ohne Treffer ist „unvollstaendig", nicht „nicht vorhanden"', async () => {
    const index = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      book_id: 1,
      kind: 'link',
      title: `Eintrag ${i}`,
      source: `https://press.example.org/artikel/${i}`,
      body: '',
      urls: [],
      tags: [],
      links: [],
      pinned: false,
      archived: false,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
    }));
    const server = await startMockServer({ hasResearchList: true, researchIndex: index });
    try {
      const { api } = makeClient(server);
      const items = await api.listResearch({ bookId: 1, sort: 'updated', limit: 200 });
      const report = summarizeDuplicates({ items, url: 'https://press.example.org/neu', limit: 200 });

      assert.equal(report.found, false);
      assert.equal(report.complete, false);
      assert.equal(report.truncatedBy, 'limit');
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Warteschlange gegen den Mock-Server', () => {
  it('wiederholt nach 503 und legt dabei nichts doppelt an', async () => {
    const server = await startMockServer();
    try {
      const { api } = makeClient(server);
      let now = 0;
      let jobs = [];
      const queue = createQueue({
        load: async () => JSON.parse(JSON.stringify(jobs)),
        save: async (next) => {
          jobs = JSON.parse(JSON.stringify(next));
        },
        now: () => now,
        random: () => 0,
      });

      const job = await queue.add(baseIntent({ mode: 'both' }));

      // Erster Anlauf: der Server laesst genau die Quellen-Anlage scheitern,
      // nachdem das Recherche-Item schon steht.
      const stored = (await queue.list())[0];
      server.failNext(1, 503);
      // POST /research geht durch? Nein — failNext trifft den ersten Schreibzugriff.
      await assert.rejects(() =>
        runCaptureJob(stored, { api, capabilities: { capture: false, byUrl: false } }),
      );
      const result = await queue.fail(stored.id, { status: 503 }, stored.progress);
      assert.equal(result.willRetry, true);

      // Zweiter Anlauf: geht durch.
      now += 60_000;
      const due = await queue.due();
      assert.equal(due.length, 1);
      await runCaptureJob(due[0], { api, capabilities: { capture: false, byUrl: false } });
      await queue.complete(due[0].id);

      assert.equal((await queue.list()).length, 0);
      assert.equal(server.state.researchItems.size, 1);
      assert.equal(server.state.sources.size, 1);
    } finally {
      await server.close();
    }
  });

  it('ein Retry nach halbem Erfolg legt das Recherche-Item nicht erneut an', async () => {
    const server = await startMockServer();
    try {
      const { api } = makeClient(server);
      const caps = { capture: false, byUrl: false };
      const job = makeJob(baseIntent({ mode: 'both' }), 'job_halb');

      // Erst nur die Recherche-Haelfte laufen lassen …
      const researchOnly = { ...job, intent: { ...job.intent, mode: 'research' } };
      await runCaptureJob(researchOnly, { api, capabilities: caps });
      const researchId = researchOnly.progress.researchItemId;

      // … dann mit demselben Fortschritt als mode=both wiederholen.
      job.progress = researchOnly.progress;
      const before = server.calls('POST /research').length;
      await runCaptureJob(job, { api, capabilities: caps });

      assert.equal(server.calls('POST /research').length, before, 'kein zweites Recherche-Item');
      assert.equal(job.progress.researchItemId, researchId);
      assert.ok(job.progress.sourceId);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('Hilfsfunktionen', () => {
  it('base64 hin und zurueck', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const roundTrip = toBinary(toBase64(bytes));
    assert.deepEqual([...roundTrip], [...bytes]);
  });

  it('describeDevice liest userAgentData', () => {
    const value = describeDevice({
      userAgentData: {
        brands: [
          { brand: 'Not A(Brand', version: '99' },
          { brand: 'Google Chrome', version: '131' },
        ],
        platform: 'Linux',
      },
    });
    assert.equal(value, 'Google Chrome 131 / Linux');
  });

  it('describeDevice faellt auf den User-Agent zurueck', () => {
    const value = describeDevice({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    assert.equal(value, 'Chrome 131 / X11');
  });
});
