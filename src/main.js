import * as core from '@actions/core';
import { ActionClient } from './client.js';
import { InputError, readInputs } from './inputs.js';

const INPUT_NAMES = [
  'api-key', 'profile', 'platforms', 'type', 'text', 'title', 'media', 'scheduled-date',
  'timezone', 'add-to-queue', 'first-comment', 'wait', 'wait-timeout', 'extra'
];

const FINAL = new Set(['completed', 'failed']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SDK prefixes API errors with "Upload-Post API error: "; the rest is the API's own message. */
export function apiMessage(error) {
  return String(error?.message || error).replace(/^Upload-Post API error:\s*/, '');
}

/** Normalise per-platform results (sync response object or status array) to a list. */
export function normaliseResults(results) {
  if (!results) return [];
  const list = Array.isArray(results)
    ? results
    : Object.entries(results).map(([platform, r]) => ({ platform, ...r }));
  return list
    .filter((r) => r && r.platform)
    .map((r) => {
      const url = r.post_url || r.url || null;
      return {
        platform: r.platform,
        success: r.success === true,
        skipped: r.skipped === true,
        url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null,
        note: url && !/^https?:\/\//i.test(String(url)) ? String(url) : null,
        error: r.error_message || r.error || (r.success === false ? r.message : null) || null,
        warnings: Array.isArray(r.warnings) ? r.warnings : []
      };
    });
}

export function postUrls(results) {
  const out = {};
  for (const r of results) if (r.url) out[r.platform] = r.url;
  return out;
}

async function publish(client, inputs) {
  const options = {
    ...inputs.sdkOptions,
    user: inputs.profile,
    platforms: inputs.platforms,
    title: inputs.caption
  };
  if (inputs.firstComment.trim()) options.firstComment = inputs.firstComment;
  if (inputs.scheduledDate) options.scheduledDate = inputs.scheduledDate;
  if (inputs.timezone) options.timezone = inputs.timezone;
  if (inputs.addToQueue) options.addToQueue = true;
  // Immediate posts run in the background on Upload-Post's side; we get a
  // request_id back straight away and poll it when `wait` is on.
  if (!inputs.scheduledDate && !inputs.addToQueue) options.asyncUpload = true;

  switch (inputs.type) {
    case 'text': return client.uploadText(options);
    case 'video': return client.upload(inputs.media[0], options);
    case 'photos': return client.uploadPhotos(inputs.media, options);
    case 'document': return client.uploadDocument(inputs.media[0], options);
    default: throw new InputError(`Unsupported type ${inputs.type}`);
  }
}

export async function waitForResult(client, requestId, { timeoutMs, intervalMs = 10000, notFoundGraceMs = 120000, now = Date.now } = {}) {
  const started = now();
  let last = null;
  for (;;) {
    try {
      last = await client.getStatus(requestId);
      const done = last.completed ?? 0;
      const total = last.total ?? '?';
      core.info(`Status: ${last.status} (${done}/${total} platforms)`);
      if (FINAL.has(last.status)) return { status: last.status, response: last, timedOut: false };
    } catch (error) {
      const msg = apiMessage(error);
      // The status record can lag the upload response by a moment.
      if (!/not.found|no upload request found/i.test(msg) || now() - started > notFoundGraceMs) throw error;
      core.info('Status: waiting for the upload to register');
    }
    if (now() - started + intervalMs > timeoutMs) {
      return { status: last?.status || 'pending', response: last, timedOut: true };
    }
    await sleep(intervalMs);
  }
}

async function writeSummary(rows, headline) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    const table = [[{ data: 'Platform', header: true }, { data: 'Result', header: true }, { data: 'Post', header: true }]];
    for (const r of rows) {
      const result = r.skipped ? 'skipped (not connected)' : r.success ? 'published' : `failed: ${r.error || 'unknown error'}`;
      table.push([r.platform, result, r.url ? `<a href="${r.url}">${r.url}</a>` : (r.note || '')]);
    }
    await core.summary.addHeading('Upload-Post', 3).addRaw(headline, true);
    if (rows.length) core.summary.addTable(table);
    await core.summary.write();
  } catch (error) {
    core.debug(`Could not write job summary: ${error.message}`);
  }
}

