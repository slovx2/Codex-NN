use std::{
    collections::HashSet,
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, ImageFormat, ImageReader,
};
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive};

use crate::{
    models::{ThemeInstallOutcome, ThemeManifest, ThemeSummary},
    paths::{atomic_write, AppPaths},
};

const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 3200;
const DEFAULT_THEME_ID: &str = "strawberry-starlight";
const LEGACY_DEFAULT_THEME_ID: &str = "codex-nn-default";
const STRAWBERRY_STARLIGHT_THEME: &str =
    include_str!("../../theme-packs/strawberry-starlight/theme.json");
const STRAWBERRY_STARLIGHT_IMAGE: &[u8] =
    include_bytes!("../../theme-packs/strawberry-starlight/background.webp");
const AZURE_NEON_FRONTIER_THEME: &str =
    include_str!("../../theme-packs/azure-neon-frontier/theme.json");
const AZURE_NEON_FRONTIER_IMAGE: &[u8] =
    include_bytes!("../../theme-packs/azure-neon-frontier/background.webp");

struct BuiltInTheme {
    id: &'static str,
    manifest: &'static str,
    image: &'static [u8],
}

const BUILT_IN_THEMES: &[BuiltInTheme] = &[
    BuiltInTheme {
        id: "strawberry-starlight",
        manifest: STRAWBERRY_STARLIGHT_THEME,
        image: STRAWBERRY_STARLIGHT_IMAGE,
    },
    BuiltInTheme {
        id: "azure-neon-frontier",
        manifest: AZURE_NEON_FRONTIER_THEME,
        image: AZURE_NEON_FRONTIER_IMAGE,
    },
];

#[derive(Debug, Clone)]
pub struct ThemeStore {
    paths: AppPaths,
}

struct PreparedTheme {
    manifest: ThemeManifest,
    image: Vec<u8>,
    preview: Vec<u8>,
}

impl ThemeStore {
    pub fn new(paths: AppPaths) -> Result<Self, String> {
        let store = Self { paths };
        store.remove_legacy_default()?;
        store.ensure_built_ins()?;
        Ok(store)
    }

