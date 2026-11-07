import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampLine,
  collapseWhitespace,
  extractDoi,
  extractIsbn,
  isoDate,
  normalizeDate,
  sliceUnits,
  tidyParagraphs,
  truncateAtSentence,
  yearFromDate,
} from '../src/shared/text.js';

describe('truncateAtSentence', () => {
  it('laesst kurzen Text unangetastet', () => {
    const result = truncateAtSentence('Kurz und gut.', 100);
    assert.equal(result.text, 'Kurz und gut.');
    assert.equal(result.truncated, false);
    assert.equal(result.originalLength, 13);
  });

  it('trennt an der letzten Satzgrenze im erlaubten Fenster', () => {
    const text = 'Erster Satz. Zweiter Satz. Dritter Satz, der nicht mehr hineinpasst.';
    const result = truncateAtSentence(text, 30);
    assert.equal(result.text, 'Erster Satz. Zweiter Satz.');
    assert.equal(result.truncated, true);
    assert.equal(result.originalLength, text.length);
  });

  it('erkennt auch ! ? und Auslassungspunkte', () => {
    assert.equal(truncateAtSentence('Wirklich? Ja! Und weiter geht es hier.', 15).text, 'Wirklich? Ja!');
  });

  it('nimmt eine Satzgrenze auch dann, wenn sie erst bei 30% des Fensters liegt', () => {
    // Punkt bei Index 24 von 60 = 40% — die Satzgrenze schlaegt die Wortgrenze.
    const text = 'Ein Satz ganz am Anfang. Danach folgt ein sehr langer Nebensatz ohne jeden Punkt darin';
    const result = truncateAtSentence(text, 60);
    assert.equal(result.text, 'Ein Satz ganz am Anfang.');
    assert.equal(result.truncated, true);
  });

  it('trennt an einer Wortgrenze, wenn die Satzgrenze zu weit vorn liegt', () => {
    // Punkt bei Index 24 von 120 = 20% — zu wenig, also Wortgrenze.
    const text =
      'Ein Satz ganz am Anfang. Danach folgt ein ausgesprochen langer und maeandernder Nebensatz ohne jeden weiteren Punkt darin, der einfach nicht enden will';
    const result = truncateAtSentence(text, 120);
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 120);
    assert.ok(result.text.length > 60, 'nicht an der fruehen Satzgrenze getrennt');
    assert.ok(!result.text.endsWith(' '));
    // Kein Wort mittendrin zerschnitten.
    assert.ok(text.startsWith(result.text));
    assert.equal(text[result.text.length], ' ');
  });

  it('trennt notfalls hart', () => {
    const result = truncateAtSentence('a'.repeat(50), 20);
    assert.equal(result.text.length, 20);
    assert.equal(result.truncated, true);
  });

  it('behandelt Grenzwerte', () => {
    assert.deepEqual(truncateAtSentence('', 10), { text: '', truncated: false, originalLength: 0 });
    assert.deepEqual(truncateAtSentence(null, 10), { text: '', truncated: false, originalLength: 0 });
    assert.equal(truncateAtSentence('abc', 0).truncated, true);
  });
});

describe('extractDoi', () => {
  it('findet ein blankes DOI', () => {
    assert.equal(extractDoi('siehe 10.1234/jfs.2019.0417 dort'), '10.1234/jfs.2019.0417');
  });

  it('findet ein DOI mit Praefix', () => {
    assert.equal(extractDoi('doi:10.1234/abc'), '10.1234/abc');
    assert.equal(extractDoi('https://doi.org/10.1234/abc'), '10.1234/abc');
  });

  it('schneidet Satzzeichen am Ende ab', () => {
    assert.equal(extractDoi('vgl. 10.1234/abc.'), '10.1234/abc');
    assert.equal(extractDoi('vgl. 10.1234/abc,'), '10.1234/abc');
    assert.equal(extractDoi('(10.1234/abc)'), '10.1234/abc');
  });

  it('behaelt Klammern, die zum DOI gehoeren', () => {
    assert.equal(extractDoi('10.1002/(SICI)1097-0258'), '10.1002/(SICI)1097-0258');
  });

  it('gibt null zurueck, wenn nichts da ist', () => {
    assert.equal(extractDoi('kein doi hier 10.12/'), null);
    assert.equal(extractDoi(''), null);
    assert.equal(extractDoi(null), null);
  });
});

