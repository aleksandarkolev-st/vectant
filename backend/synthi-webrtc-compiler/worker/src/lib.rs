/// Debug log macro — only prints when SYNTHI_WORKER_VERBOSE=1 is set.
/// Use instead of `eprintln!`/`println!` for non-error debug output.
#[macro_export]
macro_rules! debug_log {
    ($($arg:tt)*) => {
        if $crate::verbose_enabled() {
            eprintln!($($arg)*);
        }
    };
}

static VERBOSE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

pub fn verbose_enabled() -> bool {
    *VERBOSE.get_or_init(|| std::env::var("SYNTHI_WORKER_VERBOSE").unwrap_or_default() == "1")
}

pub mod android;
pub mod compiler;
pub mod hmr;
pub mod infra;
pub mod runtime;
pub mod safety;
pub mod webrtc;
