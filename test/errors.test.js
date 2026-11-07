import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ApiError,
  ERROR_MESSAGE_KEYS,
  describeError,
  isAuthError,
  isRetryable,
  isScopeError,
  messageKeyForError,
  substitutionsForError,
} from '../src/shared/errors.js';

/** Uebersetzer-Attrappe: gibt den Schluessel mit eingesetzten Platzhaltern zurueck. */
const fakeTranslate = (key, subs = []) =>
  subs.length ? `${key}[${subs.join('|')}]` : `text:${key}`;

/**
 * Der Vertrag, wie er im Mutterprojekt in `docs/clients.md` steht — die
 * vollstaendige Fehlercode-Tabelle. Der Test haelt die Map dagegen: sie muss
 * jeden dieser Codes kennen (sonst sieht der Nutzer eine generische Meldung)
 * und darf keinen Code kennen, den der Server nie sendet (sonst prueft der
 * Client auf etwas, das nie eintrifft — genau der Fehler, der
 * `CAPTURE_SCOPE_REQUIRED` drei Versionen lang ueberlebt hat).
 */
const CONTRACT_CODES = [
  'NOT_LOGGED_IN',
  'DEVICE_SCOPE_FORBIDDEN',
  'DEMO_TOKEN_FIXED',
  'INVALID_BOOK_ID',
  'NO_BOOK_ACCESS',
  'INSUFFICIENT_ROLE',
  'BOOKID_REQ',
  'INVALID_VALUE',
  'INVALID_URL',
  'INVALID_FIELD',
  'EMPTY',
  'SOURCE_IDENTITY_REQ',
  'CITEKEY_TAKEN',
  'INVALID_ID',
  'DUPLICATE_URL',
  'SEARCH_FAILED',
  'SHUTTING_DOWN',
  'ITEM_NOT_FOUND',
  'NO_IMAGE',
  'IMAGE_INVALID',
  'NO_DOC',
  'DOC_TOO_LARGE',
  'DOC_NOT_PDF',
  'DOC_UNREADABLE',
  'URL_REQ',
  'NOT_FOUND',
  'NOT_SOURCE_OWNER',
  'LOOKUP_PARAM_REQUIRED',
  'LOOKUP_PARAM_AMBIGUOUS',
  'INVALID_DOI',
  'INVALID_ISBN',
  'LOOKUP_NOT_FOUND',
  'LOOKUP_UNAVAILABLE',
  'LOOKUP_FAILED',
];

/**
 * Codes, die aeltere Server sendeten und der heutige Vertrag nicht mehr kennt.
 * Sie bleiben gemappt, weil selbst gehostete Instanzen nachhinken — sie sind
 * keine Erfindung, nur Altlast.
 */
const LEGACY_CODES = ['LOGIN_REQ'];

/** Codes, die der Client einmal erwartete und die der Server nie gesendet hat. */
const ERFUNDENE_CODES = [
  'CAPTURE_SCOPE_REQUIRED',
  'BOOK_NOT_FOUND',
  'BOOK_ACCESS_DENIED',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'SOURCE_NOT_FOUND',
];