    pub fn default_id(&self) -> &'static str {
        DEFAULT_THEME_ID
    }

    pub fn list(&self, active_id: Option<&str>) -> Result<Vec<ThemeSummary>, String> {
        let mut themes = Vec::new();
        let entries = std::fs::read_dir(&self.paths.themes)
            .map_err(|error| format!("无法读取主题库：{error}"))?;
        for entry in entries.flatten() {
            let directory = entry.path();
            if !directory.is_dir() {
                continue;
            }
            if let Ok(manifest) = self.read_manifest_from(&directory) {
                let preview = std::fs::read(directory.join("preview.jpg")).unwrap_or_default();
                let built_in = self.is_built_in(&manifest.id);
                themes.push(summary_from(manifest, preview, active_id, built_in));
            }
        }
        themes.sort_by(|left, right| {
            right
                .built_in
                .cmp(&left.built_in)
                .then(left.name.cmp(&right.name))
        });
        Ok(themes)
    }

    pub fn load(&self, id: &str) -> Result<(ThemeManifest, Vec<u8>), String> {
        validate_id(id)?;
        let directory = self.paths.themes.join(id);
        let manifest = self.read_manifest_from(&directory)?;
        let image_path = safe_child(&directory, &manifest.image)?;
        let image =
            std::fs::read(image_path).map_err(|error| format!("无法读取主题图片：{error}"))?;
        if image.is_empty() || image.len() as u64 > MAX_IMAGE_BYTES {
            return Err("主题图片为空或超过 16 MB".into());
        }
        Ok((manifest, image))
    }

    pub fn install(
        &self,
        package: PathBuf,
        allow_update: bool,
    ) -> Result<ThemeInstallOutcome, String> {
        let prepared = inspect_package(&package)?;
        if self.is_built_in(&prepared.manifest.id) {
            return Err("内置主题不可覆盖".into());
        }
        let id = prepared.manifest.id.clone();
        let final_dir = self.paths.themes.join(&id);
        let updated = final_dir.exists();
        let pending_summary = summary_from(
            prepared.manifest.clone(),
            prepared.preview.clone(),
            None,
            false,
        );
        if updated && !allow_update {
            return Ok(ThemeInstallOutcome {
                installed: false,
                updated: false,
                needs_confirmation: true,
                theme: pending_summary,
            });
        }

        let nonce = Uuid::new_v4().simple();
        let temporary = self.paths.themes.join(format!(".{id}.{nonce}.tmp"));
        std::fs::create_dir(&temporary)
            .map_err(|error| format!("无法创建主题临时目录：{error}"))?;
        let write_result = (|| {
            atomic_write(&temporary.join(&prepared.manifest.image), &prepared.image)?;
            atomic_write(&temporary.join("preview.jpg"), &prepared.preview)?;
            let json =
                serde_json::to_vec_pretty(&prepared.manifest).map_err(|error| error.to_string())?;
            atomic_write(
                &temporary.join("theme.json"),
                &[json, b"\n".to_vec()].concat(),
            )
        })();
        if let Err(error) = write_result {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(error);
        }

        if updated {
            let backup = self.paths.themes.join(format!(".{id}.{nonce}.backup"));
            std::fs::rename(&final_dir, &backup)
                .map_err(|error| format!("无法备份现有主题：{error}"))?;
            if let Err(error) = std::fs::rename(&temporary, &final_dir) {
                let _ = std::fs::rename(&backup, &final_dir);
                let _ = std::fs::remove_dir_all(&temporary);
                return Err(format!("无法更新主题：{error}"));
            }
            let _ = std::fs::remove_dir_all(backup);
        } else if let Err(error) = std::fs::rename(&temporary, &final_dir) {
            let _ = std::fs::remove_dir_all(&temporary);
            return Err(format!("无法安装主题：{error}"));
        }

        Ok(ThemeInstallOutcome {
            installed: true,
            updated,
            needs_confirmation: false,
            theme: self.summary(&id, false)?,
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        if self.is_built_in(id) {
            return Err("内置主题不可删除".into());
        }
        let directory = self.paths.themes.join(id);
        if !directory.is_dir() {
            return Err(format!("主题不存在：{id}"));
        }
        let trash = self
            .paths
            .themes
            .join(format!(".{id}.{}.deleting", Uuid::new_v4().simple()));
        std::fs::rename(&directory, &trash).map_err(|error| format!("无法移除主题：{error}"))?;
        std::fs::remove_dir_all(&trash).map_err(|error| format!("无法清理主题文件：{error}"))
    }

    pub fn summary(&self, id: &str, active: bool) -> Result<ThemeSummary, String> {
        self.list(if active { Some(id) } else { None })?
            .into_iter()
            .find(|theme| theme.id == id)
            .ok_or_else(|| format!("主题不存在：{id}"))
    }

    fn is_built_in(&self, id: &str) -> bool {
        BUILT_IN_THEMES.iter().any(|theme| theme.id == id)
    }

    fn ensure_built_ins(&self) -> Result<(), String> {
        for theme in BUILT_IN_THEMES {
            self.ensure_built_in(theme)?;
        }
        Ok(())
    }

    fn remove_legacy_default(&self) -> Result<(), String> {
        let directory = self.paths.themes.join(LEGACY_DEFAULT_THEME_ID);
        if directory.exists() {
            std::fs::remove_dir_all(&directory)
                .map_err(|error| format!("无法移除旧版默认主题：{error}"))?;
        }
        Ok(())
    }

    fn ensure_built_in(&self, built_in: &BuiltInTheme) -> Result<(), String> {
        let manifest: ThemeManifest = serde_json::from_str(built_in.manifest)
            .map_err(|error| format!("内置主题 {} 的清单格式错误：{error}", built_in.id))?;
        validate_manifest(&manifest)?;
        if manifest.id != built_in.id {
            return Err(format!("内置主题 {} 的 ID 不匹配", built_in.id));
        }

        let directory = self.paths.themes.join(built_in.id);
        let image_path = directory.join(&manifest.image);
        let manifest_path = directory.join("theme.json");
        if std::fs::read(&manifest_path).is_ok_and(|bytes| bytes == built_in.manifest.as_bytes())
            && std::fs::read(&image_path).is_ok_and(|bytes| bytes == built_in.image)
            && directory.join("preview.jpg").is_file()
        {
            return Ok(());
        }

        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建内置主题 {}：{error}", built_in.id))?;
        atomic_write(&image_path, built_in.image)?;
        atomic_write(&manifest_path, built_in.manifest.as_bytes())?;
        let image = image::load_from_memory(built_in.image)
            .map_err(|error| format!("内置主题 {} 的图片损坏：{error}", built_in.id))?;
        atomic_write(&directory.join("preview.jpg"), &encode_preview(&image)?)
    }

    fn read_manifest_from(&self, directory: &Path) -> Result<ThemeManifest, String> {
        let bytes = std::fs::read(directory.join("theme.json"))
            .map_err(|error| format!("无法读取 theme.json：{error}"))?;
        let manifest: ThemeManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("theme.json 格式错误：{error}"))?;
        validate_manifest(&manifest)?;
        if manifest.id
            != directory
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
        {
            return Err("主题目录与主题 ID 不匹配".into());
        }
        safe_child(directory, &manifest.image)?;
        Ok(manifest)
    }
}

