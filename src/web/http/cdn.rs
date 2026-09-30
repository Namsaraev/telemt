use base64::Engine as _;
use bytes::Bytes;
use hyper::header;
use hyper::{Method, Request};

const PREFIX: &str = "x-telemt-cdn-";
const METHOD: &str = "x-telemt-cdn-method";
const COUNT: &str = "x-telemt-cdn-body-count";
const CHUNK: usize = 6144;
const MAX_BODY: usize = 32768;

/// Validated envelope metadata; decoded bytes remain under normal body admission.
#[derive(Clone)]
pub(super) struct Envelope {
    count: usize,
    bytes: usize,
}

/// Detects reserved envelope headers on every route, including decoy paths.
pub(super) fn present<B>(request: &Request<B>) -> bool {
    request
        .headers()
        .keys()
        .any(|name| name.as_str().starts_with(PREFIX))
}

fn single<'a, B>(request: &'a Request<B>, name: &str) -> Option<&'a str> {
    let mut values = request.headers().get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

/// Validates a canonical GET envelope without allocating decoded payload data.
pub(super) fn adapt<B>(request: &mut Request<B>, base: &str) -> Option<()> {
    if request.method() != Method::GET
        || request.uri().query().is_some()
        || request.headers().contains_key(header::TRANSFER_ENCODING)
        || request.headers().contains_key(header::TRAILER)
        || (request.headers().contains_key(header::CONTENT_LENGTH)
            && single(request, "content-length") != Some("0"))
    {
        return None;
    }
    let suffix = request.uri().path().strip_prefix(base)?;
    let method = single(request, METHOD)?;
    let payload = match (suffix, method) {
        ("api/v1/session" | "api/v1/up", "POST") => true,
        ("api/v1/down", "POST") | ("api/v1/session", "DELETE") => false,
        _ => return None,
    };
    let method = if method == "POST" {
        Method::POST
    } else {
        Method::DELETE
    };
    let mut bytes = 0;
    let count = if payload {
        if !super::request::binary_content_type(request) {
            return None;
        }
        let value = single(request, COUNT)?;
        let count = value.parse::<usize>().ok()?;
        if count == 0 || count > (MAX_BODY * 4).div_ceil(3 * CHUNK) || count.to_string() != value {
            return None;
        }
        for index in 0..count {
            let name = format!("{PREFIX}body-{index}");
            let value = single(request, &name)?;
            if value.is_empty()
                || value.len() > CHUNK
                || (index + 1 < count && value.len() != CHUNK)
                || value.len() % 4 == 1
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            {
                return None;
            }
            bytes += value.len() * 3 / 4;
        }
        if bytes > MAX_BODY {
            return None;
        }
        count
    } else {
        if request.headers().contains_key(header::CONTENT_TYPE) {
            return None;
        }
        0
    };
    let actual = request
        .headers()
        .keys()
        .filter(|name| name.as_str().starts_with(PREFIX))
        .count();
    if actual != 1 + if payload { 1 + count } else { 0 } {
        return None;
    }
    request.extensions_mut().insert(Envelope { count, bytes });
    *request.method_mut() = method;
    Some(())
}

/// Decodes into one bounded allocation after the existing body permit is acquired.
pub(super) fn decode<B>(request: &mut Request<B>, limit: usize) -> Option<Bytes> {
    let envelope = request.extensions_mut().remove::<Envelope>()?;
    if envelope.bytes > limit {
        return None;
    }
    let mut decoded = vec![0; envelope.bytes];
    let mut offset = 0;
    for index in 0..envelope.count {
        let name = format!("{PREFIX}body-{index}");
        let value = single(request, &name)?;
        let length = value.len() * 3 / 4;
        let written = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode_slice(value, &mut decoded[offset..offset + length])
            .ok()?;
        if written != length {
            return None;
        }
        offset += written;
        request.headers_mut().remove(name);
    }
    request.headers_mut().remove(METHOD);
    request.headers_mut().remove(COUNT);
    request.headers_mut().remove(header::CONTENT_LENGTH);
    Some(Bytes::from(decoded))
}

#[cfg(test)]
mod tests;
