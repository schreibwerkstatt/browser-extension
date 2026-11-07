/**
 * Service Worker (MV3, ESM).
 *
 * Hier — und nur hier — laufen Netzwerkanfragen. Mit `host_permissions`
 * auf den App-Host ist der Worker CORS-befreit; aus einem Content-Script
 * wuerde derselbe Request scheitern.
 *
 * Der Worker faengt keine Navigation ab, beobachtet keinen Verlauf und
 * wird nie von selbst aktiv. Alles beginnt mit einer Nutzeraktion:
 * Popup, Tastenkuerzel oder Kontextmenue.
 */

import { createApiClient, describeDevice } from './api-client.js';
import { probeCapabilities } from './capabilities.js';
import { runCaptureJob } from './capture-runner.js';
import { createAttachmentStore } from './attachment-store.js';
import { createIdbBackend } from './idb.js';
import { createHandlers, lookupHandler } from './handlers.js';
import { createQueue } from './queue.js';
import { createStore } from './state.js';

const store = createStore();

import {
  BOOKS_TTL_MS,
  CAPABILITY_TTL_MS,
  STORAGE_KEYS,
  TOKEN_STATE,
  canWriteToBook,
  capabilityEnabled,
} from '../shared/config.js';
import { ApiError, describeError, isRouteMissing } from '../shared/errors.js';
import { summarizeDuplicates } from '../shared/duplicates.js';
import { intentFromHarvest } from '../shared/intent.js';
import { LIMITS, RESEARCH_LIST } from '../shared/limits.js';
import { attachmentsAreLost, incompleteText } from '../shared/outcome.js';
import { t } from '../ui/chrome-i18n.js';
import { toOriginPattern } from '../shared/url.js';

const QUEUE_ALARM = 'schreibwerkstatt-queue';
const CONTEXT_MENU_QUOTE = 'schreibwerkstatt-capture-quote';
const UNDO_NOTIFICATION_PREFIX = 'undo:';

/** Chrome deckelt Alarme in gepackten Erweiterungen auf 30 s. */
const MIN_ALARM_DELAY_MS = 30 * 1000;

/** Einmalig beim Start des Workers abgefragt; konstant ueber seine Lebensdauer. */
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// ---------------------------------------------------------------------------
// Grundbausteine
// ---------------------------------------------------------------------------

const api = createApiClient({
  getConfig: store.getConfig,
  getClientInfo: async () => ({
    platform: 'chrome',
    device: describeDevice(navigator),
    // Nackt — `X-Client-Version` baut der API-Client daraus `chrome/…`.
    version: EXTENSION_VERSION,
  }),
  onAuthError: () => {
    // Nie stillschweigend erneut versuchen: Token markieren, Badge rot.
    void store.setTokenState(TOKEN_STATE.INVALID).then(refreshBadge);
  },
  onScopeError: () => {
    void store.setTokenState(TOKEN_STATE.SCOPE_MISSING).then(refreshBadge);
  },
});

const queue = createQueue({
  load: store.loadQueue,
  save: store.saveQueue,
  translate: t,
});

/**
 * Laufender Durchlauf von `processQueue` — verhindert, dass zwei Wecker
 * gleichzeitig dieselbe Queue abarbeiten.
 * @type {Promise<void>|null}
 */
let current = null;
/** Waehrend des Durchlaufs angefordert: danach noch einmal nachsehen. */
let again = false;

/**
 * Was beim letzten Durchlauf mit einem Auftrag passiert ist.
 *
 * Ein erfolgreicher Auftrag verlaesst die Queue — sein `progress` waere danach
 * nicht mehr abfragbar. Genau der traegt aber die Antwortflags des Servers
 * (`source_created`, `research_created`), und ohne die kann das Popup nicht
 * sagen „war schon in der Bibliothek". Also hier kurz zwischenlagern, bis die
 * Antwort auf `SUBMIT_CAPTURE` sie abgeholt hat.
 *
 * @type {Map<string, import('../shared/config.js').CaptureProgress>}
 */
const lastOutcome = new Map();

/**
 * Auftraege aus dem Kontextmenue holt niemand ab — dort gibt es kein Popup, das
 * auf eine Antwort wartet. Ohne Deckel wuechse die Ablage bis zum Ende der
 * Worker-Lebensdauer.
 */
const LAST_OUTCOME_MAX = 20;

