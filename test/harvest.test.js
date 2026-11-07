/**
 * Metadaten-Ernte gegen gespeicherte HTML-Fixtures.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectJsonLdNodes,
  guessCslType,
  harvestMetadata,
  pickJsonLdArticle,
  plausibleCanonical,
} from '../src/content/extract-meta.js';
import { splitTitleAffix, stripTitleAffix } from '../src/content/title-affix.js';
import { harvestBylineNames } from '../src/content/byline.js';
import { JSDOM } from 'jsdom';
import { loadFixture } from './helpers/dom.js';

const FIXED_NOW = new Date(2026, 6, 31); // 2026-07-31, lokale Zeit

describe('Ernte: Wissenschaftsverlag mit citation_*', () => {
  const url = 'https://press.example.org/articles/jfs-2019-0417?utm_campaign=toc';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('publisher-citation.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('bevorzugt citation_title vor og:title und DC.title', () => {
    assert.equal(meta.title, 'Sediment transport under partial ice cover');
    assert.equal(meta.provenance.title, 'citation');
  });

  it('nimmt alle citation_author und zerlegt sie', () => {
    assert.deepEqual(meta.authors, [
      { family: 'Halvorsen', given: 'Ingrid M.' },
      { family: 'Okonkwo', given: 'Chidi' },
      { family: 'van der Meer', given: 'Jan' },
    ]);
    assert.equal(meta.provenance.authors, 'citation');
  });

  it('nimmt das Journal als container_title', () => {
    assert.equal(meta.containerTitle, 'Journal of Fluvial Studies');
    assert.equal(meta.publisher, 'Northfield Academic Press');
  });

  it('zieht Datum und Jahr aus citation_publication_date, nicht aus article:published_time', () => {
    assert.equal(meta.publishedDate, '2019-04-17');
    assert.equal(meta.year, 2019);
  });

  it('findet das DOI', () => {
    assert.equal(meta.doi, '10.1234/jfs.2019.0417');
  });

  it('loest citation_pdf_url absolut auf und erkennt gleiche Herkunft', () => {
    assert.equal(meta.pdfUrl, 'https://press.example.org/articles/jfs-2019-0417/pdf');
    assert.equal(meta.pdfSameOrigin, true);
  });

  it('raet den CSL-Typ article', () => {
    assert.equal(meta.cslType, 'article');
  });

  it('normalisiert die URL auf die kanonische Fassung ohne Tracking', () => {
    assert.equal(meta.normalizedUrl, 'https://press.example.org/articles/jfs-2019-0417');
  });

  it('setzt accessed_at auf heute', () => {
    assert.equal(meta.accessedAt, '2026-07-31');
  });
});

describe('Ernte: Nachrichtenseite mit JSON-LD', () => {
  const url = 'https://abendpost.example.ch/stadt/seeufer-entscheid-verschoben';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('news-jsonld.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt headline aus dem NewsArticle-Knoten, nicht og:title', () => {
    assert.equal(meta.title, 'Stadtrat verschiebt Entscheid über Seeufer');
    assert.equal(meta.provenance.title, 'jsonld');
  });

  it('findet den Artikel-Knoten auch im @graph neben einer Organization', () => {
    assert.deepEqual(meta.authors, [
      { family: 'Stauffer', given: 'Miriam' },
      { family: 'Dubois', given: 'Léon' },
    ]);
  });

  it('erkennt den Verlag als Koerperschaft statt ihn zu zerlegen', () => {
    assert.equal(meta.publisher, 'Abendpost Verlag AG');
  });

  it('nimmt datePublished, nicht dateModified', () => {
    assert.equal(meta.publishedDate, '2024-06-11');
    assert.equal(meta.year, 2024);
  });

  it('faellt fuer den Website-Namen auf og:site_name zurueck', () => {
    assert.equal(meta.siteName, 'Abendpost');
  });

  it('bleibt beim CSL-Typ website', () => {
    assert.equal(meta.cslType, 'website');
    assert.equal(meta.containerTitle, 'Abendpost');
  });
});

describe('Ernte: Blog nur mit OpenGraph', () => {
  const url = 'https://kestrel.example.net/posts/standing-desk';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('blog-og.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt og:title', () => {
    assert.equal(meta.title, 'Why I stopped using a standing desk');
    assert.equal(meta.provenance.title, 'opengraph');
  });

  it('zerlegt article:author', () => {
    assert.deepEqual(meta.authors, [{ family: 'Raghunathan', given: 'Priya' }]);
  });

  it('nimmt article:published_time', () => {
    assert.equal(meta.publishedDate, '2023-11-02');
    assert.equal(meta.year, 2023);
  });

  it('putzt die Tracking-Parameter aus der og:url', () => {
    assert.equal(meta.canonicalUrl, 'https://kestrel.example.net/posts/standing-desk?utm_source=rss');
    assert.equal(meta.normalizedUrl, 'https://kestrel.example.net/posts/standing-desk');
  });

  it('findet kein DOI und keine ISBN', () => {
    assert.equal(meta.doi, '');
    assert.equal(meta.isbn, '');
  });
});

describe('Ernte: nackte Seite ohne Metadaten', () => {
  const url = 'https://gemeinde-fallstadt.example.ch/protokolle/2024-05-03.html';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('bare.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('faellt auf document.title zurueck', () => {
    assert.equal(meta.title, 'Protokoll der Gemeindeversammlung vom 3. Mai');
    assert.equal(meta.provenance.title, 'fallback');
  });

  it('findet keine Personen statt welche zu erfinden', () => {
    assert.deepEqual(meta.authors, []);
  });

  it('nimmt den Hostnamen als Website-Namen', () => {
    assert.equal(meta.siteName, 'gemeinde-fallstadt.example.ch');
  });

  it('laesst das Jahr leer, statt eine Zahl aus dem Text zu raten', () => {
    assert.equal(meta.publishedDate, '');
    assert.equal(meta.year, null);
  });

  it('bleibt bei website', () => {
    assert.equal(meta.cslType, 'website');
  });
});

describe('Ernte: Dublin Core', () => {
  const url = 'https://repo.example.edu/eintrag/88421';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('dublincore.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt DC.title, weil weder citation_* noch JSON-LD da sind', () => {
    assert.equal(meta.title, 'Zur Rezeption der Lex Salica im Frühmittelalter');
    assert.equal(meta.provenance.title, 'dublincore');
  });

  it('zerlegt mehrere DC.creator, auch mit Sonderzeichen', () => {
    assert.deepEqual(meta.authors, [
      { family: 'Brenner', given: 'Anne-Sophie' },
      { family: 'Ó Súilleabháin', given: 'Cormac' },
    ]);
  });

  it('nimmt DCTERMS.issued', () => {
    assert.equal(meta.publishedDate, '2011-09-30');
    assert.equal(meta.year, 2011);
  });

  it('zieht die ISBN aus DC.identifier und schaltet auf book um', () => {
    assert.equal(meta.isbn, '9783161484100');
    assert.equal(meta.cslType, 'book');
  });
});

describe('Ernte: Wikipedia (MediaWiki)', () => {
  const url = 'https://de.wikipedia.org/wiki/Fallstadter_Seeufer';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('mediawiki.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt den Titel aus h1#firstHeading, nicht die Kurzbeschreibung aus JSON-LD headline', () => {
    assert.equal(meta.title, 'Fallstadter Seeufer');
    assert.equal(meta.provenance.title, 'site');
    assert.equal(meta.description, 'Uferabschnitt am Fallstadter See, Schweiz');
  });

  it('nimmt den Stand der Version, nicht das Anlagedatum des Artikels', () => {
    // Ohne dateModified im JSON-LD bleibt der Fusszeilen-Stand; sein Monat
    // ist lokalisiert, das Jahr genuegt der Quelle.
    assert.equal(meta.year, 2026);
    assert.equal(meta.provenance.date, 'site');
  });

  it('setzt keinen Autor — auch nicht die Koerperschaft aus JSON-LD', () => {
    assert.deepEqual(meta.authors, []);
    assert.equal(meta.provenance.authors, undefined);
  });

  it('macht den Artikel nicht wegen der Literaturliste zum Buch', () => {
    assert.equal(meta.isbn, '');
    assert.equal(meta.doi, '');
    assert.equal(meta.cslType, 'website');
  });

  it('nennt Wikipedia als Website und Container, die Foundation als Verlag', () => {
    assert.equal(meta.siteName, 'Wikipedia');
    assert.equal(meta.containerTitle, 'Wikipedia');
    assert.equal(meta.publisher, 'Wikimedia Foundation, Inc.');
  });

  it('liefert den Permalink der gelesenen Fassung, zitiert aber kanonisch', () => {
    assert.equal(meta.permalink, 'https://de.wikipedia.org/w/index.php?title=Fallstadter_Seeufer&oldid=245001337');
    assert.equal(meta.normalizedUrl, 'https://de.wikipedia.org/wiki/Fallstadter_Seeufer');
  });

  it('bevorzugt dateModified aus JSON-LD, wenn es da ist', async () => {
    const doc = await loadFixture('mediawiki.html', url);
    const script = /** @type {Element} */ (doc.querySelector('script[type="application/ld+json"]'));
    const node = JSON.parse(script.textContent || '');
    node.dateModified = '2025-12-30T08:00:00Z';
    script.textContent = JSON.stringify(node);
    assert.equal(harvestMetadata(doc, { url, now: FIXED_NOW }).publishedDate, '2025-12-30');
  });

  it('laesst das Datum leer statt das Anlagedatum zu nehmen, wenn kein Stand da ist', async () => {
    const doc = await loadFixture('mediawiki.html', url);
    doc.getElementById('footer-info-lastmod')?.remove();
    const bare = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(bare.publishedDate, '');
    assert.equal(bare.year, null);
  });

  it('loest den Permalink der Mobilansicht auf die Desktop-Adresse auf', async () => {
    const mobile = 'https://de.m.wikipedia.org/wiki/Fallstadter_Seeufer';
    const doc = await loadFixture('mediawiki.html', mobile);
    const m = harvestMetadata(doc, { url: mobile, now: FIXED_NOW });
    assert.equal(m.permalink, 'https://de.wikipedia.org/w/index.php?title=Fallstadter_Seeufer&oldid=245001337');
  });

  it('nimmt einen kursiven Anzeigetitel als Klartext', async () => {
    const doc = await loadFixture('mediawiki.html', url);
    const h1 = /** @type {Element} */ (doc.getElementById('firstHeading'));
    h1.innerHTML = '<i>Ufer und Stadt</i> (Buch)';
    doc.title = 'Ufer und Stadt (Buch) – Wikipedia';
    const m = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(m.title, 'Ufer und Stadt (Buch)');
    assert.equal(m.siteName, 'Wikipedia');
  });

  it('greift ohne MediaWiki-Generator nicht', async () => {
    const doc = await loadFixture('mediawiki.html', url);
    doc.querySelector('meta[name="generator"]')?.remove();
    const m = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.notEqual(m.provenance.title, 'site');
    assert.equal(m.permalink, '');
  });
});

