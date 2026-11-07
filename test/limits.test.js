import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LIMITS,
  clampAttachmentName,
  clampCapturePayload,
  clampResearchPayload,
  clampSourcePayload,
  jsonByteLength,
  validateBinarySize,
  validateResearchPayload,
  validateSourcePayload,
  validateUrls,
} from '../src/shared/limits.js';

const keys = (problems) => problems.map((problem) => problem.key);
const fields = (truncations) => truncations.map((entry) => entry.field);

describe('validateResearchPayload', () => {
  it('nimmt eine gueltige Payload an', () => {
    assert.deepEqual(
      validateResearchPayload({ book_id: 1, kind: 'quote', title: 'Titel', body: 'Text' }),
      [],
    );
  });

  it('verlangt ein Buch', () => {
    assert.ok(keys(validateResearchPayload({ title: 'x' })).includes('validation_book_required'));
  });

  it('verlangt Titel, Text ODER eine URL', () => {
    assert.ok(
      keys(validateResearchPayload({ book_id: 1, title: '', body: '' })).includes(
        'validation_research_empty',
      ),
    );
    // Eine URL allein genuegt — aber nur, was der Server als URL zaehlt:
    // `urls[]` bzw. `url` (/capture), nicht das Freitextfeld `source`.
    assert.ok(
      keys(validateResearchPayload({ book_id: 1, source: 'https://example.org' })).includes(
        'validation_research_empty',
      ),
    );
    assert.deepEqual(keys(validateResearchPayload({ book_id: 1, url: 'https://example.org' })), []);
    assert.deepEqual(
      keys(validateResearchPayload({ book_id: 1, urls: [{ url: 'https://example.org' }] })),
      [],
    );
  });

  it('beanstandet einen zu langen Titel NICHT — der Server kuerzt ihn still', () => {
    // Der Server lehnt nicht ab, er schneidet ab und antwortet 2xx. Also wird
    // hier nichts beanstandet; gekuerzt wird in `clampResearchPayload`, und der
    // Nutzer sieht es vorher.
    assert.deepEqual(keys(validateResearchPayload({ book_id: 1, title: 'x'.repeat(301) })), []);
  });

  it('beanstandet einen zu langen Fliesstext NICHT', () => {
    assert.deepEqual(
      keys(validateResearchPayload({ book_id: 1, kind: 'link', body: 'x'.repeat(LIMITS.BODY_MAX + 1) })),
      [],
    );
  });

  it('ein zu langes ZITAT wird dagegen abgelehnt — Wortlaut wird nie beschnitten', () => {
    const problems = validateResearchPayload(
      { book_id: 1, kind: 'quote', body: 'x'.repeat(LIMITS.BODY_MAX + 1) },
      { verbatimBody: true },
    );
    assert.deepEqual(keys(problems), ['validation_body_too_long']);
    assert.deepEqual(problems[0].params, { max: LIMITS.BODY_MAX, actual: LIMITS.BODY_MAX + 1 });
  });

  it('prueft die Art', () => {
    assert.ok(
      keys(validateResearchPayload({ book_id: 1, kind: 'zettel', title: 'x' })).includes(
        'validation_kind_invalid',
      ),
    );
  });
});

describe('validateSourcePayload', () => {
  const base = { csl_type: 'website', title: 'Titel' };

  it('nimmt eine gueltige Payload an', () => {
    assert.deepEqual(validateSourcePayload(base), []);
  });

  it('spiegelt SOURCE_IDENTITY_REQ: Titel ODER Person', () => {
    assert.ok(
      keys(validateSourcePayload({ csl_type: 'website' })).includes('validation_source_identity'),
    );
    // Eine Person allein genuegt.
    assert.deepEqual(
      validateSourcePayload({ csl_type: 'website', authors: [{ family: 'Muster', given: 'Max' }] }),
      [],
    );
    // Auch ein literal zaehlt als Person.
    assert.deepEqual(
      validateSourcePayload({ csl_type: 'website', editors: [{ literal: 'Abendpost AG' }] }),
      [],
    );
    // Leere Personenobjekte zaehlen nicht.
    assert.ok(
      keys(validateSourcePayload({ csl_type: 'website', authors: [{ family: '', given: '' }] })).includes(
        'validation_source_identity',
      ),
    );
  });

  it('prueft den CSL-Typ', () => {
    assert.ok(
      keys(validateSourcePayload({ ...base, csl_type: 'blogpost' })).includes(
        'validation_csl_type_invalid',
      ),
    );
  });

  it('verlangt http(s) fuer die URL', () => {
    assert.ok(
      keys(validateSourcePayload({ ...base, url: 'ftp://example.org' })).includes('validation_url_scheme'),
    );
    assert.deepEqual(validateSourcePayload({ ...base, url: 'https://example.org' }), []);
  });

  it('prueft das Jahr', () => {
    assert.ok(keys(validateSourcePayload({ ...base, year: 'neulich' })).includes('validation_year_invalid'));
    assert.deepEqual(validateSourcePayload({ ...base, year: 2019 }), []);
    assert.deepEqual(validateSourcePayload({ ...base, year: null }), []);
    assert.deepEqual(validateSourcePayload({ ...base, year: '' }), []);
  });
});

