#!/usr/bin/env node

/**
 * Add two numbers.
 * @param {number} a - first operand
 * @param {number} [b=1] - second operand
 * @returns {number} the sum
 */
function add(a, b = 1) {
  return a + b;
}

/**
 * Pick the first matching item.
 * @template T
 * @param {Array.<T>} items - source list
 * @param {function(T): boolean} predicate - matcher
 * @returns {T | undefined} first match
 */
function firstMatch(items, predicate) {
  for (const item of items) {
    if (predicate(item)) {
      return item;
    }
  }
  return undefined;
}

/**
 * A person record.
 * @type {Object}
 * @property {string} name
 * @property {number} [age]
 */
const person = { name: 'Ada' };

/**
 * Greet someone.
 * @param {string} name
 * @returns {string}
 */
const greet = (name) => `hello ${name}`;

/**
 * Shout without parentheses in the original source.
 * @param {string} text
 */
const shout = text => text.toUpperCase();

/**
 * A callback type.
 * @callback Handler
 * @param {string} event
 * @returns {void}
 */

/**
 * A named record type.
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

class Counter {
  /**
   * @param {number} [start=0]
   */
  constructor(start = 0) {
    /** @type {number} */
    this.value = start;
  }

  /**
   * @param {number} step
   * @returns {number}
   */
  increase(step) {
    this.value += step;
    return this.value;
  }
}

/** @param {string} value */
function lengthOf(value) {
  return value.length;
}

/**
 * @param {...number} values
 * @returns {number}
 */
function sum(...values) {
  return values.reduce((acc, value) => acc + value, 0);
}

export { add, firstMatch, person, greet, shout, Counter, lengthOf, sum };
