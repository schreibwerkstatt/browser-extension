/**
 * Was an einem Auftrag UNVOLLSTAENDIG geblieben ist.
 *
 * Ein Auftrag kann beim Server ankommen und trotzdem weniger mitbringen, als
 * der Nutzer abgeschickt hat: der Anhang liegt nur im Arbeitsspeicher und
 * ueberlebt den Neustart des Service Workers nicht, und ein schon vergebener
 * Zitierschluessel wird vertragsgemaess ohne ihn erneut gesendet. Beides ist
 * kein Fehler — der Auftrag gilt als erfolgreich und verlaesst die Queue.
 *
 * Genau darin liegt die Falle: mit dem Auftrag verschwindet auch die Notiz,
 * dass etwas fehlt. Ohne dieses Modul quittiert die Erweiterung „gespeichert"
 * ueber einen Screenshot, der nie ankam, und ueber einen Zitierschluessel, den
 * niemand gewaehlt hat — dieselbe stille Unwahrheit, die bei den Textlimits
 * mit `clamp*Payload` eigens vermieden wird (CLAUDE.md, „Kein stilles
 * Verwerfen").
 *
 * Frei von `chrome`-APIs: die Regel gehoert an EINEN Ort, weil sie an DREI
 * Stellen gebraucht wird — Popup-Quittung, Erfolgs-Benachrichtigung und
 * Warteschlange in den Optionen.
 */

/**
 * @typedef {{ key: string, substitutions: string[] }} IncompleteNotice
 */

/**
 * Hat dieser Auftrag seine Anhaenge verloren?
 *
 * `declared` sagt, was das Popup mitgeschickt HAT; `hasCache`, ob die Bytes
 * jetzt noch da sind. Fehlen sie und ist der Upload noch nicht erfolgt, gehen
 * sie verloren — der Auftrag selbst wird trotzdem gesendet, denn Text und
 * Metadaten sind vollstaendig persistiert.
 *
 * Ein bereits hochgeladener Anhang ist kein Verlust: dann hat ein frueherer
 * Versuch ihn schon abgeliefert und nur der Rest scheiterte.
 *
 * @param {{screenshot?: boolean, pdf?: boolean}} [declared]
 * @param {{imageUploaded?: boolean, pdfUploaded?: boolean}} [progress]
 * @param {boolean} [hasCache] liegen die Bytes noch im Arbeitsspeicher?
 * @returns {boolean}
 */
export function attachmentsAreLost(declared = {}, progress = {}, hasCache = false) {
  if (hasCache) return false;
  return !!(
    (declared.screenshot && !progress.imageUploaded) ||
    (declared.pdf && !progress.pdfUploaded)
  );
}

/**
 * Alles, was an diesem Auftrag nicht so gesendet wurde, wie es gemeint war —
 * als i18n-Schluessel mit Platzhaltern, damit das Uebersetzen beim Aufrufer
 * bleibt (dieselbe Trennung wie in `shared/errors.js`).
 *
 * Leeres Ergebnis heisst: der Auftrag ging vollstaendig hinaus.
 *
 * @param {import('./config.js').CaptureProgress|Record<string, any>} [progress]
 * @returns {IncompleteNotice[]}
 */
export function incompleteNotices(progress = {}) {
  /** @type {IncompleteNotice[]} */
  const notices = [];

  if (progress.attachmentsLost) {
    notices.push({ key: 'notice_attachment_lost', substitutions: [] });
  }

  const citekey = typeof progress.citekeyDropped === 'string' ? progress.citekeyDropped.trim() : '';
  if (citekey) {
    notices.push({ key: 'notice_citekey_dropped', substitutions: [citekey] });
  }

  // Wortlauttreue nicht gewaehrleistet: Chrome hat die Markierung geliefert,
  // nicht die Seite (iframe oder gesperrte Seite). Gespeichert ist sie, aber
  // Zeilenumbrueche und mehrfacher Leerraum fehlen.
  if (progress.quoteApproximate) {
    notices.push({ key: 'notice_quote_approximate', substitutions: [] });
  }

  return notices;
}

/**
 * Dieselbe Auskunft als fertiger Satz. Leerer String heisst „nichts zu melden";
 * der Aufrufer haengt ihn dann einfach nicht an.
 *
 * @param {import('./config.js').CaptureProgress|Record<string, any>} [progress]
 * @param {(key: string, substitutions?: string[]) => string} [translate]
 * @returns {string}
 */
export function incompleteText(progress = {}, translate = (key) => key) {
  return incompleteNotices(progress)
    .map((notice) => translate(notice.key, notice.substitutions))
    .join(' ');
}