describe('Ernte: WordPress ohne SEO-Plugin', () => {
  const url = 'https://kestrel.example.net/2025/03/seeufer/';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('wordpress.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt die Ueberschrift mit Dachzeile, wenn og:title sie weglaesst', () => {
    assert.equal(meta.title, 'Querbau: Warum das Seeufer nicht fertig wird');
    assert.equal(meta.provenance.title, 'opengraph');
  });

  it('liest die Autorin aus dem Post-Author-Block, nicht aus Kommentar oder verwandten Beitraegen', () => {
    assert.deepEqual(meta.authors, [{ family: 'Raghunathan', given: 'Priya' }]);
    assert.equal(meta.provenance.authors, 'fallback');
  });

  it('datiert nach dem Beitrag, nicht nach dem Kommentar', () => {
    assert.equal(meta.publishedDate, '2025-03-14');
    assert.equal(meta.provenance.date, 'fallback');
  });

  it('haelt eine Beitragsnummer im Text nicht fuer eine ISBN', () => {
    assert.equal(meta.isbn, '');
    assert.equal(meta.cslType, 'website');
    assert.equal(meta.containerTitle, 'Kestrel Notes');
  });
});

describe('Ernte: HubSpot-Blog mit @id-Verweisen im JSON-LD', () => {
  const url = 'https://blog.abendpost.example.ch/seeufer-planung';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('hubspot.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('loest den Autor-Verweis auf den Person-Knoten auf', () => {
    assert.deepEqual(meta.authors, [{ family: 'Stauffer', given: 'Miriam' }]);
    assert.equal(meta.provenance.authors, 'jsonld');
  });

  it('loest den Verlag auf, statt die @id-Adresse einzutragen', () => {
    assert.equal(meta.publisher, 'Abendpost Verlag AG');
  });

  it('nimmt den WebSite-Knoten als Website-Namen und die eigene WebPage nicht als Container', () => {
    assert.equal(meta.siteName, 'Abendpost Blog');
    assert.equal(meta.containerTitle, 'Abendpost Blog');
    assert.equal(meta.cslType, 'website');
  });

  it('haelt eine Nummer mit zufaellig gueltiger Pruefziffer nicht fuer eine ISBN', () => {
    assert.equal(meta.isbn, '');
  });

  it('liest die HubSpot-Autorenzeile ohne „von", wenn JSON-LD keinen Autor nennt', async () => {
    const doc = await loadFixture('hubspot.html', url);
    doc.querySelector('script[type="application/ld+json"]')?.remove();
    const m = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.deepEqual(m.authors, [{ family: 'Dubois', given: 'Léon' }]);
  });
});

