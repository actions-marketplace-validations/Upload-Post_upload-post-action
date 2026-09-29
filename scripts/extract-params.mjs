#!/usr/bin/env node
// Builds src/documented-params.json from the public API reference
// (upload-post-docs/docs/api/upload-*.md). Only parameters that appear in a
// documented parameter table (or in the documented per-platform title and
// first-comment lists) end up in the allowlist that `extra` is checked against.
//
//   node scripts/extract-params.mjs [path/to/upload-post-docs/docs/api]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(
  process.argv[2] || process.env.UPLOAD_POST_DOCS_DIR || path.join(here, '../../upload-post-docs/docs/api')
);

const SOURCES = {
  video: 'upload-video.md',
  photos: 'upload-photo.md',
  text: 'upload-text.md',
  document: 'upload-document.md'
};

// Sections for platforms this action does not target (Reddit is returning 503
// reddit_unavailable; the credential-based networks are outside its scope).
const SKIP_SECTIONS = /^(reddit|mastodon|lemmy|wordpress|slack|nostr|dev\.to|hashnode|whop|listmonk)\b/i;
const SKIP_NAMES = /^(reddit_|mastodon_|lemmy_|wordpress_|slack_|nostr_|devto_|hashnode_|whop_|listmonk_)|^(subreddit|flair_id|first_comment_media\[\])$/;

// Owned by dedicated action inputs; `extra` may not override them.
const RESERVED = new Set([
  'user', 'platform[]', 'title', 'video', 'photos[]', 'document',
  'scheduled_date', 'timezone', 'add_to_queue', 'first_comment', 'async_upload'
]);

const NAME = /^[a-z][A-Za-z0-9_]*(\[\])?$/;
const INDEXED = /^([a-z][a-z0-9_]*_)\{N\}$/;

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

function namesFromCell(cell) {
  return cell
    .split(/\s+or\s+|,|\//)
    .map((s) => s.replace(/`/g, '').trim())
    .filter(Boolean);
}

function extract(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const params = {};
  const patterns = {};
  let section = '';
  let header = null;
  let inFence = false;

  const add = (name, isFile, isList = false) => {
    if (SKIP_NAMES.test(name) || RESERVED.has(name)) return;
    const idx = name.match(INDEXED);
    if (idx) {
      patterns[`^${idx[1]}\\d+$`] = { file: Boolean(isFile), list: false };
      return;
    }
    if (!NAME.test(name)) return;
    params[name] = {
      file: Boolean(isFile) || Boolean(params[name]?.file),
      list: Boolean(isList) || Boolean(params[name]?.list)
    };
  };

  for (const line of lines) {
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) { section = h[1].trim(); header = null; continue; }
    if (SKIP_SECTIONS.test(section)) continue;

    if (line.trim().startsWith('|')) {
      const c = cells(line);
      if (!header) { header = c.map((x) => x.toLowerCase()); continue; }
      if (c.every((x) => /^:?-+:?$/.test(x))) continue;
      const typeIdx = header.indexOf('type');
      if (typeIdx === -1) continue; // not a parameter table
      const type = c[typeIdx] || '';
      const isFile = /\bfile/i.test(type);
      // "Array" in the Type column: the API reads the field as repeated `name[]`.
      const isList = /^array\b/i.test(type);
      for (const n of namesFromCell(c[0])) add(n, isFile, isList);
      continue;
    }
    header = null;

    // "* `instagram_title`: ..." lists under the per-platform title / first comment sections.
    if (/platform-specific (titles|first comments)/i.test(section)) {
      const m = line.match(/^\s*[*-]\s+`([a-z][a-z0-9_]*)`/);
      if (m) add(m[1], false);
    }
  }
  return { params, patterns };
}

const out = { _generated_from: 'upload-post-docs/docs/api (scripts/extract-params.mjs)' };
for (const [type, name] of Object.entries(SOURCES)) {
  out[type] = extract(path.join(docsDir, name));
}
const target = path.join(here, '../src/documented-params.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
for (const type of Object.keys(SOURCES)) {
  console.log(`${type}: ${Object.keys(out[type].params).length} params, ${Object.keys(out[type].patterns).length} patterns`);
}
console.log(`wrote ${path.relative(process.cwd(), target)}`);
