import fs from 'node:fs';
import path from 'node:path';
import documented from './documented-params.json' with { type: 'json' };
import sdkFieldMap from './sdk-field-map.json' with { type: 'json' };

export const PLATFORMS = [
  'tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x',
  'threads', 'pinterest', 'bluesky', 'discord', 'telegram', 'google_business'
];

// Which platforms each post type can go to (from the API reference).
export const PLATFORMS_BY_TYPE = {
  text: ['linkedin', 'x', 'facebook', 'threads', 'bluesky', 'discord', 'telegram', 'google_business'],
  video: PLATFORMS,
  photos: ['tiktok', 'instagram', 'linkedin', 'facebook', 'x', 'threads', 'pinterest', 'bluesky', 'discord', 'telegram', 'google_business'],
  document: ['linkedin']
};

const TYPES = Object.keys(PLATFORMS_BY_TYPE);

// Fields that have their own input. `extra` may not set them.
const RESERVED_EXTRA = {
  user: 'profile',
  'platform[]': 'platforms',
  platform: 'platforms',
  title: 'text',
  video: 'media',
  'photos[]': 'media',
  photos: 'media',
  document: 'media',
  scheduled_date: 'scheduled-date',
  timezone: 'timezone',
  add_to_queue: 'add-to-queue',
  first_comment: 'first-comment',
  async_upload: 'wait'
};

export class InputError extends Error {}

export function parseBoolean(value, name, fallback = false) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new InputError(`Input "${name}" must be true or false, got "${value}".`);
}

/** Newline-separated if the value has newlines, otherwise comma-separated. */
export function parseList(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const parts = raw.includes('\n') ? raw.split(/\r?\n/) : raw.split(',');
  return parts.map((p) => p.trim()).filter((p) => p && !p.startsWith('#'));
}

export function parsePlatforms(value, type) {
  const list = parseList(value.replace(/\n/g, ',')).map((p) => p.toLowerCase());
  const platforms = [];
  for (let p of list) {
    if (p === 'twitter') p = 'x';
    if (p === 'reddit') {
      throw new InputError('Reddit posting is currently unavailable in the Upload-Post API (503 reddit_unavailable). Remove "reddit" from platforms.');
    }
    if (!PLATFORMS.includes(p)) {
      throw new InputError(`Unknown platform "${p}". Supported: ${PLATFORMS.join(', ')}.`);
    }
    if (!PLATFORMS_BY_TYPE[type].includes(p)) {
      throw new InputError(`Platform "${p}" does not accept ${type} posts. Platforms for type "${type}": ${PLATFORMS_BY_TYPE[type].join(', ')}.`);
    }
    if (!platforms.includes(p)) platforms.push(p);
  }
  if (type === 'document' && platforms.length === 0) platforms.push('linkedin');
  if (platforms.length === 0) throw new InputError('Input "platforms" is required (comma-separated, e.g. "x,linkedin").');
  return platforms;
}

/** URLs pass through; repository paths are resolved against the workspace and must exist. */
export function resolveMedia(items, workspace) {
  return items.map((item) => {
    if (/^https?:\/\//i.test(item)) return item;
    const abs = path.resolve(workspace, item);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new InputError(`Media file not found: "${item}" (looked for ${abs}). Use a public URL or a path relative to the repository root, and check out the repository first (actions/checkout).`);
    }
    return abs;
  });
}

function isDocumented(type, key) {
  const spec = documented[type];
  if (spec.params[key]) return spec.params[key];
  for (const [pattern, meta] of Object.entries(spec.patterns)) {
    if (new RegExp(pattern).test(key)) return meta;
  }
  return null;
}

/**
 * Split `extra` into SDK options and fields to append as-is.
 * Only parameters documented for the chosen post type are accepted.
 */