describe('Ernte: Tageszeitung mit SEO-Titel und Platzhalter-Autor', () => {
  const url = 'https://www.abendpost.example.ch/stadt/seeufer-ld.10025303';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('newspaper.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('nimmt die gedruckte Ueberschrift statt der SEO-Fassung mit gleichem Stichwort', () => {
    assert.equal(meta.title, 'Das Fallstadter Seeufer: Warum die Stadt seit elf Jahren plant und nie baut');
    assert.equal(meta.provenance.title, 'jsonld');
  });

  it('ueberspringt den Platzhalter im JSON-LD und nimmt meta[name=author]', () => {
    assert.deepEqual(meta.authors, [{ family: 'Stauffer', given: 'Miriam' }]);
    assert.equal(meta.provenance.authors, 'opengraph');
  });

  it('haelt das Paywall-Produkt nicht fuer die Zeitschrift', () => {
    assert.equal(meta.cslType, 'website');
    assert.equal(meta.containerTitle, 'Abendpost');
  });

  it('laesst den Metadaten-Titel stehen, wenn die h1 nichts mit ihm teilt', async () => {
    const doc = await loadFixture('newspaper.html', url);
    doc.querySelector('article h1')?.remove();
    doc.querySelector('header')?.insertAdjacentHTML('afterbegin', '<h1>Abendpost</h1>');
    assert.equal(harvestMetadata(doc, { url, now: FIXED_NOW }).title, 'Das Fallstadter Seeufer: Planung ohne Ende');
  });

  it('setzt keine Zeitung als ihren eigenen Autor', async () => {
    // Wie beim Economist: anonym nach Hausstil, author = publisher.
    const doc = await loadFixture('newspaper.html', url);
    doc.querySelector('meta[name="author"]')?.remove();
    const script = /** @type {Element} */ (doc.querySelector('script[type="application/ld+json"]'));
    const node = JSON.parse(script.textContent || '');
    node.author = { '@type': 'NewsMediaOrganization', name: 'Abendpost' };
    script.textContent = JSON.stringify(node);
    assert.deepEqual(harvestMetadata(doc, { url, now: FIXED_NOW }).authors, []);
  });

  it('behaelt eine benannte Redaktion als Koerperschaft', async () => {
    const doc = await loadFixture('newspaper.html', url);
    doc.querySelector('meta[name="author"]')?.remove();
    const script = /** @type {Element} */ (doc.querySelector('script[type="application/ld+json"]'));
    const node = JSON.parse(script.textContent || '');
    node.author = { '@type': 'Organization', name: 'Redaktion Abendpost Stadt' };
    script.textContent = JSON.stringify(node);
    assert.deepEqual(harvestMetadata(doc, { url, now: FIXED_NOW }).authors, [{ literal: 'Redaktion Abendpost Stadt' }]);
  });
});

