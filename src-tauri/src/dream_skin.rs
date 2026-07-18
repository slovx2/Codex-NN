use std::{
    collections::HashSet,
    fs::{File, Metadata},
    io::{Read, Write},
    path::{Component, Path},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use zip::{result::ZipError, write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::models::{ThemeArt, ThemeColors, ThemeManifest};

const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 20 * 1024 * 1024;
const BUILT_IN_IDS: &[&str] = &[
    "adventure-atlas",
    "strawberry-starlight",
    "azure-neon-frontier",
    "miku-future-collab",
    "portal-dimension-lab",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSkinImportRequest {
    pub source_path: String,
    #[serde(default)]
    pub allow_update: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DreamSkinManifest {
    schema_version: u8,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    brand_subtitle: String,
    #[serde(default)]
    tagline: String,
    #[serde(default)]
    project_prefix: String,
    #[serde(default)]
    project_label: String,
    #[serde(default)]
    status_text: String,
    #[serde(default)]
    quote: String,
    image: String,
    #[serde(default)]
    appearance: Option<String>,
    #[serde(default)]
    art: ThemeArt,
    #[serde(default)]
    colors: DreamSkinColors,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DreamSkinColors {
    background: Option<String>,
    panel: Option<String>,
    panel_alt: Option<String>,
    accent: Option<String>,
    accent_alt: Option<String>,
    secondary: Option<String>,
    highlight: Option<String>,
    text: Option<String>,
    muted: Option<String>,
    line: Option<String>,
}

struct ConvertedTheme {
    manifest: ThemeManifest,
    image: Vec<u8>,
}

pub fn convert_to_package(source: &Path, output: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("无法读取 Dream Skin 主题来源：{error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Dream Skin 主题来源不允许符号链接".into());
    }
    let converted = if metadata.is_dir() {
        read_directory(source)?
    } else if metadata.is_file()
        && source
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        read_zip(source, &metadata)?
    } else {
        return Err("Dream Skin 主题来源必须是主题目录或 ZIP 文件".into());
    };
    write_package(output, converted)
}

fn read_directory(root: &Path) -> Result<ConvertedTheme, String> {
    let manifest_path = root.join("theme.json");
    reject_symlink(&manifest_path)?;
    let manifest_bytes = read_file_limited(&manifest_path, MAX_MANIFEST_BYTES, "theme.json")?;
    let raw = parse_manifest(&manifest_bytes)?;
    validate_image_name(&raw.image)?;
    let image_path = root.join(&raw.image);
    reject_symlink(&image_path)?;
    let image = read_file_limited(&image_path, MAX_IMAGE_BYTES, "主题图片")?;

    for entry in
        std::fs::read_dir(root).map_err(|error| format!("无法读取 Dream Skin 主题目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取主题目录条目：{error}"))?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| "Dream Skin 主题文件名必须是 UTF-8".to_string())?;
        if name == ".DS_Store" || name == "theme.json" || name == raw.image {
            continue;
        }
        if name == "__MACOSX" && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            reject_symlinks_recursively(&entry.path())?;
            continue;
        }
        return Err(format!("Dream Skin 主题目录包含不支持的额外条目：{name}"));
    }
    Ok(ConvertedTheme {
        manifest: convert_manifest(raw),
        image,
    })
}

