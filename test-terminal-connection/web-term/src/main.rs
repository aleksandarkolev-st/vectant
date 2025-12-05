mod handle_connection;
mod download;

use handle_connection::handle_connection;

use tokio::net::{TcpListener, TcpStream};
use tokio::io::AsyncReadExt;
use tokio::sync::RwLock;
use hyper::{
    Body, Request as HyperRequest, Response, Uri,
    server::conn::Http
};
use hyper::client::Client;
use hyper::service::service_fn;
use percent_encoding::percent_decode_str;
use lazy_static::lazy_static;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

// -------------------------------
// GLOBAL PORT LIST
// -------------------------------
lazy_static! {
    static ref PORTS: RwLock<HashSet<u16>> = RwLock::new(HashSet::new());
    static ref HTTP_CLIENT: Arc<Client<hyper::client::HttpConnector>> = {
        Arc::new(Client::new())
    };
}

// -------------------------------
// REAL REVERSE PROXY
// -------------------------------
async fn handle_stream(stream: TcpStream) {
    let mut peek_buf = [0u8; 2048];
    let n = match stream.peek(&mut peek_buf).await { Ok(n) => n, Err(_) => return };
    let request_text = String::from_utf8_lossy(&peek_buf[..n]);
    
    // Check for WebSocket upgrade
    let is_ws = request_text.contains("Upgrade: websocket");
    if is_ws {
        if let Err(e) = handle_connection(stream).await {
            eprintln!("WebSocket error: {}", e);
        }
        return;
    }

    let service = service_fn(move |mut req: HyperRequest<Body>| async move {
        // Safe extraction of path
        let path_and_query = req.uri().path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "".to_string());

        // 1. Status endpoint
        if path_and_query == "/status" || path_and_query == "/ports" {
            let ports = PORTS.read().await;
            let ports_vec: Vec<u16> = ports.iter().copied().collect();
            let json_response = format!(
                r#"{{"active_ports": {:?}, "count": {}}}"#,
                ports_vec, ports_vec.len()
            );
            return Ok(Response::builder()
                .status(200)
                .header("Content-Type", "application/json")
                .body(Body::from(json_response))
                .unwrap());
        }

        // 2. Direct Port Access: /port/3000/some/path
        if let Some(rest) = path_and_query.strip_prefix("/port/") {
            let mut parts = rest.splitn(2, '/');
            let port_str = parts.next().unwrap_or("");
            if let Ok(port) = port_str.parse::<u16>() {
                // Optimization: Check existence then drop lock immediately
                let exists = PORTS.read().await.contains(&port);
                if exists {
                    return proxy_to_port(req, port, &path_and_query).await;
                } else {
                    return Ok(Response::builder()
                        .status(404)
                        .header("Content-Type", "application/json")
                        .body(Body::from(format!(r#"{{"error": "Port {} not active"}}"#, port)))
                        .unwrap());
                }
            }
        }

        // 3. (NEW) SMART ASSET ROUTING via REFERER
        // Detects requests like /_next/... that come from a page at /port/XXXX
        if let Some(referer) = req.headers().get("referer").and_then(|v| v.to_str().ok()) {
            // Look for "/port/XXXX" in the Referer URL
            if let Some(idx) = referer.find("/port/") {
                let rest = &referer[idx + 6..]; // Skip "/port/"
                let end = rest.find('/').unwrap_or(rest.len());
                let port_str = &rest[..end];
                
                if let Ok(port) = port_str.parse::<u16>() {
                    let exists = PORTS.read().await.contains(&port);
                    if exists {
                        eprintln!("🔗 Auto-routing orphaned asset '{}' to port {}", path_and_query, port);
                        // We pass the path AS IS (e.g. /_next/static/...)
                        // proxy_to_port handles it correctly because it doesn't start with /port/
                        return proxy_to_port(req, port, &path_and_query).await;
                    }
                }
            }
        }

        // 4. Default / Help Response
        let ports = PORTS.read().await;
        let ports_list: Vec<u16> = ports.iter().copied().collect();
        let help_text = if ports_list.is_empty() {
            "SYNTHI CLOUD IDE BACKEND\n\nNo active ports detected yet.\nStart a dev server (e.g., 'npm run dev').".to_string()
        } else {
            format!(
                "SYNTHI CLOUD IDE BACKEND\n\nActive ports: {:?}\n\nAccess services:\n  http://localhost:8080/port/<port>/<path>\n",
                ports_list
            )
        };
        Ok(Response::builder()
            .status(200)
            .header("Content-Type", "text/plain")
            .body(Body::from(help_text))
            .unwrap())
    });

    if let Err(e) = Http::new().serve_connection(stream, service).await {
        eprintln!("HTTP error: {}", e);
    }
}

// -------------------------------
// HELPER: MIME TYPE DETECTION
// -------------------------------
fn get_mime_type(path: &str) -> Option<&'static str> {
    let decoded = match percent_decode_str(path).decode_utf8() {
        Ok(s) => s.into_owned(),
        Err(_) => path.to_string(),
    };
    let clean = decoded.split('?').next().unwrap_or(&decoded);
    let lower = clean.to_lowercase();

    if lower.ends_with(".js") || lower.ends_with(".mjs") || 
       lower.contains("._.js") || lower.contains("._.mjs") ||
       lower.contains(".acc.js") || lower.contains(".hot-update.js") {
        return Some("application/javascript");
    }
    if lower.ends_with(".css") || lower.contains("._.css") || lower.contains(".module.css") {
        return Some("text/css");
    }
    if lower.ends_with(".json") || lower.contains(".json") { return Some("application/json"); }
    if lower.ends_with(".wasm") { return Some("application/wasm"); }
    if lower.ends_with(".html") { return Some("text/html"); }
    if lower.ends_with(".svg") { return Some("image/svg+xml"); }
    if lower.ends_with(".png") { return Some("image/png"); }
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { return Some("image/jpeg"); }
    if lower.ends_with(".ico") { return Some("image/x-icon"); }
    if lower.ends_with(".woff") || lower.ends_with(".woff2") { return Some("font/woff2"); }
    if lower.ends_with(".ttf") { return Some("font/ttf"); }

    None
}

// -------------------------------
// HELPER: PROXY REQUEST
// -------------------------------
pub async fn proxy_to_port(
    mut req: HyperRequest<Body>,
    port: u16,
    original_path: &str,
) -> Result<Response<Body>, hyper::Error> {
    let client = HTTP_CLIENT.clone();
    
    // 1. URI Rewriting
    let prefix_with_slash = format!("/port/{}/", port);
    let prefix_no_slash = format!("/port/{}", port);
    
    let stripped = if original_path.starts_with(&prefix_with_slash) {
        original_path.strip_prefix(&prefix_with_slash).unwrap()
    } else if original_path.starts_with(&prefix_no_slash) {
        original_path.strip_prefix(&prefix_no_slash).unwrap()
    } else {
        original_path
    };
    
    let normalized = if stripped.starts_with('/') {
        stripped.to_string()
    } else {
        format!("/{}", stripped)
    };
    
    let new_uri_string = format!("http://127.0.0.1:{}{}", port, normalized);
    let new_uri = new_uri_string.parse::<Uri>().unwrap();
    
    *req.uri_mut() = new_uri;

    // 2. HOST HEADER REWRITE
    req.headers_mut().insert("host", format!("127.0.0.1:{}", port).parse().unwrap());
    
    // 3. Send Request
    let upstream_res = match tokio::time::timeout(
        Duration::from_secs(30),
        client.request(req)
    ).await {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Ok(Response::builder()
                .status(504)
                .body(Body::from("Gateway Timeout"))
                .unwrap());
        }
    };
    
    let (parts, body) = upstream_res.into_parts();
    let inferred_mime = get_mime_type(&normalized);

    eprintln!("🔄 {} -> {} | Status: {} | MIME: {:?}", original_path, new_uri_string, parts.status, inferred_mime);

    let mut builder = Response::builder().status(parts.status);
    
    for (name, value) in parts.headers.iter() {
        let name_str = name.as_str().to_lowercase();
        if name_str != "content-type" && 
           name_str != "x-content-type-options" && 
           name_str != "content-length" {
            builder = builder.header(name, value);
        }
    }

    // 4. Force correct MIME type (e.g. for those orphaned assets)
    if let Some(mime) = inferred_mime {
        builder = builder.header("Content-Type", mime);
    } else if let Some(upstream_ct) = parts.headers.get("content-type") {
        builder = builder.header("Content-Type", upstream_ct);
    }
    
    builder = builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "*");

    Ok(builder.body(body).unwrap())
}

