use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{models::ThemeManifest, paths::atomic_write};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ThemeLink {
    pub manifest_id: String,
    pub theme_id: String,
    pub version_id: String,
    pub version_number: i32,
    pub package_sha256: String,
    pub local_content_sha256: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceLocalSyncState {
    pub local_theme_id: String,
    pub manifest_id: String,
    pub linked: bool,
    pub theme_id: Option<String>,
    pub version_id: Option<String>,
    pub version_number: Option<i32>,
    pub package_sha256: Option<String>,
    pub role: Option<String>,
    pub local_changed: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLinks {
    schema_version: u8,
    themes: Vec<ThemeLink>,
}

pub(super) struct ThemeLinkStore {
    path: PathBuf,
    links: Vec<ThemeLink>,
}

impl ThemeLinkStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self {
                path,
                links: Vec::new(),
            });
        }
        let bytes =
            std::fs::read(&path).map_err(|error| format!("无法读取主题云端关联：{error}"))?;
        let stored: StoredLinks = serde_json::from_slice(&bytes)
            .map_err(|error| format!("主题云端关联已损坏：{error}"))?;
        if stored.schema_version != 1 {
            return Err("主题云端关联版本不受支持".into());
        }
        Ok(Self {
            path,
            links: stored.themes,
        })
    }

    pub fn get(&self, manifest_id: &str) -> Option<ThemeLink> {
        self.links
            .iter()
            .find(|link| link.manifest_id == manifest_id)
            .cloned()
    }

    pub fn all(&self) -> Vec<ThemeLink> {
        self.links.clone()
    }

    pub fn upsert(&mut self, link: ThemeLink) -> Result<(), String> {
        if let Some(existing) = self
            .links
            .iter_mut()
            .find(|item| item.manifest_id == link.manifest_id)
        {
            *existing = link;
        } else {
            self.links.push(link);
        }
        self.links
            .sort_by(|left, right| left.manifest_id.cmp(&right.manifest_id));
        let bytes = serde_json::to_vec_pretty(&StoredLinks {
            schema_version: 1,
            themes: self.links.clone(),
        })
        .map_err(|error| format!("无法序列化主题云端关联：{error}"))?;
        atomic_write(&self.path, &bytes).map_err(|error| format!("无法保存主题云端关联：{error}"))
    }
}

pub(super) fn content_sha256(manifest: &ThemeManifest, image: &[u8]) -> Result<String, String> {
    let manifest =
        serde_json::to_vec(manifest).map_err(|error| format!("无法计算本地主题指纹：{error}"))?;
    let mut digest = Sha256::new();
    digest.update(b"codex-nn-theme-content-v1\0");
    digest.update((manifest.len() as u64).to_be_bytes());
    digest.update(manifest);
    digest.update(image);
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
