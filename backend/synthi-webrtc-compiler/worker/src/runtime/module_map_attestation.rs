use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

pub const PARENT_MODULE_MAP_ATTESTATION_SCHEMA_VERSION: &str =
    "synthi.runner.parent_module_map_attestation.v1";
pub const PARENT_MODULE_MAP_ATTESTATION_AUTHORITY: &str =
    "parent_kernel_mapping_observation_not_hmr_acceptance";
pub const LINUX_SEALED_MEMFD_MAPPING_MECHANISM: &str = "linux_sealed_memfd_procfs_v1";

#[cfg(target_os = "linux")]
const REQUIRED_MEMFD_SEALS: i32 =
    libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;

#[derive(Debug)]
pub struct ParentSealedModuleArtifact {
    file: File,
    pub content_hash: String,
    pub byte_length: u64,
    pub device: u64,
    pub inode: u64,
}

impl ParentSealedModuleArtifact {
    #[cfg(target_os = "linux")]
    pub fn peer_path(&self) -> PathBuf {
        use std::os::fd::AsRawFd;

        PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            self.file.as_raw_fd()
        ))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn peer_path(&self) -> PathBuf {
        PathBuf::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableModuleMappingV1 {
    pub start: u64,
    pub end: u64,
    pub file_offset: u64,
    pub permissions: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentModuleMapAttestationV1 {
    pub schema_version: String,
    pub proof_authority: String,
    pub attestation_id: String,
    pub observer_mechanism: String,
    pub request_id: String,
    pub module_id: String,
    pub artifact_content_hash: String,
    pub loader_epoch: u64,
    pub runner_pid: u32,
    pub runner_start_time_ticks: u64,
    pub artifact_byte_length: u64,
    pub artifact_device: u64,
    pub artifact_inode: u64,
    pub observed_seals: i32,
    pub peer_fd_numbers: Vec<i32>,
    pub executable_mappings: Vec<ExecutableModuleMappingV1>,
    pub maps_snapshot_hash: String,
    pub mapping_verified: bool,
    pub accepted_for_hmr: bool,
    pub accepted_for_gpu_hmr: bool,
    pub hmr_success: bool,
    pub gpu_hmr_success: bool,
}

impl ParentModuleMapAttestationV1 {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != PARENT_MODULE_MAP_ATTESTATION_SCHEMA_VERSION {
            return Err("parent module-map attestation schema mismatch".to_string());
        }
        if self.proof_authority != PARENT_MODULE_MAP_ATTESTATION_AUTHORITY {
            return Err("parent module-map attestation authority mismatch".to_string());
        }
        if self.observer_mechanism != LINUX_SEALED_MEMFD_MAPPING_MECHANISM {
            return Err("parent module-map observer mechanism mismatch".to_string());
        }
        if self.request_id.trim().is_empty()
            || self.module_id.trim().is_empty()
            || !canonical_sha256(&self.artifact_content_hash)
            || self.loader_epoch == 0
            || self.runner_pid == 0
            || self.runner_start_time_ticks == 0
            || self.artifact_byte_length == 0
            || self.artifact_inode == 0
            || self.peer_fd_numbers.is_empty()
            || self.executable_mappings.is_empty()
            || !canonical_sha256(&self.maps_snapshot_hash)
            || !self.mapping_verified
        {
            return Err("parent module-map attestation evidence is incomplete".to_string());
        }
        if self.accepted_for_hmr
            || self.accepted_for_gpu_hmr
            || self.hmr_success
            || self.gpu_hmr_success
        {
            return Err("parent module-map attestation cannot claim HMR authority".to_string());
        }
        #[cfg(target_os = "linux")]
        if self.observed_seals & REQUIRED_MEMFD_SEALS != REQUIRED_MEMFD_SEALS {
            return Err("parent module-map attestation seals are incomplete".to_string());
        }
        if self.attestation_id != self.expected_attestation_id()? {
            return Err("parent module-map attestation identity mismatch".to_string());
        }
        Ok(())
    }

    pub fn matches_loaded_boundary(
        &self,
        request_id: &str,
        module_id: &str,
        artifact_content_hash: &str,
        loader_epoch: u64,
        runner_pid: u32,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.module_id == module_id
            && self.artifact_content_hash == artifact_content_hash
            && self.loader_epoch == loader_epoch
            && self.runner_pid == runner_pid
    }

    fn expected_attestation_id(&self) -> Result<String, String> {
        let material = serde_json::json!([
            self.schema_version,
            self.proof_authority,
            self.observer_mechanism,
            self.request_id,
            self.module_id,
            self.artifact_content_hash,
            self.loader_epoch,
            self.runner_pid,
            self.runner_start_time_ticks,
            self.artifact_byte_length,
            self.artifact_device,
            self.artifact_inode,
            self.observed_seals,
            self.peer_fd_numbers,
            self.executable_mappings,
            self.maps_snapshot_hash,
            self.mapping_verified,
            self.accepted_for_hmr,
            self.accepted_for_gpu_hmr,
            self.hmr_success,
            self.gpu_hmr_success,
        ]);
        let bytes = serde_json::to_vec(&material)
            .map_err(|error| format!("serializing parent module-map attestation: {error}"))?;
        Ok(format!(
            "parent-module-map-attestation:sha256:{:x}",
            Sha256::digest(bytes)
        ))
    }
}

fn canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

#[cfg(target_os = "linux")]
fn hash_file(file: &File) -> io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = file.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

#[cfg(target_os = "linux")]
pub fn create_parent_sealed_module_artifact(
    source_path: &Path,
    expected_content_hash: &str,
) -> io::Result<ParentSealedModuleArtifact> {
    use std::ffi::CString;
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::fd::{FromRawFd, RawFd};
    use std::os::unix::fs::MetadataExt;

    if !canonical_sha256(expected_content_hash) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected module artifact hash is not canonical sha256",
        ));
    }
    let name = CString::new("synthi-module-object").expect("static memfd name");
    let raw_fd: RawFd =
        unsafe { libc::memfd_create(name.as_ptr(), libc::MFD_ALLOW_SEALING | libc::MFD_CLOEXEC) };
    if raw_fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = unsafe { File::from_raw_fd(raw_fd) };
    let mut source = File::open(source_path)?;
    let mut hasher = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        file.write_all(&buffer[..count])?;
        byte_length = byte_length
            .checked_add(count as u64)
            .ok_or_else(|| io::Error::other("module artifact byte length overflow"))?;
    }
    file.flush()?;
    let content_hash = format!("sha256:{:x}", hasher.finalize());
    if byte_length == 0 || content_hash != expected_content_hash {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "module artifact changed while creating its sealed object",
        ));
    }
    file.seek(SeekFrom::Start(0))?;
    if unsafe { libc::fcntl(raw_fd, libc::F_ADD_SEALS, REQUIRED_MEMFD_SEALS) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let observed_seals = unsafe { libc::fcntl(raw_fd, libc::F_GET_SEALS) };
    if observed_seals < 0 {
        return Err(io::Error::last_os_error());
    }
    if observed_seals & REQUIRED_MEMFD_SEALS != REQUIRED_MEMFD_SEALS {
        return Err(io::Error::other(
            "sealed module artifact did not retain all required seals",
        ));
    }
    if hash_file(&file)? != content_hash {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "sealed module artifact hash changed after sealing",
        ));
    }
    let metadata = file.metadata()?;
    Ok(ParentSealedModuleArtifact {
        file,
        content_hash,
        byte_length,
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(target_os = "linux"))]
pub fn create_parent_sealed_module_artifact(
    _source_path: &Path,
    _expected_content_hash: &str,
) -> io::Result<ParentSealedModuleArtifact> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no parent-observed immutable module mapping mechanism is available on this target",
    ))
}

