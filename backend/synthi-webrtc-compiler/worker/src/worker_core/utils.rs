use serde_json;
use tokio::process::Command;
use anyhow::Result;
use std::process::Stdio;
use crate::worker_core::types::{LspSessionState, CompileRequest, REQUIRED_TOOLS};

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

                    let sep = if !to.ends_with('/') && !clean_suffix.starts_with('/') && !clean_suffix.is_empty() {
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

pub fn make_chunks(data: &[u8], msg_id: u32) -> Vec<Vec<u8>> {
    let chunk_size = 60000; 
    let total_len = data.len();
    let total_chunks = (total_len + chunk_size - 1) / chunk_size;
    let mut chunks = Vec::new();

    for (i, chunk_slice) in data.chunks(chunk_size).enumerate() {
        let mut packet = Vec::with_capacity(16 + chunk_slice.len());
        packet.extend_from_slice(b"CHNK");
        packet.extend_from_slice(&msg_id.to_be_bytes());
        packet.extend_from_slice(&(i as u32).to_be_bytes());
        packet.extend_from_slice(&(total_chunks as u32).to_be_bytes());
        packet.extend_from_slice(chunk_slice);
        chunks.push(packet);
    }
    chunks
}

pub fn system_command(program: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("wsl");
        cmd.arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

pub async fn verify_tooling() -> Result<()> {
    for tool in REQUIRED_TOOLS {
        let status = system_command(tool)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("{tool} not found on PATH");
        }
    }
    Ok(())
}

pub async fn perform_ai_split(req: &CompileRequest) -> Result<serde_json::Value> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let payload = serde_json::json!({
        "code": req.source,
        "lang": req.language,
        "files": req.files,
        "mode": "split"
    });

    let backend_url = std::env::var("AI_BACKEND_URL")
        .unwrap_or_else(|_| "http://172.27.240.1:8000".to_string());
    let url = format!("{}/refactor/split", backend_url);

    let res = client.post(&url)
        .json(&payload)
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;

    let result_str = res["result"].as_str().ok_or(anyhow::anyhow!("No result from AI"))?;
    
    // Clean markdown
    let clean_json = if let Some(start) = result_str.find("```json") {
        let s = &result_str[start+7..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else if let Some(start) = result_str.find("```") {
        let s = &result_str[start+3..];
        if let Some(end) = s.find("```") {
            &s[..end]
        } else {
            s
        }
    } else {
        result_str
    }.trim();

    let split_data: serde_json::Value = match serde_json::from_str(clean_json) {
        Ok(v) => v,
        Err(e) => {
            // Try to repair truncated JSON
            // Assumption: Truncated inside the last string value (explanation)
            if e.to_string().contains("EOF") {
                 let repaired = format!("{}\"}}", clean_json);
                 if let Ok(v) = serde_json::from_str(&repaired) {
                     println!("Successfully repaired truncated JSON response.");
                     v
                 } else {
                     // Try just closing brace if it wasn't in a string
                     let repaired_brace = format!("{}}}", clean_json);
                     if let Ok(v) = serde_json::from_str(&repaired_brace) {
                         println!("Successfully repaired truncated JSON response (brace only).");
                         v
                     } else {
                        println!("Failed to parse AI response: {}", e);
                        println!("Raw content: {}", clean_json);
                        let snippet: String = clean_json.chars().take(1000).collect();
                        return Err(anyhow::anyhow!("JSON Parse Error: {}. \nRaw content snippet: {}...", e, snippet));
                     }
                 }
            } else {
                println!("Failed to parse AI response: {}", e);
                println!("Raw content: {}", clean_json);
                let snippet: String = clean_json.chars().take(1000).collect();
                return Err(anyhow::anyhow!("JSON Parse Error: {}. \nRaw content snippet: {}...", e, snippet));
            }
        }
    };
    Ok(split_data)
}
