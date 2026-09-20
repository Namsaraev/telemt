use super::*;

#[test]
fn web_yandex_cdn_and_upstream_prefer_are_known_keys() {
    for strict in [false, true] {
        let source = format!(
            r#"
[general]
config_strict = {strict}
[web]
yandex_cdn_compat = true
[[upstreams]]
type = "socks5"
address = "127.0.0.1:10808"
prefer = 4
"#
        );
        let parsed: toml::Value = toml::from_str(&source).unwrap();
        assert!(check::collect_unknown_config_keys(&parsed).is_empty());
        assert!(handle_unknown_config_keys(&parsed).is_ok());

        for (key, typo, path) in [
            (
                "yandex_cdn_compat",
                "yandex_cdn_compa",
                "web.yandex_cdn_compa",
            ),
            ("prefer", "preferr", "upstreams[0].preferr"),
        ] {
            let invalid: toml::Value = toml::from_str(&source.replace(key, typo)).unwrap();
            let unknown = check::collect_unknown_config_keys(&invalid);
            assert_eq!(unknown.len(), 1);
            assert_eq!(unknown[0].path, path);
            assert_eq!(handle_unknown_config_keys(&invalid).is_err(), strict);
        }
    }
}