#[cfg(target_os = "linux")]
fn process_start_time_ticks(pid: u32) -> io::Result<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let close = stat
        .rfind(')')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid process stat"))?;
    stat.get(close + 1..)
        .into_iter()
        .flat_map(str::split_whitespace)
        .nth(19)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "process start time missing"))?
        .parse::<u64>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "process start time invalid"))
}

#[cfg(target_os = "linux")]
struct StoppedProcessGuard {
    pid: u32,
}

#[cfg(target_os = "linux")]
impl Drop for StoppedProcessGuard {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.pid as i32, libc::SIGCONT);
        }
    }
}

#[cfg(target_os = "linux")]
fn stop_process(pid: u32) -> io::Result<StoppedProcessGuard> {
    if unsafe { libc::kill(pid as i32, libc::SIGSTOP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let guard = StoppedProcessGuard { pid };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
        let stopped = status
            .lines()
            .find(|line| line.starts_with("State:"))
            .is_some_and(|line| line.split_whitespace().nth(1) == Some("T"));
        if stopped {
            return Ok(guard);
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "runner did not enter a stopped state for mapping attestation",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[cfg(target_os = "linux")]
fn executable_mappings_for(
    maps: &str,
    device: u64,
    inode: u64,
) -> io::Result<Vec<ExecutableModuleMappingV1>> {
    let expected_major = libc::major(device) as u64;
    let expected_minor = libc::minor(device) as u64;
    let mut mappings = Vec::new();
    for line in maps.lines() {
        let mut fields = line.split_whitespace();
        let (Some(range), Some(permissions), Some(offset), Some(dev), Some(observed_inode)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        let (Some((major, minor)), Some((start, end))) =
            (dev.split_once(':'), range.split_once('-'))
        else {
            continue;
        };
        if !permissions.contains('x')
            || u64::from_str_radix(major, 16).ok() != Some(expected_major)
            || u64::from_str_radix(minor, 16).ok() != Some(expected_minor)
            || observed_inode.parse::<u64>().ok() != Some(inode)
        {
            continue;
        }
        mappings.push(ExecutableModuleMappingV1 {
            start: u64::from_str_radix(start, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid mapping start"))?,
            end: u64::from_str_radix(end, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid mapping end"))?,
            file_offset: u64::from_str_radix(offset, 16).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid mapping offset")
            })?,
            permissions: permissions.to_string(),
        });
    }
    Ok(mappings)
}

#[cfg(target_os = "linux")]
pub fn verify_parent_observed_module_mapping(
    runner_pid: u32,
    request_id: &str,
    module_id: &str,
    artifact_content_hash: &str,
    loader_epoch: u64,
    artifact: &ParentSealedModuleArtifact,
) -> io::Result<ParentModuleMapAttestationV1> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    if artifact.content_hash != artifact_content_hash {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "module mapping request hash does not match its sealed object",
        ));
    }
    let start_time_before = process_start_time_ticks(runner_pid)?;
    let _stopped = stop_process(runner_pid)?;
    if process_start_time_ticks(runner_pid)? != start_time_before {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runner process identity changed before mapping attestation",
        ));
    }
    let maps = std::fs::read_to_string(format!("/proc/{runner_pid}/maps"))?;
    let executable_mappings = executable_mappings_for(&maps, artifact.device, artifact.inode)?;
    if executable_mappings.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "sealed module object has no executable mapping in the runner",
        ));
    }

    let mut peer_fd_numbers = Vec::new();
    let mut observed_seals = 0;
    for entry in std::fs::read_dir(format!("/proc/{runner_pid}/fd"))? {
        let entry = entry?;
        let Some(fd_number) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        let peer_file = match File::open(entry.path()) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let metadata = peer_file.metadata()?;
        if metadata.dev() != artifact.device || metadata.ino() != artifact.inode {
            continue;
        }
        if metadata.len() != artifact.byte_length || hash_file(&peer_file)? != artifact.content_hash
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runner retained a mismatched module object",
            ));
        }
        let seals = unsafe { libc::fcntl(peer_file.as_raw_fd(), libc::F_GET_SEALS) };
        if seals < 0 {
            return Err(io::Error::last_os_error());
        }
        if seals & REQUIRED_MEMFD_SEALS != REQUIRED_MEMFD_SEALS {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runner module object is not immutably sealed",
            ));
        }
        observed_seals |= seals;
        peer_fd_numbers.push(fd_number);
    }
    if peer_fd_numbers.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "runner did not retain the sealed module object descriptor",
        ));
    }
    peer_fd_numbers.sort_unstable();

    let maps_after = std::fs::read_to_string(format!("/proc/{runner_pid}/maps"))?;
    if maps_after != maps || process_start_time_ticks(runner_pid)? != start_time_before {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runner mapping snapshot changed during attestation",
        ));
    }
    let mut attestation = ParentModuleMapAttestationV1 {
        schema_version: PARENT_MODULE_MAP_ATTESTATION_SCHEMA_VERSION.to_string(),
        proof_authority: PARENT_MODULE_MAP_ATTESTATION_AUTHORITY.to_string(),
        attestation_id: String::new(),
        observer_mechanism: LINUX_SEALED_MEMFD_MAPPING_MECHANISM.to_string(),
        request_id: request_id.to_string(),
        module_id: module_id.to_string(),
        artifact_content_hash: artifact_content_hash.to_string(),
        loader_epoch,
        runner_pid,
        runner_start_time_ticks: start_time_before,
        artifact_byte_length: artifact.byte_length,
        artifact_device: artifact.device,
        artifact_inode: artifact.inode,
        observed_seals,
        peer_fd_numbers,
        executable_mappings,
        maps_snapshot_hash: format!("sha256:{:x}", Sha256::digest(maps.as_bytes())),
        mapping_verified: true,
        accepted_for_hmr: false,
        accepted_for_gpu_hmr: false,
        hmr_success: false,
        gpu_hmr_success: false,
    };
    attestation.attestation_id = attestation
        .expected_attestation_id()
        .map_err(io::Error::other)?;
    attestation.validate().map_err(io::Error::other)?;
    Ok(attestation)
}

