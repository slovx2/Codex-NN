use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{Query, State},
    http::StatusCode as AxumStatusCode,
    response::Html,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{future::join_all, StreamExt};
use rand::distr::{Alphanumeric, SampleString};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::AsyncWriteExt,
    net::TcpListener,
    sync::{oneshot, Mutex},
};
use url::Url;
use uuid::Uuid;

use crate::{
    models::{ThemeInstallOutcome, ThemeInstallRequest, ThemeManifest},
    paths::{atomic_write, AppPaths},
    runtime::ThemeRuntime,
    theme,
};

use super::{
    grants::GuestGrantStore,
    preview::{self, PreparedUpload},
    sync::{content_sha256, MarketplaceLocalSyncState, ThemeLink, ThemeLinkStore},
    types::{
        ApiEnvelope, DownloadInfo, MarketplaceAuthState, MarketplaceLikeResult,
        MarketplaceListingInput, MarketplaceLoginResult, MarketplacePage, MarketplaceShareCode,
        MarketplaceThemeCard, MarketplaceThemeDetail, MarketplaceUploadOutcome,
        MarketplaceUploadPreparation, MarketplaceUploadRecord, MarketplaceUser, MineResponse,
        ShareCodeList, ShareRedeemResult, TokenPair, UploadSource, UploadTarget,
    },
};

const MAX_PACKAGE_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
struct AuthMemory {
    access_token: Option<String>,
    access_expires_at: Option<Instant>,
    user: Option<MarketplaceUser>,
    pending: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    user: MarketplaceUser,
    updated_at_epoch_seconds: u64,
}

struct DownloadedTheme {
    path: PathBuf,
    info: DownloadInfo,
    local_content_sha256: String,
}

pub struct MarketplaceClient {
    app: AppHandle,
    http: reqwest::Client,
    api_base: String,
    cache_dir: PathBuf,
    temporary_dir: PathBuf,
    refresh_token_path: PathBuf,
    session_path: PathBuf,
    auth: Mutex<AuthMemory>,
    links: Mutex<ThemeLinkStore>,
    grants: Mutex<GuestGrantStore>,
}