export async function run({ getInput = (n) => core.getInput(n), clientFactory } = {}) {
  try {
    const raw = {};
    for (const name of INPUT_NAMES) raw[name] = getInput(name) ?? '';
    // Mask before anything can echo it.
    if (raw['api-key']) core.setSecret(raw['api-key'].trim());

    const inputs = readInputs((n) => raw[n] ?? '');
    const client = clientFactory
      ? clientFactory(inputs)
      : new ActionClient(inputs.apiKey, { rawFields: inputs.rawFields });

    const when = inputs.scheduledDate
      ? ` scheduled for ${inputs.scheduledDate}${inputs.timezone ? ` (${inputs.timezone})` : ''}`
      : inputs.addToQueue ? ' to the queue' : '';
    core.info(`Posting ${inputs.type} to ${inputs.platforms.join(', ')} as profile "${inputs.profile}"${when}`);

    const response = await publish(client, inputs);

    const requestId = response.request_id || '';
    const jobId = response.job_id || '';
    core.setOutput('request-id', requestId);
    core.setOutput('job-id', jobId);
    for (const w of response.warnings || []) core.warning(String(w));

    // Scheduled or queued: nothing to wait for now.
    if (jobId && !requestId && !response.results) {
      const at = response.scheduled_date || inputs.scheduledDate;
      core.setOutput('status', 'scheduled');
      core.setOutput('post-urls', '{}');
      core.info(`Scheduled: job_id ${jobId}${at ? `, publishes at ${at}` : ''}`);
      if (inputs.wait) core.info('"wait" does not apply to scheduled or queued posts; the job publishes later.');
      await writeSummary([], `Scheduled (job <code>${jobId}</code>)${at ? ` for ${at}` : ''}.`);
      return;
    }

    let status;
    let results = normaliseResults(response.results);
    let finalMessage = '';

    if (response.results) {
      // Finished synchronously.
      status = results.some((r) => r.success) ? 'completed' : 'failed';
    } else if (requestId && inputs.wait) {
      core.info(`Waiting for the result of request ${requestId} (up to ${inputs.waitTimeout}s)`);
      const outcome = await waitForResult(client, requestId, { timeoutMs: inputs.waitTimeout * 1000 });
      status = outcome.status;
      results = normaliseResults(outcome.response?.results);
      finalMessage = outcome.response?.message || '';
      if (outcome.timedOut) {
        core.warning(`Still "${status}" after ${inputs.waitTimeout}s. The post keeps processing on Upload-Post; check it with request_id ${requestId}.`);
      }
    } else {
      status = 'pending';
      core.info(`Accepted: request_id ${requestId}. Set "wait: true" to wait for the published URLs.`);
    }

    const urls = postUrls(results);
    core.setOutput('status', status);
    core.setOutput('post-urls', JSON.stringify(urls));

    for (const r of results) {
      for (const w of r.warnings) core.warning(`${r.platform}: ${w}`);
      if (r.url) core.info(`${r.platform}: ${r.url}`);
      else if (r.skipped) core.warning(`${r.platform}: skipped, profile "${inputs.profile}" has no ${r.platform} account connected.`);
    }

    const failed = results.filter((r) => !r.success && !r.skipped);
    const ok = results.filter((r) => r.success);
    await writeSummary(results, `Status: <b>${status}</b>${requestId ? ` (request <code>${requestId}</code>)` : ''}`);

    if (failed.length || status === 'failed') {
      const details = failed.map((r) => `${r.platform}: ${r.error || 'failed'}`);
      if (!details.length && finalMessage) details.push(finalMessage);
      const published = ok.length ? ` Already published on ${ok.map((r) => r.platform).join(', ')} (do not re-run for those).` : '';
      core.setFailed(`Upload-Post: ${details.join(' | ') || 'upload failed'}.${published}`);
    }
  } catch (error) {
    core.setFailed(error instanceof InputError ? error.message : apiMessage(error));
  }
}