fn read_zip(path: &Path, metadata: &Metadata) -> Result<ConvertedTheme, String> {
    if metadata.len() == 0 || metadata.len() > MAX_PACKAGE_BYTES {
        return Err("Dream Skin ZIP 必须是 1 字节到 20 MB 的文件".into());
    }
    let file = File::open(path).map_err(|error| format!("无法打开 Dream Skin ZIP：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Dream Skin ZIP 格式错误：{error}"))?;
    let mut effective_files = Vec::new();
    let mut names = HashSet::new();
    let mut unpacked = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(zip_entry_error)?;
        if entry.encrypted() {
            return Err("Dream Skin ZIP 不支持加密文件".into());
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err("Dream Skin ZIP 仅支持 Stored 或 Deflate 压缩".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Dream Skin ZIP 不允许符号链接".into());
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Dream Skin ZIP 包含不安全路径".to_string())?;
        let name = enclosed
            .to_str()
            .ok_or_else(|| "Dream Skin ZIP 文件名必须是 UTF-8".to_string())?
            .replace('\\', "/");
        if Path::new(&name).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("Dream Skin ZIP 包含不安全路径".into());
        }
        if !names.insert(name.clone()) {
            return Err("Dream Skin ZIP 包含重复文件".into());
        }
        unpacked = unpacked.saturating_add(entry.size());
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("Dream Skin ZIP 解压后超过 20 MB".into());
        }
        if !entry.is_dir() && !is_macos_metadata(&enclosed) {
            effective_files.push(name);
        }
    }

    let theme_entries = effective_files
        .iter()
        .filter(|name| {
            Path::new(name).file_name().and_then(|value| value.to_str()) == Some("theme.json")
        })
        .cloned()
        .collect::<Vec<_>>();
    if theme_entries.len() != 1 {
        return Err("Dream Skin ZIP 必须包含唯一的 theme.json".into());
    }
    let theme_entry = &theme_entries[0];
    if Path::new(theme_entry).components().count() > 2 {
        return Err("Dream Skin ZIP 最多允许一层包装目录".into());
    }
    let manifest_bytes = read_zip_entry(&mut archive, theme_entry, MAX_MANIFEST_BYTES)?;
    let raw = parse_manifest(&manifest_bytes)?;
    validate_image_name(&raw.image)?;
    let prefix = Path::new(theme_entry)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let image_entry = prefix.join(&raw.image).to_string_lossy().replace('\\', "/");
    if effective_files.len() != 2 || !effective_files.contains(&image_entry) {
        return Err("Dream Skin ZIP 只能包含 theme.json 和清单引用的图片".into());
    }
    let image = read_zip_entry(&mut archive, &image_entry, MAX_IMAGE_BYTES)?;
    Ok(ConvertedTheme {
        manifest: convert_manifest(raw),
        image,
    })
}

fn parse_manifest(bytes: &[u8]) -> Result<DreamSkinManifest, String> {
    let manifest: DreamSkinManifest = serde_json::from_slice(bytes)
        .map_err(|error| format!("Dream Skin theme.json 格式错误：{error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "不支持 Dream Skin schema v{}",
            manifest.schema_version
        ));
    }
    Ok(manifest)
}

fn convert_manifest(raw: DreamSkinManifest) -> ThemeManifest {
    let id = convert_id(&raw.id, &raw.name);
    ThemeManifest {
        schema_version: 1,
        id,
        name: text(&raw.name, "ChatGPT Dream Skin", 80),
        layout_preset: "dreamSkin".into(),
        brand_subtitle: text(&raw.brand_subtitle, "CODEX DREAM SKIN", 80),
        tagline: text(&raw.tagline, "Make something wonderful.", 160),
        project_prefix: text(&raw.project_prefix, "选择项目 · ", 80),
        project_label: text(&raw.project_label, "◉  选择项目", 80),
        status_text: text(&raw.status_text, "DREAM SKIN ONLINE", 80),
        quote: text(&raw.quote, "MAKE SOMETHING WONDERFUL", 80),
        image: raw.image,
        appearance: raw.appearance,
        art: raw.art,
        colors: ThemeColors {
            background: color(raw.colors.background, "#071116"),
            panel: color(raw.colors.panel, "#0b1a20"),
            panel_alt: color(raw.colors.panel_alt, "#10272c"),
            accent: color(raw.colors.accent, "#7cff46"),
            accent_alt: color(raw.colors.accent_alt, "#b8ff3d"),
            secondary: color(raw.colors.secondary, "#36d7e8"),
            highlight: color(raw.colors.highlight, "#642a8c"),
            text: color(raw.colors.text, "#e9fff1"),
            muted: color(raw.colors.muted, "#9ebdb3"),
            line: color(raw.colors.line, "rgba(124, 255, 70, .28)"),
        },
    }
}

fn text(value: &str, fallback: &str, max: usize) -> String {
    let value = value.trim();
    let selected = if value.is_empty() { fallback } else { value };
    selected.chars().take(max).collect()
}

fn color(value: Option<String>, fallback: &str) -> Option<String> {
    value.map(|value| {
        let value = value.trim().to_string();
        if is_color(&value) {
            value
        } else {
            fallback.to_string()
        }
    })
}

fn is_color(value: &str) -> bool {
    if value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return true;
    }
    (value.starts_with("rgb(") || value.starts_with("rgba("))
        && value.ends_with(')')
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || "rgba(),.% ".contains(character))
}

