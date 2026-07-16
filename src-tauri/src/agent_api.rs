use std::{
    net::TcpListener as StdTcpListener,
    path::Path,
    sync::{Arc, Mutex},
};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::{
    models::{AppSnapshot, DiagnosticReport, ThemeInstallRequest, ThemePackageRequest},
    paths::{atomic_write, AppPaths},
    runtime::ThemeRuntime,
};

pub const AGENT_API_STATE_RELATIVE_PATH: &str = "agent-api/state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentApiStateFile {
    pub schema_version: u8,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub started_at: String,
}

#[derive(Clone)]
struct ApiState {
    runtime: Arc<ThemeRuntime>,
    token: String,
}

pub struct AgentApiRuntime {
    state_path: std::path::PathBuf,
    token: String,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

type ApiError = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, ApiError>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageInput {
    package_path: String,
}

#[derive(Debug, Deserialize)]
struct ThemeIdInput {
    id: String,
}

impl AgentApiRuntime {
    pub fn start(runtime: Arc<ThemeRuntime>, paths: &AppPaths) -> Result<Self, String> {
        let listener = StdTcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("无法启动 Agent API：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("无法配置 Agent API：{error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("无法读取 Agent API 端口：{error}"))?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let state_path = paths.root.join(AGENT_API_STATE_RELATIVE_PATH);
        secure_parent(&state_path)?;
        let state_file = AgentApiStateFile {
            schema_version: 1,
            port,
            token: token.clone(),
            pid: std::process::id(),
            started_at: Utc::now().to_rfc3339(),
        };
        let mut content =
            serde_json::to_vec_pretty(&state_file).map_err(|error| error.to_string())?;
        content.push(b'\n');
        atomic_write(&state_path, &content)?;

        let app = router(ApiState {
            runtime,
            token: token.clone(),
        });
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let failure_state_path = state_path.clone();
        let failure_token = token.clone();
        tauri::async_runtime::spawn(async move {
            let result = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_rx.await;
                    })
                    .await
                    .map_err(|error| error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            if result.is_err() {
                remove_state_if_owned(&failure_state_path, &failure_token);
            }
        });

        Ok(Self {
            state_path,
            token,
            shutdown: Mutex::new(Some(shutdown_tx)),
        })
    }

