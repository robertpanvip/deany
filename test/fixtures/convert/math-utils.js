#!/usr/bin/env node
/**
 * math-utils — a complete, realistic JS module converted by the JSDoc pipeline.
 * Covers: default params, rest params, @template generics, @typedef, @callback,
 * arrow functions, classes with promoted fields, and a named export list.
 */

/** @param {number} a @param {number} b @returns {number} */
function add(a, b) {
  return a + b;
}

/**
 * Pick the first item matching a predicate.
 * @template T
 * @param {Array.<T>} items
 * @param {function(T): boolean} predicate
 * @returns {T | undefined}
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
 * A 2D point.
 * @typedef {Object} Point
 * @property {number} x
 * @property {number} y
 */

/** @param {Point} p @returns {number} */
function magnitude(p) {
  return Math.sqrt(p.x * p.x + p.y * p.y);
}

/** @param {string} s @returns {string} */
const shout = s => s.toUpperCase();

/**
 * @callback Reducer
 * @param {number} acc
 * @param {number} value
 * @returns {number}
 */

class Counter {
  /** @param {number} [start=0] */
  constructor(start = 0) {
    /** @type {number} */
    this.value = start;
  }

  /** @param {number} step @returns {number} */
  inc(step) {
    this.value += step;
    return this.value;
  }
}

/** @param {...number} ns @returns {number} */
function sum(...ns) {
  return ns.reduce((acc, n) => acc + n, 0);
}

export { add, firstMatch, magnitude, shout, Counter, sum };
