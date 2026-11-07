/**
 * Popup: vorausgefuelltes Formular fuer die Erfassung.
 *
 * Das Popup ruft selbst nichts im Netz auf. Es erntet ueber den Service
 * Worker (der injiziert das Content-Script) und schickt den fertigen
 * Auftrag ebenfalls an den Worker.
 */

import { canWriteToBook, TOKEN_STATE } from '../shared/config.js';
import { describeError } from '../shared/errors.js';
import { intentFromHarvest, mergeLookup } from '../shared/intent.js';
import {
  CSL_TYPES,
  LIMITS,
  RESEARCH_LIST,
  clampResearchPayload,
  clampSourcePayload,
  validateResearchPayload,
  validateSourcePayload,
} from '../shared/limits.js';
import { MSG } from '../shared/messages.js';
import { createBookOption, el, errorText, showNotice, showUiError } from '../shared/notice.js';
import { incompleteText } from '../shared/outcome.js';
import { formatPeople, parsePeople } from '../shared/people.js';
import { hostLabel, normalizeUrl } from '../shared/url.js';
import { applyI18n, t } from '../ui/chrome-i18n.js';
import { send } from '../ui/messaging.js';

const ui = {
  loading: el('loading'),
  setupNeeded: el('setup-needed'),
  tokenProblem: el('token-problem'),
  tokenProblemText: el('token-problem-text'),
  hostPermission: el('host-permission'),
  fatalProblem: el('fatal-problem'),
  fatalProblemText: el('fatal-problem-text'),
  attachScreenshotRow: el('attach-screenshot-row'),
  form: el('capture-form'),
  queueChip: el('queue-chip'),

  book: el('book'),
  bookHint: el('book-hint'),
  kind: el('kind'),
  tags: el('tags'),
  title: el('title'),
  titleCounter: el('title-counter'),
  body: el('body'),
  bodyCounter: el('body-counter'),
  truncationHint: el('truncation-hint'),
  clampHint: el('clamp-hint'),
  verbatimHint: el('verbatim-hint'),
  duplicateNotice: el('duplicate-notice'),
  duplicateIncomplete: el('duplicate-incomplete'),
  provenanceNotice: el('provenance-notice'),

  sourceFields: el('source-fields'),
  cslType: el('csl-type'),
  year: el('year'),
  authors: el('authors'),
  authorsParsed: el('authors-parsed'),
  containerTitle: el('container-title'),
  publisher: el('publisher'),
  place: el('place'),
  doi: el('doi'),
  isbn: el('isbn'),
  lookup: el('lookup'),
  lookupStatus: el('lookup-status'),
  sourceUrl: el('source-url'),
  accessedAt: el('accessed-at'),
  citekey: el('citekey'),
  note: el('note'),

  attachScreenshot: el('attach-screenshot'),
  attachPdfRow: el('attach-pdf-row'),
  attachPdf: el('attach-pdf'),
  pdfHint: el('pdf-hint'),

  formError: el('form-error'),
  formSuccess: el('form-success'),
  submit: el('submit'),
  cancel: el('cancel'),
};

/** @type {{state: any, harvested: any, tab: any, intent: any}} */
const context = { state: null, harvested: null, tab: null, intent: null };

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

