import { fakerEN, fakerES } from '@faker-js/faker';

// ── What can be generated ──────────────────────────────────────────────

/**
 * The two locales that ship inside the page. They are the only ones offered
 * because the data is what costs the bytes: `en` is roughly 288 KB on its own
 * and `es` adds about 20 KB, while each of the seventy other locales would add
 * its own chunk. The pair is picked because between them they cover the two
 * languages the tool is written in.
 *
 * Both locales expose exactly the same namespaces and the same methods, so the
 * catalog below is written once and never has to be filtered per locale. They
 * are not the same data, though: faker composes them as the ordered chain
 * `[es, en, base]`, and anything `es` does not define quietly comes back in
 * English. `finance.iban` is the clearest case, it is a helper resolved against
 * `base` and returns a Belgian IBAN under both locales, so the locale selector
 * must not be advertised as translating every generator.
 */
export type TextLocale = 'en' | 'es';

export const FAKE: Record<TextLocale, typeof fakerEN> = { en: fakerEN, es: fakerES };

/**
 * The namespaces worth offering, and the methods kept from each one.
 *
 * Every entry here is verified against the installed faker by the test, which
 * is the only reason the list can be trusted: faker's methods are reached by
 * string at runtime, so a name that is one version off is a crash in the page
 * and not a compile error.
 *
 * The test also requires each one to actually return something. That is a
 * stricter rule than it sounds: a method can run perfectly well with no
 * arguments and still be useless here, because it is a transform waiting for
 * its input. `helpers.slugify` and `helpers.mustache` both take a string and
 * returned an empty one when called with nothing, which is why `helpers` is
 * gone from the list entirely rather than trimmed.
 */
