#!/usr/bin/env node
import { createRequire } from 'node:module';

// Guard the TypeScript peer before the CLI modules load. deany targets the
// TypeScript 6 semantic model. TypeScript 7 ships a different module shape
// (ts.TypeFormatFlags and others are missing at import time) which would crash
// during module evaluation with an opaque TypeError; older 5.x is no longer a
// supported baseline. Fail early with a helpful message instead.
const require = createRequire(import.meta.url);
let tsVersion;
try {
  tsVersion = require('typescript').version;
} catch {
  console.error('deany: cannot find the "typescript" peer dependency.');
  console.error('Install a compatible version: npm install -g typescript@6');
  process.exit(1);
}
const major = Number.parseInt(String(tsVersion).split('.')[0], 10);
if (major !== 6) {
  console.error(`deany requires TypeScript 6.x, but found ${tsVersion ?? 'an unknown version'}.`);
  console.error('Install a compatible version: npm install -g typescript@6');
  process.exit(1);
}

await import('../dist/cli.js');
