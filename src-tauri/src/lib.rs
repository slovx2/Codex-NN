mod agent_api;
mod app_icon;
mod cdp;
mod cdp_session;
mod claude_theme_designer_plugin;
mod codex;
mod dream_skin;
mod locale;
mod marketplace;
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

use locale::{LanguageManager, LanguagePreference, LanguageSettings};
use marketplace::{
    MarketplaceAuthState, MarketplaceClient, MarketplaceLikeResult, MarketplaceListingInput,
    MarketplaceLocalSyncState, MarketplaceLoginResult, MarketplacePage, MarketplaceShareCode,
    MarketplaceThemeDetail, MarketplaceUploadOutcome, MarketplaceUploadPreparation,
    MarketplaceUploadRecord, MarketplaceUser, UploadSource,
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
    locale::result(runtime.snapshot().await)
}

#[tauri::command]
async fn list_themes(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<Vec<ThemeSummary>, String> {
    locale::result(runtime.list_themes().await)
}

#[tauri::command]
async fn install_theme_package(
    runtime: State<'_, Arc<ThemeRuntime>>,
    request: ThemeInstallRequest,
) -> Result<ThemeInstallOutcome, String> {
    locale::result(runtime.install_theme(request).await)
}

#[tauri::command]
async fn install_dream_skin_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    request: dream_skin::DreamSkinImportRequest,
) -> Result<ThemeInstallOutcome, String> {
    locale::result(runtime.install_dream_skin_theme(request).await)
}

#[tauri::command]
async fn delete_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    id: String,
) -> Result<AppSnapshot, String> {
    locale::result(runtime.delete_theme(id).await)
}

#[tauri::command]
async fn activate_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    id: String,
) -> Result<AppSnapshot, String> {
    locale::result(runtime.activate_theme(id).await)
}

#[tauri::command]
async fn apply_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    locale::result(runtime.apply_theme().await)
}

#[tauri::command]
async fn launch_codex(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    locale::result(runtime.launch_codex().await)
}

#[tauri::command]
async fn pause_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    locale::result(runtime.pause_theme().await)
}

#[tauri::command]
async fn restore_theme(runtime: State<'_, Arc<ThemeRuntime>>) -> Result<AppSnapshot, String> {
    locale::result(runtime.restore_theme().await)
}

#[tauri::command]
async fn verify_theme(
    runtime: State<'_, Arc<ThemeRuntime>>,
    screenshot_path: Option<String>,
) -> Result<VerificationReport, String> {
    locale::result(runtime.verify_theme(screenshot_path).await)
}

#[tauri::command]
async fn run_diagnostics(
    runtime: State<'_, Arc<ThemeRuntime>>,
) -> Result<DiagnosticReport, String> {
    Ok(runtime.diagnostics().await)
}

#[tauri::command]
async fn sync_language(
    app: AppHandle,
    language: State<'_, Arc<LanguageManager>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
    system_locale: String,
) -> Result<LanguageSettings, String> {
    let before = locale::current();
    let settings = language.sync(&system_locale)?;
    let refresh = if before != settings.resolved_language {
        refresh_localized_surfaces(&app, runtime.inner().clone()).await
    } else {
        update_window_title(&app);
        update_tray(&app).map_err(|error| error.to_string())
    };
    if let Err(error) = refresh {
        report_language_refresh_error(&app, error);
    }
    Ok(settings)
}

#[tauri::command]
async fn set_language_preference(
    app: AppHandle,
    language: State<'_, Arc<LanguageManager>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
    preference: LanguagePreference,
    system_locale: String,
) -> Result<LanguageSettings, String> {
    let settings = language.set_preference(preference, &system_locale)?;
    if let Err(error) = refresh_localized_surfaces(&app, runtime.inner().clone()).await {
        report_language_refresh_error(&app, error);
    }
    Ok(settings)
}

#[tauri::command]
async fn marketplace_list_themes(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    query: String,
    page: i32,
) -> Result<MarketplacePage, String> {
    locale::result(marketplace.list_themes(query, page).await)
}

#[tauri::command]
async fn marketplace_get_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
) -> Result<MarketplaceThemeDetail, String> {
    locale::result(marketplace.get_theme(&theme_id).await)
}

#[tauri::command]
async fn marketplace_auth_state(
    marketplace: State<'_, Arc<MarketplaceClient>>,
) -> Result<MarketplaceAuthState, String> {
    Ok(marketplace.auth_state().await)
}

#[tauri::command]
async fn marketplace_start_login(
    marketplace: State<'_, Arc<MarketplaceClient>>,
) -> Result<MarketplaceLoginResult, String> {
    locale::result(marketplace.start_login().await)
}

#[tauri::command]
async fn marketplace_logout(
    marketplace: State<'_, Arc<MarketplaceClient>>,
) -> Result<MarketplaceAuthState, String> {
    locale::result(marketplace.logout().await)
}

