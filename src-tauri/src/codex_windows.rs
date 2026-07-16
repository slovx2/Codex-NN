use std::{
    os::windows::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
    process::Command,
};

use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::ERROR_INSUFFICIENT_BUFFER,
        NetworkManagement::IpHelper::{
            GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        },
        Networking::WinSock::AF_INET,
        Storage::Packaging::Appx::{
            FindPackagesByPackageFamily, GetPackagePathByFullName, PACKAGE_FILTER_HEAD,
        },
    },
};

use super::{spawn, CodexInstallation};

const PACKAGE_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";

pub fn discover() -> Result<CodexInstallation, String> {
    let mut packages = package_full_names()?;
    packages.sort();
    let full_name = packages
        .pop()
        .ok_or_else(|| "未安装官方 Microsoft Store Codex".to_string())?;
    let root = package_path(&full_name)?;
    let executable = manifest_executable(&root)?;
    Ok(CodexInstallation {
        app_path: root,
        executable,
        version: full_name.split('_').nth(1).unwrap_or("unknown").into(),
        identity: PACKAGE_FAMILY.into(),
    })
}

fn package_full_names() -> Result<Vec<String>, String> {
    let family = wide(PACKAGE_FAMILY);
    let mut count = 0_u32;
    let mut buffer_length = 0_u32;
    let first = unsafe {
        FindPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            PACKAGE_FILTER_HEAD,
            &mut count,
            None,
            &mut buffer_length,
            None,
            None,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER || count == 0 || buffer_length == 0 {
        return Ok(Vec::new());
    }
    let mut pointers = vec![PWSTR(std::ptr::null_mut()); count as usize];
    let mut buffer = vec![0_u16; buffer_length as usize];
    let result = unsafe {
        FindPackagesByPackageFamily(
            PCWSTR(family.as_ptr()),
            PACKAGE_FILTER_HEAD,
            &mut count,
            Some(pointers.as_mut_ptr()),
            &mut buffer_length,
            Some(PWSTR(buffer.as_mut_ptr())),
            None,
        )
    };
    if result.0 != 0 {
        return Err(format!("无法查找 Codex Store 包：Win32 {}", result.0));
    }
    pointers.truncate(count as usize);
    pointers
        .into_iter()
        .map(|pointer| unsafe { PCWSTR(pointer.0).to_string() }.map_err(|error| error.to_string()))
        .collect()
}

fn package_path(full_name: &str) -> Result<PathBuf, String> {
    let name = wide(full_name);
    let mut length = 0_u32;
    let first = unsafe { GetPackagePathByFullName(PCWSTR(name.as_ptr()), &mut length, None) };
    if first != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(format!("无法读取 Codex Store 安装路径：Win32 {}", first.0));
    }
    let mut buffer = vec![0_u16; length as usize];
    let result = unsafe {
        GetPackagePathByFullName(
            PCWSTR(name.as_ptr()),
            &mut length,
            Some(PWSTR(buffer.as_mut_ptr())),
        )
    };
    if result.0 != 0 {
        return Err(format!("无法读取 Codex Store 安装路径：Win32 {}", result.0));
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..end])))
}

fn manifest_executable(root: &Path) -> Result<PathBuf, String> {
    let manifest_path = root.join("AppxManifest.xml");
    let xml = std::fs::read_to_string(&manifest_path)
        .map_err(|error| format!("无法读取 AppxManifest.xml：{error}"))?;
    let document = roxmltree::Document::parse(&xml)
        .map_err(|error| format!("AppxManifest.xml 格式错误：{error}"))?;
    let relative = document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "Application")
        .and_then(|node| node.attribute("Executable"))
        .ok_or_else(|| "AppxManifest.xml 缺少 Application Executable".to_string())?;
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Codex Store 清单包含不安全的可执行路径".into());
    }
    let executable = root.join(relative);
    if !executable.is_file() {
        return Err(format!(
            "Codex Store 主程序不存在：{}",
            executable.display()
        ));
    }
    Ok(executable)
}

pub fn launch(installation: &CodexInstallation, port: Option<u16>) -> Result<(), String> {
    let mut command = Command::new(&installation.executable);
    if let Some(port) = port {
        command.args([
            "--remote-debugging-address=127.0.0.1",
            &format!("--remote-debugging-port={port}"),
        ]);
    }
    spawn(command)
}

pub fn request_quit(captured: &[u32]) -> Result<(), String> {
    for pid in captured {
        let _ = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .status();
    }
    Ok(())
}

pub fn force_stop(captured: &[u32]) -> Result<(), String> {
    for pid in captured {
        let _ = hidden_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    Ok(())
}

pub fn listener_pids(port: u16) -> Result<Vec<u32>, String> {
    let mut size = 0_u32;
    let first = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER.0 || size == 0 {
        return Err(format!("无法读取 TCP 监听表：Win32 {first}"));
    }
    let mut buffer = vec![0_u8; size as usize];
    let result = unsafe {
        GetExtendedTcpTable(
            Some(buffer.as_mut_ptr().cast()),
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if result != 0 {
        return Err(format!("无法读取 TCP 监听表：Win32 {result}"));
    }
    let table = unsafe { &*(buffer.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>()) };
    let rows =
        unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
    Ok(rows
        .iter()
        .filter(|row| u16::from_be(row.dwLocalPort as u16) == port)
        .map(|row| row.dwOwningPid)
        .collect())
}

fn hidden_command(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(program);
    command.creation_flags(0x08000000);
    command
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::manifest_executable;

    #[test]
    fn appx_manifest_rejects_parent_paths() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("AppxManifest.xml"),
            r#"<Package><Applications><Application Executable="..\evil.exe" /></Applications></Package>"#,
        ).unwrap();
        assert!(manifest_executable(root.path()).is_err());
    }
}