describe('extractIsbn', () => {
  it('normalisiert auf reine Ziffern', () => {
    assert.equal(extractIsbn('ISBN 978-3-16-148410-0'), '9783161484100');
    assert.equal(extractIsbn('3-16-148410-X'), '316148410X');
  });

  it('verwirft Ziffernfolgen ohne gueltige Pruefziffer', () => {
    // Zeitstempel und Artikel-IDs aus echten Blogseiten.
    assert.equal(extractIsbn('2026091202'), null);
    assert.equal(extractIsbn('id 5567151590'), null);
    assert.equal(extractIsbn('ISBN 978-3-16-148410-1'), null);
  });

  it('nimmt den ersten gueltigen Kandidaten', () => {
    assert.equal(extractIsbn('Post 2026091202, ISBN 978-3-16-148410-0'), '9783161484100');
  });

  it('verlangt auf Wunsch das Wort ISBN', () => {
    // Jede elfte Zufallszahl hat eine gueltige ISBN-10-Pruefziffer — die
    // Pruefziffer allein haelt eine Artikel-ID nicht auf, das Wort schon.
    assert.equal(extractIsbn('post-1785805606'), '1785805606');
    assert.equal(extractIsbn('post-1785805606', { requireLabel: true }), null);
    assert.equal(extractIsbn('Bestellnr. 3-16-148410-X', { requireLabel: true }), null);
    assert.equal(extractIsbn('ISBN-10: 3-16-148410-X', { requireLabel: true }), '316148410X');
  });

  it('ignoriert zu kurze Zahlen', () => {
    assert.equal(extractIsbn('12345'), null);
    assert.equal(extractIsbn(''), null);
  });
});

describe('yearFromDate', () => {
  it('liest verschiedene Formate', () => {
    assert.equal(yearFromDate('2019'), 2019);
    assert.equal(yearFromDate('2019-04-17'), 2019);
    assert.equal(yearFromDate('2024-06-11T05:30:00+02:00'), 2024);
    assert.equal(yearFromDate('17.04.2019'), 2019);
    assert.equal(yearFromDate('April 2019'), 2019);
    assert.equal(yearFromDate(1999), 1999);
  });

  it('gibt null zurueck, wenn keine Jahreszahl da ist', () => {
    assert.equal(yearFromDate('demnaechst'), null);
    assert.equal(yearFromDate(''), null);
    assert.equal(yearFromDate(null), null);
    assert.equal(yearFromDate(42), null);
  });
});

describe('normalizeDate', () => {
  it('ISO bleibt ISO', () => {
    assert.equal(normalizeDate('2019-04-17'), '2019-04-17');
    assert.equal(normalizeDate('2024-06-11T05:30:00+02:00'), '2024-06-11');
  });

  it('deutsches Datum', () => {
    assert.equal(normalizeDate('17.4.2019'), '2019-04-17');
  });

  it('Verlagsformat mit Schraegstrichen', () => {
    assert.equal(normalizeDate('2019/04/17'), '2019-04-17');
  });

  it('nur ein Jahr bleibt ein Jahr', () => {
    assert.equal(normalizeDate('2019'), '2019');
    assert.equal(normalizeDate('erschienen 2019'), '2019');
  });

  it('nichts Verwertbares ergibt null', () => {
    assert.equal(normalizeDate('bald'), null);
    assert.equal(normalizeDate(''), null);
  });

  it('prueft den Kalender: kein Monat 13, kein 31. Februar', () => {
    assert.equal(normalizeDate('2024-13-45'), null);
    assert.equal(normalizeDate('2024-00-10'), null);
    assert.equal(normalizeDate('2024-04-31'), null);
    assert.equal(normalizeDate('31.02.2024'), null);
    assert.equal(normalizeDate('0.5.2024'), null);
    assert.equal(normalizeDate('2024/02/30'), null);
  });

  it('kennt die Schaltjahre', () => {
    assert.equal(normalizeDate('2024-02-29'), '2024-02-29');
    assert.equal(normalizeDate('29.2.2000'), '2000-02-29');
    assert.equal(normalizeDate('2023-02-29'), null);
    assert.equal(normalizeDate('29.02.1900'), null);
  });
});