#[tauri::command]
async fn marketplace_update_profile(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    public_name: String,
) -> Result<MarketplaceUser, String> {
    locale::result(marketplace.update_profile(public_name).await)
}

#[tauri::command]
async fn marketplace_list_my_uploads(
    marketplace: State<'_, Arc<MarketplaceClient>>,
) -> Result<Vec<MarketplaceUploadRecord>, String> {
    locale::result(marketplace.list_my_uploads().await)
}

#[tauri::command]
async fn marketplace_local_sync_states(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
) -> Result<Vec<MarketplaceLocalSyncState>, String> {
    locale::result(marketplace.local_sync_states(runtime.inner().clone()).await)
}

#[tauri::command]
async fn marketplace_prepare_upload(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
    source: UploadSource,
) -> Result<MarketplaceUploadPreparation, String> {
    locale::result(
        marketplace
            .prepare_upload(source, runtime.inner().clone())
            .await,
    )
}

#[tauri::command]
async fn marketplace_upload_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
    source: UploadSource,
    listing: MarketplaceListingInput,
    allow_update: bool,
) -> Result<MarketplaceUploadOutcome, String> {
    locale::result(
        marketplace
            .upload_theme(source, listing, allow_update, runtime.inner().clone())
            .await,
    )
}

#[tauri::command]
async fn marketplace_install_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    runtime: State<'_, Arc<ThemeRuntime>>,
    theme_id: String,
    allow_update: bool,
) -> Result<ThemeInstallOutcome, String> {
    locale::result(
        marketplace
            .install_theme(&theme_id, allow_update, runtime.inner().clone())
            .await,
    )
}

#[tauri::command]
async fn marketplace_save_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
    destination: String,
) -> Result<(), String> {
    locale::result(marketplace.save_theme(&theme_id, &destination).await)
}

#[tauri::command]
async fn marketplace_withdraw_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
) -> Result<(), String> {
    locale::result(marketplace.withdraw_theme(&theme_id).await)
}

#[tauri::command]
async fn marketplace_restore_theme(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
) -> Result<(), String> {
    locale::result(marketplace.restore_theme(&theme_id).await)
}

#[tauri::command]
async fn marketplace_set_like(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
    liked: bool,
) -> Result<MarketplaceLikeResult, String> {
    locale::result(marketplace.set_like(&theme_id, liked).await)
}

#[tauri::command]
async fn marketplace_create_share_code(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
) -> Result<MarketplaceShareCode, String> {
    locale::result(marketplace.create_share_code(&theme_id).await)
}

#[tauri::command]
async fn marketplace_list_share_codes(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    theme_id: String,
) -> Result<Vec<MarketplaceShareCode>, String> {
    locale::result(marketplace.list_share_codes(&theme_id).await)
}

#[tauri::command]
async fn marketplace_redeem_share_code(
    marketplace: State<'_, Arc<MarketplaceClient>>,
    code: String,
) -> Result<String, String> {
    locale::result(marketplace.redeem_share_code(code).await)
}

#[tauri::command]
fn set_app_accent(app: AppHandle, accent: String) -> Result<(), String> {
    locale::result(app_icon::set_accent(&app, &accent))
}

#[tauri::command]
fn get_theme_designer_plugin_status(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::inspect(&app)
        .map(localize_plugin_status)
        .map_err(locale::translate_error)
}

#[tauri::command]
fn install_theme_designer_plugin(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::install(&app)
        .map(localize_plugin_status)
        .map_err(locale::translate_error)
}

#[tauri::command]
fn uninstall_theme_designer_plugin(
    app: AppHandle,
) -> Result<theme_designer_plugin::ThemeDesignerPluginStatus, String> {
    theme_designer_plugin::uninstall(&app)
        .map(localize_plugin_status)
        .map_err(locale::translate_error)
}

fn localize_plugin_status(
    mut status: theme_designer_plugin::ThemeDesignerPluginStatus,
) -> theme_designer_plugin::ThemeDesignerPluginStatus {
    status.message = status.message.map(locale::translate_error);
    status
}

fn tray_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    MenuBuilder::new(app)
        .text(
            MENU_SHOW,
            locale::select("显示 Codex 暖暖", "Show Codex NN"),
        )
        .separator()
        .text(
            MENU_APPLY,
            locale::select("应用当前主题", "Apply current theme"),
        )
        .text(
            MENU_LAUNCH,
            locale::select("启动/重启 Codex", "Launch/restart Codex"),
        )
        .text(MENU_PAUSE, locale::select("暂停主题", "Pause theme"))
        .text(
            MENU_RESTORE,
            locale::select("完全恢复...", "Restore completely..."),
        )
        .separator()
        .text(MENU_QUIT, locale::select("退出", "Quit"))
        .build()
}

