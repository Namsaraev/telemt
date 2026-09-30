use super::*;

#[test]
fn web_cdn_mode_defaults_false_and_survives_serialization() {
    let direct = load_config_from_temp_toml(WEB_CONFIG);
    assert!(!direct.web.vhosts[0].yandex_cdn_compat);
    let source = format!(
        "[general]\nconfig_strict = true\n{}\n[web.limits]\nmax_header_bytes = 65536\n",
        WEB_CONFIG.replace(
            "[[web.vhosts]]",
            "[[web.vhosts]]\nyandex_cdn_compat = true\nbase_path = 'relay/nested'"
        )
    );
    let config = load_config_from_temp_toml(&source);
    let vhost = &config.web.vhosts[0];
    assert!(vhost.yandex_cdn_compat);
    let runtime = config.web.runtime.as_ref().unwrap();
    assert!(runtime.vhosts["proxy.example.com"].yandex_cdn_compat);
    assert_eq!(runtime.vhosts["proxy.example.com"].base, "/relay/nested/");
    let roundtrip: WebVhostConfig = toml::from_str(&toml::to_string(vhost).unwrap()).unwrap();
    assert_eq!(roundtrip, *vhost);
    let invalid = source.replace("65536", "16384");
    assert!(load_config_error_from_temp_toml(&invalid).contains("max_header_bytes"));
    let invalid = source.replace("https-lanes", "websocket");
    assert!(load_config_error_from_temp_toml(&invalid).contains("HTTPS carriers"));
}

#[test]
fn web_cdn_and_direct_vhosts_keep_independent_modes() {
    let source = format!(
        "{WEB_CONFIG}\n[web.limits]\nmax_header_bytes = 65536\n{}",
        r#"
[[web.vhosts]]
host = "cdn.example.com"
base_path = "relay/nested"
yandex_cdn_compat = true
public_addr = "192.0.2.10:443"

[web.vhosts.decoy]
mode = "http_upstream"
upstream = "http://127.0.0.1:18081"

[[web.vhosts.profiles]]
user = "alice"
secret_mode = "dd"
"#
    );
    let config = load_config_from_temp_toml(&source);
    let runtime = config.web.runtime.as_ref().unwrap();
    assert!(!runtime.vhosts["proxy.example.com"].yandex_cdn_compat);
    assert!(runtime.vhosts["cdn.example.com"].yandex_cdn_compat);
    assert_ne!(
        runtime.vhosts["proxy.example.com"].capabilities,
        runtime.vhosts["cdn.example.com"].capabilities
    );
}
