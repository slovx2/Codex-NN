mod agent_api;
mod app_icon;
mod cdp;
mod cdp_session;
mod codex;
mod dream_skin;
mod models;
mod paths;
mod plugin_mcp;
mod runtime;
mod theme;
mod theme_designer_plugin;

#[cfg(test)]
mod integration_tests;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use models::{
    AppSnapshot, DiagnosticReport, ThemeInstallOutcome, ThemeInstallRequest, ThemeSummary,
    VerificationReport,
};
use runtime::ThemeRuntime;
use tauri::{
    menu::MenuBuilder, tray::TrayIconBuilder, AppHandle, Emitter, Manager, Runtime, State,
    WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main-tray";
const MENU_SHOW: &str = "show";
const MENU_APPLY: &str = "apply";
const MENU_LAUNCH: &str = "launch";
const MENU_PAUSE: &str = "pause";
const MENU_RESTORE: &str = "restore";
const MENU_QUIT: &str = "quit";

#[derive(Default)]
struct Lifecycle {
    should_exit: AtomicBool,
}

#[tauri::command]
async fn get_app_snapshot(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    runtime.snapshot().await
}

#[tauri::command]
async fn list_themes(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<Vec<ThemeSummary>, String> {
    runtime.list_themes().await
}

#[tauri::command]
async fn install_theme_package(
    runtime: State<'_, Arc<ThemeRuntime>>,
    request: ThemeInstallRequest,
) -> Result<ThemeInstallOutcome, String> {
    runtime.install_theme(request).await
}

#[tauri::command]
async fn install_dream_skin_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    request: dream_skin::DreamSkinImportRequest,
) -> Result<ThemeInstallOutcome, String> {
    runtime.install_dream_skin_theme(request).await
}

#[tauri::command]
async fn delete_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    id: String,
) -> Result<AppSnapshot, String> {
    runtime.delete_theme(id).await
}

#[tauri::command]
async fn activate_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    id: String,
) -> Result<AppSnapshot, String> {
    runtime.activate_theme(id).await
}

#[tauri::command]
async fn apply_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    runtime.apply_theme().await
}

#[tauri::command]
async fn launch_codex(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    runtime.launch_codex().await
}

#[tauri::command]
async fn pause_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    runtime.pause_theme().await
}

#[tauri::command]
async fn restore_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    runtime.restore_theme().await
}

#[tauri::command]
async fn verify_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    screenshot_path: Option<String>,
) -> Result<VerificationReport, String> {
    runtime.verify_theme(screenshot_path).await
}

#[tauri::command]
async fn run_diagnostics(
    runtime: State<'_, Arc<ThemeRuntime>>,
) -> Result<DiagnosticReport, String> {
    Ok(runtime.diagnostics().await)
}

#[tauri::command]
fn set_app_accent(app: AppHandle, accent: String) -> Result<(), String> {
    app_icon::set_accent(&app, &accent)
}

#[tauri::command]
fn get_theme_designer_plugin_status(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::inspect(&app)
}

#[tauri::command]
fn install_theme_designer_plugin(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::install(&app)
}

#[tauri::command]
fn uninstall_theme_designer_plugin(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::uninstall(&app)
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(MENU_SHOW, "显示 Codex 暖暖")
        .separator()
        .text(MENU_APPLY, "应用当前主题")
        .text(MENU_LAUNCH, "启动/重启 Codex")
        .text(MENU_PAUSE, "暂停主题")
        .text(MENU_RESTORE, "完全恢复…")
        .separator()
        .text(MENU_QUIT, "退出")
        .build()?;
    let runtime = app.state::<Arc<ThemeRuntime>>().inner().clone();
    let lifecycle = app.state::<Arc<Lifecycle>>().inner().clone();
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Codex 暖暖")
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_SHOW => show_main(app),
            MENU_APPLY => {
                let app = app.clone();
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.apply_theme().await {
                        show_main(&app);
                        let _ = app.emit("theme://operation-error", error);
                    }
                });
            }
            MENU_LAUNCH => {
                let app = app.clone();
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.launch_codex().await {
                        show_main(&app);
                        let _ = app.emit("theme://operation-error", error);
                    }
                });
            }
            MENU_PAUSE => {
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.pause_theme().await;
                });
            }
            MENU_RESTORE => {
                show_main(app);
                let _ = app.emit("theme://request-restore", ());
            }
            MENU_QUIT => {
                lifecycle.should_exit.store(true, Ordering::SeqCst);
                let app = app.clone();
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.pause_theme().await;
                    stop_agent_api(&app);
                    app.exit(0);
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    set_dock_visibility(app, true);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.hide();
    }
    set_dock_visibility(app, false);
}

fn stop_agent_api<R: Runtime>(app: &AppHandle<R>) {
    if let Some(runtime) = app.try_state::<agent_api::AgentApiRuntime>() {
        runtime.stop();
    }
}

#[cfg(target_os = "macos")]
fn set_dock_visibility<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let _ = app.set_dock_visibility(visible);
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visibility<R: Runtime>(_app: &AppHandle<R>, _visible: bool) {}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(Lifecycle::default()))
        .setup(|app| {
            let runtime = ThemeRuntime::new(app.handle().clone()).map_err(std::io::Error::other)?;
            let paths = paths::AppPaths::resolve(app.handle()).map_err(std::io::Error::other)?;
            let agent_api = agent_api::AgentApiRuntime::start(runtime.clone(), &paths)
                .map_err(std::io::Error::other)?;
            app.manage(runtime);
            app.manage(agent_api);
            if let Err(error) = theme_designer_plugin::update_if_version_changed(app.handle()) {
                eprintln!("[codex-nn] 更新主题设计插件失败：{error}");
            }
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_snapshot,
            list_themes,
            install_theme_package,
            install_dream_skin_theme,
            delete_theme,
            activate_theme,
            apply_theme,
            launch_codex,
            pause_theme,
            restore_theme,
            verify_theme,
            run_diagnostics,
            set_app_accent,
            get_theme_designer_plugin_status,
            install_theme_designer_plugin,
            uninstall_theme_designer_plugin,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let lifecycle = window.app_handle().state::<Arc<Lifecycle>>();
                if !lifecycle.should_exit.load(Ordering::SeqCst) {
                    api.prevent_close();
                    hide_main(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Codex NN 构建失败");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            let lifecycle = app.state::<Arc<Lifecycle>>();
            if !lifecycle.should_exit.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                let runtime = app.state::<Arc<ThemeRuntime>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = runtime.pause_theme().await;
                    stop_agent_api(&app);
                    app.exit(0);
                });
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show_main(app),
        _ => {}
    });
}

pub fn run_mcp() -> i32 {
    plugin_mcp::run()
}
