/**
 * Mock-Server, der den dokumentierten API-Vertrag nachbaut.
 *
 * Kein echter Server, keine Netzabhaengigkeit — nur `node:http` auf
 * einem freien Port. Fehlerantworten haben die vertragsgemaesse Form
 * `{ error_code, params?, detail? }`; eine unbekannte Route antwortet mit HTML,
 * genau wie Express es tut. Daran haengt die Faehigkeits-Erkennung.
 *
 * **Diese Datei ist der Vertrag, gegen den die Tests pruefen.** Sie darf deshalb
 * nur Codes und Pfade kennen, die der Server wirklich hat. Sie hat einmal
 * `CAPTURE_SCOPE_REQUIRED`, `BOOK_ACCESS_DENIED`, `VALIDATION_FAILED` und
 * `POST /sources/:id/pdf` gesprochen — dieselben Erfindungen wie der Client.
 * Genau darum waren die Tests gruen, waehrend die Erweiterung gegen die echte
 * App in Fehler lief. Wer hier etwas hinzufuegt, prueft es vorher gegen
 * `docs/clients.md` im Mutterprojekt.
 *
 * Zwei Dinge werden ausdruecklich nachgebaut, weil der Client daran zerbrechen
 * koennte:
 *
 *  - **Der Body-Parser antwortet ohne `error_code`.** `413` bei zu grossem
 *    Koerper, `400` bei kaputtem JSON, beides HTML. Der Server hat keinen
 *    globalen Express-Fehler-Handler.
 *  - **Der Parser gewinnt gegen die Route.** PDF-Limit und Parser-Limit liegen
 *    beide bei 25 MB, also ist `DOC_TOO_LARGE` in der Praxis unerreichbar.
 *
 * Seit Vertrag api 6 (Mutterprojekt `contract/CHANGELOG.md`) dazu: Textfelder
 * werden weiter still gekuerzt, **URLs aber abgewiesen** (`INVALID_URL` mit
 * `params.max`), falsche Feldtypen ebenso (`INVALID_FIELD`). `POST /research`
 * antwortet auf eine schon erfasste URL mit `409 DUPLICATE_URL`, uebersteuerbar
 * mit `allow_duplicate: true`.
 */

import { createServer } from 'node:http';

import { serverNormalizeUrl } from '../../src/shared/url.js';

/**
 * @typedef {object} MockOptions
 * @property {boolean} [hasCapture] `POST /capture` ausgerollt?
 * @property {boolean} [hasByUrl] `GET /sources/by-url` ausgerollt?
 * @property {boolean} [hasResearchList] `GET /research` ausgerollt?
 * @property {string} [token] gueltiges Token
 * @property {boolean} [tokenHasCaptureScope]
 * @property {boolean} [tokenHasReadScope] traegt das Token `content:read`?
 * @property {Array<Record<string, any>>} [researchIndex] Bestand fuer `GET /research`
 * @property {Set<string>} [takenCitekeys]
 * @property {boolean} [checkPdfMagic] `%PDF-` pruefen und sonst `DOC_NOT_PDF`
 * @property {number} [port] Port; 0 waehlt einen freien (Voreinstellung)
 * @property {string} [host] Bind-Adresse; nur Loopback als Voreinstellung
 * @property {(entry: any) => void} [onRequest] wird je Anfrage aufgerufen
 */

/**
 * @param {MockOptions} [options]
 */
