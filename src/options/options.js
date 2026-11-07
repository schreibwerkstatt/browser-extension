/**
 * Options-Seite: Verbindung einrichten, Standardbuch waehlen,
 * Verhalten einstellen, Warteschlange einsehen.
 *
 * Die Host-Berechtigung wird hier angefragt — ausdruecklich einzeln fuer
 * den eingetragenen Host, nie fuer alle Seiten.
 */

import { CAPABILITY_MODE, TOKEN_PREFIX, TOKEN_STATE } from '../shared/config.js';
import { describeError } from '../shared/errors.js';
import { MSG } from '../shared/messages.js';
import { createBookOption, el, errorText, hideNotice, showNotice } from '../shared/notice.js';
import { incompleteNotices } from '../shared/outcome.js';
import { isLocalHost, normalizeServerUrl, toOriginPattern } from '../shared/url.js';
import { applyI18n, formatRelativeTime, t } from '../ui/chrome-i18n.js';
import { send } from '../ui/messaging.js';

const ui = {
  serverUrl: el('server-url'),
  serverUrlHint: el('server-url-hint'),
  token: el('token'),
  toggleToken: el('toggle-token'),
  tokenFormatHint: el('token-format-hint'),
  saveConnection: el('save-connection'),
  grantPermission: el('grant-permission'),
  testConnection: el('test-connection'),
  permissionState: el('permission-state'),
  connectionResult: el('connection-result'),

  defaultBook: el('default-book'),
  booksMeta: el('books-meta'),
  refreshBooks: el('refresh-books'),
  booklist: el('booklist'),

  defaultMode: el('default-mode'),
  defaultKind: el('default-kind'),
  undoDelay: el('undo-delay'),
  harvestArticleText: el('harvest-article-text'),
  notifications: el('notifications'),
  duplicateCheck: el('duplicate-check'),
  saveSettings: el('save-settings'),
  settingsSaved: el('settings-saved'),

  capCaptureDetected: el('cap-capture-detected'),
  capCaptureMode: el('cap-capture-mode'),
  capByUrlDetected: el('cap-byurl-detected'),
  capByUrlMode: el('cap-byurl-mode'),
  capResearchDetected: el('cap-research-detected'),
  capResearchMode: el('cap-research-mode'),
  capResearchScope: el('cap-research-scope'),
  capProbedAt: el('cap-probed-at'),

  flushQueue: el('flush-queue'),
  queue: el('queue'),
  queueEmpty: el('queue-empty'),

  versionLine: el('version-line'),
};

/** @type {any} */
let state = null;

// ---------------------------------------------------------------------------

async function init() {
  applyI18n();
  wireEvents();
  await reload();
}

async function reload() {
  state = await send(MSG.GET_STATE);

  ui.serverUrl.value = state.serverUrl || '';
  ui.token.value = state.hasToken ? '••••••••••••••••' : '';
  ui.token.dataset.untouched = state.hasToken ? 'true' : '';

  ui.defaultMode.value = state.settings.defaultMode;
  ui.defaultKind.value = state.settings.defaultKind;
  ui.undoDelay.value = String(Math.round(state.settings.undoDelayMs / 1000));
  ui.harvestArticleText.checked = !!state.settings.harvestArticleText;
  ui.notifications.checked = !!state.settings.notifications;
  ui.duplicateCheck.checked = !!state.settings.duplicateCheck;

  ui.capCaptureMode.value = state.capabilities.capture.mode;
  ui.capByUrlMode.value = state.capabilities.byUrl.mode;
  ui.capResearchMode.value = state.capabilities.researchList.mode;

  ui.versionLine.textContent = t('options_version', [state.version]);

  renderTokenState();
  renderBooks();
  renderCapabilities();
  renderQueue();
  await renderPermissionState();
}

/**
 * Fuehrt eine Aktion aus und zeigt jeden Fehler an — mit Code, wie ueberall.
 * Ohne diese Huelle endete ein Fehler des Service Workers hier als
 * unbehandelte Rejection, und der Nutzer saehe schlicht nichts.
 *
 * @param {() => Promise<void>} task
 */
function guarded(task) {
  return () => {
    task().catch((error) => {
      showNotice(ui.connectionResult, errorText(error), 'error');
      ui.connectionResult.scrollIntoView({ block: 'nearest' });
    });
  };
}

