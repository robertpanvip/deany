import type * as ts from 'typescript';
import type { JsDocBlock, JsDocTag } from './types.js';

interface BracedType {
  readonly type: string;
  readonly rest: string;
}

const TAG_LINE = /^@([A-Za-z][A-Za-z0-9]*)\b\s*([\s\S]*)$/;

/** Known JSDoc tag names, used to find inline ` @tag` boundaries on one line. */
const KNOWN_TAGS = new Set([
  'param', 'returns', 'return', 'typedef', 'property', 'prop', 'callback',
  'template', 'this', 'type', 'enum', 'extends', 'implements', 'constructor',
  'class', 'memberof', 'readonly', 'abstract', 'override', 'deprecated',
  'see', 'link', 'example', 'throws', 'exception', 'yields', 'augments',
]);

/**
 * Split a single JSDoc line into multiple tag chunks when several tags appear
 * inline. Scans for ` @name` (space + at + known tag name) at brace depth 0 so
 * an `@` inside a `{...}` type or a word like `foo@bar` is not a boundary.
 */
function splitInlineTags(line: string): string[] {
  const starts: number[] = [0];
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '@' && depth === 0 && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      const name = /^@([A-Za-z][A-Za-z0-9]*)\b/.exec(line.slice(i));
      if (name !== null && KNOWN_TAGS.has(name[1] ?? '')) {
        starts.push(i);
      }
    }
  }
  if (starts.length === 1) {
    return [line];
  }
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : line.length;
    const part = line.slice(starts[i], end).trim();
    if (part.length > 0) {
      parts.push(part);
    }
  }
  return parts;
}

/** Split a JSDoc tag body into a leading balanced `{...}` type and the remainder. */
function takeBracedType(body: string): BracedType | undefined {
  const text = body.trimStart();
  if (text.length === 0 || text[0] !== '{') {
    return undefined;
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          type: text.slice(1, i).trim(),
          rest: text.slice(i + 1).trim(),
        };
      }
    }
  }
  return undefined;
}

/** Parse the name portion of `@param` / `@typedef` / `@callback`. */
function parseName(
  rest: string,
): Pick<JsDocTag, 'name' | 'optional' | 'variadic' | 'defaultValue' | 'description'> {
  let text = rest.trim();
  let optional = false;
  let variadic = false;
  let defaultValue: string | undefined;

  if (text.startsWith('[') && text.includes(']')) {
    const close = text.indexOf(']');
    const inside = text.slice(1, close);
    optional = true;
    const eq = inside.indexOf('=');
    if (eq >= 0) {
      defaultValue = inside.slice(eq + 1).trim();
      text = inside.slice(0, eq).trim() + text.slice(close + 1);
    } else {
      text = inside.trim() + text.slice(close + 1);
    }
    // A rest param may be written as `[...args]` (optional-looking brackets
    // around a variadic name). After stripping the brackets the leading `...`
    // must still mark it variadic; otherwise the name becomes literal `...args`
    // and the converter emits `...args: { length: number; }[]` with a
    // "no matching parameter" diagnostic.
    if (text.startsWith('...')) {
      variadic = true;
      text = text.slice(3).trim();
    }
  } else if (text.startsWith('...')) {
    variadic = true;
    text = text.slice(3).trim();
  }

  const match = /^([^\s,]+)\s*([\s\S]*)$/.exec(text);
  if (match === null) {
    return { optional, variadic, defaultValue, description: '' };
  }

  let description = (match[2] ?? '').trim();
  if (description.startsWith('-')) {
    description = description.slice(1).trim();
  }

  // Optional params written as `[name=default]` still describe an optional binding.
  return {
    name: match[1],
    optional,
    variadic,
    defaultValue,
    description,
  };
}

