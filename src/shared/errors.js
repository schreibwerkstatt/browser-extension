/**
 * Fehlercode -> Text und Verhalten.
 *
 * Zwei Regeln aus der Spezifikation:
 *  - Der `error_code` wird IMMER mit angezeigt, damit Support moeglich ist.
 *  - Auth-Fehler werden nie stillschweigend wiederholt.
 *
 * Dieses Modul kennt `chrome.i18n` nicht; es liefert nur Schluessel.
 * Das Uebersetzen macht der Aufrufer (siehe `shared/i18n.js`).
 */

/** Fehler mit strukturierter Server-Antwort. */
export class ApiError extends Error {
  /**
   * @param {object} init
   * @param {number} [init.status]
   * @param {string} [init.code]
   * @param {Record<string, any>} [init.params]
   * @param {string} [init.message]
   * @param {boolean} [init.networkError]
   * @param {unknown} [init.cause]
   */
  constructor({ status = 0, code = '', params = {}, message = '', networkError = false, cause } = {}) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.params = params;
    this.networkError = networkError;
    if (cause !== undefined) this.cause = cause;
    /** Antwort war JSON — unterscheidet ein fachliches 404 vom Express-404. */
    this.jsonBody = false;
    /** Die ersten 500 Zeichen der Antwort, fuer die Faehigkeits-Erkennung. */
    this.bodyText = '';
    /** Angefragter Pfad; der Scope-Fehlercode sagt nicht, welcher Scope fehlt. */
    this.path = '';
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      params: this.params,
      networkError: this.networkError,
      message: this.message,
    };
  }
}

/**
 * **Die** Fehlercode-Map: `error_code` des Servers -> i18n-Schluessel.
 *
 * Sie deckt den dokumentierten Vertrag vollstaendig ab (Mutterprojekt,
 * `docs/clients.md`, Abschnitt „Dritter Client"). Alle Meldungen kommen von
 * hier; nirgends im Client wird ein Code in einer `if`-Kette geprueft, um Text
 * auszuwaehlen. Wer einen Code hinzufuegt, fuegt ihn hier hinzu — und nur hier.
 *
 * Codes, die hier NICHT stehen, sind keine Luecke, die man mit einer Annahme
 * fuellt: sie fallen auf `err_unmapped_code` und nennen sich selbst, damit der
 * naechste Abgleich sie findet statt sie zu erraten.
 */
