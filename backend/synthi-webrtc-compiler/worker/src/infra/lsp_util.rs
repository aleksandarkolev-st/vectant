use serde::Deserialize;

pub struct LspSessionState {
    pub client_root_uri: Option<String>,
    pub server_root_uri: String,
}

pub fn rewrite_uris(val: &mut serde_json::Value, state: &LspSessionState, to_server: bool) {
    if let Some(client_uri) = &state.client_root_uri {
        let (from, to) = if to_server {
            (client_uri.as_str(), state.server_root_uri.as_str())
        } else {
            (state.server_root_uri.as_str(), client_uri.as_str())
        };

        match val {
            serde_json::Value::String(s) => {
                if s.starts_with(from) {
                    let suffix = &s[from.len()..];

                    // Fix double slash issue: if 'to' ends with '/' and suffix starts with '/', strip one.
                    let clean_suffix = if to.ends_with('/') && suffix.starts_with('/') {
                        &suffix[1..]
                    } else {
                        suffix
                    };

                    let sep = if !to.ends_with('/')
                        && !clean_suffix.starts_with('/')
                        && !clean_suffix.is_empty()
                    {
                        "/"
                    } else {
                        ""
                    };
                    *s = format!("{}{}{}", to, sep, clean_suffix);
                }
            }
            serde_json::Value::Array(arr) => {
                for v in arr {
                    rewrite_uris(v, state, to_server);
                }
            }
            serde_json::Value::Object(map) => {
                for (_, v) in map {
                    rewrite_uris(v, state, to_server);
                }
            }
            _ => {}
        }
    }
}
