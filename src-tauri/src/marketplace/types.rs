use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum UploadSource {
    Package { path: String },
    Installed { theme_id: String },
}

#[derive(Debug, Deserialize)]
pub(super) struct ApiEnvelope<T> {
    pub code: i32,
    pub message: String,
    #[serde(default)]
    pub reason: String,
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct MarketplaceUser {
    pub id: String,
    pub public_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct MarketplaceThemeCard {
    pub theme_id: String,
    pub version_id: String,
    pub manifest_id: String,
    pub name: String,
    pub tagline: String,
    pub author_name: String,
    pub version_number: i32,
    pub download_count: i64,
    pub card_preview_url: String,
    pub published_at: String,
    #[serde(default)]
    pub preview_data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct MarketplaceThemeDetail {
    #[serde(flatten)]
    pub card: MarketplaceThemeCard,
    pub quote: String,
    pub manifest: serde_json::Value,
    pub detail_preview_url: String,
    pub package_size: i64,
    pub package_sha256: String,
    #[serde(default)]
    pub detail_preview_data_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct MarketplacePage {
    pub items: Vec<MarketplaceThemeCard>,
    pub total: i64,
    pub page: i32,
    pub page_size: i32,
    pub pages: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct MarketplaceUploadRecord {
    pub theme_id: String,
    pub version_id: String,
    pub manifest_id: String,
    pub version_number: i32,
    pub status: String,
    pub name: String,
    pub tagline: String,
    pub package_sha256: String,
    pub package_size: i64,
    pub created_at: String,
    pub reviewed_at: Option<String>,
    pub upload_targets: Option<UploadTargets>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceUploadOutcome {
    pub uploaded: bool,
    pub needs_confirmation: bool,
    pub is_update: bool,
    pub name: String,
    pub previous_version_number: Option<i32>,
    pub record: Option<MarketplaceUploadRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct UploadTarget {
    pub url: String,
    pub method: String,
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct UploadTargets {
    pub package: UploadTarget,
    pub card_preview: UploadTarget,
    pub detail_preview: UploadTarget,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) struct TokenPair {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub user: MarketplaceUser,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAuthState {
    pub logged_in: bool,
    pub pending: bool,
    pub user: Option<MarketplaceUser>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLoginResult {
    pub status: String,
    pub auth: MarketplaceAuthState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) struct MineResponse {
    pub items: Vec<MarketplaceUploadRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) struct DownloadInfo {
    pub url: String,
    pub version_id: String,
    pub version_number: i32,
    pub manifest_id: String,
    pub sha256: String,
    pub size: i64,
}
