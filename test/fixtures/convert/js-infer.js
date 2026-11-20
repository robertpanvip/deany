/*
 * A complete JS module with almost no JSDoc — every type is inferred from
 * usage evidence by the implicit-any resolver during conversion.
 */

let count;
count = 42;

function addOne(value) {
  return value + 1;
}

let names;
names = ['a', 'b'];

/** @param {number} n */
function takeNumber(n) {
  return n;
}

let amount;
amount = 7;
takeNumber(amount);

let mystery;

export { count, addOne, names, amount, mystery };
