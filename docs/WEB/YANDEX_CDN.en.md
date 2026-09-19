# Yandex CDN compatibility for the WEB bridge

Enable the opt-in bridge method adapter in the existing `[web]` table:

```toml
[web]
enabled = true
yandex_cdn_compat = true
carrier = "https"
carriers = false
```

Keep your existing WEB listener, vhost, profile, and decoy configuration from
[WEB_PROXY.en.md](WEB_PROXY.en.md). For initial CDN testing use the fixed `https`
carrier above. `https-lanes` also uses the adapter, but requires working HTTP/2
on the client-facing CDN. This option does not adapt WebSocket connections or
native clients that issue HTTP requests without executing the embedded bridge.

The default is `false`. Configuration reload affects newly issued bridge pages;
an already loaded page keeps its mode, including during recovery. Reopen the
proxy connection after changing it. The mode applies to all WEB vhosts in this
process. Server-side authentication, frame parsing, session state, retry budgets,
and HTTP handlers are unchanged. Nginx must restore methods before Telemt.

| Operation | Standard | CDN wire method | Marker | Telemt receives |
| --- | --- | --- | --- | --- |
| Create session | POST `/api/v1/session` | OPTIONS | absent | POST with HELLO |
| Uplink | POST `/api/v1/up` | OPTIONS | absent | POST with frames |
| Downlink | POST `/api/v1/down` | GET | absent | POST without body |
| Cleanup | DELETE `/api/v1/session` | OPTIONS | `X-Telemt-CDN-Method: DELETE` | DELETE without body |

The marker is a routing hint, not an authentication credential. It is stripped
before Telemt. Authorization and the existing carrier, sequence, cursor, and
lane headers are preserved. Downlink and cleanup have no Content-Type.

## Origin Nginx configuration

Copy [yandex-cdn-map.conf](nginx/yandex-cdn-map.conf) and
[yandex-cdn-proxy.conf](nginx/yandex-cdn-proxy.conf) to `/etc/nginx/snippets/`.
Include the map once inside `http {}` (for example at the top of a file loaded
by `/etc/nginx/conf.d/*.conf`). If `map_hash_bucket_size` is already configured,
keep one directive with a value of at least 64. Include the proxy snippet only in the dedicated
WEB vhost location. All `proxy_set_header` directives belong in that same
location because defining them there disables inheritance from the server.

```nginx
# This file is loaded inside http {}.
include /etc/nginx/snippets/yandex-cdn-map.conf;

upstream telemt_yandex_web {
    server 127.0.0.1:18080;
    keepalive 64;
}

server {
    listen 443 ssl;
    server_name tmt.rusc1.pin.dpdns.org;
    access_log off;

    ssl_certificate /etc/letsencrypt/live/tmt.rusc1.pin.dpdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tmt.rusc1.pin.dpdns.org/privkey.pem;

    # Populate this file with set_real_ip_from for verified CDN origin peers only.
    include /etc/nginx/snippets/yandex-cdn-trusted-peers.conf;
    # Use this header only if the CDN overwrites it with the actual client IP.
    real_ip_header X-Forwarded-For-Y;
    real_ip_recursive off;

    client_max_body_size 2m;

    location / {
        proxy_pass http://telemt_yandex_web;
        proxy_http_version 1.1;
        proxy_set_header Host tmt.rusc1.pin.dpdns.org;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        include /etc/nginx/snippets/yandex-cdn-proxy.conf;
    }
}
```

The domain, certificate paths, listener port, and trusted peer ranges are
deployment values: match them to your server before running `nginx -t` and
reloading Nginx. The example uses a fixed HTTPS carrier. For a different origin
TLS hostname, keep the existing origin certificate/server_name and CDN SNI
configuration; the upstream Host must still equal the public Telemt WEB vhost.
No live server configuration is modified by this patch.

Populate the trusted-peer include from your CDN's verified origin-facing IP
ranges; do not trust `0.0.0.0/0` or `::/0`. `X-Forwarded-For-Y` was the header
observed in the referenced deployment; verify it is overwritten by that CDN
resource, including when the client supplies a forged value. If your resource
uses a different verified header, change `real_ip_header` accordingly. Do not
pass a raw client-supplied X-Forwarded-For list to Telemt. Telemt should bind to
loopback and trust only Nginx, for example `web_trusted_proxy_cidrs =
["127.0.0.1/32"]` with `web_client_ip_source = "x_forwarded_for"`.

Do not add a generic `OPTIONS` 204 response or CORS preflight handler to these
paths: OPTIONS carries the actual binary payload. Do not force Content-Type,
set a replacement body, drop request bodies, or rewrite paths/query strings.
Unmatched methods and paths pass through unchanged. Standard POST/DELETE
requests continue to work through the same Nginx configuration.

## CDN settings and deployment checks

Disable CDN caching for the dedicated hostname, including bridge HTML, recovery
responses, all `/api/v1/*` responses, errors, and stale responses. Purge any
previously cached objects. Nginx `proxy_cache off` controls Nginx only; response
no-store headers do not override a CDN rule that explicitly forces caching.
Do not enable redirects, content rewriting, or response compression for the
binary API. Forward Authorization, Content-Type, the cleanup marker, all
`X-Carrier-*`, `X-Up-Seq`, `X-Down-Cursor`, `X-Lane-ID`, and response token/cursor
headers without modification. Preserve query strings used for bridge issuance
and recovery. OPTIONS must forward its full binary body.

Keep the default 25-second Telemt long poll below the CDN origin timeout.
Test through the actual CDN with Telegram: establish a session, transfer data
both ways, leave it idle across several polls, reconnect, and close it. Verify
that cleanup reaches Telemt as DELETE, downlink replies never come from cache,
and two clients retain distinct trusted client identities. Repeat with HTTPS
lanes if enabling that carrier. Local/CI tests cannot establish provider-specific
body forwarding, cache policy, timeout, or Telegram interoperability.

Rollback: set `yandex_cdn_compat = false`, reload configuration, and reconnect
through a route that allows standard POST/DELETE. The Nginx adapter also accepts
the standard methods, so it need not be removed first.

## Validation

The existing Build workflow runs `node --test src/web/bridge/request.test.cjs`,
the Nginx round-trip test, `cargo test web`, and the release build. To run the
Nginx test locally on Linux, install Nginx and run
`node --test src/web/bridge/nginx.test.cjs` from the repository root. The test
uses temporary configuration, loopback ports, and a private Nginx process.

References: [Nginx proxy_method](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_method),
[Nginx real-IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html),
[Yandex HTTP method settings](https://yandex.cloud/en/docs/cdn/operations/resources/configure-http).