async function init() {
  applyI18n();
  fillCslTypes();
  wireEvents();

  try {
    context.state = await send(MSG.GET_STATE);
  } catch (error) {
    showFatal(error);
    return;
  }

  updateQueueChip(context.state.counts);

  if (!context.state.serverUrl || !context.state.hasToken) {
    ui.loading.hidden = true;
    ui.setupNeeded.hidden = false;
    return;
  }

  // Text und Code kommen aus derselben Map wie jede andere Fehlermeldung —
  // hier stand sonst ein Code, den der Server nie geschickt hat.
  if (context.state.tokenState === TOKEN_STATE.INVALID) {
    showTokenProblem(describeError({ status: 401, code: 'NOT_LOGGED_IN' }, t).text);
  } else if (context.state.tokenState === TOKEN_STATE.SCOPE_MISSING) {
    showTokenProblem(describeError({ status: 403, code: 'DEVICE_SCOPE_FORBIDDEN' }, t).text);
  }
  // Nur ein sicherer Befund (`false`) wird gemeldet; `null` heisst „unbekannt".
  // Erfassen bleibt moeglich — der Auftrag wartet dann in der Warteschlange.
  if (context.state.hostPermission === false) ui.hostPermission.hidden = false;

  fillBooks(context.state.books, context.state.defaultBookId);

  try {
    const result = await send(MSG.HARVEST_ACTIVE_TAB, {
      includeArticleText: context.state.settings.harvestArticleText,
    });
    context.harvested = result.harvested;
    context.tab = result.tab;
  } catch (error) {
    // Auf chrome://-Seiten und im Web Store ist keine Injektion moeglich.
    ui.loading.hidden = true;
    ui.form.hidden = false;
    showError(error);
    return;
  }

  prefill();
  ui.loading.hidden = true;
  ui.form.hidden = false;

  void checkDuplicate();
  void refreshBooksInBackground();
}

/**
 * Die gespeicherte Liste steht sofort da; ein neu angelegtes Buch soll aber
 * nicht erst nach einem Umweg ueber die Optionen auftauchen. Scheitert der
 * Abruf, bleibt die gespeicherte Liste stehen — Token-Probleme meldet der
 * Service Worker ueber den Token-Zustand.
 */
async function refreshBooksInBackground() {
  let books;
  try {
    ({ books } = await send(MSG.REFRESH_BOOKS));
  } catch {
    return;
  }
  if (JSON.stringify(books) === JSON.stringify(context.state.books)) return;

  const selected = ui.book.value;
  context.state.books = books;
  fillBooks(books, context.state.defaultBookId);
  // Eine Auswahl, die der Nutzer schon getroffen hat, bleibt erhalten.
  const stillWritable = books.find((book) => String(book.id) === selected && canWriteToBook(book));
  if (stillWritable) ui.book.value = selected;
  if (ui.book.value !== selected) void checkDuplicate();
}

function fillCslTypes() {
  for (const type of CSL_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = t(`csl_${type}`);
    ui.cslType.append(option);
  }
}

/**
 * @param {Array<Record<string, any>>} books
 * @param {number|string|null} defaultBookId
 */
function fillBooks(books, defaultBookId) {
  ui.book.replaceChildren();

  if (!books.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = t('popup_no_books');
    ui.book.append(option);
    return;
  }

  let hasViewerOnly = false;
  for (const book of books) {
    const option = createBookOption(book, t);
    if (option.disabled) hasViewerOnly = true;
    ui.book.append(option);
  }

  ui.bookHint.hidden = !hasViewerOnly;

  const preferred = books.find((book) => String(book.id) === String(defaultBookId) && canWriteToBook(book));
  const firstWritable = books.find(canWriteToBook);
  const chosen = preferred || firstWritable;
  if (chosen) ui.book.value = String(chosen.id);
}

