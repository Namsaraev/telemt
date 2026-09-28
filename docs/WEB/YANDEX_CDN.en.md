# Per-vhost Yandex CDN compatibility

This fork adds `yandex_cdn_compat` to `[[web.vhosts]]` on Telemt 3.5.8.
It defaults to `false`. The old global `[web]` option and Nginx method-restoration
patch are not used. Strict configuration rejects the global option.

The direct virtual host retains standard POST bodies and DELETE cleanup.
On the CDN virtual host, the embedded bridge sends GET with an empty body;
Telemt validates the envelope and passes the decoded payload to its existing
authenticated handlers. This applies to the JavaScript bridge, not native
clients that bypass it. Live provider/client interoperability must be tested.

## Configuration

Merge these settings with an existing valid WEB listener, access user and
decoy configuration. These are neutral examples, not deployment credentials.

```toml
[web]
enabled = true
carrier = "https"
carriers = ["https-lanes"]

[web.limits]
max_header_bytes = 65536

[[web.vhosts]]
host = "direct.example.com"
base_path = "relay/nested"
public_addr = "192.0.2.10:443"
yandex_cdn_compat = false

[web.vhosts.decoy]
mode = "http_upstream"
upstream = "http://127.0.0.1:18081"

[[web.vhosts.profiles]]
user = "web-user"
secret_mode = "dd"

[[web.vhosts]]
host = "cdn.example.com"
base_path = "relay/nested"
public_addr = "192.0.2.10:443"
yandex_cdn_compat = true

[web.vhosts.decoy]
mode = "http_upstream"
upstream = "http://127.0.0.1:18081"

[[web.vhosts.profiles]]
user = "web-user"
secret_mode = "dd"
```

Telemt 3.5.8 caps `max_header_bytes` at 65536; 131072 is not a valid value.
Enabling a CDN vhost requires 65536. The existing global memory-envelope
validation still applies. Header limits are process-owned and require restart.
Use only `https` and `https-lanes` in the shared carrier policy when enabling
a CDN vhost; configuration rejects WebSocket candidates in this combination.
With `https-lanes`, verify HTTP/2 on the client-facing route.

Host and Base Path remain the existing capability identity. Preserve the exact
case and path, including nested segments; do not strip the prefix in Nginx.
An empty `base_path` also works. Each host has its own generated proxy link.
The compatibility flag is serialized with the vhost for configuration round
trips. A separate panel may still discard fields it does not recognize: verify
its save behavior before using it to edit these vhosts.

## Wire contract

Paths below are appended to `/relay/nested` in the example.

| Operation | Logical method | Wire method | Payload |
| --- | --- | --- | --- |
| `/api/v1/session` create | POST | GET | HELLO in numbered headers |
| `/api/v1/up` | POST | GET | Frames in numbered headers |
| `/api/v1/down` | POST | GET | None |
| `/api/v1/session` cleanup | DELETE | GET | None |

Every adapted request includes `X-Telemt-CDN-Method: POST` or `DELETE`.
For payload requests, encode the complete binary payload as unpadded base64url,
split into chunks of 6144 ASCII characters, and send:

```http
X-Telemt-CDN-Method: POST
Content-Type: application/octet-stream
X-Telemt-CDN-Body-Count: 2
X-Telemt-CDN-Body-0: <first 6144 characters>
X-Telemt-CDN-Body-1: <remaining characters>
```

The decoded payload ceiling is 32768 bytes (43691 encoded characters, at most
eight headers). All chunks except the last must have exactly 6144 characters.
Count and indexes are canonical decimal; duplicates, gaps, extra reserved
headers, padding, invalid alphabet and noncanonical trailing bits are rejected.
Bodyless operations omit both payload count/chunks and Content-Type.
Transfer-Encoding, trailers, nonzero Content-Length and nonempty wire bodies
are rejected. An absent Content-Length or one canonical `0` is accepted.

Authorization, sequence, cursor, lane and carrier-negotiation headers retain
their original meaning. Markers are not credentials. Decoding happens only
after normal handler authentication and body-budget admission. Invalid or
misplaced envelopes never forward their headers to the decoy.

The CDN bridge limits upload batches to 32768 bytes and divides larger DATA
frames into 16 KiB stream fragments before queue reservation. Stream IDs and
payload byte order are preserved; the added frame headers count toward queue
limits. Downlink response limits remain unchanged. Direct bridge framing is
unchanged. Retries keep the same encoded payload, sequence and lane; recovery
keeps the bridge's mode. Diagnostic sideband scripts are omitted on CDN pages
because they use POST. Direct-page diagnostics remain available.

## Nginx and CDN

Example location in the CDN TLS server; certificate setup is intentionally
omitted. No `proxy_method` or body reconstruction belongs in Nginx.

```nginx
server_name cdn.example.com;
client_header_buffer_size 16k;
large_client_header_buffers 8 16k;

location ^~ /relay/nested/ {
    proxy_pass http://127.0.0.1:18080;
    proxy_http_version 1.1;
    proxy_set_header Host cdn.example.com;
    proxy_set_header Connection "";
    proxy_pass_request_headers on;
    proxy_pass_request_body on;
    proxy_cache off;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_next_upstream off;
    proxy_read_timeout 65s;
    proxy_send_timeout 65s;
    add_header Cache-Control "no-store, private" always;
}
```

Use the direct host in its own server/location. For client identity, retain a
verified trusted-proxy configuration: accept a CDN client-IP header only when
the origin is restricted to verified CDN peers and the provider overwrites
client-supplied values. Do not blindly trust a public forwarding header.

Disable CDN caching for the entire base path, including bridge issuance,
recovery, successful API replies and errors; purge older cached objects.
Nginx `proxy_cache off` does not configure CDN caching. Forward every numbered
payload header and all existing authentication/carrier headers unchanged.
Preserve raw paths, query strings on bridge/recovery requests, and response
token/cursor headers. Verify provider aggregate-header limits and timeouts.
Disable logging of payload headers and credentials at every hop.

## Validation and reload

```sh
node --test src/web/bridge/request.test.cjs
cargo test --locked web
cargo build --release --locked
```

Tests cover wire encoding, chunk boundaries, exact Base Path routing,
malformed envelopes, configuration strict keys, framing, retry ownership and
session lifecycle. They do not prove actual CDN behavior or Telegram support.
Test both links with text/media, large uploads/downloads, idle polling,
reconnect, lock/unlock and network changes through the intended CDN/network.

Changing the flag takes effect in the new runtime generation and newly issued
pages. Reopen existing bridge connections after a change; old pages retain
their original mode and can be rejected if compatibility is disabled. Rollback
sets the vhost flag to false and uses a route supporting normal POST/DELETE.
