'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve } = require('node:path');
const vm = require('node:vm');

test('Nginx restores bridge methods, preserves payloads, and prevents caching', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'telemt-nginx-'));
  const origin = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.setHeader('X-Session-Token', 'response-token');
    response.setHeader('X-Down-Cursor', '123');
    response.statusCode = request.url === '/error' ? 503 : 200;
    response.end(JSON.stringify({ method: request.method, url: request.url,
      headers: request.headers, body: Buffer.concat(chunks).toString('hex') }));
  });
  let nginx;
  try {
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const snippets = resolve(__dirname, '../../../docs/WEB/nginx');
    const config = `
      worker_processes 1;
      pid "${directory}/nginx.pid";
      error_log "${directory}/error.log";
      events { worker_connections 64; }
      http {
        access_log off;
        client_body_temp_path "${directory}/body";
        proxy_temp_path "${directory}/proxy";
        include "${snippets}/yandex-cdn-map.conf";
        server {
          listen 127.0.0.1:${port};
          location / {
            proxy_pass http://127.0.0.1:${origin.address().port};
            proxy_http_version 1.1;
            proxy_set_header Host proxy.example.com;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header Connection "";
            include "${snippets}/yandex-cdn-proxy.conf";
          }
        }
      }`;
    writeFileSync(`${directory}/nginx.conf`, config);
    const binary = process.env.NGINX_BINARY || '/usr/sbin/nginx';
    const args = ['-p', directory, '-c', `${directory}/nginx.conf`];
    const syntax = spawnSync(binary, [...args, '-t'], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, String(syntax.error || syntax.stderr));
    nginx = spawn(binary, [...args, '-g', 'daemon off;'], { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const response = await fetch(url); await response.text(); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 30)); }
    }
    assert.ok(ready, 'private Nginx did not start');
    const context = vm.createContext({ setTimeout, clearTimeout });
    vm.runInContext(readFileSync(`${__dirname}/request.js`, 'utf8'), context);
    for (const enabled of [false, true]) {
      const api = context.TelemtBridgeRequest.create({ yandexCdnCompat: enabled });
      for (const [path, method, body] of [
        ['/api/v1/session', 'POST', Buffer.from([0, 255, 128, 13, 10])],
        ['/api/v1/up', 'POST', Buffer.from([255, 0, 1, 128])],
        ['/api/v1/down', 'POST', null], ['/api/v1/session', 'DELETE', null],
      ]) {
        const headers = { 'X-Up-Seq': '7', 'X-Down-Cursor': '9', 'X-Lane-ID': '2',
          'X-Carrier-Attempt': '1', 'X-Carrier-Failure': 'network',
          'X-Carrier-Capabilities': 'https,https-lanes' };
        const wire = api.wireOptions(path, api.options(method, 'test-token', body, headers));
        const response = await fetch(url + path + '?probe=1', wire);
        const echo = await response.json();
        assert.equal(echo.method, method);
        assert.equal(echo.url, path + '?probe=1');
        assert.equal(echo.body, body ? body.toString('hex') : '');
        assert.equal(echo.headers.authorization, 'Bearer test-token');
        assert.equal(echo.headers['content-type'], body ? 'application/octet-stream' : undefined);
        assert.equal(echo.headers['x-telemt-cdn-method'], undefined);
        assert.equal(echo.headers.host, 'proxy.example.com');
        assert.equal(echo.headers['x-forwarded-for'], '127.0.0.1');
        for (const [key, value] of Object.entries(headers)) assert.equal(echo.headers[key.toLowerCase()], value);
        assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
        assert.equal(response.headers.get('pragma'), 'no-cache');
        assert.equal(response.headers.get('expires'), '0');
        assert.equal(response.headers.get('x-session-token'), 'response-token');
        assert.equal(response.headers.get('x-down-cursor'), '123');
      }
    }
    for (const [path, method, marker] of [
      ['/unrelated', 'OPTIONS', 'DELETE'], ['/api/v1/up', 'OPTIONS', 'DELETE'],
      ['/api/v1/session', 'OPTIONS', 'UNKNOWN'], ['/api/v1/ws', 'GET', ''],
    ]) {
      const response = await fetch(url + path, { method, headers: { 'X-Telemt-CDN-Method': marker } });
      const echo = await response.json();
      assert.equal(echo.method, method);
      assert.equal(echo.headers['x-telemt-cdn-method'], undefined);
    }
    const error = await fetch(url + '/error');
    await error.text();
    assert.equal(error.status, 503);
    assert.match(error.headers.get('cache-control'), /no-store/);
  } finally {
    if (nginx && nginx.exitCode === null) {
      const stopped = once(nginx, 'exit');
      nginx.kill('SIGTERM');
      await stopped;
    }
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
