use std::{fs::File, io::Write, path::Path};

use image::ImageEncoder;
use serde_json::json;
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    dream_skin::DreamSkinImportRequest,
    models::{SessionState, ThemeInstallRequest, ThemeManifest},
    paths::AppPaths,
    runtime::ThemeRuntime,
};

fn test_runtime() -> (TempDir, AppPaths, std::sync::Arc<ThemeRuntime>) {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(root.path().join("app-data")).unwrap();
    let runtime = ThemeRuntime::new_for_test(paths.clone()).unwrap();
    (root, paths, runtime)
}

fn manifest(id: &str, name: &str) -> ThemeManifest {
    let mut manifest: ThemeManifest = serde_json::from_str(include_str!(
        "../../theme-packs/strawberry-starlight/theme.json"
    ))
    .unwrap();
    manifest.id = id.into();
    manifest.name = name.into();
    manifest.layout_preset = "standard".into();
    manifest.image = "background.png".into();
    manifest
}

fn png() -> Vec<u8> {
    let pixels = vec![128_u8; 64 * 48 * 3];
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&pixels, 64, 48, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

fn package(path: &Path, manifest: &ThemeManifest) {
    let file = File::create(path).unwrap();
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("theme.json", options).unwrap();
    writer
        .write_all(&serde_json::to_vec_pretty(manifest).unwrap())
        .unwrap();
    writer.start_file(&manifest.image, options).unwrap();
    writer.write_all(&png()).unwrap();
    writer.finish().unwrap();
}

#[tokio::test]
async fn theme_runtime_runs_the_complete_local_lifecycle() {
    let (root, paths, runtime) = test_runtime();
    assert_eq!(runtime.list_themes().await.unwrap().len(), 2);

    let first = root.path().join("first.zip");
    package(&first, &manifest("runtime-theme", "运行时主题"));
    let installed = runtime
        .install_theme(ThemeInstallRequest {
            package_path: first.display().to_string(),
            allow_update: false,
        })
        .await
        .unwrap();
    assert!(installed.installed);
    assert!(!installed.updated);

    let activated = runtime
        .activate_theme("runtime-theme".into())
        .await
        .unwrap();
    assert_eq!(activated.active_theme.unwrap().id, "runtime-theme");
    assert_eq!(activated.session, SessionState::Off);

    let second = root.path().join("second.zip");
    package(&second, &manifest("runtime-theme", "更新后的运行时主题"));
    let pending = runtime
        .install_theme(ThemeInstallRequest {
            package_path: second.display().to_string(),
            allow_update: false,
        })
        .await
        .unwrap();
    assert!(pending.needs_confirmation);
    let updated = runtime
        .install_theme(ThemeInstallRequest {
            package_path: second.display().to_string(),
            allow_update: true,
        })
        .await
        .unwrap();
    assert!(updated.updated);
    assert_eq!(updated.theme.name, "更新后的运行时主题");

    let paused = runtime.pause_theme().await.unwrap();
    assert_eq!(paused.session, SessionState::Paused);
    assert!(runtime
        .verify_theme(None)
        .await
        .unwrap_err()
        .contains("主题端口"));

    let deleted = runtime.delete_theme("runtime-theme".into()).await.unwrap();
    assert_eq!(deleted.active_theme.unwrap().id, "strawberry-starlight");
    assert_eq!(runtime.list_themes().await.unwrap().len(), 2);
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(paths.state).unwrap()).unwrap();
    assert_eq!(state["activeThemeId"], "strawberry-starlight");
}

#[tokio::test]
async fn runtime_imports_dream_skin_and_cleans_conversion_artifacts() {
    let (root, paths, runtime) = test_runtime();
    let source = root.path().join("dream-source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("background.png"), png()).unwrap();
    std::fs::write(
        source.join("theme.json"),
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "id": "Dream Theme 中文",
            "name": "Dream 导入",
            "image": "background.png",
            "promoTitle": "应被忽略"
        }))
        .unwrap(),
    )
    .unwrap();

    let outcome = runtime
        .install_dream_skin_theme(DreamSkinImportRequest {
            source_path: source.display().to_string(),
            allow_update: false,
        })
        .await
        .unwrap();
    assert!(outcome.installed);
    assert!(outcome.theme.id.starts_with("dream-skin-"));
    assert!(runtime
        .list_themes()
        .await
        .unwrap()
        .iter()
        .any(|theme| theme.id == outcome.theme.id));
    assert!(!std::fs::read_dir(paths.root).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".dream-import-")
    }));
}

#[tokio::test]
async fn runtime_repairs_invalid_persisted_state_and_reports_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let paths = AppPaths::from_root(root.path().join("app-data")).unwrap();
    std::fs::write(
        &paths.state,
        br#"{"schemaVersion":1,"session":"active","port":9341,"activeThemeId":"missing"}"#,
    )
    .unwrap();

    let runtime = ThemeRuntime::new_for_test(paths).unwrap();
    let snapshot = runtime.snapshot().await.unwrap();
    assert_eq!(snapshot.session, SessionState::Stale);
    assert_eq!(snapshot.active_theme.unwrap().id, "strawberry-starlight");

    let report = runtime.diagnostics().await;
    assert_eq!(report.checks.len(), 3);
    assert!(report
        .checks
        .iter()
        .any(|check| check.name == "当前主题" && check.pass));
    assert!(report.checks.iter().any(|check| check.name == "实时 CDP"));
}
