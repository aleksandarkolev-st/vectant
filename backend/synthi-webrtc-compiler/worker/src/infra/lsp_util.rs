// use serde::Deserialize;

use std::collections::HashMap;

pub struct LspSessionState {
    pub client_root_uri: Option<String>,
    pub server_root_uri: String,
    /// Track the last-seen document version per URI to reject out-of-order
    /// didChange notifications.  Key = server-side URI after rewrite.
    pub doc_versions: HashMap<String, i64>,
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

#[cfg(test)]
mod tests {
    use super::{rewrite_uris, LspSessionState};
    use std::collections::HashMap;

    fn session_state() -> LspSessionState {
        LspSessionState {
            client_root_uri: Some("file:///synthi/".to_string()),
            server_root_uri: "file:///tmp/synthi-session-42/".to_string(),
            doc_versions: HashMap::new(),
        }
    }

    #[test]
    fn rewrites_nested_workspace_uris_to_the_session_workspace() {
        let mut request = serde_json::json!({
            "textDocument": { "uri": "file:///synthi/include/math.hpp" },
            "related": ["file:///synthi/src/main.cpp"],
        });

        rewrite_uris(&mut request, &session_state(), true);

        assert_eq!(
            request["textDocument"]["uri"],
            "file:///tmp/synthi-session-42/include/math.hpp"
        );
        assert_eq!(
            request["related"][0],
            "file:///tmp/synthi-session-42/src/main.cpp"
        );
    }

    #[test]
    fn rewrites_server_navigation_results_back_to_the_editor_workspace() {
        let mut response = serde_json::json!({
            "uri": "file:///tmp/synthi-session-42/include/math.hpp",
            "targetUri": "file:///tmp/synthi-session-42/src/main.cpp",
        });

        rewrite_uris(&mut response, &session_state(), false);

        assert_eq!(response["uri"], "file:///synthi/include/math.hpp");
        assert_eq!(response["targetUri"], "file:///synthi/src/main.cpp");
    }
}
