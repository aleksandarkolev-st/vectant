use std::path::Path;

#[derive(Debug, Clone)]
pub struct KvmStatus {
    pub exists: bool,
    pub accessible: bool,
    pub reason: String,
}

/// Best-effort KVM detection for Linux workers.
///
/// We consider KVM "available" only if `/dev/kvm` exists and is openable by the
/// current user (permission check). This avoids enabling `-accel on` and then
/// failing late with opaque emulator errors.
#[cfg(target_os = "linux")]
pub fn detect_kvm() -> KvmStatus {
    let p = Path::new("/dev/kvm");
    if !p.exists() {
        return KvmStatus {
            exists: false,
            accessible: false,
            reason: "/dev/kvm missing".to_string(),
        };
    }

    match std::fs::OpenOptions::new().read(true).write(true).open(p) {
        Ok(_f) => KvmStatus {
            exists: true,
            accessible: true,
            reason: "/dev/kvm accessible".to_string(),
        },
        Err(e) => KvmStatus {
            exists: true,
            accessible: false,
            reason: format!("/dev/kvm not accessible: {}", e),
        },
    }
}

/// Non-Linux platforms do not use `/dev/kvm`.
#[cfg(not(target_os = "linux"))]
pub fn detect_kvm() -> KvmStatus {
    KvmStatus {
        exists: false,
        accessible: false,
        reason: "KVM probe not applicable on this OS".to_string(),
    }
}
