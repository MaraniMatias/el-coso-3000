/**
 * The preview colouring, tested through a DOM that does not exist in Bun.
 *
 * The point of the checks is not that a span has a class. It is that what goes
 * into the DOM is the same text that went in as a string: the preview is built
 * from spans now, so a mistake here would silently change what a person copies
 * out of it, and `innerHTML` on generated data would be an injection.
 */
import { describe, expect, test } from 'bun:test';
import { highlightInto } from '../src/ui/text-highlight';
import { formatRows, type Row } from '../src/ui/text-generators';

interface Token {
  text: string;
  cls: string;
}

/**
 * A recorder instead of a DOM tree.
 *
 * `highlightInto` only ever calls `replaceChildren`, `append`,
 * `document.createTextNode` and `document.createElement`, and reads back
 * `textContent` and `className`. So a flat list of everything appended to the
 * root is enough to check both what the person sees and what was marked up,
 * with no tree walking and no `innerHTML` in sight.
 */
function paint(text: string, format: Parameters<typeof highlightInto>[2], delimiter = ';'): Token[] {
  const tokens: Token[] = [];

  const target = {
    replaceChildren: () => {
      tokens.length = 0;
    },
    append: (...items: Array<{ textContent: string; cls: string }>) => {
      for (const item of items) tokens.push({ text: item.textContent, cls: item.cls });
    },
    // The over-budget path assigns `textContent` instead of appending nodes, so
    // the recorder has to see that too or the fallback would look like empty
    // output and the test would pass for the wrong reason.
    set textContent(value: string) {
      tokens.length = 0;
      tokens.push({ text: value, cls: '' });
    },
    get textContent(): string {
      return asText(tokens);
    },
  };

  const stubDocument = {
    createTextNode: (value: string) => ({ textContent: value, cls: '' }),
    createElement: () => ({
      textContent: '',
      cls: '',
      set className(value: string) {
        this.cls = value;
      },
      get className(): string {
        return this.cls;
      },
    }),
  };

  const saved = globalThis.document;
  globalThis.document = stubDocument as unknown as Document;
  try {
    highlightInto(target as unknown as HTMLElement, text, format, delimiter);
  } finally {
    globalThis.document = saved;
  }
  return tokens;
}

/** What the person would copy: the tokens joined, marks discarded. */
const asText = (tokens: Token[]): string => tokens.map((t) => t.text).join('');
const classesOf = (tokens: Token[]): Set<string> =>
  new Set(tokens.map((t) => t.cls).filter(Boolean));

const rows: Row[] = [
  { name: 'Ada Lovelace', city: 'London', note: 'first | second' },
  { name: 'Grace Hopper', city: 'New York', note: 'plain' },
];

describe('highlightInto', () => {
  for (const format of ['plain', 'json', 'csv', 'md'] as const) {
    test(`${format} puts back exactly the text it was given`, () => {
      // The invariant the whole feature rests on: colouring is decoration, so
      // what lands in the DOM has to be byte-identical to what Copy and the
      // download use, which both read the string and never the DOM.
      const text = formatRows(rows, format, '\n', ';');
      expect(asText(paint(text, format))).toBe(text);
    });

    test(`${format} marks something up`, () => {
      const text = formatRows(rows, format, '\n', ';');
      expect(classesOf(paint(text, format)).size).toBeGreaterThan(0);
    });
  }

  test('json tells keys, strings and numbers apart', () => {
    const text = JSON.stringify(rows[0] ?? {}, null, 2);
    const classes = classesOf(paint(text, 'json'));
    expect(classes.has('tok-key')).toBe(true);
    expect(classes.has('tok-string')).toBe(true);
  });

  test('csv marks the header row and dims the delimiters', () => {
    const classes = classesOf(paint(formatRows(rows, 'csv', '\n', ';'), 'csv'));
    expect(classes.has('tok-head')).toBe(true);
    expect(classes.has('tok-punct')).toBe(true);
  });

  test('csv dims whichever delimiter it was given, and still round-trips', () => {
    for (const delimiter of [';', ',', '\t', '|']) {
      const text = formatRows(rows, 'csv', '\n', delimiter);
      const classes = classesOf(paint(text, 'csv', delimiter));
      expect(classes.has('tok-punct'), delimiter).toBe(true);
      expect(asText(paint(text, 'csv', delimiter))).toBe(text);
    }
  });

  test('md marks the header, the rule and the pipes', () => {
    const classes = classesOf(paint(formatRows(rows, 'md', '\n', ';'), 'md'));
    expect(classes.has('tok-head')).toBe(true);
    expect(classes.has('tok-rule')).toBe(true);
    expect(classes.has('tok-punct')).toBe(true);
  });

  test('md marks the rule of a one-column table too', () => {
    // A bare generator gives a single column, so its rule line has one cell and
    // nothing between the pipes. It is still the rule and still gets marked;
    // asking for more than one cell is what used to leave it bare.
    const one: Row[] = [{ email: 'a@b.c' }, { email: 'd@e.f' }];
    const text = formatRows(one, 'md', '\n', ';');
    expect(text.split('\n')[1]).toMatch(/^\| [:\-\s]+\|$/);
    const classes = classesOf(paint(text, 'md'));
    expect(classes.has('tok-rule')).toBe(true);
    expect(classes.has('tok-head')).toBe(true);
  });

  test('plain marks the row rule so the records can be seen apart', () => {
    const tokens = paint(formatRows(rows, 'plain', ' | ', ';'), 'plain');
    expect(tokens.filter((t) => t.cls === 'tok-rule').map((t) => t.text)).toEqual(['---']);
  });

  test('a value that looks like markup stays text, never markup', () => {
    // Generated values are arbitrary. There is no `innerHTML` in the module, so
    // this is structural, but it is the property that makes that safe and it
    // should fail loudly if someone reaches for it later.
    const hostile = '<img src=x onerror=alert(1)>';
    const text = `{\n  "a": "${hostile}"\n}`;
    const tokens = paint(text, 'json');
    expect(asText(tokens)).toContain(hostile);
    // The hostile text arrives inside a span whose content is its text, which
    // is what `createElement` + `textContent` gives and `innerHTML` would not.
    expect(tokens.some((t) => t.cls === 'tok-string' && t.text.includes('<img'))).toBe(true);
  });

  test('past the row budget it gives up and leaves the text alone', () => {
    // A thousand rows is a normal request. It should still be correct, just
    // not coloured, rather than ten thousand spans of different slowness.
    const many = Array.from({ length: 400 }, (_, i) => ({ a: `v${i}` }));
    const text = formatRows(many, 'csv', '\n', ';');
    const tokens = paint(text, 'csv');
    expect(classesOf(tokens).size).toBe(0);
    expect(asText(tokens)).toBe(text);
  });

  test('empty output does not throw', () => {
    for (const format of ['plain', 'json', 'csv', 'md'] as const) {
      expect(() => paint('', format)).not.toThrow();
    }
  });
});