describe('Ernte: Magazin mit Entities im JSON-LD und CSS-Modul-Byline', () => {
  const url = 'https://nbr.example.org/2026/01/why-teams-stop-collaborating';
  /** @type {any} */
  let meta;

  it('liest die Fixture', async () => {
    const doc = await loadFixture('magazine.html', url);
    meta = harvestMetadata(doc, { url, now: FIXED_NOW });
  });

  it('dekodiert HTML-Entities aus JSON-LD', () => {
    assert.equal(meta.title, 'Why Teams Stop “Collaborating”—and What Helps');
    assert.equal(meta.description, 'It isn’t the tools. It’s the mandate.');
  });

  it('liest die Autor:innen aus der Byline, nicht doppelt aus dem Bio-Kasten', () => {
    assert.deepEqual(meta.authors, [
      { family: 'Halvorsen', given: 'Ingrid' },
      { family: 'Okonkwo', given: 'Chidi' },
    ]);
    assert.equal(meta.provenance.authors, 'fallback');
  });
});

describe('Autorenzeile aus dem Markup', () => {
  /** @param {string} body */
  const names = (body) => harvestBylineNames(new JSDOM(`<body>${body}</body>`).window.document);

  it('verlangt beim allgemeinen Selektor, dass die Klasse auf author-name endet', () => {
    // netzpolitik.org: der Kasten enthaelt Name UND Datum.
    assert.deepEqual(names('<div class="np-intro-author-name-dates">Carla Siepmann 27. September 2026</div>'), []);
    assert.deepEqual(names('<div class="blog-hero-1__author-name">von Tobias Ellenberger</div>'), ['Tobias Ellenberger']);
  });

  it('streicht Einleitungen wie „Written by:"', () => {
    assert.deepEqual(names('<span class="hs-author-name">Written by: Priya Raghunathan</span>'), ['Priya Raghunathan']);
  });

  it('nimmt keine URL und keinen Biografie-Kasten', () => {
    assert.deepEqual(names('<a rel="author">https://kestrel.example.net/author/priya/</a>'), []);
    assert.deepEqual(names(`<div class="entry-author">${'Sehr lange Biografie '.repeat(10)}</div>`), []);
  });

  it('sammelt mehrere Autor:innen desselben Selektors', () => {
    assert.deepEqual(
      names('<span class="wp-block-post-author-name">Miriam Stauffer</span><span class="wp-block-post-author-name">Léon Dubois</span>'),
      ['Miriam Stauffer', 'Léon Dubois'],
    );
  });
});

