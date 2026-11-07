/**
 * Metadaten-Ernte („graben").
 *
 * Reine Funktion ueber einem `Document` — kein `window`, kein `chrome`,
 * damit sie in Node gegen HTML-Fixtures getestet werden kann.
 *
 * Prioritaetsreihenfolge (hoechste zuerst):
 *   0. Seitenrezept (derzeit MediaWiki, siehe `mediawiki.js`) — nur fuer
 *      Seiten, deren Struktur bekannt ist und deren Metadaten nachweislich
 *      in die Irre fuehren
 *   1. Highwire / `citation_*`
 *   2. JSON-LD (schema.org Article & Verwandte)
 *   3. Dublin Core
 *   4. OpenGraph / `article:*`
 *   5. Fallback: <title>, rel=canonical, erstes <h1>
 *
 * Titel aus OpenGraph und `<title>` verlieren einen angehaengten Site-Namen
 * (`title-affix.js`), sofern er sich belegen laesst.
 *
 * Jedes Feld merkt sich in `provenance`, aus welcher Schicht es stammt.
 * Das Popup zeigt das an, damit sichtbar ist, was belegt und was geraten ist.
 */

import { formatPerson, parsePeople } from '../shared/people.js';
import {
  clampLine,
  collapseWhitespace,
  extractDoi,
  extractIsbn,
  isoDate,
  normalizeDate,
  yearFromDate,
} from '../shared/text.js';
import { normalizeUrl, resolveUrl, sameServerResource } from '../shared/url.js';
import { harvestBylineDate, harvestBylineNames } from './byline.js';
import { harvestMediaWiki } from './mediawiki.js';
import { hostNameCandidates, splitTitleAffix, stripTitleAffix } from './title-affix.js';
import { textWithout } from './visible-text.js';

/** Reihenfolge der Schichten; frueher = staerker. */
export const LAYERS = Object.freeze(['site', 'citation', 'jsonld', 'dublincore', 'opengraph', 'fallback']);

const ARTICLE_TYPES = new Set([
  'article',
  'newsarticle',
  'scholarlyarticle',
  'blogposting',
  'techarticle',
  'report',
  'reportagenewsarticle',
  'liveblogposting',
  'medicalscholarlyarticle',
  'socialmediaposting',
]);

const OTHER_CREATIVE_TYPES = new Set(['book', 'chapter', 'thesis', 'dataset', 'movie', 'webpage']);

/**
 * Baut einen Index ueber alle <meta>-Elemente.
 * Schluessel sind kleingeschrieben; `name`, `property` und `itemprop`
 * landen im selben Topf, weil Seiten das munter mischen.
 *
 * @param {Document} doc
 * @returns {Map<string, string[]>}
 */
function indexMetaTags(doc) {
  /** @type {Map<string, string[]>} */
  const index = new Map();
  const add = (key, value) => {
    if (!key || !value) return;
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = String(value).trim();
    if (!normalizedKey || !normalizedValue) return;
    const bucket = index.get(normalizedKey);
    if (bucket) bucket.push(normalizedValue);
    else index.set(normalizedKey, [normalizedValue]);
  };

  for (const meta of doc.querySelectorAll('meta')) {
    const content = meta.getAttribute('content');
    if (!content) continue;
    add(meta.getAttribute('name'), content);
    add(meta.getAttribute('property'), content);
    add(meta.getAttribute('itemprop'), content);
  }
  return index;
}

/**
 * @param {Map<string, string[]>} index
 * @param {string[]} keys
 * @returns {string|null} erster Treffer
 */
function first(index, keys) {
  for (const key of keys) {
    const values = index.get(key.toLowerCase());
    if (values && values.length && values[0]) return values[0];
  }
  return null;
}

/**
 * @param {Map<string, string[]>} index
 * @param {string[]} keys
 * @returns {string[]} alle Treffer aller Schluessel
 */
function all(index, keys) {
  /** @type {string[]} */
  const out = [];
  for (const key of keys) {
    const values = index.get(key.toLowerCase());
    if (values) out.push(...values);
  }
  return out;
}