function wireEvents() {
  ui.serverUrl.addEventListener('input', () => {
    const normalized = normalizeServerUrl(ui.serverUrl.value);
    if (!ui.serverUrl.value.trim()) {
      ui.serverUrlHint.textContent = '';
      return;
    }
    if (!normalized) {
      ui.serverUrlHint.textContent = t('options_server_url_invalid');
      return;
    }
    // http nur fuer lokale Entwicklung durchgehen lassen.
    if (isBlockedHttp(normalized)) {
      ui.serverUrlHint.textContent = t('options_server_url_insecure');
      return;
    }
    ui.serverUrlHint.textContent = t('options_server_url_normalized', [normalized]);
  });

  ui.token.addEventListener('input', () => {
    ui.token.dataset.untouched = '';
    const value = ui.token.value.trim();
    ui.tokenFormatHint.hidden = !value || value.startsWith(TOKEN_PREFIX);
  });

  ui.toggleToken.addEventListener('click', () => {
    const shown = ui.token.type === 'text';
    ui.token.type = shown ? 'password' : 'text';
    ui.toggleToken.textContent = shown ? t('options_show_token') : t('options_hide_token');
  });

  ui.saveConnection.addEventListener('click', guarded(saveConnection));
  ui.grantPermission.addEventListener('click', guarded(requestPermission));
  ui.testConnection.addEventListener('click', guarded(testConnection));

  ui.refreshBooks.addEventListener('click', guarded(refreshBooks));
  ui.defaultBook.addEventListener('change', guarded(setDefaultBook));

  ui.saveSettings.addEventListener('click', guarded(saveSettings));

  ui.capCaptureMode.addEventListener(
    'change',
    guarded(() => setCapabilityMode('capture', ui.capCaptureMode.value)),
  );
  ui.capByUrlMode.addEventListener(
    'change',
    guarded(() => setCapabilityMode('byUrl', ui.capByUrlMode.value)),
  );
  ui.capResearchMode.addEventListener(
    'change',
    guarded(() => setCapabilityMode('researchList', ui.capResearchMode.value)),
  );

  ui.flushQueue.addEventListener('click', guarded(flushQueue));
}

// ------------------------------------------------------------------ Verbindung

async function saveConnection() {
  hideNotice(ui.connectionResult);

  const serverUrl = normalizeServerUrl(ui.serverUrl.value);
  if (!serverUrl) {
    showNotice(ui.connectionResult, t('options_server_url_invalid'), 'error');
    return;
  }
  if (isBlockedHttp(serverUrl)) {
    showNotice(ui.connectionResult, t('options_server_url_insecure'), 'error');
    return;
  }

  // Unveraendertes Maskenfeld bedeutet: Token bleibt, wie es ist.
  const token = ui.token.dataset.untouched === 'true' ? '' : ui.token.value.trim();

  // Berechtigung gleich mit anfordern — VOR dem ersten `await`, denn Chrome
  // verlangt dafuer die Nutzergeste dieses Klicks. Ohne sie scheiterte spaeter
  // jeder Aufruf an CORS und saehe aus wie „keine Verbindung".
  const pattern = toOriginPattern(serverUrl);
  const permission = pattern
    ? chrome.permissions.request({ origins: [pattern] }).catch(() => false)
    : Promise.resolve(true);

  try {
    const result = await send(MSG.SAVE_CREDENTIALS, { serverUrl, token });
    ui.serverUrl.value = result.serverUrl;
    const granted = await permission;
    showNotice(
      ui.connectionResult,
      granted ? t('options_saved') : t('options_permission_denied'),
      granted ? 'success' : 'error',
    );
    await reload();
  } catch (error) {
    showNotice(ui.connectionResult, errorText(error), 'error');
  }
}

/**
 * Eine `http`-Adresse ausserhalb von localhost ist keine Warnung, sondern eine
 * Sackgasse: das Manifest fuehrt unter `optional_host_permissions` nur
 * das weite https-Muster und die localhost-Muster, ein anderes `http`-Origin
 * laesst sich gar nicht anfordern. Also hier ablehnen statt spaeter an
 * `chrome.permissions.request()` scheitern.
 *
 * @param {string} normalized bereits durch `normalizeServerUrl` gegangen
 */
function isBlockedHttp(normalized) {
  return normalized.startsWith('http://') && !isLocalHost(normalized);
}

async function requestPermission() {
  const pattern = toOriginPattern(ui.serverUrl.value);
  if (!pattern) {
    showNotice(ui.connectionResult, t('options_server_url_invalid'), 'error');
    return;
  }
  const normalized = normalizeServerUrl(ui.serverUrl.value);
  if (normalized && isBlockedHttp(normalized)) {
    showNotice(ui.connectionResult, t('options_server_url_insecure'), 'error');
    return;
  }
  try {
    // Muss aus einer Nutzergeste kommen — daher direkt im Klick-Handler.
    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      showNotice(ui.connectionResult, t('options_permission_denied'), 'error');
    }
    await renderPermissionState();
  } catch (error) {
    showNotice(ui.connectionResult, errorText(error), 'error');
  }
}