export const ERROR_MESSAGE_KEYS = Object.freeze({
  // ----------------------------------------------------- Auth und Berechtigung
  /** Token fehlt, unbekannt, widerrufen, abgelaufen — oder Konto gesperrt. */
  NOT_LOGGED_IN: 'err_not_logged_in',
  /**
   * ALTLAST, kein Vertragscode mehr: so antworteten die `/research`-Routen
   * aelterer Server. Heute kommt die 401 dort aus dem Buch-Guard, und zwar als
   * `NOT_LOGGED_IN` („keinen zweiten Code fuer dieselbe Lage", docs/clients.md).
   * Bleibt stehen, weil selbst gehostete Instanzen nicht im Gleichschritt
   * aktualisiert werden.
   */
  LOGIN_REQ: 'err_not_logged_in',
  /**
   * Methode+Pfad stehen nicht in der Allowlist DIESES Tokens. Aussage ueber das
   * Token, nicht ueber das Buch — das Gate sitzt vor der Route, es wurde nichts
   * gelesen und nichts geschrieben.
   */
  DEVICE_SCOPE_FORBIDDEN: 'err_device_scope_forbidden',
  /** Festes Demo-Token; mit einem capture-Token gar nicht erreichbar. */
  DEMO_TOKEN_FIXED: 'err_demo_token_fixed',

  // ------------------------------------------------------------- Buchzugriff
  /**
   * Buch existiert nicht ODER keine Zugriffsrolle. Der Server unterscheidet das
   * absichtlich nicht, damit fremde Buch-Ids nicht abfragbar sind — deshalb gibt
   * es hier auch keine zwei Meldungen.
   */
  NO_BOOK_ACCESS: 'err_no_book_access',
  /** Rolle zu niedrig. Traegt `detail: { actual, required }`. */
  INSUFFICIENT_ROLE: 'err_insufficient_role',
  /** `book_id` keine positive Ganzzahl (nur auf `:book_id`-URL-Routen). */
  INVALID_BOOK_ID: 'err_invalid_id',
  /** `book_id` fehlt oder ist ungueltig (`POST /capture`, `POST /research`). */
  BOOKID_REQ: 'err_bookid_req',
  /** `book_id`/`:id` fehlt oder ist keine positive Ganzzahl. */
  INVALID_ID: 'err_invalid_id',

  // -------------------------------------------------------------- Nutzdaten
  /** Wert nicht in der Whitelist. `params: { field, allowed }`. */
  INVALID_VALUE: 'err_invalid_value',
  /**
   * URL nicht http(s), nicht normalisierbar oder ueber 2000 Zeichen
   * (`params: { max }`). Abgelehnt wird der ganze Request; gekuerzt wird nie.
   */
  INVALID_URL: 'err_invalid_url',
  /** `title`/`body`/`source` weder String noch `null`. `params: { field }`. */
  INVALID_FIELD: 'err_invalid_field',
  /**
   * `POST /research`: eine der URLs haengt schon an einem Fundstueck dieses
   * Buchs. Traegt `existing_id`. Der Ablauf antwortet darauf selbst (einmal mit
   * `allow_duplicate: true`, siehe `capture-runner.js`) — die Meldung ist fuer
   * den Fall, dass er es nicht kann.
   */
  DUPLICATE_URL: 'err_duplicate_url',
  /** Fundstueck ohne Titel, Text und URL. */
  EMPTY: 'err_empty',
  /** Quelle ohne Titel und ohne Person. */
  SOURCE_IDENTITY_REQ: 'err_source_identity_req',
  CITEKEY_TAKEN: 'err_citekey_taken',

  // --------------------------------------------------------------- Anhaenge
  ITEM_NOT_FOUND: 'err_item_not_found',
  NO_IMAGE: 'err_no_image',
  IMAGE_INVALID: 'err_image_invalid',
  NO_DOC: 'err_no_doc',
  /**
   * PDF > 25 MB. In der Praxis nie zu sehen: der Body-Parser hat dieselbe
   * Schwelle und gewinnt — dann kommt ein 413 OHNE `error_code`. Wer nur auf
   * diesen Code prueft, faengt den Fall nie; siehe `STATUS_MESSAGE_KEYS[413]`.
   */
  DOC_TOO_LARGE: 'err_doc_too_large',
  DOC_NOT_PDF: 'err_doc_not_pdf',
  DOC_UNREADABLE: 'err_doc_unreadable',
  /** Quelle gehoert einem anderen Konto — Bibliotheks-Hoheit, nicht Buchrecht. */
  NOT_SOURCE_OWNER: 'err_not_source_owner',

  // ----------------------------------------------------- Voruebergehend (503)
  /** `GET /research?q=`: Volltextsuche gescheitert — keine ungefilterte Liste. */
  SEARCH_FAILED: 'err_search_failed',
  /** Server startet gerade neu (Deploy). Es wurde nichts geschrieben. */
  SHUTTING_DOWN: 'err_shutting_down',

  // ------------------------------------------------------------ Quellenpfade
  URL_REQ: 'err_url_req',
  /** Auf `GET /sources/by-url` der Normalfall „kenne ich nicht", kein Fehler. */
  NOT_FOUND: 'err_not_found',

  // ------------------------------------------------- Register-Abfrage (lookup)
  LOOKUP_PARAM_REQUIRED: 'err_lookup_param_required',
  LOOKUP_PARAM_AMBIGUOUS: 'err_lookup_param_ambiguous',
  INVALID_DOI: 'err_invalid_doi',
  INVALID_ISBN: 'err_invalid_isbn',
  LOOKUP_NOT_FOUND: 'err_lookup_not_found',
  LOOKUP_UNAVAILABLE: 'err_lookup_unavailable',
  LOOKUP_FAILED: 'err_lookup_failed',

  // ------------------------------------------------------------- Eigene Codes
  // Nicht vom Server, sondern von dieser Erweiterung erzeugt. Sie stehen mit in
  // der Map, weil sonst genau die Faelle als „Unbekannter Fehler" erscheinen,
  // die wir selbst am besten erklaeren koennten.
  NO_SERVER_CONFIGURED: 'err_no_server_configured',
  NO_TOKEN_CONFIGURED: 'err_no_token_configured',
  TIMEOUT: 'err_status_timeout',
  CLIENT_VALIDATION_FAILED: 'err_client_validation_failed',
  CLIENT_IMAGE_TOO_LARGE: 'err_client_image_too_large',
  CLIENT_DOC_TOO_LARGE: 'err_client_doc_too_large',
  CLIENT_PAYLOAD_TOO_LARGE: 'err_client_payload_too_large',
  /** Auftrag wurde fuer einen anderen Server erfasst — angehalten, nicht umgeleitet. */
  CLIENT_SERVER_CHANGED: 'err_client_server_changed',
  /** Serverwechsel ohne neues Token: das alte ginge sonst an den fremden Host. */
  CLIENT_TOKEN_REQUIRED: 'err_client_token_required',
  HARVEST_FAILED: 'err_harvest_failed',
  NO_ACTIVE_TAB: 'err_no_active_tab',
  INVALID_SERVER_URL: 'err_invalid_server_url',
  // Interner Fehler, kein Serverproblem. Ohne Eintrag wuerde `err_unmapped_code`
  // dem Server etwas anhaengen, was in der Erweiterung schiefgegangen ist.
  UNKNOWN_MESSAGE: 'err_unknown_message',
});

