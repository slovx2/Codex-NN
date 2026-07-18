use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::locale;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub root: PathBuf,
    pub themes: PathBuf,
    pub state: PathBuf,
    pub settings: PathBuf,
    pub logs: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let root = app.path().app_data_dir().map_err(|error| {
            locale::localize(
                &format!("无法定位应用数据目录：{error}"),
                &format!("Unable to locate the app data directory: {error}"),
            )
        })?;
        Self::from_root(root)
    }

    pub fn from_root(root: PathBuf) -> Result<Self, String> {
        let paths = Self {
            themes: root.join("themes"),
            state: root.join("state.json"),
            settings: root.join("settings.json"),
            logs: root.join("codex-nn.log"),
            root,
        };
        paths.ensure()?;
        Ok(paths)
    }

    fn ensure(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.themes).map_err(|error| {
            locale::localize(
                &format!("无法创建主题目录：{error}"),
                &format!("Unable to create the theme directory: {error}"),
            )
        })?;
        secure_directory(&self.root)?;
        secure_directory(&self.themes)?;
        Ok(())
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        locale::localize(
            "写入路径缺少父目录",
            "The write path has no parent directory",
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| {
        locale::localize(
            &format!("无法创建目录：{error}"),
            &format!("Unable to create the directory: {error}"),
        )
    })?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("data"),
        std::process::id()
    ));
    std::fs::write(&temporary, bytes).map_err(|error| {
        locale::localize(
            &format!("无法写入临时文件：{error}"),
            &format!("Unable to write the temporary file: {error}"),
        )
    })?;
    secure_file(&temporary)?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        locale::localize(
            &format!("无法原子替换文件：{error}"),
            &format!("Unable to atomically replace the file: {error}"),
        )
    })?;
    secure_file(path)
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        locale::localize(
            &format!("无法设置目录权限：{error}"),
            &format!("Unable to set directory permissions: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| {
        locale::localize(
            &format!("无法设置文件权限：{error}"),
            &format!("Unable to set file permissions: {error}"),
        )
    })
}

#[cfg(not(unix))]
fn secure_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_app_directories_and_atomically_replaces_files() {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(root.path().join("nested/app-data")).unwrap();
        assert!(paths.root.is_dir());
        assert!(paths.themes.is_dir());

        let target = paths.root.join("settings.json");
        atomic_write(&target, b"first").unwrap();
        atomic_write(&target, b"second").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert!(!paths
            .root
            .join(format!(".settings.json.{}.tmp", std::process::id()))
            .exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&paths.root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