fn convert_id(raw_id: &str, name: &str) -> String {
    let raw_id = raw_id.trim();
    if valid_id(raw_id) && !BUILT_IN_IDS.contains(&raw_id) {
        return raw_id.to_string();
    }
    let seed = if raw_id.is_empty() {
        name.trim()
    } else {
        raw_id
    };
    let mut slug = String::new();
    let mut last_hyphen = false;
    for character in seed.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_hyphen = false;
        } else if !slug.is_empty() && !last_hyphen {
            slug.push('-');
            last_hyphen = true;
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "theme" } else { slug };
    let hash = format!("{:x}", Sha256::digest(seed.as_bytes()));
    format!("dream-skin-{slug}-{}", &hash[..8])
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.as_bytes()[0].is_ascii_lowercase()
        && id
            .chars()
            .all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-')
}

fn validate_image_name(name: &str) -> Result<(), String> {
    if Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name) {
        return Err("Dream Skin 主题图片必须直接位于主题目录".into());
    }
    match Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "webp") => Ok(()),
        _ => Err("Dream Skin 主题图片仅支持 PNG、JPEG 或 WebP".into()),
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} 必须是普通文件", path.display()));
    }
    Ok(())
}

fn reject_symlinks_recursively(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{} 不允许是符号链接", path.display()));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)
            .map_err(|error| format!("无法读取 {}：{error}", path.display()))?
        {
            let entry = entry.map_err(|error| format!("无法读取 macOS 元数据：{error}"))?;
            reject_symlinks_recursively(&entry.path())?;
        }
    }
    Ok(())
}

fn read_file_limited(path: &Path, limit: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取 {label}：{error}"))?;
    if metadata.len() == 0 || metadata.len() > limit {
        return Err(format!("{label} 为空或超过大小限制"));
    }
    std::fs::read(path).map_err(|error| format!("无法读取 {label}：{error}"))
}

fn read_zip_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(zip_entry_error)?;
    if entry.size() == 0 || entry.size() > limit {
        return Err(format!("{name} 为空或超过大小限制"));
    }
    let mut output = Vec::with_capacity(entry.size() as usize);
    entry
        .take(limit + 1)
        .read_to_end(&mut output)
        .map_err(|error| format!("无法解压 {name}：{error}"))?;
    if output.len() as u64 > limit {
        return Err(format!("{name} 超过大小限制"));
    }
    Ok(output)
}

fn zip_entry_error(error: ZipError) -> String {
    match error {
        ZipError::UnsupportedArchive(message) if message == ZipError::PASSWORD_REQUIRED => {
            "Dream Skin ZIP 不支持加密文件".into()
        }
        other => format!("无法读取 Dream Skin ZIP 条目：{other}"),
    }
}

fn is_macos_metadata(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "__MACOSX")
        || path.file_name().and_then(|value| value.to_str()) == Some(".DS_Store")
}

