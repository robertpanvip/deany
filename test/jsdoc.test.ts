import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsDocBlocks, parseTemplateNames } from '../src/jsdoc.js';

const source = `
/**
 * Summary line.
 * @param {string} name - the name
 * @param {number} [age=18] - years
 * @param {...string} tags - labels
 * @returns {boolean} ok
 */
function demo(name, age, tags) { return true; }
`;

test('parses tags, optional defaults and rest parameters', () => {
  const blocks = parseJsDocBlocks(source);
  assert.equal(blocks.length, 1);
  const block = blocks[0];
  assert.ok(block !== undefined);
  assert.equal(block.description, 'Summary line.');

  const params = block.tags.filter((tag) => tag.tag === 'param');
  assert.equal(params.length, 3);
  assert.equal(params[0]?.name, 'name');
  assert.equal(params[0]?.typeText, 'string');
  assert.equal(params[0]?.description, 'the name');
  assert.equal(params[1]?.name, 'age');
  assert.equal(params[1]?.optional, true);
  assert.equal(params[1]?.defaultValue, '18');
  assert.equal(params[2]?.variadic, true);
  assert.equal(block.tags.find((tag) => tag.tag === 'returns')?.typeText, 'boolean');
});

test('parses balanced brace types and typedef names', () => {
  const blocks = parseJsDocBlocks(`
/**
 * @typedef {Object} Config
 * @property {string} host
 * @property {number} [port]
 */
`);
  const block = blocks[0];
  assert.ok(block !== undefined);
  const typedef = block.tags.find((tag) => tag.tag === 'typedef');
  assert.equal(typedef?.typeText, 'Object');
  assert.equal(typedef?.name, 'Config');
  assert.equal(block.tags.filter((tag) => tag.tag === 'property').length, 2);
});

test('parses an optional rest parameter [...args] as variadic with a clean name', () => {
  // Regression: `[...args]` used to become name `...args` with variadic=false,
  // producing `...args: { length: number; }[]` and a "no matching parameter"
  // diagnostic. The brackets must be stripped AND the leading `...` honored.
  const tag = parseJsDocBlocks('/** @param {...number} [...args] */')[0]?.tags[0];
  assert.equal(tag?.name, 'args');
  assert.equal(tag?.variadic, true);
  assert.equal(tag?.optional, true);
});

test('ignores JSDoc-looking text inside strings, templates and regexes', () => {
  // Regression: parseJsDocBlocks used a plain indexOf('/**') scan, so a fake
  // tag inside a string literal injected a bogus type alias into the output.
  const cases = [
    `const note = " /** @param {StringInsideString} x */";`,
    'const tpl = ` /** @param {FromTemplate} x */`;',
    'const re = /\\/\\*\\* @param {FromRegex} x/;',
  ];
  for (const src of cases) {
    const blocks = parseJsDocBlocks(src);
    assert.equal(blocks.length, 0, `unexpected JSDoc block in: ${src}`);
  }
  // A real JSDoc must still be found.
  assert.equal(parseJsDocBlocks('/** @param {Real} x */').length, 1);
});

test('parses template names', () => {
  const blocks = parseJsDocBlocks('/** @template T, U */');
  const template = blocks[0]?.tags.find((tag) => tag.tag === 'template');
  assert.ok(template !== undefined);
  assert.deepEqual(parseTemplateNames(template), ['T', 'U']);
});

test('R17-8b: a /**** banner at file offset 0 is not a JSDoc block', () => {
  // The fourth `*` check used to be chained behind `before.length > 0`, so a
  // banner at the very first character skipped it and leaked bogus typedefs.
  const banner = `/****\n * @typedef {Nope} G\n */\nlet x;`;
  assert.equal(parseJsDocBlocks(banner).length, 0);
  // banners later in the file were already ignored — keep that behavior.
  assert.equal(parseJsDocBlocks(`const a = 1;\n${banner}`).length, 0);
  // a genuine JSDoc at offset 0 must still parse.
  assert.equal(parseJsDocBlocks('/** @typedef {Real} T */\nlet x;').length, 1);
});

test('R17b-5: multiple JSDoc tags on one physical line are all parsed', () => {
  const blocks = parseJsDocBlocks('/** @param {number} a @param {string} b @returns {boolean} */');
  const tags = blocks[0]?.tags ?? [];
  assert.deepEqual(tags.map((t) => t.tag), ['param', 'param', 'returns']);
  assert.equal(tags[0]?.name, 'a');
  assert.equal(tags[0]?.typeText, 'number');
  assert.equal(tags[1]?.name, 'b');
  assert.equal(tags[1]?.typeText, 'string');
  assert.equal(tags[2]?.typeText, 'boolean');
});

test('R17b-9: @template T extends object stays one type parameter', () => {
  const block = parseJsDocBlocks('/** @template T extends object, U */')[0];
  const tag = block?.tags.find((t) => t.tag === 'template');
  assert.ok(tag !== undefined);
  assert.deepEqual(parseTemplateNames(tag), ['T extends object', 'U']);
});