function prefill() {
  const settings = context.state.settings;
  const bookId = ui.book.value || null;
  const book = (context.state.books || []).find((entry) => String(entry.id) === String(bookId));

  const intent = intentFromHarvest(context.harvested, {
    mode: settings.defaultMode,
    defaultKind: settings.defaultKind,
    bookId,
    bookName: book ? book.name : '',
  });
  context.intent = intent;

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    const input = /** @type {HTMLInputElement} */ (radio);
    input.checked = input.value === intent.mode;
  }

  ui.kind.value = intent.kind;
  ui.title.value = intent.title;
  ui.body.value = intent.body;
  ui.tags.value = '';

  ui.cslType.value = intent.source.csl_type;
  ui.year.value = intent.source.year ? String(intent.source.year) : '';
  ui.authors.value = formatPeople(intent.source.authors);
  ui.containerTitle.value = intent.source.container_title;
  ui.publisher.value = intent.source.publisher;
  ui.place.value = intent.source.place;
  ui.doi.value = intent.source.doi;
  ui.isbn.value = intent.source.isbn;
  ui.sourceUrl.value = intent.source.url;
  ui.accessedAt.value = intent.source.accessed_at;
  ui.citekey.value = '';
  ui.note.value = '';

  const harvested = context.harvested;

  // Sichtbarer Hinweis, wenn der Fliesstext gekuerzt wurde.
  if (harvested.bodyTruncated) {
    ui.truncationHint.textContent = t('popup_truncated_hint', [
      String(LIMITS.BODY_MAX),
      String(harvested.bodyOriginalLength),
    ]);
    ui.truncationHint.hidden = false;
  }

  ui.verbatimHint.hidden = !harvested.hasSelection;

  // PDF nur anbieten, wenn es same-origin liegt — sonst fehlt die Berechtigung.
  if (harvested.meta.pdfUrl) {
    ui.attachPdfRow.hidden = false;
    if (!harvested.meta.pdfSameOrigin) {
      ui.attachPdf.disabled = true;
      ui.pdfHint.textContent = t('popup_pdf_cross_origin', [hostLabel(harvested.meta.pdfUrl)]);
      ui.pdfHint.hidden = false;
    }
  }

  // DOI/ISBN vorhanden -> kanonische Angaben anbieten (und empfehlen).
  if (intent.source.doi || intent.source.isbn) {
    ui.lookup.hidden = false;
    if (intent.source.doi) {
      ui.lookupStatus.textContent = t('popup_lookup_recommended');
      ui.lookupStatus.hidden = false;
    }
  }

  showProvenance(harvested.meta.provenance, harvested.meta.bylineHint);
  updateCounters();
  updateAuthorsPreview();
  updateModeVisibility();
}

/**
 * Zeigt, woher die wichtigsten Felder stammen — geerntet ist nicht belegt.
 * @param {Record<string, string>} provenance
 * @param {string} [bylineHint]
 */
function showProvenance(provenance, bylineHint) {
  const layers = new Set(Object.values(provenance || {}));
  /** @type {string[]} */
  const parts = [];

  if (layers.has('site')) parts.push(t('provenance_site'));
  else if (layers.has('citation')) parts.push(t('provenance_citation'));
  else if (layers.has('jsonld')) parts.push(t('provenance_jsonld'));
  else if (layers.has('dublincore')) parts.push(t('provenance_dublincore'));
  else if (layers.has('opengraph')) parts.push(t('provenance_opengraph'));
  else parts.push(t('provenance_fallback'));

  if (bylineHint) parts.push(t('provenance_byline_hint', [bylineHint]));

  ui.provenanceNotice.textContent = parts.join(' · ');
  ui.provenanceNotice.hidden = false;
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

function wireEvents() {
  ui.title.addEventListener('input', updateCounters);
  ui.body.addEventListener('input', updateCounters);
  // Auch diese Felder haben serverseitige Grenzen — der Hinweis muss mitgehen.
  ui.tags.addEventListener('input', updateClampHint);
  // Die Dublettenpruefung fragt nach GENAU dieser Adresse. Wer sie korrigiert
  // (AMP-Variante, Tracking-Rest), bekaeme sonst weiter den Befund zur alten.
  ui.sourceUrl.addEventListener('input', () => {
    updateClampHint();
    scheduleDuplicateCheck();
  });
  ui.kind.addEventListener('change', updateClampHint);
  ui.authors.addEventListener('input', updateAuthorsPreview);
  ui.book.addEventListener('change', () => void checkDuplicate());

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      updateModeVisibility();
      updateClampHint();
      void checkDuplicate();
    });
  }

  ui.lookup.addEventListener('click', () => void runLookup());
  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  ui.cancel.addEventListener('click', () => window.close());

  for (const id of ['open-options', 'goto-options', 'goto-options-2', 'goto-options-3']) {
    const node = document.getElementById(id);
    if (node) node.addEventListener('click', () => chrome.runtime.openOptionsPage());
  }
}

