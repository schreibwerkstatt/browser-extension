/**
 * Gemeinsame DOM-Helfer fuer Popup und Options-Seite.
 *
 * Beide UIs bauten dieselben kleinen Helfer (`el`, `errorText`, Notice-Komponenten)
 * je fuer sich — mit leicht unterschiedlichen Namen und Signaturen. Das hielt
 * Fehlerbehandlung und Viewer-Ausgrauung der <option>-Elemente auseinander.
 *
 * Dieses Modul ist frei von `chrome`-APIs und damit direkt testbar.
 */

import { canWriteToBook } from './config.js';
import { describeError } from './errors.js';

/**
 * Hier nie `document.getElementById` direkt — der Cast waere sonst an jeder
 * Aufrufstelle zu wiederholen.
 * @param {string} id
 * @returns {any}
 */
export function el(id) {
  return document.getElementById(id);
}

/**
 * Liefert den Anzeige-Text fuer einen Fehler ohne die strukturierten Kennzahlen.
 * @param {any} error
 * @param {(key: string, substitutions?: string[]) => string} [translate]
 */
export function errorText(error, translate = (key) => key) {
  if (error && error.message) return error.message;
  return translate('err_unknown');
}

/**
 * Ansichtstyp einer Notice — die Options-Seite hat `notice--warn` und
 * `notice--muted`; das Popup kommt mit `error`/`success` aus.
 * @typedef {'error'|'success'|'muted'|'warn'} NoticeTone
 */

const NOTICE_TONES = /** @type {const} */ (['error', 'success', 'muted', 'warn']);

/**
 * Setzt Text und Ton (CSS-Klasse `notice--<tone>`) an einem Knot und zeigt ihn.
 *
 * Andere Ton-Klassen werden zuvor entfernt, damit ein Wechsel von „Fehler"
 * zu „Erfolg" nicht beide Farben ueberlagert.
 *
 * @param {HTMLElement} node
 * @param {string} text
 * @param {NoticeTone} tone
 */
export function showNotice(node, text, tone) {
  node.textContent = text;
  node.classList.remove(...NOTICE_TONES.map((t) => `notice--${t}`));
  node.classList.add(`notice--${tone}`);
  node.hidden = false;
}

/**
 * Versteckt eine Notice.
 * @param {HTMLElement} node
 */
export function hideNotice(node) {
  node.hidden = true;
}

/**
 * Baut ein `<option>`-Element fuer ein Buch aus.
 *
 * Viewer-Buecher werden ausgegraut, nicht versteckt — nur so erkennt der
 * Nutzer, dass es das Buch gibt, aber nicht schreibbar ist.
 *
 * @param {Record<string, any>} book Eintrag aus `GET /books`: `id`, `name`, `role`
 * @param {(key: string, substitutions?: string[]) => string} translate
 * @returns {HTMLOptionElement}
 */
export function createBookOption(book, translate) {
  const option = document.createElement('option');
  option.value = String(book.id);
  const writable = canWriteToBook(book);
  option.disabled = !writable;
  option.textContent = writable ? book.name : `${book.name} — ${translate('role_viewer')}`;
  return option;
}

/**
 * Fehleranzeige fuer die UI: elementarer Text plus Sonderpfad fuer Auth-Fehler.
 *
 * Im Service Worker wird `describeError` bereits gerufen und die Meldung
 * mit `error.auth`/`error.scope` sauber ausgezeichnet; das Popup bekommt die
 * so angereicherte Fehlerstruktur direkt. Diese Funktion kapselt die kleine
 * Verzweigung, die vorher an beiden Aufrufstellen stand.
 *
 * Mit `onAuth` laesst sich die Anzeige weiterleiten, wenn das Token untauglich
 * ist (Popup schaltet auf die Token-Problem-Zeile um, Options-Seite macht
 * aehnliches); ohne `onAuth` erscheint der Fehlertext inline.
 *
 * @param {any} error
 * @param {{
 *   translate?: (key: string, substitutions?: string[]) => string,
 *   onAuth?: (text: string) => void,
 *   inline?: HTMLElement,
 * }} [opts]
 */
export function showUiError(error, opts = {}) {
  const translate = opts.translate || ((key) => key);
  // Kommt der Fehler aus dem Service Worker, ist er dort schon beschrieben
  // (`message` mit Code, `key` gesetzt). Ein zweites `describeError` saehe nur
  // noch Ersatzcodes wie `NETWORK` oder `HTTP_503`, die die Map nicht kennt, und
  // verloere die Platzhalter — heraus kaeme „unbekannter Fehlercode NETWORK".
  const alreadyDescribed = !!(error && error.key && typeof error.message === 'string' && error.message);
  const text = alreadyDescribed
    ? error.message
    : describeError(error, translate).text || errorText(error, translate);
  if (error && error.auth && opts.onAuth) {
    opts.onAuth(text);
    return;
  }
  if (opts.inline) showNotice(opts.inline, text, 'error');
}