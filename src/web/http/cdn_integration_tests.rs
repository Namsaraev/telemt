use super::*;

fn wire(path: &str, token: &str, method: &str, body: Option<&[u8]>, extra: &str) -> Vec<u8> {
    let mut head = format!("GET {path} HTTP/1.1\r\nHost: proxy.example.com\r\nX-Forwarded-For: 192.0.2.10\r\nAuthorization: Bearer {token}\r\nX-Telemt-CDN-Method: {method}\r\nConnection: close\r\n{extra}");
    if let Some(body) = body {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body);
        head.push_str(&format!("Content-Type: application/octet-stream\r\nX-Telemt-CDN-Body-Count: {}\r\n", encoded.len().div_ceil(6144)));
        for (index, chunk) in encoded.as_bytes().chunks(6144).enumerate() {
            head.push_str(&format!("X-Telemt-CDN-Body-{index}: {}\r\n", std::str::from_utf8(chunk).unwrap()));
        }
    }
    head.push_str("\r\n");
    head.into_bytes()
}

#[tokio::test]
async fn web_cdn_prefixed_session_uplink_retry_downlink_and_cleanup() {
    let capability = [92u8; 32];
    let mut config = runtime_config_with_base(capability, WebCarrier::Https, "/relay/nested/");
    config.web.limits.max_header_bytes = 65536;
    config.web.timeouts.long_poll_secs = 1;
    let routing = Arc::get_mut(config.web.runtime.as_mut().unwrap()).unwrap();
    Arc::get_mut(routing.vhosts.get_mut("proxy.example.com").unwrap()).unwrap().yandex_cdn_compat = true;
    let generation = test_runtime_generation(1, config);
    let runtime = WebProcessRuntime::start(Arc::new(ArcSwap::from(Arc::clone(&generation))));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(capability);
    let bridge = request(&listener, &runtime, format!("GET /relay/nested/?bridge={encoded} HTTP/1.1\r\nHost: proxy.example.com\r\nX-Forwarded-For: 192.0.2.10\r\nConnection: close\r\n\r\n").into_bytes()).await;
    let html = std::str::from_utf8(split_response(&bridge).1).unwrap();
    assert!(html.contains("yandexCdnCompat:true"));
    assert!(!html.contains("__YANDEX_CDN_COMPAT__"));
    let bootstrap = html.split_once("bootstrap=\"").unwrap().1.split('"').next().unwrap();
    let hello = frame::encode(FrameType::Hello, 0, &[1]);
    let created = request(&listener, &runtime, wire("/relay/nested/api/v1/session", bootstrap, "POST", Some(&hello), "")).await;
    let (headers, _) = split_response(&created);
    assert!(headers.starts_with(b"HTTP/1.1 200"));
    let token = response_header(headers, "x-session-token");
    let pong = frame::encode(FrameType::Pong, 0, &[]);
    for _ in 0..2 {
        let response = request(&listener, &runtime, wire("/relay/nested/api/v1/up", token, "POST", Some(&pong), "X-Up-Seq: 1\r\n")).await;
        assert!(response.starts_with(b"HTTP/1.1 204"));
    }
    let large = pong.repeat(4096);
    let response = request(&listener, &runtime, wire("/relay/nested/api/v1/up", token, "POST", Some(&large), "X-Up-Seq: 2\r\n")).await;
    assert!(response.starts_with(b"HTTP/1.1 204"));
    for path in ["/api/v1/up", "/relay/nested//api/v1/up", "/relay/nested/api/v1/up?q=1"] {
        let response = request(&listener, &runtime, wire(path, token, "POST", Some(&pong), "X-Up-Seq: 2\r\n")).await;
        assert!(response.starts_with(b"HTTP/1.1 404"));
        assert_eq!(response_header(split_response(&response).0, "cache-control"), "no-store");
    }
    let down = request(&listener, &runtime, wire("/relay/nested/api/v1/down", token, "POST", None, "X-Down-Cursor: 0\r\n")).await;
    assert!(down.starts_with(b"HTTP/1.1 204"));
    let close = request(&listener, &runtime, wire("/relay/nested/api/v1/session", token, "DELETE", None, "")).await;
    assert!(close.starts_with(b"HTTP/1.1 204"));
    let wrong_host = String::from_utf8(wire("/api/v1/session", token, "POST", Some(&hello), "")).unwrap().replace("Host: proxy.example.com", "Host: other.example.com");
    let rejected = request(&listener, &runtime, wrong_host.into_bytes()).await;
    assert!(rejected.starts_with(b"HTTP/1.1 404"));
    runtime.shutdown().await;
    generation.stop_sessions().await;
    generation.stop_background_tasks().await;
}
