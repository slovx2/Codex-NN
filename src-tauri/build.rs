use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn main() {
    generate_plugin_assets().expect("无法生成内置插件资源");
    tauri_build::build();
}

struct PluginAssetBundle {
    source_directory: &'static str,
    output_directory: &'static str,
    version_manifest: &'static str,
    asset_manifest: &'static str,
    asset_constant: &'static str,
}

fn generate_plugin_assets() -> io::Result<()> {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").map_err(|error| io::Error::other(error.to_string()))?,
    );
    let output_dir = PathBuf::from(
        std::env::var("OUT_DIR").map_err(|error| io::Error::other(error.to_string()))?,
    );
    let version =
        std::env::var("CARGO_PKG_VERSION").map_err(|error| io::Error::other(error.to_string()))?;
    let bundles = [
        PluginAssetBundle {
            source_directory: "codex-nn-theme-designer",
            output_directory: "theme-designer-plugin",
            version_manifest: ".codex-plugin/plugin.json",
            asset_manifest: "theme_designer_plugin_assets.rs",
            asset_constant: "THEME_DESIGNER_PLUGIN_ASSETS",
        },
        PluginAssetBundle {
            source_directory: "claude-code-theme-designer",
            output_directory: "claude-theme-designer-plugin",
            version_manifest: ".claude-plugin/plugin.json",
            asset_manifest: "claude_theme_designer_plugin_assets.rs",
            asset_constant: "CLAUDE_THEME_DESIGNER_PLUGIN_ASSETS",
        },
    ];

    for bundle in bundles {
        generate_plugin_asset_bundle(&manifest_dir, &output_dir, &version, &bundle)?;
    }
    Ok(())
}

fn generate_plugin_asset_bundle(
    manifest_dir: &Path,
    output_dir: &Path,
    version: &str,
    bundle: &PluginAssetBundle,
) -> io::Result<()> {
    let source_root = manifest_dir
        .join("..")
        .join("plugin")
        .join(bundle.source_directory);
    let output_root = output_dir.join(bundle.output_directory);
    emit_rerun_if_changed(&source_root)?;
    if output_root.exists() {
        fs::remove_dir_all(&output_root)?;
    }
    copy_plugin_assets(
        &source_root,
        &output_root,
        version,
        Path::new(bundle.version_manifest),
    )?;
    generate_asset_manifest(&output_root, output_dir, bundle)
}

fn copy_plugin_assets(
    source_root: &Path,
    output_root: &Path,
    version: &str,
    version_manifest: &Path,
) -> io::Result<()> {
    let mut files = collect_files(source_root)?;
    files.sort();
    for source in files {
        let relative = source
            .strip_prefix(source_root)
            .map_err(|error| io::Error::other(error.to_string()))?;
        let destination = output_root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        if relative == version_manifest {
            let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&source)?)?;
            manifest["version"] = serde_json::Value::String(version.to_string());
            let mut content = serde_json::to_vec_pretty(&manifest)?;
            content.push(b'\n');
            fs::write(destination, content)?;
        } else {
            fs::copy(source, destination)?;
        }
    }
    Ok(())
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_into(root, &mut files)?;
    Ok(files)
}

fn collect_files_into(path: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    let mut entries = fs::read_dir(path)?
        .map(|entry| entry.map(|item| item.path()))
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort();
    for entry in entries {
        collect_files_into(&entry, files)?;
    }
    Ok(())
}

fn generate_asset_manifest(
    output_root: &Path,
    output_dir: &Path,
    bundle: &PluginAssetBundle,
) -> io::Result<()> {
    let mut files = collect_files(output_root)?;
    files.sort();
    let mut source = format!("const {}: &[(&str, &[u8])] = &[\n", bundle.asset_constant);
    for path in files {
        let relative = path
            .strip_prefix(output_root)
            .map_err(|error| io::Error::other(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        source.push_str(&format!(
            "    ({relative:?}, include_bytes!(concat!(env!(\"OUT_DIR\"), \"/{}/{relative}\"))),\n",
            bundle.output_directory
        ));
    }
    source.push_str("];\n");
    let manifest_path = output_dir.join(bundle.asset_manifest);
    fs::write(manifest_path, source)
}

fn emit_rerun_if_changed(path: &Path) -> io::Result<()> {
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            emit_rerun_if_changed(&entry?.path())?;
        }
    }
    Ok(())
}