impl MarketplaceClient {
    pub fn new(app: AppHandle, paths: &AppPaths) -> Result<Arc<Self>, String> {
        let root = paths.root.join("marketplace");
        let cache_dir = root.join("previews");
        let temporary_dir = root.join("temporary");
        std::fs::create_dir_all(&cache_dir)
            .map_err(|error| format!("无法创建广场预览缓存：{error}"))?;
        std::fs::create_dir_all(&temporary_dir)
            .map_err(|error| format!("无法创建广场临时目录：{error}"))?;
        let api_base = option_env!("CODEX_NN_MARKETPLACE_API_BASE_URL")
            .unwrap_or("https://api.codexnn.com")
            .trim_end_matches('/')
            .to_string();
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .user_agent(concat!("Codex-NN/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("无法创建主题广场网络客户端：{error}"))?;
        let links = ThemeLinkStore::load(root.join("theme-links.json"))?;
        let grants = GuestGrantStore::load(root.join("share-grants.json"))?;
        Ok(Arc::new(Self {
            app,
            http,
            api_base,
            cache_dir,
            temporary_dir,
            refresh_token_path: root.join("marketplace-refresh-token"),
            session_path: root.join("marketplace-session.json"),
            auth: Mutex::new(AuthMemory::default()),
            links: Mutex::new(links),
            grants: Mutex::new(grants),
        }))
    }

    pub async fn list_themes(&self, query: String, page: i32) -> Result<MarketplacePage, String> {
        let request = self
            .viewer_request(Method::GET, "/api/v1/themes", None)
            .await?
            .query(&[("q", query), ("page", page.max(1).to_string())]);
        let mut result: MarketplacePage = self.public_json(request).await?;
        let previews = join_all(result.items.iter().map(|card| self.card_preview(card))).await;
        for (card, preview) in result.items.iter_mut().zip(previews) {
            card.preview_data_url = preview.unwrap_or_default();
        }
        Ok(result)
    }

    pub async fn get_theme(&self, theme_id: &str) -> Result<MarketplaceThemeDetail, String> {
        let request = self
            .viewer_request(
                Method::GET,
                &format!("/api/v1/themes/{theme_id}"),
                Some(theme_id),
            )
            .await?;
        let mut result: MarketplaceThemeDetail = self.public_json(request).await?;
        result.detail_preview_data_url = self
            .remote_preview(
                &result.detail_preview_url,
                &format!("{}-detail.jpg", result.card.version_id),
                1280,
                800,
                2 * 1024 * 1024,
            )
            .await?;
        if result.card.preview_data_url.is_empty() {
            result.card.preview_data_url =
                self.card_preview(&result.card).await.unwrap_or_default();
        }
        Ok(result)
    }

    pub async fn auth_state(&self) -> MarketplaceAuthState {
        let should_restore = {
            let auth = self.auth.lock().await;
            auth.access_token.is_none() && auth.user.is_none()
        };
        if should_restore && self.refresh_access().await.is_err() {
            if let Ok(session) = self.read_session() {
                self.auth.lock().await.user = Some(session.user);
            }
        }
        self.auth_snapshot().await
    }

    pub async fn start_login(&self) -> Result<MarketplaceLoginResult, String> {
        self.auth.lock().await.pending = true;
        let result = self.login_with_loopback().await;
        self.auth.lock().await.pending = false;
        result?;
        Ok(MarketplaceLoginResult {
            status: "complete".into(),
            auth: self.auth_snapshot().await,
        })
    }

    async fn login_with_loopback(&self) -> Result<(), String> {
        let client_state = random_token(32);
        let verifier = random_token(64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let (callback_url, callback) = start_callback_server(client_state.clone()).await?;
        let mut browser_url = Url::parse(&format!("{}/api/v1/auth/desktop/start", self.api_base))
            .map_err(|error| format!("主题广场登录地址无效：{error}"))?;
        browser_url
            .query_pairs_mut()
            .append_pair("provider", "google")
            .append_pair("redirect_uri", &callback_url)
            .append_pair("state", &client_state)
            .append_pair("code_challenge", &challenge);
        self.app
            .opener()
            .open_url(browser_url.as_str(), None::<&str>)
            .map_err(|error| format!("无法打开系统浏览器：{error}"))?;
        let code = tokio::time::timeout(Duration::from_secs(180), callback)
            .await
            .map_err(|_| "浏览器授权超时，请重新登录".to_string())?
            .map_err(|_| "浏览器授权回跳失败".to_string())??;
        let pair: TokenPair = self
            .public_json(
                self.http
                    .post(format!("{}/api/v1/auth/desktop/token", self.api_base))
                    .json(&serde_json::json!({
                        "code": code,
                        "code_verifier": verifier
                    })),
            )
            .await?;
        self.accept_token_pair(pair).await
    }

    pub async fn logout(&self) -> Result<MarketplaceAuthState, String> {
        let refresh = self.read_refresh_token();
        self.clear_local_auth()?;
        *self.auth.lock().await = AuthMemory::default();
        if let Some(refresh) = refresh {
            let _ = self
                .http
                .post(format!("{}/api/v1/auth/logout", self.api_base))
                .json(&serde_json::json!({"refresh_token": refresh}))
                .send()
                .await;
        }
        Ok(self.auth_snapshot().await)
    }

    pub async fn update_profile(&self, public_name: String) -> Result<MarketplaceUser, String> {
        let request = self
            .authorized_request(Method::PATCH, "/api/v1/me")
            .await?
            .json(&serde_json::json!({"public_name": public_name}));
        let user: MarketplaceUser = self.authorized_json(request).await?;
        self.write_session(&user)?;
        self.auth.lock().await.user = Some(user.clone());
        Ok(user)
    }

    pub async fn list_my_uploads(&self) -> Result<Vec<MarketplaceUploadRecord>, String> {
        let request = self
            .authorized_request(Method::GET, "/api/v1/me/theme-uploads")
            .await?;
        let result: MineResponse = self.authorized_json(request).await?;
        Ok(result.items)
    }

    pub async fn local_sync_states(
        &self,
        runtime: Arc<ThemeRuntime>,
    ) -> Result<Vec<MarketplaceLocalSyncState>, String> {
        let themes = runtime.list_themes().await?;
        let links = self.links.lock().await.all();
        let mut states = Vec::new();
        for theme in themes.into_iter().filter(|theme| !theme.built_in) {
            let (manifest, image) = runtime.load_theme_for_marketplace(&theme.id)?;
            let current_hash = content_sha256(&manifest, &image)?;
            let link = links.iter().find(|item| item.manifest_id == manifest.id);
            states.push(MarketplaceLocalSyncState {
                local_theme_id: theme.id,
                manifest_id: manifest.id,
                linked: link.is_some(),
                theme_id: link.map(|item| item.theme_id.clone()),
                version_id: link.map(|item| item.version_id.clone()),
                version_number: link.map(|item| item.version_number),
                package_sha256: link.map(|item| item.package_sha256.clone()),
                role: link.map(|item| item.role.clone()),
                local_changed: link.is_some_and(|item| item.local_content_sha256 != current_hash),
            });
        }
        Ok(states)
    }

    pub async fn prepare_upload(
        &self,
        source: UploadSource,
        runtime: Arc<ThemeRuntime>,
    ) -> Result<MarketplaceUploadPreparation, String> {
        let manifest = match source {
            UploadSource::Installed { theme_id } => {
                runtime.load_theme_for_marketplace(&theme_id)?.0
            }
            UploadSource::Package { path } => {
                let path = PathBuf::from(path);
                tokio::task::spawn_blocking(move || theme::inspect_package(&path))
                    .await
                    .map_err(|error| format!("主题包校验任务异常结束：{error}"))??
                    .manifest
            }
        };
        let previous = self
            .list_my_uploads()
            .await?
            .into_iter()
            .filter(|record| record.manifest_id == manifest.id)
            .max_by_key(|record| record.version_number);
        let listing = previous
            .as_ref()
            .map(|record| MarketplaceListingInput {
                title: record.title.clone(),
                description: record.description.clone(),
                tags: record.tags.clone(),
                visibility: record.visibility.clone(),
            })
            .unwrap_or_else(|| MarketplaceListingInput {
                title: manifest.name.clone(),
                description: manifest.tagline.clone(),
                tags: Vec::new(),
                visibility: "public".into(),
            });
        Ok(MarketplaceUploadPreparation {
            manifest_id: manifest.id,
            default_title: manifest.name,
            default_description: manifest.tagline,
            existing_visibility: previous.map(|record| record.visibility),
            listing,
        })
    }

    pub async fn upload_theme(
        &self,
        source: UploadSource,
        listing: MarketplaceListingInput,
        allow_update: bool,
        runtime: Arc<ThemeRuntime>,
    ) -> Result<MarketplaceUploadOutcome, String> {
        let (package_path, temporary) = match source {
            UploadSource::Package { path } => (PathBuf::from(path), None),
            UploadSource::Installed { theme_id } => {
                let (manifest, image) = runtime.load_theme_for_marketplace(&theme_id)?;
                let path = self.write_installed_package(&manifest, &image)?;
                (path.clone(), Some(path))
            }
        };
        let prepared = tokio::task::spawn_blocking(move || preview::prepare_package(&package_path))
            .await
            .map_err(|error| format!("主题投稿准备任务异常结束：{error}"))?;
        let result = match prepared {
            Ok(prepared) => self.resolve_upload(prepared, listing, allow_update).await,
            Err(error) => Err(error),
        };
        if let Some(path) = temporary {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    async fn resolve_upload(
        &self,
        prepared: PreparedUpload,
        listing: MarketplaceListingInput,
        allow_update: bool,
    ) -> Result<MarketplaceUploadOutcome, String> {
        if prepared.package.len() > MAX_PACKAGE_BYTES {
            return Err("上传主题包不能超过 20 MB".into());
        }
        let previous = self
            .list_my_uploads()
            .await?
            .into_iter()
            .filter(|record| record.manifest_id == prepared.manifest.id)
            .max_by_key(|record| record.version_number);
        let is_update = previous.is_some();
        let same_submission = previous.as_ref().is_some_and(|record| {
            record.package_sha256 == prepared.package_sha256
                && record.title == listing.title
                && record.description == listing.description
                && record.tags == listing.tags
                && record.visibility == listing.visibility
        });
        if is_update && !same_submission && !allow_update {
            return Ok(MarketplaceUploadOutcome {
                uploaded: false,
                needs_confirmation: true,
                is_update: true,
                title: listing.title,
                previous_version_number: previous.map(|record| record.version_number),
                record: None,
            });
        }

        let local_content_sha256 = prepared.local_content_sha256.clone();
        let title = listing.title.clone();
        let record = self.upload_prepared(prepared, listing).await?;
        self.links.lock().await.upsert(ThemeLink {
            manifest_id: record.manifest_id.clone(),
            theme_id: record.theme_id.clone(),
            version_id: record.version_id.clone(),
            version_number: record.version_number,
            package_sha256: record.package_sha256.clone(),
            local_content_sha256,
            role: "publisher".into(),
        })?;
        Ok(MarketplaceUploadOutcome {
            uploaded: !same_submission,
            needs_confirmation: false,
            is_update,
            title,
            previous_version_number: previous.map(|item| item.version_number),
            record: Some(record),
        })
    }

    pub async fn withdraw_theme(&self, theme_id: &str) -> Result<(), String> {
        let request = self
            .authorized_request(
                Method::POST,
                &format!("/api/v1/me/themes/{theme_id}/withdraw"),
            )
            .await?;
        let _: serde_json::Value = self.authorized_json(request).await?;
        Ok(())
    }

    pub async fn restore_theme(&self, theme_id: &str) -> Result<(), String> {
        let request = self
            .authorized_request(
                Method::POST,
                &format!("/api/v1/me/themes/{theme_id}/restore"),
            )
            .await?;
        let _: serde_json::Value = self.authorized_json(request).await?;
        Ok(())
    }

    pub async fn set_like(
        &self,
        theme_id: &str,
        liked: bool,
    ) -> Result<MarketplaceLikeResult, String> {
        let method = if liked { Method::PUT } else { Method::DELETE };
        let request = self
            .with_guest_grant(
                self.authorized_request(method, &format!("/api/v1/themes/{theme_id}/like"))
                    .await?,
                theme_id,
            )
            .await;
        self.authorized_json(request).await
    }

    pub async fn create_share_code(&self, theme_id: &str) -> Result<MarketplaceShareCode, String> {
        let request = self
            .authorized_request(
                Method::POST,
                &format!("/api/v1/me/themes/{theme_id}/share-codes"),
            )
            .await?;
        self.authorized_json(request).await
    }

    pub async fn list_share_codes(
        &self,
        theme_id: &str,
    ) -> Result<Vec<MarketplaceShareCode>, String> {
        let request = self
            .authorized_request(
                Method::GET,
                &format!("/api/v1/me/themes/{theme_id}/share-codes"),
            )
            .await?;
        let result: ShareCodeList = self.authorized_json(request).await?;
        Ok(result.items)
    }

    pub async fn redeem_share_code(&self, code: String) -> Result<String, String> {
        let request = self
            .viewer_request(Method::POST, "/api/v1/theme-share/redeem", None)
            .await?
            .json(&serde_json::json!({"code": code}));
        let result: ShareRedeemResult = self.public_json(request).await?;
        if result.grant_type == "guest" {
            self.grants
                .lock()
                .await
                .upsert(result.theme_id.clone(), result.grant_token)?;
        }
        Ok(result.theme_id)
    }

    pub async fn install_theme(
        &self,
        theme_id: &str,
        allow_update: bool,
        runtime: Arc<ThemeRuntime>,
    ) -> Result<ThemeInstallOutcome, String> {
        let downloaded = self.download_validated(theme_id).await?;
        let outcome = runtime
            .install_theme(ThemeInstallRequest {
                package_path: downloaded.path.display().to_string(),
                allow_update,
            })
            .await;
        let association_result = if let Ok(installed) = &outcome {
            if installed.installed {
                let mut links = self.links.lock().await;
                let role = links
                    .get(&downloaded.info.manifest_id)
                    .filter(|link| link.theme_id == theme_id && link.role == "publisher")
                    .map(|_| "publisher")
                    .unwrap_or("consumer");
                links.upsert(ThemeLink {
                    manifest_id: downloaded.info.manifest_id.clone(),
                    theme_id: theme_id.to_string(),
                    version_id: downloaded.info.version_id.clone(),
                    version_number: downloaded.info.version_number,
                    package_sha256: downloaded.info.sha256.clone(),
                    local_content_sha256: downloaded.local_content_sha256.clone(),
                    role: role.into(),
                })
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };
        let _ = std::fs::remove_file(downloaded.path);
        association_result?;
        outcome
    }

    pub async fn save_theme(&self, theme_id: &str, destination: &str) -> Result<(), String> {
        let destination = PathBuf::from(destination);
        if !destination.is_absolute()
            || destination
                .extension()
                .and_then(|value| value.to_str())
                .is_none_or(|value| !value.eq_ignore_ascii_case("zip"))
        {
            return Err("保存位置必须是绝对 .zip 路径".into());
        }
        if std::fs::symlink_metadata(&destination)
            .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
        {
            return Err("保存位置不能是目录或符号链接".into());
        }
        let downloaded = self.download_validated(theme_id).await?;
        let result = replace_file(&downloaded.path, &destination);
        let _ = std::fs::remove_file(downloaded.path);
        result
    }

    async fn upload_prepared(
        &self,
        prepared: PreparedUpload,
        listing: MarketplaceListingInput,
    ) -> Result<MarketplaceUploadRecord, String> {
        let request = self
            .authorized_request(Method::POST, "/api/v1/me/theme-uploads")
            .await?
            .json(&serde_json::json!({
                "manifest": prepared.manifest,
                "listing": listing,
                "package": {"sha256": prepared.package_sha256, "size": prepared.package.len()},
                "card_preview": {"sha256": prepared.card_sha256, "size": prepared.card.len()},
                "detail_preview": {"sha256": prepared.detail_sha256, "size": prepared.detail.len()}
            }));
        let record: MarketplaceUploadRecord = self.authorized_json(request).await?;
        let Some(targets) = record.upload_targets.clone() else {
            return Ok(record);
        };
        self.put_asset(&targets.package, prepared.package).await?;
        self.put_asset(&targets.card_preview, prepared.card).await?;
        self.put_asset(&targets.detail_preview, prepared.detail)
            .await?;
        let request = self
            .authorized_request(
                Method::POST,
                &format!("/api/v1/me/theme-uploads/{}/complete", record.version_id),
            )
            .await?;
        self.authorized_json(request).await
    }

    async fn put_asset(&self, target: &UploadTarget, bytes: Vec<u8>) -> Result<(), String> {
        if !target.method.eq_ignore_ascii_case("PUT") {
            return Err("资源服务返回了不支持的上传方式".into());
        }
        let mut request = self.http.put(&target.url);
        for (name, value) in &target.headers {
            request = request.header(name, value);
        }
        let response = request.body(bytes).send().await.map_err(network_error)?;
        if !response.status().is_success() {
            return Err(format!("上传主题资源失败（HTTP {}）", response.status()));
        }
        Ok(())
    }

    async fn card_preview(&self, card: &MarketplaceThemeCard) -> Result<String, String> {
        self.remote_preview(
            &card.card_preview_url,
            &format!("{}-card.jpg", card.version_id),
            640,
            400,
            512 * 1024,
        )
        .await
    }

    async fn remote_preview(
        &self,
        url: &str,
        cache_name: &str,
        width: u32,
        height: u32,
        max_bytes: usize,
    ) -> Result<String, String> {
        let path = self.cache_dir.join(cache_name);
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(clean) = preview::sanitize_remote_preview(&bytes, width, height, max_bytes) {
                return Ok(preview::data_url(&clean));
            }
            let _ = std::fs::remove_file(&path);
        }
        let response = self.http.get(url).send().await.map_err(network_error)?;
        if !response.status().is_success() {
            return Err(format!("下载主题预览失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err("远程预览图大小不符合要求".into());
        }
        let bytes = read_bounded(response, max_bytes, "远程预览图过大").await?;
        let clean = preview::sanitize_remote_preview(&bytes, width, height, max_bytes)?;
        std::fs::write(&path, &clean).map_err(|error| format!("无法缓存主题预览：{error}"))?;
        Ok(preview::data_url(&clean))
    }

    async fn download_validated(&self, theme_id: &str) -> Result<DownloadedTheme, String> {
        let request = self
            .viewer_request(
                Method::POST,
                &format!("/api/v1/themes/{theme_id}/download"),
                Some(theme_id),
            )
            .await?;
        let info: DownloadInfo = self.public_json(request).await?;
        if info.size <= 0 || info.size as usize > MAX_PACKAGE_BYTES || info.version_number < 1 {
            return Err("远程主题包大小不符合要求".into());
        }
        let response = self
            .http
            .get(&info.url)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(format!("下载主题包失败（HTTP {}）", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_PACKAGE_BYTES as u64 || length != info.size as u64)
        {
            return Err("远程主题包大小与服务记录不一致".into());
        }
        let path = self.temporary_dir.join(format!(
            "{}-{}.zip",
            info.version_id,
            Uuid::new_v4().simple()
        ));
        let mut output = tokio::fs::File::create(&path)
            .await
            .map_err(|error| format!("无法创建主题下载临时文件：{error}"))?;
        let mut stream = response.bytes_stream();
        let mut digest = Sha256::new();
        let mut size = 0_usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(network_error)?;
            size = size
                .checked_add(chunk.len())
                .ok_or_else(|| "远程主题包过大".to_string())?;
            if size > MAX_PACKAGE_BYTES {
                let _ = tokio::fs::remove_file(&path).await;
                return Err("远程主题包超过 20 MB".into());
            }
            digest.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|error| format!("无法写入主题下载临时文件：{error}"))?;
        }
        output
            .flush()
            .await
            .map_err(|error| format!("无法完成主题下载：{error}"))?;
        drop(output);
        let actual_sha = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if size as i64 != info.size || !actual_sha.eq_ignore_ascii_case(&info.sha256) {
            let _ = tokio::fs::remove_file(&path).await;
            return Err("主题包完整性校验失败".into());
        }
        let inspect_path = path.clone();
        let prepared = tokio::task::spawn_blocking(move || theme::inspect_package(&inspect_path))
            .await
            .map_err(|error| format!("主题包校验任务异常结束：{error}"))??;
        if prepared.manifest.id != info.manifest_id {
            let _ = tokio::fs::remove_file(&path).await;
            return Err("主题包 ID 与广场记录不一致".into());
        }
        let local_content_sha256 = content_sha256(&prepared.manifest, &prepared.image)?;
        Ok(DownloadedTheme {
            path,
            info,
            local_content_sha256,
        })
    }

    fn write_installed_package(
        &self,
        manifest: &ThemeManifest,
        image: &[u8],
    ) -> Result<PathBuf, String> {
        use std::io::Write;
        use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

        let path = self.temporary_dir.join(format!(
            "upload-{}-{}.zip",
            manifest.id,
            Uuid::new_v4().simple()
        ));
        let file =
            std::fs::File::create(&path).map_err(|error| format!("无法创建投稿临时包：{error}"))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer
            .start_file("theme.json", options)
            .map_err(|error| format!("无法写入投稿清单：{error}"))?;
        writer
            .write_all(
                &serde_json::to_vec_pretty(manifest)
                    .map_err(|error| format!("无法序列化投稿清单：{error}"))?,
            )
            .map_err(|error| format!("无法写入投稿清单：{error}"))?;
        writer
            .start_file(&manifest.image, options)
            .map_err(|error| format!("无法写入投稿背景：{error}"))?;
        writer
            .write_all(image)
            .map_err(|error| format!("无法写入投稿背景：{error}"))?;
        writer
            .finish()
            .map_err(|error| format!("无法完成投稿临时包：{error}"))?;
        Ok(path)
    }

    async fn auth_snapshot(&self) -> MarketplaceAuthState {
        let auth = self.auth.lock().await;
        MarketplaceAuthState {
            logged_in: auth.user.is_some()
                && (auth.access_token.is_some() || self.refresh_token_path.is_file()),
            pending: auth.pending,
            user: auth.user.clone(),
        }
    }

    async fn authorized_request(
        &self,
        method: Method,
        path: &str,
    ) -> Result<RequestBuilder, String> {
        let token = self.ensure_access().await?;
        Ok(self
            .http
            .request(method, format!("{}{}", self.api_base, path))
            .bearer_auth(token))
    }

    async fn viewer_request(
        &self,
        method: Method,
        path: &str,
        theme_id: Option<&str>,
    ) -> Result<RequestBuilder, String> {
        let mut request = self
            .http
            .request(method, format!("{}{}", self.api_base, path));
        let has_login = {
            let auth = self.auth.lock().await;
            auth.access_token.is_some() || self.refresh_token_path.is_file()
        };
        if has_login {
            request = request.bearer_auth(self.ensure_access().await?);
        }
        if let Some(theme_id) = theme_id {
            request = self.with_guest_grant(request, theme_id).await;
        }
        Ok(request)
    }

    async fn with_guest_grant(&self, request: RequestBuilder, theme_id: &str) -> RequestBuilder {
        match self.grants.lock().await.get(theme_id) {
            Some(token) => request.header("X-Codex-NN-Theme-Grant", token),
            None => request,
        }
    }

    async fn ensure_access(&self) -> Result<String, String> {
        {
            let auth = self.auth.lock().await;
            if let (Some(token), Some(expires_at)) = (&auth.access_token, auth.access_expires_at) {
                if expires_at > Instant::now() + Duration::from_secs(30) {
                    return Ok(token.clone());
                }
            }
        }
        self.refresh_access().await
    }

    async fn refresh_access(&self) -> Result<String, String> {
        let refresh = self
            .read_refresh_token()
            .ok_or_else(|| "请先使用 Google 登录".to_string())?;
        let request = self
            .http
            .post(format!("{}/api/v1/auth/token/refresh", self.api_base))
            .json(&serde_json::json!({"refresh_token": refresh}));
        let response = request.send().await.map_err(network_error)?;
        let unauthorized = response.status() == StatusCode::UNAUTHORIZED;
        let pair: TokenPair = match parse_response(response).await {
            Ok(pair) => pair,
            Err(error) => {
                if unauthorized {
                    let _ = self.clear_local_auth();
                    let pending = self.auth.lock().await.pending;
                    *self.auth.lock().await = AuthMemory {
                        pending,
                        ..AuthMemory::default()
                    };
                }
                return Err(error);
            }
        };
        let token = pair.access_token.clone();
        self.accept_token_pair(pair).await?;
        Ok(token)
    }

    async fn accept_token_pair(&self, pair: TokenPair) -> Result<(), String> {
        self.write_refresh_token(&pair.refresh_token)?;
        self.write_session(&pair.user)?;
        let mut auth = self.auth.lock().await;
        auth.access_token = Some(pair.access_token);
        auth.access_expires_at =
            Some(Instant::now() + Duration::from_secs(pair.expires_in.max(60) as u64));
        auth.user = Some(pair.user);
        Ok(())
    }

    fn read_refresh_token(&self) -> Option<String> {
        let token = std::fs::read_to_string(&self.refresh_token_path).ok()?;
        let token = token.trim().to_string();
        (!token.is_empty()).then_some(token)
    }

    fn write_refresh_token(&self, token: &str) -> Result<(), String> {
        atomic_write(&self.refresh_token_path, token.as_bytes())
            .map_err(|error| format!("无法保存登录凭证：{error}"))
    }

    fn write_session(&self, user: &MarketplaceUser) -> Result<(), String> {
        let session = StoredSession {
            user: user.clone(),
            updated_at_epoch_seconds: now_epoch_seconds(),
        };
        let bytes = serde_json::to_vec_pretty(&session)
            .map_err(|error| format!("无法序列化本地登录状态：{error}"))?;
        atomic_write(&self.session_path, &bytes)
            .map_err(|error| format!("无法保存本地登录状态：{error}"))
    }

    fn read_session(&self) -> Result<StoredSession, String> {
        let bytes = std::fs::read(&self.session_path)
            .map_err(|error| format!("无法读取本地登录状态：{error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("本地登录状态已损坏：{error}"))
    }

    fn clear_local_auth(&self) -> Result<(), String> {
        for path in [&self.refresh_token_path, &self.session_path] {
            if path.exists() {
                std::fs::remove_file(path)
                    .map_err(|error| format!("无法清除本地登录状态：{error}"))?;
            }
        }
        Ok(())
    }

    async fn public_json<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T, String> {
        parse_response(request.send().await.map_err(network_error)?).await
    }

    async fn authorized_json<T: DeserializeOwned>(
        &self,
        request: RequestBuilder,
    ) -> Result<T, String> {
        let retry = request.try_clone();
        let response = request.send().await.map_err(network_error)?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return parse_response(response).await;
        }
        let _ = self.refresh_access().await?;
        let Some(retry) = retry else {
            return Err("登录状态已更新，请重试刚才的操作".into());
        };
        let token = self.ensure_access().await?;
        parse_response(
            retry
                .bearer_auth(token)
                .send()
                .await
                .map_err(network_error)?,
        )
        .await
    }
}

async fn parse_response<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let envelope: ApiEnvelope<T> = response
        .json()
        .await
        .map_err(|error| format!("主题广场返回了无法识别的数据：{error}"))?;
    if !status.is_success() || envelope.code != 0 {
        let reason = if envelope.reason.is_empty() {
            String::new()
        } else {
            format!(" [{}]", envelope.reason)
        };
        return Err(format!("{}{}", envelope.message, reason));
    }
    envelope
        .data
        .ok_or_else(|| "主题广场响应缺少数据".to_string())
}

async fn read_bounded(
    response: reqwest::Response,
    max_bytes: usize,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::with_capacity(response_content_capacity(max_bytes));
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(too_large.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn response_content_capacity(max_bytes: usize) -> usize {
    max_bytes.min(64 * 1024)
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "连接主题广场超时".into()
    } else {
        format!("无法连接主题广场：{error}")
    }
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    sender: Arc<StdMutex<Option<CallbackSender>>>,
    shutdown: Arc<StdMutex<Option<oneshot::Sender<()>>>>,
}

type CallbackSender = oneshot::Sender<Result<String, String>>;

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

async fn start_callback_server(
    expected_state: String,
) -> Result<(String, oneshot::Receiver<Result<String, String>>), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("无法启动本机登录回跳：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("无法读取本机登录端口：{error}"))?
        .port();
    let (sender, receiver) = oneshot::channel();
    let (shutdown_sender, shutdown_receiver) = oneshot::channel();
    let state = CallbackState {
        expected_state,
        sender: Arc::new(StdMutex::new(Some(sender))),
        shutdown: Arc::new(StdMutex::new(Some(shutdown_sender))),
    };
    let router = Router::new()
        .route("/callback", get(handle_callback))
        .with_state(state);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.await;
            })
            .await;
    });
    Ok((format!("http://127.0.0.1:{port}/callback"), receiver))
}

async fn handle_callback(
    State(state): State<CallbackState>,
    Query(query): Query<CallbackQuery>,
) -> (AxumStatusCode, Html<&'static str>) {
    let result = if let Some(error) = query.error {
        Err(format!("授权失败：{error}"))
    } else if query.state.as_deref() != Some(state.expected_state.as_str()) {
        Err("授权 state 校验失败".into())
    } else if let Some(code) = query.code {
        Ok(code)
    } else {
        Err("授权回跳缺少 code".into())
    };
    if let Ok(mut sender) = state.sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
    if let Ok(mut shutdown) = state.shutdown.lock() {
        if let Some(shutdown) = shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    (
        AxumStatusCode::OK,
        Html("<!doctype html><meta charset=\"utf-8\"><title>Codex NN</title><body>Codex 暖暖登录已完成，可以回到应用。</body>"),
    )
}

fn random_token(length: usize) -> String {
    Alphanumeric.sample_string(&mut rand::rng(), length)
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "保存位置缺少父目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("无法创建保存目录：{error}"))?;
    let temporary = parent.join(format!(".theme-{}.tmp.zip", Uuid::new_v4().simple()));
    std::fs::copy(source, &temporary).map_err(|error| format!("无法复制主题包：{error}"))?;
    if !destination.exists() {
        return std::fs::rename(&temporary, destination).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            format!("无法保存主题包：{error}")
        });
    }
    let backup = parent.join(format!(".theme-{}.backup.zip", Uuid::new_v4().simple()));
    std::fs::rename(destination, &backup).map_err(|error| format!("无法备份原主题包：{error}"))?;
    if let Err(error) = std::fs::rename(&temporary, destination) {
        let _ = std::fs::rename(&backup, destination);
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("无法保存主题包：{error}"));
    }
    let _ = std::fs::remove_file(backup);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loopback_callback_accepts_only_the_expected_state() {
        let (callback_url, receiver) = start_callback_server("expected-state".into())
            .await
            .unwrap();
        let response = reqwest::get(format!(
            "{callback_url}?state=expected-state&code=application-code"
        ))
        .await
        .unwrap();
        assert!(response.status().is_success());
        assert_eq!(receiver.await.unwrap().unwrap(), "application-code");

        let (callback_url, receiver) = start_callback_server("expected-state".into())
            .await
            .unwrap();
        let response = reqwest::get(format!(
            "{callback_url}?state=wrong-state&code=application-code"
        ))
        .await
        .unwrap();
        assert!(response.status().is_success());
        assert!(receiver.await.unwrap().is_err());
    }
}
