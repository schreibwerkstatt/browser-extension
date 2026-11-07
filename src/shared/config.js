/**
 * Speicherschema und Voreinstellungen.
 *
 * Alles liegt in `chrome.storage.local`, ausdruecklich NICHT in `sync`:
 * das Geraete-Token ist ein Geheimnis und darf nicht ueber Google-Konten
 * repliziert werden.
 */

export const STORAGE_KEYS = Object.freeze({
  SERVER_URL: 'serverUrl',
  TOKEN: 'token',
  TOKEN_STATE: 'tokenState',
  DEFAULT_BOOK_ID: 'defaultBookId',
  BOOKS: 'books',
  BOOKS_FETCHED_AT: 'booksFetchedAt',
  CAPABILITIES: 'capabilities',
  QUEUE: 'queue',
  SETTINGS: 'settings',
  LAST_ERROR: 'lastError',
});

/** @typedef {'unknown'|'valid'|'invalid'|'scope_missing'} TokenState */

export const TOKEN_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  VALID: 'valid',
  INVALID: 'invalid',
  SCOPE_MISSING: 'scope_missing',
});

/** Erwartetes Praefix der in der Web-App erzeugten Geraete-Token. */
export const TOKEN_PREFIX = 'swd_';

/** Auto/an/aus je Server-Faehigkeit. */
export const CAPABILITY_MODE = Object.freeze({
  AUTO: 'auto',
  ON: 'on',
  OFF: 'off',
});

export const DEFAULT_CAPABILITIES = Object.freeze({
  /** `POST /capture` — transaktionaler Ein-Request-Pfad. */
  capture: { mode: CAPABILITY_MODE.AUTO, detected: null },
  /** `GET /sources/by-url` — Doppelklick-Schutz. */
  byUrl: { mode: CAPABILITY_MODE.AUTO, detected: null },
  /**
   * `GET /research` — Lesepfad fuer die Dublettenpruefung.
   * `scopeMissing` haelt fest, dass der Endpunkt zwar da ist, dem Token aber
   * `content:read` fehlt. Das ist ein Konfigurationsbefund, kein Ausfall.
   */
  researchList: { mode: CAPABILITY_MODE.AUTO, detected: null, scopeMissing: false },
  probedAt: 0,
});

/** Wie lange ein Faehigkeits-Befund gilt, bevor erneut geprueft wird. */
export const CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

/** Wie lange die Buecherliste ohne erneuten Abruf verwendet wird. */
export const BOOKS_TTL_MS = 60 * 60 * 1000;

export const DEFAULT_SETTINGS = Object.freeze({
  /** Wartezeit vor dem Senden eines Zitats aus dem Kontextmenue (Undo-Fenster). */
  undoDelayMs: 6000,
  /** Vorauswahl im Popup. */
  defaultMode: 'research',
  /** Vorauswahl der Recherche-Art ohne Textmarkierung. */
  defaultKind: 'link',
  /** Haupttext der Seite vorbefuellen? */
  harvestArticleText: true,
  /** Erfolgs- und Undo-Toasts anzeigen. */
  notifications: true,
  /** Vor dem Senden auf Dubletten pruefen (nur wenn by-url verfuegbar). */
  duplicateCheck: true,
});

/** Auftragszustaende in der Queue. */
export const JOB_STATE = Object.freeze({
  /** Undo-Fenster laeuft, noch nichts gesendet. */
  HELD: 'held',
  /** Wartet auf Versand oder Wiederholung. */
  PENDING: 'pending',
  /** Wird gerade gesendet. */
  RUNNING: 'running',
  /** Endgueltig gescheitert, bleibt zur Ansicht erhalten. */
  FAILED: 'failed',
});

/**
 * Ein Erfassungsauftrag. `progress` haelt fest, welche Teilschritte schon
 * beim Server angekommen sind — nur so erzeugt ein Retry keine Duplikate.
 *
 * @typedef {object} CaptureJob
 * @property {string} id
 * @property {string} [serverUrl] Server, fuer den erfasst wurde. Fehlt nur an
 *   Auftraegen aus Versionen vor der Bindung; die gelten fuer den aktuellen.
 * @property {number} createdAt
 * @property {number} attempts
 * @property {number} runAfter
 * @property {keyof typeof JOB_STATE extends never ? string : string} state
 * @property {{code: string, text: string, at: number}|null} lastError
 * @property {CaptureIntent} intent
 * @property {CaptureProgress} progress
 */

/**
 * @typedef {object} CaptureIntent
 * @property {'research'|'source'|'both'} mode
 * @property {number|string|null} bookId
 * @property {string} bookName
 * @property {string} url
 * @property {string} normalizedUrl
 * @property {'note'|'link'|'quote'|'fact'} kind
 * @property {string} title
 * @property {string} body
 * @property {string[]} tags
 * @property {Array<{url: string, label: string}>} urls
 * @property {SourceDraft} source
 * @property {CaptureAttachments} attachments Nutzdaten; in der persistierten
 *   Warteschlange immer leer, sie liegen in der Anhang-Ablage
 * @property {{screenshot: boolean, pdf: boolean}} [attachmentsDeclared] welche
 *   Anhaenge der Auftrag haben soll — Grundlage fuer `attachmentsLost`
 * @property {boolean} [quoteApproximate] das Zitat stammt aus Chromes
 *   `selectionText` (Leerraum zusammengefasst, ohne Zeilenumbrueche), nicht
 *   aus der Seite — Grundlage fuer den gleichnamigen Vermerk in `progress`
 */

