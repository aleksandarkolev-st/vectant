pub mod audit;
pub mod approval;
pub mod desktop;
pub mod http;
pub mod ipc;
pub mod lifecycle;
pub mod pair;
pub mod policy;
pub mod preview;
pub mod scanner;
pub mod session;
pub mod update;
pub mod workspace;

pub const APP_PROTOCOL_VERSION: &str = "local-support-mvp.1";
pub const POLICY_VERSION: &str = "2026.07.05";
pub const SCANNER_VERSION: &str = "scanner-2026.07.05";
