declare function takeNumber(value: number): void;

// Assignment source + call site both point to number.
let count: any;
count = 42;
takeNumber(count);

// Initializer.
const title: any = 'hello';

// Return-statement inference.
function getValue(): any {
  return 123;
}

// Public API parameter: internal call site must NOT narrow it (S4).
export function greet(who: any): void {}

// Non-exported parameter: internal call site DOES narrow it.
function localGreet(who: any): void {}
localGreet('Ada');

class Box {
  value: any;

  constructor() {
    this.value = 'ok';
  }
}

// Array shape evidence.
const names: any = ['a', 'b'];
names.push('c');

// Conflicting evidence: keep a union rather than guessing.
let unresolved: any;
unresolved = 1;
unresolved = 'a';

export { count, title, getValue, localGreet, Box, names, unresolved };