// -------------------------------
// DETECT OPEN PORTS
// -------------------------------
async fn port_scanner() {
    loop {
        let mut detected = HashSet::new();
        if let Ok(output) = scan_ports_native().await { detected = output; }
        else if let Ok(output) = scan_ports_shell().await { detected = output; }

        let mut healthy_ports = HashSet::new();
        for port in &detected {
            if port != &8080 && is_port_healthy(*port).await {
                healthy_ports.insert(*port);
            }
        }

        let mut ports = PORTS.write().await;
        if *ports != healthy_ports {
            *ports = healthy_ports.clone();
            println!("🔍 Active ports: {:?}", *ports);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

async fn scan_ports_native() -> Result<HashSet<u16>, Box<dyn std::error::Error + Send + Sync>> {
    let mut detected = HashSet::new();
    let common_ports = vec![3000, 3001, 3002, 3003, 5173, 5174, 8080, 8081, 4000, 4001, 5000, 8000];
    
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = tokio::fs::read_to_string("/proc/net/tcp").await {
            for line in contents.lines().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    if let Some(addr_part) = parts.get(1) {
                        if let Some(port_hex) = addr_part.split(':').nth(1) {
                            if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                                if port != 8080 && port > 1024 { detected.insert(port); }
                            }
                        }
                    }
                }
            }
        }
    }
    
    for port in common_ports {
        if port != 8080 {
            if let Ok(Ok(_)) = tokio::time::timeout(
                Duration::from_millis(50),
                tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
            ).await {
                detected.insert(port);
            }
        }
    }
    Ok(detected)
}

async fn scan_ports_shell() -> Result<HashSet<u16>, Box<dyn std::error::Error + Send + Sync>> {
    let output = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("ss -tuln 2>/dev/null | grep LISTEN | awk '{print $5}' | awk -F: '{print $NF}' || netstat -tuln 2>/dev/null | grep LISTEN | awk '{print $4}' | awk -F: '{print $NF}'")
        .output()
        .await?;

    if !output.status.success() { return Err("Shell failed".into()); }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut detected = HashSet::new();
    for line in text.lines() {
        if let Ok(port) = line.trim().parse::<u16>() {
            if port != 8080 { detected.insert(port); }
        }
    }
    Ok(detected)
}

async fn is_port_healthy(port: u16) -> bool {
    match tokio::time::timeout(
        Duration::from_millis(200),
        tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
    ).await {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

#[tokio::main]
async fn main() {
    println!("🚀 SYNTHI backend running on 0.0.0.0:8080");
    tokio::spawn(port_scanner());
    let listener = TcpListener::bind("0.0.0.0:8080").await.unwrap();
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(handle_stream(stream));
    }
}
