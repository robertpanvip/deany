/*
 * 这个文件几乎没有 JSDoc，类型全部从使用证据反推。
 */

let count;
count = 42;

function addOne(value) {
  return value + 1;
}

let names;
names = ['a', 'b'];

/**
 * @param {number} n
 */
function takeNumber(n) {
  return n;
}

let amount;
amount = 7;
takeNumber(amount);

let mystery;

export { count, addOne, names, amount, mystery };