function updateModeVisibility() {
  const mode = currentMode();
  el('research-fields').hidden = mode === 'source';
  // Der Screenshot haengt am Fundstueck; eine reine Quelle nimmt nur ein PDF.
  // Sichtbar und angehakt ginge er still verloren.
  ui.attachScreenshotRow.hidden = mode === 'source';
  if (mode === 'source') ui.attachScreenshot.checked = false;
  // Bei „Quelle" und „Beides" sind die bibliografischen Angaben das Wichtige,
  // also aufgeklappt. Bei reiner Recherche bleiben sie eingeklappt erreichbar.
  if (mode !== 'research') ui.sourceFields.open = true;
}

function currentMode() {
  const checked = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="mode"]:checked'));
  return checked ? checked.value : 'research';
}

function updateCounters() {
  setCounter(ui.titleCounter, ui.title.value.length, LIMITS.TITLE_MAX);
  setCounter(ui.bodyCounter, ui.body.value.length, LIMITS.BODY_MAX);
  updateClampHint();
}

/** Feldname -> anzeigbare Bezeichnung. Literale, damit der i18n-Test sie sieht. */
const CLAMP_LABELS = {
  title: 'popup_clamp_title',
  body: 'popup_clamp_body',
  source: 'popup_clamp_source',
  tags: 'popup_clamp_tags',
  urls: 'popup_clamp_urls',
};

/**
 * Sagt vorher, was der Server beim Speichern still abschneiden wuerde.
 *
 * Der Punkt ist nicht die Laenge, sondern die Quittung: der Server lehnt zu
 * lange Textfelder nicht ab, er kuerzt sie und antwortet 2xx. Wer das nicht
 * anzeigt, meldet „gespeichert" ueber einen Text, den so niemand gespeichert
 * hat. Gerechnet wird mit denselben Funktionen, die spaeter wirklich kuerzen.
 */
function clampPreview() {
  const mode = currentMode();
  const verbatimBody = ui.kind.value === 'quote';
  /** @type {import('../shared/limits.js').Truncation[]} */
  const truncations = [];

  if (mode !== 'source') {
    truncations.push(
      ...clampResearchPayload(
        {
          title: ui.title.value,
          body: ui.body.value,
          source: normalizeUrl(ui.sourceUrl.value) || '',
          tags: readTags(),
          urls: context.intent ? context.intent.urls : [],
        },
        { verbatimBody },
      ).truncations,
    );
  }

  if (mode !== 'research') {
    const seen = new Set(truncations.map((entry) => `${entry.field}:${entry.max}`));
    truncations.push(
      ...clampSourcePayload({ title: ui.title.value, url: ui.sourceUrl.value }).truncations.filter(
        (entry) => !seen.has(`${entry.field}:${entry.max}`),
      ),
    );
  }

  return truncations;
}

function updateClampHint() {
  const truncations = clampPreview();
  if (!truncations.length) {
    ui.clampHint.hidden = true;
    return;
  }
  const parts = truncations.map((entry) =>
    t('popup_clamp_field', [
      t(CLAMP_LABELS[entry.field] || 'popup_clamp_body'),
      String(entry.max),
      String(entry.actual),
    ]),
  );
  ui.clampHint.textContent = t('popup_clamp_hint', [parts.join(' · ')]);
  ui.clampHint.hidden = false;
}

