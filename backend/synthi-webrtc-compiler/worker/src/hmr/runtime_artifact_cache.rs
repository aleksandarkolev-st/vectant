use std::path::{Path, PathBuf};

/// Environment override for the incremental compile cache.
///
/// The cache can contain runtime-loadable artifacts, so the default resolver
/// avoids noexec mounts. An explicit override is still honored for deployments
/// that provide their own executable artifact cache path.
pub const SYNTHI_COMPILE_CACHE_DIR_ENV: &str = "SYNTHI_COMPILE_CACHE_DIR";

const CACHE_DIR_NAME: &str = "synthi_compile_cache";

pub fn incremental_compile_cache_dir() -> PathBuf {
    let configured = std::env::var(SYNTHI_COMPILE_CACHE_DIR_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(path) = configured {
        return PathBuf::from(path);
    }

    default_incremental_compile_cache_dir()
}

fn default_incremental_compile_cache_dir() -> PathBuf {
    let temp_dir = std::env::temp_dir();

    #[cfg(target_os = "linux")]
    {
        let shm_root = Path::new("/dev/shm");
        if !path_is_on_noexec_mount(shm_root) {
            return shm_root.join(CACHE_DIR_NAME);
        }
    }

    temp_dir.join(CACHE_DIR_NAME)
}

#[cfg(target_os = "linux")]
fn path_is_on_noexec_mount(path: &Path) -> bool {
    let mounts = match std::fs::read_to_string("/proc/self/mounts") {
        Ok(mounts) => mounts,
        Err(_) => return false,
    };

    mount_path_has_option(path, &mounts, "noexec").unwrap_or(false)
}

#[cfg(test)]
pub(crate) fn choose_incremental_compile_cache_dir_for_test(
    configured: Option<&str>,
    temp_dir: &Path,
    shm_mount_has_noexec: bool,
) -> PathBuf {
    if let Some(path) = configured.map(str::trim).filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }

    if !shm_mount_has_noexec {
        return Path::new("/dev/shm").join(CACHE_DIR_NAME);
    }

    temp_dir.join(CACHE_DIR_NAME)
}

#[cfg(target_os = "linux")]
fn mount_path_has_option(path: &Path, mounts: &str, option: &str) -> Option<bool> {
    let mut best_component_count = 0usize;
    let mut best_has_option = None;

    for line in mounts.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 {
            continue;
        }

        let mount_point = PathBuf::from(decode_proc_mount_field(fields[1]));
        if !path.starts_with(&mount_point) {
            continue;
        }

        let component_count = mount_point.components().count();
        if component_count >= best_component_count {
            best_component_count = component_count;
            best_has_option = Some(fields[3].split(',').any(|candidate| candidate == option));
        }
    }

    best_has_option
}

#[cfg(target_os = "linux")]
fn decode_proc_mount_field(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut decoded = String::with_capacity(field.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let octal = &field[index + 1..index + 4];
            if let Ok(value) = u8::from_str_radix(octal, 8) {
                decoded.push(value as char);
                index += 4;
                continue;
            }
        }

        decoded.push(bytes[index] as char);
        index += 1;
    }

    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_cache_dir_wins() {
        let chosen = choose_incremental_compile_cache_dir_for_test(
            Some("/mnt/cache/runtime-artifacts"),
            Path::new("/tmp"),
            true,
        );

        assert_eq!(chosen, PathBuf::from("/mnt/cache/runtime-artifacts"));
    }

    #[test]
    fn linux_default_uses_shm_when_mount_allows_exec() {
        let chosen = choose_incremental_compile_cache_dir_for_test(None, Path::new("/tmp"), false);

        assert_eq!(chosen, PathBuf::from("/dev/shm/synthi_compile_cache"));
    }

    #[test]
    fn linux_default_uses_temp_dir_when_shm_is_noexec() {
        let chosen = choose_incremental_compile_cache_dir_for_test(None, Path::new("/tmp"), true);

        assert_eq!(chosen, PathBuf::from("/tmp/synthi_compile_cache"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn mount_option_uses_deepest_matching_mount() {
        let mounts = "\
rootfs / rootfs rw 0 0
tmpfs /tmp tmpfs rw,nosuid,nodev 0 0
tmpfs /tmp/noexec tmpfs rw,nosuid,nodev,noexec 0 0
";

        assert_eq!(
            mount_path_has_option(Path::new("/tmp/noexec/cache"), mounts, "noexec"),
            Some(true)
        );
        assert_eq!(
            mount_path_has_option(Path::new("/tmp/cache"), mounts, "noexec"),
            Some(false)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_mount_escape_decoding_handles_spaces() {
        assert_eq!(
            decode_proc_mount_field("/tmp/cache\\040with\\040space"),
            "/tmp/cache with space"
        );
    }
}