describe('clampResearchPayload', () => {
  it('laesst eine Payload innerhalb der Grenzen unberuehrt', () => {
    const input = { title: 'Titel', body: 'Text', source: 'https://example.org', tags: ['eis'] };
    const { payload, truncations } = clampResearchPayload(input);
    assert.deepEqual(truncations, []);
    assert.deepEqual(payload, input);
  });

  it('aendert die uebergebene Payload nicht — das Popup rechnet damit nur vor', () => {
    const input = { title: 'x'.repeat(400) };
    clampResearchPayload(input);
    assert.equal(input.title.length, 400);
  });

  it('kuerzt Titel auf 300 und meldet die Originallaenge', () => {
    const { payload, truncations } = clampResearchPayload({ title: 'x'.repeat(400) });
    assert.equal(payload.title.length, LIMITS.TITLE_MAX);
    assert.deepEqual(truncations, [{ field: 'title', max: 300, actual: 400 }]);
  });

  it('kuerzt hart, nicht an der Satzgrenze — der Server tut es auch so', () => {
    const { payload } = clampResearchPayload({ title: `${'a'.repeat(299)}. Noch ein Satz.` });
    assert.equal(payload.title, `${'a'.repeat(299)}.`);
  });

  it('kuerzt den Fliesstext auf 20000', () => {
    const { payload, truncations } = clampResearchPayload({ body: 'x'.repeat(20001) });
    assert.equal(payload.body.length, LIMITS.BODY_MAX);
    assert.deepEqual(fields(truncations), ['body']);
  });

  it('laesst einen Wortlaut in Ruhe, wenn verbatimBody gesetzt ist', () => {
    const body = 'x'.repeat(20001);
    const { payload, truncations } = clampResearchPayload({ body }, { verbatimBody: true });
    assert.equal(payload.body, body, 'ein Zitat wird nie beschnitten');
    assert.deepEqual(truncations, []);
  });

  it('kuerzt `source` auf 1000 — das Feld hatte bisher gar keine Grenze', () => {
    const { payload, truncations } = clampResearchPayload({ source: `https://example.org/${'a'.repeat(2000)}` });
    assert.equal(payload.source.length, LIMITS.SOURCE_MAX);
    assert.deepEqual(fields(truncations), ['source']);
  });

  it('kappt Tags bei 20 Stueck und 60 Zeichen', () => {
    const { payload, truncations } = clampResearchPayload({
      tags: Array.from({ length: 25 }, (_, i) => (i === 0 ? 'y'.repeat(80) : `tag${i}`)),
    });
    assert.equal(payload.tags.length, LIMITS.TAGS_MAX);
    assert.equal(payload.tags[0].length, LIMITS.TAG_MAX);
    // Zwei Befunde: zu viele Tags UND ein zu langer Tag.
    assert.deepEqual(fields(truncations), ['tags', 'tags']);
  });

  it('kappt urls bei 20 Stueck und das Label bei 300 — die Adresse selbst NIE', () => {
    // Seit Vertrag api 6 weist der Server eine URL ueber 2000 Zeichen ab
    // (`INVALID_URL`); eine abgeschnittene Adresse zeigt woandershin.
    const { payload, truncations } = clampResearchPayload({
      urls: Array.from({ length: 22 }, (_, i) => ({
        url: i === 0 ? `https://example.org/${'a'.repeat(2500)}` : `https://example.org/${i}`,
        label: i === 0 ? 'L'.repeat(400) : '',
      })),
    });
    assert.equal(payload.urls.length, LIMITS.URLS_MAX);
    assert.equal(payload.urls[0].url.length, 2520);
    assert.equal(payload.urls[0].label.length, LIMITS.URL_LABEL_MAX);
    assert.deepEqual(fields(truncations), ['urls']);
  });
});

describe('clampSourcePayload', () => {
  it('kuerzt den Titel, die URL nie', () => {
    const { payload, truncations } = clampSourcePayload({
      title: 'x'.repeat(400),
      url: `https://example.org/${'a'.repeat(2500)}`,
    });
    assert.equal(payload.title.length, LIMITS.TITLE_MAX);
    assert.equal(payload.url.length, 2520);
    assert.deepEqual(fields(truncations), ['title']);
  });

  it('erfindet keine Grenze fuer Felder, die keine dokumentierte haben', () => {
    // `container_title`, `publisher`, `place` und `note` bleiben, wie sie sind —
    // eine geratene Grenze waere eine Annahme, kein gespiegelter Vertrag.
    const long = 'x'.repeat(5000);
    const { payload, truncations } = clampSourcePayload({
      title: 'Titel',
      container_title: long,
      publisher: long,
      place: long,
      note: long,
    });
    assert.deepEqual(truncations, []);
    assert.equal(payload.note.length, 5000);
    assert.equal(payload.container_title.length, 5000);
  });
});