async function renderPermissionState() {
  const pattern = toOriginPattern(ui.serverUrl.value || state?.serverUrl);
  if (!pattern) {
    ui.permissionState.hidden = true;
    ui.grantPermission.disabled = true;
    return;
  }
  ui.grantPermission.disabled = false;
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  ui.permissionState.textContent = granted
    ? t('options_permission_granted', [pattern])
    : t('options_permission_missing', [pattern]);
  ui.permissionState.classList.toggle('notice--warn', !granted);
  ui.permissionState.classList.toggle('notice--muted', granted);
  ui.permissionState.hidden = false;
  ui.grantPermission.hidden = granted;
}

async function testConnection() {
  ui.testConnection.disabled = true;
  showNotice(ui.connectionResult, t('options_testing'), 'muted');
  try {
    const result = await send(MSG.TEST_CONNECTION);
    // chrome.i18n kennt keine Pluralregeln — die eine Ausnahme von Hand.
    const count = result.books.length;
    showNotice(
      ui.connectionResult,
      count === 1 ? t('options_test_ok_one') : t('options_test_ok', [String(count)]),
      'success',
    );
    await reload();
  } catch (error) {
    showNotice(ui.connectionResult, errorText(error), 'error');
    await reload();
  } finally {
    ui.testConnection.disabled = false;
  }
}

/**
 * Der Fehlercode gehoert in die Meldung — beides kommt aus derselben Map wie
 * jede andere Fehlermeldung, damit hier nie ein Code steht, den der Server
 * nicht sendet. `CAPTURE_SCOPE_REQUIRED` stand genau so lange hier, wie es
 * niemand nachgeprueft hat.
 */
function renderTokenState() {
  if (state.tokenState === TOKEN_STATE.INVALID) {
    showNotice(ui.connectionResult, describeError({ status: 401, code: 'NOT_LOGGED_IN' }, t).text, 'error');
  } else if (state.tokenState === TOKEN_STATE.SCOPE_MISSING) {
    showNotice(
      ui.connectionResult,
      describeError({ status: 403, code: 'DEVICE_SCOPE_FORBIDDEN' }, t).text,
      'error',
    );
  }
}

// ---------------------------------------------------------------------- Bücher

function renderBooks() {
  ui.defaultBook.replaceChildren();
  ui.booklist.replaceChildren();

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = t('options_no_default_book');
  ui.defaultBook.append(empty);

  for (const book of state.books || []) {
    const option = createBookOption(book, t);
    ui.defaultBook.append(option);

    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = book.name;
    const meta = document.createElement('span');
    meta.textContent = [roleLabel(book.role), book.buchtyp, book.owner_email]
      .filter(Boolean)
      .join(' · ');
    item.append(name, meta);
    ui.booklist.append(item);
  }

  if (state.defaultBookId !== null && state.defaultBookId !== undefined) {
    ui.defaultBook.value = String(state.defaultBookId);
  }

  ui.booksMeta.textContent = state.booksFetchedAt
    ? t('options_books_fetched', [formatRelativeTime(state.booksFetchedAt)])
    : t('options_books_never');
}

/**
 * `t` liefert bei fehlendem Schluessel den Schluessel selbst zurueck — ein
 * `|| book.role` griffe also nie, und eine unbekannte Rolle stuende als
 * `role_xyz` da.
 *
 * @param {string} role
 */
function roleLabel(role) {
  const key = `role_${role}`;
  const label = t(key);
  return label && label !== key ? label : role;
}

async function refreshBooks() {
  ui.refreshBooks.disabled = true;
  try {
    await send(MSG.REFRESH_BOOKS);
    await reload();
  } catch (error) {
    showNotice(ui.connectionResult, errorText(error), 'error');
  } finally {
    ui.refreshBooks.disabled = false;
  }
}

async function setDefaultBook() {
  const value = ui.defaultBook.value;
  await send(MSG.SET_DEFAULT_BOOK, { bookId: value ? Number(value) : null });
  flash(ui.settingsSaved);
}

// -------------------------------------------------------------------- Verhalten

async function saveSettings() {
  const seconds = Math.min(30, Math.max(0, Number(ui.undoDelay.value) || 0));
  await send(MSG.SAVE_SETTINGS, {
    settings: {
      defaultMode: ui.defaultMode.value,
      defaultKind: ui.defaultKind.value,
      undoDelayMs: seconds * 1000,
      harvestArticleText: ui.harvestArticleText.checked,
      notifications: ui.notifications.checked,
      duplicateCheck: ui.duplicateCheck.checked,
    },
  });
  ui.undoDelay.value = String(seconds);
  flash(ui.settingsSaved);
}