describe('Site-Namen am Titel', () => {
  it('schneidet og:title und <title> ab, wenn der Rest der Ueberschrift gleicht', async () => {
    const url = 'https://kestrel.example.net/posts/standing-desk';
    const doc = await loadFixture('blog-og.html', url);
    doc.querySelector('meta[property="og:title"]')?.remove();
    const meta = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(meta.title, 'Why I stopped using a standing desk');
  });

  it('trennt per Ueberschrift, auch ohne bekannten Site-Namen', () => {
    assert.deepEqual(splitTitleAffix('Seeufer-Entscheid – Abendpost', { heading: 'Seeufer-Entscheid' }), {
      head: 'Seeufer-Entscheid',
      site: 'Abendpost',
    });
  });

  it('trennt per bekanntem Site-Namen, auch als Anfangsstueck', () => {
    assert.equal(
      stripTitleAffix('Sediment transport | Journal of Fluvial Studies', {
        siteNames: ['Journal of Fluvial Studies Online'],
      }),
      'Sediment transport',
    );
  });

  it('erkennt den Site-Namen vorne', () => {
    assert.equal(stripTitleAffix('Abendpost | Seeufer-Entscheid', { siteNames: ['Abendpost'] }), 'Seeufer-Entscheid');
  });

  it('nimmt Host-Labels nur exakt', () => {
    assert.equal(stripTitleAffix('Seeufer – Abendpost', { hostNames: ['abendpost', 'example'] }), 'Seeufer');
    assert.equal(
      stripTitleAffix('Repositorium – Eintrag 88421', { hostNames: ['repo', 'example'] }),
      'Repositorium – Eintrag 88421',
    );
  });

  it('laesst einen Gedankenstrich im Werktitel stehen', () => {
    assert.equal(
      stripTitleAffix('Krieg und Frieden – eine Relektüre', { heading: 'Lesenotizen', siteNames: ['Kestrel Notes'] }),
      'Krieg und Frieden – eine Relektüre',
    );
  });

  it('trennt nie am Doppelpunkt', () => {
    assert.equal(stripTitleAffix('Abendpost: Seeufer', { siteNames: ['Abendpost'] }), 'Abendpost: Seeufer');
  });
});