/**
 * @param {string} jobId
 * @param {import('../shared/config.js').CaptureProgress} progress
 */
function rememberOutcome(jobId, progress) {
  lastOutcome.set(jobId, { ...progress });
  // Map haelt die Einfuegereihenfolge — der aelteste Eintrag geht zuerst.
  while (lastOutcome.size > LAST_OUTCOME_MAX) {
    const oldest = lastOutcome.keys().next().value;
    if (oldest === undefined) break;
    lastOutcome.delete(oldest);
  }
}

/**
 * Anhaenge (Screenshot, PDF) liegen getrennt von der Warteschlange: im
 * Arbeitsspeicher und darunter in IndexedDB, damit sie Wiederholungen nach
 * einem Worker-Neustart ueberstehen. Warum nicht in `chrome.storage.local`,
 * steht in `attachment-store.js`.
 *
 * Fehlt ein Anhang trotzdem (IndexedDB nicht verfuegbar), wird der Verlust am
 * Auftrag vermerkt und in den Optionen angezeigt — nicht stillschweigend.
 */
const attachmentCache = createAttachmentStore({
  backend: typeof indexedDB !== 'undefined' ? createIdbBackend() : null,
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function refreshBadge() {
  const [tokenState, counts] = await Promise.all([store.getTokenState(), queue.counts()]);

  if (tokenState === TOKEN_STATE.INVALID || tokenState === TOKEN_STATE.SCOPE_MISSING) {
    await setBadge('!', '#c0392b', t('badge_token_problem'));
    return;
  }

  if (counts.failed > 0) {
    await setBadge(String(counts.total), '#c0392b', t('badge_failed', [String(counts.failed)]));
    return;
  }

  if (counts.total > 0) {
    await setBadge(String(counts.total), '#2f6f4f', t('badge_pending', [String(counts.total)]));
    return;
  }

  await setBadge('', '#2f6f4f', t('ext_name'));
}

/**
 * @param {string} text
 * @param {string} color
 * @param {string} title
 */
async function setBadge(text, color, title) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch {
    // Beim Herunterfahren des Workers kann das fehlschlagen — unkritisch.
  }
}

// ---------------------------------------------------------------------------
// Faehigkeiten
// ---------------------------------------------------------------------------

/**
 * Aufgeloeste Faehigkeiten. Wenn der Auto-Modus noch keinen Befund hat oder
 * der Befund abgelaufen ist, wird einmal geprobt — nur im Rahmen einer vom
 * Nutzer ausgeloesten Aktion.
 *
 * @param {boolean} [allowProbe]
 * @returns {Promise<{capture: boolean, byUrl: boolean, researchList: boolean, researchScopeMissing: boolean}>}
 */
async function resolveCapabilities(allowProbe = true) {
  let capabilities = await store.getCapabilities();

  const needsProbe =
    (capabilities.capture.mode === 'auto' && capabilities.capture.detected === null) ||
    (capabilities.byUrl.mode === 'auto' && capabilities.byUrl.detected === null) ||
    (capabilities.researchList.mode === 'auto' && capabilities.researchList.detected === null) ||
    Date.now() - (capabilities.probedAt || 0) > CAPABILITY_TTL_MS;

  if (allowProbe && needsProbe) {
    const config = await store.getConfig();
    const tokenState = await store.getTokenState();
    if (config.serverUrl && config.token && tokenState !== TOKEN_STATE.INVALID) {
      try {
        const detected = await probeCapabilities(api);
        capabilities = await store.saveDetectedCapabilities(detected);
      } catch {
        // Probe ist Kuer. Fehlschlag heisst: Fallback-Pfad benutzen.
      }
    }
  }

  return {
    capture: capabilityEnabled(capabilities.capture),
    byUrl: capabilityEnabled(capabilities.byUrl),
    researchList: capabilityEnabled(capabilities.researchList),
    researchScopeMissing: !!capabilities.researchList.scopeMissing,
  };
}

/** @param {'capture'|'byUrl'|'researchList'} name */
function markCapabilityMissing(name) {
  // Nur den einen Befund nennen: `pick` behaelt die uebrigen, und das Lesen
  // geschieht innerhalb der serialisierten Schreibkette des Stores.
  store.saveDetectedCapabilities({ [name]: false }).catch((error) => {
    console.error('markCapabilityMissing', error);
  });
}

/**
 * Hat der Nutzer den Zugriff auf den Server erlaubt? Ohne die
 * Host-Berechtigung scheitert jeder Aufruf an CORS — und sieht dann aus wie
 * „keine Verbindung", endlos wiederholt.
 *
 * @param {string} serverUrl
 * @returns {Promise<boolean|null>} `null`, wenn sich das nicht feststellen laesst
 */
async function hasHostPermission(serverUrl) {
  const pattern = toOriginPattern(serverUrl);
  if (!pattern || !chrome.permissions) return null;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dublettenpruefung
// ---------------------------------------------------------------------------

/**
 * „Habe ich diese Quelle schon?" — ueber `GET /sources/by-url`.
 *
 * @param {{byUrl: boolean}} capabilities
 * @param {{url: string, bookId?: number|string|null}} message
 */
async function checkSourceDuplicate(capabilities, message) {
  if (!capabilities.byUrl) return { supported: false };
  try {
    const found = await api.findSourceByUrl(message.url, message.bookId ?? '');
    return { supported: true, found: true, source: found.source, linkedToBook: !!found.linked_to_book };
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err.status === 404 && err.jsonBody === true) return { supported: true, found: false };
    if (isRouteMissing(err)) {
      markCapabilityMissing('byUrl');
      return { supported: false };
    }
    throw error;
  }
}

/**
 * „Habe ich diese SEITE in diesem Buch schon erfasst?" — ueber `GET /research`.
 *
 * Gefragt wird nach dem Buch, nicht nach einem Textbegriff: `q` wuerde den
 * FTS5-Vorfilter des Servers anwerfen, dessen 500er-Deckel VOR Filter und
 * Sortierung greift. Verglichen wird die URL, siehe `shared/duplicates.js`.
 *
 * Der Aufruf ist Komfort und darf das Erfassen nie blockieren — deshalb wird
 * jeder Fehler zu einem Befund, nicht zu einer Ausnahme.
 *
 * @param {{researchList: boolean, researchScopeMissing: boolean}} capabilities
 * @param {{url: string, bookId?: number|string|null}} message
 */
async function checkResearchDuplicate(capabilities, message) {
  if (!message.bookId) return { supported: false };
  if (!capabilities.researchList) {
    return { supported: false, scopeMissing: capabilities.researchScopeMissing };
  }

  try {
    const items = await api.listResearch({
      bookId: message.bookId,
      sort: 'updated',
      limit: RESEARCH_LIST.LIMIT_MAX,
    });
    return {
      supported: true,
      ...summarizeDuplicates({
        items: /** @type {import('../shared/duplicates.js').ResearchListItem[]} */ (items),
        url: message.url,
        limit: RESEARCH_LIST.LIMIT_MAX,
      }),
    };
  } catch (error) {
    const err = /** @type {any} */ (error);

    if (isRouteMissing(err)) {
      markCapabilityMissing('researchList');
      return { supported: false };
    }

    // Fehlender Scope ist ein Befund ueber das Token: melden, nicht wiederholen.
    if (err.status === 403 && err.code === 'DEVICE_SCOPE_FORBIDDEN') {
      void store.saveDetectedCapabilities({ researchList: true, researchScopeMissing: true });
      return { supported: false, scopeMissing: true, error: describeError(err, t) };
    }

    return { supported: false, error: describeError(err, t) };
  }
}

// ---------------------------------------------------------------------------
// Seitenzugriff (nur im Moment der Nutzeraktion)
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Injiziert das Ernte-Script und ruft es auf.
 *
 * Zwei Aufrufe, damit der Rueckgabewert zuverlaessig ankommt: der erste
 * laedt das Buendel, der zweite ruft die registrierte Funktion.
 *
 * @param {number} tabId
 * @param {{includeArticleText?: boolean}} [options]
 */
async function harvestTab(tabId, options = {}) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/harvest.js'],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [{ includeArticleText: options.includeArticleText !== false }],
    func: (opts) => {
      const bridge = /** @type {any} */ (globalThis).__schreibwerkstatt;
      return bridge ? bridge.harvest(opts) : null;
    },
  });

  const result = results && results[0] ? results[0].result : null;
  if (!result) {
    throw new ApiError({ code: 'HARVEST_FAILED', status: 0, message: 'content script returned nothing' });
  }
  return result;
}

