use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::paths::atomic_write;

const PLUGIN_MARKER: &str = "codex-nn-claude-theme-designer";
const PLUGIN_NAME: &str = "codex-nn-theme-designer";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

include!(concat!(
    env!("OUT_DIR"),
    "/claude_theme_designer_plugin_assets.rs"
));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeThemeDesignerPluginStatus {
    pub installed: bool,
    pub managed: bool,
    pub conflict: bool,
    pub version: String,
    pub message: Option<String>,
    pub claude_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeManagedState {
    marker: String,
    plugin_version: String,
    plugin_root: String,
    files: BTreeMap<String, String>,
    updated_at: String,
}

struct PluginPaths {
    app_data_root: PathBuf,
    plugin_root: PathBuf,
    managed_state_path: PathBuf,
}

impl PluginPaths {
    fn resolve(app: &AppHandle) -> Result<Self, String> {
        let claude_config = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
            .ok_or_else(|| "无法定位 Claude Code 配置目录".to_string())?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        Ok(Self::from_roots(claude_config, app_data))
    }

    fn from_roots(claude_config: PathBuf, app_data: PathBuf) -> Self {
        Self {
            app_data_root: app_data.clone(),
            plugin_root: claude_config.join("skills").join(PLUGIN_NAME),
            managed_state_path: app_data
                .join("claude")
                .join("theme-designer-plugin-state.json"),
        }
    }
}

pub fn inspect(app: &AppHandle) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    inspect_paths(&PluginPaths::resolve(app)?)
}

pub fn install(app: &AppHandle) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    install_paths(&PluginPaths::resolve(app)?)
}

pub fn uninstall(app: &AppHandle) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    uninstall_paths(&PluginPaths::resolve(app)?)
}

pub fn update_if_version_changed(app: &AppHandle) -> Result<(), String> {
    update_paths_if_version_changed(&PluginPaths::resolve(app)?)
}

fn inspect_paths(paths: &PluginPaths) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    let state = read_managed_state(&paths.managed_state_path)?;
    let (installed, managed, conflict, message) = match state {
        Some(state) if state.marker == PLUGIN_MARKER => {
            if !state_targets_current_root(&state, paths)? {
                return Ok(ClaudeThemeDesignerPluginStatus {
                    installed: false,
                    managed: true,
                    conflict: true,
                    version: PLUGIN_VERSION.to_string(),
                    message: Some(
                        "Claude Code 配置目录已变化；未移动或覆盖主题设计插件。请恢复安装时的 CLAUDE_CONFIG_DIR 后再管理插件。"
                            .into(),
                    ),
                    claude_available: claude_available(),
                });
            }
            let bundle_exists = paths.plugin_root.exists();
            let files_match =
                bundle_exists && bundle_matches_state(&paths.plugin_root, &state.files);
            let files_conflict = bundle_exists && !files_match;
            let current = files_match
                && state.plugin_version == PLUGIN_VERSION
                && desired_bundle_hashes(paths).is_ok_and(|hashes| hashes == state.files);
            let message = if files_conflict {
                Some("Claude Code 中的主题设计插件已被手动修改，未自动覆盖。".into())
            } else if !bundle_exists {
                Some("Claude Code 主题设计插件目录缺失，可重新安装。".into())
            } else if !current {
                Some("Claude Code 主题设计插件可安全更新。".into())
            } else {
                None
            };
            (current, true, files_conflict, message)
        }
        Some(_) => (
            false,
            false,
            true,
            Some("检测到无法识别的 Claude Code 插件托管状态，请先手动处理。".into()),
        ),
        None if paths.plugin_root.exists() => (
            false,
            false,
            true,
            Some("Claude Code 中已存在同名主题设计插件，未自动覆盖。".into()),
        ),
        None => (
            false,
            false,
            false,
            Some("安装后将沿用 Claude Code 现有账号、模型和接口配置。".into()),
        ),
    };

    Ok(ClaudeThemeDesignerPluginStatus {
        installed,
        managed,
        conflict,
        version: PLUGIN_VERSION.to_string(),
        message,
        claude_available: claude_available(),
    })
}

