/**
 * Retry-Warteschlange.
 *
 * Grundsatz aus der Spezifikation: nie stillschweigend verwerfen.
 * Ein Auftrag verlaesst die Queue nur, wenn er erfolgreich war oder wenn
 * der Nutzer ihn ausdruecklich loescht. Auch endgueltig gescheiterte
 * Auftraege bleiben sichtbar stehen.
 *
 * Persistenz und Uhr sind injizierbar, damit sich das ohne Chrome testen laesst.
 */

import { exhausted, nextDelay } from '../shared/backoff.js';
import { describeError, isRetryable } from '../shared/errors.js';
import { JOB_STATE } from '../shared/config.js';

/**
 * @param {object} deps
 * @param {() => Promise<import('../shared/config.js').CaptureJob[]>} deps.load
 * @param {(jobs: import('../shared/config.js').CaptureJob[]) => Promise<void>} deps.save
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {(key: string, subs?: string[]) => string} [deps.translate]
 */
export function createQueue({ load, save, now = () => Date.now(), random = Math.random, translate }) {
  /** Schreibvorgaenge serialisieren — der Worker kann parallel geweckt werden. */
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {(jobs: import('../shared/config.js').CaptureJob[]) => T|Promise<T>} mutator
   * @returns {Promise<T>}
   */
  function transaction(mutator) {
    const run = chain.then(async () => {
      const jobs = await load();
      const result = await mutator(jobs);
      await save(jobs);
      return result;
    });
    // Fehler duerfen die Kette nicht abreissen lassen.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @returns {Promise<import('../shared/config.js').CaptureJob[]>} */
  async function list() {
    return load();
  }

  /**
   * @param {import('../shared/config.js').CaptureIntent} intent
   * @param {object} [options]
   * @param {number} [options.holdMs] Undo-Fenster; solange Zustand `held`
   * @param {string} [options.serverUrl] Server, fuer den der Auftrag erfasst
   *   wurde. Seine `book_id` gilt nur dort; nach einem Serverwechsel darf er
   *   nicht an den neuen gehen.
   * @param {(job: import('../shared/config.js').CaptureJob) => Promise<void>} [options.beforeSave]
   *   laeuft, BEVOR der Auftrag sichtbar wird — fuer die Anhaenge. Andernfalls
   *   koennte ein Wecker ihn dazwischen greifen und ohne Anhang senden.
   * @returns {Promise<import('../shared/config.js').CaptureJob>}
   */
  async function add(intent, options = {}) {
    const holdMs = Math.max(0, Number(options.holdMs) || 0);
    const timestamp = now();
    /** @type {import('../shared/config.js').CaptureJob} */
    const job = {
      id: `job_${timestamp.toString(36)}_${Math.floor(random() * 1e9).toString(36)}`,
      ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      createdAt: timestamp,
      attempts: 0,
      runAfter: timestamp + holdMs,
      state: holdMs > 0 ? JOB_STATE.HELD : JOB_STATE.PENDING,
      lastError: null,
      intent,
      progress: {
        researchItemId: null,
        sourceId: null,
        linkedBookIds: [],
        imageUploaded: false,
        pdfUploaded: false,
        // Was der Server gemeldet hat — `null` heisst „noch nichts versucht".
        researchCreated: null,
        sourceCreated: null,
        sourceLinked: null,
        via: null,
      },
    };

    if (options.beforeSave) await options.beforeSave(job);
    await transaction((jobs) => {
      jobs.push(job);
    });
    return job;
  }

  /**
   * Faellige Auftraege, aelteste zuerst. `held` zaehlt erst nach Ablauf
   * des Undo-Fensters als faellig.
   *
   * @returns {Promise<import('../shared/config.js').CaptureJob[]>}
   */
  async function due() {
    const timestamp = now();
    const jobs = await load();
    return jobs
      .filter(
        (job) =>
          (job.state === JOB_STATE.PENDING || job.state === JOB_STATE.HELD || job.state === JOB_STATE.RUNNING) &&
          job.runAfter <= timestamp,
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * @param {string} id
   * @param {Partial<import('../shared/config.js').CaptureJob>} patch
   */
  async function update(id, patch) {
    return transaction((jobs) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return null;
      Object.assign(job, patch);
      return job;
    });
  }

  /**
   * Uebernimmt einen faelligen Auftrag zur Ausfuehrung — atomar.
   *
   * `due()` ist nur eine Momentaufnahme. Zwischen ihr und dem Senden liegen
   * Netzaufrufe (Faehigkeits-Probe, vorherige Auftraege); in der Zeit kann der
   * Nutzer einen Auftrag zuruecknehmen oder verwerfen. Ohne diese Pruefung ging
   * er trotzdem hinaus, waehrend die Oberflaeche „zurueckgenommen" gemeldet hat.
   *
   * Liefert den Auftrag im GESPEICHERTEN Stand (mit aktuellem Fortschritt)
   * oder `null`, wenn es ihn nicht mehr gibt bzw. er nicht mehr faellig ist.
   *
   * @param {string} id
   * @returns {Promise<import('../shared/config.js').CaptureJob|null>}
   */
  async function claim(id) {
    const timestamp = now();
    return transaction((jobs) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return null;
      const runnable =
        job.state === JOB_STATE.PENDING || job.state === JOB_STATE.HELD || job.state === JOB_STATE.RUNNING;
      if (!runnable || job.runAfter > timestamp) return null;
      job.state = JOB_STATE.RUNNING;
      return structuredClone(job);
    });
  }

  /**
   * Endet erfolgreich: Auftrag verlaesst die Queue.
   * @param {string} id
   */
  async function complete(id) {
    return transaction((jobs) => {
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index >= 0) jobs.splice(index, 1);
      return index >= 0;
    });
  }

  /**
   * Nur auf ausdrueckliche Nutzeraktion (Undo oder „Eintrag verwerfen").
   * @param {string} id
   */
  async function discard(id) {
    return complete(id);
  }

  /**
   * Verbucht einen Fehlschlag und plant den naechsten Versuch.
   *
   * @param {string} id
   * @param {any} error
   * @param {import('../shared/config.js').CaptureProgress} [progress] Teilfortschritt sichern
   * @returns {Promise<{job: import('../shared/config.js').CaptureJob|null, willRetry: boolean}>}
   */
  async function fail(id, error, progress) {
    return transaction((jobs) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return { job: null, willRetry: false };

      if (progress) job.progress = { ...job.progress, ...progress };

      job.attempts += 1;
      const described = describeError(error, translate || ((key) => key));
      job.lastError = { code: described.code, text: described.text, at: now() };

      const willRetry = isRetryable(error) && !exhausted(job.attempts);
      if (willRetry) {
        job.state = JOB_STATE.PENDING;
        job.runAfter = now() + nextDelay(job.attempts, 0.2, random);
      } else {
        job.state = JOB_STATE.FAILED;
        job.runAfter = Number.MAX_SAFE_INTEGER;
      }
      return { job, willRetry };
    });
  }

  /**
   * Setzt einen Auftrag manuell wieder in die Warteschlange.
   * @param {string} id
   */
  async function retryNow(id) {
    return transaction((jobs) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return null;
      job.state = JOB_STATE.PENDING;
      job.runAfter = now();
      job.attempts = 0;
      return job;
    });
  }

  /**
   * Zieht einen Auftrag im Undo-Fenster zurueck.
   * @param {string} id
   * @returns {Promise<boolean>} false, wenn das Fenster schon zu war
   */
  async function undo(id) {
    return transaction((jobs) => {
      const index = jobs.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      const job = jobs[index];
      if (job.state !== JOB_STATE.HELD) return false;
      jobs.splice(index, 1);
      return true;
    });
  }

  /**
   * Zeitpunkt, zu dem der Worker das naechste Mal geweckt werden muss.
   * @returns {Promise<number|null>}
   */
  async function nextWakeAt() {
    const jobs = await load();
    // `running` zaehlt mit: steht ein Auftrag so im Speicher, waehrend dieser
    // Worker nichts abarbeitet, wurde der vorige mitten im Senden beendet.
    // Ohne Wecker bliebe er bis zum naechsten Browserstart liegen.
    const times = jobs
      .filter(
        (job) => job.state === JOB_STATE.PENDING || job.state === JOB_STATE.HELD || job.state === JOB_STATE.RUNNING,
      )
      .map((job) => job.runAfter)
      .filter((value) => Number.isFinite(value));
    if (!times.length) return null;
    return Math.min(...times);
  }

  /**
   * Zaehler fuer das Badge.
   * @returns {Promise<{total: number, pending: number, failed: number, held: number}>}
   */
  async function counts() {
    const jobs = await load();
    return {
      total: jobs.length,
      pending: jobs.filter((job) => job.state === JOB_STATE.PENDING || job.state === JOB_STATE.RUNNING).length,
      failed: jobs.filter((job) => job.state === JOB_STATE.FAILED).length,
      held: jobs.filter((job) => job.state === JOB_STATE.HELD).length,
    };
  }

  return { list, add, due, claim, update, complete, discard, fail, retryNow, undo, nextWakeAt, counts };
}
