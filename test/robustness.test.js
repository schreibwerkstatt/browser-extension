/**
 * Befunde aus dem Review vom 2026-11-07, je mit einem Test festgenagelt:
 * Wettlaeufe in der Warteschlange, Fortschritt ueber einen Worker-Neustart,
 * `/capture` und seine Uploads, der Serverwechsel und die Anzeige von Fehlern,
 * die der Service Worker schon beschrieben hat.
 *
 * Bewusst mit Attrappen statt Mock-Server: geprueft wird der Ablauf im
 * Client, nicht der Vertrag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCaptureJob } from '../src/background/capture-runner.js';
import { createHandlers } from '../src/background/handlers.js';
import { createQueue } from '../src/background/queue.js';
import { createStore } from '../src/background/state.js';
import { JOB_STATE, STORAGE_KEYS } from '../src/shared/config.js';
import { ApiError, isRetryable } from '../src/shared/errors.js';
import { MSG } from '../src/shared/messages.js';
import { showUiError } from '../src/shared/notice.js';
import { incompleteNotices } from '../src/shared/outcome.js';

// ---------------------------------------------------------------- Helfer

function makeQueue(startTime = 1_000_000) {
  let jobs = [];
  let now = startTime;
  const queue = createQueue({
    load: async () => JSON.parse(JSON.stringify(jobs)),
    save: async (next) => {
      jobs = JSON.parse(JSON.stringify(next));
    },
    now: () => now,
    random: () => 0,
  });
  return { queue, advance: (ms) => (now += ms), raw: () => jobs };
}

const intent = (overrides = {}) => ({
  mode: 'research',
  bookId: 1,
  bookName: 'Nordlicht',
  url: 'https://schreibwerkstatt.example.com/a',
  normalizedUrl: 'https://schreibwerkstatt.example.com/a',
  kind: 'quote',
  title: 'Titel',
  body: 'Wortlaut',
  tags: [],
  urls: [],
  source: { title: 'Titel', authors: [], editors: [], csl_type: 'website' },
  attachments: {},
  ...overrides,
});

function makeJob(overrides = {}) {
  return {
    id: 'job_1',
    createdAt: 0,
    attempts: 0,
    runAfter: 0,
    state: JOB_STATE.PENDING,
    lastError: null,
    intent: intent(overrides),
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

/** Express-404 als HTML — so sieht ein fehlender Pfad aus. */
const htmlNotFound = () => new ApiError({ status: 404, message: 'Cannot POST' });

// ------------------------------------------------------------ Warteschlange

describe('queue.claim', () => {
  it('liefert null fuer einen inzwischen zurueckgenommenen Auftrag', async () => {
    const { queue, advance } = makeQueue();
    const job = await queue.add(intent(), { holdMs: 5000 });
    advance(5000);
    const snapshot = await queue.due();
    assert.equal(snapshot.length, 1);

    // Waehrend der Durchlauf noch probt, ist das Fenster offiziell noch offen.
    assert.equal(await queue.undo(job.id), true);
    assert.equal(await queue.claim(job.id), null);
  });

  it('liefert null fuer einen inzwischen verworfenen Auftrag', async () => {
    const { queue } = makeQueue();
    const job = await queue.add(intent());
    await queue.discard(job.id);
    assert.equal(await queue.claim(job.id), null);
  });

  it('setzt RUNNING und liefert den GESPEICHERTEN Fortschritt', async () => {
    const { queue, raw } = makeQueue();
    const job = await queue.add(intent());
    await queue.update(job.id, { progress: { ...job.progress, researchItemId: 42 } });
    const claimed = await queue.claim(job.id);
    assert.equal(claimed.progress.researchItemId, 42);
    assert.equal(raw()[0].state, JOB_STATE.RUNNING);
  });

  it('nimmt keinen gescheiterten Auftrag', async () => {
    const { queue } = makeQueue();
    const job = await queue.add(intent());
    await queue.fail(job.id, new ApiError({ status: 400, code: 'INVALID_VALUE' }));
    assert.equal(await queue.claim(job.id), null);
  });
});

describe('queue.nextWakeAt', () => {
  it('weckt auch fuer einen verwaisten RUNNING-Auftrag', async () => {
    const { queue } = makeQueue();
    const job = await queue.add(intent());
    await queue.claim(job.id); // Worker stirbt danach
    assert.equal(typeof (await queue.nextWakeAt()), 'number');
  });
});

