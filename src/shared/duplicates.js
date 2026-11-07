/**
 * Dublettenpruefung gegen `GET /research`.
 *
 * Frei von `chrome`-APIs und deshalb direkt testbar. Der Service Worker holt
 * die Liste, dieses Modul entscheidet, was sie aussagt.
 *
 * Zwei Dinge, die hier bewusst so sind:
 *
 *  1. Verglichen wird die URL, nicht ein Textbegriff. Ein `q=`-Treffer sagt
 *     „irgendwo steht dieses Wort"; verlangt ist aber „diese Seite ist schon
 *     drin". Verglichen wird gegen `urls[].url` (und `source`) der Antwort,
 *     beide Seiten durch `serverNormalizeUrl` — sonst behauptet der Client
 *     einen Unterschied, den der Server nicht sieht.
 *
 *  2. Ein leeres Ergebnis ist nicht dasselbe wie „nicht vorhanden". Der
 *     Lesepfad liefert hoechstens `limit` Zeilen, und mit `q` schneidet der
 *     FTS5-Vorfilter schon bei 500 Zeilen ab. Wo das greifen KANN, meldet
 *     dieses Modul `complete: false`; die Oberflaeche muss das anzeigen,
 *     statt Entwarnung zu geben.
 */

import { RESEARCH_LIST, clampResearchLimit } from './limits.js';
import { serverNormalizeUrl } from './url.js';

/**
 * @typedef {object} ResearchListItem
 * @property {number} id
 * @property {string} kind
 * @property {string|null} title
 * @property {string|null} source
 * @property {string} body_snippet
 * @property {Array<{url: string, label: string}>} urls
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * @typedef {object} DuplicateReport
 * @property {boolean} found
 * @property {ResearchListItem[]} matches
 * @property {boolean} complete Darf „nicht vorhanden" behauptet werden?
 * @property {'limit'|'fts'|null} truncatedBy
 * @property {number} scanned Wie viele Eintraege wirklich geprueft wurden
 */

/**
 * Alle URLs eines Eintrags — `source` traegt die Herkunft als String,
 * `urls[]` die benannten Verweise.
 *
 * @param {ResearchListItem} item
 * @returns {string[]}
 */
export function itemUrls(item) {
  /** @type {string[]} */
  const out = [];
  if (item && typeof item.source === 'string' && item.source.trim()) out.push(item.source);
  for (const entry of (item && item.urls) || []) {
    if (entry && typeof entry.url === 'string' && entry.url.trim()) out.push(entry.url);
  }
  return out;
}

/**
 * @param {ResearchListItem[]} items
 * @param {unknown} url
 * @returns {ResearchListItem[]}
 */
export function matchesForUrl(items, url) {
  const wanted = serverNormalizeUrl(url);
  if (!wanted) return [];
  return (Array.isArray(items) ? items : []).filter((item) =>
    itemUrls(item).some((candidate) => serverNormalizeUrl(candidate) === wanted),
  );
}

/**
 * Fasst eine Antwort des Lesepfads zur Aussage „schon erfasst?" zusammen.
 *
 * @param {object} input
 * @param {ResearchListItem[]} input.items Antwort von `GET /research`
 * @param {unknown} input.url zu pruefende Seiten-URL
 * @param {unknown} [input.limit] `limit`, das mitgeschickt wurde
 * @param {boolean} [input.usedQuery] wurde `q` benutzt?
 * @returns {DuplicateReport}
 */
export function summarizeDuplicates({ items, url, limit = null, usedQuery = false }) {
  const list = Array.isArray(items) ? items : [];
  const matches = matchesForUrl(list, url);

  // Ein Treffer ist ein Treffer — der zaehlt auch aus einem abgeschnittenen
  // Ergebnis. Unvollstaendig ist nur die AUSSAGE, dass nichts da ist.
  // Geklemmt wie beim Server: 0, negativ oder Text -> Default, ueber dem
  // Maximum -> Maximum. Sonst haelt ein `limit: 0` jede Liste fuer
  // abgeschnitten und ein `limit: 1000` keine.
  const effectiveLimit = clampResearchLimit(limit) ?? RESEARCH_LIST.LIMIT_DEFAULT;

  /** @type {'limit'|'fts'|null} */
  let truncatedBy = null;
  if (list.length >= effectiveLimit) truncatedBy = 'limit';
  else if (usedQuery && list.length >= RESEARCH_LIST.FTS_PREFILTER_CAP) truncatedBy = 'fts';
  // Mit `q` kann der Vorfilter auch dann geschnitten haben, wenn am Ende
  // weniger Zeilen ankommen: Filter und Sortierung greifen erst danach.
  else if (usedQuery) truncatedBy = 'fts';

  return {
    found: matches.length > 0,
    matches,
    complete: matches.length > 0 || truncatedBy === null,
    truncatedBy: matches.length > 0 ? null : truncatedBy,
    scanned: list.length,
  };
}
