/**
 * Personennamen in CSL-Form zerlegen: `{ family, given }`.
 *
 * Leitlinie aus der Spezifikation: im Zweifel NICHT raten.
 * Alles, was nicht sicher in Vor-/Nachname zerfaellt, wird
 * `{ literal: "…" }` — das ist im Literaturverzeichnis reparierbar,
 * ein falsch zerlegter Name faellt dagegen nicht auf.
 */

/**
 * Person im CSL-Sinne: entweder zerlegt (`family`/`given`) oder, wenn sich ein
 * Name nicht sinnvoll zerlegen laesst (Organisationen), als `literal`.
 *
 * @typedef {{family?: string, given?: string, literal?: string}} Person
 */

/** Namenspartikel, die zum Nachnamen gehoeren. */
const PARTICLES = new Set([
  'von', 'vom', 'van', 'ver', 'de', 'del', 'della', 'dello', 'degli', 'dei', 'di', 'da', 'das',
  'dos', 'du', 'des', 'la', 'le', 'les', 'lo', 'zu', 'zum', 'zur', 'ten', 'ter', 'den', 'der',
  'af', 'av', 'bin', 'binte', 'ibn', 'al', 'el', 'op', 'aan', 'st', 'st.',
]);

/** Suffixe: ihre Anwesenheit macht die Zerlegung unsicher. */
const SUFFIXES = new Set([
  'jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v.', 'phd', 'ph.d.', 'ph.d', 'md', 'm.d.',
  'msc', 'm.sc.', 'bsc', 'b.sc.', 'mba', 'llm', 'll.m.', 'esq', 'esq.', 'emeritus',
]);

/** Fuehrende Titel, die vor der Zerlegung wegfallen. */
const TITLES = new Set([
  'dr', 'dr.', 'prof', 'prof.', 'professor', 'pd', 'pd.', 'priv.-doz.', 'dipl.-ing.', 'dipl.',
  'mag', 'mag.', 'sir', 'dame', 'lord', 'rev', 'rev.', 'hon', 'hon.', 'mr', 'mr.', 'mrs', 'mrs.',
  'ms', 'ms.', 'herr', 'frau',
]);

/** Wortteile, die eine Koerperschaft statt einer Person anzeigen. */
const ORGANISATION_HINTS = [
  'inc', 'inc.', 'ltd', 'ltd.', 'llc', 'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'plc', 'corp', 'corp.',
  'university', 'universität', 'universitaet', 'universite', 'université', 'college', 'school',
  'institute', 'institut', 'academy', 'akademie', 'ministry', 'ministerium', 'bundesamt', 'amt',
  'department', 'agency', 'agentur', 'association', 'verband', 'verein', 'e.v.', 'ev.',
  'foundation', 'stiftung', 'council', 'rat', 'committee', 'kommission', 'commission',
  'organization', 'organisation', 'verlag', 'press', 'publishing', 'media', 'gruppe', 'group',
  'redaktion', 'staff', 'editors', 'editorial', 'newsroom', 'team', 'gesellschaft', 'zentrum',
  'center', 'centre', 'laboratory', 'labor', 'observatory', 'survey', 'bureau', 'office',
  'company', 'holding', 'stiftung', 'trust', 'society', 'union', 'network', 'netzwerk',
];

/** Trenner zwischen mehreren Personen in einem String. */
const LIST_SEPARATORS = /\s*(?:;|\||\band\b|\bund\b|&|\bet\b(?!\s+al))\s*/i;

const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();

const stripEtAl = (value) => value.replace(/[,;]?\s*\bet\.?\s*al\.?\s*$/i, '').trim();

const isAllCaps = (token) => {
  const letters = token.replace(/[^\p{L}]/gu, '');
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
};

/**
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeOrganisation(value) {
  // Bindestriche mit aufloesen, damit „Max-Planck-Institut" als Koerperschaft
  // erkannt wird. Das betrifft nur diese Pruefung, nicht die Zerlegung selbst.
  const lower = ` ${value.toLowerCase().replace(/[(),/\-–—]/g, ' ')} `;
  if (ORGANISATION_HINTS.some((hint) => lower.includes(` ${hint} `))) return true;
  // "The Guardian", "Die Zeit" — Artikel am Anfang sind kein Personenname.
  if (/^(the|die|der|das|les|la|le|el|il)\s/i.test(value)) return true;
  return false;
}

/**
 * Zerlegt einen einzelnen Namen.
 *
 * @param {unknown} raw
 * @returns {Person|null}
 */
