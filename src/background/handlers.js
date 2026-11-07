/**
 * Nachrichten-Handler fuer Popup, Options-Seite und Kontextmenue.
 *
 * `service-worker.js` hat lang einen 170-Zeilen-Switch gefuehrt, der 16
 * Nachrichtentypen inline behandelte — mit PDF-Holen, Anhang-Zusammenbau,
 * Queue-Zugriff und Antwortkonstruktion in einem Fall. Die Handler liegen
 * jetzt hier; der Service Worker uebernimmt nur noch die Verdrahtung mit
 * Chrome und die Verteilung.
 *
 * Die Handler sind absichtlich keine reine Funktionen: sie greifen ueber
 * `ctx` auf den geteilten Zustand (Queue, Anhang-Cache, letzten Outcome)
 * und die Chrome-seitigen Helfer (Ernte, Screenshot, Benachrichtigungen)
 * zu. So bleiben Nebeneffekte sichtbar, statt sie hinter einem `dispatcher`
 * zu verstecken.
 */

import {
  STORAGE_KEYS,
  TOKEN_PREFIX,
  TOKEN_STATE,
} from '../shared/config.js';
import { ApiError } from '../shared/errors.js';
import { MSG } from '../shared/messages.js';
import { fileNameFromUrl, normalizeServerUrl, toOriginPattern } from '../shared/url.js';

/**
 * @typedef {object} HandlerCtx
 * @property {ReturnType<typeof import('./api-client.js').createApiClient>} api
 * @property {ReturnType<typeof import('./queue.js').createQueue>} queue
 * @property {ReturnType<typeof import('./state.js').createStore>} store
 * @property {() => Promise<void>} refreshBadge
 * @property {() => Promise<void>} processQueue
 * @property {() => Promise<void>} scheduleNextWake
 * @property {(allowProbe?: boolean) => Promise<object>} resolveCapabilities
 * @property {(name: 'capture'|'byUrl'|'researchList') => void} markCapabilityMissing
 * @property {(capabilities: object, message: object) => Promise<object>} checkSourceDuplicate
 * @property {(capabilities: object, message: object) => Promise<object>} checkResearchDuplicate
 * @property {(force?: boolean) => Promise<Array<Record<string, any>>>} fetchBooks
 * @property {(tabId: number, options?: object) => Promise<any>} harvestTab
 * @property {(windowId: number) => Promise<{base64: string, contentType: string, size: number}>} captureScreenshot
 * @property {(tabId: number, pdfUrl: string) => Promise<{base64?: string, size?: number, error?: string}>} fetchPdfInPage
 * @property {() => Promise<chrome.tabs.Tab|null>} activeTab
 * @property {(id: string, options: chrome.notifications.NotificationOptions) => Promise<void>} notify
 * @property {ReturnType<typeof import('./attachment-store.js').createAttachmentStore>} attachmentCache
 * @property {Map<string, import('../shared/config.js').CaptureProgress>} lastOutcome
 * @property {(job: object, delayMs: number) => Promise<void>} showUndoNotification
 * @property {(serverUrl: string) => Promise<boolean|null>} [hasHostPermission]
 * @property {() => string} extensionVersion
 * @property {(api: any) => Promise<object>} probeCapabilities
 */

/**
 * @param {HandlerCtx} ctx
 */
