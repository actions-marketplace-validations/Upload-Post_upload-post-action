import fs from 'node:fs';
import { UploadPost } from 'upload-post';

/**
 * The official SDK client, plus the `extra` fields of the action.
 *
 * `extra` fields the SDK knows are handed to it as options (see
 * sdk-field-map.json), so they keep the SDK's wire encoding. Anything the SDK
 * did not put on the form (documented fields it has no option for, or local
 * files) is appended here, right before the request is sent.
 */
export class ActionClient extends UploadPost {
  constructor(apiKey, { rawFields = [], userAgentSource = 'github-action' } = {}) {
    super(apiKey);
    this.rawFields = rawFields;
    this.source = userAgentSource;
  }

  _track(form) {
    if (form.__fields) return;
    const fields = new Set();
    const append = form.append.bind(form);
    form.append = (name, ...rest) => {
      fields.add(name);
      return append(name, ...rest);
    };
    form.__fields = fields;
  }

  _addCommonParams(form, options) {
    this._track(form);
    return super._addCommonParams(form, options);
  }

  _addLinkedinParams(form, ...args) {
    // uploadDocument() skips _addCommonParams and goes straight here.
    this._track(form);
    return super._addLinkedinParams(form, ...args);
  }

  async _request(endpoint, method = 'GET', data = null, isFormData = false, extraHeaders = {}) {
    if (isFormData && data) {
      const sent = data.__fields || new Set();
      for (const { name, value, file, list } of this.rawFields) {
        const base = name.replace(/\[\]$/, '');
        if (sent.has(base) || sent.has(`${base}[]`)) continue;
        appendRaw(data, name, value, { file, list });
      }
    }
    return super._request(endpoint, method, data, isFormData, {
      'X-Upload-Post-Source': this.source,
      ...extraHeaders
    });
  }
}

/**
 * Encode one `extra` value the way the API reads it:
 *  - local file for a File field  -> file stream
 *  - list for `name[]` / Array    -> one `name[]` entry per item
 *  - other arrays and objects     -> JSON
 *  - booleans and numbers         -> strings
 */
export function appendRaw(form, name, value, { file = false, list = false } = {}) {
  if (value === undefined || value === null) return;
  if (file && typeof value === 'string' && !/^https?:\/\//i.test(value)) {
    form.append(name, fs.createReadStream(value));
    return;
  }
  if (Array.isArray(value) && (list || name.endsWith('[]'))) {
    const field = name.endsWith('[]') ? name : `${name}[]`;
    for (const item of value) {
      form.append(field, typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item));
    }
    return;
  }
  if (typeof value === 'object') {
    form.append(name, JSON.stringify(value));
    return;
  }
  form.append(name, String(value));
}
