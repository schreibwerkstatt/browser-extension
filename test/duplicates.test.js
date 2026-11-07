/**
 * Dublettenpruefung: was ein Ergebnis von `GET /research` aussagt — und was
 * nicht. Der wichtigere Teil ist der zweite.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { itemUrls, matchesForUrl, summarizeDuplicates } from '../src/shared/duplicates.js';
import { RESEARCH_LIST } from '../src/shared/limits.js';

/** @param {Partial<Record<string, any>>} [overrides] */
const item = (overrides = {}) => ({
  id: 1,
  kind: 'link',
  title: 'Sediment transport under partial ice cover',
  source: 'https://press.example.org/articles/jfs-2019-0417',
  body_snippet: 'Transport rates diverged sharply …',
  urls: [{ url: 'https://press.example.org/articles/jfs-2019-0417/pdf', label: 'PDF' }],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

/** @param {number} count */
const many = (count) =>
  Array.from({ length: count }, (_, i) =>
    item({ id: i + 1, source: `https://press.example.org/artikel/${i}`, urls: [] }),
  );

describe('itemUrls', () => {
  it('sammelt source und urls[]', () => {
    assert.deepEqual(itemUrls(item()), [
      'https://press.example.org/articles/jfs-2019-0417',
      'https://press.example.org/articles/jfs-2019-0417/pdf',
    ]);
  });

  it('uebergeht Leeres', () => {
    assert.deepEqual(itemUrls(item({ source: null, urls: [{ url: '  ', label: '' }, null] })), []);
    assert.deepEqual(itemUrls(/** @type {any} */ (null)), []);
  });
});

describe('matchesForUrl', () => {
  it('trifft ueber source', () => {
    const found = matchesForUrl([item()], 'https://press.example.org/articles/jfs-2019-0417');
    assert.equal(found.length, 1);
  });

  it('trifft ueber urls[]', () => {
    const found = matchesForUrl([item()], 'https://press.example.org/articles/jfs-2019-0417/pdf');
    assert.equal(found.length, 1);
  });

  it('vergleicht nach SERVER-Regeln, nicht nach den lokalen', () => {
    // www., http, Trailing-Slash, Fragment und utm_ — der Server sieht hier
    // dieselbe Seite, also muss der Client das auch.
    const found = matchesForUrl(
      [item()],
      'http://www.press.example.org/articles/jfs-2019-0417/?utm_source=mail#oben',
    );
    assert.equal(found.length, 1);
  });

  it('trifft nicht bei anderer Seite', () => {
    assert.deepEqual(matchesForUrl([item()], 'https://press.example.org/articles/andere'), []);
  });

  it('unbrauchbare URL trifft nie', () => {
    assert.deepEqual(matchesForUrl([item()], 'kaputt'), []);
    assert.deepEqual(matchesForUrl(/** @type {any} */ (null), 'https://press.example.org/'), []);
  });
});

describe('summarizeDuplicates', () => {
  it('meldet einen Treffer als vollstaendige Aussage', () => {
    const report = summarizeDuplicates({
      items: [item()],
      url: 'https://press.example.org/articles/jfs-2019-0417',
      limit: RESEARCH_LIST.LIMIT_MAX,
    });
    assert.equal(report.found, true);
    assert.equal(report.matches.length, 1);
    assert.equal(report.complete, true);
    assert.equal(report.truncatedBy, null);
  });

  it('kein Treffer bei kurzer Liste ist echte Entwarnung', () => {
    const report = summarizeDuplicates({
      items: many(3),
      url: 'https://press.example.org/etwas-anderes',
      limit: RESEARCH_LIST.LIMIT_MAX,
    });
    assert.equal(report.found, false);
    assert.equal(report.complete, true);
    assert.equal(report.scanned, 3);
  });

  it('volles limit heisst: abgeschnitten, also keine Entwarnung', () => {
    const report = summarizeDuplicates({
      items: many(RESEARCH_LIST.LIMIT_MAX),
      url: 'https://press.example.org/etwas-anderes',
      limit: RESEARCH_LIST.LIMIT_MAX,
    });
    assert.equal(report.found, false);
    assert.equal(report.complete, false);
    assert.equal(report.truncatedBy, 'limit');
  });

  it('ein Treffer bleibt ein Treffer, auch aus abgeschnittener Liste', () => {
    const rows = [...many(RESEARCH_LIST.LIMIT_MAX - 1), item()];
    const report = summarizeDuplicates({
      items: rows,
      url: 'https://press.example.org/articles/jfs-2019-0417',
      limit: RESEARCH_LIST.LIMIT_MAX,
    });
    assert.equal(report.found, true);
    assert.equal(report.complete, true);
  });

  it('mit q ist ein leeres Ergebnis nie belastbar — der 500er-Vorfilter', () => {
    const report = summarizeDuplicates({
      items: many(2),
      url: 'https://press.example.org/etwas-anderes',
      limit: RESEARCH_LIST.LIMIT_MAX,
      usedQuery: true,
    });
    assert.equal(report.found, false);
    assert.equal(report.complete, false);
    assert.equal(report.truncatedBy, 'fts');
  });

  it('ohne limit gilt der Server-Default als Schwelle', () => {
    const report = summarizeDuplicates({
      items: many(RESEARCH_LIST.LIMIT_DEFAULT),
      url: 'https://press.example.org/etwas-anderes',
    });
    assert.equal(report.complete, false);
    assert.equal(report.truncatedBy, 'limit');
  });
});

describe('summarizeDuplicates: limit wie der Server klemmen', () => {
  const url = 'https://press.example.org/etwas-anderes';

  for (const limit of [0, -5, 'viele', Number.NaN]) {
    it(`limit ${String(limit)} faellt auf den Default zurueck`, () => {
      // Der Server liefert dann bis zu 50 Zeilen; 3 sind echte Entwarnung,
      // 50 sind abgeschnitten — nicht umgekehrt.
      const short = summarizeDuplicates({ items: many(3), url, limit });
      assert.equal(short.complete, true);
      assert.equal(short.truncatedBy, null);
      const full = summarizeDuplicates({ items: many(RESEARCH_LIST.LIMIT_DEFAULT), url, limit });
      assert.equal(full.complete, false);
      assert.equal(full.truncatedBy, 'limit');
    });
  }

  it('ein limit ueber dem Maximum zaehlt als Maximum', () => {
    const report = summarizeDuplicates({ items: many(RESEARCH_LIST.LIMIT_MAX), url, limit: 1000 });
    assert.equal(report.complete, false);
    assert.equal(report.truncatedBy, 'limit');
  });
});