export function createHandlers(ctx) {
  const handlers = {
    async [MSG.GET_STATE]() {
      const state = await ctx.store.readState();
      const counts = await ctx.queue.counts();
      const serverUrl = state[STORAGE_KEYS.SERVER_URL];
      return {
        serverUrl,
        hasToken: !!state[STORAGE_KEYS.TOKEN],
        // `false` nur, wenn sicher fehlt; `null` = unbekannt, nicht melden.
        hostPermission: serverUrl && ctx.hasHostPermission ? await ctx.hasHostPermission(serverUrl) : null,
        tokenState: state[STORAGE_KEYS.TOKEN_STATE],
        defaultBookId: state[STORAGE_KEYS.DEFAULT_BOOK_ID],
        books: state[STORAGE_KEYS.BOOKS],
        booksFetchedAt: state[STORAGE_KEYS.BOOKS_FETCHED_AT],
        capabilities: state[STORAGE_KEYS.CAPABILITIES],
        settings: state[STORAGE_KEYS.SETTINGS],
        queue: state[STORAGE_KEYS.QUEUE],
        counts,
        version: ctx.extensionVersion(),
      };
    },

    async [MSG.HARVEST_ACTIVE_TAB](message) {
      const tab = await ctx.activeTab();
      if (!tab || tab.id === undefined) throw new ApiError({ code: 'NO_ACTIVE_TAB' });
      const settings = await ctx.store.getSettings();
      const harvested = await ctx.harvestTab(tab.id, {
        includeArticleText: message.includeArticleText ?? settings.harvestArticleText,
      });
      return { harvested, tab: { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId } };
    },

    async [MSG.REFRESH_BOOKS]() {
      return { books: await ctx.fetchBooks(true) };
    },

    async [MSG.TEST_CONNECTION]() {
      const books = await ctx.fetchBooks(true);
      const detected = await ctx.probeCapabilities(ctx.api);
      const capabilities = await ctx.store.saveDetectedCapabilities(detected);
      return { books, capabilities, tokenState: await ctx.store.getTokenState() };
    },

    async [MSG.CHECK_DUPLICATE](message) {
      const capabilities = await ctx.resolveCapabilities(true);
      const [source, research] = await Promise.all([
        ctx.checkSourceDuplicate(capabilities, message),
        ctx.checkResearchDuplicate(capabilities, message),
      ]);
      return { source, research };
    },

    async [MSG.LOOKUP_METADATA](message) {
      return ctx.api.lookup({ doi: message.doi, isbn: message.isbn });
    },

    async [MSG.CAPTURE_SCREENSHOT]() {
      const tab = await ctx.activeTab();
      if (!tab || tab.windowId === undefined) throw new ApiError({ code: 'NO_ACTIVE_TAB' });
      return ctx.captureScreenshot(tab.windowId);
    },

    async [MSG.SUBMIT_CAPTURE](message) {
      /** @type {import('../shared/config.js').CaptureIntent} */
      const intent = message.intent;

      /** @type {Record<string, any>} */
      const attachments = {};

      // PDF erst jetzt holen — im Seitenkontext, solange der Tab noch da ist.
      if (message.attachPdf && message.pdfUrl && message.tabId !== undefined) {
        const result = await ctx.fetchPdfInPage(message.tabId, message.pdfUrl);
        if (result.base64) {
          attachments.pdf = {
            bytes: result.base64,
            size: result.size,
            // Der Vertrag nimmt den Dateinamen als `?name=`; ohne ihn heisst der
            // Anhang in der App nur „Dokument".
            name: fileNameFromUrl(message.pdfUrl),
          };
        } else {
          return { queued: false, pdfError: result.error || 'FETCH_FAILED' };
        }
      }

      if (message.screenshot && message.screenshot.base64) {
        attachments.screenshot = {
          bytes: message.screenshot.base64,
          contentType: message.screenshot.contentType,
        };
      }

      // Die Nutzdaten gehen in die Anhang-Ablage, in der Warteschlange steht
      // nur, dass es sie gibt.
      intent.attachments = {};
      intent.attachmentsDeclared = {
        screenshot: !!attachments.screenshot,
        pdf: !!attachments.pdf,
      };

      const { serverUrl } = await ctx.store.getConfig();
      const job = await ctx.queue.add(intent, {
        holdMs: 0,
        serverUrl,
        // Erst die Anhaenge ablegen, dann den Auftrag sichtbar machen — sonst
        // kann ein Wecker ihn dazwischen ohne Anhang abschicken.
        beforeSave: async (created) => {
          if (attachments.screenshot || attachments.pdf) await ctx.attachmentCache.set(created.id, attachments);
        },
      });
      await ctx.refreshBadge();
      // Sofort versuchen; bei Erfolg ist der Auftrag beim Antworten schon weg.
      await ctx.processQueue();
      const remaining = await ctx.queue.list();
      const stillThere = remaining.find((entry) => entry.id === job.id);
      const outcome = ctx.lastOutcome.get(job.id) || null;
      ctx.lastOutcome.delete(job.id);
      return {
        queued: true,
        jobId: job.id,
        done: !stillThere,
        job: stillThere || null,
        // Was der Server gemeldet hat — damit das Popup „angelegt" von
        // „war schon drin" unterscheiden kann.
        outcome,
      };
    },

    async [MSG.FLUSH_QUEUE]() {
      await ctx.processQueue();
      return { counts: await ctx.queue.counts() };
    },

    async [MSG.RETRY_JOB](message) {
      await ctx.queue.retryNow(message.jobId);
      await ctx.processQueue();
      return { counts: await ctx.queue.counts() };
    },

    async [MSG.UNDO_JOB](message) {
      const undone = await ctx.queue.undo(message.jobId);
      if (undone) await ctx.attachmentCache.delete(message.jobId);
      await ctx.refreshBadge();
      return { undone };
    },

    async [MSG.DISCARD_JOB](message) {
      await ctx.queue.discard(message.jobId);
      await ctx.attachmentCache.delete(message.jobId);
      await ctx.refreshBadge();
      return { counts: await ctx.queue.counts() };
    },

    async [MSG.SET_CAPABILITY_MODE](message) {
      return { capabilities: await ctx.store.setCapabilityMode(message.name, message.mode) };
    },

    async [MSG.SAVE_CREDENTIALS](message) {
      const serverUrl = normalizeServerUrl(message.serverUrl);
      if (!serverUrl) throw new ApiError({ code: 'INVALID_SERVER_URL', status: 400 });

      const token = String(message.token || '').trim();
      const previous = await ctx.store.getConfig();
      const originChanged = !!previous.serverUrl && originOf(previous.serverUrl) !== originOf(serverUrl);

      // Ein Token gilt fuer EINEN Server. Beim Wechsel das alte weiterzuverwenden
      // hiesse, es beim naechsten Aufruf an einen fremden Host zu schicken.
      if (originChanged && !token) {
        throw new ApiError({ code: 'CLIENT_TOKEN_REQUIRED', status: 400 });
      }

      await ctx.store.writeState({
        [STORAGE_KEYS.SERVER_URL]: serverUrl,
        ...(token ? { [STORAGE_KEYS.TOKEN]: token } : {}),
        [STORAGE_KEYS.TOKEN_STATE]: TOKEN_STATE.UNKNOWN,
        // Ein Serverwechsel macht Buecher und Faehigkeits-Befunde ungueltig.
        [STORAGE_KEYS.BOOKS]: [],
        [STORAGE_KEYS.BOOKS_FETCHED_AT]: 0,
        // Die Buch-ID des alten Servers bezeichnet auf dem neuen ein anderes
        // (oder fremdes) Buch — ein Zitat per Kontextmenue landete dort.
        ...(originChanged ? { [STORAGE_KEYS.DEFAULT_BOOK_ID]: null } : {}),
      });
      // Sauberer Reset statt `saveDetectedCapabilities({ capture: null, ... })`,
      // denn `pick` liest `null` als „keine Aussage" und wuerde die Befunde
      // des vorigen Servers stehen lassen.
      await ctx.store.resetDetectedCapabilities();
      await ctx.refreshBadge();
      return {
        serverUrl,
        originPattern: toOriginPattern(serverUrl),
        tokenLooksValid: token.startsWith(TOKEN_PREFIX),
      };
    },

    async [MSG.SAVE_SETTINGS](message) {
      return { settings: await ctx.store.saveSettings(message.settings || {}) };
    },

    async [MSG.SET_DEFAULT_BOOK](message) {
      await ctx.store.writeState({ [STORAGE_KEYS.DEFAULT_BOOK_ID]: message.bookId ?? null });
      return { defaultBookId: message.bookId ?? null };
    },
  };

  return handlers;
}

/**
 * @param {string} url
 * @returns {string}
 */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Liefert den Handler fuer einen Nachrichtentyp oder wirft
 * `UNKNOWN_MESSAGE` — der Anfangsbestand von `handleMessage`.
 *
 * @param {Record<string, (message: any, sender: any) => Promise<any>>} handlers
 * @param {string} type
 */
export function lookupHandler(handlers, type) {
  const handler = handlers[type];
  if (!handler) throw new ApiError({ code: 'UNKNOWN_MESSAGE', message: String(type) });
  return handler;
}