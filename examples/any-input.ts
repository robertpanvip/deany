declare function takeNumber(value: number): void;

/**
 * 赋值来源与调用点都指向 number。
 */
let count: any;
count = 42;
takeNumber(count);

const title: any = 'hello';

/**
 * 从 return 语句反推。
 */
function getValue(): any {
  return 123;
}

function greet(who: any): void {}
greet('Ada');

class Box {
  value: any;

  constructor() {
    this.value = 'ok';
  }
}

/**
 * 证据冲突，保留 any 并报告。
 */
let unresolved: any;
unresolved = 1;
unresolved = 'a';

export { count, title, getValue, greet, Box, unresolved };