export async function startMockServer(options = {}) {
  const config = {
    hasCapture: false,
    hasByUrl: false,
    hasResearchList: false,
    token: 'swd_gueltig',
    tokenHasCaptureScope: true,
    tokenHasReadScope: true,
    /** Bestand, den `GET /research` ausliefert (Rohform wie in der DB). */
    researchIndex: [],
    takenCitekeys: new Set(['muster2019']),
    /** Magic-Bytes eines PDF pruefen (`DOC_NOT_PDF`)? Fuer Tests abschaltbar. */
    checkPdfMagic: false,
    // Fuer die Tests: freier Port, nur Loopback. `tools/review-server.mjs`
    // ueberschreibt beides, um denselben Vertrag oeffentlich anzubieten.
    port: 0,
    host: '127.0.0.1',
    onRequest: undefined,
    ...options,
  };

  /** Alles, was der Server gesehen hat — die Tests pruefen daran den Ablauf. */
  const log = [];
  const state = {
    researchItems: new Map(),
    sources: new Map(),
    links: new Map(), // sourceId -> Set(bookId)
    sourcesByUrl: new Map(), // normalisierte URL -> sourceId
    /** kind+Titel+Text+URL -> researchItemId; das Doppelklick-Fenster. */
    researchFingerprints: new Map(),
    attachments: [],
    nextId: 1,
    /** Anzahl der Ausfaelle, die der Server noch simuliert. */
    failuresLeft: 0,
    failureStatus: 503,
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      try {
        handle(req, res, body);
      } catch (error) {
        send(res, 500, { error_code: 'SERVER_ERROR', params: { message: String(error) } });
      }
    });
  });

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {any} payload
   */
  function send(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  }

  /**
   * Unbekannte Route: HTML, kein JSON. Das ist das Unterscheidungsmerkmal,
   * an dem die Erweiterung „Endpunkt fehlt" erkennt.
   */
  function sendNotARoute(res) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html>\n<html><head><title>Error</title></head><body><pre>Cannot POST /capture</pre></body></html>\n');
  }

  /**
   * Antwort des Body-Parsers: HTML, **kein** `error_code`.
   *
   * Der Server hat keinen globalen Express-Fehler-Handler, deshalb ist das die
   * echte Antwort bei einem zu grossen Koerper (413) und bei kaputtem JSON (400).
   * Der Client muss daran nicht zerbrechen und darf nicht auf einen `error_code`
   * warten, der nie kommt.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   */
  function sendParserError(res, status) {
    const title = status === 413 ? 'PayloadTooLargeError' : 'SyntaxError';
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!DOCTYPE html>\n<html><head><title>Error</title></head><body><pre>${title}: ` +
        `request entity too large<br> &nbsp; &nbsp;at readStream (/app/node_modules/raw-body/index.js:163:17)</pre></body></html>\n`,
    );
  }

  function handle(req, res, rawBody) {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    log.push({
      route,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: parseJson(rawBody, req.headers['content-type']),
      rawLength: rawBody.length,
    });
    config.onRequest?.(log[log.length - 1]);

    // -------------------------------------------------------- Body-Parser
    // Kommt VOR allem anderen, so wie im Server: der Parser laeuft, bevor
    // Auth- oder Scope-Middleware etwas zu sehen bekommt.
    const parserLimit = contentTypeOf(req) === 'application/json' ? 256 * 1024 : 25 * 1024 * 1024;
    if (rawBody.length > parserLimit) return sendParserError(res, 413);
    if (isJson(req) && rawBody.length && parseJson(rawBody, req.headers['content-type']) === null) {
      return sendParserError(res, 400);
    }

    // ---------------------------------------------------------- Kopfzeilen
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return send(res, 401, { error_code: 'NOT_LOGGED_IN' });
    }
    if (auth.slice(7) !== config.token) {
      return send(res, 401, { error_code: 'NOT_LOGGED_IN' });
    }
    // Das Scope-Gate sitzt VOR dem Routing und kennt genau einen Code.
    // `CAPTURE_SCOPE_REQUIRED` hat der Server nie gesendet.
    if (!config.tokenHasCaptureScope && req.method !== 'GET') {
      return send(res, 403, { error_code: 'DEVICE_SCOPE_FORBIDDEN' });
    }
    // Der Lesepfad verlangt `content:read` — dasselbe Gate, andere Allowlist.
    if (route === 'GET /research' && !config.tokenHasReadScope) {
      return send(res, 403, { error_code: 'DEVICE_SCOPE_FORBIDDEN' });
    }

    // Simulierte Ausfaelle, damit die Retry-Logik pruefbar ist. Ein 5xx kommt in
    // der Praxis vom Reverse-Proxy und traegt deshalb keinen `error_code`.
    if (state.failuresLeft > 0 && req.method !== 'GET') {
      state.failuresLeft -= 1;
      res.writeHead(state.failureStatus, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html>\n<html><body><h1>503 Service Unavailable</h1></body></html>\n');
    }

    // ------------------------------------------------------------- Routen
    if (route === 'GET /content/books') {
      return send(res, 200, [
        { id: 1, name: 'Nordlicht', role: 'owner', owner_email: 'ich@example.org', buchtyp: 'roman' },
        { id: 2, name: 'Mitschrift', role: 'editor', owner_email: 'wir@example.org', buchtyp: 'sachbuch' },
        { id: 3, name: 'Fremdes Buch', role: 'viewer', owner_email: 'du@example.org', buchtyp: 'roman' },
      ]);
    }

    if (route === 'GET /research') {
      if (!config.hasResearchList) return sendNotARoute(res);
      return listResearch(res, url.searchParams);
    }

    if (route === 'POST /research') {
      const payload = parseJson(rawBody, req.headers['content-type']) || {};
      // `POST /research` antwortet `BOOKID_REQ`, nicht `INVALID_ID` — der Name
      // haengt an der Route, nicht am Fehlerbild.
      if (!payload.book_id) return send(res, 400, { error_code: 'BOOKID_REQ' });
      const acl = bookAcl(payload.book_id, 'editor');
      if (acl) return send(res, 403, acl);
      // Erst die strikte Eingangspruefung — Typ und URLs werden ABGEWIESEN.
      const bad = textFieldsError(payload) || urlsError(payload.urls);
      if (bad) return send(res, 400, bad);
      // Titel und Text werden STILL GEKUERZT, nicht abgelehnt. Genau deshalb
      // muss der Client vorher kuerzen: sonst quittiert er einen Text, der so
      // nie gespeichert wurde. Als URL zaehlt fuer EMPTY nur `urls[]`.
      const urls = Array.isArray(payload.urls) ? payload.urls : [];
      const hasUrl = urls.some((entry) => entry && entry.url);
      if (!payload.title && !payload.body && !hasUrl) {
        return send(res, 400, { error_code: 'EMPTY' });
      }
      if (hasUrl && payload.allow_duplicate !== true) {
        const existing = findResearchByUrl(Number(payload.book_id), urls.map((entry) => entry.url));
        if (existing) {
          return send(res, 409, {
            error_code: 'DUPLICATE_URL',
            existing_id: existing.id,
            params: { existing_id: existing.id, title: existing.title ?? null },
          });
        }
      }
      const { allow_duplicate: _allow, ...rest } = payload;
      const stored = clampLikeServer(rest);
      const id = state.nextId++;
      state.researchItems.set(id, stored);
      return send(res, 201, { id, ...stored });
    }

    let match = url.pathname.match(/^\/research\/(\d+)\/(image|doc)$/);
    if (match && req.method === 'POST') {
      const id = Number(match[1]);
      if (!state.researchItems.has(id)) return send(res, 404, { error_code: 'ITEM_NOT_FOUND' });
      return acceptAttachment(res, req, rawBody, url, match[2] === 'image' ? 'image' : 'doc', id);
    }

    if (route === 'POST /sources') {
      const payload = parseJson(rawBody, req.headers['content-type']) || {};
      if (payload.book_id !== undefined) {
        const acl = bookAcl(payload.book_id, 'editor');
        if (acl) return send(res, 403, acl);
      }
      const anyPerson = [...(payload.authors || []), ...(payload.editors || [])].some(
        (p) => p && (p.family || p.given || p.literal),
      );
      if (!payload.title && !anyPerson) return send(res, 400, { error_code: 'SOURCE_IDENTITY_REQ' });
      if (payload.url && !/^https?:\/\//.test(payload.url)) {
        return send(res, 400, { error_code: 'INVALID_URL' });
      }
      if (payload.csl_type && !CSL_TYPES.has(payload.csl_type)) {
        return send(res, 400, {
          error_code: 'INVALID_VALUE',
          params: { field: 'csl_type', allowed: [...CSL_TYPES].join(',') },
        });
      }
      if (payload.citekey && config.takenCitekeys.has(payload.citekey)) {
        return send(res, 409, { error_code: 'CITEKEY_TAKEN', params: { citekey: payload.citekey } });
      }
      const id = state.nextId++;
      const citekey = payload.citekey || `auto${id}`;
      config.takenCitekeys.add(citekey);
      state.sources.set(id, { ...payload, citekey });
      state.links.set(id, new Set(payload.book_id ? [payload.book_id] : []));
      if (payload.url) state.sourcesByUrl.set(payload.url, id);
      return send(res, 201, { id, ...payload, citekey });
    }

    match = url.pathname.match(/^\/sources\/(\d+)\/link$/);
    if (match && req.method === 'POST') {
      const id = Number(match[1]);
      if (!state.sources.has(id)) return send(res, 404, { error_code: 'NOT_FOUND' });
      const payload = parseJson(rawBody, req.headers['content-type']) || {};
      if (!payload.book_id) return send(res, 400, { error_code: 'INVALID_ID' });
      const acl = bookAcl(payload.book_id, 'editor');
      if (acl) return send(res, 403, acl);
      state.links.get(id).add(payload.book_id);
      return send(res, 200, { ok: true });
    }

    // Der Anhang der Quelle heisst `doc`, wie beim Fundstueck. `/pdf` gibt es
    // nicht — der Name stand nur in der Scope-Allowlist, und die ist eine
    // Rechte-Liste, keine Routenliste.
    match = url.pathname.match(/^\/sources\/(\d+)\/doc$/);
    if (match && req.method === 'POST') {
      const id = Number(match[1]);
      if (!state.sources.has(id)) return send(res, 404, { error_code: 'NOT_FOUND' });
      return acceptAttachment(res, req, rawBody, url, 'source-doc', id);
    }

    if (route === 'GET /sources/lookup') {
      const doi = url.searchParams.get('doi');
      const isbn = url.searchParams.get('isbn');
      if (!doi && !isbn) return send(res, 400, { error_code: 'LOOKUP_PARAM_REQUIRED' });
      if (doi && isbn) return send(res, 400, { error_code: 'LOOKUP_PARAM_AMBIGUOUS' });
      if (doi === '10.0000/unbekannt') return send(res, 404, { error_code: 'LOOKUP_NOT_FOUND' });
      return send(res, 200, {
        source: {
          csl_type: 'article',
          title: 'Sediment transport under partial ice cover',
          authors: [
            { family: 'Halvorsen', given: 'Ingrid M.' },
            { family: 'Okonkwo', given: 'Chidi' },
            { family: 'van der Meer', given: 'Jan' },
          ],
          container_title: 'Journal of Fluvial Studies',
          publisher: 'Northfield Academic Press',
          year: 2019,
          doi: doi || '',
          isbn: isbn || '',
        },
      });
    }

    if (route === 'GET /sources/by-url') {
      if (!config.hasByUrl) return sendNotARoute(res);
      const wanted = url.searchParams.get('url') || '';
      const bookId = url.searchParams.get('book_id');
      if (!wanted) return send(res, 400, { error_code: 'URL_REQ' });
      const id = state.sourcesByUrl.get(wanted);
      // 404 heisst hier „kein Treffer im eigenen Pool" — Normalfall, kein Fehler.
      if (!id) return send(res, 404, { error_code: 'NOT_FOUND' });
      return send(res, 200, {
        source: { id, ...state.sources.get(id) },
        linked_to_book: bookId ? state.links.get(id).has(Number(bookId)) : false,
      });
    }

    if (route === 'POST /capture') {
      if (!config.hasCapture) return sendNotARoute(res);
      const payload = parseJson(rawBody, req.headers['content-type']) || {};
      if (!payload.book_id) return send(res, 400, { error_code: 'BOOKID_REQ' });
      if (!CAPTURE_MODES.has(payload.mode)) {
        return send(res, 400, {
          error_code: 'INVALID_VALUE',
          params: { field: 'mode', allowed: [...CAPTURE_MODES].join(',') },
        });
      }
      // Abgewiesen, nie gekuerzt — auch eine zu lange URL.
      if (!payload.url || !/^https?:\/\//i.test(payload.url) || payload.url.length > URL_MAX) {
        return send(res, 400, { error_code: 'INVALID_URL', params: { max: URL_MAX } });
      }
      const acl = bookAcl(payload.book_id, 'editor');
      if (acl) return send(res, 403, acl);
      const badField = textFieldsError(payload);
      if (badField) return send(res, 400, badField);
      if (payload.csl_type && !CSL_TYPES.has(payload.csl_type)) {
        return send(res, 400, {
          error_code: 'INVALID_VALUE',
          params: { field: 'csl_type', allowed: [...CSL_TYPES].join(',') },
        });
      }

      const stored = clampLikeServer(payload);

      /**
       * Die Antwort traegt drei Flags, kein `created`. Die Idempotenz ist
       * zweigeteilt: eine QUELLE existiert pro Dokument nur einmal, ein
       * FUNDSTUECK beliebig oft — dedupliziert wird dort nur der wortgleiche
       * Fund aus einem 10-Minuten-Fenster, also der Doppelklick.
       *
       * @type {any}
       */
      const result = {};

      if (payload.mode === 'research' || payload.mode === 'both') {
        const fingerprint = [stored.kind, stored.title, stored.body, stored.url].join(' ');
        const twin = state.researchFingerprints.get(fingerprint);
        if (twin !== undefined) {
          result.research_item = { id: twin };
          result.research_created = false;
        } else {
          const id = state.nextId++;
          state.researchItems.set(id, stored);
          state.researchFingerprints.set(fingerprint, id);
          result.research_item = { id };
          result.research_created = true;
        }
      }

      if (payload.mode === 'source' || payload.mode === 'both') {
        const existing = state.sourcesByUrl.get(stored.url);
        if (existing !== undefined) {
          // Bekannte URL: wiederverwenden und nur verlinken.
          const wasLinked = state.links.get(existing).has(payload.book_id);
          state.links.get(existing).add(payload.book_id);
          result.source = { id: existing, ...state.sources.get(existing) };
          result.source_created = false;
          result.source_linked = !wasLinked;
        } else {
          const id = state.nextId++;
          state.sources.set(id, stored);
          state.links.set(id, new Set([payload.book_id]));
          state.sourcesByUrl.set(stored.url, id);
          result.source = { id };
          result.source_created = true;
          result.source_linked = true;
        }
      }

      return send(res, result.research_created || result.source_created ? 201 : 200, result);
    }

    return sendNotARoute(res);
  }

  /** Die zwoelf `csl_type`-Werte des Vertrags (`newspaper` seit v4.14.0). */
  const CSL_TYPES = new Set([
    'book',
    'chapter',
    'article',
    'newspaper',
    'website',
    'thesis',
    'report',
    'legal',
    'interview',
    'film',
    'dataset',
    'other',
  ]);

  const CAPTURE_MODES = new Set(['research', 'source', 'both']);

  /**
   * Rollen der drei angebotenen Buecher. Buch 3 gehoert einem anderen Konto und
   * traegt nur `viewer`; jede unbekannte Id ist ununterscheidbar von „kein
   * Zugriff" — der Server unterscheidet das absichtlich nicht.
   */
  const ROLES = new Map([
    [1, 'owner'],
    [2, 'editor'],
    [3, 'viewer'],
  ]);

  const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

  /**
   * ACL-Antwort nach `lib/acl.js` — oder `null`, wenn der Zugriff passt.
   *
   * Zwei Codes, und die Unterscheidung ist Absicht: `NO_BOOK_ACCESS` heisst
   * „gibt es nicht ODER darfst du nicht" (damit fremde Buch-Ids nicht abfragbar
   * sind), `INSUFFICIENT_ROLE` heisst „du darfst, aber zu wenig" und nennt in
   * `detail`, was fehlt.
   *
   * @param {unknown} bookId
   * @param {'viewer'|'editor'} required
   */
  function bookAcl(bookId, required) {
    const id = Number(bookId);
    const role = ROLES.get(id);
    if (!role) return { error_code: 'NO_BOOK_ACCESS' };
    if (ROLE_RANK[role] < ROLE_RANK[required]) {
      return { error_code: 'INSUFFICIENT_ROLE', detail: { actual: role, required } };
    }
    return null;
  }

  const URL_MAX = 2000;

  /**
   * `INVALID_FIELD`: `title`/`body`/`source` muss fehlen, `null` oder String sein.
   * @param {Record<string, any>} payload
   */
  function textFieldsError(payload) {
    for (const field of ['title', 'body', 'source']) {
      const value = payload[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return { error_code: 'INVALID_FIELD', params: { field } };
      }
    }
    return null;
  }

  /**
   * `urls[]` von `POST /research`: jede URL http(s) und hoechstens 2000
   * Zeichen, sonst wird der GANZE Request abgewiesen.
   * @param {unknown} urls
   */
  function urlsError(urls) {
    if (urls === undefined || urls === null) return null;
    if (!Array.isArray(urls)) return { error_code: 'INVALID_FIELD', params: { field: 'urls' } };
    for (const entry of urls) {
      const value = typeof entry === 'string' ? entry : entry && entry.url;
      if (!value) continue;
      if (!/^https?:\/\//i.test(value) || value.length > URL_MAX) {
        return { error_code: 'INVALID_URL', params: { max: URL_MAX } };
      }
    }
    return null;
  }

  /**
   * Fundstueck desselben Buchs, an dem eine dieser URLs schon haengt —
   * verglichen nach den Normalisierungsregeln des Servers.
   * @param {number} bookId
   * @param {string[]} urls
   */
  function findResearchByUrl(bookId, urls) {
    const wanted = new Set(urls.map((value) => serverNormalizeUrl(value) || value));
    for (const [id, item] of state.researchItems) {
      if (Number(item.book_id) !== bookId) continue;
      const own = [
        ...(Array.isArray(item.urls) ? item.urls.map((entry) => entry.url) : []),
        ...(item.url ? [item.url] : []),
      ];
      if (own.some((value) => wanted.has(serverNormalizeUrl(value) || value))) {
        return { id, title: item.title };
      }
    }
    return null;
  }

  /**
   * Kuerzt so, wie der Server kuerzt: still, ohne Fehler, ohne Hinweis in der
   * Antwort. URLs gehoeren nicht dazu — die weist der Server ab. Der Mock tut das ausdruecklich mit, damit ein Test zeigen kann,
   * was gespeichert wurde — und nicht nur, was gesendet wurde.
   *
   * @param {Record<string, any>} payload
   */
  function clampLikeServer(payload) {
    const cut = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);
    const next = { ...payload };
    next.title = cut(next.title, 300);
    next.body = cut(next.body, 20000);
    next.source = cut(next.source, 1000);
    if (Array.isArray(next.tags)) next.tags = next.tags.slice(0, 20).map((tag) => cut(tag, 60));
    if (Array.isArray(next.urls)) {
      next.urls = next.urls.slice(0, 20).map((entry) => ({
        url: entry.url,
        label: cut(entry.label || '', 300),
      }));
    }
    return next;
  }

  /**
   * Anhang annehmen — `POST /research/:id/{image,doc}` und
   * `POST /sources/:id/doc` verhalten sich gleich.
   *
   * `DOC_TOO_LARGE` steht hier nur der Vollstaendigkeit halber: der Body-Parser
   * hat dieselbe Schwelle und hat oben schon mit einem HTML-413 abgebrochen.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {import('node:http').IncomingMessage} req
   * @param {Buffer} rawBody
   * @param {URL} url
   * @param {'image'|'doc'|'source-doc'} kind
   * @param {number} id
   */
  function acceptAttachment(res, req, rawBody, url, kind, id) {
    const type = contentTypeOf(req);

    if (kind === 'image') {
      if (!rawBody.length || !type.startsWith('image/')) {
        return send(res, 400, { error_code: 'NO_IMAGE' });
      }
      if (rawBody.length > 12 * 1024 * 1024) return send(res, 413, { error_code: 'DOC_TOO_LARGE' });
    } else {
      if (!rawBody.length || type !== 'application/pdf') {
        return send(res, 400, { error_code: 'NO_DOC' });
      }
      if (rawBody.length > 25 * 1024 * 1024) return send(res, 413, { error_code: 'DOC_TOO_LARGE' });
      // Magic Bytes: `%PDF-`. Der Vertrag antwortet darauf mit 415.
      if (config.checkPdfMagic && rawBody.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return send(res, 415, { error_code: 'DOC_NOT_PDF' });
      }
    }

    state.attachments.push({
      kind: kind === 'source-doc' ? 'source-doc' : kind,
      id,
      bytes: rawBody.length,
      contentType: req.headers['content-type'],
      // Der Server kuerzt den Dateinamen auf 200 Zeichen.
      name: (url.searchParams.get('name') || '').slice(0, 200),
    });
    return send(res, 201, { ok: true });
  }

  /** Kinds, die der Lesepfad kennt. Unbekannte werden ignoriert, nicht abgelehnt. */
  const LIST_KINDS = new Set(['note', 'link', 'quote', 'fact', 'image', 'document']);
  const LIST_SORTS = new Set(['updated', 'created', 'title', 'kind']);

  /** Deckel des FTS5-Vorfilters — greift VOR Filter, Sortierung und `limit`. */
  const FTS_PREFILTER_CAP = 500;

  /**
   * `GET /research` — reiner Lesepfad.
   *
   * @param {import('node:http').ServerResponse} res
   * @param {URLSearchParams} params
   */
  function listResearch(res, params) {
    const rawBookId = params.get('book_id');
    const bookId = Number(rawBookId);
    if (!rawBookId || !Number.isInteger(bookId) || bookId < 1) {
      return send(res, 400, { error_code: 'INVALID_ID' });
    }
    // Buch 3 gehoert jemand anderem und traegt nur `viewer`; Buch 9 kennt
    // dieser Nutzer gar nicht. Beide Wege kommen aus `lib/acl.js`.
    const acl = bookAcl(bookId, 'editor');
    if (acl) return send(res, 403, acl);

    let rows = config.researchIndex.filter((row) => Number(row.book_id) === bookId);

    // Der Vorfilter laeuft ZUERST und schneidet hart ab. Genau daran haengt,
    // dass „nichts gefunden" nach einer breiten Query nichts beweist.
    const q = params.get('q');
    if (q) {
      rows = rows
        .filter((row) => `${row.title || ''} ${row.body || ''}`.toLowerCase().includes(q.toLowerCase()))
        .slice(0, FTS_PREFILTER_CAP);
    }

    const kind = params.get('kind');
    if (kind && LIST_KINDS.has(kind)) rows = rows.filter((row) => row.kind === kind);

    const tag = params.get('tag');
    if (tag) rows = rows.filter((row) => (row.tags || []).includes(tag));

    const linked = params.get('linked');
    if (linked) rows = rows.filter((row) => (row.links || []).includes(linked));

    if (params.get('archived') !== '1') rows = rows.filter((row) => !row.archived);

    const sort = LIST_SORTS.has(params.get('sort') || '') ? params.get('sort') : 'updated';
    const compare = {
      updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
      created: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
      title: (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
      kind: (a, b) => String(a.kind).localeCompare(String(b.kind)),
    }[sort];
    // Angeheftete zuerst, dann nach `sort`.
    rows = [...rows].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || compare(a, b));

    const rawLimit = Number(params.get('limit'));
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;

    return send(
      res,
      200,
      rows.slice(0, limit).map((row) => {
        const body = String(row.body || '');
        return {
          id: row.id,
          kind: row.kind,
          title: row.title ?? null,
          source: row.source ?? null,
          body_snippet: body.length > 200 ? `${body.slice(0, 200)}…` : body,
          urls: (row.urls || []).map((entry) => ({ url: entry.url, label: entry.label || '' })),
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
      }),
    );
  }

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = /** @type {any} */ (server.address());

  return {
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${port}`,
    port,
    config,
    state,
    log,
    /** @param {string} route */
    calls: (route) => log.filter((entry) => entry.route === route),
    routes: () => log.map((entry) => entry.route),
    /**
     * Laesst die naechsten n schreibenden Anfragen scheitern.
     * @param {number} count
     * @param {number} [status]
     */
    failNext(count, status = 503) {
      state.failuresLeft = count;
      state.failureStatus = status;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function parseJson(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  if (contentType && !contentType.includes('json')) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/** @param {import('node:http').IncomingMessage} req */
function contentTypeOf(req) {
  return String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/** @param {import('node:http').IncomingMessage} req */
function isJson(req) {
  return contentTypeOf(req) === 'application/json';
}
