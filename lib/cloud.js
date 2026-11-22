import {constants, createDecipheriv, createHash, createPublicKey, generateKeyPair, privateDecrypt, randomUUID} from 'node:crypto';
import {mkdir, link, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {readLocal, saveLocal} from './storage.js';

export const ORIGIN = 'https://formohai.top';
export const dataDirectory = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-go', 'xiaoyu');
const credentialsMax = 32 * 1024;
const deviceMax = 16 * 1024;
const envelopeMax = 2 * 1024 * 1024;
const generate = promisify(generateKeyPair);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export class CloudError extends Error {
  constructor(kind, status = 0) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

async function objectFromFile(file, maxBytes) {
  const bytes = await readLocal(file, maxBytes);
  if (bytes === null) return null;
  const data = JSON.parse(bytes);
  if (!isObject(data)) throw new CloudError('invalid');
  return data;
}

async function readResponse(response) {
  if (!response.body) throw new CloudError('invalid');
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > envelopeMax) {
        await reader.cancel();
        throw new CloudError('invalid');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size));
  } catch {
    throw new CloudError('invalid');
  } finally {
    reader.releaseLock();
  }
}

function tokens(data) {
  if (!isObject(data) || typeof data.access_token !== 'string' || !data.access_token ||
    data.access_token.length > 8192 || /[\r\n]/.test(data.access_token) ||
    (data.refresh_token != null && (typeof data.refresh_token !== 'string' || data.refresh_token.length > 8192))) {
    throw new CloudError('invalid');
  }
  return {access: data.access_token, refresh: data.refresh_token || ''};
}

export class CloudPrompts {
  constructor(directory, transport = globalThis.fetch) {
    this.directory = directory;
    this.transport = transport;
    this.activeFile = join(directory, 'cloud-account.json');
    this.keyFile = join(directory, 'cloud-device.pem');
    this.refreshing = new Map();
  }

