use serde::Serialize;
#[cfg(windows)]
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize)]
pub struct DetectedLoopbackPort {
    pub port: u16,
    pub service: String,
    pub process_identity_hash: String,
    #[serde(skip)]
    pub process_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortDetectionError {
    InvalidPort,
    NotLoopbackListener,
    ProcessUnavailable,
    Unsupported,
}

#[cfg(windows)]
pub fn detect_loopback_listener(port: u16) -> Result<DetectedLoopbackPort, PortDetectionError> {
    use std::ffi::OsString;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, FILETIME};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if port == 0 {
        return Err(PortDetectionError::InvalidPort);
    }
    let mut table_size = 0u32;
    let first = unsafe {
        GetExtendedTcpTable(
            ptr::null_mut(),
            &mut table_size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER || table_size < size_of::<u32>() as u32 {
        return Err(PortDetectionError::ProcessUnavailable);
    }
    let mut table = vec![0u8; table_size as usize];
    let result = unsafe {
        GetExtendedTcpTable(
            table.as_mut_ptr().cast(),
            &mut table_size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 0 {
        return Err(PortDetectionError::ProcessUnavailable);
    }
    let count = unsafe { *(table.as_ptr().cast::<u32>()) } as usize;
    let rows = unsafe {
        std::slice::from_raw_parts(
            table
                .as_ptr()
                .add(size_of::<u32>())
                .cast::<MIB_TCPROW_OWNER_PID>(),
            count,
        )
    };
    let row = rows
        .iter()
        .find(|row| {
            u16::from_be(row.dwLocalPort as u16) == port
                && std::net::Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).is_loopback()
        })
        .ok_or(PortDetectionError::NotLoopbackListener)?;

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, row.dwOwningPid) };
    if process.is_null() {
        return Err(PortDetectionError::ProcessUnavailable);
    }
    let detected = (|| {
        let mut path = vec![0u16; 32_768];
        let mut path_length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut path_length) }
            == 0
        {
            return Err(PortDetectionError::ProcessUnavailable);
        }
        path.truncate(path_length as usize);
        let path = OsString::from_wide(&path).to_string_lossy().into_owned();
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err(PortDetectionError::ProcessUnavailable);
        }
        let creation_ticks =
            ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
        let process_identity = format!(
            "pid={};created={creation_ticks};path={path}",
            row.dwOwningPid
        );
        let service = std::path::Path::new(&path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("local service")
            .to_string();
        Ok(DetectedLoopbackPort {
            port,
            service,
            process_identity_hash: hash_process_identity(&process_identity),
            process_identity,
        })
    })();
    unsafe {
        CloseHandle(process);
    }
    detected
}

#[cfg(not(windows))]
pub fn detect_loopback_listener(_port: u16) -> Result<DetectedLoopbackPort, PortDetectionError> {
    Err(PortDetectionError::Unsupported)
}

#[cfg(windows)]
fn hash_process_identity(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-process:");
    hasher.update(value.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

pub fn native_listener_identity_matches(port: u16, expected_identity: &str) -> bool {
    !expected_identity.is_empty()
        && expected_identity.starts_with("pid=")
        && detect_loopback_listener(port)
            .is_ok_and(|detected| detected.process_identity == expected_identity)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn detects_the_real_owner_of_a_loopback_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let detected = detect_loopback_listener(port).unwrap();

        assert_eq!(detected.port, port);
        assert!(!detected.service.is_empty());
        assert!(detected.process_identity_hash.starts_with("sha256:"));
        assert!(!detected.process_identity.is_empty());
        assert!(!serde_json::to_string(&detected).unwrap().contains("path="));
        assert!(native_listener_identity_matches(
            port,
            &detected.process_identity
        ));
        assert!(!native_listener_identity_matches(
            port,
            "pid=1;created=0;path=fake"
        ));
    }
}
