use super::*;

fn envelope(body: &[u8]) -> Request<()> {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body);
    let mut request = Request::builder()
        .method("GET")
        .uri("/relay/nested/api/v1/up")
        .header(METHOD, "POST")
        .header("content-type", "application/octet-stream")
        .header(COUNT, encoded.len().div_ceil(CHUNK).to_string())
        .body(())
        .unwrap();
    for (index, chunk) in encoded.as_bytes().chunks(CHUNK).enumerate() {
        request.headers_mut().insert(
            header::HeaderName::from_bytes(format!("{PREFIX}body-{index}").as_bytes()).unwrap(),
            header::HeaderValue::from_bytes(chunk).unwrap(),
        );
    }
    request
}

#[test]
fn cdn_roundtrip_boundaries_and_budget() {
    for size in [1, 2, 3, 4607, 4608, 4609, 32768] {
        let bytes: Vec<u8> = (0..size).map(|index| index as u8).collect();
        let mut request = envelope(&bytes);
        assert!(adapt(&mut request, "/relay/nested/").is_some());
        assert_eq!(request.method(), Method::POST);
        assert_eq!(decode(&mut request, size).unwrap().as_ref(), bytes);
        assert!(!present(&request));
        let mut request = envelope(&bytes);
        adapt(&mut request, "/relay/nested/").unwrap();
        assert!(decode(&mut request, size - 1).is_none());
    }
    assert!(adapt(&mut envelope(&vec![0; 32769]), "/relay/nested/").is_none());
}

#[test]
fn cdn_rejects_ambiguous_or_malformed_headers() {
    for (name, value) in [
        (COUNT, "01"),
        (COUNT, "0"),
        (COUNT, "99999999999999999999"),
        (METHOD, "DELETE"),
        (METHOD, "post"),
        ("x-telemt-cdn-body-0", "AA=="),
        ("x-telemt-cdn-body-0", "A"),
        ("x-telemt-cdn-body-0", "+/8"),
        ("x-telemt-cdn-body-01", "AA"),
        ("x-telemt-cdn-body-1", "AA"),
        ("x-telemt-cdn-other", "value"),
        ("content-length", "1"),
        ("content-length", "00"),
        ("transfer-encoding", "chunked"),
        ("content-type", "text/plain"),
    ] {
        let mut request = envelope(&[0]);
        request.headers_mut().insert(name, value.parse().unwrap());
        assert!(
            adapt(&mut request, "/relay/nested/").is_none(),
            "{name}: {value}"
        );
    }
    for name in [METHOD, COUNT, "x-telemt-cdn-body-0", "content-type"] {
        let mut request = envelope(&[0]);
        let value = request.headers().get(name).unwrap().clone();
        request.headers_mut().append(name, value);
        assert!(adapt(&mut request, "/relay/nested/").is_none());
    }
    let mut request = envelope(&[0]);
    request
        .headers_mut()
        .insert("x-telemt-cdn-body-0", "AB".parse().unwrap());
    adapt(&mut request, "/relay/nested/").unwrap();
    assert!(decode(&mut request, 64).is_none());
}

#[test]
fn cdn_exact_routes_and_bodyless_operations() {
    for path in [
        "/api/v1/up",
        "/relay/nested//api/v1/up",
        "/relay/nested/api/v1/up?x=1",
        "/relay/nested/api/v1/diagnostic",
        "/relay/nested/api/v1/ws",
    ] {
        let mut request = envelope(&[0]);
        *request.uri_mut() = path.parse().unwrap();
        assert!(adapt(&mut request, "/relay/nested/").is_none());
    }
    for (path, method) in [("api/v1/down", "POST"), ("api/v1/session", "DELETE")] {
        let mut request = Request::builder()
            .method("GET")
            .uri(format!("/relay/nested/{path}"))
            .header(METHOD, method)
            .body(())
            .unwrap();
        adapt(&mut request, "/relay/nested/").unwrap();
        assert!(decode(&mut request, 1).unwrap().is_empty());
    }
}