  async api(path, {body, token, signal} = {}) {
    let response;
    try {
      response = await this.transport(ORIGIN + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : {'content-type': 'application/json'}),
          ...(token ? {authorization: 'Bearer ' + token} : {}),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        redirect: 'error',
        credentials: 'omit',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });
    } catch {
      throw new CloudError('unavailable');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const kind = {401: 'signin', 403: 'denied', 409: 'other', 422: 'missing', 429: 'limited'}[response.status] || 'unavailable';
      throw new CloudError(kind, response.status);
    }
    const payload = await readResponse(response);
    if (!isObject(payload) || payload.code !== 0 || !Object.hasOwn(payload, 'data')) throw new CloudError('invalid');
    return payload.data;
  }

  async current() {
    const active = await objectFromFile(this.activeFile, credentialsMax);
    if (active === null || typeof active.id !== 'string' || !/^[a-f0-9-]{36}$/.test(active.id)) throw new CloudError('signin');
    const credentials = await objectFromFile(this.tokenPath(active.id), credentialsMax);
    if (!credentials?.access) throw new CloudError('signin');
    return {id: active.id, ...credentials};
  }

  tokenPath(id) {
    return join(this.directory, 'cloud-tokens-' + id + '.json');
  }

  async login(email, password) {
    const data = await this.api('/api/v1/auth/login', {body: {email, password}});
    if (data?.requires_2fa === true) throw new CloudError('twofactor');
    const credentials = tokens(data);
    const profile = await this.api('/api/v1/user/profile', {token: credentials.access});
    if (typeof profile?.email !== 'string') throw new CloudError('invalid');
    const old = await this.current().catch(() => null);
    const id = randomUUID();
    const next = this.tokenPath(id);
    await saveLocal(next, JSON.stringify(credentials));
    try {
      await saveLocal(this.activeFile, JSON.stringify({id}));
    } catch (error) {
      await unlink(next).catch(() => {});
      throw error;
    }
    if (old) await unlink(this.tokenPath(old.id)).catch(() => {});
  }

  async logout() {
    const old = await this.current().catch(() => null);
    await unlink(this.activeFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (old) await unlink(this.tokenPath(old.id)).catch(() => {});
  }

  async refresh(account) {
    const current = await this.current();
    if (current.id !== account.id) throw new CloudError('signin');
    if (current.access !== account.access) return current;
    if (!current.refresh) throw new CloudError('signin');
    const existing = this.refreshing.get(account.id);
    if (existing) return existing;
    const operation = (async () => {
      const result = await this.api('/api/v1/auth/refresh', {body: {refresh_token: current.refresh}});
      const updated = tokens(result);
      if (!updated.refresh || (await this.current()).id !== account.id) throw new CloudError('signin');
      const tokenPath = this.tokenPath(account.id);
      await saveLocal(tokenPath, JSON.stringify(updated));
      if ((await this.current().catch(() => null))?.id !== account.id) {
        await unlink(tokenPath).catch(() => {});
        throw new CloudError('signin');
      }
      return {id: account.id, ...updated};
    })();
    this.refreshing.set(account.id, operation);
    try {
      return await operation;
    } finally {
      this.refreshing.delete(account.id);
    }
  }

  async authenticated(path, body, account, signal) {
    if ((await this.current()).id !== account.id) throw new CloudError('signin');
    let result;
    try {
      result = await this.api(path, {body, token: account.access, signal});
    } catch (error) {
      if (error.status !== 401 || signal?.aborted) throw error;
      const refreshed = await this.refresh(account);
      result = await this.api(path, {body, token: refreshed.access, signal});
    }
    if ((await this.current()).id !== account.id) throw new CloudError('signin');
    return result;
  }

  async device() {
    let file = await readLocal(this.keyFile, deviceMax);
    if (file === null) {
      await mkdir(this.directory, {recursive: true, mode: 0o700});
      const keys = await generate('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {type: 'spki', format: 'pem'},
        privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
      });
      const temporary = this.keyFile + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, keys.privateKey, {flag: 'wx', mode: 0o600});
        await link(temporary, this.keyFile).catch(error => { if (error.code !== 'EEXIST') throw error; });
      } finally {
        await unlink(temporary).catch(() => {});
      }
      file = await readLocal(this.keyFile, deviceMax);
      if (file === null) throw new CloudError('invalid');
    }
    return {privateKey: file, publicKey: createPublicKey(file).export({type: 'spki', format: 'pem'})};
  }

  async status(account, signal) {
    const {publicKey} = await this.device();
    const result = await this.authenticated('/ai-armor-api/status', {public_key: publicKey}, account, signal);
    if (typeof result?.entitled !== 'boolean' || !['unbound', 'current', 'other'].includes(result.binding)) throw new CloudError('invalid');
    return result;
  }

  async bind(account) {
    const status = await this.status(account);
    if (!status.entitled) throw new CloudError('denied');
    if (status.binding === 'other') throw new CloudError('other');
    if (status.binding === 'current') return;
    const {publicKey} = await this.device();
    await this.authenticated('/ai-armor-api/device/bind', {
      public_key: publicKey,
      device_name: '小鱼 · DSH-Go',
      confirm_device: true,
    }, account);
  }

  async resolve(account, model, signal) {
    const {privateKey, publicKey} = await this.device();
    const nonce = randomUUID();
    const packet = await this.authenticated('/ai-armor-api/resolve', {model, nonce, public_key: publicKey}, account, signal);
    try {
      return openEnvelope(packet, {privateKey, model, nonce});
    } catch {
      throw new CloudError('invalid');
    }
  }
}

export function openEnvelope(packet, {privateKey, model, nonce}) {
  const meta = packet?.metadata;
  const expiry = Date.parse(meta?.expires_at);
  if (!isObject(meta) || packet.algorithm !== 'RSA-OAEP-256+A256GCM' ||
    meta.model !== model || meta.nonce !== nonce || !Number.isFinite(expiry) || expiry <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(meta.content_hash) || packet.aad !== JSON.stringify(meta)) {
    throw new CloudError('invalid');
  }
  const wrapped = Buffer.from(packet.wrappedKey, 'base64');
  const iv = Buffer.from(packet.iv, 'base64');
  const tag = Buffer.from(packet.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new CloudError('invalid');
  const key = privateDecrypt({key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'}, wrapped);
  let content;
  try {
    if (key.length !== 32) throw new CloudError('invalid');
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(packet.aad));
    cipher.setAuthTag(tag);
    content = Buffer.concat([cipher.update(Buffer.from(packet.ciphertext, 'base64')), cipher.final()]);
    if (!content.length || sha256(content) !== meta.content_hash) throw new CloudError('invalid');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(content);
    if (!text.trim()) throw new CloudError('invalid');
    return {text, word: typeof meta.verification_word === 'string' ? meta.verification_word : ''};
  } finally {
    key.fill(0);
    content?.fill(0);
  }
}