    pub fn stop(&self) {
        if let Some(sender) = self.shutdown.lock().expect("Agent API 状态损坏").take() {
            let _ = sender.send(());
        }
        remove_state_if_owned(&self.state_path, &self.token);
    }
}

impl Drop for AgentApiRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

fn router(state: ApiState) -> Router {
    Router::new()
        .route("/agent/v1/status", get(status))
        .route("/agent/v1/themes", get(list_themes))
        .route("/agent/v1/themes/package", post(package_theme))
        .route("/agent/v1/themes/install", post(install_theme))
        .route("/agent/v1/themes/update", post(update_theme))
        .route("/agent/v1/themes/activate", post(activate_theme))
        .route("/agent/v1/themes/delete", post(delete_theme))
        .route("/agent/v1/theme/apply", post(apply_theme))
        .route("/agent/v1/codex/launch", post(launch_codex))
        .route("/agent/v1/diagnostics", get(diagnostics))
        .with_state(state)
}

async fn status(State(state): State<ApiState>, headers: HeaderMap) -> ApiResult {
    authorize(&state, &headers)?;
    diagnostic_response(&state).await
}

async fn diagnostics(State(state): State<ApiState>, headers: HeaderMap) -> ApiResult {
    authorize(&state, &headers)?;
    diagnostic_response(&state).await
}

async fn list_themes(State(state): State<ApiState>, headers: HeaderMap) -> ApiResult {
    authorize(&state, &headers)?;
    let themes = state.runtime.list_themes().await.map_err(operation_error)?;
    let snapshot = state.runtime.snapshot().await.map_err(operation_error)?;
    Ok(success(json!({ "themes": themes, "snapshot": snapshot })))
}

async fn package_theme(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<ThemePackageRequest>,
) -> ApiResult {
    authorize(&state, &headers)?;
    state.runtime.record_agent_event(&format!(
        "打包主题目录 {}",
        display_file_name(&input.source_path)
    ));
    let outcome = state
        .runtime
        .package_theme(input)
        .await
        .map_err(operation_error)?;
    Ok(success(json!(outcome)))
}

async fn install_theme(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<PackageInput>,
) -> ApiResult {
    authorize(&state, &headers)?;
    state.runtime.record_agent_event(&format!(
        "安装主题包 {}",
        display_file_name(&input.package_path)
    ));
    let outcome = state
        .runtime
        .install_theme(ThemeInstallRequest {
            package_path: input.package_path,
            allow_update: false,
        })
        .await
        .map_err(operation_error)?;
    Ok(success(json!(outcome)))
}

async fn update_theme(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<PackageInput>,
) -> ApiResult {
    authorize(&state, &headers)?;
    state.runtime.record_agent_event(&format!(
        "更新主题包 {}",
        display_file_name(&input.package_path)
    ));
    let outcome = state
        .runtime
        .install_theme(ThemeInstallRequest {
            package_path: input.package_path,
            allow_update: true,
        })
        .await
        .map_err(operation_error)?;
    Ok(success(json!(outcome)))
}

async fn activate_theme(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<ThemeIdInput>,
) -> ApiResult {
    authorize(&state, &headers)?;
    state
        .runtime
        .record_agent_event(&format!("切换主题 {}", input.id));
    let snapshot = state
        .runtime
        .activate_theme(input.id)
        .await
        .map_err(operation_error)?;
    Ok(snapshot_response(snapshot))
}

async fn delete_theme(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(input): Json<ThemeIdInput>,
) -> ApiResult {
    authorize(&state, &headers)?;
    state
        .runtime
        .record_agent_event(&format!("删除主题 {}", input.id));
    let snapshot = state
        .runtime
        .delete_theme(input.id)
        .await
        .map_err(operation_error)?;
    Ok(snapshot_response(snapshot))
}

async fn apply_theme(State(state): State<ApiState>, headers: HeaderMap) -> ApiResult {
    authorize(&state, &headers)?;
    state.runtime.record_agent_event("应用当前主题");
    let snapshot = state.runtime.apply_theme().await.map_err(operation_error)?;
    Ok(snapshot_response(snapshot))
}

async fn launch_codex(State(state): State<ApiState>, headers: HeaderMap) -> ApiResult {
    authorize(&state, &headers)?;
    state
        .runtime
        .record_agent_event("从 Agent 启动或重启 Codex");
    let snapshot = state
        .runtime
        .launch_codex()
        .await
        .map_err(operation_error)?;
    Ok(snapshot_response(snapshot))
}

async fn diagnostic_response(state: &ApiState) -> ApiResult {
    let snapshot = state.runtime.snapshot().await.map_err(operation_error)?;
    let themes = state.runtime.list_themes().await.map_err(operation_error)?;
    let report = state.runtime.diagnostics().await;
    let recommendations = diagnostic_recommendations(&snapshot, &report);
    Ok(success(json!({
        "snapshot": snapshot,
        "themes": themes,
        "diagnostics": report,
        "logPaths": state.runtime.log_paths(),
        "recommendations": recommendations,
    })))
}

fn snapshot_response(snapshot: AppSnapshot) -> Json<Value> {
    let recommendations = snapshot_recommendations(&snapshot);
    success(json!({
        "snapshot": snapshot,
        "recommendations": recommendations,
    }))
}

fn diagnostic_recommendations(snapshot: &AppSnapshot, report: &DiagnosticReport) -> Vec<String> {
    let mut recommendations = snapshot_recommendations(snapshot);
    if snapshot.session == crate::models::SessionState::Active
        && report
            .checks
            .iter()
            .any(|check| check.name == "实时 CDP" && !check.pass)
    {
        recommendations.push(restart_codex_recommendation());
    }
    recommendations
}

fn snapshot_recommendations(snapshot: &AppSnapshot) -> Vec<String> {
    let mut recommendations = Vec::new();
    if !snapshot.codex.installed {
        recommendations.push("未找到官方 Codex Desktop，请先完成安装。".into());
    } else {
        match snapshot.session {
            crate::models::SessionState::Off => {
                recommendations.push("主题会话尚未启动，请从 Codex NN App 启动 Codex。".into())
            }
            crate::models::SessionState::Starting => {
                recommendations.push("主题会话正在启动，请等待启动完成后重试。".into())
            }
            crate::models::SessionState::Paused => {
                recommendations.push("主题会话已暂停，请从 Codex NN App 启动或重启 Codex。".into())
            }
            crate::models::SessionState::Stale | crate::models::SessionState::Error => {
                recommendations.push(restart_codex_recommendation())
            }
            crate::models::SessionState::Active => {}
        }
    }
    if let Some(error) = &snapshot.last_error {
        recommendations.push(format!("最近错误：{error}"));
    }
    recommendations
}

fn restart_codex_recommendation() -> String {
    "CDP 未连接或端口已失效，请从 Codex NN App 启动或重启 Codex，然后重试。".into()
}

fn authorize(state: &ApiState, headers: &HeaderMap) -> Result<(), ApiError> {
    let expected = format!("Bearer {}", state.token);
    if headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(expected.as_str())
    {
        return Ok(());
    }
    Err(api_error(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "Agent API 令牌无效，请重新安装主题设计插件或重启 Codex NN。",
        None,
    ))
}

fn success(mut data: Value) -> Json<Value> {
    strip_theme_previews(&mut data);
    Json(json!({ "ok": true, "data": data }))
}

fn strip_theme_previews(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("previewDataUrl");
            object.values_mut().for_each(strip_theme_previews);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_theme_previews),
        _ => {}
    }
}