fn install_paths(paths: &PluginPaths) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    match read_managed_state(&paths.managed_state_path)? {
        Some(state) if state.marker == PLUGIN_MARKER => {
            if !state_targets_current_root(&state, paths)? {
                return Err(
                    "Claude Code 配置目录已变化，未安装到新目录。请恢复安装时的 CLAUDE_CONFIG_DIR 后再管理插件。"
                        .into(),
                );
            }
            if paths.plugin_root.exists() && !bundle_matches_state(&paths.plugin_root, &state.files)
            {
                return Err("Claude Code 主题设计插件已被手动修改，请先移除冲突。".into());
            }
        }
        Some(_) => return Err("检测到无法识别的 Claude Code 插件托管状态。".into()),
        None if paths.plugin_root.exists() => {
            return Err("Claude Code 中已存在同名主题设计插件，未自动覆盖。".into());
        }
        None => {}
    }

    let plugin_root = managed_plugin_root(&paths.plugin_root)?;
    let state = ClaudeManagedState {
        marker: PLUGIN_MARKER.into(),
        plugin_version: PLUGIN_VERSION.into(),
        plugin_root,
        files: replace_plugin_bundle(paths)?,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_json(&paths.managed_state_path, &state)?;
    inspect_paths(paths)
}

fn uninstall_paths(paths: &PluginPaths) -> Result<ClaudeThemeDesignerPluginStatus, String> {
    let Some(state) = read_managed_state(&paths.managed_state_path)? else {
        return inspect_paths(paths);
    };
    if state.marker != PLUGIN_MARKER {
        return inspect_paths(paths);
    }
    if !state_targets_current_root(&state, paths)? {
        return inspect_paths(paths);
    }
    if paths.plugin_root.exists() && !bundle_matches_state(&paths.plugin_root, &state.files) {
        return inspect_paths(paths);
    }

    remove_dir_if_exists(&paths.plugin_root)?;
    remove_file_if_exists(&paths.managed_state_path)?;
    inspect_paths(paths)
}

fn update_paths_if_version_changed(paths: &PluginPaths) -> Result<(), String> {
    let Some(mut state) = read_managed_state(&paths.managed_state_path)? else {
        return Ok(());
    };
    if state.marker != PLUGIN_MARKER
        || !state_targets_current_root(&state, paths)?
        || (paths.plugin_root.exists() && !bundle_matches_state(&paths.plugin_root, &state.files))
    {
        return Ok(());
    }
    let expected = desired_bundle_hashes(paths)?;
    if paths.plugin_root.exists()
        && state.plugin_version == PLUGIN_VERSION
        && state.files == expected
    {
        return Ok(());
    }

    state.files = replace_plugin_bundle(paths)?;
    state.plugin_version = PLUGIN_VERSION.into();
    state.updated_at = Utc::now().to_rfc3339();
    write_json(&paths.managed_state_path, &state)
}

fn state_targets_current_root(
    state: &ClaudeManagedState,
    paths: &PluginPaths,
) -> Result<bool, String> {
    Ok(state.plugin_root == managed_plugin_root(&paths.plugin_root)?)
}

fn managed_plugin_root(path: &Path) -> Result<String, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("无法定位当前目录：{error}"))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let identity = normalized.to_string_lossy().into_owned();
    #[cfg(windows)]
    let identity = identity.replace('/', "\\").to_lowercase();
    Ok(identity)
}