/**
 * Holt ein PDF im Seitenkontext.
 *
 * Der Worker selbst darf fremde Hosts nicht anfragen (keine Host-Permission
 * ausser dem App-Host). Im Seitenkontext ist ein Same-Origin-Abruf dagegen
 * erlaubt — deshalb bieten wir „PDF mitschicken" nur bei gleicher Herkunft an.
 *
 * @param {number} tabId
 * @param {string} pdfUrl
 * @returns {Promise<{base64?: string, size?: number, error?: string}>}
 */
async function fetchPdfInPage(tabId, pdfUrl) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [pdfUrl, LIMITS.DOC_MAX_BYTES],
    func: async (/** @type {string} */ url, /** @type {number} */ maxBytes) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return { error: `HTTP_${response.status}` };
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) return { error: 'TOO_LARGE', size: buffer.byteLength };
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { base64: btoa(binary), size: buffer.byteLength };
      } catch (error) {
        return { error: 'FETCH_FAILED' };
      }
    },
  });

  return (results && results[0] && results[0].result) || { error: 'FETCH_FAILED' };
}

/**
 * @param {number} windowId
 * @returns {Promise<{base64: string, contentType: string, size: number}>}
 */
async function captureScreenshot(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 });
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const size = Math.floor((base64.length * 3) / 4);
  if (size > LIMITS.IMAGE_MAX_BYTES) {
    throw new ApiError({ status: 400, code: 'CLIENT_IMAGE_TOO_LARGE', params: { size } });
  }
  return { base64, contentType: 'image/jpeg', size };
}

