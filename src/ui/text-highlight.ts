/**
 * Colouring for the text preview.
 *
 * This is not a general syntax highlighter and does not pretend to be one. The
 * preview only ever shows four shapes it produced itself, so the rules are
 * written per format instead of guessed at: the app already knows which format
 * it rendered, and a highlighter that had to work that out from the content
 * would be guessing. `highlight.js` and friends would also add tens of
 * kilobytes to a file that is already 874 KB, to colour four things.
 *
 * Every node is built with `createElement` and filled with `textContent`.
 * Generated values are arbitrary strings and none of them is trusted, so
 * there is no `innerHTML` anywhere in this file: there is nothing to escape
 * and no way to get it wrong later.
 */
import type { TextFormat } from './text-generators';

/** How many rows get coloured. Past this the preview stays plain text. */
const MAX_HIGHLIGHT_ROWS = 200;

const CLASS = {
  key: 'tok-key',
  string: 'tok-string',
  number: 'tok-number',
  literal: 'tok-literal',
  head: 'tok-head',
  rule: 'tok-rule',
  punct: 'tok-punct',
} as const;

type TokenKind = keyof typeof CLASS;

interface Token {
  text: string;
  kind?: TokenKind;
}

const span = (parent: HTMLElement, text: string, kind?: TokenKind): void => {
  if (!kind) {
    parent.append(document.createTextNode(text));
    return;
  }
  const el = document.createElement('span');
  el.className = CLASS[kind];
  el.textContent = text;
  parent.append(el);
};

const emit = (parent: HTMLElement, tokens: Token[]): void => {
  for (const token of tokens) span(parent, token.text, token.kind);
};

/**
 * JSON: a key, then whatever follows it on the line.
 *
 * Done per line rather than by scanning the whole document because the output
 * is pretty-printed with two spaces, which puts exactly one key per line and
 * makes the line the natural unit.
 */
function jsonTokens(line: string): Token[] {
  const match = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)/.exec(line);
  if (!match) return [{ text: line }];
  const [, indent, key, colon] = match;
  const rest = line.slice(match[0].length);
  return [
    { text: indent ?? '' },
    { text: key ?? '', kind: 'key' },
    { text: colon ?? '', kind: 'punct' },
    ...valueTokens(rest),
  ];
}

/** The value half of a JSON line: a string, a number, or a bare literal. */
function valueTokens(text: string): Token[] {
  const out: Token[] = [];
  let rest = text;
  const parts = /("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = parts.exec(rest)) !== null) {
    if (match.index > last) out.push({ text: rest.slice(last, match.index) });
    const token = match[0];
    const kind: TokenKind | undefined = token.startsWith('"')
      ? 'string'
      : /^[+-]?\d/.test(token)
        ? 'number'
        : 'literal';
    out.push({ text: token, kind });
    last = match.index + token.length;
  }
  if (last < rest.length) out.push({ text: rest.slice(last) });
  return out;
}

/**
 * A delimited row. The separators are dimmed; the cells take the colour of
 * `cell`, which is how the header row of CSV and Markdown stands out from the
 * values under it.
 */
function delimitedTokens(line: string, delimiter: string, cell?: TokenKind): Token[] {
  if (!delimiter) return [{ text: line }];
  const out: Token[] = [];
  const push = (text: string, kind?: TokenKind): void => {
    // A line that starts or ends with the delimiter splits off an empty piece.
    // Emitting a span for it would be a node that renders nothing, copies
    // nothing and only shows up as noise in the markup.
    if (text.length > 0) out.push({ text, kind });
  };
  let last = 0;
  let index = line.indexOf(delimiter);
  while (index !== -1) {
    push(line.slice(last, index), cell);
    out.push({ text: delimiter, kind: 'punct' });
    last = index + delimiter.length;
    index = line.indexOf(delimiter, last);
  }
  push(line.slice(last), cell);
  return out;
}

/**
 * A Markdown rule line: the row of dashes and colons under the header.
 *
 * The leading and trailing pipes split off as empty cells, so they are dropped
 * before the test; without that, `| --- | --- |` has a blank piece at each end
 * and never qualifies. The test then only asks that there was a pipe at all and
 * that everything between them is dashes or colons. It must not require two
 * cells: a one-column table, which is what a bare generator produces, has a
 * rule line with a single cell and used to go uncoloured because of it.
 */
const isRuleLine = (line: string): boolean => {
  if (!line.includes('|')) return false;
  const cells = line.split('|').filter((cell) => cell.trim().length > 0);
  return cells.length > 0 && cells.every((cell) => /^[\s:-]+$/.test(cell));
};

/**
 * Paints the preview.
 *
 * The row budget is there because a hundred thousand `span` elements is a
 * different kind of slow: pasting a thousand rows is normal, and the first few
 * hundred are the ones anyone reads. Past the limit the text is put in as is,
 * which is still exactly what gets copied and downloaded.
 */
export function highlightInto(
  target: HTMLElement,
  text: string,
  format: TextFormat,
  delimiter: string,
): void {
  target.replaceChildren();
  const lines = text.split('\n');
  if (lines.length > MAX_HIGHLIGHT_ROWS) {
    target.textContent = text;
    return;
  }

  lines.forEach((line, index) => {
    if (index > 0) target.append(document.createTextNode('\n'));
    switch (format) {
      case 'json':
        emit(target, jsonTokens(line));
        return;
      case 'csv':
        emit(target, delimitedTokens(line, delimiter, index === 0 ? 'head' : undefined));
        return;
      case 'md': {
        if (index === 0) {
          emit(target, delimitedTokens(line, '|', 'head'));
          return;
        }
        if (isRuleLine(line)) {
          span(target, line, 'rule');
          return;
        }
        emit(target, delimitedTokens(line, '|'));
        return;
      }
      case 'plain':
      default:
        // The row rule is the one piece of structure in a headerless format,
        // so it is the one piece worth pointing at.
        if (line.trim() === '---') {
          span(target, line, 'rule');
          return;
        }
        span(target, line);
    }
  });
}