fn inspect_package(path: &Path) -> Result<PreparedTheme, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取主题包：{error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PACKAGE_BYTES {
        return Err("主题 ZIP 必须是 1 字节到 20 MB 的文件".into());
    }
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
        != Some("zip")
    {
        return Err("主题包必须使用 .zip 扩展名".into());
    }

    let file = File::open(path).map_err(|error| format!("无法打开主题包：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("主题 ZIP 格式错误：{error}"))?;
    if archive.len() != 2 {
        return Err("主题 ZIP 根目录必须且只能包含 theme.json 和一张主题图片".into());
    }

    let mut names = HashSet::new();
    let mut unpacked = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法读取 ZIP 条目：{error}"))?;
        if entry.encrypted() {
            return Err("主题 ZIP 不支持加密文件".into());
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err("主题 ZIP 仅支持 Stored 或 Deflate 压缩".into());
        }
        if entry.is_dir() {
            return Err("主题 ZIP 不允许目录，文件必须直接位于根目录".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("主题 ZIP 不允许符号链接".into());
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "主题 ZIP 包含不安全路径".to_string())?;
        if enclosed.components().count() != 1 {
            return Err("主题 ZIP 文件必须直接位于根目录".into());
        }
        let name = enclosed
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "主题 ZIP 文件名必须是 UTF-8".to_string())?
            .to_string();
        if !names.insert(name) {
            return Err("主题 ZIP 包含重复文件".into());
        }
        unpacked = unpacked.saturating_add(entry.size());
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("主题 ZIP 解压后超过 20 MB".into());
        }
    }
    if !names.contains("theme.json") {
        return Err("主题 ZIP 缺少 theme.json".into());
    }

    let manifest_bytes = read_entry(&mut archive, "theme.json", MAX_MANIFEST_BYTES)?;
    let manifest: ThemeManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("theme.json 格式错误：{error}"))?;
    validate_manifest(&manifest)?;
    if names.len() != 2 || !names.contains(&manifest.image) {
        return Err("主题 ZIP 必须只包含 theme.json 和清单引用的主题图片".into());
    }

    let image_bytes = read_entry(&mut archive, &manifest.image, MAX_IMAGE_BYTES)?;
    let expected_format = image_format(&manifest.image)?;
    let actual_format =
        image::guess_format(&image_bytes).map_err(|_| "无法识别主题图片格式".to_string())?;
    if actual_format != expected_format {
        return Err("主题图片内容与扩展名不一致".into());
    }
    let dimensions = ImageReader::new(Cursor::new(&image_bytes))
        .with_guessed_format()
        .map_err(|error| format!("无法识别主题图片：{error}"))?
        .into_dimensions()
        .map_err(|error| format!("无法读取主题图片尺寸：{error}"))?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || dimensions.0 > MAX_IMAGE_EDGE
        || dimensions.1 > MAX_IMAGE_EDGE
    {
        return Err("主题图片最长边不可超过 3200 像素".into());
    }
    let image = image::load_from_memory_with_format(&image_bytes, expected_format)
        .map_err(|error| format!("无法解码主题图片：{error}"))?;
    let preview = encode_preview(&image)?;
    Ok(PreparedTheme {
        manifest,
        image: image_bytes,
        preview,
    })
}

