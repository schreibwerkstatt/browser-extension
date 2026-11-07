/**
 * Text eines DOM-Knotens ohne das, was kein Inhalt ist.
 *
 * `textContent` liest auch Skripte, Stylesheets und `<noscript>`-Fallbacks
 * mit — dort stehen DOIs und ISBNs aus Tracking-Konfigurationen, Literatur-
 * Widgets und JSON-Bloecken, die mit der Seite nichts zu tun haben. Reine
 * Funktion ueber einem Element, kein `chrome`, kein `window`.
 */

/** Was nie zum lesbaren Inhalt gehoert. */
export const NON_CONTENT_SELECTOR = 'script, style, noscript, template, nav';

/** Zusaetzlich zum Seitengeruest — fuer die Suche nach dem Haupttext. */
export const CHROME_SELECTOR = `${NON_CONTENT_SELECTOR}, header, footer, aside, form, iframe`;

/**
 * Arbeitet auf einer Kopie; das Seiten-DOM bleibt unberuehrt.
 *
 * @param {Node|null|undefined} node
 * @param {string} [selector] was vorher entfernt wird
 * @returns {string}
 */
export function textWithout(node, selector = NON_CONTENT_SELECTOR) {
  if (!node) return '';
  const clone = /** @type {Element} */ (node.cloneNode(true));
  for (const junk of clone.querySelectorAll(selector)) junk.remove();
  return clone.textContent || '';
}