// ---------------------------------------------------------------------------
// Buecher
// ---------------------------------------------------------------------------

/**
 * @param {boolean} [force]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function fetchBooks(force = false) {
  const state = await store.readState();
  const age = Date.now() - (state[STORAGE_KEYS.BOOKS_FETCHED_AT] || 0);
  if (!force && state[STORAGE_KEYS.BOOKS].length && age < BOOKS_TTL_MS) {
    return state[STORAGE_KEYS.BOOKS];
  }

  const books = await api.getBooks();
  await store.saveBooks(books);
  await store.setTokenState(TOKEN_STATE.VALID);
  await refreshBadge();

  // Ein Standardbuch, das es nicht mehr gibt oder in dem wir nur lesen
  // duerfen, wird zurueckgesetzt statt beim Senden zu scheitern.
  const current = state[STORAGE_KEYS.DEFAULT_BOOK_ID];
  if (current !== null && current !== undefined) {
    const book = books.find((entry) => String(entry.id) === String(current));
    if (!book || !canWriteToBook(book)) {
      await store.writeState({ [STORAGE_KEYS.DEFAULT_BOOK_ID]: null });
    }
  }

  return books;
}

// ---------------------------------------------------------------------------
// Warteschlange abarbeiten
// ---------------------------------------------------------------------------

/**
 * Arbeitet die Warteschlange ab. Laeuft schon ein Durchlauf, wird kein
 * zweiter gestartet, sondern ein weiterer angehaengt und das Ganze abgewartet.
 *
 * Frueher kehrte ein zweiter Aufruf sofort zurueck. `SUBMIT_CAPTURE` fand den
 * eben angelegten Auftrag dann unbearbeitet vor und das Popup meldete „in
 * Warteschlange: unbekannter Fehler" — ohne dass etwas schiefgegangen war.
 *
 * @returns {Promise<void>}
 */
function processQueue() {
  if (current) {
    again = true;
    return current;
  }
  current = (async () => {
    try {
      do {
        again = false;
        await processQueueOnce();
      } while (again);
    } finally {
      current = null;
    }
  })();
  return current;
}

