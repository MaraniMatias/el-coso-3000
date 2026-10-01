/**
 * The metadata vocabulary and its three serializers.
 *
 * Every container writes the same object, so these tests check that the
 * serializers differ only in encoding: same facts, same order, no drift
 * between the flat layer and the XMP layer.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildMetadata,
  metadataAsPairs,
  metadataAsText,
  metadataAsXmp,
} from '../src/core/metadata';
import { checkContrast } from '../src/core/color';
import {
  APP_NAME,
  APP_VERSION,
  AUTHOR,
  LICENSE,
  REPO_URL,
  type Spec,
} from '../src/core/types';

const spec = (over: Partial<Spec> = {}): Spec => ({
  width: 1920,
  height: 495,
  bg: 'FEE2E2',
  fg: '991B1B',
  paletteName: 'red',
  duration: 0,
  fps: 30,
  showProgressBar: false,
  showTime: false,
  quality: 0.92,
  ...over,
});

/** Fixed clock: every assertion about dates or determinism depends on it. */
const NOW = new Date('2026-10-01T11:46:28+02:00');
const at = (s: Spec, quality?: number) =>
  buildMetadata(s, quality === undefined ? { now: NOW } : { now: NOW, quality });

const flat = (meta: ReturnType<typeof buildMetadata>) =>
  new Map(metadataAsPairs(meta));