describe('clampCapturePayload', () => {
  it('wendet beide Regelwerke an und meldet `title` nur einmal', () => {
    const { payload, truncations } = clampCapturePayload({
      title: 'x'.repeat(400),
      body: 'y'.repeat(20001),
      url: `https://example.org/${'a'.repeat(2500)}`,
    });
    assert.equal(payload.title.length, LIMITS.TITLE_MAX);
    assert.equal(payload.body.length, LIMITS.BODY_MAX);
    assert.equal(payload.url.length, 2520);
    assert.deepEqual(fields(truncations), ['title', 'body']);
  });
});

describe('validateUrls', () => {
  it('lehnt eine URL ueber 2000 Zeichen ab — in `url` wie in `urls[]`', () => {
    const long = `https://example.org/${'a'.repeat(1990)}`;
    assert.deepEqual(
      validateUrls({ url: long }).map((p) => [p.field, p.key, p.params?.max]),
      [['url', 'validation_url_too_long', LIMITS.URL_MAX]],
    );
    assert.deepEqual(
      validateUrls({ urls: [{ url: 'https://example.org/kurz' }, { url: long }] }).map((p) => p.field),
      ['urls'],
    );
  });

  it('nimmt genau 2000 Zeichen noch an', () => {
    const exact = `https://example.org/${'a'.repeat(LIMITS.URL_MAX - 20)}`;
    assert.equal(exact.length, LIMITS.URL_MAX);
    assert.deepEqual(validateUrls({ url: exact, urls: [{ url: exact }] }), []);
  });

  it('lehnt ein anderes Schema ab, auch in urls[]', () => {
    assert.deepEqual(
      validateUrls({ urls: [{ url: 'ftp://example.org/datei' }] }).map((p) => p.key),
      ['validation_url_scheme'],
    );
  });

  it('steckt in validateResearchPayload, nicht in validateSourcePayload', () => {
    // `POST /sources` kennt keine Laengengrenze fuer `url` — dort wuerde die
    // Pruefung eine erfundene Grenze durchsetzen.
    const long = `https://example.org/${'a'.repeat(2100)}`;
    assert.ok(
      keys(validateResearchPayload({ book_id: 1, title: 'T', urls: [{ url: long }] })).includes(
        'validation_url_too_long',
      ),
    );
    assert.ok(
      !keys(validateSourcePayload({ csl_type: 'website', title: 'T', url: long })).includes(
        'validation_url_too_long',
      ),
    );
  });
});

describe('clampAttachmentName', () => {
  it('kuerzt auf 200 Zeichen', () => {
    assert.equal(clampAttachmentName(`${'n'.repeat(250)}.pdf`).length, LIMITS.DOC_NAME_MAX);
  });

  it('vertraegt fehlende Angaben', () => {
    assert.equal(clampAttachmentName(undefined), '');
    assert.equal(clampAttachmentName('  bericht.pdf '), 'bericht.pdf');
  });
});

describe('jsonByteLength', () => {
  it('zaehlt Bytes, nicht Zeichen — der Body-Parser tut es auch', () => {
    // Ein Umlaut wiegt in UTF-8 zwei Bytes. Wer Zeichen zaehlt, unterschaetzt
    // die 256-kB-Grenze von `POST /capture`.
    assert.equal(jsonByteLength({ a: 'ae' }), JSON.stringify({ a: 'ae' }).length);
    assert.ok(jsonByteLength({ a: 'ä'.repeat(100) }) > JSON.stringify({ a: 'ä'.repeat(100) }).length);
  });
});

describe('validateBinarySize', () => {
  it('laesst zu, was hineinpasst', () => {
    assert.equal(validateBinarySize(1024, 'image'), null);
    assert.equal(validateBinarySize(LIMITS.DOC_MAX_BYTES, 'doc'), null);
  });

  it('lehnt zu grosse Bilder ab (12 MB)', () => {
    const problem = validateBinarySize(LIMITS.IMAGE_MAX_BYTES + 1, 'image');
    assert.equal(problem.key, 'validation_image_too_large');
    assert.equal(problem.params.max, 12);
  });

  it('lehnt zu grosse PDFs ab (25 MB)', () => {
    const problem = validateBinarySize(LIMITS.DOC_MAX_BYTES + 1, 'doc');
    assert.equal(problem.key, 'validation_doc_too_large');
    assert.equal(problem.params.max, 25);
  });
});
