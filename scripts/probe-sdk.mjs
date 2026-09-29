#!/usr/bin/env node
// Builds src/sdk-field-map.json: for every documented API field, the option
// name the `upload-post` SDK uses to send it. Routing `extra` through the SDK
// keeps its wire encoding (e.g. YouTube `tags` go out as repeated `tags[]`).
// Fields the SDK does not know are appended as-is by the action.
//
// It works by building each upload form with one option set at a time and
// recording which form fields appear. No network calls are made.
//
//   node scripts/probe-sdk.mjs          # rewrite the map
//   node scripts/probe-sdk.mjs --check  # exit 1 if the map is stale
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { UploadPost } from 'upload-post';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sdkSource = fs.readFileSync(require.resolve('upload-post'), 'utf8');
const documented = JSON.parse(fs.readFileSync(path.join(here, '../src/documented-params.json'), 'utf8'));

const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x', 'threads',
  'pinterest', 'bluesky', 'discord', 'telegram', 'google_business'];

// Every option name the SDK reads.
const optionNames = new Set();
for (const m of sdkSource.matchAll(/options\.([A-Za-z_][A-Za-z0-9_]*)/g)) optionNames.add(m[1]);
for (const m of sdkSource.matchAll(/_pick\(\s*options\s*,([^)]*)\)/g)) {
  for (const s of m[1].matchAll(/'([^']+)'/g)) optionNames.add(s[1]);
}
for (const skip of ['user', 'title', 'platforms', 'scheduledDate', 'timezone', 'addToQueue',
  'firstComment', 'asyncUpload', 'idempotencyKey', 'requestId']) optionNames.delete(skip);

class Probe extends UploadPost {
  async _request(_endpoint, _method, form) {
    return form._streams
      .filter((s) => typeof s === 'string')
      .map((s) => (s.match(/name="([^"]+)"/) || [])[1])
      .filter(Boolean);
  }
}
const client = new Probe('probe');

const CALLS = {
  video: (o) => client.upload('https://example.com/v.mp4', o),
  photos: (o) => client.uploadPhotos(['https://example.com/p.jpg'], o),
  text: (o) => client.uploadText(o),
  document: (o) => client.uploadDocument('https://example.com/d.pdf', o)
};

async function fieldsFor(type, extra) {
  try {
    return await CALLS[type]({ user: 'u', title: 't', platforms: PLATFORMS, ...extra });
  } catch {
    return null;
  }
}

const map = { _sdk_version: JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('upload-post')), 'package.json'), 'utf8')).version };
for (const type of Object.keys(CALLS)) {
  const base = new Set(await fieldsFor(type, {}));
  const byField = {};
  for (const opt of [...optionNames].sort()) {
    const got = await fieldsFor(type, { [opt]: 'probe' });
    if (!got) continue;
    const added = [...new Set(got.filter((f) => !base.has(f)))];
    if (added.length !== 1) continue; // ambiguous or no-op
    const field = added[0];
    const key = field.replace(/\[\]$/, '');
    // Prefer an option literally named like the API field (snake_case alias).
    if (!byField[key] || opt === key || opt === field) byField[key] = { option: opt, field };
  }
  const out = {};
  const known = { ...documented[type].params };
  for (const name of Object.keys(known)) {
    const hit = byField[name.replace(/\[\]$/, '')];
    if (hit) out[name] = hit;
  }
  map[type] = out;
}

const target = path.join(here, '../src/sdk-field-map.json');
const text = JSON.stringify(map, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== text) {
    console.error('src/sdk-field-map.json is stale: run `npm run probe-sdk`');
    process.exit(1);
  }
  console.log('src/sdk-field-map.json is up to date');
} else {
  fs.writeFileSync(target, text);
  for (const type of Object.keys(CALLS)) {
    const docs = Object.keys(documented[type].params);
    const viaSdk = Object.keys(map[type]);
    console.log(`${type}: ${viaSdk.length}/${docs.length} documented fields sent through the SDK; raw: ${docs.filter((d) => !viaSdk.includes(d)).join(' ')}`);
  }
}
