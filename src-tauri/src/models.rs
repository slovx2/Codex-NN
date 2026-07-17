use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    #[default]
    Off,
    Starting,
    Active,
    Paused,
    Stale,
    Error,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeColors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent_alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

impl ThemeColors {
    pub fn is_empty(&self) -> bool {
        self.background.is_none()
            && self.panel.is_none()
            && self.panel_alt.is_none()
            && self.accent.is_none()
            && self.accent_alt.is_none()
            && self.secondary.is_none()
            && self.highlight.is_none()
            && self.text.is_none()
            && self.muted.is_none()
            && self.line.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeArt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safe_area: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_mode: Option<String>,
}

impl ThemeArt {
    pub fn is_empty(&self) -> bool {
        self.focus_x.is_none()
            && self.focus_y.is_none()
            && self.safe_area.is_none()
            && self.task_mode.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeManifest {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    #[serde(default = "default_layout_preset")]
    pub layout_preset: String,
    pub brand_subtitle: String,
    pub tagline: String,
    pub project_prefix: String,
    pub project_label: String,
    pub status_text: String,
    pub quote: String,
    pub image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<String>,
    #[serde(default, skip_serializing_if = "ThemeArt::is_empty")]
    pub art: ThemeArt,
    #[serde(default, skip_serializing_if = "ThemeColors::is_empty")]
    pub colors: ThemeColors,
}

fn default_layout_preset() -> String {
    "standard".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSummary {
    pub id: String,
    pub name: String,
    pub tagline: String,
    pub quote: String,
    pub accent: String,
    pub preview_data_url: String,
    pub active: bool,
    pub built_in: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInstallRequest {
    pub package_path: String,
    #[serde(default)]
    pub allow_update: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInstallOutcome {
    pub installed: bool,
    pub updated: bool,
    pub needs_confirmation: bool,
    pub theme: ThemeSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePackageRequest {
    pub source_path: String,
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemePackageOutcome {
    pub package_path: String,
    pub theme_id: String,
    pub theme_name: String,
    pub package_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub session: SessionState,
    pub port: Option<u16>,
    pub watcher_running: bool,
    pub codex: CodexStatus,
    pub active_theme: Option<ThemeSummary>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub pass: bool,
    pub port: Option<u16>,
    pub target_count: usize,
    pub screenshot_path: Option<String>,
    pub details: serde_json::Value,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub pass: bool,
    pub checks: Vec<DiagnosticCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub name: String,
    pub pass: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub schema_version: u8,
    pub session: SessionState,
    pub port: Option<u16>,
    pub active_theme_id: Option<String>,
    pub updated_at: Option<String>,
}
