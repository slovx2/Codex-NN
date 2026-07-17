use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths::atomic_write;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuestGrant {
    theme_id: String,
    token: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGuestGrants {
    schema_version: u8,
    grants: Vec<GuestGrant>,
}

pub(super) struct GuestGrantStore {
    path: PathBuf,
    grants: Vec<GuestGrant>,
}

impl GuestGrantStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self {
                path,
                grants: Vec::new(),
            });
        }
        let bytes =
            std::fs::read(&path).map_err(|error| format!("无法读取私密主题授权：{error}"))?;
        let stored: StoredGuestGrants = serde_json::from_slice(&bytes)
            .map_err(|error| format!("私密主题授权已损坏：{error}"))?;
        if stored.schema_version != 1 {
            return Err("私密主题授权版本不受支持".into());
        }
        Ok(Self {
            path,
            grants: stored.grants,
        })
    }

    pub fn get(&self, theme_id: &str) -> Option<String> {
        self.grants
            .iter()
            .find(|grant| grant.theme_id == theme_id)
            .map(|grant| grant.token.clone())
    }

    pub fn upsert(&mut self, theme_id: String, token: String) -> Result<(), String> {
        if token.is_empty() {
            return Ok(());
        }
        if let Some(existing) = self
            .grants
            .iter_mut()
            .find(|grant| grant.theme_id == theme_id)
        {
            existing.token = token;
        } else {
            self.grants.push(GuestGrant { theme_id, token });
        }
        let bytes = serde_json::to_vec_pretty(&StoredGuestGrants {
            schema_version: 1,
            grants: self.grants.clone(),
        })
        .map_err(|error| format!("无法序列化私密主题授权：{error}"))?;
        atomic_write(&self.path, &bytes).map_err(|error| format!("无法保存私密主题授权：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_grants_are_persisted_per_theme() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("marketplace/share-grants.json");
        let mut store = GuestGrantStore::load(path.clone()).unwrap();
        store
            .upsert("theme-1".into(), "cnn_grant_first".into())
            .unwrap();
        store
            .upsert("theme-1".into(), "cnn_grant_second".into())
            .unwrap();
        let restored = GuestGrantStore::load(path).unwrap();
        assert_eq!(restored.get("theme-1").as_deref(), Some("cnn_grant_second"));
    }
}
