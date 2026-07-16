use std::{path::PathBuf, sync::Arc, time::Duration};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::{watch, Mutex, RwLock},
    task::JoinHandle,
};

use crate::{
    cdp::{self, ThemePayload},
    codex,
    dream_skin::{self, DreamSkinImportRequest},
    models::{
        AppSnapshot, DiagnosticCheck, DiagnosticReport, PersistedState, ProgressEvent,
        SessionState, ThemeInstallOutcome, ThemeInstallRequest, ThemePackageOutcome,
        ThemePackageRequest, ThemeSummary, VerificationReport,
    },
    paths::{atomic_write, AppPaths},
    theme::{self, ThemeStore},
};

struct WatcherHandle {
    stop: watch::Sender<bool>,
    join: JoinHandle<()>,
}

pub struct ThemeRuntime {
    app: Option<AppHandle>,
    paths: AppPaths,
    themes: ThemeStore,
    operation: Mutex<()>,
    state: RwLock<PersistedState>,
    last_error: RwLock<Option<String>>,
    watcher: Mutex<Option<WatcherHandle>>,
}

impl ThemeRuntime {
    pub fn new(app: AppHandle) -> Result<Arc<Self>, String> {
        let paths = AppPaths::resolve(&app)?;
        Self::from_paths(Some(app), paths)
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(paths: AppPaths) -> Result<Arc<Self>, String> {
        Self::from_paths(None, paths)
    }

    fn from_paths(app: Option<AppHandle>, paths: AppPaths) -> Result<Arc<Self>, String> {
        let themes = ThemeStore::new(paths.clone())?;
        let mut state = read_state(&paths).unwrap_or_default();
        if state.schema_version != 1 {
            state = PersistedState {
                schema_version: 1,
                active_theme_id: Some(themes.default_id().into()),
                ..Default::default()
            };
        }
        if state.active_theme_id.is_none() {
            state.active_theme_id = Some(themes.default_id().into());
        }
        if state
            .active_theme_id
            .as_deref()
            .is_some_and(|id| themes.summary(id, false).is_err())
        {
            state.active_theme_id = Some(themes.default_id().into());
        }
        if state.session == SessionState::Active || state.session == SessionState::Starting {
            state.session = SessionState::Stale;
        }
        let runtime = Arc::new(Self {
            app,
            paths,
            themes,
            operation: Mutex::new(()),
            state: RwLock::new(state),
            last_error: RwLock::new(None),
            watcher: Mutex::new(None),
        });
        runtime.persist_sync()?;
        Ok(runtime)
    }

    pub async fn snapshot(&self) -> Result<AppSnapshot, String> {
        let state = self.state.read().await.clone();
        let watcher_running = self
            .watcher
            .lock()
            .await
            .as_ref()
            .is_some_and(|item| !item.join.is_finished());
        let active_theme = match state.active_theme_id.as_deref() {
            Some(id) => Some(self.themes.summary(id, true)?),
            None => None,
        };
        Ok(AppSnapshot {
            session: state.session,
            port: state.port,
            watcher_running,
            codex: codex::status(),
            active_theme,
            last_error: self.last_error.read().await.clone(),
        })
    }

    pub async fn list_themes(&self) -> Result<Vec<ThemeSummary>, String> {
        let active = self.state.read().await.active_theme_id.clone();
        self.themes.list(active.as_deref())
    }

    pub fn log_paths(&self) -> Vec<String> {
        vec![
            self.paths.logs.display().to_string(),
            self.paths
                .logs
                .with_extension("log.1")
                .display()
                .to_string(),
        ]
    }

    pub fn record_agent_event(&self, message: &str) {
        self.append_log("AGENT", message);
    }

    pub async fn install_theme(
        &self,
        request: ThemeInstallRequest,
    ) -> Result<ThemeInstallOutcome, String> {
        let _operation = self.operation.lock().await;
        let store = self.themes.clone();
        let package = PathBuf::from(request.package_path);
        let mut outcome =
            tokio::task::spawn_blocking(move || store.install(package, request.allow_update))
                .await
                .map_err(|error| format!("主题安装任务异常结束：{error}"))??;
        if !outcome.installed {
            return Ok(outcome);
        }
        let is_active =
            self.state.read().await.active_theme_id.as_deref() == Some(&outcome.theme.id);
        outcome.theme = self.themes.summary(&outcome.theme.id, is_active)?;
        if is_active && self.state.read().await.session == SessionState::Active {
            let port = self
                .state
                .read()
                .await
                .port
                .ok_or_else(|| "当前主题会话缺少端口".to_string())?;
            let payload = self.payload_for(&outcome.theme.id)?;
            self.progress("theme", "正在热更新当前主题");
            cdp::wait_and_apply(port, &payload, Duration::from_secs(10)).await?;
            self.start_watcher(port, payload).await;
        }
        let _ = self.emit_snapshot().await;
        Ok(outcome)
    }

    pub async fn package_theme(
        &self,
        request: ThemePackageRequest,
    ) -> Result<ThemePackageOutcome, String> {
        let source = PathBuf::from(request.source_path);
        let output = PathBuf::from(request.output_path);
        tokio::task::spawn_blocking(move || theme::package_directory(&source, &output))
            .await
            .map_err(|error| format!("主题打包任务异常结束：{error}"))?
    }

    pub async fn install_dream_skin_theme(
        &self,
        request: DreamSkinImportRequest,
    ) -> Result<ThemeInstallOutcome, String> {
        let source = PathBuf::from(request.source_path);
        let temporary = self
            .paths
            .root
            .join(format!(".dream-import-{}.zip", uuid::Uuid::new_v4()));
        let conversion_source = source.clone();
        let conversion_target = temporary.clone();
        let conversion = tokio::task::spawn_blocking(move || {
            dream_skin::convert_to_package(&conversion_source, &conversion_target)
        })
        .await
        .map_err(|error| format!("Dream Skin 转换任务异常结束：{error}"))?;
        if let Err(error) = conversion {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        let outcome = self
            .install_theme(ThemeInstallRequest {
                package_path: temporary.display().to_string(),
                allow_update: request.allow_update,
            })
            .await;
        let _ = std::fs::remove_file(&temporary);
        outcome
    }

    pub async fn delete_theme(&self, id: String) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        let is_active = self.state.read().await.active_theme_id.as_deref() == Some(id.as_str());
        if is_active {
            let default_id = self.themes.default_id().to_string();
            let payload = self.payload_for(&default_id)?;
            let (active, port) = {
                let mut state = self.state.write().await;
                state.active_theme_id = Some(default_id);
                (state.session == SessionState::Active, state.port)
            };
            self.persist().await?;
            if let (true, Some(port)) = (active, port) {
                self.progress("theme", "正在切换到内置主题");
                cdp::wait_and_apply(port, &payload, Duration::from_secs(10)).await?;
                self.start_watcher(port, payload).await;
            }
        }
        let store = self.themes.clone();
        tokio::task::spawn_blocking(move || store.delete(&id))
            .await
            .map_err(|error| format!("主题删除任务异常结束：{error}"))??;
        self.emit_snapshot().await
    }

    pub async fn activate_theme(&self, id: String) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        let payload = self.payload_for(&id)?;
        let (active, port) = {
            let mut state = self.state.write().await;
            state.active_theme_id = Some(id);
            (state.session == SessionState::Active, state.port)
        };
        self.persist().await?;
        if active {
            match port {
                Some(port) if self.owned_endpoint(port).await => {
                    self.progress("theme", "正在热切换主题");
                    cdp::wait_and_apply(port, &payload, Duration::from_secs(10)).await?;
                    self.start_watcher(port, payload).await;
                }
                _ => self.set_session(SessionState::Stale, port).await?,
            }
        }
        self.emit_snapshot().await
    }