export function parseExtra(value, type, workspace) {
  const raw = String(value ?? '').trim();
  const sdkOptions = {};
  const rawFields = [];
  if (!raw) return { sdkOptions, rawFields };

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new InputError(`Input "extra" is not valid JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new InputError('Input "extra" must be a JSON object, e.g. {"privacyStatus": "unlisted"}.');
  }

  const unknown = [];
  for (const [key, val] of Object.entries(obj)) {
    if (RESERVED_EXTRA[key]) {
      throw new InputError(`"${key}" cannot go in "extra": use the "${RESERVED_EXTRA[key]}" input instead.`);
    }
    if (/^reddit_|^subreddit$|^flair_id$/.test(key)) {
      throw new InputError(`"${key}" is a Reddit parameter; Reddit posting is currently unavailable.`);
    }
    const meta = isDocumented(type, key);
    if (!meta) {
      unknown.push(key);
      continue;
    }
    if (meta.file && typeof val === 'string' && !/^https?:\/\//i.test(val)) {
      // Local file for a File field: always sent as a file stream.
      const [abs] = resolveMedia([val], workspace);
      rawFields.push({ name: key, value: abs, file: true, list: false });
      continue;
    }
    const viaSdk = sdkFieldMap[type]?.[key];
    const primitive = ['string', 'number', 'boolean'].includes(typeof val);
    const sdkRepeats = Array.isArray(val) && viaSdk?.field.endsWith('[]');
    if (viaSdk && (primitive || sdkRepeats)) {
      sdkOptions[viaSdk.option] = typeof val === 'boolean' ? String(val) : val;
    }
    // Always registered as a fallback; skipped at send time if the SDK already set it.
    rawFields.push({ name: key, value: val, file: false, list: Boolean(meta.list) });
  }
  if (unknown.length) {
    throw new InputError(
      `Unknown or undocumented parameter(s) in "extra" for type "${type}": ${unknown.join(', ')}. ` +
      `See https://docs.upload-post.com/api/reference for the parameters of each endpoint.`
    );
  }
  return { sdkOptions, rawFields };
}

/**
 * Read and validate every input. `get(name)` returns the raw string value.
 */
export function readInputs(get, env = process.env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();

  const apiKey = get('api-key').trim();
  if (!apiKey) throw new InputError('Input "api-key" is required. Store your key as the repository secret UPLOAD_POST_API_KEY and pass `api-key: ${{ secrets.UPLOAD_POST_API_KEY }}`.');

  const profile = get('profile').trim();
  if (!profile) throw new InputError('Input "profile" is required: the Upload-Post profile (username) whose connected accounts will publish.');

  const type = (get('type').trim() || 'text').toLowerCase();
  if (!TYPES.includes(type)) throw new InputError(`Input "type" must be one of ${TYPES.join(', ')}, got "${type}".`);

  const platforms = parsePlatforms(get('platforms'), type);

  const text = get('text');
  const title = get('title');
  if (text.trim() && title.trim() && text !== title) {
    throw new InputError('Set either "text" or "title", not both (they are the same field: the post caption).');
  }
  const caption = text.trim() ? text : title;
  if ((type === 'text' || type === 'document') && !caption.trim()) {
    throw new InputError(`Input "text" is required for type "${type}".`);
  }

  const mediaItems = parseList(get('media'));
  let media = [];
  if (type === 'text') {
    if (mediaItems.length) throw new InputError('Input "media" is not used with type "text". Use type "photos", "video" or "document".');
  } else {
    if (!mediaItems.length) throw new InputError(`Input "media" is required for type "${type}".`);
    if ((type === 'video' || type === 'document') && mediaItems.length > 1) {
      throw new InputError(`Type "${type}" takes exactly one file in "media"; got ${mediaItems.length}.`);
    }
    media = resolveMedia(mediaItems, workspace);
  }

  const scheduledDate = get('scheduled-date').trim();
  const timezone = get('timezone').trim();
  const addToQueue = parseBoolean(get('add-to-queue'), 'add-to-queue');
  if (scheduledDate && addToQueue) throw new InputError('Use either "scheduled-date" or "add-to-queue", not both.');
  if (timezone && !scheduledDate) throw new InputError('Input "timezone" only applies together with "scheduled-date".');

  const wait = parseBoolean(get('wait'), 'wait');
  const waitTimeoutRaw = get('wait-timeout').trim() || '900';
  const waitTimeout = Number(waitTimeoutRaw);
  if (!Number.isFinite(waitTimeout) || waitTimeout <= 0) {
    throw new InputError(`Input "wait-timeout" must be a positive number of seconds, got "${waitTimeoutRaw}".`);
  }

  const { sdkOptions, rawFields } = parseExtra(get('extra'), type, workspace);

  return {
    apiKey,
    profile,
    type,
    platforms,
    caption,
    media,
    scheduledDate,
    timezone,
    addToQueue,
    firstComment: get('first-comment'),
    wait,
    waitTimeout,
    sdkOptions,
    rawFields
  };
}