#[cfg(not(target_os = "linux"))]
pub fn verify_parent_observed_module_mapping(
    _runner_pid: u32,
    _request_id: &str,
    _module_id: &str,
    _artifact_content_hash: &str,
    _loader_epoch: u64,
    _artifact: &ParentSealedModuleArtifact,
) -> io::Result<ParentModuleMapAttestationV1> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no parent-observed module mapping verifier is available on this target",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{create_parent_sealed_module_artifact, hash_file, REQUIRED_MEMFD_SEALS};
    use sha2::Digest;
    use std::io::{Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;

    fn compile_c(source: &std::path::Path, output: &std::path::Path, args: &[&str]) {
        let mut command = std::process::Command::new("cc");
        command.arg(source);
        command.args(args);
        command.arg("-o").arg(output);
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "C helper compilation failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn sealed_module_object_is_content_bound_and_immutable() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("ordinary-build-output.bin");
        std::fs::write(&source, b"opaque module bytes").unwrap();
        let expected_hash = format!("sha256:{:x}", sha2::Sha256::digest(b"opaque module bytes"));
        let mut artifact = create_parent_sealed_module_artifact(&source, &expected_hash).unwrap();
        let seals = unsafe { libc::fcntl(artifact.file.as_raw_fd(), libc::F_GET_SEALS) };
        assert_eq!(seals & REQUIRED_MEMFD_SEALS, REQUIRED_MEMFD_SEALS);
        assert_eq!(hash_file(&artifact.file).unwrap(), expected_hash);
        assert!(artifact.file.seek(SeekFrom::Start(0)).is_ok());
        assert!(artifact.file.write_all(b"forged").is_err());
        assert!(artifact.file.set_len(0).is_err());
    }

    #[test]
    fn parent_attestation_rejects_unmapped_objects_and_resumes_the_process() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("ordinary-build-output.bin");
        std::fs::write(&source, b"opaque module bytes").unwrap();
        let expected_hash = format!("sha256:{:x}", sha2::Sha256::digest(b"opaque module bytes"));
        let artifact = create_parent_sealed_module_artifact(&source, &expected_hash).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();

        let result = super::verify_parent_observed_module_mapping(
            child.id(),
            &format!("runner-module-load:request:{}", "a".repeat(32)),
            "opaque module identity",
            &expected_hash,
            1,
            &artifact,
        );
        assert_eq!(unsafe { libc::kill(child.id() as i32, 0) }, 0);
        child.kill().unwrap();
        child.wait().unwrap();
        let error = result.unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn parent_attestation_observes_the_exact_sealed_executable_mapping() {
        let directory = tempfile::tempdir().unwrap();
        let module_source = directory.path().join("module.c");
        let module_path = directory.path().join("module.so");
        std::fs::write(&module_source, "int opaque_export(void) { return 42; }\n").unwrap();
        compile_c(&module_source, &module_path, &["-shared", "-fPIC"]);
        let module_bytes = std::fs::read(&module_path).unwrap();
        let expected_hash = format!("sha256:{:x}", sha2::Sha256::digest(&module_bytes));
        let artifact = create_parent_sealed_module_artifact(&module_path, &expected_hash).unwrap();

        let loader_source = directory.path().join("loader.c");
        let loader_path = directory.path().join("loader");
        let ready_path = directory.path().join("ready");
        let unloaded_path = directory.path().join("unloaded");
        std::fs::write(
            &loader_source,
            r#"
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
int main(int argc, char **argv) {
    if (argc != 4) return 10;
    int retained = open(argv[1], O_RDONLY);
    if (retained < 0) return 11;
    char path[128];
    if (snprintf(path, sizeof(path), "/proc/self/fd/%d", retained) <= 0) return 12;
    void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!library) return 13;
    FILE *ready = fopen(argv[2], "w");
    if (!ready) return 14;
    fputs("ready", ready);
    fclose(ready);
    if (getchar() == EOF) return 15;
    if (dlclose(library) != 0) return 16;
    close(retained);
    FILE *unloaded = fopen(argv[3], "w");
    if (!unloaded) return 17;
    fputs("unloaded", unloaded);
    fclose(unloaded);
    sleep(30);
    return 0;
}
"#,
        )
        .unwrap();
        compile_c(&loader_source, &loader_path, &["-ldl"]);
        let mut child = std::process::Command::new(&loader_path)
            .arg(artifact.peer_path())
            .arg(&ready_path)
            .arg(&unloaded_path)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !ready_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(ready_path.exists(), "mapping helper did not become ready");

        let request_id = format!("runner-module-load:request:{}", "b".repeat(32));
        let result = super::verify_parent_observed_module_mapping(
            child.id(),
            &request_id,
            "opaque module identity",
            &expected_hash,
            3,
            &artifact,
        );
        let child_pid = child.id();
        child.stdin.as_mut().unwrap().write_all(b"u").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !unloaded_path.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            unloaded_path.exists(),
            "mapping helper did not unload the module"
        );
        let stale_result = super::verify_parent_observed_module_mapping(
            child.id(),
            &request_id,
            "opaque module identity",
            &expected_hash,
            3,
            &artifact,
        );
        child.kill().unwrap();
        child.wait().unwrap();
        let attestation = result.unwrap();
        assert!(attestation.matches_loaded_boundary(
            &request_id,
            "opaque module identity",
            &expected_hash,
            3,
            child_pid,
        ));
        assert_eq!(attestation.artifact_inode, artifact.inode);
        assert!(!attestation.executable_mappings.is_empty());
        assert!(!attestation.accepted_for_hmr);
        assert!(!attestation.hmr_success);
        assert_eq!(
            stale_result.unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
    }
}
