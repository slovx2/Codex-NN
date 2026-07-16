use std::{path::PathBuf, process::Command, time::Duration};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::models::CodexStatus;

#[cfg(target_os = "macos")]
#[path = "codex_macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "codex_windows.rs"]
mod platform;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallation {
    pub app_path: PathBuf,
    pub executable: PathBuf,
    pub version: String,
    pub identity: String,
}

pub fn discover() -> Result<CodexInstallation, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::discover()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("Codex NN 目前只支持 macOS 和 Windows".into())
}

pub fn status() -> CodexStatus {
    match discover() {
        Ok(installation) => CodexStatus {
            installed: true,
            running: is_running(&installation),
            version: Some(installation.version),
            path: Some(installation.app_path.to_string_lossy().into_owned()),
            message: None,
        },
        Err(message) => CodexStatus {
            installed: false,
            running: false,
            version: None,
            path: None,
            message: Some(message),
        },
    }
}

pub fn is_running(installation: &CodexInstallation) -> bool {
    !main_pids(installation).is_empty()
}

pub fn main_pids(installation: &CodexInstallation) -> Vec<u32> {
    let expected = normalize_path(&installation.executable);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    system
        .processes()
        .iter()
        .filter(|(_, process)| {
            process
                .exe()
                .is_some_and(|path| normalize_path(path) == expected)
        })
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

pub async fn stop(installation: &CodexInstallation, allow_force: bool) -> Result<(), String> {
    let captured = main_pids(installation);
    if captured.is_empty() {
        return Ok(());
    }
    platform::request_quit(&captured)?;
    if wait_stopped(installation, Duration::from_secs(15)).await {
        return Ok(());
    }
    if !allow_force {
        return Err("Codex 未能在 15 秒内退出，需要明确允许强制重启".into());
    }
    platform::force_stop(&captured)?;
    if wait_stopped(installation, Duration::from_secs(5)).await {
        Ok(())
    } else {
        Err("Codex 未能安全退出，请手动关闭后重试".into())
    }
}

pub fn launch(installation: &CodexInstallation, port: Option<u16>) -> Result<(), String> {
    platform::launch(installation, port)
}

pub fn listener_belongs_to_codex(port: u16, installation: &CodexInstallation) -> bool {
    let listeners = match platform::listener_pids(port) {
        Ok(pids) if !pids.is_empty() => pids,
        _ => return false,
    };
    let roots = main_pids(installation);
    if roots.is_empty() {
        return false;
    }
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    listeners
        .into_iter()
        .all(|pid| roots.contains(&pid) || is_descendant(pid, &roots, &system))
}

pub fn select_available_port(preferred: u16) -> Result<u16, String> {
    let end = preferred.saturating_add(100);
    for port in preferred..=end {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(format!("端口 {preferred} 到 {end} 都已被占用"))
}

pub fn default_port() -> u16 {
    if cfg!(target_os = "windows") {
        9335
    } else {
        9341
    }
}

fn normalize_path(path: &std::path::Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn is_descendant(pid: u32, roots: &[u32], system: &System) -> bool {
    let mut current = Pid::from_u32(pid);
    for _ in 0..32 {
        let Some(process) = system.process(current) else {
            return false;
        };
        let Some(parent) = process.parent() else {
            return false;
        };
        if roots.contains(&parent.as_u32()) {
            return true;
        }
        if parent == current {
            return false;
        }
        current = parent;
    }
    false
}

async fn wait_stopped(installation: &CodexInstallation, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if !is_running(installation) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    !is_running(installation)
}

pub(crate) fn spawn(mut command: Command) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动 Codex：{error}"))
}

#[cfg(test)]
mod tests {
    use super::select_available_port;

    #[test]
    fn selects_a_free_loopback_port() {
        let occupied = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        if port < u16::MAX {
            assert_ne!(select_available_port(port).unwrap(), port);
        }
    }
}