describe('DOI aus dem Fliesstext', () => {
  it('greift nur, wenn keine Meta-Angabe existiert', async () => {
    const url = 'https://example.org/paper';
    const doc = await loadFixture('bare.html', url);
    doc.body.insertAdjacentHTML(
      'beforeend',
      '<p>Zitieren als doi:10.5555/abc-123.4 (Stand Mai).</p>',
    );
    const meta = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(meta.doi, '10.5555/abc-123.4');
    assert.equal(meta.provenance.doi, 'fallback');
    // Mit DOI, aber ohne ISBN: Zeitschriftenartikel.
    assert.equal(meta.cslType, 'article');
  });
});

describe('guessCslType', () => {
  it('ISBN schlaegt DOI', () => {
    assert.equal(guessCslType({ isbn: '9783161484100', doi: '10.1/x' }), 'book');
  });

  it('JSON-LD-Typ schlaegt alles', () => {
    assert.equal(guessCslType({ isbn: '9783161484100', jsonLdTypes: ['thesis'] }), 'thesis');
    assert.equal(guessCslType({ jsonLdTypes: ['ScholarlyArticle'.toLowerCase()] }), 'article');
  });

  it('ohne Anhaltspunkt: website', () => {
    assert.equal(guessCslType({}), 'website');
  });
});

describe('Ernte: Profil-URL, Handle und E-Mail sind keine Personen', () => {
  const url = 'https://schreibwerkstatt.example.com/blog/beitrag';

  /** @param {string} head */
  async function harvest(head) {
    const { JSDOM } = await import('jsdom');
    const html = `<!doctype html><html><head><title>Beitrag</title>${head}</head><body></body></html>`;
    const doc = new JSDOM(html, { url, contentType: 'text/html' }).window.document;
    return harvestMetadata(doc, { url, now: FIXED_NOW });
  }

  it('wirft die Profil-URL aus article:author, behaelt den Namen aus author', async () => {
    const meta = await harvest(`
      <meta property="article:author" content="https://www.facebook.com/redaktion.beispiel" />
      <meta name="author" content="Priya Raghunathan" />`);
    assert.deepEqual(meta.authors, [{ family: 'Raghunathan', given: 'Priya' }]);
  });

  it('wirft Handle und E-Mail-Adresse', async () => {
    const meta = await harvest(`
      <meta name="twitter:creator" content="@redaktion_beispiel" />
      <meta name="author" content="redaktion@schreibwerkstatt.example.com" />
      <meta name="author" content="www.schreibwerkstatt.example.com/team/priya" />`);
    assert.deepEqual(meta.authors, []);
    assert.equal(meta.provenance.authors, undefined);
  });

  it('bleibt nur eine URL, kommt die naechste Schicht zum Zug', async () => {
    const meta = await harvest(`
      <meta name="citation_author" content="https://orcid.org/0000-0002-1825-0097" />
      <meta name="DC.creator" content="Halvorsen, Ingrid M." />`);
    assert.deepEqual(meta.authors, [{ family: 'Halvorsen', given: 'Ingrid M.' }]);
    assert.equal(meta.provenance.authors, 'dublincore');
  });

  it('laesst Koerperschaften und Namen mit Sonderzeichen stehen', async () => {
    const meta = await harvest(`<meta name="author" content="Redaktion Beispiel-Zeitung" />`);
    assert.equal(meta.authors.length, 1);
  });
});