fn write_package(path: &Path, converted: ConvertedTheme) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "临时主题包路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建临时主题包目录：{error}"))?;
    let file = File::create(path).map_err(|error| format!("无法创建临时主题包：{error}"))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file("theme.json", options)
        .map_err(|error| format!("无法写入临时 theme.json：{error}"))?;
    writer
        .write_all(
            &serde_json::to_vec_pretty(&converted.manifest)
                .map_err(|error| format!("无法序列化转换主题：{error}"))?,
        )
        .map_err(|error| format!("无法写入临时 theme.json：{error}"))?;
    writer
        .start_file(&converted.manifest.image, options)
        .map_err(|error| format!("无法写入临时主题图片：{error}"))?;
    writer
        .write_all(&converted.image)
        .map_err(|error| format!("无法写入临时主题图片：{error}"))?;
    writer
        .finish()
        .map_err(|error| format!("无法完成临时主题包：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::ImageEncoder;

    use super::*;

    fn png() -> Vec<u8> {
        let mut output = Vec::new();
        image::codecs::png::PngEncoder::new(&mut output)
            .write_image(&[210, 120, 160], 1, 1, image::ExtendedColorType::Rgb8)
            .unwrap();
        output
    }

    fn manifest(id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "id": id,
            "name": "Dream 测试",
            "image": "background.png",
            "appearance": "auto",
            "art": {
                "focusX": 0.72,
                "focusY": 0.45,
                "safeArea": "left",
                "taskMode": "ambient"
            },
            "colors": { "accent": "#e25563" },
            "promoTitle": "额外推广字段"
        }))
        .unwrap()
    }

    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    fn patch_first_central_entry(path: &Path, offset: usize, value: &[u8]) {
        let mut bytes = std::fs::read(path).unwrap();
        let position = bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .unwrap();
        bytes[position + offset..position + offset + value.len()].copy_from_slice(value);
        std::fs::write(path, bytes).unwrap();
    }

    fn converted_manifest(path: &Path) -> ThemeManifest {
        let file = File::open(path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut content = Vec::new();
        archive
            .by_name("theme.json")
            .unwrap()
            .read_to_end(&mut content)
            .unwrap();
        serde_json::from_slice(&content).unwrap()
    }

    #[test]
    fn converts_directory_with_defaults_and_ignores_ds_store() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dream");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("theme.json"), manifest("custom-theme")).unwrap();
        std::fs::write(source.join("background.png"), png()).unwrap();
        std::fs::write(source.join(".DS_Store"), b"metadata").unwrap();
        std::fs::create_dir_all(source.join("__MACOSX")).unwrap();
        std::fs::write(source.join("__MACOSX/._background.png"), b"metadata").unwrap();
        let output = root.path().join("converted.zip");

        convert_to_package(&source, &output).unwrap();

        let converted = converted_manifest(&output);
        assert_eq!(converted.id, "custom-theme");
        assert_eq!(converted.layout_preset, "dreamSkin");
        assert_eq!(converted.brand_subtitle, "CODEX DREAM SKIN");
        assert_eq!(converted.appearance.as_deref(), Some("auto"));
        assert_eq!(converted.art.focus_x, Some(0.72));
        assert_eq!(converted.art.safe_area.as_deref(), Some("left"));
        assert_eq!(converted.art.task_mode.as_deref(), Some("ambient"));
        assert_eq!(converted.colors.accent.as_deref(), Some("#e25563"));
        assert_eq!(converted.colors.panel, None);
    }

    #[test]
    fn preserves_latest_gothic_void_manifest_semantics() {
        let raw = parse_manifest(
            br##"{
              "schemaVersion": 1,
              "id": "preset-gothic-void-crusade",
              "name": "Gothic Void Crusade",
              "brandSubtitle": "CODEX DREAM SKIN",
              "tagline": "A solemn cathedral-world horizon for focused work.",
              "projectPrefix": "Select project \u00b7 ",
              "projectLabel": "\u25c9  Select project",
              "statusText": "VOID CRUSADE ONLINE",
              "quote": "MAKE SOMETHING WONDERFUL",
              "image": "background.jpg",
              "appearance": "auto",
              "art": {
                "focusX": 0.76,
                "focusY": 0.45,
                "safeArea": "left",
                "taskMode": "ambient"
              },
              "colors": {
                "background": "#0d0d0e",
                "panel": "#171513",
                "panelAlt": "#211d18",
                "accent": "#c8a55a",
                "accentAlt": "#e3c27a",
                "secondary": "#74352e",
                "highlight": "#8a2f27",
                "text": "#f3ead7",
                "muted": "#b5a386",
                "line": "rgba(200, 165, 90, .28)"
              },
              "promoTitle": "Codex Dream Skin"
            }"##,
        )
        .unwrap();

        let converted = convert_manifest(raw);

        assert_eq!(converted.id, "preset-gothic-void-crusade");
        assert_eq!(converted.layout_preset, "dreamSkin");
        assert_eq!(converted.name, "Gothic Void Crusade");
        assert_eq!(converted.project_prefix, "Select project ·");
        assert_eq!(converted.appearance.as_deref(), Some("auto"));
        assert_eq!(converted.art.focus_x, Some(0.76));
        assert_eq!(converted.art.task_mode.as_deref(), Some("ambient"));
        assert_eq!(converted.colors.panel_alt.as_deref(), Some("#211d18"));
        assert_eq!(
            converted.colors.line.as_deref(),
            Some("rgba(200, 165, 90, .28)")
        );
    }

    #[test]
    fn converts_single_wrapper_zip_and_ignores_macos_metadata() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dream.zip");
        write_zip(
            &source,
            &[
                ("my-theme/theme.json", manifest("wrapped-theme")),
                ("my-theme/background.png", png()),
                ("__MACOSX/my-theme/._background.png", b"metadata".to_vec()),
                ("my-theme/.DS_Store", b"metadata".to_vec()),
            ],
        );
        let output = root.path().join("converted.zip");

        convert_to_package(&source, &output).unwrap();

        assert_eq!(converted_manifest(&output).id, "wrapped-theme");
        let archive = ZipArchive::new(File::open(output).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn converts_root_zip() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dream.zip");
        write_zip(
            &source,
            &[
                ("theme.json", manifest("root-theme")),
                ("background.png", png()),
            ],
        );

        let output = root.path().join("converted.zip");
        convert_to_package(&source, &output).unwrap();

        assert_eq!(converted_manifest(&output).id, "root-theme");
    }

    #[test]
    fn normalizes_invalid_and_builtin_ids_stably() {
        let first = convert_id("My Theme / 中文", "名称");
        let second = convert_id("My Theme / 中文", "名称");
        assert_eq!(first, second);
        assert!(first.starts_with("dream-skin-my-theme-"));
        assert!(valid_id(&first));

        for id in BUILT_IN_IDS {
            let built_in = convert_id(id, "名称");
            assert_ne!(built_in, *id);
            assert!(built_in.starts_with(&format!("dream-skin-{id}-")));
        }
    }

    #[test]
    fn rejects_extra_files_deep_wrappers_and_traversal() {
        let root = tempfile::tempdir().unwrap();
        for (name, entries, expected) in [
            (
                "extra.zip",
                vec![
                    ("theme.json", manifest("valid-theme")),
                    ("background.png", png()),
                    ("theme.css", b"body{}".to_vec()),
                ],
                "只能包含",
            ),
            (
                "deep.zip",
                vec![
                    ("one/two/theme.json", manifest("valid-theme")),
                    ("one/two/background.png", png()),
                ],
                "一层包装目录",
            ),
            (
                "unsafe.zip",
                vec![
                    ("../theme.json", manifest("valid-theme")),
                    ("background.png", png()),
                ],
                "不安全路径",
            ),
            (
                "backslash-unsafe.zip",
                vec![
                    ("..\\theme.json", manifest("valid-theme")),
                    ("..\\background.png", png()),
                ],
                "不安全路径",
            ),
        ] {
            let source = root.path().join(name);
            write_zip(&source, &entries);
            let error = convert_to_package(&source, &root.path().join(format!("{name}.out.zip")))
                .unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn rejects_unknown_schema_and_directory_extras() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dream");
        std::fs::create_dir_all(&source).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&manifest("valid-theme")).unwrap();
        value["schemaVersion"] = 2.into();
        std::fs::write(
            source.join("theme.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        std::fs::write(source.join("background.png"), png()).unwrap();
        let error = convert_to_package(&source, &root.path().join("converted.zip")).unwrap_err();
        assert!(error.contains("schema v2"));

        value["schemaVersion"] = 1.into();
        std::fs::write(
            source.join("theme.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        std::fs::write(source.join("script.js"), b"alert(1)").unwrap();
        let error = convert_to_package(&source, &root.path().join("converted.zip")).unwrap_err();
        assert!(error.contains("额外条目"));
    }

    #[test]
    fn rejects_encrypted_and_symlink_zip_entries() {
        let root = tempfile::tempdir().unwrap();
        let entries = [
            ("theme.json", manifest("valid-theme")),
            ("background.png", png()),
        ];

        let encrypted = root.path().join("encrypted.zip");
        write_zip(&encrypted, &entries);
        patch_first_central_entry(&encrypted, 8, &1_u16.to_le_bytes());
        let error =
            convert_to_package(&encrypted, &root.path().join("encrypted-output.zip")).unwrap_err();
        assert!(error.contains("加密"), "{error}");

        let symlink = root.path().join("symlink.zip");
        write_zip(&symlink, &entries);
        let symlink_mode = (0o120777_u32 << 16).to_le_bytes();
        patch_first_central_entry(&symlink, 38, &symlink_mode);
        let error =
            convert_to_package(&symlink, &root.path().join("symlink-output.zip")).unwrap_err();
        assert!(error.contains("符号链接"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_source() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("dream");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("theme.json"), manifest("valid-theme")).unwrap();
        std::fs::write(source.join("background.png"), png()).unwrap();
        let linked = root.path().join("linked-theme");
        symlink(&source, &linked).unwrap();

        let error = convert_to_package(&linked, &root.path().join("converted.zip")).unwrap_err();
        assert!(error.contains("符号链接"), "{error}");
    }
}
