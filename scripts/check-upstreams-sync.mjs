#!/usr/bin/env node
// scripts/check-upstreams-sync.mjs — drift guard. Fails when the checked-in
// edge bundle (functions/lib/upstreams.json) differs from config/upstreams.json.
// Run `npm run sync:upstreams` to fix. CI runs this on every push.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const a = readFileSync(join(root, 'config', 'upstreams.json'), 'utf8');
let b;
try {
  b = readFileSync(join(root, 'functions', 'lib', 'upstreams.json'), 'utf8');
} catch {
  console.error('DRIFT: functions/lib/upstreams.json missing — run npm run sync:upstreams');
  process.exit(1);
}
if (JSON.stringify(JSON.parse(a)) !== JSON.stringify(JSON.parse(b))) {
  console.error('DRIFT: functions/lib/upstreams.json is stale — run npm run sync:upstreams and commit the result.');
  process.exit(1);
}
console.log('upstreams bundle in sync.');