async function processQueueOnce() {
  try {
    const jobs = await queue.due();
    // Nur proben, wenn ohnehin gesendet wird. Ein Wecker, der nichts
    // vorfindet, loest keinen einzigen Netzwerkaufruf aus.
    const capabilities = await resolveCapabilities(jobs.length > 0);

    const { serverUrl } = jobs.length ? await store.getConfig() : { serverUrl: '' };

    for (const due of jobs) {
      // Ein Auftrag im Undo-Fenster wird beim Faelligwerden regulaer gesendet.
      // `claim` statt der Momentaufnahme: was der Nutzer inzwischen
      // zurueckgenommen oder verworfen hat, geht nicht mehr hinaus.
      const job = await queue.claim(due.id);
      if (!job) continue;
      try {
        // Erfasst fuer einen anderen Server: seine `book_id` gilt hier nicht.
        // Angehalten und gemeldet, nie umgeleitet — und nie still verworfen.
        if (job.serverUrl && serverUrl && job.serverUrl !== serverUrl) {
          throw new ApiError({
            status: 0,
            code: 'CLIENT_SERVER_CHANGED',
            params: { server: job.serverUrl },
            message: `job for ${job.serverUrl}`,
          });
        }
        await restoreAttachments(job);
        await runCaptureJob(job, {
          api,
          capabilities,
          onCapabilityMissing: markCapabilityMissing,
          onProgress: async (progress) => {
            await queue.update(job.id, { progress: { ...progress } });
          },
        });
        rememberOutcome(job.id, job.progress);
        await queue.complete(job.id);
        await attachmentCache.delete(job.id);
        await notifySuccess(job);
      } catch (error) {
        job.intent.attachments = {};
        const { willRetry } = await queue.fail(job.id, error, job.progress);
        // Auch nach dem endgueltigen Scheitern bleibt der Anhang liegen: der
        // Nutzer kann den Auftrag in den Optionen erneut anstossen, und dann
        // soll er vollstaendig rausgehen. Weg ist er erst mit dem Verwerfen.
        if (!willRetry) await notifyFailure(job, error);
      }
    }
  } catch (error) {
    // Ein Fehler ausserhalb eines Auftrags (Speicher, Konfiguration) darf
    // nicht als unbehandelte Rejection verschwinden.
    console.error('processQueue', error);
  } finally {
    try {
      await scheduleNextWake();
      await refreshBadge();
    } catch (error) {
      console.error('processQueue/finally', error);
    }
  }
}

/**
 * Haengt die im Speicher gehaltenen Anhaenge wieder an den Auftrag.
 * Fehlen sie (Worker-Neustart), wird der Verlust am Auftrag vermerkt.
 *
 * @param {import('../shared/config.js').CaptureJob} job
 */
async function restoreAttachments(job) {
  const cached = await attachmentCache.get(job.id);
  job.intent.attachments = cached || {};

  if (attachmentsAreLost(job.intent.attachmentsDeclared || {}, job.progress, !!cached)) {
    job.progress.attachmentsLost = true;
  }
  if (job.intent.quoteApproximate) job.progress.quoteApproximate = true;
}

async function scheduleNextWake() {
  const at = await queue.nextWakeAt();
  if (at === null) {
    await chrome.alarms.clear(QUEUE_ALARM);
    return;
  }
  const delay = Math.max(at - Date.now(), 0);
  // Kurze Wartezeiten (Undo-Fenster) faengt ein Timer ab; der Alarm ist nur
  // das Netz darunter, falls der Worker vorher eingeschlaefert wird.
  if (delay < MIN_ALARM_DELAY_MS) {
    setTimeout(() => {
      void processQueue();
    }, delay + 50);
  }
  await chrome.alarms.create(QUEUE_ALARM, { when: Date.now() + Math.max(delay, MIN_ALARM_DELAY_MS) });
}

// ---------------------------------------------------------------------------
// Benachrichtigungen
// ---------------------------------------------------------------------------

/**
 * @param {string} id
 * @param {chrome.notifications.NotificationOptions} options
 */
async function notify(id, options) {
  const settings = await store.getSettings();
  if (!settings.notifications) return;
  if (!chrome.notifications) return;
  try {
    await chrome.notifications.create(
      id,
      /** @type {chrome.notifications.NotificationCreateOptions} */ ({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        silent: true,
        ...options,
      }),
    );
  } catch {
    // Benachrichtigungen sind Komfort, kein Vertrag.
  }
}

/**
 * @param {import('../shared/config.js').CaptureJob} job
 * @param {number} delayMs
 */
async function showUndoNotification(job, delayMs) {
  const seconds = Math.round(delayMs / 1000);
  await notify(`${UNDO_NOTIFICATION_PREFIX}${job.id}`, {
    title: t('notify_quote_captured_title'),
    message: t('notify_quote_captured_message', [
      job.intent.bookName || String(job.intent.bookId ?? ''),
      String(seconds),
    ]),
    contextMessage: (job.intent.body || '').slice(0, 120),
    buttons: [{ title: t('notify_undo_button') }],
    requireInteraction: false,
  });
}

