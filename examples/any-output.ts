declare function takeNumber(value: number): void;

/**
 * 赋值来源与调用点都指向 number。
 */
let count: number;
count = 42;
takeNumber(count);

const title: string = 'hello';

/**
 * 从 return 语句反推。
 */
function getValue(): number {
  return 123;
}

function greet(who: any): void {}
greet('Ada');

class Box {
  value: string;

  constructor() {
    this.value = 'ok';
  }
}

/**
 * 证据冲突，保留 any 并报告。
 */
let unresolved: (number | string);
unresolved = 1;
unresolved = 'a';

export { count, title, getValue, greet, Box, unresolved };