describe('queue.add', () => {
  it('fuehrt beforeSave aus, BEVOR der Auftrag sichtbar wird', async () => {
    const { queue, raw } = makeQueue();
    /** @type {number[]} */
    const seen = [];
    await queue.add(intent(), {
      beforeSave: async () => {
        seen.push(raw().length);
      },
    });
    assert.deepEqual(seen, [0]);
    assert.equal(raw().length, 1);
  });

  it('merkt sich den Server, fuer den erfasst wurde', async () => {
    const { queue } = makeQueue();
    const job = await queue.add(intent(), { serverUrl: 'https://schreibwerkstatt.example.com' });
    assert.equal(job.serverUrl, 'https://schreibwerkstatt.example.com');
  });
});

// ---------------------------------------------------------------- Runner

describe('runCaptureJob: Fortschritt ueberlebt einen Abbruch', () => {
  it('meldet das angelegte Fundstueck, bevor die Quelle scheitert', async () => {
    /** @type {any[]} */
    const checkpoints = [];
    const api = {
      createResearchItem: async () => ({ id: 7 }),
      createSource: async () => {
        throw new ApiError({ status: 0, networkError: true });
      },
    };
    const job = makeJob({ mode: 'both' });
    await assert.rejects(
      runCaptureJob(job, {
        api: /** @type {any} */ (api),
        capabilities: { capture: false, byUrl: false },
        onProgress: (progress) => {
          checkpoints.push({ ...progress });
        },
      }),
    );
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].researchItemId, 7);
  });
});

describe('runCaptureJob: /capture', () => {
  const okCapture = async () => ({ research_item: { id: 3 }, research_created: true });

  it('ein HTML-404 beim Upload schaltet /capture NICHT ab', async () => {
    /** @type {string[]} */
    const missing = [];
    const api = {
      capture: okCapture,
      uploadResearchImage: async () => {
        throw htmlNotFound();
      },
    };
    const job = makeJob();
    job.intent.attachments = { screenshot: { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' } };
    await assert.rejects(
      runCaptureJob(job, {
        api: /** @type {any} */ (api),
        capabilities: { capture: true, byUrl: false },
        onCapabilityMissing: (name) => missing.push(name),
      }),
      (error) => /** @type {any} */ (error).status === 404,
    );
    assert.deepEqual(missing, []);
    assert.equal(job.progress.researchItemId, 3);
  });

  it('wiederholt 409 CITEKEY_TAKEN genau einmal — auf diesem Pfad ein Wettlauf', async () => {
    let calls = 0;
    const api = {
      capture: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError({ status: 409, code: 'CITEKEY_TAKEN' });
        return { source: { id: 9 }, source_created: true, source_linked: true };
      },
    };
    const job = makeJob({ mode: 'source' });
    await runCaptureJob(job, { api: /** @type {any} */ (api), capabilities: { capture: true, byUrl: false } });
    assert.equal(calls, 2);
    assert.equal(job.progress.sourceId, 9);
  });

  it('ein fehlender /capture-Pfad faellt weiterhin auf den Fallback zurueck', async () => {
    /** @type {string[]} */
    const missing = [];
    const api = {
      capture: async () => {
        throw htmlNotFound();
      },
      createResearchItem: async () => ({ id: 5 }),
    };
    const job = makeJob();
    await runCaptureJob(job, {
      api: /** @type {any} */ (api),
      capabilities: { capture: true, byUrl: false },
      onCapabilityMissing: (name) => missing.push(name),
    });
    assert.deepEqual(missing, ['capture']);
    assert.equal(job.progress.researchItemId, 5);
  });
});

// ------------------------------------------------------- Serverwechsel

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const out = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) if (key in data) out[key] = data[key];
      return out;
    },
    async set(patch) {
      Object.assign(data, patch);
    },
  };
}

const noop = async () => undefined;