/**
 * @param {string} url
 * @param {string} head
 * @param {string} [body]
 */
function inlineDoc(url, head, body = '') {
  const html = `<!doctype html><html><head><title>Beitrag</title>${head}</head><body>${body}</body></html>`;
  return new JSDOM(html, { url, contentType: 'text/html' }).window.document;
}

describe('Kanonische Adresse auf Plausibilitaet pruefen', () => {
  const url = 'https://blog.schreibwerkstatt.example.com/2024/artikel-a';

  it('verwirft rel=canonical auf die Startseite', () => {
    const meta = harvestMetadata(inlineDoc(url, '<link rel="canonical" href="/" />'), { url, now: FIXED_NOW });
    assert.equal(meta.canonicalUrl, '');
    assert.equal(meta.provenance.canonicalUrl, undefined);
    assert.equal(meta.normalizedUrl, 'https://blog.schreibwerkstatt.example.com/2024/artikel-a');
  });

  it('verwirft einen Praefix-Pfad und einen fremden Host, nimmt dann die naechste Schicht', () => {
    const meta = harvestMetadata(
      inlineDoc(
        url,
        `<meta property="og:url" content="https://blog.schreibwerkstatt.example.com/2024/" />
         <link rel="canonical" href="https://www.blog.schreibwerkstatt.example.com/2024/artikel-a/" />`,
      ),
      { url, now: FIXED_NOW },
    );
    assert.equal(meta.canonicalUrl, 'https://www.blog.schreibwerkstatt.example.com/2024/artikel-a/');
    assert.equal(meta.provenance.canonicalUrl, 'fallback');
  });

  it('plausibleCanonical im Einzelnen', () => {
    assert.equal(plausibleCanonical('https://andere.example.com/2024/artikel-a', url), null);
    assert.equal(plausibleCanonical('https://blog.schreibwerkstatt.example.com/', url), null);
    assert.equal(plausibleCanonical('https://blog.schreibwerkstatt.example.com/2024', url), null);
    // Gleiche Tiefe, anderer Pfad (umbenannter Slug): bleibt.
    const renamed = 'https://blog.schreibwerkstatt.example.com/2024/artikel-a-neu';
    assert.equal(plausibleCanonical(renamed, url), renamed);
    // Nur Praefix auf Zeichenebene, nicht auf Segmentebene: bleibt.
    const longer = 'https://blog.schreibwerkstatt.example.com/2024/artikel';
    assert.equal(plausibleCanonical(longer, url), longer);
    assert.equal(plausibleCanonical(longer, 'https://blog.schreibwerkstatt.example.com/2024/artikel-a/teil-2'), longer);
    // Echter Segment-Praefix eines tieferen Pfads: verworfen.
    assert.equal(plausibleCanonical(url, `${url}/teil-2`), null);
    // Startseite auf der Startseite ist in Ordnung.
    const root = 'https://schreibwerkstatt.example.com/';
    assert.equal(plausibleCanonical(root, 'https://www.schreibwerkstatt.example.com/?ref=x'), root);
    assert.equal(plausibleCanonical(null, url), null);
  });

  it('verwirft auch eine JSON-LD-url auf die Startseite', () => {
    const meta = harvestMetadata(
      inlineDoc(
        url,
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'BlogPosting',
          headline: 'Artikel A',
          url: 'https://blog.schreibwerkstatt.example.com/',
        })}</script>`,
      ),
      { url, now: FIXED_NOW },
    );
    assert.equal(meta.title, 'Artikel A');
    assert.equal(meta.canonicalUrl, '');
  });
});

describe('JSON-LD: der Artikel der Seite, nicht ein verwandter', () => {
  const url = 'https://schreibwerkstatt.example.com/2024/artikel-a';

  it('bevorzugt den Artikel auf oberster Ebene vor einem aus hasPart', () => {
    const data = {
      '@type': 'CollectionPage',
      hasPart: [{ '@type': 'NewsArticle', headline: 'Verwandt' }],
    };
    const own = { '@type': 'NewsArticle', headline: 'Eigener Artikel' };
    const doc = inlineDoc(
      url,
      `<script type="application/ld+json">${JSON.stringify(data)}</script>
       <script type="application/ld+json">${JSON.stringify(own)}</script>`,
    );
    assert.equal(pickJsonLdArticle(collectJsonLdNodes(doc), url)?.headline, 'Eigener Artikel');
    assert.equal(harvestMetadata(doc, { url, now: FIXED_NOW }).title, 'Eigener Artikel');
  });

  it('nimmt unter mehreren den, dessen url zur Seite passt', () => {
    const graph = {
      '@graph': [
        { '@type': 'Article', headline: 'Andere Seite', url: 'https://schreibwerkstatt.example.com/2024/artikel-b' },
        {
          '@type': 'Article',
          headline: 'Diese Seite',
          mainEntityOfPage: { '@type': 'WebPage', '@id': 'https://www.schreibwerkstatt.example.com/2024/artikel-a/' },
        },
      ],
    };
    const doc = inlineDoc(url, `<script type="application/ld+json">${JSON.stringify(graph)}</script>`);
    assert.equal(pickJsonLdArticle(collectJsonLdNodes(doc), url)?.headline, 'Diese Seite');
    // Ohne Seiten-URL: der erste, wie bisher.
    assert.equal(pickJsonLdArticle(collectJsonLdNodes(doc))?.headline, 'Andere Seite');
  });

  it('ein verschachtelter Artikel genuegt, wenn es keinen anderen gibt', () => {
    const page = { '@type': 'WebPage', mainEntity: { '@type': 'Article', headline: 'Hauptinhalt' } };
    const doc = inlineDoc(url, `<script type="application/ld+json">${JSON.stringify(page)}</script>`);
    assert.equal(pickJsonLdArticle(collectJsonLdNodes(doc), url)?.headline, 'Hauptinhalt');
  });
});

describe('DOI und ISBN nur aus sichtbarem Text', () => {
  const url = 'https://schreibwerkstatt.example.com/2024/artikel-a';

  it('ignoriert script, style, noscript, template und nav', () => {
    const doc = inlineDoc(
      url,
      '',
      `<script>var cfg = { doi: "10.1234/aus-dem-skript" };</script>
       <style>/* 10.1234/aus-dem-stylesheet */</style>
       <noscript>doi:10.1234/aus-noscript ISBN 978-3-16-148410-0</noscript>
       <template><p>10.1234/aus-template</p></template>
       <nav>Siehe 10.1234/aus-der-navigation</nav>
       <p>Kein Bezeichner hier.</p>`,
    );
    const meta = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(meta.doi, '');
    assert.equal(meta.isbn, '');
  });

  it('findet sie weiterhin im Fliesstext', () => {
    const doc = inlineDoc(
      url,
      '',
      '<script>10.1234/falsch</script><p>doi:10.5555/richtig, ISBN 978-3-16-148410-0</p>',
    );
    const meta = harvestMetadata(doc, { url, now: FIXED_NOW });
    assert.equal(meta.doi, '10.5555/richtig');
    assert.equal(meta.isbn, '9783161484100');
    // Das Seiten-DOM bleibt unberuehrt.
    assert.equal(doc.querySelectorAll('script').length, 1);
  });
});