fn operation_error(error: String) -> ApiError {
    let recovery = if error.contains("CDP")
        || error.contains("端口")
        || error.contains("从 Codex NN")
        || error.contains("主题会话")
    {
        Some(restart_codex_recommendation())
    } else {
        None
    };
    api_error(
        StatusCode::CONFLICT,
        "operation_failed",
        &error,
        recovery.as_deref(),
    )
}

fn api_error(status: StatusCode, code: &str, message: &str, recovery: Option<&str>) -> ApiError {
    (
        status,
        Json(json!({
            "ok": false,
            "error": {
                "code": code,
                "message": message,
                "recovery": recovery,
            }
        })),
    )
}

fn display_file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("theme.zip")
        .to_string()
}

fn secure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Agent API 状态路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建 Agent API 目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护 Agent API 目录：{error}"))?;
    }
    Ok(())
}

fn remove_state_if_owned(path: &Path, token: &str) {
    let owned = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AgentApiStateFile>(&bytes).ok())
        .is_some_and(|state| state.token == token && state.pid == std::process::id());
    if owned {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use crate::models::{CodexStatus, DiagnosticCheck, SessionState};

    use super::*;

    fn snapshot(session: SessionState) -> AppSnapshot {
        AppSnapshot {
            session,
            port: Some(9222),
            watcher_running: false,
            codex: CodexStatus {
                installed: true,
                ..Default::default()
            },
            active_theme: None,
            last_error: None,
        }
    }

    #[test]
    fn stale_session_recommends_restarting_from_app() {
        let recommendations = snapshot_recommendations(&snapshot(SessionState::Stale));
        assert_eq!(recommendations.len(), 1);
        assert!(recommendations[0].contains("从 Codex NN App 启动或重启"));
    }

    #[test]
    fn active_session_has_no_recovery_message() {
        assert!(snapshot_recommendations(&snapshot(SessionState::Active)).is_empty());
    }

    #[test]
    fn inactive_sessions_explain_the_next_action() {
        let off = snapshot_recommendations(&snapshot(SessionState::Off));
        assert!(off[0].contains("从 Codex NN App 启动 Codex"));

        let paused = snapshot_recommendations(&snapshot(SessionState::Paused));
        assert!(paused[0].contains("启动或重启"));

        let starting = snapshot_recommendations(&snapshot(SessionState::Starting));
        assert!(starting[0].contains("等待启动完成"));
    }

    #[test]
    fn active_session_with_failed_cdp_recommends_restart() {
        let report = DiagnosticReport {
            pass: false,
            checks: vec![DiagnosticCheck {
                name: "实时 CDP".into(),
                pass: false,
                detail: "未连接".into(),
            }],
        };
        let recommendations = diagnostic_recommendations(&snapshot(SessionState::Active), &report);
        assert_eq!(recommendations.len(), 1);
        assert!(recommendations[0].contains("从 Codex NN App 启动或重启"));
    }

    #[test]
    fn agent_responses_remove_theme_preview_data() {
        let payload = success(json!({
            "themes": [{
                "id": "test-theme",
                "name": "测试主题",
                "previewDataUrl": "data:image/webp;base64,large"
            }],
            "snapshot": {
                "activeTheme": { "previewDataUrl": "data:image/webp;base64,large" }
            }
        }));
        let text = serde_json::to_string(&payload.0).unwrap();
        assert!(!text.contains("previewDataUrl"));
        assert!(!text.contains("base64"));
        assert_eq!(payload.0["data"]["themes"][0]["id"], "test-theme");
    }

    #[test]
    fn cdp_errors_include_recovery_action() {
        let (_, Json(payload)) = operation_error("CDP 端口不可用".into());
        assert!(payload["error"]["recovery"]
            .as_str()
            .unwrap()
            .contains("重启 Codex"));
    }
}