/**
 * Knoten, die nicht auf oberster Ebene (bzw. im `@graph`) stehen, sondern
 * ueber `mainEntity`, `hasPart`, `itemListElement` oder `mainEntityOfPage`
 * erreicht wurden. Eine Liste verwandter Artikel steckt dort — der Artikel
 * der Seite selbst steht fast immer oben.
 *
 * @type {WeakSet<object>}
 */
const NESTED_NODES = new WeakSet();

/**
 * Sammelt alle JSON-LD-Knoten, inklusive `@graph` und verschachtelter Arrays.
 * @param {Document} doc
 * @returns {Record<string, any>[]}
 */
export function collectJsonLdNodes(doc) {
  /** @type {Record<string, any>[]} */
  const nodes = [];

  /**
   * @param {any} value
   * @param {number} [depth]
   * @param {boolean} [nested] ueber mainEntity/hasPart/… erreicht
   */
  const walk = (value, depth = 0, nested = false) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1, nested);
      return;
    }
    if (typeof value !== 'object') return;
    nodes.push(value);
    if (nested) NESTED_NODES.add(value);
    if (value['@graph']) walk(value['@graph'], depth + 1, nested);
    // Verschachtelte Werke ("mainEntity", "itemListElement") mitnehmen.
    for (const key of ['mainEntity', 'mainEntityOfPage', 'itemListElement', 'hasPart']) {
      if (value[key] && typeof value[key] === 'object') walk(value[key], depth + 1, true);
    }
  };

  const decode = entityDecoder(doc);
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent;
    if (!raw || !raw.trim()) continue;
    try {
      walk(decodeStrings(JSON.parse(raw), decode));
    } catch {
      // Kaputtes JSON-LD ist haeufig. Kein Grund, die Ernte abzubrechen.
    }
  }
  return nodes;
}

/**
 * Manche CMS schreiben HTML-Entities in JSON-LD („AI &ldquo;Workslop&rdquo;"
 * bei hbr.org). In JSON bedeuten sie nichts; im Titel stuenden sie woertlich.
 * Dekodiert wird ueber ein nie eingehaengtes <textarea>: dessen Inhalt ist
 * reiner Text, es wird nichts ausgefuehrt und nichts geladen.
 *
 * @param {Document} doc
 * @returns {(value: string) => string}
 */
function entityDecoder(doc) {
  /** @type {HTMLTextAreaElement|null} */
  let area = null;
  return (value) => {
    if (!/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(value)) return value;
    try {
      area = area || doc.createElement('textarea');
      area.innerHTML = value;
      return area.value;
    } catch {
      return value;
    }
  };
}

/**
 * @param {any} value
 * @param {(value: string) => string} decode
 * @param {number} [depth]
 * @returns {any}
 */
function decodeStrings(value, decode, depth = 0) {
  if (typeof value === 'string') return decode(value);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((entry) => decodeStrings(entry, decode, depth + 1));
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    // Der Fliesstext ist fuer die Ernte ohne Belang und kann riesig sein.
    out[key] = key === 'articleBody' ? entry : decodeStrings(entry, decode, depth + 1);
  }
  return out;
}

/**
 * @param {Record<string, any>} node
 * @returns {string[]} @type als Liste kleingeschriebener Strings
 */