fn replace_plugin_bundle(paths: &PluginPaths) -> Result<BTreeMap<String, String>, String> {
    let files = desired_bundle_files(paths)?;
    let parent = paths
        .plugin_root
        .parent()
        .ok_or_else(|| "Claude Code 插件路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 Claude Code skills 目录：{error}"))?;
    let temporary = parent.join(format!(".{PLUGIN_NAME}.{}.tmp", std::process::id()));
    let backup = parent.join(format!(".{PLUGIN_NAME}.{}.backup", std::process::id()));
    remove_dir_if_exists(&temporary)?;
    remove_dir_if_exists(&backup)?;
    for (relative, content) in &files {
        atomic_write(&temporary.join(relative), content)?;
    }

    let had_existing = paths.plugin_root.exists();
    if had_existing {
        fs::rename(&paths.plugin_root, &backup)
            .map_err(|error| format!("无法暂存旧 Claude Code 主题设计插件：{error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &paths.plugin_root) {
        if had_existing {
            let _ = fs::rename(&backup, &paths.plugin_root);
        }
        let _ = remove_dir_if_exists(&temporary);
        return Err(format!("无法安装 Claude Code 主题设计插件：{error}"));
    }
    remove_dir_if_exists(&backup)?;
    Ok(files
        .into_iter()
        .map(|(path, content)| (path, sha256(&content)))
        .collect())
}

fn desired_bundle_hashes(paths: &PluginPaths) -> Result<BTreeMap<String, String>, String> {
    Ok(desired_bundle_files(paths)?
        .into_iter()
        .map(|(path, content)| (path, sha256(&content)))
        .collect())
}

fn desired_bundle_files(paths: &PluginPaths) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    for (relative, content) in CLAUDE_THEME_DESIGNER_PLUGIN_ASSETS {
        if *relative == ".mcp.json" {
            continue;
        }
        let (target, content) = if *relative == ".mcp.json.template" {
            (".mcp.json", plugin_mcp_json(paths)?.into_bytes())
        } else {
            (*relative, content.to_vec())
        };
        validate_relative_path(target)?;
        if files.insert(target.to_string(), content).is_some() {
            return Err(format!("内置 Claude Code 插件资源重复：{target}"));
        }
    }
    if !files.contains_key(".mcp.json") {
        return Err("内置 Claude Code 插件缺少 .mcp.json.template。".into());
    }
    Ok(files)
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("内置 Claude Code 插件包含无效路径。".into());
    }
    Ok(())
}

fn plugin_mcp_json(paths: &PluginPaths) -> Result<String, String> {
    let command = std::env::current_exe()
        .map_err(|error| format!("无法定位 Codex NN 可执行文件：{error}"))?;
    let command_json =
        serde_json::to_string(&command.display().to_string()).map_err(|error| error.to_string())?;
    let app_data_json = serde_json::to_string(&paths.app_data_root.display().to_string())
        .map_err(|error| error.to_string())?;
    let template = std::str::from_utf8(plugin_asset(".mcp.json.template")?)
        .map_err(|error| format!("MCP 配置模板不是 UTF-8：{error}"))?;
    Ok(template
        .replace("{{CODEX_NN_COMMAND_JSON}}", &command_json)
        .replace("{{CODEX_NN_APP_DATA_DIR_JSON}}", &app_data_json))
}

fn plugin_asset(path: &str) -> Result<&'static [u8], String> {
    CLAUDE_THEME_DESIGNER_PLUGIN_ASSETS
        .iter()
        .find(|(relative, _)| *relative == path)
        .map(|(_, content)| *content)
        .ok_or_else(|| format!("缺少内置 Claude Code 插件资源：{path}"))
}

fn bundle_matches_state(root: &Path, expected: &BTreeMap<String, String>) -> bool {
    collect_bundle_hashes(root).is_ok_and(|actual| actual == *expected)
}

fn collect_bundle_hashes(root: &Path) -> Result<BTreeMap<String, String>, String> {
    if !root.is_dir() {
        return Err("Claude Code 插件目录不存在。".into());
    }
    let mut files = BTreeMap::new();
    collect_bundle_hashes_into(root, root, &mut files)?;
    Ok(files)
}

