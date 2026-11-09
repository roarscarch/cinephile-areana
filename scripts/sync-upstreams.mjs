#!/usr/bin/env node
// scripts/sync-upstreams.mjs — copy config/upstreams.json into the edge bundle.
//
// The Pages Function (functions/lib/*) can't read ../config at runtime — it is
// bundled. So the checked-in functions/lib/upstreams.json is a BUILD ARTIFACT
// of config/upstreams.json. Run this after every config edit:
//
//   npm run sync:upstreams   (also runs automatically in `npm test`)
//
// CI fails if the copy is stale (see scripts/check-upstreams-sync.mjs via the
// canary workflow), so the two backends can never disagree again.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'functions', 'lib'), { recursive: true });
copyFileSync(join(root, 'config', 'upstreams.json'), join(root, 'functions', 'lib', 'upstreams.json'));
console.log('synced config/upstreams.json -> functions/lib/upstreams.json');