/**
 * Erfolgsmeldung — und zwar die ganze.
 *
 * Ein Auftrag, der seinen Anhang beim Neustart des Workers verloren hat oder
 * dessen Zitierschluessel schon vergeben war, gilt als erfolgreich und
 * verlaesst die Queue. Mit ihm verschwaende die Notiz, dass etwas fehlt —
 * hier ist die einzige Stelle, an der der Nutzer sie noch erfaehrt. Deshalb
 * haengt sie an der Meldung und nicht an der Warteschlange.
 *
 * @param {import('../shared/config.js').CaptureJob} job
 */
async function notifySuccess(job) {
  const key =
    job.intent.mode === 'source'
      ? 'notify_saved_source'
      : job.intent.mode === 'both'
        ? 'notify_saved_both'
        : 'notify_saved_research';
  const incomplete = incompleteText(job.progress, t);
  await notify(`done:${job.id}`, {
    title: incomplete ? t('notify_saved_incomplete_title') : t('notify_saved_title'),
    message: [t(key, [job.intent.bookName || '']), incomplete].filter(Boolean).join(' '),
    contextMessage: job.intent.title.slice(0, 120),
  });
}

/**
 * @param {import('../shared/config.js').CaptureJob} job
 * @param {any} error
 */
async function notifyFailure(job, error) {
  const described = describeError(error, t);
  await notify(`fail:${job.id}`, {
    title: t('notify_failed_title'),
    message: described.text,
    contextMessage: job.intent.title.slice(0, 120),
  });
}

// ---------------------------------------------------------------------------
// Kontextmenue: Zitat erfassen
// ---------------------------------------------------------------------------

async function installContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_QUOTE,
    title: t('context_menu_capture_quote'),
    contexts: ['selection'],
  });
}

/**
 * Zitat direkt erfassen — ohne Popup, mit Undo-Fenster.
 * @param {chrome.tabs.Tab|undefined} tab
 * @param {string} [fallbackSelection] `info.selectionText`, nur als Notnagel
 */
async function captureQuoteFromTab(tab, fallbackSelection = '') {
  if (!tab || tab.id === undefined) return;

  const state = await store.readState();
  const settings = state[STORAGE_KEYS.SETTINGS];
  const bookId = state[STORAGE_KEYS.DEFAULT_BOOK_ID];

  if (!state[STORAGE_KEYS.SERVER_URL] || !state[STORAGE_KEYS.TOKEN]) {
    await notify('setup', {
      title: t('notify_setup_needed_title'),
      message: t('notify_setup_needed_message'),
    });
    await chrome.runtime.openOptionsPage();
    return;
  }

  if (bookId === null || bookId === undefined) {
    await notify('nobook', {
      title: t('notify_no_book_title'),
      message: t('notify_no_book_message'),
    });
    await chrome.runtime.openOptionsPage();
    return;
  }

  let harvested;
  try {
    // Kein Fliesstext noetig — das Zitat ist die Markierung.
    harvested = await harvestTab(tab.id, { includeArticleText: false });
  } catch (error) {
    // Auf Seiten, die keine Injektion erlauben (chrome://, Web Store),
    // bleibt nur der von Chrome gelieferte, gekuerzte Text.
    harvested = null;
  }

  const harvestedSelection = (harvested && harvested.selectionText) || '';
  const selection = harvestedSelection || fallbackSelection || '';
  // `info.selectionText` ist nicht der Wortlaut: Chrome fasst Leerraum zusammen
  // und wirft Zeilenumbrueche weg. Er greift, wenn die Ernte scheiterte oder
  // die Markierung in einem iframe liegt (das Content-Script sieht nur den
  // obersten Frame). Gespeichert wird trotzdem — aber mit Vermerk.
  const approximate = !harvestedSelection && !!fallbackSelection;
  if (!selection.trim()) {
    await notify('noselection', {
      title: t('notify_no_selection_title'),
      message: t('notify_no_selection_message'),
    });
    return;
  }

  if (selection.length > LIMITS.BODY_MAX) {
    await notify('toolong', {
      title: t('notify_quote_too_long_title'),
      message: t('notify_quote_too_long_message', [String(LIMITS.BODY_MAX), String(selection.length)]),
    });
    return;
  }

  const book = (state[STORAGE_KEYS.BOOKS] || []).find((entry) => String(entry.id) === String(bookId));

  const intent = intentFromHarvest(harvested || { meta: { url: tab.url || '' }, hasSelection: true, selectionText: selection }, {
    mode: 'research',
    bookId,
    bookName: book ? book.name : '',
  });
  // Der Wortlaut bleibt exakt, auch wenn die Ernte scheiterte.
  intent.body = selection;
  intent.kind = 'quote';
  if (!intent.title) intent.title = (tab.title || '').slice(0, LIMITS.TITLE_MAX);

  // Ohne Hinweise gibt es keinen Rueckgaengig-Knopf — dann waere das
  // Warten nur eine Verzoegerung ohne Gegenwert.
  const holdMs = settings.notifications ? settings.undoDelayMs : 0;

  if (approximate) intent.quoteApproximate = true;

  const job = await queue.add(intent, { holdMs, serverUrl: state[STORAGE_KEYS.SERVER_URL] });
  if (holdMs > 0) await showUndoNotification(job, holdMs);
  await refreshBadge();
  await scheduleNextWake();
  if (holdMs === 0) await processQueue();
}