export const CATEGORIES = {
  lorem: { label: 'Lorem', gens: ['word', 'words', 'sentence', 'sentences', 'paragraph', 'paragraphs', 'text', 'slug'] },
  person: { label: 'Person', gens: ['fullName', 'firstName', 'lastName', 'middleName', 'gender', 'jobTitle', 'jobArea', 'jobDescriptor', 'jobType', 'prefix', 'suffix', 'bio', 'zodiacSign'] },
  internet: { label: 'Internet', gens: ['email', 'exampleEmail', 'username', 'displayName', 'password', 'url', 'domainName', 'domainWord', 'domainSuffix', 'ip', 'ipv4', 'ipv6', 'mac', 'httpMethod', 'httpStatusCode', 'userAgent', 'protocol', 'port', 'emoji', 'jwt'] },
  location: { label: 'Location', gens: ['city', 'country', 'countryCode', 'state', 'county', 'continent', 'street', 'streetAddress', 'secondaryAddress', 'postalAddress', 'zipCode', 'buildingNumber', 'latitude', 'longitude', 'timeZone', 'language', 'direction'] },
  company: { label: 'Company', gens: ['name', 'catchPhrase', 'catchPhraseAdjective', 'catchPhraseDescriptor', 'catchPhraseNoun', 'buzzPhrase', 'buzzAdjective', 'buzzNoun', 'buzzVerb'] },
  commerce: { label: 'Commerce', gens: ['product', 'productName', 'productDescription', 'productMaterial', 'productAdjective', 'price', 'department', 'isbn', 'upc'] },
  phone: { label: 'Phone', gens: ['number', 'imei'] },
  date: { label: 'Date', gens: ['past', 'future', 'recent', 'soon', 'anytime', 'birthdate', 'month', 'weekday'] },
  finance: { label: 'Finance', gens: ['accountName', 'accountNumber', 'amount', 'currencyCode', 'currencyName', 'currencySymbol', 'creditCardNumber', 'creditCardCVV', 'creditCardIssuer', 'iban', 'bic', 'routingNumber', 'pin', 'transactionType', 'transactionDescription', 'ethereumAddress', 'bitcoinAddress', 'litecoinAddress'] },
  string: { label: 'IDs', gens: ['uuid', 'nanoid', 'ulid', 'alphanumeric', 'alpha', 'numeric', 'hexadecimal', 'octal', 'binary', 'symbol', 'sample'] },
  color: { label: 'Color', gens: ['human', 'rgb', 'hsl', 'hwb', 'cmyk', 'lab', 'lch'] },
  number: { label: 'Number', gens: ['int', 'float', 'bigInt', 'binary', 'octal', 'hex', 'romanNumeral'] },
  word: { label: 'Word', gens: ['adjective', 'adverb', 'conjunction', 'interjection', 'noun', 'preposition', 'verb', 'sample'] },
  git: { label: 'Git', gens: ['commitSha', 'commitMessage', 'commitDate', 'branch', 'commitEntry'] },
  system: { label: 'System', gens: ['fileName', 'filePath', 'fileType', 'fileExt', 'commonFileName', 'commonFileType', 'commonFileExt', 'directoryPath', 'mimeType', 'semver', 'cron', 'networkInterface'] },
  database: { label: 'Database', gens: ['column', 'type', 'engine', 'collation', 'mongodbObjectId'] },
  vehicle: { label: 'Vehicle', gens: ['manufacturer', 'model', 'vin', 'vrm', 'fuel', 'type', 'color', 'bicycle'] },
  airline: { label: 'Airline', gens: ['flightNumber', 'airline', 'airport', 'seat', 'recordLocator', 'aircraftType'] },
  book: { label: 'Book', gens: ['title', 'author', 'genre', 'format', 'publisher', 'series'] },
  music: { label: 'Music', gens: ['songName', 'artist', 'genre', 'album'] },
  food: { label: 'Food', gens: ['dish', 'description', 'ingredient', 'spice', 'fruit', 'vegetable', 'meat', 'adjective', 'ethnicCategory'] },
  animal: { label: 'Animal', gens: ['dog', 'cat', 'bird', 'fish', 'horse', 'rabbit', 'bear', 'snake', 'insect', 'crocodilia', 'cetacean', 'cow', 'lion', 'rodent', 'petName', 'type'] },
  science: { label: 'Science', gens: ['chemicalElement', 'unit'] },
  datatype: { label: 'Data type', gens: ['boolean'] },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
export type GeneratorName = (typeof CATEGORIES)[CategoryKey]['gens'][number];

/** A `category.generator` pair, the identity every selection is stored as. */
export type GeneratorKey = `${CategoryKey}.${GeneratorName}`;

export const GENERATORS: GeneratorKey[] = (Object.keys(CATEGORIES) as CategoryKey[]).flatMap(
  (cat) => CATEGORIES[cat].gens.map((gen) => `${cat}.${gen}` as GeneratorKey),
);

export function generatorLabel(key: GeneratorKey): string {
  return `${CATEGORIES[categoryOf(key)].label} · ${prettify(methodOf(key))}`;
}

export function categoryOf(key: GeneratorKey): CategoryKey {
  return key.slice(0, key.indexOf('.')) as CategoryKey;
}

/** The bare method name of a `category.generator` key, with no cast needed. */
export function methodOf(key: GeneratorKey): string {
  return key.slice(key.indexOf('.') + 1);
}

/** Turns a camelCase faker method into the words a picker should show. */
function prettify(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// ── Presets ────────────────────────────────────────────────────────────

/**
 * One column of a preset. `gen` says what to call and `as` names the column;
 * they differ only where the field name would be a poor label on its own, such
 * as `lorem.sentence` rendering as a column simply called `sentence`.
 */
export interface PresetField {
  gen: GeneratorKey;
  as: string;
}

export interface Preset {
  label: string;
  fields: PresetField[];
}

export const PRESETS: Record<string, Preset> = {
  sentence: {
    label: 'One sentence',
    fields: [{ gen: 'lorem.sentence', as: 'sentence' }],
  },
  paragraph: {
    label: 'Paragraph',
    fields: [
      { gen: 'lorem.sentence', as: 'title' },
      { gen: 'lorem.paragraphs', as: 'body' },
    ],
  },
  user: {
    label: 'User profile',
    fields: [
      { gen: 'person.fullName', as: 'name' },
      { gen: 'internet.email', as: 'email' },
      { gen: 'internet.username', as: 'username' },
      { gen: 'person.jobTitle', as: 'job' },
      { gen: 'phone.number', as: 'phone' },
      { gen: 'location.streetAddress', as: 'street' },
      { gen: 'location.city', as: 'city' },
      { gen: 'location.country', as: 'country' },
      { gen: 'location.zipCode', as: 'zip' },
    ],
  },
  company: {
    label: 'Company',
    fields: [
      { gen: 'company.name', as: 'name' },
      { gen: 'company.buzzPhrase', as: 'tagline' },
      { gen: 'company.catchPhraseDescriptor', as: 'catchphrase' },
      { gen: 'company.buzzAdjective', as: 'adjective' },
      { gen: 'company.buzzNoun', as: 'noun' },
      { gen: 'location.city', as: 'city' },
      { gen: 'location.country', as: 'country' },
      { gen: 'internet.domainName', as: 'domain' },
    ],
  },
  product: {
    label: 'Product',
    fields: [
      { gen: 'commerce.productName', as: 'name' },
      { gen: 'commerce.department', as: 'department' },
      { gen: 'commerce.price', as: 'price' },
      { gen: 'commerce.productMaterial', as: 'material' },
      { gen: 'commerce.productDescription', as: 'description' },
    ],
  },
  address: {
    label: 'Address',
    fields: [
      { gen: 'person.fullName', as: 'name' },
      { gen: 'location.streetAddress', as: 'street' },
      { gen: 'location.city', as: 'city' },
      { gen: 'location.state', as: 'state' },
      { gen: 'location.zipCode', as: 'zip' },
      { gen: 'location.country', as: 'country' },
      { gen: 'location.latitude', as: 'latitude' },
      { gen: 'location.longitude', as: 'longitude' },
    ],
  },
  payment: {
    label: 'Payment',
    fields: [
      { gen: 'person.fullName', as: 'name' },
      { gen: 'finance.creditCardNumber', as: 'card' },
      { gen: 'finance.creditCardIssuer', as: 'issuer' },
      { gen: 'finance.creditCardCVV', as: 'cvv' },
      { gen: 'finance.iban', as: 'iban' },
      { gen: 'finance.bic', as: 'bic' },
      { gen: 'finance.accountName', as: 'accountName' },
      { gen: 'finance.accountNumber', as: 'account' },
      { gen: 'finance.routingNumber', as: 'routing' },
      { gen: 'finance.currencyCode', as: 'currency' },
      { gen: 'finance.amount', as: 'amount' },
    ],
  },
  api: {
    label: 'API response',
    fields: [
      { gen: 'string.uuid', as: 'id' },
      { gen: 'person.fullName', as: 'name' },
      { gen: 'internet.email', as: 'email' },
      { gen: 'internet.username', as: 'username' },
      { gen: 'person.jobTitle', as: 'job' },
      { gen: 'company.name', as: 'company' },
      { gen: 'location.city', as: 'city' },
      { gen: 'location.country', as: 'country' },
      { gen: 'internet.ip', as: 'ip' },
      { gen: 'date.past', as: 'createdAt' },
    ],
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);

/**
 * The pseudo-preset that hands the picker back to the person. It is deliberately
 * not in `PRESETS`: the picker needs a selected option to mean "no bundle, use
 * the category and the generator I picked", and an empty value would make the
 * control look unset. Everything that reads the preset treats this name as the
 * absence of one.
 */
export const CUSTOM_PRESET = 'custom';

/** True when the spec asks for a bare generator rather than a bundle. */
function isCustom(spec: { preset: string }): boolean {
  return spec.preset === CUSTOM_PRESET || !(spec.preset in PRESETS);
}


// ── Generating ─────────────────────────────────────────────────────────

export interface TextSpec {
  preset: string;
  category: CategoryKey;
  generator: GeneratorKey;
  locale: TextLocale;
  count: number;
  format: TextFormat;
  /** What goes between the fields of one row in the text format. */
  separator: string;
  /** What goes between the columns in the CSV format. */
  delimiter: string;
}

export const TEXT_FORMATS = ['plain', 'json', 'csv', 'md'] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];

export interface TextFormatInfo {
  label: string;
  extension: string;
  mime: string;
}

export const TEXT_FORMAT_INFO: Record<TextFormat, TextFormatInfo> = {
  plain: { label: 'Text', extension: 'txt', mime: 'text/plain' },
  json: { label: 'JSON', extension: 'json', mime: 'application/json' },
  csv: { label: 'CSV', extension: 'csv', mime: 'text/csv' },
  md: { label: 'Markdown', extension: 'md', mime: 'text/markdown' },
};

/**
 * The named separators for the text format. The picker offers words rather than
 * the characters themselves because a literal newline in the value of an
 * `<option>` is invisible in the markup and impossible to tell from a space.
 */
export const SEPARATORS: Record<string, string> = {
  newline: '\n',
  comma: ',',
  semicolon: ';',
  tab: '\t',
  space: ' ',
};

/** The named delimiters for the CSV format, on the same terms. */
export const DELIMITERS: Record<string, string> = {
  semicolon: ';',
  comma: ',',
  tab: '\t',
  pipe: '|',
};

/**
 * The delimiter characters, in the order they are offered.
 *
 * The form speaks in names because an `<option value="tab">` is readable, but an
 * agent should be handed the characters: `;` says what it is and `semicolon`
 * would have to be translated. This is the list the WebMCP schema advertises,
 * and it is derived rather than written twice so the two cannot drift.
 */
export const DELIMITER_CHOICES: string[] = Object.values(DELIMITERS);

/** The option name for a delimiter character, e.g. `;` becomes `semicolon`. */
export function delimiterKey(char: string): string | undefined {
  return Object.keys(DELIMITERS).find((key) => DELIMITERS[key] === char);
}

/**
 * What separates one row from the next in the text format.
 *
 * Without it a preset with several fields is unreadable: three user profiles
 * come out as twenty-seven consecutive lines and there is nothing to say where
 * one record stops. Three dashes are what a person reading a terminal already
 * expects, and they survive a paste into anything.
 */
export const ROW_RULE = '---';

export const COUNT_MIN = 1;
export const COUNT_MAX = 1000;
export const DEFAULT_COUNT = 10;

/** One generated record: a preset column name to its generated value. */
export type Row = Record<string, string>;

/**
 * Calls one faker method. The lookup is on purpose: the catalog is data, so a
 * name that does not exist cannot be caught by the type checker and would only
 * surface as a crash inside the page. `test/text-generators.test.ts` walks the
 * whole catalog against the real faker so that cannot reach a build.
 */
function call(fake: typeof fakerEN, key: GeneratorKey): unknown {
  const namespace = (fake as unknown as Record<string, Record<string, unknown>>)[categoryOf(key)];
  const fn = namespace?.[methodOf(key)];
  if (typeof fn !== 'function') throw new Error(`Unknown generator: ${key}`);
  return fn.call(namespace);
}

/** Coerces whatever a generator returned into text, since rows are strings. */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  // `helpers.*` and a few `internet.*` methods hand back richer shapes, and a
  // JSON string is the honest way to show one without inventing a table layout
  // for it.
  return JSON.stringify(value);
}

/**
 * Produces `count` records. A preset gives one row per iteration with a column
 * per field; a bare generator gives one column whose header is the generator
 * itself, which is what makes the tabular formats usable for both.
 */
export function generateRows(spec: TextSpec): Row[] {
  const fake = FAKE[spec.locale];
  const preset = isCustom(spec) ? undefined : PRESETS[spec.preset];
  const fields: PresetField[] = preset
    ? preset.fields
    : [{ gen: spec.generator, as: methodOf(spec.generator) }];

  const rows: Row[] = [];
  for (let i = 0; i < spec.count; i++) {
    const row: Row = {};
    for (const field of fields) row[field.as] = toText(call(fake, field.gen));
    rows.push(row);
  }
  return rows;
}

/** The column headers of a row set, in the order they were generated. */
function columnsOf(rows: Row[]): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : [];
}

