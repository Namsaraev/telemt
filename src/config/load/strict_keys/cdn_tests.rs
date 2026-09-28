use super::*;

#[test]
fn web_cdn_key_is_per_vhost_and_strict() {
    let source = "[general]\nconfig_strict = true\n[[web.vhosts]]\nhost = 'cdn.example.com'\nyandex_cdn_compat = true\n";
    let parsed: toml::Value = toml::from_str(source).unwrap();
    assert!(handle_unknown_config_keys(&parsed).is_ok());
    for source in [
        source.replace("yandex_cdn_compat", "yandex_cdn_compa"),
        "[general]\nconfig_strict = true\n[web]\nyandex_cdn_compat = true".to_string(),
    ] {
        let parsed: toml::Value = toml::from_str(&source).unwrap();
        assert!(handle_unknown_config_keys(&parsed).is_err());
    }
}
