use super::*;

#[test]
fn web_cdn_mode_defaults_false_and_survives_serialization() {
    let direct = load_config_from_temp_toml(WEB_CONFIG);
    assert!(!direct.web.vhosts[0].yandex_cdn_compat);
    let source = format!("[general]\nconfig_strict = true\n{}\n[web.limits]\nmax_header_bytes = 65536\n",
        WEB_CONFIG.replace("[[web.vhosts]]", "[[web.vhosts]]\nyandex_cdn_compat = true\nbase_path = 'relay/nested'"));
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
