use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

/// Debounce delay in milliseconds
const DEBOUNCE_MS: u64 = 300;

/// File change types for rebuild decision
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileChangeType {
    SharedHeader,  // shared.h changed - rebuild both
    CoreSource,    // core.cpp changed - rebuild core (+ gui if ABI changed)
    GuiSource,     // gui.cpp changed - rebuild gui only
    MainSource,    // main source changed - rebuild main
    Other,         // other file - needs analysis
}

impl FileChangeType {
    pub fn from_path(path: &str) -> Self {
        let lower = path.to_lowercase();
        if lower.ends_with("shared.h") || lower.ends_with("shared.hpp") {
            FileChangeType::SharedHeader
        } else if lower.contains("core") && (lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs")) {
            FileChangeType::CoreSource
        } else if lower.contains("gui") && (lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs")) {
            FileChangeType::GuiSource
        } else if lower.ends_with(".cpp") || lower.ends_with(".c") || lower.ends_with(".rs") {
            FileChangeType::MainSource
        } else {
            FileChangeType::Other
        }
    }
}

/// Message sent from watcher to build system
#[derive(Debug, Clone)]
pub struct WatcherMessage {
    pub paths: Vec<String>,
    pub change_types: Vec<FileChangeType>,
    pub timestamp: Instant,
}

pub fn setup_watcher(path: &Path, tx: Sender<String>) -> notify::Result<RecommendedWatcher> {
    let (notify_tx, notify_rx) = std::sync::mpsc::channel();

    let mut watcher = RecommendedWatcher::new(notify_tx, Config::default())?;

    watcher.watch(path, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        // Debounce state: track pending changes per file
        let mut pending: HashMap<String, Instant> = HashMap::new();
        let mut last_emit = Instant::now();
        
        loop {
            // Use a short timeout to check for debounce expiry
            match notify_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => {
                    let now = Instant::now();
                    
                    // Filter for relevant events (modify/create)
                    use notify::EventKind;
                    let dominated = matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    );
                    
                    if !dominated {
                        continue;
                    }
                    
                    // Add/update pending files
                    for path in event.paths {
                        if let Some(path_str) = path.to_str() {
                            // Skip build artifacts and temp files
                            if path_str.contains("/target/") || 
                               path_str.contains("\\target\\") ||
                               path_str.contains("/.") ||
                               path_str.contains("\\.") ||
                               path_str.ends_with(".so") ||
                               path_str.ends_with(".dll") ||
                               path_str.ends_with(".o") ||
                               path_str.ends_with(".obj") ||
                               path_str.contains("debug_ai_generated") {
                                continue;
                            }
                            pending.insert(path_str.to_string(), now);
                        }
                    }
                }
                Ok(Err(e)) => {
                    println!("[Watcher] Error: {:?}", e);
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // Check if any pending files have passed debounce threshold
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    println!("[Watcher] Channel disconnected");
                    break;
                }
            }
            
            // Check for debounce expiry
            let now = Instant::now();
            let debounce_duration = Duration::from_millis(DEBOUNCE_MS);
            
            // Collect files that have passed debounce threshold
            let mut ready: Vec<String> = Vec::new();
            pending.retain(|path, timestamp| {
                if now.duration_since(*timestamp) >= debounce_duration {
                    ready.push(path.clone());
                    false // Remove from pending
                } else {
                    true // Keep in pending
                }
            });
            
            // Emit coalesced changes
            if !ready.is_empty() && now.duration_since(last_emit) >= debounce_duration {
                // Determine what kind of rebuild is needed
                let mut has_shared = false;
                let mut has_core = false;
                let mut has_gui = false;
                
                for path in &ready {
                    match FileChangeType::from_path(path) {
                        FileChangeType::SharedHeader => has_shared = true,
                        FileChangeType::CoreSource => has_core = true,
                        FileChangeType::GuiSource => has_gui = true,
                        _ => {}
                    }
                }
                
                // Send a summary message indicating what changed
                // Format: "changed:<scope>:<paths>"
                // scope: "both", "core", "gui", "main"
                let scope = if has_shared {
                    "both"
                } else if has_core && has_gui {
                    "both"
                } else if has_core {
                    "core"
                } else if has_gui {
                    "gui"
                } else {
                    "main"
                };
                
                let message = format!("changed:{}:{}", scope, ready.join(","));
                if let Err(e) = tx.send(message) {
                    println!("[Watcher] Failed to send: {:?}", e);
                    break;
                }
                
                last_emit = now;
            }
        }
    });

    Ok(watcher)
}