fn collect_bundle_hashes_into(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查 Claude Code 插件：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Claude Code 插件中不允许符号链接。".into());
    }
    if metadata.is_file() {
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let content =
            fs::read(path).map_err(|error| format!("无法读取 Claude Code 插件：{error}"))?;
        files.insert(relative, sha256(&content));
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("Claude Code 插件中包含不支持的文件类型。".into());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("无法读取 Claude Code 插件目录：{error}"))?
        .map(|entry| entry.map(|item| item.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法读取 Claude Code 插件目录：{error}"))?;
    entries.sort();
    for entry in entries {
        collect_bundle_hashes_into(root, &entry, files)?;
    }
    Ok(())
}

fn read_managed_state(path: &Path) -> Result<Option<ClaudeManagedState>, String> {
    match fs::read(path) {
        Ok(content) => serde_json::from_slice(&content)
            .map(Some)
            .map_err(|error| format!("Claude Code 插件托管状态损坏：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 Claude Code 插件托管状态：{error}")),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut content = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    content.push(b'\n');
    atomic_write(path, &content)
}

fn sha256(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn command_available(command: &str) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return command_path.is_file();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    let candidates = executable_names(command);
    std::env::split_paths(&path)
        .any(|directory| candidates.iter().any(|name| directory.join(name).is_file()))
}

fn claude_available() -> bool {
    if let Some(configured) = std::env::var_os("CLAUDE_CODE_PATH").filter(|value| !value.is_empty())
    {
        let configured = PathBuf::from(configured);
        if configured.is_file() || configured.to_str().is_some_and(command_available) {
            return true;
        }
    }
    if command_available("claude") {
        return true;
    }

    let mut candidates = vec![
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    if let Some(home) = dirs::home_dir() {
        for name in executable_names("claude") {
            candidates.push(home.join(".local").join("bin").join(&name));
            candidates.push(home.join(".claude").join("local").join(&name));
        }
    }
    candidates.into_iter().any(|path| path.is_file())
}

fn executable_names(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(command).extension().is_some() {
            return vec![command.to_string()];
        }
        let extensions = std::env::var_os("PATHEXT")
            .unwrap_or_else(|| std::ffi::OsString::from(".COM;.EXE;.BAT;.CMD"));
        std::iter::once(command.to_string())
            .chain(
                extensions
                    .to_string_lossy()
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(|extension| format!("{command}{extension}")),
            )
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![command.to_string()]
    }
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除 {}：{error}", path.display())),
    }
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法删除 {}：{error}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths() -> (tempfile::TempDir, PluginPaths) {
        let root = tempfile::tempdir().unwrap();
        let paths = PluginPaths::from_roots(
            root.path().join("claude-config"),
            root.path().join("app-data"),
        );
        (root, paths)
    }

    #[test]
    fn installs_and_uninstalls_the_complete_plugin_bundle() {
        let (_root, paths) = test_paths();

        let installed = install_paths(&paths).unwrap();

        assert!(installed.installed);
        assert!(installed.managed);
        assert!(!installed.conflict);
        assert!(paths
            .plugin_root
            .join(".claude-plugin/plugin.json")
            .is_file());
        assert!(paths
            .plugin_root
            .join("skills/design-codex-nn-theme/SKILL.md")
            .is_file());
        let mcp: serde_json::Value =
            serde_json::from_slice(&fs::read(paths.plugin_root.join(".mcp.json")).unwrap())
                .unwrap();
        assert_eq!(
            mcp["mcpServers"]["codex-nn"]["args"],
            serde_json::json!(["mcp"])
        );
        assert_eq!(
            mcp["mcpServers"]["codex-nn"]["env"]["CODEX_NN_APP_DATA_DIR"],
            paths.app_data_root.display().to_string()
        );

        let removed = uninstall_paths(&paths).unwrap();
        assert!(!removed.installed);
        assert!(!removed.managed);
        assert!(!removed.conflict);
        assert!(!paths.plugin_root.exists());
        assert!(!paths.managed_state_path.exists());
    }

    #[test]
    fn detects_manual_plugin_changes_and_does_not_overwrite_them() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        fs::write(paths.plugin_root.join("user-note.txt"), "keep me").unwrap();

        let status = inspect_paths(&paths).unwrap();
        assert!(status.conflict);
        assert!(!status.installed);
        assert!(install_paths(&paths).is_err());
        update_paths_if_version_changed(&paths).unwrap();
        assert_eq!(
            fs::read_to_string(paths.plugin_root.join("user-note.txt")).unwrap(),
            "keep me"
        );
        let uninstall_status = uninstall_paths(&paths).unwrap();
        assert!(uninstall_status.conflict);
        assert!(paths.plugin_root.exists());
    }

    #[test]
    fn rejects_an_unmanaged_name_collision() {
        let (_root, paths) = test_paths();
        fs::create_dir_all(&paths.plugin_root).unwrap();
        fs::write(paths.plugin_root.join("SKILL.md"), "user plugin").unwrap();

        let error = install_paths(&paths).unwrap_err();

        assert!(error.contains("同名"));
        assert_eq!(
            fs::read_to_string(paths.plugin_root.join("SKILL.md")).unwrap(),
            "user plugin"
        );
    }

    #[test]
    fn safely_refreshes_an_unchanged_managed_bundle() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        let mut state = read_managed_state(&paths.managed_state_path)
            .unwrap()
            .unwrap();
        state.plugin_version = "0.0.1".into();
        write_json(&paths.managed_state_path, &state).unwrap();

        update_paths_if_version_changed(&paths).unwrap();

        let updated = read_managed_state(&paths.managed_state_path)
            .unwrap()
            .unwrap();
        assert_eq!(updated.plugin_version, PLUGIN_VERSION);
        assert!(bundle_matches_state(&paths.plugin_root, &updated.files));
    }

    #[test]
    fn a_missing_managed_bundle_can_be_restored_reinstalled_or_uninstalled() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        remove_dir_if_exists(&paths.plugin_root).unwrap();

        let missing = inspect_paths(&paths).unwrap();
        assert!(missing.managed);
        assert!(!missing.installed);
        assert!(!missing.conflict);

        update_paths_if_version_changed(&paths).unwrap();
        assert!(inspect_paths(&paths).unwrap().installed);

        remove_dir_if_exists(&paths.plugin_root).unwrap();
        assert!(install_paths(&paths).unwrap().installed);

        remove_dir_if_exists(&paths.plugin_root).unwrap();
        let removed = uninstall_paths(&paths).unwrap();
        assert!(!removed.managed);
        assert!(!removed.conflict);
        assert!(!paths.managed_state_path.exists());
    }

    #[test]
    fn changing_claude_config_dir_never_moves_or_duplicates_a_managed_plugin() {
        let (root, original) = test_paths();
        install_paths(&original).unwrap();
        let changed = PluginPaths::from_roots(
            root.path().join("another-claude-config"),
            original.app_data_root.clone(),
        );

        let status = inspect_paths(&changed).unwrap();
        assert!(status.managed);
        assert!(status.conflict);
        assert!(!status.installed);
        assert!(!changed.plugin_root.exists());

        update_paths_if_version_changed(&changed).unwrap();
        assert!(!changed.plugin_root.exists());
        assert!(install_paths(&changed).is_err());
        let uninstall_status = uninstall_paths(&changed).unwrap();
        assert!(uninstall_status.conflict);
        assert!(original.plugin_root.exists());
        assert!(original.managed_state_path.exists());

        let removed = uninstall_paths(&original).unwrap();
        assert!(!removed.managed);
        assert!(!original.plugin_root.exists());
    }

    #[test]
    fn managed_state_contains_only_plugin_metadata() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();

        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(&paths.managed_state_path).unwrap()).unwrap();
        let mut keys = state
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "files",
                "marker",
                "pluginRoot",
                "pluginVersion",
                "updatedAt"
            ]
        );
    }
}
