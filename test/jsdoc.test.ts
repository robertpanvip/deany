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

test('parses template names', () => {
  const blocks = parseJsDocBlocks('/** @template T, U */');
  const template = blocks[0]?.tags.find((tag) => tag.tag === 'template');
  assert.ok(template !== undefined);
  assert.deepEqual(parseTemplateNames(template), ['T', 'U']);
});