/** Parse one line that starts with `@tag`. */
function parseTagLine(line: string, raw: string): JsDocTag | undefined {
  const match = TAG_LINE.exec(line.trim());
  if (match === null) {
    return undefined;
  }
  const tag = match[1] ?? '';
  const body = (match[2] ?? '').trim();
  const braced = takeBracedType(body);

  if (tag === 'param' || tag === 'typedef' || tag === 'callback' || tag === 'property') {
    const parsed = parseName(braced?.rest ?? body);
    return {
      tag,
      typeText: braced?.type,
      name: parsed.name,
      optional: parsed.optional,
      variadic: parsed.variadic || (braced?.type.startsWith('...') ?? false),
      defaultValue: parsed.defaultValue,
      description: parsed.description,
      raw,
    };
  }

  let description = (braced?.rest ?? body).trim();
  if (description.startsWith('-')) {
    description = description.slice(1).trim();
  }
  return {
    tag,
    typeText: braced?.type,
    optional: false,
    variadic: false,
    description,
    raw,
  };
}

/**
 * Positions of `/**` that actually start a comment in code context. A plain
 * `indexOf` scan also matches the sequence inside a string, template literal
 * or regex (e.g. a string containing a fake JSDoc tag), which would make the
 * converter inject bogus type aliases from prose. This scanner skips quoted
 * strings, template literals (including dollar-brace expressions), regex
 * literals and line/block comments so only real JSDoc starts are used.
 */
function jsDocStarts(source: string): number[] {
  const starts: number[] = [];
  let i = 0;
  // Whether the next `/` could begin a regex (true at expression start) —
  // needed to avoid treating a division `/` as a regex that swallows a later
  // JSDoc. Conservative: when unsure we do not skip, so real JSDoc is kept.
  let regexAllowed = true;
  const n = source.length;
  while (i < n) {
    const ch = source[i] ?? '';
    const next = source[i + 1] ?? '';

    // Line comment: skip to newline.
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      regexAllowed = true;
      continue;
    }
    // JSDoc / block comment: record JSDoc starts, then skip the whole block.
    if (ch === '/' && next === '*') {
      if (source[i + 2] === '*') {
        starts.push(i);
      }
      const close = source.indexOf('*/', i + 2);
      i = close >= 0 ? close + 2 : n;
      continue;
    }
    // Single/double quoted string.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      regexAllowed = false;
      continue;
    }
    // Template literal: skip text; for `${...}` scan until its matching `}`
    // (nesting braces) before resuming the template.
    if (ch === '`') {
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '`') { i += 1; break; }
        if (source[i] === '$' && source[i + 1] === '{') {
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const c = source[i] ?? '';
            if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            else if (c === '"' || c === "'" || c === '`') {
              const q = c; i += 1;
              while (i < n && source[i] !== q) { if (source[i] === '\\') i += 1; i += 1; }
            }
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      regexAllowed = false;
      continue;
    }
    // Regex literal (only where a regex is syntactically allowed).
    if (ch === '/' && regexAllowed) {
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < n) {
        const c = source[i] ?? '';
        if (c === '\\') { i += 2; continue; }
        if (c === '[') { inClass = true; i += 1; continue; }
        if (c === ']') { inClass = false; i += 1; continue; }
        if (c === '/' && !inClass) { i += 1; closed = true; break; }
        if (c === '\n') { break; }
        i += 1;
      }
      if (closed) {
        while (i < n && /[gimsuyd]/.test(source[i] ?? '')) i += 1;
        regexAllowed = false;
        continue;
      }
      // Not a real regex — treat the `/` as an operator.
      i += 1;
      regexAllowed = true;
      continue;
    }

    if (!/\s/.test(ch)) {
      // An identifier/number/punctuation that can end an expression means a
      // following `/` is division, not regex. `return`/operators keep it open.
      regexAllowed = /[)\]}]/.test(ch);
    }
    i += 1;
  }
  return starts;
}

