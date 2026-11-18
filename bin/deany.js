#!/usr/bin/env node
import { createRequire } from 'node:module';

// Guard the TypeScript peer before the CLI modules load. TypeScript 7 ships a
// different module shape (ts.TypeFormatFlags and others are missing at import
// time), which would otherwise crash during module evaluation with an opaque
// TypeError instead of a helpful message. TypeScript 5.x and 6.x are both
// supported.
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
if (!Number.isFinite(major) || major >= 7 || major < 5) {
  console.error(`deany requires TypeScript 5.x or 6.x, but found ${tsVersion ?? 'an unknown version'}.`);
  console.error('Install a compatible version: npm install -g typescript@6');
  process.exit(1);
}

await import('../dist/cli.js');