describe('Fehlercode-Map gegen den Vertrag', () => {
  it('kennt jeden Code der Vertragstabelle', () => {
    const fehlend = CONTRACT_CODES.filter((code) => !ERROR_MESSAGE_KEYS[code]);
    assert.deepEqual(fehlend, []);
  });

  it('kennt keinen erfundenen Code mehr', () => {
    const uebrig = ERFUNDENE_CODES.filter((code) => ERROR_MESSAGE_KEYS[code]);
    assert.deepEqual(uebrig, []);
  });

  it('kennt jeden Code, den die Erweiterung selbst wirft', async () => {
    // Sonst faellt ein eigener Code auf `err_unmapped_code` und haengt dem
    // Server an, was in der Erweiterung schiefgegangen ist.
    const { readFile, readdir } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    /** @param {string} dir @returns {Promise<string[]>} */
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : Promise.resolve([join(dir, entry.name)]),
        ),
      );
      return nested.flat();
    };

    /** @type {Set<string>} */
    const geworfen = new Set();
    for (const file of (await walk(src)).filter((name) => name.endsWith('.js'))) {
      if (file.endsWith(`shared${'/'}errors.js`)) continue;
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/code:\s*'([A-Z][A-Z0-9_]+)'/g)) geworfen.add(match[1]);
    }

    assert.ok(geworfen.size > 5, 'die Suche hat nichts gefunden — Muster pruefen');
    const fehlend = [...geworfen].filter((code) => !ERROR_MESSAGE_KEYS[code]);
    assert.deepEqual(fehlend, []);
  });

  it('jeder gemappte Server-Code steht im Vertrag oder ist ausgewiesene Altlast', () => {
    const eigene = new Set([
      'NO_SERVER_CONFIGURED', 'NO_TOKEN_CONFIGURED', 'TIMEOUT', 'CLIENT_VALIDATION_FAILED',
      'CLIENT_IMAGE_TOO_LARGE', 'CLIENT_DOC_TOO_LARGE', 'CLIENT_PAYLOAD_TOO_LARGE',
      'HARVEST_FAILED', 'NO_ACTIVE_TAB', 'INVALID_SERVER_URL', 'UNKNOWN_MESSAGE',
      'CLIENT_SERVER_CHANGED', 'CLIENT_TOKEN_REQUIRED',
    ]);
    const bekannt = new Set([...CONTRACT_CODES, ...LEGACY_CODES, ...eigene]);
    assert.deepEqual(Object.keys(ERROR_MESSAGE_KEYS).filter((code) => !bekannt.has(code)), []);
  });

  it('INVALID_FIELD nennt das Feld und wird nicht wiederholt', () => {
    const error = { status: 400, code: 'INVALID_FIELD', params: { field: 'title' } };
    assert.deepEqual(substitutionsForError(error), ['title']);
    assert.equal(isRetryable(error), false);
  });

  it('INVALID_URL setzt `params.max` nicht in den Text ein und ist endgueltig', () => {
    const error = { status: 400, code: 'INVALID_URL', params: { max: 2000 } };
    assert.deepEqual(substitutionsForError(error), []);
    assert.equal(isRetryable(error), false);
  });

  it('SEARCH_FAILED und SHUTTING_DOWN sind voruebergehend — wiederholen', () => {
    // Vertrag: „wie einen vorübergehenden Fehler behandeln und erneut versuchen".
    assert.equal(isRetryable({ status: 503, code: 'SEARCH_FAILED' }), true);
    assert.equal(isRetryable({ status: 503, code: 'SHUTTING_DOWN' }), true);
    assert.equal(messageKeyForError({ status: 503, code: 'SHUTTING_DOWN' }), 'err_shutting_down');
  });

  it('LOGIN_REQ (Altlast) und NOT_LOGGED_IN sind derselbe Fall unter zwei Namen', () => {
    // Aeltere Server sagten auf `/research` LOGIN_REQ, heute kommt dort
    // NOT_LOGGED_IN. Gleiche Meldung, gleiche Behandlung.
    assert.equal(messageKeyForError({ status: 401, code: 'LOGIN_REQ' }), 'err_not_logged_in');
    assert.equal(isAuthError({ status: 401, code: 'LOGIN_REQ' }), true);
    assert.equal(isRetryable({ status: 401, code: 'LOGIN_REQ' }), false);
  });
});

describe('messageKeyForError', () => {
  it('bildet dokumentierte Codes ab', () => {
    assert.equal(messageKeyForError({ status: 401, code: 'NOT_LOGGED_IN' }), 'err_not_logged_in');
    assert.equal(
      messageKeyForError({ status: 403, code: 'DEVICE_SCOPE_FORBIDDEN' }),
      'err_device_scope_forbidden',
    );
    assert.equal(messageKeyForError({ status: 400, code: 'SOURCE_IDENTITY_REQ' }), 'err_source_identity_req');
    assert.equal(messageKeyForError({ status: 409, code: 'CITEKEY_TAKEN' }), 'err_citekey_taken');
  });

  it('ist unempfindlich gegen Kleinschreibung', () => {
    assert.equal(messageKeyForError({ code: 'not_logged_in' }), 'err_not_logged_in');
  });

  it('faellt auf den HTTP-Status zurueck, wenn der Server KEINEN Code schickt', () => {
    // Genau das ist der Fall bei den beiden HTML-Antworten des Body-Parsers.
    assert.equal(messageKeyForError({ status: 404 }), 'err_status_404');
    assert.equal(messageKeyForError({ status: 500 }), 'err_server_error');
    assert.equal(messageKeyForError({ status: 418 }), 'err_status_400');
    assert.equal(messageKeyForError({ status: 599 }), 'err_server_error');
  });

  it('413 ohne Code heisst „zu gross" — DOC_TOO_LARGE kommt nie an', () => {
    // Parser-Limit und Server-Limit liegen beide bei 25 MB, der Parser gewinnt.
    // Wer nur auf DOC_TOO_LARGE prueft, faengt den Fall nie.
    assert.equal(messageKeyForError({ status: 413 }), 'err_payload_too_large');
    assert.equal(messageKeyForError({ status: 413, code: 'DOC_TOO_LARGE' }), 'err_doc_too_large');
  });

  it('400 ohne Code ist der kaputte JSON-Koerper', () => {
    assert.equal(messageKeyForError({ status: 400 }), 'err_status_400');
  });

  it('erkennt Netzfehler', () => {
    assert.equal(messageKeyForError({ networkError: true, status: 0 }), 'err_network');
  });

  it('kennt einen letzten Ausweg', () => {
    assert.equal(messageKeyForError({}), 'err_unknown');
  });

  it('ein unbekannter Code verschwindet nicht — er nennt sich selbst', () => {
    assert.equal(messageKeyForError({ status: 400, code: 'WAS_AUCH_IMMER' }), 'err_unmapped_code');
    const result = describeError({ status: 400, code: 'WAS_AUCH_IMMER' }, fakeTranslate);
    assert.equal(result.text, 'err_unmapped_code[WAS_AUCH_IMMER|400]');
    // Kein doppelter Code am Ende: er steht schon im Text.
    assert.equal(result.code, 'WAS_AUCH_IMMER');
  });
});

