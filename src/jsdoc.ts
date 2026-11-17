import type * as ts from 'typescript';
import type { JsDocBlock, JsDocTag } from './types.js';

interface BracedType {
  readonly type: string;
  readonly rest: string;
}

const TAG_LINE = /^@([A-Za-z][A-Za-z0-9]*)\b\s*([\s\S]*)$/;

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

/** Scan a JavaScript source text and parse every JSDoc block with its offsets. */
export function parseJsDocBlocks(source: string): JsDocBlock[] {
  const blocks: JsDocBlock[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const start = source.indexOf('/**', cursor);
    if (start < 0) {
      break;
    }
    const end = source.indexOf('*/', start + 3);
    if (end < 0) {
      break;
    }
    // A JSDoc block must not be part of a longer comment like `/****` or `x/**`.
    const before = start === 0 ? '' : source[start - 1] ?? '';
    if (before.length > 0 && source[start + 3] !== '*' && !/\s/.test(before)) {
      cursor = start + 3;
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
        const tag = parseTagLine(trimmed, text);
        if (tag !== undefined) {
          tags.push(tag);
          seenTag = true;
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
    cursor = end + 2;
  }

  return blocks;
}

/** Return the JSDoc block that immediately precedes `node` (whitespace only in between). */
export function leadingJsDoc(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  source: string,
  blocks: readonly JsDocBlock[],
): JsDocBlock | undefined {
  const pos = node.getStart(sourceFile);
  let best: JsDocBlock | undefined;
  for (const block of blocks) {
    if (block.end <= pos && /^\s*$/.test(source.slice(block.end, pos))) {
      if (best === undefined || block.end > best.end) {
        best = block;
      }
    }
  }
  return best;
}

/** Names declared by a `@template T, U` tag. */
export function parseTemplateNames(tag: JsDocTag): string[] {
  const source = (tag.name ?? tag.description ?? '').trim();
  return source
    .split(/[\s,]+/)
    .map((part) => part.replace(/^\{|\}$/g, '').trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}
