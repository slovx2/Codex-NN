use std::{fs::File, io::Write, path::Path, time::Duration};

use image::ImageEncoder;
use reqwest::{Client, Method, StatusCode};
use serde_json::json;
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::{
    agent_api::{AgentApiRuntime, AgentApiStateFile, AGENT_API_STATE_RELATIVE_PATH},
    dream_skin::DreamSkinImportRequest,
    models::{SessionState, ThemeInstallRequest, ThemeManifest},
    paths::AppPaths,
    runtime::ThemeRuntime,
};

async fn wait_for_agent_api(client: &Client, state: &AgentApiStateFile) {
    let url = format!("http://127.0.0.1:{}/agent/v1/status", state.port);
    for _ in 0..50 {
        if client
            .get(&url)
            .bearer_auth(&state.token)
            .send()
            .await
            .is_ok()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("Agent API 未在预期时间内启动");
}

async fn agent_request(
    client: &Client,
    state: &AgentApiStateFile,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> reqwest::Response {
    let url = format!("http://127.0.0.1:{}{path}", state.port);
    let mut request = client.request(method, url).bearer_auth(&state.token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    request.send().await.unwrap()
}

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

fn theme_directory(path: &Path, manifest: &ThemeManifest) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(
        path.join("theme.json"),
        serde_json::to_vec_pretty(manifest).unwrap(),
    )
    .unwrap();
    std::fs::write(path.join(&manifest.image), png()).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_api_enforces_auth_and_runs_theme_lifecycle() {
    let (root, paths, runtime) = test_runtime();
    let api = AgentApiRuntime::start(runtime, &paths).unwrap();
    let state_path = paths.root.join(AGENT_API_STATE_RELATIVE_PATH);
    let state: AgentApiStateFile =
        serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
    let client = Client::new();
    wait_for_agent_api(&client, &state).await;

    assert_ne!(state.port, 0);
    assert_eq!(state.token.len(), 32);
    assert_eq!(state.pid, std::process::id());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&state_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let unauthorized = client
        .get(format!(
            "http://127.0.0.1:{}/agent/v1/diagnostics",
            state.port
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        unauthorized.json::<serde_json::Value>().await.unwrap()["error"]["code"],
        "unauthorized"
    );

    let status = agent_request(&client, &state, Method::GET, "/agent/v1/status", None).await;
    assert_eq!(status.status(), StatusCode::OK);

    let diagnostics =
        agent_request(&client, &state, Method::GET, "/agent/v1/diagnostics", None).await;
    assert_eq!(diagnostics.status(), StatusCode::OK);
    let diagnostics = diagnostics.text().await.unwrap();
    assert!(!diagnostics.contains("previewDataUrl"));
    assert!(!diagnostics.contains("base64"));
    let diagnostics: serde_json::Value = serde_json::from_str(&diagnostics).unwrap();
    assert_eq!(diagnostics["data"]["snapshot"]["session"], "off");
    let recommendation = diagnostics["data"]["recommendations"][0].as_str().unwrap();
    if diagnostics["data"]["snapshot"]["codex"]["installed"] == true {
        assert!(recommendation.contains("从 Codex NN App 启动 Codex"));
    } else {
        assert!(recommendation.contains("未找到官方 Codex Desktop"));
    }
    assert_eq!(
        diagnostics["data"]["logPaths"][0],
        paths.logs.display().to_string()
    );

    let source = root.path().join("agent-theme");
    let first = root.path().join("agent-theme.zip");
    theme_directory(&source, &manifest("agent-theme", "Agent 主题"));
    let packaged = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/package",
        Some(json!({
            "sourcePath": source.display().to_string(),
            "outputPath": first.display().to_string(),
        })),
    )
    .await
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(packaged["data"]["themeId"], "agent-theme");
    assert_eq!(
        packaged["data"]["packagePath"],
        std::fs::canonicalize(&first).unwrap().display().to_string()
    );
    let installed = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/install",
        Some(json!({ "packagePath": first.display().to_string() })),
    )
    .await
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(installed["data"]["installed"], true);

    theme_directory(&source, &manifest("agent-theme", "Agent 主题已更新"));
    let packaged = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/package",
        Some(json!({
            "sourcePath": source.display().to_string(),
            "outputPath": first.display().to_string(),
        })),
    )
    .await;
    assert_eq!(packaged.status(), StatusCode::OK);
    let updated = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/update",
        Some(json!({ "packagePath": first.display().to_string() })),
    )
    .await
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(updated["data"]["updated"], true);
    assert_eq!(updated["data"]["theme"]["name"], "Agent 主题已更新");

    let activated = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/activate",
        Some(json!({ "id": "agent-theme" })),
    )
    .await
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(
        activated["data"]["snapshot"]["activeTheme"]["id"],
        "agent-theme"
    );

    let apply_error = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/theme/apply",
        Some(json!({})),
    )
    .await;
    assert_eq!(apply_error.status(), StatusCode::CONFLICT);
    let apply_error = apply_error.json::<serde_json::Value>().await.unwrap();
    let recovery = apply_error["error"]["recovery"]
        .as_str()
        .unwrap_or_default();
    let message = apply_error["error"]["message"].as_str().unwrap_or_default();
    assert!(
        recovery.contains("重启 Codex")
            || message.contains("未找到官方 Codex")
            || message.contains("未安装官方"),
        "未返回可执行的恢复信息：{apply_error}"
    );

    let deleted = agent_request(
        &client,
        &state,
        Method::POST,
        "/agent/v1/themes/delete",
        Some(json!({ "id": "agent-theme" })),
    )
    .await
    .json::<serde_json::Value>()
    .await
    .unwrap();
    assert_eq!(
        deleted["data"]["snapshot"]["activeTheme"]["id"],
        "strawberry-starlight"
    );
    assert!(std::fs::read_to_string(&paths.logs)
        .unwrap()
        .contains(" AGENT 删除主题 agent-theme"));

    api.stop();
    assert!(!state_path.exists());
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