fn read_entry(archive: &mut ZipArchive<File>, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(name)
        .map_err(|error| format!("无法读取 {name}：{error}"))?;
    if entry.size() == 0 || entry.size() > limit {
        return Err(format!("{name} 为空或超过大小限制"));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法解压 {name}：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{name} 超过大小限制"));
    }
    Ok(bytes)
}

fn validate_manifest(manifest: &ThemeManifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err(format!("不支持主题 schema v{}", manifest.schema_version));
    }
    validate_id(&manifest.id)?;
    validate_text("主题名称", &manifest.name, 80, true)?;
    if !matches!(
        manifest.layout_preset.as_str(),
        "standard" | "dreamSkin" | "strawberryStarlight" | "azureNeon"
    ) {
        return Err("主题布局只能是 standard、dreamSkin、strawberryStarlight 或 azureNeon".into());
    }
    validate_text("品牌副标题", &manifest.brand_subtitle, 80, false)?;
    validate_text("主题标语", &manifest.tagline, 160, false)?;
    validate_text("项目提示", &manifest.project_prefix, 80, false)?;
    validate_text("项目标题", &manifest.project_label, 80, false)?;
    validate_text("状态文字", &manifest.status_text, 80, false)?;
    validate_text("装饰引语", &manifest.quote, 80, false)?;
    if Path::new(&manifest.image)
        .file_name()
        .and_then(|value| value.to_str())
        != Some(manifest.image.as_str())
    {
        return Err("主题图片必须直接位于主题目录".into());
    }
    image_format(&manifest.image)?;
    for (name, value) in [
        ("background", &manifest.colors.background),
        ("panel", &manifest.colors.panel),
        ("panelAlt", &manifest.colors.panel_alt),
        ("accent", &manifest.colors.accent),
        ("accentAlt", &manifest.colors.accent_alt),
        ("secondary", &manifest.colors.secondary),
        ("highlight", &manifest.colors.highlight),
        ("text", &manifest.colors.text),
        ("muted", &manifest.colors.muted),
        ("line", &manifest.colors.line),
    ] {
        if !is_color(value) {
            return Err(format!("主题颜色 {name} 格式错误"));
        }
    }
    Ok(())
}

fn validate_text(name: &str, value: &str, max: usize, required: bool) -> Result<(), String> {
    if required && value.trim().is_empty() {
        return Err(format!("{name}不能为空"));
    }
    if value.chars().count() > max {
        return Err(format!("{name}不可超过 {max} 个字符"));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 80
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
    {
        Ok(())
    } else {
        Err("主题 ID 只能包含小写字母、数字和连字符，且最长 80 字符".into())
    }
}

fn is_color(value: &str) -> bool {
    let value = value.trim();
    if value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|char| char.is_ascii_hexdigit())
    {
        return true;
    }
    let rgb = (value.starts_with("rgb(") || value.starts_with("rgba(")) && value.ends_with(')');
    rgb && value
        .chars()
        .all(|char| char.is_ascii_digit() || "rgba(),.% ".contains(char))
}

fn image_format(name: &str) -> Result<ImageFormat, String> {
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => Ok(ImageFormat::Jpeg),
        Some("png") => Ok(ImageFormat::Png),
        Some("webp") => Ok(ImageFormat::WebP),
        _ => Err("主题图片仅支持 PNG、JPEG 或 WebP".into()),
    }
}

