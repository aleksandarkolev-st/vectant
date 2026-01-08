use tokio::process::Command;
use std::process::Stdio;

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

pub fn get_wsl_host_ip() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let is_wsl = std::fs::read_to_string("/proc/version")
        .map(|s| s.to_lowercase().contains("microsoft"))
        .unwrap_or(false);
    if !is_wsl {
        return None;
    }

    // METHOD 1: Try `ip route` (most reliable)
    if let Ok(output) = std::process::Command::new("ip")
        .args(&["route", "show", "default"])
        .output() 
    {
        let s = String::from_utf8_lossy(&output.stdout);
        // Look for "via <IP>"
        if let Some(pos) = s.find("via ") {
            let rest = &s[pos + 4..];
            if let Some(end) = rest.find(' ') {
                let ip = &rest[..end];
                return Some(ip.to_string());
            }
        }
    }

    // METHOD 2: Try to parse default route from /proc/net/route
    if let Ok(content) = std::fs::read_to_string("/proc/net/route") {
        for line in content.lines().skip(1) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 && parts[1] == "00000000" {
                if let Ok(val) = u32::from_str_radix(parts[2], 16) {
                    let bytes = val.to_le_bytes();
                     return Some(format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3]));
                }
            }
        }
    }
    if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in content.lines() {
            if line.starts_with("nameserver") {
                if let Some(ip) = line.split_whitespace().nth(1) {
                    return Some(ip.to_string());
                }
            }
        }
    }
    None
}

pub fn system_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::null())
       .stdout(Stdio::piped())
       .stderr(Stdio::piped());
    cmd
}

