import { describe, expect, test } from 'bun:test';
import { fakerEN, fakerES } from '@faker-js/faker';
import {
  CATEGORIES,
  COUNT_MAX,
  FAKE,
  GENERATORS,
  PRESETS,
  PRESET_KEYS,
  TEXT_FORMATS,
  TEXT_FORMAT_INFO,
  categoryOf,
  formatRows,
  generateRows,
  generatorLabel,
  textFilename,
  type GeneratorKey,
  type TextSpec,
} from '../src/ui/text-generators';

// ── The catalog must match the faker that actually ships ───────────────
//
// The catalog is data, so a name that does not exist on the installed faker
// is not a type error: it is a crash inside the page, on whichever generator
// nobody opened before reloading. Every entry is walked against both locales
// so that cannot reach a build.

describe('generator catalog', () => {
  const entries: Array<[GeneratorKey, string]> = GENERATORS.map((key) => [key, key]);

  test('is not empty', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  for (const [key, label] of entries) {
    test(`${label} exists in en and es`, () => {
      for (const [locale, fake] of Object.entries(FAKE)) {
        const [cat, gen] = key.split('.');
        const ns = (fake as unknown as Record<string, Record<string, unknown>>)[cat!];
        const fn = ns?.[gen!] as (() => unknown) | undefined;
        expect(typeof fn, `${cat}.${gen} missing in ${locale}`).toBe('function');
        // And it has to survive being called, which is the part a `typeof`
        // check alone would not catch.
        expect(() => fn!.call(ns)).not.toThrow();
      }
    });

    // Not throwing is not the same as being useful. A method that takes no
    // arguments can still be a transform waiting for its input, and it will
    // hand back an empty string without complaining: `helpers.slugify` and
    // `helpers.mustache` both did, and the picker would have offered a
    // generator that produced nothing, every time, forever.
    //
    // Ten draws, because a generator can be empty by chance: `word.sample`
    // and the `hacker` verbs lean on small lookup lists. Only a method that is
    // empty on every single draw is a wrong entry in the catalog.
    test(`${label} produces something in en and es`, () => {
      for (const [locale, fake] of Object.entries(FAKE)) {
        const [cat, gen] = key.split('.');
        const ns = (fake as unknown as Record<string, Record<string, unknown>>)[cat!];
        const fn = ns?.[gen!] as (() => unknown) | undefined;
        const values = Array.from({ length: 10 }, () => fn!.call(ns));
        const nonEmpty = values.filter((value) => String(value ?? '').trim().length > 0);
        expect(nonEmpty.length, `${cat}.${gen} produced nothing in ${locale}`).toBeGreaterThan(0);
      }
    });
  }

  test('every category label is non-empty and unique', () => {
    const labels = Object.values(CATEGORIES).map((c) => c.label);
    expect(labels.every((l) => l.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('categoryOf round-trips', () => {
    for (const key of GENERATORS) {
      expect(`${categoryOf(key)}.${key.split('.')[1]}`).toBe(key);
    }
  });

  test('generatorLabel is human readable', () => {
    expect(generatorLabel('person.fullName')).toBe('Person · full Name');
    expect(generatorLabel('internet.email')).toBe('Internet · email');
  });
});

// ── Presets ────────────────────────────────────────────────────────────

describe('presets', () => {
  test('all eight ship and are non-empty', () => {
    expect(PRESET_KEYS).toEqual([
      'sentence', 'paragraph', 'user', 'company',
      'product', 'address', 'payment', 'api',
    ]);
    for (const key of PRESET_KEYS) {
      const preset = PRESETS[key]!;
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.fields.length).toBeGreaterThan(0);
    }
  });

  test('every preset field points at a real generator', () => {
    for (const key of PRESET_KEYS) {
      for (const field of PRESETS[key]!.fields) {
        expect(GENERATORS).toContain(field.gen);
        expect(field.as.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('no preset repeats a column name', () => {
    for (const key of PRESET_KEYS) {
      const names = PRESETS[key]!.fields.map((f) => f.as);
      expect(new Set(names).size, `${key} repeats a column`).toBe(names.length);
    }
  });
});

// ── Generating ─────────────────────────────────────────────────────────

function spec(over: Partial<TextSpec> = {}): TextSpec {
  return {
    preset: 'user',
    category: 'person',
    generator: 'person.fullName',
    locale: 'en',
    count: 3,
    format: 'plain',
    separator: ',',
    ...over,
  };
}

describe('generateRows', () => {
  test('a preset gives one row per iteration with every column', () => {
    const rows = generateRows(spec({ count: 4 }));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(PRESETS.user!.fields.map((f) => f.as));
      for (const value of Object.values(row)) expect(value.length).toBeGreaterThan(0);
    }
  });

  test('a bare generator gives a single named column', () => {
    const rows = generateRows(spec({ preset: '', generator: 'internet.email', count: 3 }));
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!)).toEqual(['email']);
    for (const row of rows) expect(row.email).toContain('@');
  });

  test('count is honoured', () => {
    for (const count of [1, 2, 7, COUNT_MAX]) {
      expect(generateRows(spec({ count }))).toHaveLength(count);
    }
  });

  test('count of zero yields nothing rather than throwing', () => {
    expect(generateRows(spec({ count: 0 }))).toEqual([]);
  });

  test('every value is a string, so rows survive JSON and CSV', () => {
    const rows = generateRows(spec({ count: 5 }));
    for (const row of rows) {
      for (const value of Object.values(row)) expect(typeof value).toBe('string');
    }
  });

  test('the spanish locale actually produces different data', () => {
    fakerEN.seed(7);
    fakerES.seed(7);
    const en = generateRows(spec({ locale: 'en', count: 20 })).map((r) => r.name);
    const es = generateRows(spec({ locale: 'es', count: 20 })).map((r) => r.name);
    expect(es).not.toEqual(en);
  });

  test('an unknown generator throws instead of returning undefined', () => {
    expect(() =>
      generateRows(spec({ preset: '', generator: 'person.nope' as GeneratorKey })),
    ).toThrow(/Unknown generator/);
  });

  test('an unknown preset falls back to the bare generator', () => {
    const rows = generateRows(spec({ preset: 'nope', generator: 'person.firstName', count: 2 }));
    expect(Object.keys(rows[0]!)).toEqual(['firstName']);
  });
});

// ── Formatting ─────────────────────────────────────────────────────────

const rows = [
  { name: 'Ada Lovelace', city: 'London', note: 'first | second' },
  { name: 'Grace Hopper', city: 'New York', note: 'plain' },
];

describe('formatRows', () => {
  test('plain is one value per line for a single column', () => {
    expect(formatRows([{ email: 'a@b.c' }, { email: 'd@e.f' }], 'plain', '\n'))
      .toBe('a@b.c\nd@e.f');
  });

  test('plain joins the columns of a preset with the separator, escaping nothing', () => {
    expect(formatRows(rows, 'plain', ' | ')).toBe(
      'Ada Lovelace | London | first | second\nGrace Hopper | New York | plain',
    );
  });

  test('json is a single object, array is every row', () => {
    expect(JSON.parse(formatRows(rows, 'json', '\n'))).toEqual(rows[0]);
    expect(JSON.parse(formatRows(rows, 'array', '\n'))).toEqual(rows);
  });

  test('csv has a header and quotes only what a comma would break', () => {
    const out = formatRows(rows, 'csv', '\n').split('\n');
    expect(out[0]).toBe('name,city,note');
    // A pipe is an ordinary character in CSV, unlike in a Markdown table.
    expect(out[1]).toBe('Ada Lovelace,London,first | second');
    expect(formatRows([{ a: 'x,y', b: 'z' }], 'csv', '\n').split('\n')[1]).toBe('"x,y",z');
  });

  test('csv has no Markdown underline row', () => {
    // A row of dashes would import into a spreadsheet as literal data.
    const out = formatRows(rows, 'csv', '\n').split('\n');
    expect(out).toHaveLength(rows.length + 1);
    expect(out.some((line) => /^-+(,-+)*$/.test(line))).toBe(false);
  });

  test('csv doubles embedded quotes and wraps newlines', () => {
    const out = formatRows([{ a: 'he said "hi"', b: 'x' }], 'csv', '\n').split('\n');
    expect(out[1]).toBe('"he said ""hi""",x');
  });

  test('markdown underlines its header and escapes pipes', () => {
    const out = formatRows(rows, 'md', '\n').split('\n');
    expect(out[0]).toBe('| name | city | note |');
    expect(out[1]).toBe('| --- | --- | --- |');
    expect(out[2]).toBe('| Ada Lovelace | London | first \\| second |');
    expect(out).toHaveLength(rows.length + 2);
    // Every line has to keep the same column count or the table is broken.
    for (const line of out) {
      expect(line.split(/(?<!\\)\|/).length).toBe(5);
    }
  });

  test('markdown flattens a newline inside a value', () => {
    const out = formatRows([{ a: 'one\ntwo' }], 'md', '\n');
    expect(out.split('\n')).toHaveLength(3);
  });

  test('no format throws on an empty result', () => {
    for (const format of TEXT_FORMATS) {
      expect(() => formatRows([], format, '\n')).not.toThrow();
    }
    expect(formatRows([], 'array', '\n')).toBe('[]');
    expect(formatRows([], 'json', '\n')).toBe('{}');
  });
});

describe('textFilename', () => {
  test('carries the format extension', () => {
    for (const format of TEXT_FORMATS) {
      expect(textFilename(spec({ format })).endsWith(`.${TEXT_FORMAT_INFO[format].extension}`)).toBe(true);
    }
  });

  test('names the preset, or the generator when there is none', () => {
    expect(textFilename(spec({ preset: 'user', format: 'json' }))).toBe('fake-user.json');
    expect(textFilename(spec({ preset: '', generator: 'person.fullName', format: 'csv' })))
      .toBe('fake-person-fullName.csv');
  });
});
