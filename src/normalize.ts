import type { ConvertOptions, JsDocTag } from './types.js';

/** Split on a separator while respecting nested generic/call/object brackets. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** Extract the comma-separated arguments of `Name<...>` if present. */
function genericArguments(text: string, name: string): string[] | undefined {
  if (!text.startsWith(name)) {
    return undefined;
  }
  let i = name.length;
  while (/\s/.test(text[i] ?? '')) {
    i += 1;
  }
  if (text[i] !== '<') {
    return undefined;
  }
  const args: string[] = [];
  let depth = 1;
  let start = i + 1;
  for (i = start; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '<') {
      depth += 1;
    } else if (ch === '>') {
      depth -= 1;
      if (depth === 0) {
        const tail = text.slice(start, i).trim();
        if (tail.length > 0) {
          args.push(tail);
        }
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/** Convert JSDoc `function(string, number): boolean` into a TS function type. */
function convertFunctionType(text: string, options: ConvertOptions): string | undefined {
  const match = /^function\s*\(([\s\S]*)\)\s*(?::\s*([\s\S]+))?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  const params = splitTopLevel(match[1] ?? '', ',').map((part, index) => {
    if (part.startsWith('...')) {
      const inner = normalizeJsDocType(part.slice(3), options);
      return `...arg${index}: ${inner}[]`;
    }
    return `arg${index}: ${normalizeJsDocType(part, options)}`;
  });
  const returns = normalizeJsDocType((match[2] ?? 'void').trim(), options);
  return `(${params.join(', ')}) => ${returns}`;
}

/** True when `=>` occurs at bracket depth 0, i.e. the whole expression is an arrow type. */
export function hasTopLevelArrow(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === '=' && text[i + 1] === '>' && depth === 0) {
      return true;
    }
  }
  return false;
}

/** Join union/intersection members, parenthesizing top-level function types. */
function joinComposite(members: readonly string[], separator: string): string {
  return members
    .map((member) => (hasTopLevelArrow(member) ? `(${member})` : member))
    .join(separator);
}

/** Wrap a union type in parentheses when an array suffix is appended. */
function appendArray(type: string): string {
  if (type.includes('|') || type.includes('&')) {
    return `(${type})[]`;
  }
  return `${type}[]`;
}

/** Normalize one JSDoc type expression into valid TypeScript type syntax. */
export function normalizeJsDocType(raw: string, options: ConvertOptions): string {
  let type = raw.trim().replace(/\s+/g, ' ');
  if (type.length === 0) {
    return options.defaultType;
  }

  // JSDoc `module:Foo.Bar` / `module:Foo~Bar` namespace references. TypeScript has
  // no `module:` qualifier, so strip it down to the dotted/simple type path.
  // (Cross-file typedef resolution is not available per-file; see dangling aliases.)
  if (type.startsWith('module:')) {
    type = type.slice('module:'.length).replace(/~/g, '.').trim();
  }

  // JSDoc writes generics as `Array.<T>`; TypeScript writes `Array<T>`.
  type = type.replace(/\.<\s*/g, '<');
  type = type.replace(/\s*\|\s*/g, ' | ').replace(/\s*&\s*/g, ' & ');

  // Split top-level unions/intersections first so each member (including a
  // `function(...)` type) is normalized independently. Without this, a type like
  // `function(A): X | function(B): Y` leaks raw `=>` into a union and breaks TS.
  const unionMembers = splitTopLevel(type, '|');
  if (unionMembers.length > 1) {
    return joinComposite(unionMembers.map((part) => normalizeJsDocType(part, options)), ' | ');
  }
  const intersectionMembers = splitTopLevel(type, '&');
  if (intersectionMembers.length > 1) {
    return joinComposite(intersectionMembers.map((part) => normalizeJsDocType(part, options)), ' & ');
  }

  if (type === '*' || type === '?' || type === 'any') {
    return options.unknownForLoose ? 'unknown' : 'any';
  }
  if (type === 'function') {
    return '(...args: unknown[]) => unknown';
  }

  // JSDoc non-nullable `!T` carries no extra meaning once strict null checks are on.
  if (type.startsWith('!') && type.length > 1) {
    type = type.slice(1).trim();
  }
  // JSDoc nullable `?T` means T or null.
  if (type.startsWith('?') && type.length > 1) {
    return `${normalizeJsDocType(type.slice(1).trim(), options)} | null`;
  }

  const fn = convertFunctionType(type, options);
  if (fn !== undefined) {
    return fn;
  }

  const recordArgs = genericArguments(type, 'Object');
  if (recordArgs !== undefined) {
    const [keyType, valueType] = recordArgs;
    return `Record<${normalizeJsDocType(keyType ?? options.defaultType, options)}, ${normalizeJsDocType(valueType ?? options.defaultType, options)}>`;
  }
  if (type === 'Object') {
    return 'Record<string, unknown>';
  }
  // Bare generics need type arguments in TypeScript; keep them strict-safe.
  if (type === 'Array' || type === 'Array.') {
    return 'Array<unknown>';
  }
  if (type === 'Promise') {
    return 'Promise<unknown>';
  }
  if (type === 'Map') {
    return 'Map<unknown, unknown>';
  }
  if (type === 'Set') {
    return 'Set<unknown>';
  }
  if (type === 'Record') {
    return 'Record<string, unknown>';
  }
  if (type === 'Symbol') {
    return 'symbol';
  }
  // JSDoc/Closure spell primitives with capitalized names (`String`, `Number`,
  // `Boolean`, `Integer`, `Float`). In TypeScript those spellings are boxed
  // wrapper objects — using them breaks arithmetic, `Math.*` calls and
  // assignability against literals. Map exact matches to primitive keywords.
  // Generic usages (e.g. `Array<String>`) are handled recursively by the
  // generic branch below, so they normalize here too.
  const primitiveAliases: Record<string, string> = {
    String: 'string',
    Number: 'number',
    Boolean: 'boolean',
    Integer: 'number',
    Float: 'number',
  };
  const primitive = primitiveAliases[type];
  if (primitive !== undefined) {
    return primitive;
  }

  const arrayArgs = genericArguments(type, 'Array');
  if (
    options.arrayShorthand &&
    arrayArgs !== undefined &&
    arrayArgs.length === 1 &&
    (arrayArgs[0] ?? '').length > 0
  ) {
    return appendArray(normalizeJsDocType(arrayArgs[0] ?? options.defaultType, options));
  }

  // Generic type (e.g. `Promise<...>`, `Array<function(): X>`): normalize each
  // top-level type argument so nested JSDoc syntax is converted too.
  const genericMatch = /^([A-Za-z_$][\w$]*)\s*<(.+)>$/.exec(type);
  if (genericMatch !== null) {
    const name = genericMatch[1] ?? '';
    const inner = genericMatch[2] ?? '';
    const args = splitTopLevel(inner, ',').map((arg) => normalizeJsDocType(arg, options));
    return `${name}<${args.join(', ')}>`;
  }

  return type;
}

/** Normalize the type of a rest parameter (`@param {...number} args`). */
export function normalizeRestType(raw: string, options: ConvertOptions): string {
  const stripped = raw.trim().replace(/^\.\.\./, '');
  return appendArray(normalizeJsDocType(stripped, options));
}

/** Build an inline object type from a run of `@property` tags. */
export function objectTypeFromProperties(
  properties: readonly JsDocTag[],
  options: ConvertOptions,
): string {
  if (properties.length === 0) {
    return 'Record<string, unknown>';
  }
  const members = properties.map((prop) => {
    const name = prop.name ?? 'property';
    const quoted = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
    const optional = prop.optional ? '?' : '';
    const type = normalizeJsDocType(prop.typeText ?? options.defaultType, options);
    return `${quoted}${optional}: ${type};`;
  });
  return `{ ${members.join(' ')} }`;
}

/** Wrap a JSDoc `@returns` type for an async function. */
export function wrapAsyncReturn(type: string, options: ConvertOptions): string {
  if (!options.asyncPromiseReturn || type.startsWith('Promise<')) {
    return type;
  }
  if (type === 'void') {
    return 'Promise<void>';
  }
  return `Promise<${type}>`;
}

/** Built-in / lib type names that never need a fallback alias. */
const BUILTIN_TYPE_NAMES = new Set([
  // TS primitives & JS built-ins
  'string', 'number', 'boolean', 'bigint', 'symbol', 'void', 'undefined', 'null', 'never',
  'any', 'unknown', 'object', 'Object', 'Function', 'Array', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'JSON', 'Math', 'Reflect', 'Proxy',
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'NonNullable', 'ReturnType', 'Parameters', 'InstanceType', 'ThisType', 'Awaited',
  'Iterable', 'Iterator', 'AsyncIterable', 'Generator', 'AsyncGenerator',
  'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Uint8Array', 'ArrayBuffer',
  // DOM / Node globals (provided by lib, not JSDoc typedefs)
  'window', 'document', 'self', 'globalThis', 'console', 'process', 'Buffer',
  'Node', 'Element', 'HTMLElement', 'Event', 'EventTarget', 'Window', 'LocalStorage',
]);

/**
 * Extract custom type names referenced by a JSDoc type expression that are
 * neither built-ins nor defined in `definedNames`. Used to emit fallback
 * `type X = unknown;` aliases so generated TS stays syntactically valid when a
 * typedef lives in another file (or is missing entirely).
 */
export function extractCustomTypeNames(
  typeText: string,
  definedNames: ReadonlySet<string>,
  templateNames: ReadonlySet<string> = new Set(),
): string[] {
  const found = new Set<string>();
  // Match dotted paths too (`Foo.Bar` -> `Foo`), and skip `module:`/`typeof`.
  const cleaned = typeText.replace(/\bmodule:/g, '').replace(/\btypeof\s+/g, '');
  const tokens = cleaned.match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const token of tokens) {
    if (
      BUILTIN_TYPE_NAMES.has(token) ||
      definedNames.has(token) ||
      templateNames.has(token) ||
      token === 'function'
    ) {
      continue;
    }
    // Only treat capitalized identifiers as custom type names; lowercase
    // identifiers in type text are usually parameter labels or keywords.
    if (/^[A-Z]/.test(token)) {
      found.add(token);
    }
  }
  return [...found];
}