/**
 * Fallback nach HTTP-Status, wenn der Server keinen Code mitschickt.
 *
 * Das ist kein Notnagel, sondern ein regulaerer Pfad: der Server hat keinen
 * globalen Express-Fehler-Handler, deshalb antwortet der Body-Parser mit
 * Express' Default — **HTML ohne `error_code`**. Zwei Faelle, beide echt:
 *
 *   413  Koerper ueber dem Parser-Limit (PDF > 25 MB, Bild > 12 MB, JSON > 256 kB)
 *   400  JSON-Koerper syntaktisch kaputt
 */
const STATUS_MESSAGE_KEYS = Object.freeze({
  400: 'err_status_400',
  401: 'err_not_logged_in',
  403: 'err_status_403',
  404: 'err_status_404',
  405: 'err_status_404',
  408: 'err_status_timeout',
  409: 'err_status_409',
  // Kein `error_code` heisst hier verlaesslich: der Parser hat abgebrochen,
  // also war eine Datei oder der JSON-Koerper zu gross.
  413: 'err_payload_too_large',
  415: 'err_unsupported_media_type',
  429: 'err_rate_limited',
  500: 'err_server_error',
  502: 'err_server_error',
  503: 'err_server_error',
  504: 'err_status_timeout',
});

/**
 * Codes, bei denen ein Wiederholen sinnlos ist (der Nutzer muss handeln).
 *
 * Alles, was der Server fachlich ablehnt, gehoert hierher: dieselbe Anfrage
 * bekommt dieselbe Antwort. Ausgenommen sind die `LOOKUP_*`-502er — dort ist
 * ein Fremddienst kurz weg, nicht die Anfrage falsch.
 */