describe('Schnitt durch ein Surrogatpaar', () => {
  // '😀' ist ein Surrogatpaar: zwei UTF-16-Einheiten, ein Zeichen.
  it('sliceUnits laesst keine einsame High-Surrogate stehen', () => {
    assert.equal(sliceUnits('ab😀', 3), 'ab');
    assert.equal(sliceUnits('ab😀', 4), 'ab😀');
    assert.equal(sliceUnits('ab😀c', 4), 'ab😀');
    assert.equal(sliceUnits('abc', 0), '');
  });

  it('clampLine schneidet eine Einheit frueher und bleibt unter dem Limit', () => {
    const result = clampLine('x'.repeat(9) + '😀 Rest', 10);
    assert.equal(result, 'x'.repeat(9));
    assert.ok(result.length <= 10);
    assert.ok(!/[\uD800-\uDBFF]$/.test(result));
  });

  it('truncateAtSentence trennt beim harten Schnitt kein Emoji', () => {
    const result = truncateAtSentence('😀'.repeat(20), 11);
    assert.equal(result.text, '😀'.repeat(5));
    assert.ok(result.text.length <= 11);
    assert.equal(result.truncated, true);
  });
});

describe('Kleinkram', () => {
  it('collapseWhitespace', () => {
    assert.equal(collapseWhitespace('  a \n  b\t c '), 'a b c');
    assert.equal(collapseWhitespace(null), '');
  });

  it('macht aus einzelnen Umbruechen Leerzeichen, aus doppelten Absaetze', () => {
    // Soft-Wrap (Browser-Umbuch, <br>, eingerueckter Quelltext) -> Leerzeichen.
    assert.equal(tidyParagraphs('eins\nzwei'), 'eins zwei');
    // echter Absatz bleibt.
    assert.equal(tidyParagraphs('eins\n\nzwei'), 'eins\n\nzwei');
    // mehr als eine Leerzeile -> genau eine.
    assert.equal(tidyParagraphs('eins\n\n\n\nzwei'), 'eins\n\nzwei');
  });

  it('fasst zusammenhaengenden Fliesstext aus mehreren Quellzeilen zusammen', () => {
    // So sieht echtes HTML aus: ein Logik-Absatz, ueber mehrere Zeilen eingrueckt.
    assert.equal(
      tidyParagraphs('  Die Versammlung wurde\n  um 19:30 Uhr\n  durch den Gemeindepräsidenten eröffnet.  '),
      'Die Versammlung wurde um 19:30 Uhr durch den Gemeindepräsidenten eröffnet.',
    );
  });

  it('behält mehrere Absaetze und glaettet jeden einzelnen', () => {
    assert.equal(
      tidyParagraphs('a\n\n\n\nb\n  c  '),
      'a\n\nb c',
    );
  });

  it('normalisiert CRLF und Soft-Wraps zusammen', () => {
    assert.equal(tidyParagraphs('eins\r\nzwei\r\n\r\n drei'), 'eins zwei\n\ndrei');
  });

  it('leerer/falscher Input ergibt Leerstring', () => {
    assert.equal(tidyParagraphs(''), '');
    assert.equal(tidyParagraphs(null), '');
    assert.equal(tidyParagraphs('   \n  \n  '), '');
  });

  it('clampLine kuerzt hart auf die Titellaenge', () => {
    assert.equal(clampLine('x'.repeat(400)).length, 300);
    assert.equal(clampLine('  a  b '), 'a b');
  });

  it('isoDate arbeitet in lokaler Zeit', () => {
    assert.equal(isoDate(new Date(2026, 0, 5)), '2026-01-05');
  });
});