    pub async fn apply_theme(&self) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        let installation = codex::discover()?;
        let port = self
            .state
            .read()
            .await
            .port
            .ok_or_else(requires_managed_launch)?;
        if !cdp::endpoint_ready(port).await
            || !codex::listener_belongs_to_codex(port, &installation)
        {
            return Err(requires_managed_launch());
        }
        let active_id = self.active_theme_id().await;
        let payload = self.payload_for(&active_id)?;
        self.progress("theme", "正在应用当前主题");
        cdp::wait_and_apply(port, &payload, Duration::from_secs(15)).await?;
        self.start_watcher(port, payload).await;
        self.set_session(SessionState::Active, Some(port)).await?;
        self.emit_snapshot().await
    }

    pub async fn launch_codex(&self) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        let saved_port = self
            .state
            .read()
            .await
            .port
            .unwrap_or_else(codex::default_port);
        self.set_session(SessionState::Starting, Some(saved_port))
            .await?;
        self.progress("discover", "正在校验官方 Codex");
        let result = self.launch_codex_inner(saved_port).await;
        if let Err(error) = &result {
            self.set_error(error.clone()).await;
        }
        result
    }

    async fn launch_codex_inner(&self, preferred_port: u16) -> Result<AppSnapshot, String> {
        let installation = codex::discover()?;
        let active_id = self.active_theme_id().await;
        let payload = self.payload_for(&active_id)?;
        self.stop_watcher().await;
        if codex::is_running(&installation) {
            self.progress("restart", "正在重启 Codex");
            codex::stop(&installation, true).await?;
        }
        let port = codex::select_available_port(preferred_port)?;
        self.progress("launch", &format!("正在通过回环端口 {port} 启动 Codex"));
        codex::launch(&installation, Some(port))?;
        wait_for_owned_endpoint(port, &installation).await?;
        self.progress("inject", "正在应用当前主题");
        cdp::wait_and_apply(port, &payload, Duration::from_secs(30)).await?;
        self.start_watcher(port, payload).await;
        self.set_session(SessionState::Active, Some(port)).await?;
        self.emit_snapshot().await
    }

    pub async fn pause_theme(&self) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        self.stop_watcher().await;
        let port = self.state.read().await.port;
        if let (Some(port), Ok(installation)) = (port, codex::discover()) {
            if cdp::endpoint_ready(port).await
                && codex::listener_belongs_to_codex(port, &installation)
            {
                self.progress("pause", "正在移除实时主题");
                cdp::remove_all(port).await?;
            }
        }
        self.set_session(SessionState::Paused, port).await?;
        self.emit_snapshot().await
    }

    pub async fn restore_theme(&self) -> Result<AppSnapshot, String> {
        let _operation = self.operation.lock().await;
        self.stop_watcher().await;
        let installation = codex::discover()?;
        if let Some(port) = self.state.read().await.port {
            if cdp::endpoint_ready(port).await
                && codex::listener_belongs_to_codex(port, &installation)
            {
                self.progress("restore", "正在清理 Codex 中的主题");
                cdp::remove_all(port).await?;
            }
        }
        if codex::is_running(&installation) {
            self.progress("restore", "正在关闭调试会话并恢复官方启动方式");
            codex::stop(&installation, true).await?;
            codex::launch(&installation, None)?;
        }
        self.set_session(SessionState::Off, None).await?;
        self.emit_snapshot().await
    }

    pub async fn verify_theme(
        &self,
        screenshot: Option<String>,
    ) -> Result<VerificationReport, String> {
        let state = self.state.read().await.clone();
        let port = state
            .port
            .ok_or_else(|| "当前没有活动的主题端口".to_string())?;
        let installation = codex::discover()?;
        if !codex::listener_belongs_to_codex(port, &installation) {
            return Err("已保存端口不属于当前 Codex 进程".into());
        }
        cdp::verify(port, screenshot.as_deref().map(PathBuf::from).as_deref()).await
    }

    pub async fn diagnostics(&self) -> DiagnosticReport {
        let mut checks = Vec::new();
        let codex = codex::discover();
        checks.push(DiagnosticCheck {
            name: "官方 Codex".into(),
            pass: codex.is_ok(),
            detail: codex
                .as_ref()
                .map(|item| format!("{} · {}", item.version, item.app_path.display()))
                .unwrap_or_else(|error| error.clone()),
        });
        let active = self.active_theme_id().await;
        let theme = self.payload_for(&active);
        checks.push(DiagnosticCheck {
            name: "当前主题".into(),
            pass: theme.is_ok(),
            detail: theme
                .as_ref()
                .map(|item| {
                    format!(
                        "{} · 注入脚本 {} KB",
                        item.theme_id,
                        item.script.len() / 1024
                    )
                })
                .unwrap_or_else(|error| error.clone()),
        });
        let state = self.state.read().await.clone();
        let endpoint = match state.port {
            Some(port) => cdp::endpoint_ready(port).await,
            None => false,
        };
        checks.push(DiagnosticCheck {
            name: "实时 CDP".into(),
            pass: state.session == SessionState::Active && endpoint,
            detail: match (state.session, state.port) {
                (SessionState::Off, _) => "尚未启动".into(),
                (SessionState::Starting, Some(port)) => {
                    format!("127.0.0.1:{port} · 正在启动")
                }
                (SessionState::Starting, None) => "正在启动".into(),
                (SessionState::Paused, Some(port)) => {
                    format!("127.0.0.1:{port} · 会话已暂停")
                }
                (SessionState::Paused, None) => "会话已暂停".into(),
                (_, Some(port)) => format!(
                    "127.0.0.1:{port} · {}",
                    if endpoint { "可用" } else { "未连接" }
                ),
                _ => "未连接".into(),
            },
        });
        DiagnosticReport {
            pass: checks.iter().all(|item| item.pass),
            checks,
        }
    }

    async fn start_watcher(&self, port: u16, payload: ThemePayload) {
        self.stop_watcher().await;
        let (stop, receiver) = watch::channel(false);
        let join = tokio::spawn(cdp::run_watcher(port, payload, receiver));
        *self.watcher.lock().await = Some(WatcherHandle { stop, join });
    }

    async fn stop_watcher(&self) {
        if let Some(handle) = self.watcher.lock().await.take() {
            let _ = handle.stop.send(true);
            let _ = tokio::time::timeout(Duration::from_secs(2), handle.join).await;
        }
    }

    fn payload_for(&self, id: &str) -> Result<ThemePayload, String> {
        let (manifest, image) = self.themes.load(id)?;
        cdp::build_payload(&manifest, &image)
    }

    async fn owned_endpoint(&self, port: u16) -> bool {
        let Ok(installation) = codex::discover() else {
            return false;
        };
        cdp::endpoint_ready(port).await && codex::listener_belongs_to_codex(port, &installation)
    }

    async fn active_theme_id(&self) -> String {
        self.state
            .read()
            .await
            .active_theme_id
            .clone()
            .unwrap_or_else(|| self.themes.default_id().into())
    }

    async fn set_session(&self, session: SessionState, port: Option<u16>) -> Result<(), String> {
        {
            let mut state = self.state.write().await;
            state.session = session;
            state.port = port;
            state.updated_at = Some(Utc::now().to_rfc3339());
        }
        if session != SessionState::Error {
            *self.last_error.write().await = None;
        }
        self.persist().await
    }

    async fn set_error(&self, error: String) {
        self.append_log("ERROR", &error);
        *self.last_error.write().await = Some(error);
        let port = self.state.read().await.port;
        let _ = self.set_session(SessionState::Error, port).await;
        let _ = self.emit_snapshot().await;
    }

    fn progress(&self, phase: &str, message: &str) {
        self.append_log("INFO", &format!("{phase}: {message}"));
        if let Some(app) = &self.app {
            let _ = app.emit(
                "theme://progress",
                ProgressEvent {
                    phase: phase.into(),
                    message: message.into(),
                },
            );
        }
    }

    fn append_log(&self, level: &str, message: &str) {
        use std::io::Write;
        if std::fs::metadata(&self.paths.logs)
            .is_ok_and(|metadata| metadata.len() > 2 * 1024 * 1024)
        {
            let _ = std::fs::rename(&self.paths.logs, self.paths.logs.with_extension("log.1"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.paths.logs)
        {
            let cleaned = message.replace(['\r', '\n'], " ");
            let _ = writeln!(file, "{} {level} {cleaned}", Utc::now().to_rfc3339());
        }
    }

    async fn emit_snapshot(&self) -> Result<AppSnapshot, String> {
        let snapshot = self.snapshot().await?;
        if let Some(app) = &self.app {
            let _ = app.emit("theme://status-changed", &snapshot);
        }
        Ok(snapshot)
    }

    async fn persist(&self) -> Result<(), String> {
        self.persist_sync()
    }
    fn persist_sync(&self) -> Result<(), String> {
        let state = self
            .state
            .try_read()
            .map_err(|_| "状态正在更新，请重试".to_string())?;
        let data = serde_json::to_vec_pretty(&*state).map_err(|error| error.to_string())?;
        atomic_write(&self.paths.state, &[data, b"\n".to_vec()].concat())
    }
}

fn read_state(paths: &AppPaths) -> Option<PersistedState> {
    serde_json::from_slice(&std::fs::read(&paths.state).ok()?).ok()
}

fn requires_managed_launch() -> String {
    "请先从 Codex NN 启动或重启 Codex".into()
}

async fn wait_for_owned_endpoint(
    port: u16,
    installation: &codex::CodexInstallation,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    while tokio::time::Instant::now() < deadline {
        if cdp::endpoint_ready(port).await && codex::listener_belongs_to_codex(port, installation) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    Err(format!(
        "Codex 未能在 45 秒内提供已验证的回环 CDP 端口 {port}"
    ))
}
