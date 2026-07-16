use std::{
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use toml_edit::{DocumentMut, Item};

use crate::paths::atomic_write;

const PLUGIN_MARKER: &str = "codex-nn-theme-designer";
const MARKETPLACE_NAME: &str = "codex-nn";
const PLUGIN_NAME: &str = "codex-nn-theme-designer";
const PLUGIN_SELECTOR: &str = "codex-nn-theme-designer@codex-nn";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
include!(concat!(env!("OUT_DIR"), "/theme_designer_plugin_assets.rs"));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDesignerPluginStatus {
    pub installed: bool,
    pub managed: bool,
    pub conflict: bool,
    pub version: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManagedState {
    marker: String,
    marketplace_source: String,
    plugin_version: String,
    features_plugins_before: Option<bool>,
    updated_at: String,
}

#[derive(Debug, Default)]
struct PluginConfigSnapshot {
    marketplace_present: bool,
    marketplace_source_type: Option<String>,
    marketplace_source: Option<String>,
    marketplace_shape_matches: bool,
    plugin_present: bool,
    plugin_enabled: bool,
    plugin_shape_matches: bool,
    features_plugins_present: bool,
    features_plugins_value: Option<bool>,
    features_plugins: bool,
}

struct PluginPaths {
    config_path: PathBuf,
    marketplace_root: PathBuf,
    marketplace_manifest_path: PathBuf,
    plugin_root: PathBuf,
    plugin_cache_base_root: PathBuf,
    plugin_cache_root: PathBuf,
    managed_state_path: PathBuf,
}

impl PluginPaths {
    fn resolve(app: &AppHandle) -> Result<Self, String> {
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
            .ok_or_else(|| "无法定位 Codex 配置目录".to_string())?;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        Ok(Self::from_roots(codex_home, app_data))
    }

    fn from_roots(codex_home: PathBuf, app_data: PathBuf) -> Self {
        let marketplace_root = app_data.join("codex").join("codex-nn-marketplace");
        let plugin_root = marketplace_root.join("plugins").join(PLUGIN_NAME);
        let plugin_cache_base_root = codex_home
            .join("plugins")
            .join("cache")
            .join(MARKETPLACE_NAME)
            .join(PLUGIN_NAME);
        Self {
            config_path: codex_home.join("config.toml"),
            marketplace_manifest_path: marketplace_root
                .join(".agents")
                .join("plugins")
                .join("marketplace.json"),
            plugin_cache_root: plugin_cache_base_root.join(PLUGIN_VERSION),
            managed_state_path: app_data
                .join("codex")
                .join("theme-designer-plugin-state.json"),
            marketplace_root,
            plugin_root,
            plugin_cache_base_root,
        }
    }
}

pub fn inspect(app: &AppHandle) -> Result<ThemeDesignerPluginStatus, String> {
    inspect_paths(&PluginPaths::resolve(app)?)
}

pub fn install(app: &AppHandle) -> Result<ThemeDesignerPluginStatus, String> {
    install_paths(&PluginPaths::resolve(app)?)
}

pub fn uninstall(app: &AppHandle) -> Result<ThemeDesignerPluginStatus, String> {
    uninstall_paths(&PluginPaths::resolve(app)?)
}

pub fn update_if_version_changed(app: &AppHandle) -> Result<(), String> {
    update_paths_if_version_changed(&PluginPaths::resolve(app)?)
}

fn update_paths_if_version_changed(paths: &PluginPaths) -> Result<(), String> {
    let Some(mut state) = read_managed_state(&paths.managed_state_path)? else {
        return Ok(());
    };
    if state.marker != PLUGIN_MARKER || state.plugin_version == PLUGIN_VERSION {
        return Ok(());
    }
    let config = read_config(&paths.config_path)?;
    let snapshot = read_plugin_config(&config);
    if !config_matches_state(&snapshot, &state) {
        return Ok(());
    }
    write_plugin_files(&paths)?;
    state.plugin_version = PLUGIN_VERSION.to_string();
    state.updated_at = Utc::now().to_rfc3339();
    write_json(&paths.managed_state_path, &state)
}

fn inspect_paths(paths: &PluginPaths) -> Result<ThemeDesignerPluginStatus, String> {
    let config = read_config(&paths.config_path)?;
    let snapshot = read_plugin_config(&config);
    let state = read_managed_state(&paths.managed_state_path)?;
    let expected_source = paths.marketplace_root.display().to_string();
    let config_ready = snapshot.marketplace_source_type.as_deref() == Some("local")
        && snapshot.marketplace_source.as_deref() == Some(expected_source.as_str())
        && snapshot.plugin_enabled
        && snapshot.features_plugins;
    let bundles_ready = paths.marketplace_manifest_path.is_file()
        && plugin_bundle_complete(&paths.plugin_root)
        && plugin_bundle_complete(&paths.plugin_cache_root);

    let managed = state
        .as_ref()
        .is_some_and(|state| state.marker == PLUGIN_MARKER);
    let (installed, conflict, message) = match state {
        Some(state) if state.marker == PLUGIN_MARKER => {
            let conflict = !config_matches_state(&snapshot, &state);
            (
                !conflict && config_ready && bundles_ready,
                conflict,
                conflict.then(|| "Codex 中的主题设计插件配置已被手动修改，未自动覆盖。".into()),
            )
        }
        Some(_) => (
            false,
            true,
            Some("检测到无法识别的插件托管状态，请先手动处理。".into()),
        ),
        None if snapshot.marketplace_present
            || snapshot.plugin_present
            || (snapshot.features_plugins_present && snapshot.features_plugins_value.is_none()) =>
        {
            (
                false,
                true,
                Some("Codex 中已存在冲突的主题设计插件配置，未自动覆盖。".into()),
            )
        }
        None => (false, false, None),
    };
    Ok(ThemeDesignerPluginStatus {
        installed,
        managed,
        conflict,
        version: PLUGIN_VERSION.to_string(),
        message,
    })
}

fn install_paths(paths: &PluginPaths) -> Result<ThemeDesignerPluginStatus, String> {
    let config = read_config(&paths.config_path)?;
    let snapshot = read_plugin_config(&config);
    let state = read_managed_state(&paths.managed_state_path)?;
    let features_plugins_before = match state {
        Some(state) if state.marker == PLUGIN_MARKER => {
            if !config_matches_state(&snapshot, &state) {
                return Err("插件配置已被手动修改，请先恢复或移除冲突配置".into());
            }
            state.features_plugins_before
        }
        Some(_) => return Err("检测到无法识别的插件托管状态".into()),
        None if snapshot.marketplace_present || snapshot.plugin_present => {
            return Err("Codex 中已存在同名 marketplace 或插件配置".into());
        }
        None if snapshot.features_plugins_present && snapshot.features_plugins_value.is_none() => {
            return Err("Codex 的 features.plugins 不是布尔值，未自动覆盖".into());
        }
        None => snapshot.features_plugins_value,
    };

    write_plugin_files(paths)?;
    let source = paths.marketplace_root.display().to_string();
    let updated = write_plugin_config(&config, &source)?;
    write_text(&paths.config_path, &updated)?;
    let state = PluginManagedState {
        marker: PLUGIN_MARKER.into(),
        marketplace_source: source,
        plugin_version: PLUGIN_VERSION.into(),
        features_plugins_before,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_json(&paths.managed_state_path, &state)?;
    inspect_paths(paths)
}

fn uninstall_paths(paths: &PluginPaths) -> Result<ThemeDesignerPluginStatus, String> {
    let Some(state) = read_managed_state(&paths.managed_state_path)? else {
        return inspect_paths(paths);
    };
    if state.marker != PLUGIN_MARKER {
        return inspect_paths(paths);
    }
    let config = read_config(&paths.config_path)?;
    let snapshot = read_plugin_config(&config);
    if !config_matches_state(&snapshot, &state) {
        return inspect_paths(paths);
    }
    let updated = remove_plugin_config(&config, state.features_plugins_before)?;
    write_text(&paths.config_path, &updated)?;
    remove_dir_if_exists(&paths.marketplace_root)?;
    remove_dir_if_exists(&paths.plugin_cache_base_root)?;
    remove_file_if_exists(&paths.managed_state_path)?;
    inspect_paths(paths)
}

fn read_config(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("无法读取 Codex 配置：{error}")),
    }
}

fn read_plugin_config(config: &str) -> PluginConfigSnapshot {
    let Ok(document) = config.parse::<DocumentMut>() else {
        return PluginConfigSnapshot::default();
    };
    let marketplace = document
        .get("marketplaces")
        .and_then(|value| value.get(MARKETPLACE_NAME));
    let plugin = document
        .get("plugins")
        .and_then(|value| value.get(PLUGIN_SELECTOR));
    PluginConfigSnapshot {
        marketplace_present: marketplace.is_some(),
        marketplace_source_type: marketplace
            .and_then(|value| value.get("source_type"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        marketplace_source: marketplace
            .and_then(|value| value.get("source"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        marketplace_shape_matches: marketplace
            .is_some_and(|value| has_only_keys(value, &["source_type", "source"])),
        plugin_present: plugin.is_some(),
        plugin_enabled: plugin
            .and_then(|value| value.get("enabled"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        plugin_shape_matches: plugin.is_some_and(|value| has_only_keys(value, &["enabled"])),
        features_plugins_present: document
            .get("features")
            .and_then(|value| value.get("plugins"))
            .is_some(),
        features_plugins_value: document
            .get("features")
            .and_then(|value| value.get("plugins"))
            .and_then(|value| value.as_bool()),
        features_plugins: document
            .get("features")
            .and_then(|value| value.get("plugins"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
    }
}

fn has_only_keys(item: &Item, allowed: &[&str]) -> bool {
    if let Some(table) = item.as_table() {
        return table.iter().all(|(key, _)| allowed.contains(&key));
    }
    if let Some(table) = item.as_inline_table() {
        return table.iter().all(|(key, _)| allowed.contains(&key));
    }
    false
}

fn write_plugin_config(config: &str, source: &str) -> Result<String, String> {
    let mut document = config
        .parse::<DocumentMut>()
        .map_err(|error| format!("Codex config.toml 格式错误：{error}"))?;
    document["features"]["plugins"] = toml_edit::value(true);
    document["marketplaces"][MARKETPLACE_NAME]["source_type"] = toml_edit::value("local");
    document["marketplaces"][MARKETPLACE_NAME]["source"] = toml_edit::value(source);
    document["plugins"][PLUGIN_SELECTOR]["enabled"] = toml_edit::value(true);
    Ok(document.to_string())
}

fn remove_plugin_config(config: &str, features_before: Option<bool>) -> Result<String, String> {
    let mut document = config
        .parse::<DocumentMut>()
        .map_err(|error| format!("Codex config.toml 格式错误：{error}"))?;
    if remove_child(&mut document, "plugins", PLUGIN_SELECTOR) {
        document.remove("plugins");
    }
    if remove_child(&mut document, "marketplaces", MARKETPLACE_NAME) {
        document.remove("marketplaces");
    }
    match features_before {
        Some(value) => document["features"]["plugins"] = toml_edit::value(value),
        None if remove_child(&mut document, "features", "plugins") => {
            document.remove("features");
        }
        None => {}
    }
    Ok(document.to_string())
}

fn remove_child(document: &mut DocumentMut, parent: &str, child: &str) -> bool {
    let Some(item) = document.get_mut(parent) else {
        return false;
    };
    if let Some(table) = item.as_table_mut() {
        table.remove(child);
        return table.is_empty();
    }
    if let Some(table) = item.as_inline_table_mut() {
        table.remove(child);
        return table.is_empty();
    }
    false
}

fn config_matches_state(snapshot: &PluginConfigSnapshot, state: &PluginManagedState) -> bool {
    snapshot.marketplace_shape_matches
        && snapshot.plugin_shape_matches
        && snapshot.marketplace_source_type.as_deref() == Some("local")
        && snapshot.marketplace_source.as_deref() == Some(state.marketplace_source.as_str())
        && snapshot.plugin_enabled
        && snapshot.features_plugins
}

fn write_plugin_files(paths: &PluginPaths) -> Result<(), String> {
    remove_dir_if_exists(&paths.plugin_root)?;
    remove_dir_if_exists(&paths.plugin_cache_base_root)?;
    write_plugin_bundle(&paths.plugin_root)?;
    write_plugin_bundle(&paths.plugin_cache_root)?;
    let marketplace = plugin_asset("marketplace.json")?;
    atomic_write(&paths.marketplace_manifest_path, marketplace)?;
    Ok(())
}

fn write_plugin_bundle(root: &Path) -> Result<(), String> {
    for (relative, content) in THEME_DESIGNER_PLUGIN_ASSETS {
        if *relative == "marketplace.json" {
            continue;
        }
        atomic_write(&root.join(relative), content)?;
    }
    Ok(())
}

fn plugin_bundle_complete(root: &Path) -> bool {
    THEME_DESIGNER_PLUGIN_ASSETS
        .iter()
        .filter(|(relative, _)| *relative != "marketplace.json")
        .all(|(relative, _)| root.join(relative).is_file())
}

fn plugin_asset(path: &str) -> Result<&'static [u8], String> {
    THEME_DESIGNER_PLUGIN_ASSETS
        .iter()
        .find(|(relative, _)| *relative == path)
        .map(|(_, content)| *content)
        .ok_or_else(|| format!("缺少内置插件资源：{path}"))
}

fn read_managed_state(path: &Path) -> Result<Option<PluginManagedState>, String> {
    match fs::read(path) {
        Ok(content) => serde_json::from_slice(&content)
            .map(Some)
            .map_err(|error| format!("插件托管状态损坏：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取插件托管状态：{error}")),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_write(path, &content)
}

fn write_text(path: &Path, value: &str) -> Result<(), String> {
    atomic_write(path, value.as_bytes())
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
        let paths =
            PluginPaths::from_roots(root.path().join("codex-home"), root.path().join("app-data"));
        (root, paths)
    }

    #[test]
    fn installs_and_uninstalls_without_touching_other_config() {
        let (_root, paths) = test_paths();
        write_text(
            &paths.config_path,
            "[features]\nunified_exec = true\n\n[plugins.\"other@personal\"]\nenabled = true\n",
        )
        .unwrap();

        let installed = install_paths(&paths).unwrap();
        assert!(installed.installed);
        assert!(!installed.conflict);
        assert!(paths
            .plugin_root
            .join("skills/design-codex-nn-theme/SKILL.md")
            .is_file());
        assert!(paths
            .plugin_cache_root
            .join(".codex-plugin/plugin.json")
            .is_file());
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(paths.plugin_cache_root.join(".codex-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["version"], PLUGIN_VERSION);

        let removed = uninstall_paths(&paths).unwrap();
        assert!(!removed.installed);
        assert!(!removed.conflict);
        let config = fs::read_to_string(&paths.config_path).unwrap();
        assert!(config.contains("unified_exec = true"));
        assert!(config.contains("other@personal"));
        assert!(!config.contains(PLUGIN_SELECTOR));
        assert!(!config.contains("marketplaces.codex-nn"));
        assert!(!config.contains("plugins = true"));
        assert!(!paths.marketplace_root.exists());
        assert!(!paths.plugin_cache_base_root.exists());
    }

    #[test]
    fn preserves_preexisting_plugin_feature_on_uninstall() {
        let (_root, paths) = test_paths();
        write_text(&paths.config_path, "[features]\nplugins = true\n").unwrap();

        install_paths(&paths).unwrap();
        uninstall_paths(&paths).unwrap();

        let config = fs::read_to_string(&paths.config_path).unwrap();
        assert!(config.contains("plugins = true"));
    }

    #[test]
    fn restores_explicitly_disabled_plugin_feature_on_uninstall() {
        let (_root, paths) = test_paths();
        write_text(&paths.config_path, "[features]\nplugins = false\n").unwrap();

        install_paths(&paths).unwrap();
        uninstall_paths(&paths).unwrap();

        let config = fs::read_to_string(&paths.config_path).unwrap();
        assert!(config.contains("plugins = false"));
    }

    #[test]
    fn refuses_to_remove_manually_changed_config() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        let config = fs::read_to_string(&paths.config_path)
            .unwrap()
            .replace("enabled = true", "enabled = false");
        write_text(&paths.config_path, &config).unwrap();

        let status = uninstall_paths(&paths).unwrap();

        assert!(status.conflict);
        assert!(paths.plugin_root.exists());
        assert!(paths.managed_state_path.exists());
    }

    #[test]
    fn treats_extra_managed_table_fields_as_conflict() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        let config = fs::read_to_string(&paths.config_path)
            .unwrap()
            .replace("enabled = true", "enabled = true\nuser_note = \"keep\"");
        write_text(&paths.config_path, &config).unwrap();

        let status = uninstall_paths(&paths).unwrap();

        assert!(status.conflict);
        assert!(fs::read_to_string(&paths.config_path)
            .unwrap()
            .contains("user_note"));
    }

    #[test]
    fn rejects_unmanaged_name_collision() {
        let (_root, paths) = test_paths();
        write_text(
            &paths.config_path,
            "[marketplaces.codex-nn]\nsource_type = \"local\"\nsource = \"/other\"\n",
        )
        .unwrap();

        let error = install_paths(&paths).unwrap_err();

        assert!(error.contains("同名 marketplace"));
        assert!(!paths.managed_state_path.exists());
    }

    #[test]
    fn rejects_non_boolean_plugin_feature() {
        let (_root, paths) = test_paths();
        write_text(&paths.config_path, "[features]\nplugins = \"custom\"\n").unwrap();

        let error = install_paths(&paths).unwrap_err();

        assert!(error.contains("不是布尔值"));
        assert!(fs::read_to_string(&paths.config_path)
            .unwrap()
            .contains("plugins = \"custom\""));
    }

    #[test]
    fn refreshes_managed_plugin_version() {
        let (_root, paths) = test_paths();
        install_paths(&paths).unwrap();
        let mut state = read_managed_state(&paths.managed_state_path)
            .unwrap()
            .unwrap();
        state.plugin_version = "0.0.1".into();
        write_json(&paths.managed_state_path, &state).unwrap();
        std::fs::write(
            paths
                .plugin_root
                .join("skills/design-codex-nn-theme/SKILL.md"),
            b"stale",
        )
        .unwrap();

        update_paths_if_version_changed(&paths).unwrap();

        let refreshed = read_managed_state(&paths.managed_state_path)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.plugin_version, PLUGIN_VERSION);
        let skill = std::fs::read_to_string(
            paths
                .plugin_root
                .join("skills/design-codex-nn-theme/SKILL.md"),
        )
        .unwrap();
        assert!(skill.contains("name: design-codex-nn-theme"));
    }
}
