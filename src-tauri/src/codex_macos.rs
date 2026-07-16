use std::{
    path::{Path, PathBuf},
    process::Command,
};

use plist::Value;

use super::{spawn, CodexInstallation};

const BUNDLE_ID: &str = "com.openai.codex";
const EXPECTED_TEAM_ID: &str = "2DC432GLL2";

pub fn discover() -> Result<CodexInstallation, String> {
    let mut candidates = vec![
        PathBuf::from("/Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("Applications/ChatGPT.app"));
        candidates.push(home.join("Applications/Codex.app"));
    }
    if let Ok(output) = Command::new("/usr/bin/mdfind")
        .arg("kMDItemCFBundleIdentifier == 'com.openai.codex'")
        .output()
    {
        candidates.extend(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(PathBuf::from),
        );
    }

    let mut last_error = None;
    for candidate in candidates {
        if !candidate.join("Contents/Info.plist").is_file() {
            continue;
        }
        match inspect(&candidate) {
            Ok(installation) => return Ok(installation),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "未找到官方 Codex Desktop（com.openai.codex）".into()))
}

fn inspect(bundle: &Path) -> Result<CodexInstallation, String> {
    let info = Value::from_file(bundle.join("Contents/Info.plist"))
        .map_err(|error| format!("无法读取 Codex Info.plist：{error}"))?;
    let dictionary = info
        .as_dictionary()
        .ok_or_else(|| "Codex Info.plist 格式错误".to_string())?;
    let identifier = string_value(dictionary, "CFBundleIdentifier")?;
    if identifier != BUNDLE_ID {
        return Err(format!("拒绝非官方 Bundle ID：{identifier}"));
    }
    let executable_name = string_value(dictionary, "CFBundleExecutable")?;
    let version = string_value(dictionary, "CFBundleShortVersionString")?;
    let executable = bundle.join("Contents/MacOS").join(executable_name);
    if !executable.is_file() {
        return Err(format!("Codex 主程序不存在：{}", executable.display()));
    }
    verify_signature(bundle)?;
    Ok(CodexInstallation {
        app_path: bundle.to_path_buf(),
        executable,
        version,
        identity: BUNDLE_ID.into(),
    })
}

fn string_value(dictionary: &plist::Dictionary, key: &str) -> Result<String, String> {
    dictionary
        .get(key)
        .and_then(Value::as_string)
        .map(str::to_owned)
        .ok_or_else(|| format!("Codex Info.plist 缺少 {key}"))
}

fn verify_signature(bundle: &Path) -> Result<(), String> {
    let status = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .status()
        .map_err(|error| format!("无法校验 Codex 签名：{error}"))?;
    if !status.success() {
        return Err("Codex 代码签名无效，请重新安装官方应用".into());
    }
    let output = Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=4"])
        .arg(bundle)
        .output()
        .map_err(|error| format!("无法读取 Codex 签名：{error}"))?;
    let detail = String::from_utf8_lossy(&output.stderr);
    let team = detail
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .unwrap_or_default();
    if team != EXPECTED_TEAM_ID {
        return Err(format!(
            "Codex 签名团队不匹配：{}",
            if team.is_empty() { "缺失" } else { team }
        ));
    }
    Ok(())
}

pub fn launch(installation: &CodexInstallation, port: Option<u16>) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/open");
    command.arg("-na").arg(&installation.app_path);
    if let Some(port) = port {
        command.args([
            "--args",
            "--remote-debugging-address=127.0.0.1",
            &format!("--remote-debugging-port={port}"),
        ]);
    }
    spawn(command)
}

pub fn request_quit(_captured: &[u32]) -> Result<(), String> {
    let status = Command::new("/usr/bin/osascript")
        .args(["-e", "tell application id \"com.openai.codex\" to quit"])
        .status()
        .map_err(|error| format!("无法请求 Codex 退出：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Codex 拒绝退出请求".into())
    }
}

pub fn force_stop(captured: &[u32]) -> Result<(), String> {
    for signal in ["-TERM", "-KILL"] {
        for pid in captured {
            let _ = Command::new("/bin/kill")
                .args([signal, &pid.to_string()])
                .status();
        }
        if signal == "-TERM" {
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    }
    Ok(())
}

pub fn listener_pids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .map_err(|error| format!("无法检查 CDP 端口：{error}"))?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect())
}