describe('substitutionsForError', () => {
  it('INSUFFICIENT_ROLE nennt Ist- und Soll-Rolle in FESTER Reihenfolge', () => {
    // Sonst haengt die Meldung daran, wie der Server das Objekt serialisiert.
    assert.deepEqual(
      substitutionsForError({ code: 'INSUFFICIENT_ROLE', params: { actual: 'viewer', required: 'editor' } }),
      ['viewer', 'editor'],
    );
    assert.deepEqual(
      substitutionsForError({ code: 'INSUFFICIENT_ROLE', params: { required: 'editor', actual: 'viewer' } }),
      ['viewer', 'editor'],
    );
  });

  it('fehlende Angaben werden nicht zu „undefined" im Text', () => {
    assert.deepEqual(substitutionsForError({ code: 'INSUFFICIENT_ROLE', params: {} }), ['?', '?']);
  });

  it('INVALID_VALUE nennt Feld und erlaubte Werte', () => {
    assert.deepEqual(
      substitutionsForError({ code: 'INVALID_VALUE', params: { field: 'mode', allowed: 'research,source,both' } }),
      ['mode', 'research,source,both'],
    );
  });
});

describe('isRetryable', () => {
  it('Netzfehler und Zeitueberschreitungen: ja', () => {
    assert.equal(isRetryable({ networkError: true }), true);
    assert.equal(isRetryable({ status: 408 }), true);
    assert.equal(isRetryable({ status: 429 }), true);
    assert.equal(isRetryable({ status: 503 }), true);
  });

  it('Auth- und Berechtigungsfehler: nein — nie stillschweigend wiederholen', () => {
    assert.equal(isRetryable({ status: 401, code: 'NOT_LOGGED_IN' }), false);
    assert.equal(isRetryable({ status: 403, code: 'DEVICE_SCOPE_FORBIDDEN' }), false);
    assert.equal(isRetryable({ status: 403, code: 'NO_BOOK_ACCESS' }), false);
    assert.equal(isRetryable({ status: 403, code: 'INSUFFICIENT_ROLE' }), false);
  });

  it('fachliche Ablehnungen: nein', () => {
    assert.equal(isRetryable({ status: 400, code: 'SOURCE_IDENTITY_REQ' }), false);
    assert.equal(isRetryable({ status: 400, code: 'EMPTY' }), false);
    assert.equal(isRetryable({ status: 400, code: 'BOOKID_REQ' }), false);
    assert.equal(isRetryable({ status: 400, code: 'INVALID_URL' }), false);
    assert.equal(isRetryable({ status: 413, code: 'DOC_TOO_LARGE' }), false);
    assert.equal(isRetryable({ status: 415, code: 'DOC_NOT_PDF' }), false);
    assert.equal(isRetryable({ status: 403, code: 'NOT_SOURCE_OWNER' }), false);
  });

  it('ein 502 vom Fremd-Dienst darf wiederholt werden', () => {
    // Crossref/OpenLibrary ist kurz weg — die Anfrage selbst ist in Ordnung.
    assert.equal(isRetryable({ status: 502, code: 'LOOKUP_UNAVAILABLE' }), true);
  });

  it('ein 413 OHNE Code ist endgueltig: die Datei wird nicht kleiner', () => {
    // Ohne diese Zeile wuerde ein zu grosses PDF in der Warteschlange kreisen.
    assert.equal(isRetryable({ status: 413 }), false);
  });

  it('CITEKEY_TAKEN wird im Ablauf behandelt, nicht per Retry', () => {
    assert.equal(isRetryable({ status: 409, code: 'CITEKEY_TAKEN' }), false);
  });

  it('ohne HTTP-Antwort: ja', () => {
    assert.equal(isRetryable({ status: 0 }), true);
  });
});

