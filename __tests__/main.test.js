import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { UploadPost } from 'upload-post';

vi.mock('@actions/core', async () => {
  const actual = await vi.importActual('@actions/core');
  return {
    ...actual,
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    debug: vi.fn()
  };
});

const core = await import('@actions/core');
const { run, normaliseResults, waitForResult } = await import('../src/main.js');

/** [name, value] pairs of a form-data instance (streams show as "<file:basename>"). */
function formFields(form) {
  const out = [];
  const s = form._streams;
  for (let i = 0; i < s.length; i++) {
    if (typeof s[i] !== 'string') continue;
    const m = s[i].match(/name="([^"]+)"/);
    if (!m) continue;
    const v = s[i + 1];
    out.push([m[1], typeof v === 'string' ? v : `<file:${path.basename(v?.path || v?.source?.path || "")}>`]);
  }
  return out;
}

let calls;
let responses;
let workspace;

function inputs(values) {
  return (name) => values[name] ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  responses = [];
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'upa-'));
  process.env.GITHUB_WORKSPACE = workspace;
  delete process.env.GITHUB_STEP_SUMMARY;
  // Transport mock: the real SDK builds the request, nothing leaves the process.
  vi.spyOn(UploadPost.prototype, '_request').mockImplementation(async function (endpoint, method, data, isFormData, headers) {
    calls.push({ endpoint, method, fields: isFormData ? formFields(data) : data, headers });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? { success: true, request_id: 'req-1' };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const base = { 'api-key': 'secret-key', profile: 'my-brand' };

describe('text posts', () => {
  it('posts text asynchronously and returns the request id', async () => {
    await run({ getInput: inputs({ ...base, platforms: 'x, linkedin', text: 'v1.2.0 is out' }) });

    expect(core.setSecret).toHaveBeenCalledWith('secret-key');
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe('/upload_text');
    expect(calls[0].fields).toEqual(expect.arrayContaining([
      ['user', 'my-brand'],
      ['title', 'v1.2.0 is out'],
      ['platform[]', 'x'],
      ['platform[]', 'linkedin'],
      ['async_upload', 'true']
    ]));
    expect(calls[0].headers['X-Upload-Post-Source']).toBe('github-action');
    expect(core.setOutput).toHaveBeenCalledWith('request-id', 'req-1');
    expect(core.setOutput).toHaveBeenCalledWith('status', 'pending');
    expect(core.setOutput).toHaveBeenCalledWith('post-urls', '{}');
  });

  it('accepts "title" as the caption and "twitter" as x', async () => {
    await run({ getInput: inputs({ ...base, platforms: 'twitter', title: 'hello' }) });
    expect(calls[0].fields).toEqual(expect.arrayContaining([['title', 'hello'], ['platform[]', 'x']]));
  });

  it('schedules a post and reports the job id', async () => {
    responses.push({ success: true, job_id: 'job-9', scheduled_date: '2030-01-01T10:00:00Z' });
    await run({
      getInput: inputs({
        ...base, platforms: 'linkedin', text: 'Later', 'scheduled-date': '2030-01-01T10:00:00',
        timezone: 'Europe/Madrid', 'first-comment': 'Link in bio', wait: 'true'
      })
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    const f = calls[0].fields;
    expect(f).toEqual(expect.arrayContaining([
      ['scheduled_date', '2030-01-01T10:00:00'],
      ['timezone', 'Europe/Madrid'],
      ['first_comment', 'Link in bio']
    ]));
    expect(f.find(([n]) => n === 'async_upload')).toBeUndefined();
    expect(core.setOutput).toHaveBeenCalledWith('job-id', 'job-9');
    expect(core.setOutput).toHaveBeenCalledWith('status', 'scheduled');
    expect(calls).toHaveLength(1); // no polling for scheduled posts
  });

  it('adds to the queue', async () => {
    responses.push({ success: true, job_id: 'job-q' });
    await run({ getInput: inputs({ ...base, platforms: 'bluesky', text: 'queued', 'add-to-queue': 'true' }) });
    expect(calls[0].fields).toEqual(expect.arrayContaining([['add_to_queue', 'true']]));
    expect(core.setOutput).toHaveBeenCalledWith('status', 'scheduled');
  });
});

describe('media', () => {
  it('uploads a local video file from the workspace', async () => {
    fs.mkdirSync(path.join(workspace, 'videos'));
    fs.writeFileSync(path.join(workspace, 'videos/clip.mp4'), 'fake');
    await run({
      getInput: inputs({
        ...base, type: 'video', platforms: 'youtube,tiktok', text: 'New video', media: 'videos/clip.mp4',
        extra: JSON.stringify({ privacyStatus: 'unlisted', tags: ['a', 'b'], privacy_level: 'SELF_ONLY', disable_duet: true })
      })
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(calls[0].endpoint).toBe('/upload');
    expect(calls[0].fields).toEqual(expect.arrayContaining([
      ['video', '<file:clip.mp4>'],
      ['privacyStatus', 'unlisted'],
      ['tags[]', 'a'],
      ['tags[]', 'b'],
      ['privacy_level', 'SELF_ONLY'],
      ['disable_duet', 'true']
    ]));
    // No field sent twice by the SDK and the raw fallback.
    const names = calls[0].fields.map(([n]) => n).filter((n) => !n.endsWith('[]'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('sends photo URLs and local files, newline separated', async () => {
    fs.writeFileSync(path.join(workspace, 'a.png'), 'x');
    await run({
      getInput: inputs({ ...base, type: 'photos', platforms: 'instagram', media: 'https://cdn.example.com/1.jpg\na.png\n' })
    });
    expect(calls[0].endpoint).toBe('/upload_photos');
    expect(calls[0].fields.filter(([n]) => n === 'photos[]')).toEqual([
      ['photos[]', 'https://cdn.example.com/1.jpg'],
      ['photos[]', '<file:a.png>']
    ]);
  });

  it('sends a document to LinkedIn by default', async () => {
    await run({ getInput: inputs({ ...base, type: 'document', text: 'Deck', media: 'https://x.com/d.pdf', extra: '{"visibility":"CONNECTIONS"}' }) });
    expect(calls[0].endpoint).toBe('/upload_document');
    expect(calls[0].fields).toEqual(expect.arrayContaining([['platform[]', 'linkedin'], ['visibility', 'CONNECTIONS']]));
  });

  it('streams local files for documented File fields in extra', async () => {
    fs.writeFileSync(path.join(workspace, 'thumb.jpg'), 'x');
    await run({
      getInput: inputs({ ...base, type: 'video', platforms: 'youtube', text: 't', media: 'https://x.com/v.mp4', extra: '{"thumbnail":"thumb.jpg"}' })
    });
    expect(calls[0].fields).toEqual(expect.arrayContaining([['thumbnail', '<file:thumb.jpg>']]));
  });

  it('appends documented fields the SDK has no option for', async () => {
    await run({
      getInput: inputs({
        ...base, platforms: 'x,linkedin', text: 't',
        extra: JSON.stringify({ external_id: 'rel-42', exclude_reply_user_ids: ['1', '2'] })
      })
    });
    expect(calls[0].fields).toEqual(expect.arrayContaining([
      ['external_id', 'rel-42'],
      ['exclude_reply_user_ids[]', '1'],
      ['exclude_reply_user_ids[]', '2']
    ]));
  });
});

describe('validation', () => {
  const cases = [
    [{ platforms: 'x' }, 'Input "api-key" is required', { 'api-key': '' }],
    [{ platforms: 'x', text: 'a' }, 'Input "profile" is required', { profile: '' }],
    [{ platforms: 'reddit', text: 'a' }, 'Reddit posting is currently unavailable'],
    [{ platforms: 'myspace', text: 'a' }, 'Unknown platform "myspace"'],
    [{ platforms: 'youtube', text: 'a' }, 'does not accept text posts'],
    [{ platforms: 'x' }, 'Input "text" is required'],
    [{ platforms: 'x', text: 'a', type: 'video' }, 'Input "media" is required'],
    [{ platforms: 'x', text: 'a', type: 'video', media: 'missing.mp4' }, 'Media file not found'],
    [{ platforms: 'x', text: 'a', type: 'video', media: 'https://a/1.mp4,https://a/2.mp4' }, 'exactly one file'],
    [{ platforms: 'x', text: 'a', 'scheduled-date': '2030-01-01', 'add-to-queue': 'true' }, 'not both'],
    [{ platforms: 'x', text: 'a', wait: 'maybe' }, 'must be true or false'],
    [{ platforms: 'x', text: 'a', extra: '{bad' }, 'not valid JSON'],
    [{ platforms: 'x', text: 'a', extra: '{"made_up_field":1}' }, 'Unknown or undocumented parameter(s)'],
    [{ platforms: 'x', text: 'a', extra: '{"scheduled_date":"2030"}' }, 'use the "scheduled-date" input'],
    [{ platforms: 'x', text: 'a', extra: '{"subreddit":"test"}' }, 'Reddit parameter'],
    [{ platforms: 'x', text: 'a', extra: '{"privacyStatus":"private"}' }, 'Unknown or undocumented'] // YouTube-only, video-only
  ];
  it.each(cases)('%j fails with "%s"', async (values, message, overrides = {}) => {
    await run({ getInput: inputs({ ...base, ...values, ...overrides }) });
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(calls).toHaveLength(0);
  });
});

describe('API errors and results', () => {
  it('fails with the API message (plan upgrade link included)', async () => {
    responses.push(new Error('Upload-Post API error: TikTok uploads are not available on the Free plan. Upgrade at https://app.upload-post.com/pricing'));
    await run({ getInput: inputs({ ...base, platforms: 'x', text: 'a' }) });
    expect(core.setFailed).toHaveBeenCalledWith('TikTok uploads are not available on the Free plan. Upgrade at https://app.upload-post.com/pricing');
  });

  it('waits for the final status and outputs the post URLs', async () => {
    vi.useFakeTimers();
    responses.push(
      { success: true, request_id: 'req-7' },
      { status: 'in_progress', completed: 1, total: 2, results: [{ platform: 'x', success: true, post_url: 'https://x.com/a/status/1' }] },
      {
        status: 'completed', completed: 2, total: 2, results: [
          { platform: 'x', success: true, post_url: 'https://x.com/a/status/1' },
          { platform: 'linkedin', success: true, post_url: 'https://www.linkedin.com/feed/update/urn:li:share:1' }
        ]
      }
    );
    const done = run({ getInput: inputs({ ...base, platforms: 'x,linkedin', text: 'a', wait: 'true' }) });
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(calls.map((c) => c.endpoint)).toEqual(['/upload_text', '/uploadposts/status', '/uploadposts/status']);
    expect(calls[1].fields).toEqual({ request_id: 'req-7' });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('status', 'completed');
    expect(core.setOutput).toHaveBeenCalledWith('post-urls', JSON.stringify({
      x: 'https://x.com/a/status/1',
      linkedin: 'https://www.linkedin.com/feed/update/urn:li:share:1'
    }));
  });

  it('fails when a platform fails, naming the ones already published', async () => {
    vi.useFakeTimers();
    responses.push(
      { success: true, request_id: 'req-8' },
      {
        status: 'completed', completed: 2, total: 2, results: [
          { platform: 'x', success: true, post_url: 'https://x.com/a/status/2' },
          { platform: 'threads', success: false, error_message: 'Token expired, reconnect Threads' }
        ]
      }
    );
    const done = run({ getInput: inputs({ ...base, platforms: 'x,threads', text: 'a', wait: 'true' }) });
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('threads: Token expired, reconnect Threads'));
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Already published on x'));
    expect(core.setOutput).toHaveBeenCalledWith('post-urls', JSON.stringify({ x: 'https://x.com/a/status/2' }));
  });

  it('does not fail on skipped (unconnected) platforms', async () => {
    responses.push({
      success: true,
      results: {
        x: { success: true, url: 'https://x.com/a/status/3' },
        linkedin: { success: false, skipped: true, error: 'Profile has no Linkedin account configured' }
      }
    });
    await run({ getInput: inputs({ ...base, platforms: 'x,linkedin', text: 'a' }) });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith('status', 'completed');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('linkedin: skipped'));
  });
});

describe('helpers', () => {
  it('normalises sync and status result shapes', () => {
    expect(normaliseResults({ x: { success: true, url: 'https://x.com/1' } })[0]).toMatchObject({ platform: 'x', success: true, url: 'https://x.com/1' });
    expect(normaliseResults([{ platform: 'tiktok', success: true, post_url: 'Video sent to Inbox (No Public URL)' }])[0])
      .toMatchObject({ url: null, note: 'Video sent to Inbox (No Public URL)' });
  });

  it('tolerates a not-found status right after the upload, then times out cleanly', async () => {
    let t = 0;
    const client = {
      getStatus: vi.fn()
        .mockRejectedValueOnce(new Error('Upload-Post API error: No upload request found with this ID'))
        .mockResolvedValue({ status: 'processing', completed: 0, total: 1 })
    };
    const res = await waitForResult(client, 'r', { timeoutMs: 45, intervalMs: 10, now: () => (t += 10) });
    expect(res).toMatchObject({ status: 'processing', timedOut: true });
  });
});