// ── Formatting ─────────────────────────────────────────────────────────

/**
 * Escapes a value for a CSV cell.
 *
 * What forces quotes depends on the delimiter: RFC 4180 asks for quotes around
 * anything holding the delimiter, a quote or a line break, and a value with a
 * comma is harmless in a semicolon-separated file. Quoting is always safe, so
 * the delimiter only decides the threshold, never whether quoting is allowed.
 */
function csvCell(value: string, delimiter: string): string {
  const needs = value.includes(delimiter) || /["\n\r]/.test(value);
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Escapes a value for a Markdown table cell, where a pipe would open a column. */
function mdCell(value: string): string {
  return value.replace(/([|\\])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/**
 * True when every value in a column parses as a number, money included.
 *
 * A column of prices should sit right-aligned under its header: that is what
 * makes a Markdown table read as a table, and it is the one hint that survives
 * in the raw text a person is about to paste.
 */
function isNumericColumn(values: string[]): boolean {
  // Strict on purpose. An earlier version allowed up to three trailing letters
  // for currency codes, and that swallowed `12B`: a column of ZIP codes with
  // one stray letter would have been right-aligned, which is a claim that they
  // are quantities. Only a sign, digits with their separators, and a percent.
  return values.every((v) => /^[-+]?[0-9][0-9.,]*\s*%?$/.test(v));
}

/**
 * Renders rows as a Markdown table, padded so the pipes line up.
 *
 * Markdown does not care about the padding and GitHub renders both the same.
 * The person does: this is the source they are about to paste into a README,
 * and a table whose columns wobble is much harder to read or edit than one
 * that does not. Numeric columns go right-aligned, with the colon the syntax
 * asks for in the rule underneath.
 */
function mdTable(rows: Row[]): string {
  const cols = columnsOf(rows);
  if (!cols.length) return '';
  const body = rows.map((row) => cols.map((c) => mdCell(row[c] ?? '')));
  const header = cols.map(mdCell);
  const numeric = cols.map((_, i) => isNumericColumn(body.map((row) => row[i] ?? '')));
  const widths = cols.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...body.map((row) => row[i]?.length ?? 0), 3),
  );

  const cell = (value: string, width: number, right: boolean) =>
    right ? value.padStart(width) : value.padEnd(width);
  const line = (values: string[]) =>
    `| ${values.map((v, i) => cell(v, widths[i] ?? 0, numeric[i] ?? false)).join(' | ')} |`;

  // The alignment colon has to sit on the outside edge of the cell, so a
  // right-aligned one is dashes then a colon and a left-aligned one is a colon
  // then dashes. Padding the token out to the column width with dashes on the
  // end would bury the colon in the middle, where Markdown reads it as another
  // dash and the alignment is silently lost.
  const rule = cols.map((_, i) => {
    const width = widths[i] ?? 3;
    const dashes = '-'.repeat(Math.max(1, width - 1));
    return numeric[i] ? `${dashes}:` : `:${dashes}`;
  });

  return [
    line(header),
    `| ${rule.join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
}

/** Renders rows as CSV, with a header row and no padding: spaces are data. */
function csvTable(rows: Row[], delimiter: string): string {
  const cols = columnsOf(rows);
  if (!cols.length) return '';
  const escape = (value: string) => csvCell(value, delimiter);
  const line = (values: string[]) => values.map(escape).join(delimiter);
  return [
    line(cols),
    ...rows.map((row) => line(cols.map((c) => row[c] ?? ''))),
  ].join('\n');
}

/**
 * Turns generated rows into the text that gets previewed, copied and saved.
 *
 * The tabular formats need a header, and a preset has one while a bare
 * generator would have nothing to name its single column after. The header is
 * always emitted and a bare generator is just a one-column table: the first
 * line carries the generator name and the rest are values, the same shape as a
 * preset with one field. Without it the output of `email` would be five lines
 * of email with no clue what they are, and neither could be opened in a
 * spreadsheet or pasted into a query.
 *
 * `plain` is the one that stays headerless, because it is the one meant for
 * pasting into a form field where a header row would be a mistake. It still
 * needs the row rule: a preset has several fields per record, and nothing in
 * a run of bare values says where one record ends.
 */
export function formatRows(
  rows: Row[],
  format: TextFormat,
  separator: string,
  delimiter: string,
): string {
  const cols = columnsOf(rows);

  switch (format) {
    case 'json':
      return JSON.stringify(rows, null, 2);
    case 'csv':
      return csvTable(rows, delimiter);
    case 'md':
      return mdTable(rows);
    case 'plain':
    default:
      return rows
        .map((row) =>
          cols.length > 1
            ? cols.map((c) => row[c] ?? '').join(separator)
            : (row[cols[0] ?? ''] ?? ''),
        )
        .join(`\n${ROW_RULE}\n`);
  }
}

/** The file name a download of this output gets. */
export function textFilename(spec: TextSpec): string {
  const ext = TEXT_FORMAT_INFO[spec.format].extension;
  const seed = isCustom(spec) ? spec.generator.replace('.', '-') : spec.preset;
  return `fake-${seed}.${ext}`;
}
