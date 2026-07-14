//! Narrow, least-privilege diagnostic process inspection.
//!
//! No command line, environment, raw path, PID, handle, or process object
//! crosses this boundary. This is intentionally not a generic process API.

use std::path::Path;
use std::time::Instant;

use crate::full_access::{sanitized_process_record, SanitizedProcessRecord, MAX_PROCESS_RECORDS};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessInspectionError {
    Unsupported,
    InvalidScope,
    Unavailable,
}

pub struct ProcessInspectionAdapter;

impl ProcessInspectionAdapter {
    pub fn list_workspace_processes(
        workspace_root: &Path,
        max_records: usize,
    ) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
        if !workspace_root.is_absolute() || max_records == 0 || max_records > MAX_PROCESS_RECORDS {
            return Err(ProcessInspectionError::InvalidScope);
        }
        list_workspace_processes_platform(workspace_root, max_records)
    }

    pub fn inspect_listener_identity(
        port: u16,
        expected_identity_hash: &str,
    ) -> Result<bool, ProcessInspectionError> {
        if port == 0
            || !expected_identity_hash.starts_with("sha256:")
            || expected_identity_hash.len() != 71
        {
            return Err(ProcessInspectionError::InvalidScope);
        }
        let listener = crate::port_adapter::detect_loopback_listener(port)
            .map_err(|_| ProcessInspectionError::Unavailable)?;
        Ok(listener.process_identity_hash == expected_identity_hash)
    }
}

#[cfg(windows)]
fn list_workspace_processes_platform(
    workspace_root: &Path,
    max_records: usize,
) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
    use std::ffi::OsString;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let root = workspace_root.to_string_lossy().to_ascii_lowercase();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(ProcessInspectionError::Unavailable);
    }
    let started = Instant::now();
    let mut result = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { zeroed() };
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut current = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while current && result.len() < max_records {
        let pid = entry.th32ProcessID;
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if !process.is_null() {
            let inspected = (|| {
                let mut path = vec![0u16; 32_768];
                let mut length = path.len() as u32;
                if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) }
                    == 0
                {
                    return None;
                }
                path.truncate(length as usize);
                let full_path = OsString::from_wide(&path).to_string_lossy().into_owned();
                if !full_path
                    .to_ascii_lowercase()
                    .starts_with(&(root.clone() + "\\"))
                {
                    return None;
                }
                let name = Path::new(&full_path).file_name()?.to_str()?.to_string();
                let (mut creation, mut exit, mut kernel, mut user) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                if unsafe {
                    GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user)
                } == 0
                {
                    return None;
                }
                let created =
                    ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
                sanitized_process_record(
                    &format!("pid={pid};created={created};image={full_path}"),
                    &name,
                    "workspace_process",
                    0,
                    Vec::new(),
                    true,
                    "executable_inside_workspace",
                    started.elapsed().as_millis() as u64,
                )
                .ok()
            })();
            unsafe {
                CloseHandle(process);
            }
            if let Some(record) = inspected {
                result.push(record);
            }
        }
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        current = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Ok(result)
}

#[cfg(not(windows))]
fn list_workspace_processes_platform(
    _workspace_root: &Path,
    _max_records: usize,
) -> Result<Vec<SanitizedProcessRecord>, ProcessInspectionError> {
    Err(ProcessInspectionError::Unsupported)
}
