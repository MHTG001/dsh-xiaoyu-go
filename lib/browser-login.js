import {randomUUID, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {CloudError, ORIGIN} from './cloud.js';

const maxBodyBytes = 16 * 1024;

function reply(response, status, text) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鱼 · DSH-Go</title><main><h1>' + text + '</h1></main></html>');
}

async function readForm(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new CloudError('invalid');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks, size).toString('utf8'));
}

export function openBrowserLogin({accept, finish, timeoutMs = 300_000}) {
  const state = randomUUID();
  const controller = new AbortController();
  let stopped = false;
  let exchanging = false;
  let host;

  const server = createServer({requestTimeout: 12_000, headersTimeout: 8_000}, async (request, response) => {
    if (stopped || exchanging || request.method !== 'POST' || request.url !== '/callback' ||
        request.headers.host !== host || request.headers.origin !== ORIGIN ||
        request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
      reply(response, 403, '该登录请求无效，请从小鱼设置重新打开。');
      return;
    }
    let fields;
    try {
      fields = await readForm(request);
    } catch {
      if (!response.destroyed) reply(response, 400, '登录请求无效。');
      return;
    }
    const signedState = Buffer.from(fields.get('state') || '');
    const expectedState = Buffer.from(state);
    if (stopped || exchanging || fields.getAll('state').length !== 1 ||
        fields.getAll('access_token').length !== 1 || fields.getAll('refresh_token').length !== 1 ||
        !fields.get('access_token') || !fields.get('refresh_token') ||
        signedState.length !== expectedState.length || !timingSafeEqual(signedState, expectedState)) {
      reply(response, 403, '该登录请求无效，请从小鱼设置重新打开。');
      return;
    }
    exchanging = true;
    let failure = null;
    try {
      await accept({
        access_token: fields.get('access_token'),
        refresh_token: fields.get('refresh_token'),
      }, controller.signal);
    } catch (error) {
      failure = error instanceof CloudError ? error : new CloudError('unavailable');
    }
    if (stopped) return;
    reply(response, failure ? 401 : 200, failure
      ? '登录未完成，请返回小鱼设置重试。'
      : '登录成功，请返回 DSH-Go 的小鱼设置。');
    stop(failure);
  });

  function stop(error, destroy = false) {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    if (error) controller.abort(error);
    server.close();
    if (destroy) server.closeAllConnections();
    finish(error);
  }

  const deadline = setTimeout(() => stop(new CloudError('expired'), true), timeoutMs);
  deadline.unref();
  const url = new Promise((resolve, reject) => {
    server.on('error', () => {
      const error = new CloudError('unavailable');
      stop(error, true);
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => {
      if (stopped) {
        server.close();
        reject(new CloudError('cancelled'));
        return;
      }
      const {port} = server.address();
      host = '127.0.0.1:' + port;
      const target = new URL('/desktop-connect', ORIGIN);
      target.searchParams.set('port', String(port));
      target.searchParams.set('state', state);
      resolve(target.toString());
    });
  });
  server.unref();
  return {url, cancel: () => stop(new CloudError('cancelled'), true)};
}
