import type { ConvertOptions, JsDocTag } from '../types.js';

import { appendArray, normalizeJsDocType } from './core.js';

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

/**
 * Build a nested inline object type from `@param options.foo` / `@param [options.bar]`
 * style tags. These describe properties of a single parameter; the checker normally
 * collapses them to a bare `object`, losing every field (TS2339). Folding the dotted
 * paths back into an object shape keeps the JSDoc's explicit, reliable evidence.
 */
export function objectTypeFromDottedParams(
  root: string,
  tags: readonly JsDocTag[],
  options: ConvertOptions,
): string {
  interface ShapeNode {
    optional: boolean;
    type: string | undefined;
    readonly children: Map<string, ShapeNode>;
  }
  const makeNode = (): ShapeNode => ({ optional: false, type: undefined, children: new Map() });
  const rootNode = makeNode();
  const prefix = `${root}.`;

  for (const tag of tags) {
    const name = tag.name;
    if (name === undefined || !name.startsWith(prefix)) {
      continue;
    }
    const path = name.slice(prefix.length).split('.').filter((segment) => segment.length > 0);
    if (path.length === 0) {
      continue;
    }
    let node = rootNode;
    for (const segment of path) {
      let next = node.children.get(segment);
      if (next === undefined) {
        next = makeNode();
        node.children.set(segment, next);
      }
      node = next;
    }
    node.optional = tag.optional;
    node.type = tag.typeText ?? options.defaultType;
  }

  const render = (node: ShapeNode): string => {
    if (node.children.size === 0) {
      return normalizeJsDocType(node.type ?? options.defaultType, options);
    }
    const members = [...node.children.entries()].map(([key, child]) => {
      const quoted = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `${quoted}${child.optional ? '?' : ''}: ${render(child)};`;
    });
    return `{ ${members.join(' ')} }`;
  };

  return render(rootNode);
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
export const BUILTIN_TYPE_NAMES = new Set([
  // TS primitives & JS built-ins
  'string', 'number', 'boolean', 'bigint', 'symbol', 'void', 'undefined', 'null', 'never',
  'any', 'unknown', 'object', 'Object', 'Function', 'Array', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'JSON', 'Math', 'Reflect', 'Proxy',
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract',
  'NonNullable', 'ReturnType', 'Parameters', 'InstanceType', 'ThisType', 'Awaited',
  // Utility types from lib.es5.d.ts / lib.es2015 / intrinsic string types. Missing
  // any of these makes convert.ts emit a bogus `type X = unknown;` fallback alias
  // that collides with the lib declaration (TS2300) and breaks generic use (TS2315).
  'ThisParameterType', 'OmitThisParameter', 'ConstructorParameters',
  'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize', 'ReadonlyArray',
  'This', 'NoInfer',
  'Iterable', 'Iterator', 'AsyncIterable', 'Generator', 'AsyncGenerator',
  'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Uint8Array', 'ArrayBuffer',
  // DOM / Node globals (provided by lib, not JSDoc typedefs)
  'window', 'document', 'self', 'globalThis', 'console', 'process', 'Buffer',
  'Node', 'Element', 'HTMLElement', 'Event', 'EventTarget', 'Window', 'LocalStorage',
])

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