export function parsePerson(raw) {
  if (raw && typeof raw === 'object') {
    // Bereits strukturiert (z. B. aus JSON-LD `{ "@type": "Person", name: … }`).
    const obj = /** @type {Record<string, any>} */ (raw);
    if (typeof obj.family === 'string' || typeof obj.given === 'string') {
      const family = collapse(obj.family || '');
      const given = collapse(obj.given || '');
      if (!family && !given) return null;
      if (!family) return { literal: given };
      return { family, given };
    }
    if (typeof obj.literal === 'string' && collapse(obj.literal)) {
      return { literal: collapse(obj.literal) };
    }
    // schema.org `Person` ohne `name`, nur mit `givenName`/`familyName`
    // (`additionalName` ist der Zweitname und gehoert zum Vornamen).
    const hasName = typeof obj.name === 'string' && collapse(obj.name);
    if (!hasName) {
      const familyName = schemaText(obj.familyName);
      const givenName = [schemaText(obj.givenName), schemaText(obj.additionalName)].filter(Boolean).join(' ');
      if (familyName || givenName) return parsePerson({ family: familyName, given: givenName });
    }
    // Ein `@id` ist ein Verweis, kein Name — ausser er sieht nach einem aus.
    const id = typeof obj['@id'] === 'string' && !/[#/:]/.test(obj['@id']) ? obj['@id'] : '';
    const name = obj.name ?? id;
    return parsePerson(typeof name === 'string' ? name : '');
  }

  if (typeof raw !== 'string') return null;

  let value = stripEtAl(collapse(raw));
  if (!value) return null;

  // Klammerzusaetze ("Max Muster (Redaktion)") stoeren die Zerlegung.
  value = collapse(value.replace(/\s*\([^)]*\)\s*/g, ' '));
  if (!value) return null;

  if (looksLikeOrganisation(value)) return { literal: value };

  // E-Mail-Adressen und URLs sind keine Namen.
  if (/@|https?:\/\//i.test(value)) return { literal: value };

  const commaCount = (value.match(/,/g) || []).length;

  if (commaCount === 1) {
    const [left, right] = value.split(',').map(collapse);
    if (!left || !right) return { literal: value.replace(/,/g, '').trim() || value };
    // "Muster, Max" — aber "Muster, Jr." ist ein Suffix, kein Vorname.
    if (right.split(' ').some((token) => SUFFIXES.has(token.toLowerCase()))) {
      return { literal: value };
    }
    const given = stripTitles(right.split(' ')).join(' ');
    if (!given) return { literal: value };
    return { family: left, given };
  }

  if (commaCount > 1) return { literal: value };

  let tokens = stripTitles(value.split(' '));
  if (tokens.length === 0) return { literal: value };
  if (tokens.length === 1) return { literal: tokens[0] };

  if (tokens.some((token) => SUFFIXES.has(token.toLowerCase()))) return { literal: value };

  // Verlagskonvention "MUSTER Max": der durchgaengig grossgeschriebene
  // Block ist der Nachname.
  const capsFlags = tokens.map(isAllCaps);
  const capsCount = capsFlags.filter(Boolean).length;
  if (capsCount > 0 && capsCount < tokens.length) {
    if (capsFlags[0]) {
      let end = 0;
      while (end + 1 < tokens.length && capsFlags[end + 1]) end += 1;
      const family = tokens.slice(0, end + 1).join(' ');
      const given = tokens.slice(end + 1).join(' ');
      if (family && given) return { family, given };
    }
    if (capsFlags[capsFlags.length - 1]) {
      let start = tokens.length - 1;
      while (start - 1 >= 0 && capsFlags[start - 1]) start -= 1;
      const family = tokens.slice(start).join(' ');
      const given = tokens.slice(0, start).join(' ');
      if (family && given) return { family, given };
    }
  }

  // Partikel: alles ab dem ersten Partikel gehoert zum Nachnamen
  // ("Jan van der Meer" -> family "van der Meer").
  for (let i = 1; i < tokens.length - 1; i += 1) {
    if (PARTICLES.has(tokens[i].toLowerCase())) {
      return { family: tokens.slice(i).join(' '), given: tokens.slice(0, i).join(' ') };
    }
  }

  // Regelfall "Vorname Nachname" / "J. R. R. Tolkien".
  const family = tokens[tokens.length - 1];
  const given = tokens.slice(0, -1).join(' ');
  if (!family || !given) return { literal: value };
  return { family, given };
}

/**
 * Textwert eines schema.org-Feldes, das auch eine Liste sein darf.
 * @param {unknown} value
 * @returns {string}
 */
function schemaText(value) {
  const entry = Array.isArray(value) ? value[0] : value;
  return typeof entry === 'string' ? collapse(entry) : '';
}

/**
 * @param {string[]} tokens
 * @returns {string[]}
 */
function stripTitles(tokens) {
  const out = [...tokens];
  while (out.length > 1 && TITLES.has(out[0].toLowerCase())) out.shift();
  return out.filter(Boolean);
}

/**
 * Zerlegt eine Autorenangabe, die eine oder mehrere Personen enthaelt.
 *
 * Akzeptiert einen String ("Muster, Max; Beispiel, Eva"), ein Array von
 * Strings oder ein Array von Objekten (JSON-LD).
 *
 * @param {unknown} input
 * @returns {Person[]}
 */
export function parsePeople(input) {
  if (input === null || input === undefined) return [];

  if (Array.isArray(input)) {
    return dedupe(input.flatMap((entry) => parsePeople(entry)));
  }

  if (typeof input === 'object') {
    const person = parsePerson(input);
    return person ? [person] : [];
  }

  if (typeof input !== 'string') return [];

  const value = collapse(input);
  if (!value) return [];

  const hasExplicitSeparator = LIST_SEPARATORS.test(value);

  if (hasExplicitSeparator) {
    const parts = value.split(LIST_SEPARATORS).map(collapse).filter(Boolean);
    return dedupe(parts.flatMap((part) => parsePeople(part)));
  }

  // Kommagetrennte Liste ohne weiteren Trenner ist mehrdeutig:
  // "Muster, Max" (eine Person) vs. "Max Muster, Eva Beispiel" (zwei).
  // Heuristik: bei genau einem Komma nehmen wir eine Person an, bei
  // mehreren Kommas eine Liste — es sei denn, die Teile sehen nach
  // "Nachname, Vorname"-Paaren aus.
  const commaParts = value.split(',').map(collapse).filter(Boolean);
  if (commaParts.length > 2) {
    if (commaParts.length % 2 === 0 && looksLikePairs(commaParts)) {
      /** @type {Array<any>} */
      const people = [];
      for (let i = 0; i < commaParts.length; i += 2) {
        const person = parsePerson(`${commaParts[i]}, ${commaParts[i + 1]}`);
        if (person) people.push(person);
      }
      return dedupe(people);
    }
    return dedupe(commaParts.flatMap((part) => parsePeople(part)));
  }

  // Genau ein Komma: „Muster, Max" ist eine Person, „Anna Bertram, Carl
  // Dorn" sind zwei. Getrennt wird nur, wenn BEIDE Seiten wie ein ganzer
  // Name aussehen — mindestens zwei Woerter, kein Partikel, kein Suffix.
  // „von Goethe, Johann Wolfgang" bleibt deshalb eine Person.
  if (commaParts.length === 2 && commaParts.every(looksLikeFullName)) {
    return dedupe(commaParts.flatMap((part) => parsePeople(part)));
  }

  const person = parsePerson(value);
  return person ? [person] : [];
}

/**
 * Sieht der Teil wie „Vorname Nachname" aus, nicht wie ein halber Name?
 * @param {string} part
 */
function looksLikeFullName(part) {
  const tokens = stripTitles(part.split(' '));
  if (tokens.length < 2) return false;
  return !tokens.some((token) => {
    const lower = token.toLowerCase();
    return PARTICLES.has(lower) || SUFFIXES.has(lower);
  });
}

/**
 * "Muster, Max, Beispiel, Eva" — jeder zweite Teil ist ein Vorname
 * (ein Wort oder Initialen), jeder erste ein Nachname.
 * @param {string[]} parts
 */
function looksLikePairs(parts) {
  for (let i = 1; i < parts.length; i += 2) {
    const tokens = parts[i].split(' ');
    if (tokens.length > 3) return false;
    if (tokens.some((token) => SUFFIXES.has(token.toLowerCase()))) return false;
  }
  return true;
}

/**
 * @param {Person[]} people
 */
function dedupe(people) {
  const seen = new Set();
  /** @type {typeof people} */
  const out = [];
  for (const person of people) {
    if (!person) continue;
    const key = formatPerson(person).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  return out;
}

/**
 * Anzeigeform, auch fuer die Rueckkonvertierung ins Popup-Textfeld.
 * @param {Person} person
 * @returns {string}
 */
export function formatPerson(person) {
  if (!person) return '';
  if (person.literal) return person.literal;
  if (person.family && person.given) return `${person.family}, ${person.given}`;
  return person.family || person.given || '';
}

/**
 * @param {Person[]} people
 * @returns {string} "Muster, Max; Beispiel, Eva"
 */
export function formatPeople(people) {
  if (!Array.isArray(people)) return '';
  return people.map(formatPerson).filter(Boolean).join('; ');
}