#[tauri::command]
fn get_claude_theme_designer_plugin_status(
    app: AppHandle,
) -> Result<claude_theme_designer_plugin::ClaudeThemeDesignerPluginStatus, String> {
    claude_theme_designer_plugin::inspect(&app)
}

#[tauri::command]
fn install_claude_theme_designer_plugin(
    app: AppHandle,
) -> Result<claude_theme_designer_plugin::ClaudeThemeDesignerPluginStatus, String> {
    claude_theme_designer_plugin::install(&app)
}

#[tauri::command]
fn uninstall_claude_theme_designer_plugin(
    app: AppHandle,
) -> Result<claude_theme_designer_plugin::ClaudeThemeDesignerPluginStatus, String> {
    claude_theme_designer_plugin::uninstall(&app)
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let runtime = app.state::<Arc<ThemeRuntime>>().inner().clone();
    let lifecycle = app.state::<Arc<Lifecycle>>().inner().clone();
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(locale::select("Codex 暖暖", "Codex NN"))
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_SHOW => show_main(app),
            MENU_APPLY => {
                let app = app.clone();
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.apply_theme().await {
                        show_main(&app);
                        let _ = app.emit("theme://operation-error", locale::translate_error(error));
                    }
                });
            }
            MENU_LAUNCH => {
                let app = app.clone();
                let runtime = runtime.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = runtime.launch_codex().await {
                        show_main(&app);
                        let _ = app.emit("theme://operation-error", locale::translate_error(error));
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

fn update_tray(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(tray_menu(app)?))?;
        tray.set_tooltip(Some(locale::select("Codex 暖暖", "Codex NN")))?;
    }
    Ok(())
}

fn update_window_title(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_title(locale::select("Codex 暖暖", "Codex NN"));
    }
}

async fn refresh_localized_surfaces(
    app: &AppHandle,
    runtime: Arc<ThemeRuntime>,
) -> Result<(), String> {
    update_window_title(app);
    let mut errors = Vec::new();
    if let Err(error) = update_tray(app) {
        errors.push(error.to_string());
    }
    if let Err(error) = locale::result(runtime.refresh_language().await) {
        errors.push(error);
    }
    if let Err(error) =
        theme_designer_plugin::refresh_managed_language(app).map_err(locale::translate_error)
    {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

fn report_language_refresh_error(app: &AppHandle, error: String) {
    eprintln!("[codex-nn] 刷新本地化界面失败：{error}");
    let _ = app.emit("theme://operation-error", error);
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(Lifecycle::default()))
        .setup(|app| {
            let paths = paths::AppPaths::resolve(app.handle()).map_err(std::io::Error::other)?;
            let language = LanguageManager::load(&paths).map_err(std::io::Error::other)?;
            let runtime = ThemeRuntime::new_with_paths(app.handle().clone(), paths.clone())
                .map_err(std::io::Error::other)?;
            let marketplace = MarketplaceClient::new(app.handle().clone(), &paths)
                .map_err(std::io::Error::other)?;
            let agent_api = agent_api::AgentApiRuntime::start(runtime.clone(), &paths)
                .map_err(locale::translate_error)
                .map_err(std::io::Error::other)?;
            app.manage(runtime);
            app.manage(marketplace);
            app.manage(agent_api);
            app.manage(language);
            if let Err(error) = theme_designer_plugin::update_if_version_changed(app.handle()) {
                eprintln!("[codex-nn] 更新主题设计插件失败：{error}");
            }
            if let Err(error) =
                claude_theme_designer_plugin::update_if_version_changed(app.handle())
            {
                eprintln!("[codex-nn] 更新 Claude Code 主题设计插件失败：{error}");
            }
            setup_tray(app.handle())?;
            update_window_title(app.handle());
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
            sync_language,
            set_language_preference,
            marketplace_list_themes,
            marketplace_get_theme,
            marketplace_auth_state,
            marketplace_start_login,
            marketplace_logout,
            marketplace_update_profile,
            marketplace_list_my_uploads,
            marketplace_local_sync_states,
            marketplace_prepare_upload,
            marketplace_upload_theme,
            marketplace_install_theme,
            marketplace_save_theme,
            marketplace_withdraw_theme,
            marketplace_restore_theme,
            marketplace_set_like,
            marketplace_create_share_code,
            marketplace_list_share_codes,
            marketplace_redeem_share_code,
            set_app_accent,
            get_theme_designer_plugin_status,
            install_theme_designer_plugin,
            uninstall_theme_designer_plugin,
            get_claude_theme_designer_plugin_status,
            install_claude_theme_designer_plugin,
            uninstall_claude_theme_designer_plugin,
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
    locale::initialize_from_env();
    plugin_mcp::run()
}