function typesOf(node) {
  const raw = node['@type'] ?? node.type;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .filter((t) => typeof t === 'string')
    .map((t) => t.replace(/^https?:\/\/schema\.org\//i, '').toLowerCase());
}

/**
 * Waehlt den JSON-LD-Knoten, der die Seite selbst beschreibt.
 *
 * Artikel-Knoten auf oberster Ebene schlagen verschachtelte (verwandte
 * Artikel in `hasPart`/`itemListElement`); innerhalb derselben Ebene gewinnt
 * der, dessen `url` oder `mainEntityOfPage` auf die Seite zeigt, sonst der
 * erste. Andere Werktypen (Buch, Datensatz, …) nur, wenn kein Artikel da ist.
 *
 * @param {Record<string, any>[]} nodes
 * @param {string} [pageUrl] Adresse der Seite, fuer den Abgleich
 * @returns {Record<string, any>|null}
 */
export function pickJsonLdArticle(nodes, pageUrl = '') {
  /** @type {Record<string, any>|null} */
  let best = null;
  let bestScore = -1;
  let fallbackNode = null;
  for (const node of nodes) {
    const types = typesOf(node);
    if (types.some((type) => ARTICLE_TYPES.has(type))) {
      const score = (NESTED_NODES.has(node) ? 0 : 2) + (pageUrl && describesPage(node, pageUrl) ? 1 : 0);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
      continue;
    }
    if (!fallbackNode && types.some((type) => OTHER_CREATIVE_TYPES.has(type))) fallbackNode = node;
  }
  return best || fallbackNode;
}

/**
 * Zeigt `url` oder `mainEntityOfPage` des Knotens auf diese Seite?
 * Verglichen nach Server-Regeln (`sameServerResource`), wie jeder Vergleich
 * zweier Adressen.
 *
 * @param {Record<string, any>} node
 * @param {string} pageUrl
 */
function describesPage(node, pageUrl) {
  /** @type {string[]} */
  const candidates = [];
  /** @param {any} value */
  const collect = (value) => {
    if (typeof value === 'string') candidates.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (typeof value['@id'] === 'string') candidates.push(value['@id']);
      if (typeof value.url === 'string') candidates.push(value.url);
    }
  };
  collect(node.url);
  collect(node.mainEntityOfPage);
  return candidates.some((candidate) => sameServerResource(resolveUrl(candidate, pageUrl), pageUrl));
}

/**
 * Knoten, die eine Seite beschreiben, nicht das Werk, zu dem sie gehoert.
 * `product` ist Googles Paywall-Markup (`isPartOf` mit `productID
 * "economist.com:showcase"`): das Abo, nicht die Publikation.
 */
const PAGE_TYPES = new Set(['webpage', 'collectionpage', 'itempage', 'profilepage', 'searchresultspage', 'product']);

/**
 * Index `@id` -> Knoten. Yoast (WordPress) und HubSpot legen Autor, Verlag
 * und Website als eigene Knoten in den `@graph` und verweisen nur per `@id`.
 * Ohne Aufloesung landet die Adresse des Verweises als Name im Formular.
 *
 * @param {Record<string, any>[]} nodes
 * @returns {Map<string, Record<string, any>>}
 */
function indexJsonLdIds(nodes) {
  /** @type {Map<string, Record<string, any>>} */
  const byId = new Map();
  for (const node of nodes) {
    const id = node['@id'];
    if (typeof id !== 'string' || byId.has(id)) continue;
    // Ein blosser Verweis ({"@id": …}) ist kein Knoten mit Inhalt.
    if (Object.keys(node).some((key) => key !== '@id' && key !== '@type')) byId.set(id, node);
  }
  return byId;
}

/**
 * Ersetzt Verweise durch die Knoten, auf die sie zeigen. Unaufloesbare
 * Verweise bleiben stehen; `schemaName` und `parsePeople` ignorieren sie.
 *
 * @param {any} value
 * @param {Map<string, Record<string, any>>} byId
 * @returns {any}
 */
function deref(value, byId) {
  if (Array.isArray(value)) return value.map((entry) => deref(entry, byId));
  if (value && typeof value === 'object' && typeof value['@id'] === 'string' && !value.name) {
    return byId.get(value['@id']) || value;
  }
  return value;
}

/**
 * Zieht einen Namen aus schema.org-Werten, die String, Objekt oder Array sein duerfen.
 * @param {any} value
 * @returns {string}
 */
function schemaName(value) {
  if (!value) return '';
  if (typeof value === 'string') return collapseWhitespace(value);
  if (Array.isArray(value)) return schemaName(value[0]);
  if (typeof value === 'object') return collapseWhitespace(typeof value.name === 'string' ? value.name : '');
  return '';
}

/**
 * Name des Werks, zu dem der Artikel gehoert — aber nicht der Name der
 * eigenen Seite. Yoast setzt `isPartOf` auf den WebPage-Knoten, dessen
 * `name` „Titel - Site" lautet; als Zeitschrift waere das Unsinn.
 *
 * @param {any} value
 * @returns {string}
 */
function containerName(value) {
  const node = Array.isArray(value) ? value[0] : value;
  if (node && typeof node === 'object' && typesOf(node).some((type) => PAGE_TYPES.has(type))) return '';
  return schemaName(node);
}

/**
 * Personen aus Metadaten, ohne das, was dort oft statt eines Namens steht:
 * Profil-URL (`article:author` bei Facebook-Konventionen), Handle
 * (`twitter:creator` = "@redaktion"), E-Mail-Adresse. `parsePeople` behaelt
 * solche Werte bewusst als `literal`, weil es auch Eingaben von Hand zerlegt;
 * beim Ernten sind sie kein Name, sondern Rauschen.
 *
 * Ebenso raus: die Zeitung als ihr eigener Autor („The Economist" bei
 * The Economist) und Platzhalter im Plural wie „Auswärtige Autoren NZZ".
 * Das ist keine Autorschaft, sondern ein Hinweis darauf, dass keine genannt
 * wird — bei der NZZ steht der Name dann in `<meta name="author">`, eine
 * Schicht tiefer. Eine benannte Redaktion („Redaktion Beispiel-Zeitung",
 * „HubSpot Staff") bleibt dagegen stehen: sie ist eine Koerperschaft, die
 * zeichnet.
 *
 * Bleibt nichts uebrig, ist das Ergebnis leer, und die naechste Schicht kommt
 * zum Zug (`Field.set` ignoriert leere Listen).
 *
 * @param {unknown} input
 * @param {string[]} [siteNames] Namen der Website und des Verlags
 */
function harvestPeople(input, siteNames = []) {
  const sites = siteNames.map(foldName).filter(Boolean);
  return parsePeople(input).filter((person) => {
    if (person.literal && NOT_A_NAME.test(person.literal)) return false;
    const name = formatPerson(person);
    if (COLLECTIVE_AUTHOR.test(name)) return false;
    return !sites.includes(foldName(name));
  });
}

/** Platzhalter im Plural, die an der Stelle eines Namens stehen. */
const COLLECTIVE_AUTHOR = /(^|\s)(autoren|autorinnen|contributors|agenturen|mitarbeitende)(\s|$)/i;

/** @param {string} value */
function foldName(value) {
  return String(value || '').toLowerCase().replace(/^(the|die|der|das)\s+/, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

const NOT_A_NAME = /^(?:https?:\/\/|www\.)|^@[\w.]+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/**
 * Kandidatensammlung mit Herkunft.
 */
class Field {
  constructor() {
    /** @type {Map<string, any>} */
    this.byLayer = new Map();
    this.blocked = false;
  }

  /**
   * Das Feld bleibt leer, egal was die Schichten liefern — fuer Angaben, die
   * auf einer bekannten Seite nachweislich falsch sind. Leer ist ehrlicher.
   */
  block() {
    this.blocked = true;
  }

  /**
   * @param {string} layer
   * @param {any} value
   */
  set(layer, value) {
    if (value === null || value === undefined || value === '' ) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (!this.byLayer.has(layer)) this.byLayer.set(layer, value);
  }

  /**
   * @returns {{value: any, layer: string}|null}
   */
  resolve() {
    if (this.blocked) return null;
    for (const layer of LAYERS) {
      if (this.byLayer.has(layer)) return { value: this.byLayer.get(layer), layer };
    }
    return null;
  }
}

/**
 * @typedef {object} HarvestedMeta
 * @property {string} url
 * @property {string} normalizedUrl
 * @property {string} canonicalUrl
 * @property {string} title
 * @property {string} siteName
 * @property {string} containerTitle
 * @property {string} publisher
 * @property {string} place
 * @property {Array<{family?: string, given?: string, literal?: string}>} authors
 * @property {Array<{family?: string, given?: string, literal?: string}>} editors
 * @property {string} publishedDate
 * @property {number|null} year
 * @property {string} doi
 * @property {string} isbn
 * @property {string} pdfUrl
 * @property {string} permalink Adresse genau dieser Fassung (z. B. Wikipedia `oldid=`); leer, wenn unbekannt
 * @property {boolean} pdfSameOrigin
 * @property {string} lang
 * @property {string} accessedAt
 * @property {string} cslType
 * @property {string} description
 * @property {Record<string, string>} provenance
 * @property {string} [bylineHint] Autorenzeile von Readability, wenn die
 *   Meta-Angaben keine Autoren kennen — nur als Hinweis im Popup
 */

/**
 * @param {Document} doc
 * @param {object} [options]
 * @param {string} [options.url] Adresse der Seite (Vorrang vor `doc.baseURI`)
 * @param {Date} [options.now] fuer deterministische Tests
 * @returns {HarvestedMeta}
 */
export function harvestMetadata(doc, options = {}) {
  const baseUrl =
    options.url ||
    (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) ||
    doc.baseURI ||
    '';

  const index = indexMetaTags(doc);
  const jsonLdNodes = collectJsonLdNodes(doc);
  const jsonLdIds = indexJsonLdIds(jsonLdNodes);
  const picked = pickJsonLdArticle(jsonLdNodes, baseUrl) || {};
  /** @type {Record<string, any>} */
  const article = { ...picked };
  for (const key of ['author', 'creator', 'editor', 'publisher', 'isPartOf', 'publication']) {
    if (article[key]) article[key] = deref(article[key], jsonLdIds);
  }
  const website = jsonLdNodes.find((node) => typesOf(node).includes('website'));

  const fields = {
    title: new Field(),
    authors: new Field(),
    editors: new Field(),
    containerTitle: new Field(),
    publisher: new Field(),
    place: new Field(),
    date: new Field(),
    doi: new Field(),
    isbn: new Field(),
    pdfUrl: new Field(),
    siteName: new Field(),
    description: new Field(),
    canonicalUrl: new Field(),
    lang: new Field(),
  };

  let host = '';
  try {
    host = baseUrl ? new URL(baseUrl).hostname.replace(/^www\./i, '') : '';
  } catch {
    host = '';
  }

  const h1 = doc.querySelector('h1');
  const heading = collapseWhitespace(h1 ? h1.textContent || '' : '');
  const siteNames = [
    ...all(index, ['og:site_name', 'application-name']),
    website ? schemaName(website) : '',
    schemaName(article.publisher),
  ].filter(Boolean);
  const titleHints = { heading, siteNames, hostNames: hostNameCandidates(host) };

  // ------------------------------------------------------------ 0. Seitenrezept
  const mediaWiki = harvestMediaWiki(doc, article, baseUrl);
  if (mediaWiki) {
    fields.title.set('site', mediaWiki.title);
    fields.siteName.set('site', mediaWiki.siteName);
    fields.description.set('site', mediaWiki.description);
    // Ohne Versionsdatum lieber kein Datum als das Anlagedatum des Artikels.
    if (mediaWiki.date) fields.date.set('site', mediaWiki.date);
    else fields.date.block();
    // Ein Wiki hat keinen Autor im Sinne der Zitierstile.
    fields.authors.block();
    // DOI und ISBN im Fliesstext gehoeren zur Literaturliste des Artikels,
    // nicht zum Artikel — sonst wird jeder Wikipedia-Eintrag zum Buch.
    fields.doi.block();
    fields.isbn.block();
  }

  // ---------------------------------------------------------------- 1. Highwire
  fields.title.set('citation', clampLine(first(index, ['citation_title'])));
  fields.authors.set('citation', harvestPeople(all(index, ['citation_author', 'citation_authors']), siteNames));
  fields.editors.set('citation', harvestPeople(all(index, ['citation_editor'])));
  fields.containerTitle.set(
    'citation',
    clampLine(
      first(index, [
        'citation_journal_title',
        'citation_conference_title',
        'citation_book_title',
        'citation_inbook_title',
      ]),
    ),
  );
  fields.publisher.set('citation', clampLine(first(index, ['citation_publisher', 'citation_dissertation_institution'])));
  fields.date.set(
    'citation',
    normalizeDate(
      first(index, ['citation_publication_date', 'citation_date', 'citation_online_date', 'citation_year']),
    ),
  );
  fields.doi.set('citation', extractDoi(first(index, ['citation_doi']) || ''));
  fields.isbn.set('citation', extractIsbn(first(index, ['citation_isbn']) || ''));
  fields.pdfUrl.set('citation', resolveUrl(first(index, ['citation_pdf_url', 'citation_fulltext_html_url']), baseUrl));

  // ---------------------------------------------------------------- 2. JSON-LD
  fields.title.set('jsonld', clampLine(completeTitle(collapseWhitespace(article.headline || article.name || ''), heading)));
  fields.authors.set('jsonld', harvestPeople(article.author ?? article.creator ?? null, siteNames));
  fields.editors.set('jsonld', harvestPeople(article.editor ?? null));
  fields.date.set('jsonld', normalizeDate(article.datePublished || article.dateCreated || article.dateModified || ''));
  fields.publisher.set('jsonld', clampLine(schemaName(article.publisher)));
  fields.containerTitle.set('jsonld', clampLine(containerName(article.isPartOf) || containerName(article.publication)));
  fields.siteName.set('jsonld', clampLine(website ? schemaName(website) : ''));
  fields.description.set('jsonld', collapseWhitespace(article.description || ''));
  fields.isbn.set('jsonld', extractIsbn(String(article.isbn || '')));
  fields.doi.set(
    'jsonld',
    extractDoi(String(article.doi || article.identifier?.value || article.identifier || '')),
  );
  fields.canonicalUrl.set(
    'jsonld',
    plausibleCanonical(resolveUrl(typeof article.url === 'string' ? article.url : null, baseUrl), baseUrl),
  );
  fields.lang.set('jsonld', typeof article.inLanguage === 'string' ? article.inLanguage : schemaName(article.inLanguage));

  // ------------------------------------------------------------- 3. Dublin Core
  fields.title.set('dublincore', clampLine(first(index, ['dc.title', 'dcterms.title'])));
  fields.authors.set(
    'dublincore',
    harvestPeople(all(index, ['dc.creator', 'dcterms.creator', 'dc.contributor.author']), siteNames),
  );
  fields.date.set('dublincore', normalizeDate(first(index, ['dc.date', 'dcterms.date', 'dcterms.issued', 'dc.date.issued'])));
  fields.publisher.set('dublincore', clampLine(first(index, ['dc.publisher', 'dcterms.publisher'])));
  fields.containerTitle.set('dublincore', clampLine(first(index, ['dc.source', 'dcterms.ispartof'])));
  fields.description.set('dublincore', collapseWhitespace(first(index, ['dc.description', 'dcterms.abstract']) || ''));
  fields.lang.set('dublincore', first(index, ['dc.language', 'dcterms.language']));
  fields.isbn.set('dublincore', extractIsbn(first(index, ['dc.identifier', 'dcterms.identifier']) || ''));
  fields.doi.set('dublincore', extractDoi(first(index, ['dc.identifier', 'dcterms.identifier']) || ''));

  // -------------------------------------------------------------- 4. OpenGraph
  fields.title.set('opengraph', clampLine(completeTitle(
    stripTitleAffix(first(index, ['og:title', 'twitter:title']) || '', titleHints),
    heading,
  )));
  fields.siteName.set('opengraph', clampLine(first(index, ['og:site_name', 'application-name'])));
  fields.date.set(
    'opengraph',
    normalizeDate(first(index, ['article:published_time', 'article:modified_time', 'og:updated_time', 'date'])),
  );
  fields.authors.set('opengraph', harvestPeople(all(index, ['article:author', 'author', 'twitter:creator']), siteNames));
  fields.description.set('opengraph', collapseWhitespace(first(index, ['og:description', 'description']) || ''));
  fields.canonicalUrl.set('opengraph', plausibleCanonical(resolveUrl(first(index, ['og:url']), baseUrl), baseUrl));

  // ---------------------------------------------------------------- 5. Fallback
  const canonicalLink = doc.querySelector('link[rel~="canonical" i]');
  fields.canonicalUrl.set(
    'fallback',
    plausibleCanonical(resolveUrl(canonicalLink && canonicalLink.getAttribute('href'), baseUrl), baseUrl),
  );

  const documentTitle = collapseWhitespace(doc.title || '');
  const titleSplit = splitTitleAffix(documentTitle, titleHints);
  fields.title.set('fallback', clampLine(titleSplit ? titleSplit.head : documentTitle) || clampLine(heading));

  fields.authors.set('fallback', harvestPeople(harvestBylineNames(doc), siteNames));
  fields.date.set('fallback', normalizeDate(harvestBylineDate(doc)));

  const alternatePdf = doc.querySelector('link[rel~="alternate" i][type="application/pdf"]');
  fields.pdfUrl.set('fallback', resolveUrl(alternatePdf && alternatePdf.getAttribute('href'), baseUrl));

  const htmlLang = doc.documentElement && doc.documentElement.getAttribute('lang');
  fields.lang.set('fallback', htmlLang || '');

  // Was vom <title> abfiel, ist der Name der Website — besser als der Host.
  fields.siteName.set('fallback', clampLine(titleSplit ? titleSplit.site : ''));
  fields.siteName.set('fallback', host);

  // ------------------------------------------------------- DOI aus dem Fliesstext
  // Ausdruecklich gewuenscht: wenn keine Meta-Angabe existiert, im Text suchen.
  // Gelesen wird nur der sichtbare Text: in Skripten, Stylesheets und
  // `<noscript>` stehen DOIs aus Widgets und Konfigurationen, nicht aus der Seite.
  /** @type {string|null} */
  let bodyText = null;
  const visibleBody = () => (bodyText ??= textWithout(doc.body));
  if (!fields.doi.resolve()) {
    const textDoi = extractDoi(visibleBody());
    if (textDoi) fields.doi.set('fallback', textDoi);
  }
  if (!fields.isbn.resolve()) {
    // Im Fliesstext nur mit ausdruecklichem „ISBN" davor.
    const textIsbn = extractIsbn(visibleBody(), { requireLabel: true });
    if (textIsbn) fields.isbn.set('fallback', textIsbn);
  }

  // ------------------------------------------------------------------- Aufloesen
  /** @type {Record<string, string>} */
  const provenance = {};
  /**
   * @template T
   * @param {keyof typeof fields} name
   * @param {T} fallbackValue
   * @returns {T}
   */
  const take = (name, fallbackValue) => {
    const resolved = fields[name].resolve();
    if (!resolved) return fallbackValue;
    provenance[name] = resolved.layer;
    return resolved.value;
  };

  const title = take('title', '');
  const authors = take('authors', []);
  const editors = take('editors', []);
  const containerTitle = take('containerTitle', '');
  const siteName = take('siteName', host);
  const publisher = take('publisher', '');
  const publishedDate = take('date', '');
  const doi = take('doi', '');
  const isbn = take('isbn', '');
  const pdfUrl = take('pdfUrl', '');
  const description = take('description', '');
  const lang = take('lang', '');
  const canonicalUrl = take('canonicalUrl', '');

  const effectiveUrl = canonicalUrl || baseUrl;
  const cslType = guessCslType({ doi, isbn, containerTitle, jsonLdTypes: typesOf(article) });

  let pdfSameOrigin = false;
  if (pdfUrl) {
    try {
      pdfSameOrigin = new URL(pdfUrl).origin === new URL(baseUrl).origin;
    } catch {
      pdfSameOrigin = false;
    }
  }

  return {
    url: baseUrl,
    normalizedUrl: normalizeUrl(effectiveUrl) || normalizeUrl(baseUrl) || baseUrl,
    canonicalUrl,
    title,
    siteName,
    // Bei Zeitschriften ist der Container das Journal, bei Webseiten die Site.
    containerTitle: containerTitle || (cslType === 'website' ? siteName : ''),
    publisher,
    place: '',
    authors,
    editors,
    publishedDate,
    year: yearFromDate(publishedDate),
    doi,
    isbn,
    pdfUrl,
    pdfSameOrigin,
    permalink: mediaWiki ? mediaWiki.permalink : '',
    lang: (lang || '').slice(0, 16),
    accessedAt: isoDate(options.now || new Date()),
    cslType,
    description,
    provenance,
  };
}

/**
 * Eine kanonische Adresse, die offensichtlich nicht diese Seite meint, ist
 * schlimmer als keine: Viele CMS setzen `rel=canonical` oder `og:url`
 * seitenweit auf die Startseite oder eine Rubrik. Verworfen wird
 *
 *  - ein anderer Host (ein `www.` mehr oder weniger zaehlt nicht),
 *  - die Startseite oder ein Pfad, der ein echter Praefix des Seitenpfads ist
 *    („/2024" fuer „/2024/artikel-a") — eine Ebene hoeher ist nie dasselbe
 *    Dokument.
 *
 * Verworfen heisst leer: die naechste Schicht kommt zum Zug, am Ende die
 * Seiten-URL selbst.
 *
 * @param {string|null} candidate bereits aufgeloest
 * @param {string} pageUrl
 * @returns {string|null}
 */
export function plausibleCanonical(candidate, pageUrl) {
  if (!candidate) return null;
  let target;
  let page;
  try {
    target = new URL(candidate);
    page = new URL(pageUrl);
  } catch {
    // Ohne brauchbare Seiten-URL gibt es nichts zu vergleichen.
    return candidate;
  }
  const bareHost = (/** @type {URL} */ url) => url.hostname.toLowerCase().replace(/^www\./, '');
  if (bareHost(target) !== bareHost(page)) return null;

  const segments = (/** @type {URL} */ url) => url.pathname.split('/').filter(Boolean);
  const targetPath = segments(target);
  const pagePath = segments(page);
  if (targetPath.length < pagePath.length && targetPath.every((segment, i) => segment === pagePath[i])) {
    return null;
  }
  return candidate;
}

/**
 * Die Hauptueberschrift ist der Titel, den Leserinnen sehen und zitieren.
 * Metadaten weichen davon auf zwei Arten ab, und in beiden gilt die `<h1>`:
 *
 *  - Die Dachzeile fehlt: `og:title` „Im Gleichschritt der Cowboystiefel"
 *    statt „Breakpoint: Im Gleichschritt der Cowboystiefel" (netzpolitik.org).
 *  - Eine eigene SEO-Fassung nach demselben Stichwort: JSON-LD „Die Geschichte
 *    der Huthi: Von einer Protestbewegung zum globalen Machtfaktor", gedruckt
 *    „Die Geschichte der Huthi: Wie aus einer lokalen Protestbewegung ein
 *    geopolitischer Machtfaktor wurde" (nzz.ch).
 *
 * Sonst bleibt der Metadaten-Titel: eine `<h1>`, die nichts mit ihm teilt,
 * ist oft das Logo oder der Name einer Rubrik.
 *
 * @param {string} title
 * @param {string} heading
 * @returns {string}
 */
function completeTitle(title, heading) {
  if (!title || !heading) return title;
  if (heading.length > Math.max(title.length * 2 + 20, 300)) return title;
  const fold = (/** @type {string} */ value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const foldedHeading = fold(heading);
  const foldedTitle = fold(title);
  if (!foldedTitle || foldedHeading === foldedTitle) return title;

  if (heading.length > title.length && (foldedHeading.endsWith(foldedTitle) || foldedHeading.startsWith(foldedTitle))) {
    return heading;
  }

  // Gleiches Stichwort vor dem Doppelpunkt, mindestens zwei Woerter.
  const kicker = (/** @type {string} */ value) => {
    const index = value.indexOf(':');
    return index > 0 ? fold(value.slice(0, index)) : '';
  };
  const titleKicker = kicker(title);
  if (titleKicker && titleKicker.includes(' ') && titleKicker === kicker(heading)) return heading;
  return title;
}

/**
 * Ratet den CSL-Typ. Bewusst grob — der Nutzer korrigiert im Popup.
 *
 * @param {{doi?: string, isbn?: string, containerTitle?: string, jsonLdTypes?: string[]}} input
 * @returns {string}
 */
export function guessCslType({ doi = '', isbn = '', containerTitle = '', jsonLdTypes = [] } = {}) {
  const types = new Set(jsonLdTypes.map((t) => String(t).toLowerCase()));

  if (types.has('book')) return 'book';
  if (types.has('chapter')) return 'chapter';
  if (types.has('thesis')) return 'thesis';
  if (types.has('dataset')) return 'dataset';
  if (types.has('movie') || types.has('videoobject')) return 'film';
  if (types.has('report')) return 'report';
  if (types.has('scholarlyarticle') || types.has('medicalscholarlyarticle')) return 'article';

  if (isbn) return 'book';
  if (doi || containerTitle) return 'article';
  return 'website';
}