/** @returns {string[]} */
function readTags() {
  return ui.tags.value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * @param {HTMLElement} node
 * @param {number} value
 * @param {number} max
 */
function setCounter(node, value, max) {
  node.textContent = `${value} / ${max}`;
  node.classList.toggle('counter--over', value > max);
}

function updateAuthorsPreview() {
  const people = parsePeople(ui.authors.value);
  if (!people.length) {
    ui.authorsParsed.textContent = '';
    return;
  }
  const rendered = people
    .map((person) =>
      person.literal
        ? t('popup_author_literal', [person.literal])
        : `${person.family}, ${person.given}`,
    )
    .join(' · ');
  ui.authorsParsed.textContent = rendered;
}

// ---------------------------------------------------------------------------
// Dubletten und Lookup
// ---------------------------------------------------------------------------

/**
 * Zwei Fragen, zwei Endpunkte:
 *
 *   „Quelle schon in der Bibliothek?"  -> `GET /sources/by-url`
 *   „Seite in diesem Buch erfasst?"    -> `GET /research`
 *
 * Die zweite gilt in JEDEM Modus — auch bei reiner Recherche, denn dort
 * entsteht der Eintrag, um den es geht. Die erste nur, wenn wirklich eine
 * Quelle angelegt wird.
 */
/**
 * Wartezeit, bevor eine getippte Adresse gefragt wird. Jeder Tastendruck
 * waere ein Request an den Server — und die Antwort auf eine halbe URL.
 */
const DUPLICATE_DEBOUNCE_MS = 400;

/** @type {ReturnType<typeof setTimeout>|undefined} */
let duplicateTimer;

function scheduleDuplicateCheck() {
  clearTimeout(duplicateTimer);
  duplicateTimer = setTimeout(() => void checkDuplicate(), DUPLICATE_DEBOUNCE_MS);
}

/** Laufende Nummer: nur die Antwort auf die JUENGSTE Pruefung wird gezeigt. */
let duplicateSeq = 0;

async function checkDuplicate() {
  const seq = ++duplicateSeq;
  ui.duplicateNotice.hidden = true;
  ui.duplicateIncomplete.hidden = true;
  if (!context.harvested) return;
  if (!context.state.settings.duplicateCheck) return;

  const url = normalizeUrl(ui.sourceUrl.value || context.harvested.meta.normalizedUrl);
  if (!url) return;

  try {
    const result = await send(MSG.CHECK_DUPLICATE, { url, bookId: ui.book.value || null });
    // Buch, URL oder Modus wurden inzwischen geaendert — diese Antwort ist alt.
    if (seq !== duplicateSeq) return;
    renderDuplicate(result.source || {}, result.research || {});
  } catch {
    // Dubletten-Pruefung ist Komfort; ein Fehler blockiert das Erfassen nicht.
  }
}

/**
 * @param {Record<string, any>} source Befund aus `GET /sources/by-url`
 * @param {Record<string, any>} research Befund aus `GET /research`
 */
function renderDuplicate(source, research) {
  /** @type {string[]} */
  const found = [];

  if (currentMode() !== 'research' && source.supported && source.found) {
    found.push(source.linkedToBook ? t('popup_duplicate_in_book') : t('popup_duplicate_in_library'));
  }
  if (research.supported && research.found) {
    found.push(t('popup_duplicate_research', [String(research.matches.length)]));
  }

  if (found.length) {
    ui.duplicateNotice.textContent = found.join(' ');
    ui.duplicateNotice.hidden = false;
  }

  // Kein Treffer ist nur dann Entwarnung, wenn wirklich alles geprueft wurde.
  // Sonst steht hier, WARUM die Aussage nicht traegt — nie ein stilles Nichts.
  if (research.scopeMissing) {
    ui.duplicateIncomplete.textContent = t('popup_duplicate_scope_missing');
    ui.duplicateIncomplete.hidden = false;
    return;
  }
  if (research.supported && !research.complete) {
    ui.duplicateIncomplete.textContent =
      research.truncatedBy === 'fts'
        ? t('popup_duplicate_incomplete_fts', [String(RESEARCH_LIST.FTS_PREFILTER_CAP)])
        : t('popup_duplicate_incomplete_limit', [String(research.scanned)]);
    ui.duplicateIncomplete.hidden = false;
  }
}

async function runLookup() {
  ui.lookup.disabled = true;
  ui.lookupStatus.textContent = t('popup_lookup_running');
  ui.lookupStatus.hidden = false;

  try {
    const doi = ui.doi.value.trim();
    const isbn = ui.isbn.value.trim();
    const result = await send(MSG.LOOKUP_METADATA, doi ? { doi } : { isbn });

    const { draft, changed } = mergeLookup(readSourceDraft(), result);
    if (!changed.length) {
      ui.lookupStatus.textContent = t('popup_lookup_nothing_new');
      return;
    }

    ui.cslType.value = draft.csl_type;
    ui.title.value = draft.title || ui.title.value;
    ui.authors.value = formatPeople(draft.authors);
    ui.containerTitle.value = draft.container_title || '';
    ui.publisher.value = draft.publisher || '';
    ui.place.value = draft.place || '';
    ui.year.value = draft.year ? String(draft.year) : '';
    ui.doi.value = draft.doi || '';
    ui.isbn.value = draft.isbn || '';
    updateAuthorsPreview();
    updateCounters();

    ui.lookupStatus.textContent = t('popup_lookup_applied', [String(changed.length)]);
  } catch (error) {
    ui.lookupStatus.textContent = errorText(error);
  } finally {
    ui.lookup.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Absenden
// ---------------------------------------------------------------------------

/** @returns {import('../shared/config.js').SourceDraft} */
function readSourceDraft() {
  return {
    csl_type: ui.cslType.value,
    title: ui.title.value.trim(),
    authors: parsePeople(ui.authors.value),
    editors: [],
    container_title: ui.containerTitle.value.trim(),
    publisher: ui.publisher.value.trim(),
    place: ui.place.value.trim(),
    year: ui.year.value.trim() ? Number(ui.year.value.trim()) : null,
    url: ui.sourceUrl.value.trim(),
    doi: ui.doi.value.trim(),
    isbn: ui.isbn.value.trim(),
    accessed_at: ui.accessedAt.value,
    note: ui.note.value.trim(),
    citekey: ui.citekey.value.trim(),
  };
}

function readIntent() {
  const bookId = ui.book.value ? Number(ui.book.value) : null;
  const book = (context.state.books || []).find((entry) => String(entry.id) === String(bookId));
  const url = context.harvested ? context.harvested.meta.url : context.tab?.url || '';
  const normalized = normalizeUrl(ui.sourceUrl.value) || (context.harvested && context.harvested.meta.normalizedUrl) || url;

  return {
    mode: currentMode(),
    bookId,
    bookName: book ? book.name : '',
    url,
    normalizedUrl: normalized,
    kind: ui.kind.value,
    title: ui.title.value.trim(),
    // Wortlaut so lassen, wie er im Feld steht — kein Trim innerhalb des Zitats.
    body: ui.body.value,
    tags: readTags(),
    urls: context.intent ? context.intent.urls : [],
    source: readSourceDraft(),
    attachments: {},
  };
}

async function submit() {
  hideMessages();

  const intent = readIntent();

  if (!intent.bookId) {
    showNotice(ui.formError, t('validation_book_required'), 'error');
    return;
  }

  // Clientseitig gegen die Serverlimits pruefen, damit kein 400 zurueckkommt.
  // Was der Server still kuerzt, steht hier NICHT — das meldet `clampHint`
  // vorab und `clamp*Payload` fuehrt es beim Senden aus.
  /** @type {import('../shared/limits.js').ValidationProblem[]} */
  const problems = [];
  if (intent.mode !== 'source') {
    problems.push(
      ...validateResearchPayload(
        {
          book_id: intent.bookId,
          kind: intent.kind,
          title: intent.title,
          body: intent.body,
          source: intent.normalizedUrl,
          urls: intent.urls,
        },
        // Ein markiertes Zitat wird abgelehnt, nicht beschnitten.
        { verbatimBody: intent.kind === 'quote' },
      ),
    );
  }
  if (intent.mode !== 'research') {
    problems.push(...validateSourcePayload({ ...intent.source, url: intent.source.url || intent.normalizedUrl }));
  }

  if (problems.length) {
    const first = problems[0];
    showNotice(ui.formError, t(first.key, Object.values(first.params || {}).map(String)), 'error');
    return;
  }

  ui.submit.disabled = true;
  ui.submit.textContent = t('popup_sending');

  try {
    /** @type {Record<string, any>} */
    const payload = { intent, tabId: context.tab ? context.tab.id : undefined };

    if (ui.attachScreenshot.checked) {
      payload.screenshot = await send(MSG.CAPTURE_SCREENSHOT);
    }
    if (ui.attachPdf.checked && !ui.attachPdf.disabled) {
      payload.attachPdf = true;
      payload.pdfUrl = context.harvested.meta.pdfUrl;
    }

    const result = await send(MSG.SUBMIT_CAPTURE, payload);

    if (result.queued === false && result.pdfError) {
      showNotice(ui.formError, t('popup_pdf_failed', [result.pdfError]), 'error');
      return;
    }

    if (result.done) {
      showNotice(ui.formSuccess, successText(intent, result.outcome), 'success');
      // Steht ein Vorbehalt in der Quittung, muss er lesbar sein — eine
      // Meldung, die nach 1,4 s wegfliegt, ist keine Auskunft.
      const lingering = incompleteText(result.outcome || {}, t) ? 6000 : 1400;
      setTimeout(() => window.close(), lingering);
      return;
    }

    // Nicht durchgekommen: liegt in der Warteschlange, geht nichts verloren.
    const job = result.job;
    const reason = job && job.lastError ? job.lastError.text : t('err_unknown');
    showNotice(ui.formError, t('popup_queued', [reason]), 'error');
    updateQueueChip(await refreshCounts());
  } catch (error) {
    showError(error);
  } finally {
    ui.submit.disabled = false;
    ui.submit.textContent = t('popup_submit');
  }
}

/**
 * „Gespeichert" ist nicht die ganze Auskunft.
 *
 * Der Server sagt mit `research_created` / `source_created` / `source_linked`,
 * ob wirklich etwas Neues entstanden ist oder ob er eine vorhandene Quelle
 * wiederverwendet bzw. einen Doppelklick erkannt hat. Ohne diese Flags waere
 * „war schon drin" nicht von „neu angelegt" zu unterscheiden — und genau das
 * ist die Frage, die sich beim zweiten Erfassen derselben Seite stellt.
 *
 * Dazu kommt, was NICHT mitgegangen ist: ein verlorener Anhang, ein schon
 * vergebener Zitierschluessel. Beides laesst den Auftrag gelingen und waere
 * ohne diesen Zusatz aus der Quittung verschwunden.
 *
 * @param {Record<string, any>} intent
 * @param {Record<string, any>|null} [outcome] `progress` des Auftrags
 */
function successText(intent, outcome) {
  const parts = [t('popup_saved', [intent.bookName])];
  if (outcome) {
    if (outcome.sourceCreated === false) parts.push(t('popup_saved_source_existed'));
    if (outcome.researchCreated === false) parts.push(t('popup_saved_research_existed'));
    const incomplete = incompleteText(outcome, t);
    if (incomplete) parts.push(incomplete);
  }
  return parts.join(' ');
}

async function refreshCounts() {
  const state = await send(MSG.GET_STATE);
  context.state = state;
  return state.counts;
}

// ---------------------------------------------------------------------------
// Meldungen
// ---------------------------------------------------------------------------

function hideMessages() {
  ui.formError.hidden = true;
  ui.formSuccess.hidden = true;
}

/**
 * @param {any} error
 */
function showError(error) {
  showUiError(error, { translate: t, onAuth: showTokenProblem, inline: ui.formError });
}

/** @param {any} error */
function showFatal(error) {
  ui.loading.hidden = true;
  // Nur ein echtes Token-Problem gehoert in die Token-Zeile; alles andere
  // (Worker nicht erreichbar, Speicher unlesbar) ist ein eigener Fehler.
  if (error && error.auth) {
    showTokenProblem(errorText(error, t));
    return;
  }
  ui.fatalProblem.hidden = false;
  ui.fatalProblemText.textContent = errorText(error, t);
}

/**
 * Der Text enthaelt den Fehlercode bereits — `describeError` haengt ihn im
 * Service Worker an, bevor die Meldung hier ankommt.
 *
 * @param {string} text
 */
function showTokenProblem(text) {
  ui.tokenProblem.hidden = false;
  ui.tokenProblemText.textContent = text;
}

/** @param {{total: number, failed: number}} counts */
function updateQueueChip(counts) {
  if (!counts || !counts.total) {
    ui.queueChip.hidden = true;
    return;
  }
  ui.queueChip.textContent = t('popup_queue_chip', [String(counts.total)]);
  ui.queueChip.classList.toggle('chip--warn', counts.failed > 0);
  ui.queueChip.hidden = false;
}

void init();
