/**
 * Haupttext einer Seite extrahieren.
 *
 * Readability wird lokal mitgeliefert und beim Build eingebunden
 * (`@mozilla/readability`, Apache-2.0). Es wird KEIN Code nachgeladen —
 * das verlangt die Web-Store-Policy und die Spezifikation.
 */

import { Readability, isProbablyReaderable } from '@mozilla/readability';

import { LIMITS } from '../shared/limits.js';
import { tidyParagraphs, truncateAtSentence } from '../shared/text.js';
import { CHROME_SELECTOR, textWithout } from './visible-text.js';

/**
 * @typedef {object} ArticleText
 * @property {string} text gekuerzter Fliesstext
 * @property {boolean} truncated wurde gekuerzt?
 * @property {number} originalLength Zeichenzahl vor dem Kuerzen
 * @property {string} byline von Readability erkannte Autorenzeile
 * @property {string} excerpt Kurzfassung
 * @property {string} siteName
 * @property {boolean} readerable hielt Readability die Seite fuer lesbar?
 */

/**
 * @param {Document} doc
 * @param {number} [max]
 * @returns {ArticleText}
 */
export function extractArticleText(doc, max = LIMITS.BODY_MAX) {
  /** @type {ArticleText} */
  const empty = {
    text: '',
    truncated: false,
    originalLength: 0,
    byline: '',
    excerpt: '',
    siteName: '',
    readerable: false,
  };

  let readerable = false;
  try {
    readerable = isProbablyReaderable(doc);
  } catch {
    readerable = false;
  }

  let parsed = null;
  try {
    // Readability veraendert das uebergebene Dokument — niemals das echte
    // Seiten-DOM hineingeben, sonst zerlegt die Erweiterung die Webseite.
    const clone = /** @type {Document} */ (doc.cloneNode(true));
    parsed = new Readability(clone, { keepClasses: false }).parse();
  } catch {
    parsed = null;
  }

  const raw = tidyParagraphs(parsed && parsed.textContent ? parsed.textContent : fallbackText(doc));
  if (!raw) return { ...empty, readerable };

  const { text, truncated, originalLength } = truncateAtSentence(raw, max);

  return {
    text,
    truncated,
    originalLength,
    byline: (parsed && parsed.byline) || '',
    excerpt: (parsed && parsed.excerpt) || '',
    siteName: (parsed && parsed.siteName) || '',
    readerable,
  };
}

/**
 * Notfallvariante, wenn Readability nichts findet: sichtbarer Text der
 * groessten Textinsel, grob entrumpelt.
 *
 * @param {Document} doc
 * @returns {string}
 */
function fallbackText(doc) {
  const candidates = doc.querySelectorAll('article, main, [role="main"], #content, .content, body');
  let best = '';
  for (const node of candidates) {
    const text = textWithout(node, CHROME_SELECTOR);
    if (text.length > best.length) best = text;
  }
  return best;
}