/**
 * `bytes` ist base64 oder schon binaer; `toBinary` im Capture-Runner nimmt beides.
 *
 * @typedef {object} CaptureAttachments
 * @property {{bytes: string|Uint8Array|ArrayBuffer, contentType: string}} [screenshot]
 * @property {{bytes: string|Uint8Array|ArrayBuffer, contentType?: string, name?: string}} [pdf]
 */

/**
 * @typedef {object} SourceDraft
 * @property {string} csl_type
 * @property {string} title
 * @property {Array<{family?: string, given?: string, literal?: string}>} authors
 * @property {Array<{family?: string, given?: string, literal?: string}>} editors
 * @property {string} container_title
 * @property {string} publisher
 * @property {string} place
 * @property {number|string|null} year
 * @property {string} url
 * @property {string} doi
 * @property {string} isbn
 * @property {string} accessed_at
 * @property {string} note
 * @property {string} [citekey]
 */

/**
 * Fortschritt eines Auftrags.
 *
 * Die drei `…Created`/`…Linked`-Flags spiegeln die Antwortflags des Vertrags
 * (`research_created`, `source_created`, `source_linked`). Sie sind die einzige
 * Grundlage fuer die Auskunft „war schon drin": `false` heisst
 * wiederverwendet, nicht gescheitert. `null` heisst „noch nichts unternommen".
 *
 * @typedef {object} CaptureProgress
 * @property {number|string|null} researchItemId
 * @property {number|string|null} sourceId
 * @property {Array<number|string>} linkedBookIds
 * @property {boolean} imageUploaded
 * @property {boolean} pdfUploaded
 * @property {boolean|null} [researchCreated]
 * @property {boolean|null} [sourceCreated]
 * @property {boolean|null} [sourceLinked]
 * @property {boolean} [attachmentsLost]
 * Zitierschluessel, den der Nutzer vergeben hat und der schon belegt war. Die
 * Quelle wurde dann ohne ihn angelegt (`409 CITEKEY_TAKEN`, Wiederholung ohne
 * das Feld) — festgehalten, damit die Quittung es sagen kann.
 * @property {string} [citekeyDropped]
 * @property {boolean} [quoteApproximate] siehe `CaptureIntent.quoteApproximate`
 * @property {'capture'|'split'|null} via
 */

/**
 * Vollstaendige Voreinstellung, gemischt mit dem, was gespeichert ist.
 * @param {Record<string, any>} stored
 */
export function withDefaults(stored = {}) {
  return {
    [STORAGE_KEYS.SERVER_URL]: stored[STORAGE_KEYS.SERVER_URL] || '',
    [STORAGE_KEYS.TOKEN]: stored[STORAGE_KEYS.TOKEN] || '',
    [STORAGE_KEYS.TOKEN_STATE]: stored[STORAGE_KEYS.TOKEN_STATE] || TOKEN_STATE.UNKNOWN,
    [STORAGE_KEYS.DEFAULT_BOOK_ID]: stored[STORAGE_KEYS.DEFAULT_BOOK_ID] ?? null,
    [STORAGE_KEYS.BOOKS]: Array.isArray(stored[STORAGE_KEYS.BOOKS]) ? stored[STORAGE_KEYS.BOOKS] : [],
    [STORAGE_KEYS.BOOKS_FETCHED_AT]: stored[STORAGE_KEYS.BOOKS_FETCHED_AT] || 0,
    [STORAGE_KEYS.CAPABILITIES]: {
      ...DEFAULT_CAPABILITIES,
      ...(stored[STORAGE_KEYS.CAPABILITIES] || {}),
      capture: {
        ...DEFAULT_CAPABILITIES.capture,
        ...((stored[STORAGE_KEYS.CAPABILITIES] || {}).capture || {}),
      },
      byUrl: {
        ...DEFAULT_CAPABILITIES.byUrl,
        ...((stored[STORAGE_KEYS.CAPABILITIES] || {}).byUrl || {}),
      },
      researchList: {
        ...DEFAULT_CAPABILITIES.researchList,
        ...((stored[STORAGE_KEYS.CAPABILITIES] || {}).researchList || {}),
      },
    },
    [STORAGE_KEYS.QUEUE]: Array.isArray(stored[STORAGE_KEYS.QUEUE]) ? stored[STORAGE_KEYS.QUEUE] : [],
    [STORAGE_KEYS.SETTINGS]: { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) },
  };
}

/**
 * Loest den Auto/An/Aus-Schalter gegen den Messwert auf.
 * @param {{mode?: string, detected?: boolean|null}} capability
 * @returns {boolean}
 */
export function capabilityEnabled(capability) {
  if (!capability) return false;
  if (capability.mode === CAPABILITY_MODE.ON) return true;
  if (capability.mode === CAPABILITY_MODE.OFF) return false;
  return capability.detected === true;
}

/**
 * Darf in dieses Buch erfasst werden? `viewer` reicht nicht.
 * @param {{role?: string}} book
 */
export function canWriteToBook(book) {
  return !!book && (book.role === 'editor' || book.role === 'owner');
}