// ---------------------------------------------------------------------------
// Nachrichten aus Popup und Options-Seite
// ---------------------------------------------------------------------------

/**
 * Kontext fuer alle Handler: alles, was ausserhalb einer einzelnen
 * `case`-Marke liegen muss — Queue, Anhang-Cache, Chrome-Helfer. So
 * bleibt der Service Worker die einzige Datei, die Chrome-Ereignisse
 * verdrahtet; `handlers.js` routet nur noch.
 */
const handlerCtx = {
  api,
  queue,
  store,
  refreshBadge,
  processQueue,
  scheduleNextWake,
  resolveCapabilities,
  markCapabilityMissing,
  checkSourceDuplicate,
  checkResearchDuplicate,
  fetchBooks,
  probeCapabilities,
  harvestTab,
  captureScreenshot,
  fetchPdfInPage,
  activeTab,
  notify,
  attachmentCache,
  lastOutcome,
  showUndoNotification,
  hasHostPermission,
  extensionVersion: () => EXTENSION_VERSION,
};

const handlers = createHandlers(handlerCtx);

/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleMessage(message, sender) {
  return lookupHandler(handlers, message.type)(message, sender);
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await installContextMenus();
    await refreshBadge();
    await scheduleNextWake();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await installContextMenus();
    await refreshBadge();
    await processQueue();
  })();
});

/**
 * Erfassen ohne Popup — niemand wartet auf eine Antwort. Scheitert es
 * (Speicher voll, Zustand unlesbar), waere das Zitat ohne diese Huelle
 * spurlos weg.
 *
 * @param {chrome.tabs.Tab|undefined} tab
 * @param {string} [fallbackSelection]
 */
function captureQuoteSafely(tab, fallbackSelection) {
  captureQuoteFromTab(tab, fallbackSelection).catch(async (error) => {
    console.error('captureQuoteFromTab', error);
    await notify(`fail:quote:${Date.now()}`, {
      title: t('notify_failed_title'),
      message: describeError(error, t).text,
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_QUOTE) return;
  captureQuoteSafely(tab, info.selectionText || '');
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-quote') captureQuoteSafely(tab);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) void processQueue();
});

if (chrome.notifications) {
  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (!notificationId.startsWith(UNDO_NOTIFICATION_PREFIX) || buttonIndex !== 0) return;
    void (async () => {
      const jobId = notificationId.slice(UNDO_NOTIFICATION_PREFIX.length);
      const undone = await queue.undo(jobId);
      if (undone) await attachmentCache.delete(jobId);
      await chrome.notifications.clear(notificationId);
      await refreshBadge();
      await notify(`undone:${jobId}`, {
        title: undone ? t('notify_undone_title') : t('notify_undo_too_late_title'),
        message: undone ? t('notify_undone_message') : t('notify_undo_too_late_message'),
      });
    })();
  });

  chrome.notifications.onClicked.addListener((notificationId) => {
    void chrome.notifications.clear(notificationId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      const described = describeError(error, t);
      sendResponse({
        ok: false,
        error: {
          code: described.code,
          message: described.text,
          status: /** @type {any} */ (error)?.status ?? 0,
          key: described.key,
          auth: described.auth,
          scope: described.scope,
        },
      });
    });
  return true; // asynchrone Antwort
});

// Beim Kaltstart des Workers den Zustand wiederherstellen.
void (async () => {
  await attachmentCache.prune(async () => (await queue.list()).map((job) => job.id));
  await refreshBadge();
  await scheduleNextWake();
})();
