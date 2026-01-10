#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmulatorStreamMode {
    X11,
    Grpc,
}

#[derive(Debug, Clone)]
pub struct EmulatorGrpcConfig {
    pub host: String,
    pub port: u16,
    pub use_token: bool,
    pub token_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct EmulatorStreamConfig {
    pub mode: EmulatorStreamMode,
    pub grpc: EmulatorGrpcConfig,
}

impl EmulatorStreamConfig {
    pub fn from_env() -> Self {
        crate::android::env::load_android_env_file();

        let mode = match std::env::var("SYNTHI_ANDROID_STREAM_MODE") {
            Ok(v) => match v.trim().to_lowercase().as_str() {
                "grpc" => EmulatorStreamMode::Grpc,
                "x11" => EmulatorStreamMode::X11,
                _ => EmulatorStreamMode::X11,
            },
            Err(_) => EmulatorStreamMode::X11,
        };

        let host = std::env::var("SYNTHI_ANDROID_GRPC_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        let port = std::env::var("SYNTHI_ANDROID_GRPC_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .unwrap_or(8554);

        let use_token = std::env::var("SYNTHI_ANDROID_GRPC_USE_TOKEN")
            .ok()
            .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        let token_path = std::env::var("SYNTHI_ANDROID_GRPC_TOKEN_PATH")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        Self {
            mode,
            grpc: EmulatorGrpcConfig {
                host,
                port,
                use_token,
                token_path,
            },
        }
    }
}
