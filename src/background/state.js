/**
 * Zugriff auf `chrome.storage.local`.
 *
 * Bewusst `local` und nicht `sync`: das Geraete-Token ist ein Geheimnis
 * und soll nicht ueber das Google-Konto auf fremde Rechner wandern.
 *
 * Ueber die Factory injizierbar — damit ist das Modul ohne chrome-Umgebung
 * testbar, analog zu `queue.js` und `api-client.js`.
 */

import {
  CAPABILITY_MODE,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  TOKEN_STATE,
  withDefaults,
} from '../shared/config.js';
import { normalizeServerUrl } from '../shared/url.js';

/**
 * @param {object} deps
 * @param {chrome.storage.StorageArea} [deps.storage] `chrome.storage.local`
 *   als Voreinstellung; in Tests ueberschreibbar.
 * @param {(value: string) => string} [deps.normalizeServer]
 */
export function createStore({
  storage,
  normalizeServer = normalizeServerUrl,
} = {}) {
  const store =
    storage ||
    (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : undefined);

  /** @returns {Promise<ReturnType<typeof withDefaults>>} */
  async function readState() {
    const stored = await store.get(null);
    return withDefaults(stored);
  }

  /** @param {Record<string, any>} patch */
  async function writeState(patch) {
    await store.set(patch);
  }

  /** Zugangsdaten fuer den API-Client. */
  async function getConfig() {
    const stored = await store.get([STORAGE_KEYS.SERVER_URL, STORAGE_KEYS.TOKEN]);
    return {
      serverUrl: normalizeServer(/** @type {string} */ (stored[STORAGE_KEYS.SERVER_URL])) || '',
      token: /** @type {string} */ (stored[STORAGE_KEYS.TOKEN]) || '',
    };
  }

  async function getSettings() {
    const stored = await store.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, .../** @type {Partial<typeof DEFAULT_SETTINGS>} */ (stored[STORAGE_KEYS.SETTINGS] || {}) };
  }

  /** @param {Partial<typeof DEFAULT_SETTINGS>} patch */
  async function saveSettings(patch) {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await writeState({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
  }

  /** @returns {Promise<import('../shared/config.js').CaptureJob[]>} */
  async function loadQueue() {
    const stored = await store.get(STORAGE_KEYS.QUEUE);
    const value = stored[STORAGE_KEYS.QUEUE];
    return Array.isArray(value) ? value : [];
  }

  /** @param {import('../shared/config.js').CaptureJob[]} jobs */
  async function saveQueue(jobs) {
    await store.set({ [STORAGE_KEYS.QUEUE]: jobs });
  }

  /** @param {import('../shared/config.js').TokenState} state */
  async function setTokenState(state) {
    await writeState({ [STORAGE_KEYS.TOKEN_STATE]: state });
  }

  /** @returns {Promise<import('../shared/config.js').TokenState>} */
  async function getTokenState() {
    const stored = await store.get(STORAGE_KEYS.TOKEN_STATE);
    return /** @type {import('../shared/config.js').TokenState} */ (stored[STORAGE_KEYS.TOKEN_STATE]) || TOKEN_STATE.UNKNOWN;
  }

  async function getCapabilities() {
    const state = await readState();
    return state[STORAGE_KEYS.CAPABILITIES];
  }

  /**
   * Lesen-Aendern-Schreiben auf den Faehigkeits-Schluessel hintereinander.
   * `CHECK_DUPLICATE` stoesst zwei Pruefungen gleichzeitig an, und beide
   * koennen einen Befund schreiben — ohne Kette gewaenne der spaetere und
   * der andere Befund ginge verloren.
   */
  let capabilityChain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serializeCapabilities(task) {
    const run = capabilityChain.then(task);
    capabilityChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * @param {{capture?: boolean|null, byUrl?: boolean|null, researchList?: boolean|null, researchScopeMissing?: boolean}} detected
   */
  async function saveDetectedCapabilities(detected) {
    return serializeCapabilities(async () => {
      const current = await getCapabilities();
      const next = {
        ...current,
        capture: { ...current.capture, detected: pick(detected.capture, current.capture.detected) },
        byUrl: { ...current.byUrl, detected: pick(detected.byUrl, current.byUrl.detected) },
        researchList: {
          ...current.researchList,
          detected: pick(detected.researchList, current.researchList.detected),
          scopeMissing:
            detected.researchScopeMissing === undefined
              ? current.researchList.scopeMissing
              : !!detected.researchScopeMissing,
        },
        probedAt: Date.now(),
      };
      await writeState({ [STORAGE_KEYS.CAPABILITIES]: next });
      return next;
    });
  }

  /**
   * Setzt alle Faehigkeits-BEFUNDE explizit zurueck.
   *
   * `saveDetectedCapabilities({ capture: null, ... })` wuerde die Werte trotz
   * `null`-Argumenten BEHALTEN (siehe `pick` weiter unten), denn `null` heisst
   * in der Sprechweise der Probe „keine Aussage". Diese Funktion hier meint
   * tatsaechlich „vergiss alles" — nach einem Serverwechsel sind die Befunde
   * des vorigen Servers wertlos.
   *
   * `mode` bleibt jedoch stehen: das ist kein Befund, sondern die Vorgabe des
   * Nutzers aus den Optionen. Sie gilt weiter, auch fuer den neuen Server.
   */
  async function resetDetectedCapabilities() {
    return serializeCapabilities(async () => {
      const current = await getCapabilities();
      const next = {
        capture: { mode: current.capture.mode, detected: null },
        byUrl: { mode: current.byUrl.mode, detected: null },
        researchList: { mode: current.researchList.mode, detected: null, scopeMissing: false },
        probedAt: 0,
      };
      await writeState({ [STORAGE_KEYS.CAPABILITIES]: next });
      return next;
    });
  }

  /**
   * @param {'capture'|'byUrl'|'researchList'} name
   * @param {'auto'|'on'|'off'} mode
   */
  async function setCapabilityMode(name, mode) {
    return serializeCapabilities(async () => {
      const current = await getCapabilities();
      if (!Object.values(CAPABILITY_MODE).includes(mode)) return current;
      const next = { ...current, [name]: { ...current[name], mode } };
      await writeState({ [STORAGE_KEYS.CAPABILITIES]: next });
      return next;
    });
  }

  /** @param {Array<Record<string, any>>} books */
  async function saveBooks(books) {
    await writeState({
      [STORAGE_KEYS.BOOKS]: books,
      [STORAGE_KEYS.BOOKS_FETCHED_AT]: Date.now(),
    });
  }

  return {
    readState,
    writeState,
    getConfig,
    getSettings,
    saveSettings,
    loadQueue,
    saveQueue,
    setTokenState,
    getTokenState,
    getCapabilities,
    saveDetectedCapabilities,
    resetDetectedCapabilities,
    setCapabilityMode,
    saveBooks,
  };
}

/**
 * `null` aus der Probe heisst „keine Aussage" — dann bleibt der alte Befund.
 * @param {boolean|null|undefined} fresh
 * @param {boolean|null} previous
 */
function pick(fresh, previous) {
  return fresh === null || fresh === undefined ? previous : fresh;
}