/** Scan a JavaScript source text and parse every JSDoc block with its offsets. */
export function parseJsDocBlocks(source: string): JsDocBlock[] {
  const blocks: JsDocBlock[] = [];
  const starts = jsDocStarts(source);

  for (const start of starts) {
    const end = source.indexOf('*/', start + 3);
    if (end < 0) {
      continue;
    }
    // A JSDoc block must not be part of a longer comment like `/****` or `x/**`.
    // A fourth `*` (`/****`) is a banner, not a JSDoc, at ANY position — check
    // it independently of the preceding character. The old guard chained it
    // behind `before.length > 0`, so a banner at file offset 0 (before === '')
    // short-circuited the whole test and leaked bogus typedefs (P1-8b).
    if (source[start + 3] === '*') {
      continue;
    }
    const before = start === 0 ? '' : source[start - 1] ?? '';
    if (before.length > 0 && !/\s/.test(before)) {
      continue;
    }

    const text = source.slice(start, end + 2);
    const inner = source.slice(start + 3, end);
    const lines = inner.split(/\r?\n/).map((line) =>
      line.replace(/^\s*\*\s?/, '').trimEnd(),
    );

    const descriptionLines: string[] = [];
    const tags: JsDocTag[] = [];
    let seenTag = false;

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.startsWith('@')) {
        // A single physical line can carry several JSDoc tags:
        // `@param {number} a @param {string} b @returns {boolean}`. Split it at
        // each ` @` boundary that begins a known tag so none are silently lost
        // (review 0.1.17 P1-5). Descriptions containing a literal ` @` are rare
        // in practice; anchoring to recognized tag names keeps false splits low.
        const inlineTags = splitInlineTags(trimmed);
        for (const part of inlineTags) {
          const tag = parseTagLine(part, text);
          if (tag !== undefined) {
            tags.push(tag);
            seenTag = true;
          }
        }
        continue;
      }
      if (seenTag && tags.length > 0) {
        const last = tags[tags.length - 1];
        if (last !== undefined) {
          tags[tags.length - 1] = {
            ...last,
            description: [last.description, trimmed].filter(Boolean).join(' '),
          };
          continue;
        }
      }
      descriptionLines.push(trimmed);
    }

    blocks.push({
      start,
      end: end + 2,
      text,
      description: descriptionLines.join('\n').trim(),
      tags,
    });
  }

  return blocks;
}

/**
 * Return the JSDoc block that immediately precedes `node`. Whitespace and
 * intervening `//` line comments are allowed between the block and the
 * declaration — a `// helper` note used to sever the association and drop the
 * whole JSDoc (review 0.1.17 P1-18). A blank line is still just whitespace.
 */
export function leadingJsDoc(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  source: string,
  blocks: readonly JsDocBlock[],
): JsDocBlock | undefined {
  const pos = node.getStart(sourceFile);
  let best: JsDocBlock | undefined;
  for (const block of blocks) {
    if (block.end <= pos && onlyWhitespaceAndLineComments(source.slice(block.end, pos))) {
      if (best === undefined || block.end > best.end) {
        best = block;
      }
    }
  }
  return best;
}

/** True if a text slice contains only whitespace and `// ...` line comments. */
function onlyWhitespaceAndLineComments(text: string): boolean {
  let rest = text;
  while (rest.length > 0) {
    const lineEnd = rest.indexOf('\n');
    const line = (lineEnd >= 0 ? rest.slice(0, lineEnd) : rest).trim();
    if (line.length > 0 && !line.startsWith('//')) {
      return false;
    }
    if (lineEnd < 0) {
      break;
    }
    rest = rest.slice(lineEnd + 1);
  }
  return true;
}

/**
 * Names declared by a `@template` tag. Each name may carry a TypeScript
 * constraint via `extends`, e.g. `@template T extends object, U`. The whole
 * `T extends object` must be kept as one type-parameter declaration — splitting
 * on every space produced `f<T, extends, object>` (review 0.1.17 P1-9).
 */
export function parseTemplateNames(tag: JsDocTag): string[] {
  let source = (tag.name ?? tag.description ?? '').trim();
  // Strip a surrounding `{...}` if a tag was written as `@template {T}`.
  source = source.replace(/^\{|\}$/g, '').trim();
  // Split parameters on commas OR on whitespace, but keep `X extends Y` glued
  // together. Treat `extends` as a join signal: rebuild tokens so that the word
  // after `extends` attaches to the name before it.
  const raw = source.split(/[\s,]+/).filter((part) => part.length > 0);
  const params: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i] ?? '';
    if (token === 'extends') {
      // Append the constraint (and any dotted generic args) to the last param.
      const constraint = raw[i + 1];
      if (constraint !== undefined && params.length > 0) {
        params[params.length - 1] += ` extends ${constraint}`;
        i += 1; // consumed the constraint token
      }
      continue;
    }
    params.push(token);
  }
  return params.filter((part) => /^[A-Za-z_$][\w$]*(?:\s+extends\s+[\w.<>|&,\s]+)?$/.test(part.trim()));
}
