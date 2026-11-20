// The module-level `config` is a public contract backed by api.d.ts.
export const config: any = {};

export function run(): object {
  // A same-named LOCAL must not inherit the exported contract — it must be
  // inferred from its own writes. This used to become Record<string,string>
  // and made `config.local = 1` a TS2322.
  const config: any = {};
  config.local = 1;
  return config;
}

function target(a: number, b: string): void {}

// A spread into a fixed-arity function needs a tuple (else TS2556).
function invoke(args: any): void {
  target(...args);
}

class Widget {
  constructor(a: number, b: string) {}
}

// A constructor spread shares the same signature-based tuple inference.
function build(args: any): Widget {
  return new Widget(...args);
}

export { invoke, build };
