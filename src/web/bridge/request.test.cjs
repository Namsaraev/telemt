'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/request.js`, 'utf8');
function client(yandexCdnCompat, fetch) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return context.TelemtBridgeRequest.create({
    yandexCdnCompat, origin: () => 'https://proxy.example.com', closed: () => false,
    retryMs: () => 5000, longPollMs: () => 1000, requestMs: () => 1000,
    batchLimit: () => 1024, read: async () => new Uint8Array(), cancel: () => {},
    failure: (reason, message) => Object.assign(new Error(message), { telemtReason: reason }),
    reason: (error, fallback) => error.telemtReason || fallback, retrying: () => {},
  });
}

for (const mode of [undefined, false, true]) {
  for (const [path, method, expected, hasBody] of [
    ['/api/v1/session', 'POST', 'OPTIONS', true],
    ['/api/v1/up', 'POST', 'OPTIONS', true],
    ['/api/v1/down', 'POST', 'GET', false],
    ['/api/v1/session', 'DELETE', 'OPTIONS', false],
  ]) {
    test(`mode=${mode}: ${method} ${path} preserves the wire contract`, async () => {
      const calls = [];
      const fetch = async (url, options) => {
        calls.push({ url, options });
        return { status: 204, headers: new Headers() };
      };
      const api = client(mode, fetch);
      const body = hasBody ? Uint8Array.of(0, 255, 128, 13, 10).buffer : null;
      const controller = new AbortController();
      const headers = path.endsWith('/up') ? { 'X-Up-Seq': '7', 'X-Lane-ID': '3' }
        : path.endsWith('/down') ? { 'X-Down-Cursor': '9', 'X-Lane-ID': '3' }
        : method === 'DELETE' ? { 'X-Carrier-Failure': 'network' }
        : { 'X-Carrier-Capabilities': 'https,https-lanes', 'X-Carrier-Attempt': '2' };
      const logical = api.options(method, 'test-token', body, headers, controller.signal, method === 'DELETE');
      Object.freeze(logical.headers);
      Object.freeze(logical);
      if (method === 'DELETE') {
        await fetch('https://proxy.example.com' + path, api.wireOptions(path, logical));
      } else {
        await api.send(path, logical, null, 1);
      }
      assert.equal(calls.length, 1);
      const wire = calls[0].options;
      assert.equal(calls[0].url, 'https://proxy.example.com' + path);
      assert.equal(wire.method, mode ? expected : method);
      assert.strictEqual(wire.body, body);
      assert.equal(wire.headers.Authorization, 'Bearer test-token');
      assert.equal(wire.headers['Content-Type'], hasBody ? 'application/octet-stream' : undefined);
      assert.equal(wire.headers['X-Telemt-CDN-Method'], mode && method === 'DELETE' ? 'DELETE' : undefined);
      for (const [key, value] of Object.entries(headers)) assert.equal(wire.headers[key], value);
      assert.equal(wire.keepalive, method === 'DELETE');
      assert.equal(wire.cache, 'no-store');
      assert.equal(wire.mode, 'same-origin');
      assert.equal(wire.credentials, 'omit');
      assert.equal(wire.redirect, 'error');
      assert.equal(wire.referrerPolicy, 'no-referrer');
      assert.equal(wire.signal.aborted, false);
      assert.equal(logical.method, method);
      assert.equal(logical.headers['X-Telemt-CDN-Method'], undefined);
      if (!mode) assert.strictEqual(api.wireOptions(path, logical), logical);
      // Construct a real Fetch Request to catch invalid GET bodies and header values.
      const request = new Request(calls[0].url, wire);
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array(body || 0));
    });
  }
}

test('mapping is restricted to the four relay operations', () => {
  const api = client(true);
  for (const [path, method] of [
    ['/', 'GET'], ['/api/v1/ws', 'GET'], ['/api/v1/up', 'DELETE'],
    ['/api/v1/down', 'OPTIONS'], ['/unrelated', 'POST'], ['/api/v1/session', 'GET'],
  ]) {
    const logical = api.options(method, 'token', null);
    assert.strictEqual(api.wireOptions(path, logical), logical);
  }
});

test('retries preserve binary data, sequence, lane, and mapped method', async () => {
  const calls = [];
  const api = client(true, async (url, options) => {
    calls.push(options);
    return { status: calls.length === 1 ? 503 : 204, headers: new Headers() };
  });
  const body = Uint8Array.of(0, 255, 128).buffer;
  await api.send('/api/v1/up', api.options('POST', 'token', body, { 'X-Up-Seq': '5', 'X-Lane-ID': '2' }), null, 2);
  assert.equal(calls.length, 2);
  for (const value of calls) {
    assert.equal(value.method, 'OPTIONS');
    assert.strictEqual(value.body, body);
    assert.equal(value.headers['X-Up-Seq'], '5');
    assert.equal(value.headers['X-Lane-ID'], '2');
  }
});

test('runtime cleanup uses the same mapping even after close', async () => {
  const runtime = readFileSync(`${__dirname}/runtime.js`, 'utf8');
  const cleanup = runtime.match(/function deleteSession\(\)\{[\s\S]*?\n\}/)[0];
  for (const enabled of [false, true]) {
    const calls = [];
    const api = client(enabled);
    const context = vm.createContext({
      cleanupToken: 'cleanup-token', sessionToken: 'session-token', closed: true,
      terminalFailure: 'network', canonicalFailures: ['network'],
      relayOrigin: 'https://proxy.example.com', requestClient: api, options: api.options,
      fetch: async (url, options) => { calls.push(options); },
    });
    vm.runInContext(cleanup + '\ndeleteSession();', context);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, enabled ? 'OPTIONS' : 'DELETE');
    assert.equal(calls[0].headers.Authorization, 'Bearer cleanup-token');
    assert.equal(calls[0].headers['X-Carrier-Failure'], 'network');
    assert.equal(calls[0].headers['X-Telemt-CDN-Method'], enabled ? 'DELETE' : undefined);
    assert.equal(calls[0].headers['Content-Type'], undefined);
    assert.equal(calls[0].body, null);
    assert.equal(calls[0].keepalive, true);
  }
});