const TERMINAL_CODES = new Set([
  'NOT_LOGGED_IN',
  'LOGIN_REQ',
  // Ein fehlender Scope ist eine Eigenschaft des Tokens, keine Stoerung:
  // wiederholen aendert nichts, der Nutzer muss ein passendes Token holen.
  'DEVICE_SCOPE_FORBIDDEN',
  'DEMO_TOKEN_FIXED',
  'NO_BOOK_ACCESS',
  'INSUFFICIENT_ROLE',
  'INVALID_BOOK_ID',
  'BOOKID_REQ',
  'INVALID_ID',
  'INVALID_VALUE',
  'INVALID_URL',
  'INVALID_FIELD',
  'DUPLICATE_URL',
  'EMPTY',
  'SOURCE_IDENTITY_REQ',
  'ITEM_NOT_FOUND',
  'NO_IMAGE',
  'IMAGE_INVALID',
  'NO_DOC',
  'DOC_TOO_LARGE',
  'DOC_NOT_PDF',
  'DOC_UNREADABLE',
  'NOT_SOURCE_OWNER',
  'URL_REQ',
  'LOOKUP_PARAM_REQUIRED',
  'LOOKUP_PARAM_AMBIGUOUS',
  'INVALID_DOI',
  'INVALID_ISBN',
  'LOOKUP_NOT_FOUND',
  // Eigene Ablehnungen: erneut senden aendert nichts am Inhalt.
  'NO_SERVER_CONFIGURED',
  'NO_TOKEN_CONFIGURED',
  'CLIENT_VALIDATION_FAILED',
  'CLIENT_IMAGE_TOO_LARGE',
  'CLIENT_DOC_TOO_LARGE',
  'CLIENT_PAYLOAD_TOO_LARGE',
  'CLIENT_SERVER_CHANGED',
  'CLIENT_TOKEN_REQUIRED',
  'INVALID_SERVER_URL',
]);

/**
 * Wie die Platzhalter einer Meldung zu fuellen sind.
 *
 * Ohne das haengt die Reihenfolge an der Schluesselreihenfolge des
 * JSON-Objekts — bei `INSUFFICIENT_ROLE` also daran, ob der Server
 * `{actual, required}` oder `{required, actual}` serialisiert. Hier steht sie
 * ausdruecklich.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const SUBSTITUTION_FIELDS = Object.freeze({
  INSUFFICIENT_ROLE: ['actual', 'required'],
  INVALID_VALUE: ['field', 'allowed'],
  INVALID_FIELD: ['field'],
  // `params.max` steht fest bei 2000 und im Text; nichts einsetzen.
  INVALID_URL: [],
  CITEKEY_TAKEN: ['citekey'],
});

/** HTTP-Status, die ein Wiederholen rechtfertigen. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 524]);

/**
 * Normalisiert den Code eines Fehlers auf die Schreibweise der Map.
 * @param {{code?: string}} error
 * @returns {string}
 */
function codeOf(error) {
  return typeof error.code === 'string' ? error.code.trim().toUpperCase() : '';
}

/**
 * @param {{status?: number, code?: string, networkError?: boolean}} error
 * @returns {string} i18n-Schluessel
 */
export function messageKeyForError(error = {}) {
  const code = codeOf(error);
  if (code && ERROR_MESSAGE_KEYS[code]) return ERROR_MESSAGE_KEYS[code];
  if (error.networkError) return 'err_network';

  // Ein Code, den diese Version nicht kennt, darf nicht hinter einem
  // Status-Text verschwinden: die Meldung nennt ihn, damit der naechste
  // Abgleich weiss, wonach er sucht.
  if (code) return 'err_unmapped_code';

  const status = Number(error.status) || 0;
  if (STATUS_MESSAGE_KEYS[status]) return STATUS_MESSAGE_KEYS[status];
  if (status >= 500) return 'err_server_error';
  if (status >= 400) return 'err_status_400';
  return 'err_unknown';
}

/**
 * Platzhalter fuer die Meldung, in der Reihenfolge, die der Text erwartet.
 *
 * Der Server benennt die Zusatzangaben je nach Route `params` oder `detail`;
 * der API-Client legt beides in `error.params` ab.
 *
 * @param {{code?: string, status?: number, params?: Record<string, any>}} error
 * @returns {string[]}
 */
export function substitutionsForError(error = {}) {
  const code = codeOf(error);
  const params = error.params && typeof error.params === 'object' ? error.params : {};

  if (messageKeyForError(error) === 'err_unmapped_code') {
    return [code, String(error.status || 0)];
  }

  const fields = SUBSTITUTION_FIELDS[code];
  if (fields) {
    return fields.map((field) => {
      const value = params[field];
      return value === undefined || value === null ? '?' : String(value);
    });
  }

  return Object.values(params).map((value) => String(value));
}

