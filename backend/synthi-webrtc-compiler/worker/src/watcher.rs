use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::Duration;

pub fn setup_watcher(path: &Path, tx: Sender<String>) -> notify::Result<RecommendedWatcher> {
    let (notify_tx, notify_rx) = std::sync::mpsc::channel();

    let mut watcher = RecommendedWatcher::new(notify_tx, Config::default())?;

    watcher.watch(path, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        for res in notify_rx {
            match res {
                Ok(event) => {
                    // Filter for modify/create events
                    // For simplicity, just send the path string
                    for path in event.paths {
                        if let Some(path_str) = path.to_str() {
                            // Convert to relative path or just send absolute
                            // We'll send absolute and let the receiver handle it
                            let _ = tx.send(path_str.to_string());
                        }
                    }
                }
                Err(e) => println!("watch error: {:?}", e),
            }
        }
    });

    Ok(watcher)
}
