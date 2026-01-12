use regex::Regex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn calculate_hash<T: Hash>(t: &T) -> u64 {
    let mut s = DefaultHasher::new();
    t.hash(&mut s);
    s.finish()
}

/// Parse AppState struct fields from shared.h content
/// Returns a list of (field_name, field_type, default_value) tuples for int fields
/// Default value is extracted from declarations like "int btn_x = 200;"
pub fn parse_appstate_int_fields_with_defaults(shared_content: &str) -> Vec<(String, String, Option<i64>)> {
    let mut fields = Vec::new();
    
    // Find AppState struct definition
    let struct_re = Regex::new(r"struct\s+AppState\s*\{([^}]*)\}").ok();
    
    if let Some(re) = struct_re {
        if let Some(captures) = re.captures(shared_content) {
            if let Some(body) = captures.get(1) {
                let body_str = body.as_str();

                
                // Parse individual field declarations WITH default values
                // Match patterns like: int x; or int x = 10; or int btn_x = 330, btn_y = 10;
                // Also handle inline declarations like: int x = 0, y = 0, dx = 5, dy = 5;

                // First, handle comma-separated declarations on single lines
                // Pattern: int field1 = val1, field2 = val2, ...;
                let multi_decl_re =
                    Regex::new(r"\b(int|unsigned|char|short|long)\s+([^;]+);").ok();

                if let Some(mre) = multi_decl_re {
                    for cap in mre.captures_iter(body_str) {
                        if let (Some(type_match), Some(decls_match)) = (cap.get(1), cap.get(2)) {
                            let field_type = type_match.as_str().to_string();
                            let decls_str = decls_match.as_str();

                            // Split by comma and parse each field
                            for decl in decls_str.split(',') {
                                let decl = decl.trim();
                                if decl.is_empty() {
                                    continue;
                                }

                                // Parse "name = value" or just "name"
                                let parts: Vec<&str> = decl.splitn(2, '=').collect();
                                let field_name = parts[0].trim().to_string();

                                // Skip internal fields
                                if field_name.starts_with("_")
                                    || field_name == "magic"
                                    || field_name == "struct_size"
                                    || field_name == "abi_version"
                                    || field_name.is_empty()
                                {
                                    continue;
                                }

                                // Parse default value if present
                                let default_value = if parts.len() > 1 {
                                    let val_str = parts[1].trim();
                                    // Try to parse as integer
                                    val_str.parse::<i64>().ok()
                                } else {
                                    None
                                };

                                fields.push((field_name, field_type.clone(), default_value));
                            }
                        }
                    }
                }
            }
        }
    }

    // If no fields found, use common defaults
    if fields.is_empty() {
        fields = vec![
            ("x".to_string(), "int".to_string(), Some(0)),
            ("y".to_string(), "int".to_string(), Some(0)),
            ("dx".to_string(), "int".to_string(), Some(5)),
            ("dy".to_string(), "int".to_string(), Some(5)),
            ("running".to_string(), "int".to_string(), Some(1)),
            ("paused".to_string(), "int".to_string(), Some(0)),
        ];
    }

    fields
}

/// Generate state serialization code with explicit default values from shared.h
pub fn generate_state_serialization_code_with_defaults(
    fields: &[(String, String, Option<i64>)],
    prefix: &str,
) -> String {
    crate::hmr::binary_state::generate_msgpack_serialization_code_with_defaults(fields, prefix)
}