/**
 * Darf dieser Fehler in der Queue wiederholt werden?
 * @param {{status?: number, code?: string, networkError?: boolean}} error
 * @returns {boolean}
 */
export function isRetryable(error = {}) {
  if (error.networkError) return true;
  const code = codeOf(error);
  if (code && TERMINAL_CODES.has(code)) return false;
  // CITEKEY_TAKEN wird im Ablauf selbst behandelt (ohne citekey erneut senden),
  // darf also nicht als generischer Retry durchrutschen.
  if (code === 'CITEKEY_TAKEN') return false;
  const status = Number(error.status) || 0;
  if (status === 0) return true; // kein HTTP zustande gekommen
  if (RETRYABLE_STATUS.has(status)) return true;
  return status >= 500;
}

/**
 * Ist das ein Authentifizierungsproblem? Dann Token als ungueltig markieren,
 * Badge rot, Options-Seite verlinken.
 *
 * Der Vertrag kennt fuer 401 nur `NOT_LOGGED_IN`. `LOGIN_REQ` sendeten die
 * `/research`-Routen aelterer Server fuer dieselbe Lage; er bekommt deshalb
 * dieselbe Behandlung.
 *
 * @param {{status?: number, code?: string}} error
 */
export function isAuthError(error = {}) {
  const code = codeOf(error);
  if (code === 'NOT_LOGGED_IN' || code === 'LOGIN_REQ') return true;
  return Number(error.status) === 401;
}

/**
 * Fehlt dem Token ein Scope?
 *
 * `DEVICE_SCOPE_FORBIDDEN` ist der einzige Code, den der Server dafuer sendet
 * (Scope-Gate in `lib/device-auth.js`, Allowlist in `lib/device-scopes.js`).
 * WELCHER Scope fehlt, sagt der Code nicht — das entscheidet der Pfad, siehe
 * `error.path`.
 *
 * @param {{status?: number, code?: string}} error
 */
export function isScopeError(error = {}) {
  return codeOf(error) === 'DEVICE_SCOPE_FORBIDDEN';
}

/**
 * Antwortet der Server mit `404`/`405` als HTML (kein `error_code`), fehlt die
 * Route. Ein fachliches 404 hingegen traegt `error_code` (z. B. `NOT_FOUND`)
 * und bedeutet „kenne ich, aber nicht da" — kein Hinweis auf eine fehlende
 * Route. Genau dasselbe Muster steht in `capabilities.js` und `capture-runner.js`.
 *
 * @param {{status?: number, jsonBody?: boolean}} error
 */
export function isRouteMissing(error = {}) {
  return (error.status === 404 || error.status === 405) && error.jsonBody !== true;
}

/**
 * Baut den anzeigbaren Text. Der Code steht immer dabei.
 *
 * @param {{status?: number, code?: string, params?: Record<string, any>, message?: string, networkError?: boolean}} error
 * @param {(key: string, substitutions?: string[]) => string} translate
 * @returns {{ code: string, key: string, text: string, retryable: boolean, auth: boolean, scope: boolean }}
 */
export function describeError(error = {}, translate = (key) => key) {
  const key = messageKeyForError(error);
  let text = translate(key, substitutionsForError(error)) || key;

  const badge =
    (typeof error.code === 'string' && error.code) ||
    (error.networkError ? 'NETWORK' : '') ||
    (error.status ? `HTTP_${error.status}` : 'UNKNOWN');

  // Der Code steht IMMER in der Meldung — aber nie zweimal. `err_unmapped_code`
  // nennt ihn schon im Text, weil er dort die eigentliche Information ist.
  if (badge && !text.includes(badge)) text = `${text} (${badge})`;

  return {
    code: badge,
    key,
    text,
    retryable: isRetryable(error),
    auth: isAuthError(error),
    scope: isScopeError(error),
  };
}