describe('buildMetadata', () => {
  test('identity, license and provenance come from the core constants', () => {
    const meta = at(spec());
    expect(meta.software).toBe(APP_NAME);
    expect(meta.toolkit).toBe(`${APP_NAME} ${APP_VERSION}`);
    expect(meta.author).toBe(AUTHOR);
    expect(meta.copyright).toContain(AUTHOR);
    expect(meta.source).toBe(REPO_URL);
    expect(meta.license).toBe(LICENSE);
    expect(meta.licenseUrl).toBe(`${REPO_URL}/blob/main/LICENSE`);
  });

  test('the title and description name the actual dimensions', () => {
    const meta = at(spec());
    expect(meta.title).toBe('Placeholder 1920x495');
    expect(meta.description).toContain('1920x495');
    expect(meta.description).toContain('Still image.');
  });

  test('an animated placeholder says so instead of "still image"', () => {
    const meta = at(spec({ duration: 10 }));
    expect(meta.duration).toBe('10s');
    expect(meta.fps).toBe('30');
    expect(meta.description).toContain('10s at 30 fps');
    expect(meta.description).not.toContain('Still image.');
  });

  test('contrast is the same result the palette reports, not a second opinion', () => {
    const meta = at(spec());
    expect(meta.contrast).toEqual(checkContrast('991B1B', 'FEE2E2'));
    expect(meta.contrast.level).toBe('AA');
  });

  test('the drawn text is the label, or the dimensions when there is none', () => {
    expect(at(spec()).text).toBe('1920x495');
    // Newlines become spaces, because a value with one would break the `iTXt`
    // round-trip into a single line.
    expect(at(spec({ label: 'hola\n  mundo' })).text).toBe('hola mundo');
  });

  test('quality appears only when the caller passes it', () => {
    expect(at(spec()).quality).toBeUndefined();
    expect(flat(at(spec())).has('ElCoso3000:Quality')).toBe(false);
    expect(at(spec(), 0.92).quality).toBe('92%');
    expect(flat(at(spec(), 0.92)).get('ElCoso3000:Quality')).toBe('92%');
  });

  test('with a fixed clock the whole object is deterministic', () => {
    expect(at(spec({ duration: 3 }), 0.5)).toEqual(at(spec({ duration: 3 }), 0.5));
  });

  // AVI `INFO` and the GIF comment have no charset field, so a reader that
  // assumes Latin-1 may render UTF-8 text wrong. The fields the app controls
  // stay ASCII so that only the one field the user owns can be affected.
  test('the fields the app controls stay ASCII for charsetless containers', () => {
    const meta = at(spec({ label: 'Matías 😀' }), 0.92);
    const inCharsetlessContainer = metadataAsPairs(meta).filter(
      ([key]) => !key.startsWith('ElCoso3000:'),
    );
    const offenders = inCharsetlessContainer.filter(
      ([key, value]) => !/^[\x20-\x7e]+$/.test(key + value),
    );
    expect(offenders).toEqual([]);
  });

  // A label is user input: any Unicode, and lossy handling would misreport what
  // the file actually draws.
  test('a Unicode label is carried verbatim, not transliterated or dropped', () => {
    const meta = at(spec({ label: 'Matías 😀' }), 0.92);
    expect(flat(meta).get('ElCoso3000:Text')).toBe('Matías 😀');
    // Keywords stay ASCII: the PNG spec restricts them to Latin-1.
    for (const [key] of metadataAsPairs(meta))
      expect(key).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('metadataAsPairs', () => {
  const meta = at(spec(), 0.92);

  test('standard keywords come first, the app own ones behind a prefix', () => {
    const keys = metadataAsPairs(meta).map(([k]) => k);
    expect(keys.slice(0, 8)).toEqual([
      'Software',
      'Title',
      'Description',
      'Author',
      'Copyright',
      'Source',
      'Disclaimer',
      'Creation Time',
    ]);
    expect(keys.slice(8).every((k) => k.startsWith('ElCoso3000:'))).toBe(true);
  });

  test('no Comment: it only repeated Software', () => {
    expect(flat(meta).has('Comment')).toBe(false);
  });

  test('the technical data the export depends on is present', () => {
    expect(flat(meta).get('ElCoso3000:Placeholder')).toBe('1920x495');
    expect(flat(meta).get('ElCoso3000:Palette')).toBe('red');
    expect(flat(meta).get('ElCoso3000:Background')).toBe('#FEE2E2');
    expect(flat(meta).get('ElCoso3000:Contrast')).toBe('6.80:1 (AA)');
    expect(flat(meta).get('ElCoso3000:Text')).toBe('1920x495');
  });

  test('every keyword is legal for an iTXt chunk and unique', () => {
    const keys = metadataAsPairs(meta).map(([k]) => k);
    for (const key of keys) expect(key).toMatch(/^[!-~](?:[ -~]{0,77}[!-~])?$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('no keyword or value carries a NUL or a line break', () => {
    for (const [key, value] of metadataAsPairs(meta)) {
      expect(key).not.toMatch(/[\r\n\0]/);
      expect(value).not.toMatch(/[\r\n\0]/);
    }
  });

  test('the date is in the RFC 1123 layout of the PNG tIME chunk', () => {
    expect(flat(meta).get('Creation Time')).toMatch(
      /^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/,
    );
  });
});

describe('metadataAsText', () => {
  test('one line per pair, in the same order, with the prefix spelled out', () => {
    const meta = at(spec());
    const lines = metadataAsText(meta).split('\n');
    expect(lines).toHaveLength(metadataAsPairs(meta).length);
    expect(lines[0]).toBe(`Software: ${APP_NAME}`);
    expect(lines).toContain(`Source: ${REPO_URL}`);
    expect(lines).toContain(`El Coso 3000 Contrast: 6.80:1 (AA)`);
    expect(metadataAsText(meta)).not.toContain('ElCoso3000:');
  });

  test('every line of the block is a pair, so the two layers cannot drift', () => {
    for (const line of metadataAsText(at(spec())).split('\n')) {
      expect(line).toMatch(/^[^:]+(?:\s\d+)?: .+$/);
    }
  });
});

describe('metadataAsXmp', () => {
  const packet = new TextDecoder().decode(metadataAsXmp(at(spec())));
  /** Text of a property whose value is a plain literal. */
  const value = (property: string) =>
    new RegExp(`<${property}>(.*?)</${property}>`, 's').exec(packet)?.[1];
  /**
   * Text of a language alternative. A bare `<dc:title>text</dc:title>` is
   * well-formed XML and `exiftool` reads it, but it is not the form the XMP
   * schema describes, and a real RDF parser sees an empty value.
   */
  const alt = (property: string) =>
    new RegExp(`<${property}><rdf:Alt><rdf:li xml:lang="x-default">(.*?)</rdf:li>`, 's').exec(
      packet,
    )?.[1];

  test('tags balance from the opening to the closing xpacket', () => {
    expect(packet.startsWith('<?xpacket begin="" id="')).toBe(true);
    expect(packet.endsWith('<?xpacket end="w"?>')).toBe(true);
    // Every closing tag must close the innermost open one, and none may be
    // left open at the end: a mismatch here is what makes a reader drop the
    // whole packet instead of one property.
    const stack: string[] = [];
    let opened = 0;
    for (const m of packet.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)(?:\s[^>]*)?>/g)) {
      if (m[1] === '/') expect(stack.pop()).toBe(m[2]!);
      else if (!m[0].endsWith('/>')) {
        stack.push(m[2]!);
        opened++;
      }
    }
    expect(opened).toBeGreaterThan(10);
    expect(stack).toEqual([]);
  });

  test('declares the writer and the app namespace', () => {
    expect(packet).toContain(`x:xmptk="${APP_NAME} ${APP_VERSION}"`);
    expect(packet).toContain('xmlns:ec3k="https://github.com/MaraniMatias/el-coso-3000/ns/1.0/"');
    expect(value('xmp:CreatorTool')).toBe(APP_NAME);
  });

  test('standard properties carry the same facts as the flat layer', () => {
    const meta = at(spec());
    expect(alt('dc:title')).toBe(meta.title);
    expect(alt('dc:description')).toBe(meta.description);
    expect(alt('dc:rights')).toBe(meta.copyright);
    expect(value('dc:source')).toBe(meta.source);
    expect(alt('xmpRights:UsageTerms')).toBe(`${LICENSE} License`);
    expect(value('xmpRights:WebStatement')).toBe(meta.licenseUrl);
    expect(value('xmp:CreateDate')).toBe(NOW.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  });

  test('dc:creator is a sequence, which is the range it is defined with', () => {
    expect(value('dc:creator')).toBe(`<rdf:Seq><rdf:li>${AUTHOR}</rdf:li></rdf:Seq>`);
  });

  test('the disclaimer and the source both reach the packet', () => {
    const meta = at(spec());
    expect(value('ec3k:Disclaimer')).toBe(meta.disclaimer);
    expect(value('dc:source')).toBe(meta.source);
  });

  test('the technical data lives in the app namespace, not in dc or xmp', () => {
    expect(value('ec3k:Placeholder')).toBe('1920x495');
    expect(value('ec3k:Contrast')).toBe('6.80:1 (AA)');
    expect(packet).not.toContain('<dc:Contrast>');
  });

  test('escapes everything that would break the packet', () => {
    const nasty = new TextDecoder().decode(
      metadataAsXmp(at(spec({ label: `<b>&"x"</b>`, paletteName: 'a&b' }))),
    );
    expect(nasty).toContain('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
    // The only bare ampersands left are the ones that start an entity.
    expect(nasty.replace(/&(?:amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
  });

  test('no quality property when no quality was applied', () => {
    const clean = new TextDecoder().decode(metadataAsXmp(at(spec())));
    expect(clean).not.toContain('Quality');
    expect(new TextDecoder().decode(metadataAsXmp(at(spec(), 0.92)))).toContain(
      '<ec3k:Quality>92%</ec3k:Quality>',
    );
  });
});