async function credentialsFixture() {
  const store = createStore({ storage: memoryStorage() });
  await store.writeState({
    [STORAGE_KEYS.SERVER_URL]: 'https://alt.schreibwerkstatt.example.com',
    [STORAGE_KEYS.TOKEN]: 'swd_alt',
    [STORAGE_KEYS.DEFAULT_BOOK_ID]: 4,
  });
  const handlers = createHandlers(
    /** @type {any} */ ({ store, refreshBadge: noop }),
  );
  return { store, handlers };
}

describe('SAVE_CREDENTIALS beim Serverwechsel', () => {
  it('verlangt ein neues Token — das alte ginge sonst an den fremden Host', async () => {
    const { store, handlers } = await credentialsFixture();
    await assert.rejects(
      handlers[MSG.SAVE_CREDENTIALS]({ serverUrl: 'https://neu.schreibwerkstatt.example.com', token: '' }),
      (error) => /** @type {any} */ (error).code === 'CLIENT_TOKEN_REQUIRED',
    );
    const state = await store.readState();
    assert.equal(state[STORAGE_KEYS.SERVER_URL], 'https://alt.schreibwerkstatt.example.com');
  });

  it('setzt mit neuem Token das Standardbuch zurueck', async () => {
    const { store, handlers } = await credentialsFixture();
    await handlers[MSG.SAVE_CREDENTIALS]({ serverUrl: 'https://neu.schreibwerkstatt.example.com', token: 'swd_neu' });
    const state = await store.readState();
    assert.equal(state[STORAGE_KEYS.TOKEN], 'swd_neu');
    assert.equal(state[STORAGE_KEYS.DEFAULT_BOOK_ID], null);
  });

  it('behaelt auf demselben Server Token und Standardbuch', async () => {
    const { store, handlers } = await credentialsFixture();
    await handlers[MSG.SAVE_CREDENTIALS]({ serverUrl: 'https://alt.schreibwerkstatt.example.com/', token: '' });
    const state = await store.readState();
    assert.equal(state[STORAGE_KEYS.TOKEN], 'swd_alt');
    assert.equal(state[STORAGE_KEYS.DEFAULT_BOOK_ID], 4);
  });

  it('ein Auftrag fuer den alten Server wird nicht wiederholt, sondern gemeldet', () => {
    assert.equal(isRetryable(new ApiError({ code: 'CLIENT_SERVER_CHANGED' })), false);
  });
});

// ------------------------------------------------- Faehigkeits-Befunde

describe('saveDetectedCapabilities', () => {
  it('verliert bei gleichzeitigen Befunden keinen', async () => {
    const store = createStore({ storage: memoryStorage() });
    await Promise.all([
      store.saveDetectedCapabilities({ byUrl: false }),
      store.saveDetectedCapabilities({ researchList: true, researchScopeMissing: true }),
    ]);
    const caps = await store.getCapabilities();
    assert.equal(caps.byUrl.detected, false);
    assert.equal(caps.researchList.scopeMissing, true);
  });
});

// ------------------------------------------------------------- Anzeige

describe('showUiError', () => {
  it('zeigt einen schon beschriebenen Fehler unveraendert — kein „unbekannter Code NETWORK"', () => {
    /** @type {string[]} */
    const shown = [];
    showUiError(
      { code: 'NETWORK', key: 'err_network', message: 'Keine Verbindung (NETWORK)', status: 0, auth: true },
      { translate: (key) => key, onAuth: (text) => shown.push(text) },
    );
    assert.deepEqual(shown, ['Keine Verbindung (NETWORK)']);
  });
});

describe('incompleteNotices: Zitat aus Chromes selectionText', () => {
  it('vermerkt, dass der Wortlaut nicht originalgetreu ist', () => {
    assert.deepEqual(incompleteNotices({ quoteApproximate: true }), [
      { key: 'notice_quote_approximate', substitutions: [] },
    ]);
  });
});

describe('Kuerzen nach Server-Grenzen', () => {
  it('schneidet kein Surrogatpaar entzwei', async () => {
    const { clampResearchPayload, LIMITS } = await import('../src/shared/limits.js');
    const title = 'a'.repeat(LIMITS.TITLE_MAX - 1) + '😀';
    const { payload } = clampResearchPayload({ title, body: '', urls: [], tags: [] });
    assert.equal(payload.title, 'a'.repeat(LIMITS.TITLE_MAX - 1));
    assert.ok(payload.title.length <= LIMITS.TITLE_MAX);
  });
});
