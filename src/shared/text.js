/**
 * Textwerkzeuge: kuerzen, Jahreszahlen und DOIs ziehen, Datum formatieren.
 * Alles rein und ohne DOM, damit es sich ohne Browser testen laesst.
 */

import { LIMITS } from './limits.js';

/**
 * Vereinheitlicht Weissraum. Nur fuer Metadaten-Felder benutzen —
 * NIE fuer den Wortlaut eines Zitats.
 * @param {unknown} value
 * @returns {string}
 */
export function collapseWhitespace(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalisiert Absatzstruktur von extrahiertem Fliesstext.
 *
 * Regel: eine Absatzgrenze ist **zwei** aufeinanderfolgende Zeilenumbrueche.
 * Ein einzelner Umbruch ist ein Soft-Wrap (vom Browser-Umbuch, von `<br>`
 * oder von eingeruecktem HTML-Quelltext) und wird zu einem Leerzeichen.
 * beliebig viele Umbrueche werden zu hoechstens einer Leerzeile.
 *
 * NIE fuer den Wortlaut eines Zitats benutzen — siehe `readSelection`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function tidyParagraphs(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((para) => para.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** Satzende, gefolgt von Weissraum oder Zeilenende. */
const SENTENCE_END = /[.!?…]["'»«”’)\]]?(?=\s|$)/g;

/**
 * Untergrenzen, damit das Kuerzen nicht zu viel wegwirft.
 * Eine Satzgrenze ist die deutlich bessere Trennstelle, deshalb darf sie
 * weiter vorn liegen als eine blosse Wortgrenze.
 */
const SENTENCE_FLOOR = 0.3;
const WORD_FLOOR = 0.5;

/**
 * Kuerzt Text auf `max` Zeichen und bricht dabei moeglichst an einer
 * Satzgrenze ab. Wenn im hinteren Teil keine Satzgrenze liegt, wird an
 * einer Wortgrenze getrennt; erst zuletzt hart.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {{text: string, truncated: boolean, originalLength: number}}
 */
export function truncateAtSentence(value, max = LIMITS.BODY_MAX) {
  const text = typeof value === 'string' ? value : '';
  const originalLength = text.length;

  if (max <= 0) return { text: '', truncated: originalLength > 0, originalLength };
  if (originalLength <= max) return { text, truncated: false, originalLength };

  const window = sliceUnits(text, max);

  // Letzte Satzgrenze im erlaubten Fenster suchen.
  let cut = -1;
  SENTENCE_END.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END.exec(window)) !== null) {
    cut = match.index + match[0].length;
  }

  if (cut >= Math.floor(max * SENTENCE_FLOOR)) {
    return { text: window.slice(0, cut).trimEnd(), truncated: true, originalLength };
  }

  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= Math.floor(max * WORD_FLOOR)) {
    return { text: window.slice(0, lastSpace).trimEnd(), truncated: true, originalLength };
  }

  return { text: window.trimEnd(), truncated: true, originalLength };
}

/**
 * Kuerzt eine einzeilige Angabe hart (Titel duerfen 300 Zeichen haben).
 * @param {unknown} value
 * @param {number} [max]
 */
export function clampLine(value, max = LIMITS.TITLE_MAX) {
  const text = collapseWhitespace(value);
  if (text.length <= max) return text;
  return sliceUnits(text, max).trimEnd();
}

/**
 * Schneidet nach hoechstens `max` UTF-16-Einheiten — aber nie mitten in ein
 * Surrogatpaar (Emoji, seltene Schriftzeichen). Endete der Schnitt auf einer
 * High-Surrogate, faellt sie mit weg; die Laenge bleibt so immer <= `max`.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function sliceUnits(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * DOI aus beliebigem Text ziehen.
 * Praefix (`doi:`, `https://doi.org/`) wird entfernt, Satzzeichen am Ende
 * abgeschnitten — die gehoeren fast nie zum DOI.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function extractDoi(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = value.match(/\b10\.\d{4,9}\/[^\s"'<>]+/);
  if (!match) return null;
  let doi = match[0];
  // Haeufige Anhaengsel aus HTML/Prosa entfernen.
  doi = doi.replace(/[.,;:]+$/, '');
  while (/[)\]}>]$/.test(doi)) {
    const open = doi.slice(-1) === ')' ? '(' : doi.slice(-1) === ']' ? '[' : doi.slice(-1) === '}' ? '{' : '<';
    const close = doi.slice(-1);
    const opens = (doi.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const closes = (doi.match(new RegExp(`\\${close}`, 'g')) || []).length;
    if (closes > opens) doi = doi.slice(0, -1).replace(/[.,;:]+$/, '');
    else break;
  }
  return doi || null;
}

/**
 * ISBN aus Text ziehen und normalisieren (ohne Bindestriche).
 *
 * Nur Kandidaten mit gueltiger Pruefziffer zaehlen — sonst ist jede
 * zehnstellige Zahl eine ISBN: Zeitstempel, Artikel-IDs, Telefonnummern.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {boolean} [options.requireLabel] nur Treffer mit vorangestelltem „ISBN" —
 *   fuer Fliesstext, wo eine nackte Ziffernfolge fast nie eine ISBN ist
 * @returns {string|null}
 */
export function extractIsbn(value, options = {}) {
  if (typeof value !== 'string' || !value) return null;
  const pattern = /\b(ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dXx])\b/gi;
  for (const match of value.matchAll(pattern)) {
    if (options.requireLabel && !match[1]) continue;
    const digits = match[2].replace(/[-\s]/g, '').toUpperCase();
    if (isValidIsbn(digits)) return digits;
  }
  return null;
}