fn safe_child(root: &Path, name: &str) -> Result<PathBuf, String> {
    if Path::new(name).file_name().and_then(|value| value.to_str()) == Some(name) {
        Ok(root.join(name))
    } else {
        Err("主题图片必须位于主题目录内".into())
    }
}

fn encode_preview(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 76)
        .encode_image(&image.resize(640, 400, FilterType::Triangle))
        .map_err(|error| format!("无法生成主题预览：{error}"))?;
    Ok(output)
}

fn summary_from(
    manifest: ThemeManifest,
    preview: Vec<u8>,
    active_id: Option<&str>,
    built_in: bool,
) -> ThemeSummary {
    ThemeSummary {
        active: active_id == Some(manifest.id.as_str()),
        built_in,
        preview_data_url: format!("data:image/jpeg;base64,{}", STANDARD.encode(preview)),
        id: manifest.id,
        name: manifest.name,
        tagline: manifest.tagline,
        quote: manifest.quote,
        accent: manifest.colors.accent,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use image::ImageEncoder;
    use tempfile::TempDir;
    use zip::{write::SimpleFileOptions, ZipWriter};

    use super::*;

    fn test_store() -> (TempDir, ThemeStore) {
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(root.path().join("data")).unwrap();
        let store = ThemeStore::new(paths).unwrap();
        (root, store)
    }

    fn manifest(id: &str, image: &str) -> ThemeManifest {
        let mut value: ThemeManifest = serde_json::from_str(STRAWBERRY_STARLIGHT_THEME).unwrap();
        value.id = id.into();
        value.name = "测试主题".into();
        value.layout_preset = "standard".into();
        value.image = image.into();
        value
    }

    fn png(width: u32, height: u32) -> Vec<u8> {
        let pixels = vec![210_u8; (width * height * 3) as usize];
        let mut output = Vec::new();
        image::codecs::png::PngEncoder::new(&mut output)
            .write_image(&pixels, width, height, image::ExtendedColorType::Rgb8)
            .unwrap();
        output
    }

    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn package(path: &Path, manifest: &ThemeManifest, image: Vec<u8>) {
        write_zip(
            path,
            &[
                ("theme.json", serde_json::to_vec_pretty(manifest).unwrap()),
                (&manifest.image, image),
            ],
        );
    }

    #[test]
    fn installs_lists_and_loads_valid_package() {
        let (root, store) = test_store();
        let package_path = root.path().join("theme.zip");
        package(
            &package_path,
            &manifest("test-theme", "background.png"),
            png(1200, 720),
        );

        let outcome = store.install(package_path, false).unwrap();
        assert!(outcome.installed);
        assert!(!outcome.updated);
        assert!(!outcome.theme.built_in);
        assert!(outcome
            .theme
            .preview_data_url
            .starts_with("data:image/jpeg;base64,"));
        let (loaded, image) = store.load("test-theme").unwrap();
        assert_eq!(loaded.name, "测试主题");
        assert_eq!(loaded.layout_preset, "standard");
        assert!(!image.is_empty());
    }

    #[test]
    fn defaults_legacy_manifests_to_standard_layout() {
        let mut value: serde_json::Value =
            serde_json::from_str(STRAWBERRY_STARLIGHT_THEME).unwrap();
        value.as_object_mut().unwrap().remove("layoutPreset");
        let manifest: ThemeManifest = serde_json::from_value(value).unwrap();
        assert_eq!(manifest.layout_preset, "standard");
    }

    #[test]
    fn duplicate_requires_confirmation_then_updates() {
        let (root, store) = test_store();
        let first = root.path().join("first.zip");
        let second = root.path().join("second.zip");
        let initial = manifest("update-theme", "background.png");
        package(&first, &initial, png(100, 80));
        store.install(first, false).unwrap();

        let mut updated = initial;
        updated.name = "更新后的主题".into();
        package(&second, &updated, png(120, 90));
        let pending = store.install(second.clone(), false).unwrap();
        assert!(pending.needs_confirmation);
        assert_eq!(
            store.summary("update-theme", false).unwrap().name,
            "测试主题"
        );

        let outcome = store.install(second, true).unwrap();
        assert!(outcome.installed && outcome.updated);
        assert_eq!(
            store.summary("update-theme", false).unwrap().name,
            "更新后的主题"
        );
    }

    #[test]
    fn exposes_and_protects_all_built_in_themes() {
        let (root, store) = test_store();
        let themes = store.list(None).unwrap();
        assert_eq!(themes.len(), 2);
        assert_eq!(store.default_id(), "strawberry-starlight");

        for built_in in BUILT_IN_THEMES {
            let summary = themes.iter().find(|theme| theme.id == built_in.id).unwrap();
            assert!(summary.built_in);

            let (loaded, image) = store.load(built_in.id).unwrap();
            assert_eq!(loaded.id, built_in.id);
            assert!(matches!(
                loaded.layout_preset.as_str(),
                "strawberryStarlight" | "azureNeon"
            ));
            assert!(!image.is_empty());

            let package_path = root.path().join(format!("{}.zip", built_in.id));
            package(
                &package_path,
                &manifest(built_in.id, "background.png"),
                png(100, 80),
            );
            assert!(store.install(package_path, true).is_err());
            assert!(store.delete(built_in.id).is_err());
        }
    }

    #[test]
    fn refreshes_changed_built_in_files_on_startup() {
        let (_root, store) = test_store();
        let manifest_path = store
            .paths
            .themes
            .join("strawberry-starlight")
            .join("theme.json");
        std::fs::write(&manifest_path, b"{}").unwrap();

        let refreshed = ThemeStore::new(store.paths.clone()).unwrap();
        let (manifest, _) = refreshed.load("strawberry-starlight").unwrap();
        assert_eq!(manifest.layout_preset, "strawberryStarlight");
    }

    #[test]
    fn rejects_traversal_unknown_schema_invalid_color_and_oversized_image() {
        let (root, store) = test_store();
        let traversal = root.path().join("traversal.zip");
        let value = manifest("bad-path", "background.png");
        write_zip(
            &traversal,
            &[
                ("theme.json", serde_json::to_vec(&value).unwrap()),
                ("../background.png", png(10, 10)),
            ],
        );
        assert!(store.install(traversal, false).is_err());

        let schema = root.path().join("schema.zip");
        let mut value = manifest("bad-schema", "background.png");
        value.schema_version = 2;
        package(&schema, &value, png(10, 10));
        assert!(store.install(schema, false).is_err());

        let color = root.path().join("color.zip");
        let mut value = manifest("bad-color", "background.png");
        value.colors.accent = "url(evil)".into();
        package(&color, &value, png(10, 10));
        assert!(store.install(color, false).is_err());

        let layout = root.path().join("layout.zip");
        let mut value = manifest("bad-layout", "background.png");
        value.layout_preset = "arbitraryScript".into();
        package(&layout, &value, png(10, 10));
        assert!(store.install(layout, false).is_err());

        let dimensions = root.path().join("dimensions.zip");
        package(
            &dimensions,
            &manifest("too-wide", "background.png"),
            png(MAX_IMAGE_EDGE + 1, 1),
        );
        assert!(store.install(dimensions, false).is_err());
    }

    #[test]
    fn rejects_extra_files_and_image_extension_spoofing() {
        let (root, store) = test_store();
        let extra = root.path().join("extra.zip");
        let value = manifest("extra-file", "background.png");
        write_zip(
            &extra,
            &[
                ("theme.json", serde_json::to_vec(&value).unwrap()),
                ("background.png", png(10, 10)),
                ("readme.txt", b"extra".to_vec()),
            ],
        );
        assert!(store.install(extra, false).is_err());

        let spoofed = root.path().join("spoofed.zip");
        let value = manifest("spoofed", "background.jpg");
        package(&spoofed, &value, png(10, 10));
        assert!(store.install(spoofed, false).is_err());
    }
}