describe('isAuthError / isScopeError', () => {
  it('erkennt 401 und NOT_LOGGED_IN', () => {
    assert.equal(isAuthError({ status: 401 }), true);
    assert.equal(isAuthError({ code: 'NOT_LOGGED_IN' }), true);
    assert.equal(isAuthError({ status: 403 }), false);
  });

  it('erkennt den fehlenden Scope — und nur an DEVICE_SCOPE_FORBIDDEN', () => {
    assert.equal(isScopeError({ code: 'DEVICE_SCOPE_FORBIDDEN' }), true);
    // Der Code, den der Client einmal erwartete, ist kein Scope-Fehler mehr.
    assert.equal(isScopeError({ code: 'CAPTURE_SCOPE_REQUIRED' }), false);
    // Ein nackter 403 sagt nichts ueber das Token.
    assert.equal(isScopeError({ status: 403 }), false);
    // Ein Buchrecht ist kein Token-Recht.
    assert.equal(isScopeError({ status: 403, code: 'INSUFFICIENT_ROLE' }), false);
    assert.equal(isScopeError({ status: 403, code: 'NO_BOOK_ACCESS' }), false);
  });
});

describe('describeError', () => {
  it('haengt IMMER den Fehlercode an — dafuer ist er da', () => {
    const result = describeError({ status: 403, code: 'DEVICE_SCOPE_FORBIDDEN' }, fakeTranslate);
    assert.equal(result.code, 'DEVICE_SCOPE_FORBIDDEN');
    assert.ok(result.text.endsWith('(DEVICE_SCOPE_FORBIDDEN)'));
    assert.equal(result.scope, true);
    assert.equal(result.retryable, false);
  });

  it('INSUFFICIENT_ROLE nennt die Ursache, nicht nur „verweigert"', () => {
    const result = describeError(
      { status: 403, code: 'INSUFFICIENT_ROLE', params: { actual: 'viewer', required: 'editor' } },
      fakeTranslate,
    );
    assert.equal(result.text, 'err_insufficient_role[viewer|editor] (INSUFFICIENT_ROLE)');
    assert.equal(result.scope, false, 'eine Rolle ist keine Token-Eigenschaft');
    assert.equal(result.retryable, false);
  });

  it('reicht Server-Parameter als Platzhalter durch', () => {
    const result = describeError(
      { status: 400, code: 'INVALID_VALUE', params: { field: 'mode', allowed: 'research,source,both' } },
      fakeTranslate,
    );
    assert.equal(result.text, 'err_invalid_value[mode|research,source,both] (INVALID_VALUE)');
  });

  it('markiert Netzfehler als NETWORK', () => {
    const result = describeError({ networkError: true, status: 0 }, fakeTranslate);
    assert.equal(result.code, 'NETWORK');
    assert.equal(result.retryable, true);
  });

  it('ohne Code steht der HTTP-Status im Text', () => {
    const result = describeError({ status: 502 }, fakeTranslate);
    assert.equal(result.code, 'HTTP_502');
    assert.ok(result.text.endsWith('(HTTP_502)'));
  });

  it('kommt ohne Uebersetzer aus', () => {
    const result = describeError({ status: 404 });
    assert.equal(result.text, 'err_status_404 (HTTP_404)');
  });
});

describe('ApiError', () => {
  it('laesst sich fuer die Warteschlange serialisieren', () => {
    const error = new ApiError({ status: 409, code: 'CITEKEY_TAKEN', params: { citekey: 'muster2019' } });
    const json = JSON.parse(JSON.stringify(error));
    assert.equal(json.status, 409);
    assert.equal(json.code, 'CITEKEY_TAKEN');
    assert.deepEqual(json.params, { citekey: 'muster2019' });
  });

  it('ist ein echter Error', () => {
    const error = new ApiError({ code: 'X' });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ApiError');
  });
});