/**
 * @param {string} digits ohne Trenner
 * @returns {boolean}
 */
export function isValidIsbn(digits) {
  if (/^\d{9}[\dX]$/.test(digits)) {
    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      const digit = digits[i] === 'X' ? 10 : Number(digits[i]);
      sum += digit * (10 - i);
    }
    return sum % 11 === 0;
  }
  if (/^97[89]\d{10}$/.test(digits)) {
    let sum = 0;
    for (let i = 0; i < 13; i += 1) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
  }
  return false;
}

/**
 * Vierstellige Jahreszahl aus einem Datum oder Datumsfragment.
 * Akzeptiert "2019", "2019-04-01", "01.04.2019", "April 2019", ISO-Zeitstempel.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function yearFromDate(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 1000 && value <= 2999 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // Kein `\b` am Ende: bei "2024-06-11T05:30:00" folgt ein Wortzeichen.
  const iso = text.match(/\b((?:1[0-9]|2[0-9])\d{2})-\d{2}(?:-\d{2})?(?!\d)/);
  if (iso) return Number(iso[1]);

  const matches = text.match(/\b(1[0-9]{3}|2[0-9]{3})\b/g);
  if (!matches || !matches.length) return null;

  // Bei mehreren Kandidaten die erste plausible nehmen.
  const year = Number(matches[0]);
  return year >= 1000 && year <= 2999 ? year : null;
}

/**
 * Datum als `YYYY-MM-DD` in lokaler Zeit (nicht UTC — `accessed_at` ist
 * ein Kalendertag aus Nutzersicht, kein Zeitpunkt).
 *
 * @param {Date} [date]
 * @returns {string}
 */
export function isoDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Normalisiert ein gefundenes Publikationsdatum auf `YYYY-MM-DD`,
 * wenn Tag und Monat bekannt sind, sonst auf `YYYY`.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // Kein `\b` am Ende: ISO-Zeitstempel haengen ein "T…" an den Tag an.
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) return calendarDate(iso[1], iso[2], iso[3]);

  const german = text.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (german) return calendarDate(german[3], german[2], german[1]);

  const slashed = text.match(/\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/);
  if (slashed) return calendarDate(slashed[1], slashed[2], slashed[3]);

  const year = yearFromDate(text);
  return year ? String(year) : null;
}

/**
 * `YYYY-MM-DD`, wenn es den Tag im Kalender gibt, sonst null. Ein Datum, das
 * nach Datum aussieht, aber keins ist („2024-13-45", „31.02.2024"), ist
 * kaputt — dann lieber gar keins als ein geratenes Jahr.
 *
 * @param {string} year
 * @param {string} month
 * @param {string} day
 * @returns {string|null}
 */
function calendarDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > days) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(m)}-${pad(d)}`;
}
