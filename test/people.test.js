/**
 * Personen-Parsing. Leitfrage bei jedem Fall: lieber `literal` als falsch
 * zerlegt — ein Literal faellt im Literaturverzeichnis auf, ein vertauschter
 * Vor- und Nachname nicht.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatPeople, formatPerson, parsePeople, parsePerson } from '../src/shared/people.js';

describe('parsePerson: sichere Faelle', () => {
  it('Nachname, Vorname', () => {
    assert.deepEqual(parsePerson('Muster, Max'), { family: 'Muster', given: 'Max' });
  });

  it('Vorname Nachname', () => {
    assert.deepEqual(parsePerson('Max Muster'), { family: 'Muster', given: 'Max' });
  });

  it('Initialen bleiben beim Vornamen', () => {
    assert.deepEqual(parsePerson('J. R. R. Tolkien'), { family: 'Tolkien', given: 'J. R. R.' });
    assert.deepEqual(parsePerson('Tolkien, J. R. R.'), { family: 'Tolkien', given: 'J. R. R.' });
  });

  it('Doppelname mit Bindestrich', () => {
    assert.deepEqual(parsePerson('Anne-Sophie Brenner'), { family: 'Brenner', given: 'Anne-Sophie' });
  });

  it('diakritische Zeichen stoeren nicht', () => {
    assert.deepEqual(parsePerson('Léon Dubois'), { family: 'Dubois', given: 'Léon' });
    assert.deepEqual(parsePerson('Cormac Ó Súilleabháin'), {
      family: 'Súilleabháin',
      given: 'Cormac Ó',
    });
  });
});

describe('parsePerson: Namenspartikel', () => {
  it('nimmt das Partikel in den Nachnamen', () => {
    assert.deepEqual(parsePerson('Jan van der Meer'), { family: 'van der Meer', given: 'Jan' });
    assert.deepEqual(parsePerson('Ludwig von Beethoven'), { family: 'von Beethoven', given: 'Ludwig' });
    assert.deepEqual(parsePerson('Maria de la Cruz'), { family: 'de la Cruz', given: 'Maria' });
  });

  it('in Kommaform bleibt der Nachname unangetastet', () => {
    assert.deepEqual(parsePerson('van der Meer, Jan'), { family: 'van der Meer', given: 'Jan' });
  });
});

describe('parsePerson: Verlagsschreibweise mit Grossbuchstaben', () => {
  it('erkennt einen vorangestellten Nachnamen in Versalien', () => {
    assert.deepEqual(parsePerson('MUSTER Max'), { family: 'MUSTER', given: 'Max' });
  });

  it('erkennt einen nachgestellten Nachnamen in Versalien', () => {
    assert.deepEqual(parsePerson('Max MUSTER'), { family: 'MUSTER', given: 'Max' });
  });

  it('durchgaengige Versalien geben keinen Hinweis, also Regelfall', () => {
    assert.deepEqual(parsePerson('MAX MUSTER'), { family: 'MUSTER', given: 'MAX' });
  });
});

describe('parsePerson: bei Unsicherheit literal', () => {
  it('einzelner Name', () => {
    assert.deepEqual(parsePerson('Aristoteles'), { literal: 'Aristoteles' });
  });

  it('Suffixe machen die Zerlegung unsicher', () => {
    assert.deepEqual(parsePerson('Martin Luther King Jr.'), { literal: 'Martin Luther King Jr.' });
    assert.deepEqual(parsePerson('King, Jr.'), { literal: 'King, Jr.' });
    assert.deepEqual(parsePerson('Jane Goodall PhD'), { literal: 'Jane Goodall PhD' });
  });

  it('mehr als ein Komma', () => {
    assert.deepEqual(parsePerson('Muster, Max, Hrsg.'), { literal: 'Muster, Max, Hrsg.' });
  });

  it('Koerperschaften werden nicht zerlegt', () => {
    for (const name of [
      'Abendpost Verlag AG',
      'Universität Fallstadt',
      'Bundesamt für Statistik',
      'The Guardian',
      'Reuters Editorial Staff',
      'Max-Planck-Institut für Bildungsforschung',
    ]) {
      assert.deepEqual(parsePerson(name), { literal: name }, name);
    }
  });

  it('E-Mail und URL sind keine Namen', () => {
    assert.deepEqual(parsePerson('redaktion@example.org'), { literal: 'redaktion@example.org' });
  });

  it('leere Eingaben ergeben null', () => {
    assert.equal(parsePerson(''), null);
    assert.equal(parsePerson('   '), null);
    assert.equal(parsePerson(null), null);
    assert.equal(parsePerson(42), null);
  });
});

describe('parsePerson: Titel und Zusaetze', () => {
  it('entfernt fuehrende akademische Titel', () => {
    assert.deepEqual(parsePerson('Dr. Max Muster'), { family: 'Muster', given: 'Max' });
    assert.deepEqual(parsePerson('Prof. Dr. Eva Beispiel'), { family: 'Beispiel', given: 'Eva' });
  });

  it('entfernt Klammerzusaetze', () => {
    assert.deepEqual(parsePerson('Max Muster (Redaktion)'), { family: 'Muster', given: 'Max' });
  });

  it('uebernimmt bereits strukturierte Objekte', () => {
    assert.deepEqual(parsePerson({ family: 'Muster', given: 'Max' }), { family: 'Muster', given: 'Max' });
    assert.deepEqual(parsePerson({ '@type': 'Person', name: 'Max Muster' }), {
      family: 'Muster',
      given: 'Max',
    });
    assert.deepEqual(parsePerson({ literal: 'Abendpost' }), { literal: 'Abendpost' });
  });
});

describe('parsePeople: Listen', () => {
  it('Semikolon trennt', () => {
    assert.deepEqual(parsePeople('Muster, Max; Beispiel, Eva'), [
      { family: 'Muster', given: 'Max' },
      { family: 'Beispiel', given: 'Eva' },
    ]);
  });

  it('„und" / „and" / „&" trennen', () => {
    const expected = [
      { family: 'Muster', given: 'Max' },
      { family: 'Beispiel', given: 'Eva' },
    ];
    assert.deepEqual(parsePeople('Max Muster und Eva Beispiel'), expected);
    assert.deepEqual(parsePeople('Max Muster and Eva Beispiel'), expected);
    assert.deepEqual(parsePeople('Max Muster & Eva Beispiel'), expected);
  });

  it('ein einzelnes Komma bleibt eine Person', () => {
    assert.deepEqual(parsePeople('Muster, Max'), [{ family: 'Muster', given: 'Max' }]);
  });

  it('ein Komma zwischen zwei ganzen Namen trennt zwei Personen', () => {
    assert.deepEqual(parsePeople('Anna Bertram, Carl Dorn'), [
      { family: 'Bertram', given: 'Anna' },
      { family: 'Dorn', given: 'Carl' },
    ]);
  });

  it('ein Komma mit Partikel, Suffix oder halbem Namen bleibt eine Person', () => {
    assert.deepEqual(parsePeople('von Goethe, Johann Wolfgang'), [
      { family: 'von Goethe', given: 'Johann Wolfgang' },
    ]);
    assert.deepEqual(parsePeople('Muster, Max Johann'), [{ family: 'Muster', given: 'Max Johann' }]);
    assert.deepEqual(parsePeople('Muster, Dr. Max'), [{ family: 'Muster', given: 'Max' }]);
    assert.equal(parsePeople('Jan van der Meer, Anna Bertram').length, 1);
    assert.equal(parsePeople('Max Muster, Jr. Senior').length, 1);
  });

  it('„Nachname, Vorname"-Paare in einer Kommakette', () => {
    assert.deepEqual(parsePeople('Muster, Max, Beispiel, Eva'), [
      { family: 'Muster', given: 'Max' },
      { family: 'Beispiel', given: 'Eva' },
    ]);
  });

  it('„et al." faellt weg', () => {
    assert.deepEqual(parsePeople('Max Muster et al.'), [{ family: 'Muster', given: 'Max' }]);
  });

  it('Arrays von Strings und Objekten', () => {
    assert.deepEqual(parsePeople(['Muster, Max', { '@type': 'Person', name: 'Eva Beispiel' }]), [
      { family: 'Muster', given: 'Max' },
      { family: 'Beispiel', given: 'Eva' },
    ]);
  });

  it('entfernt Dubletten', () => {
    assert.deepEqual(parsePeople('Max Muster; Muster, Max'), [{ family: 'Muster', given: 'Max' }]);
  });

  it('leere Eingaben ergeben eine leere Liste', () => {
    assert.deepEqual(parsePeople(''), []);
    assert.deepEqual(parsePeople(null), []);
    assert.deepEqual(parsePeople([]), []);
  });
});

describe('Rueckwandlung', () => {
  it('formatPerson', () => {
    assert.equal(formatPerson({ family: 'Muster', given: 'Max' }), 'Muster, Max');
    assert.equal(formatPerson({ literal: 'Abendpost AG' }), 'Abendpost AG');
    assert.equal(formatPerson({ family: 'Muster' }), 'Muster');
  });

  it('formatPeople ist die Umkehrung von parsePeople', () => {
    const input = 'Muster, Max; Beispiel, Eva';
    assert.equal(formatPeople(parsePeople(input)), input);
  });
});

describe('JSON-LD-Verweise', () => {
  it('bildet eine Person mit givenName/familyName ohne name ab', () => {
    assert.deepEqual(parsePeople({ '@type': 'Person', givenName: 'Anna', familyName: 'Bertram' }), [
      { family: 'Bertram', given: 'Anna' },
    ]);
    assert.deepEqual(
      parsePeople({ '@type': 'Person', givenName: 'Anna', additionalName: 'Maria', familyName: 'Bertram' }),
      [{ family: 'Bertram', given: 'Anna Maria' }],
    );
    assert.deepEqual(parsePeople({ '@type': 'Person', familyName: 'Bertram' }), [{ family: 'Bertram', given: '' }]);
    assert.deepEqual(parsePeople({ '@type': 'Person', givenName: 'Anna' }), [{ literal: 'Anna' }]);
  });

  it('ein vorhandener name hat Vorrang vor givenName/familyName', () => {
    assert.deepEqual(parsePeople({ '@type': 'Person', name: 'Carl Dorn', givenName: 'X', familyName: 'Y' }), [
      { family: 'Dorn', given: 'Carl' },
    ]);
  });

  it('macht aus einem unaufgeloesten @id-Verweis keinen Namen', () => {
    assert.deepEqual(parsePeople({ '@type': 'Person', '@id': 'https://blog.example.com/#/schema/person/4711' }), []);
  });
});