// ---------------------------------------------------------------- Fähigkeiten

function renderCapabilities() {
  ui.capCaptureDetected.textContent = detectedLabel(state.capabilities.capture.detected);
  ui.capByUrlDetected.textContent = detectedLabel(state.capabilities.byUrl.detected);
  ui.capResearchDetected.textContent = detectedLabel(state.capabilities.researchList.detected);

  // Endpunkt da, Token darf ihn nicht lesen — das ist eine andere Aussage als
  // „nicht erkannt" und muss auch so dastehen.
  ui.capResearchScope.hidden = !state.capabilities.researchList.scopeMissing;
  ui.capResearchScope.textContent = state.capabilities.researchList.scopeMissing
    ? t('options_cap_research_scope_missing')
    : '';

  ui.capProbedAt.textContent = state.capabilities.probedAt
    ? t('options_cap_probed', [formatRelativeTime(state.capabilities.probedAt)])
    : t('options_cap_never_probed');
}

/** @param {boolean|null} value */
function detectedLabel(value) {
  if (value === true) return t('options_cap_yes');
  if (value === false) return t('options_cap_no');
  return t('options_cap_unknown');
}

/**
 * @param {'capture'|'byUrl'|'researchList'} name
 * @param {string} mode
 */
async function setCapabilityMode(name, mode) {
  if (!Object.values(CAPABILITY_MODE).includes(/** @type {any} */ (mode))) return;
  await send(MSG.SET_CAPABILITY_MODE, { name, mode });
  flash(ui.settingsSaved);
}

// ------------------------------------------------------------- Warteschlange

function renderQueue() {
  ui.queue.replaceChildren();
  const jobs = state.queue || [];
  ui.queueEmpty.hidden = jobs.length > 0;

  for (const job of jobs) {
    const item = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'queue__head';

    const title = document.createElement('span');
    title.className = 'queue__title';
    title.textContent = job.intent.title || t('options_queue_untitled');

    const meta = document.createElement('span');
    meta.className = 'queue__meta';
    meta.textContent = [
      t(`mode_${job.intent.mode}`),
      t(`queue_state_${job.state}`),
      job.attempts ? t('options_queue_attempts', [String(job.attempts)]) : '',
      formatRelativeTime(job.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');

    head.append(title, meta);

    const url = document.createElement('div');
    url.className = 'queue__url';
    url.textContent = job.intent.normalizedUrl || job.intent.url || '';

    item.append(head, url);

    if (job.lastError) {
      const error = document.createElement('div');
      error.className = 'queue__error';
      error.textContent = job.lastError.text;
      item.append(error);
    }

    // Vorbehalte aus derselben Quelle wie Quittung und Benachrichtigung —
    // sonst erfaehrt der Nutzer hier etwas anderes als dort.
    for (const notice of incompleteNotices(job.progress)) {
      const line = document.createElement('div');
      line.className = 'queue__error';
      line.textContent = t(notice.key, notice.substitutions);
      item.append(line);
    }

    const actions = document.createElement('div');
    actions.className = 'queue__actions';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button button--ghost';
    retry.textContent = t('options_queue_retry');
    retry.addEventListener('click', guarded(() => retryJob(job.id)));

    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'button button--ghost button--danger';
    discard.textContent = t('options_queue_discard');
    discard.addEventListener('click', guarded(() => discardJob(job.id, job.intent.title)));

    actions.append(retry, discard);
    item.append(actions);

    ui.queue.append(item);
  }
}

async function flushQueue() {
  ui.flushQueue.disabled = true;
  try {
    await send(MSG.FLUSH_QUEUE);
    await reload();
  } finally {
    ui.flushQueue.disabled = false;
  }
}

/** @param {string} jobId */
async function retryJob(jobId) {
  await send(MSG.RETRY_JOB, { jobId });
  await reload();
}

/**
 * @param {string} jobId
 * @param {string} title
 */
async function discardJob(jobId, title) {
  // Verwerfen ist der einzige Weg, auf dem Daten verloren gehen — also fragen.
  if (!window.confirm(t('options_queue_discard_confirm', [title || '']))) return;
  await send(MSG.DISCARD_JOB, { jobId });
  await reload();
}

// ------------------------------------------------------------------- Helfer

/** @param {HTMLElement} node */
function flash(node) {
  node.hidden = false;
  setTimeout(() => {
    node.hidden = true;
  }, 1600);
}

guarded(init)();
