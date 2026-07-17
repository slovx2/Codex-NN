use std::{io::Cursor, path::Path, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::ImageReader;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::{
    cdp_session::CdpSession,
    models::{ThemeManifest, VerificationReport},
};

const THEME_ENGINE_VERSION: &str = "0.4.3";
const CSS: &str = include_str!("../resources/theme-engine/nn-theme.css");
const RENDERER: &str = include_str!("../resources/theme-engine/renderer-inject.js");

#[derive(Debug, Clone)]
pub struct ThemePayload {
    pub theme_id: String,
    pub revision: String,
    pub script: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    web_socket_debugger_url: String,
    #[serde(rename = "type")]
    kind: String,
}

pub fn build_payload(manifest: &ThemeManifest, image: &[u8]) -> Result<ThemePayload, String> {
    let extension = Path::new(&manifest.image)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return Err(format!("不支持的主题图片格式：{extension}")),
    };
    let (width, height) = ImageReader::new(Cursor::new(image))
        .with_guessed_format()
        .map_err(|error| format!("无法识别主题图片：{error}"))?
        .into_dimensions()
        .map_err(|error| format!("无法解析主题图片元数据：{error}"))?;
    let ratio = f64::from(width) / f64::from(height);
    let aspect = if ratio >= 2.25 {
        "ultrawide"
    } else if ratio >= 1.45 {
        "wide"
    } else if ratio >= 1.08 {
        "landscape"
    } else if ratio >= 0.9 {
        "square"
    } else {
        "portrait"
    };
    let image_url = format!("data:{mime};base64,{}", STANDARD.encode(image));
    let mut theme = serde_json::to_value(manifest).map_err(|error| error.to_string())?;
    theme["artKey"] = Value::String(format!("{:x}", Sha256::digest(image)));
    theme["artMetadata"] = json!({
        "width": width,
        "height": height,
        "ratio": ratio,
        "wide": ratio >= 1.75,
        "aspect": aspect,
        "taskMode": if ratio >= 2.25 { "banner" } else { "ambient" },
    });
    let theme = serde_json::to_string(&theme).map_err(|error| error.to_string())?;
    let revision = theme_revision(&theme, image);
    let script = RENDERER
        .replace(
            "__CODEX_NN_THEME_CSS_JSON__",
            &serde_json::to_string(CSS).unwrap(),
        )
        .replace(
            "__CODEX_NN_THEME_ART_JSON__",
            &serde_json::to_string(&image_url).unwrap(),
        )
        .replace("__CODEX_NN_THEME_CONFIG_JSON__", &theme)
        .replace(
            "__CODEX_NN_THEME_VERSION_JSON__",
            &serde_json::to_string(THEME_ENGINE_VERSION).unwrap(),
        )
        .replace(
            "__CODEX_NN_THEME_REVISION_JSON__",
            &serde_json::to_string(&revision).unwrap(),
        );
    Ok(ThemePayload {
        theme_id: manifest.id.clone(),
        revision,
        script,
    })
}

fn theme_revision(theme: &str, image: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(theme.as_bytes());
    hasher.update([0]);
    hasher.update(image);
    format!("{:x}", hasher.finalize())
}

pub async fn endpoint_ready(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

pub async fn wait_and_apply(
    port: u16,
    payload: &ThemePayload,
    timeout: Duration,
) -> Result<usize, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_error = "尚未发现 Codex 页面".to_string();
    while tokio::time::Instant::now() < deadline {
        match apply_all(port, payload).await {
            Ok(count) if count > 0 => return Ok(count),
            Ok(_) => last_error = "CDP 已启动，但没有匹配的 Codex 页面".into(),
            Err(error) => last_error = error,
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    Err(format!("等待 Codex 页面超时：{last_error}"))
}

pub async fn run_watcher(port: u16, payload: ThemePayload, mut stop: watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            break;
        }
        if let Err(error) = apply_all(port, &payload).await {
            eprintln!("[codex-nn] 守护注入失败：{error}");
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(900)) => {}
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() { break; }
            }
        }
    }
}

pub async fn remove_all(port: u16) -> Result<usize, String> {
    if !endpoint_ready(port).await {
        return Ok(0);
    }
    let targets = list_targets(port).await?;
    let mut removed = 0;
    for target in targets {
        let mut session = connect_verified(&target, port).await?;
        let value = session.evaluate(REMOVE_SCRIPT).await?;
        if value.as_bool() == Some(true) {
            removed += 1;
        }
    }
    Ok(removed)
}

pub async fn verify(port: u16, screenshot: Option<&Path>) -> Result<VerificationReport, String> {
    let targets = list_targets(port).await?;
    let mut details = Vec::new();
    let mut screenshot_path = None;
    for target in targets {
        let mut session = connect_verified(&target, port).await?;
        let result = session.evaluate(VERIFY_SCRIPT).await?;
        if screenshot_path.is_none() {
            if let Some(path) = screenshot {
                capture(&mut session, path).await?;
                screenshot_path = Some(path.to_string_lossy().into_owned());
            }
        }
        details.push(
            json!({ "id": target.id, "title": target.title, "url": target.url, "result": result }),
        );
    }
    let pass = !details.is_empty()
        && details
            .iter()
            .all(|item| item.pointer("/result/pass").and_then(Value::as_bool) == Some(true));
    Ok(VerificationReport {
        pass,
        port: Some(port),
        target_count: details.len(),
        screenshot_path,
        details: Value::Array(details),
        message: if pass {
            "主题注入、原生控件和页面尺寸检查通过"
        } else {
            "实时验证未通过，请查看详细结果"
        }
        .into(),
    })
}

async fn apply_all(port: u16, payload: &ThemePayload) -> Result<usize, String> {
    let targets = list_targets(port).await?;
    let mut count = 0;
    for target in targets {
        let mut session = connect_verified(&target, port).await?;
        let marker = format!("window.__CODEX_NN_THEME_STATE__?.version === {version} && window.__CODEX_NN_THEME_STATE__?.themeId === {theme} && window.__CODEX_NN_THEME_STATE__?.revision === {revision}", version = serde_json::to_string(THEME_ENGINE_VERSION).unwrap(), theme = serde_json::to_string(&payload.theme_id).unwrap(), revision = serde_json::to_string(&payload.revision).unwrap());
        if session.evaluate(&marker).await?.as_bool() != Some(true) {
            let result = session.evaluate(&payload.script).await?;
            if result.get("installed").and_then(Value::as_bool) != Some(true) {
                return Err("渲染脚本没有返回成功标记".into());
            }
        }
        count += 1;
    }
    Ok(count)
}

async fn list_targets(port: u16) -> Result<Vec<Target>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|error| format!("无法读取 CDP 页面列表：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("CDP 返回 HTTP {}", response.status()));
    }
    let targets: Vec<Target> = response
        .json()
        .await
        .map_err(|error| format!("CDP 页面列表格式错误：{error}"))?;
    Ok(targets.into_iter().filter(is_codex_page_target).collect())
}

fn is_codex_page_target(target: &Target) -> bool {
    let Ok(url) = reqwest::Url::parse(&target.url) else {
        return false;
    };
    let has_initial_route = url
        .query_pairs()
        .any(|(key, _)| key.eq_ignore_ascii_case("initialRoute"));
    target.kind == "page"
        && url.scheme() == "app"
        && !target.web_socket_debugger_url.is_empty()
        && !has_initial_route
}

async fn connect_verified(target: &Target, port: u16) -> Result<CdpSession, String> {
    let mut session = CdpSession::connect(&target.web_socket_debugger_url, port).await?;
    session.send("Runtime.enable", json!({})).await?;
    session.send("Page.enable", json!({})).await?;
    let probe = session.evaluate(PROBE_SCRIPT).await?;
    if probe.get("codex").and_then(Value::as_bool) != Some(true) {
        return Err(format!("拒绝非 Codex 页面目标：{}", target.id));
    }
    Ok(session)
}

async fn capture(session: &mut CdpSession, path: &Path) -> Result<(), String> {
    let result = session
        .send(
            "Page.captureScreenshot",
            json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false }),
        )
        .await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "CDP 截图没有返回图片".to_string())?;
    let bytes = STANDARD
        .decode(data)
        .map_err(|error| format!("无法解码截图：{error}"))?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(path, bytes)
        .await
        .map_err(|error| format!("无法保存截图：{error}"))
}

const PROBE_SCRIPT: &str = r#"(() => { const shell = !!document.querySelector('main.main-surface'); const sidebar = !!document.querySelector('aside.app-shell-left-panel'); const composer = !!document.querySelector('.composer-surface-chrome'); const main = !!document.querySelector('[role="main"]'); return { codex: shell && sidebar && (composer || main) }; })()"#;
const REMOVE_SCRIPT: &str = r#"(() => { const state = window.__CODEX_NN_THEME_STATE__; if (state?.cleanup) return state.cleanup(); const root = document.documentElement; root?.classList.remove('codex-nn-theme'); for (const name of ['data-nn-theme-shell', 'data-nn-theme-layout', 'data-nn-theme-page', 'data-nn-art-wide', 'data-nn-art-safe-area', 'data-nn-task-mode', 'data-nn-art-aspect', 'data-nn-art-ready']) root?.removeAttribute(name); for (const name of ['--nn-theme-art', '--nn-art-focus-x', '--nn-art-focus-y', '--nn-art-position']) root?.style.removeProperty(name); document.getElementById('codex-nn-theme-style')?.remove(); document.getElementById('codex-nn-theme-chrome')?.remove(); delete window.__CODEX_NN_THEME_STATE__; return true; })()"#;
const VERIFY_SCRIPT: &str = r#"(() => {
  const visible = node => {
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const root = document.documentElement;
  const chrome = document.getElementById('codex-nn-theme-chrome');
  const shellMain = document.querySelector('main.main-surface') || document.querySelector('main');
  const home = document.querySelector('.nn-theme-home');
  const layout = window.__CODEX_NN_THEME_STATE__?.layout || null;
  const thread = shellMain?.querySelector('.thread-scroll-container') || null;
  const gameSource = shellMain?.querySelector('[data-feature="game-source"]') || null;
  const actualPage = gameSource && !thread ? 'home' : 'thread';
  const page = root.dataset.nnThemePage || null;
  const suggestions = home?.querySelector('.group\\/home-suggestions') || null;
  const cards = suggestions ? [...suggestions.querySelectorAll('button')].map(box) : [];
  const artWide = root.getAttribute('data-nn-art-wide') === 'true';
  const taskMode = root.getAttribute('data-nn-task-mode');
  const immersiveExpected = actualPage === 'thread' && (taskMode === 'ambient' || taskMode === 'banner');
  const wallpaperBackground = !immersiveExpected ? 'none' : layout === 'dream-skin'
    ? getComputedStyle(document.body, '::before').backgroundImage
    : artWide
      ? getComputedStyle(document.body).backgroundImage
      : getComputedStyle(shellMain, '::before').backgroundImage;
  const result = {
    installed: document.documentElement.classList.contains('codex-nn-theme'),
    version: window.__CODEX_NN_THEME_STATE__?.version || null,
    themeId: window.__CODEX_NN_THEME_STATE__?.themeId || null,
    revision: window.__CODEX_NN_THEME_STATE__?.revision || null,
    layout,
    stylePresent: !!document.getElementById('codex-nn-theme-style'),
    chromePresent: !!chrome,
    pointerEvents: chrome ? getComputedStyle(chrome).pointerEvents : null,
    sidebar: visible(document.querySelector('aside.app-shell-left-panel')),
    composer: visible(document.querySelector('.composer-surface-chrome')),
    page,
    actualPage,
    pageStateMatches: page === actualPage,
    homePresent: actualPage === 'home',
    nativeHome: actualPage === 'home' && layout === 'dream-skin',
    artWide,
    taskMode,
    immersiveTask: !immersiveExpected || (wallpaperBackground !== 'none' && wallpaperBackground.includes('blob:')),
    hero: box(home?.firstElementChild?.firstElementChild?.firstElementChild),
    cards,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
  const nativeLayout = layout === 'dream-skin';
  const nativeLayoutPass = !nativeLayout || (!shellMain?.classList.contains('nn-theme-home-shell') && !home);
  const composedLayoutPass = nativeLayout || (actualPage === 'home'
    ? (!!home && !!shellMain?.classList.contains('nn-theme-home-shell') && !!chrome?.classList.contains('nn-theme-home-shell'))
    : (!home && !shellMain?.classList.contains('nn-theme-home-shell') && !chrome?.classList.contains('nn-theme-home-shell')));
  const composedHomePass = !result.homePresent || result.nativeHome || (!!result.hero && (!suggestions || (cards.length >= 2 && cards.length <= 4)));
  const chromePass = nativeLayout ? !result.chromePresent : (result.chromePresent && result.pointerEvents === 'none');
  result.pass = result.installed && result.stylePresent && chromePass && result.sidebar &&
    result.composer && result.immersiveTask && !result.overflowX && result.pageStateMatches && nativeLayoutPass &&
    composedLayoutPass && composedHomePass;
  return result;
})()"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_complete_built_in_payload() {
        let manifest: ThemeManifest = serde_json::from_str(include_str!(
            "../../theme-packs/strawberry-starlight/theme.json"
        ))
        .unwrap();
        let image = include_bytes!("../../theme-packs/strawberry-starlight/background.webp");
        let payload = build_payload(&manifest, image).unwrap();
        assert_eq!(payload.theme_id, "strawberry-starlight");
        assert_eq!(payload.revision.len(), 64);
        assert!(payload.script.contains("Codex 暖暖"));
        assert!(payload.script.contains("\"wide\":true"));
        assert!(payload.script.contains("\"artKey\":"));
        assert!(payload.script.contains(THEME_ENGINE_VERSION));
        assert!(!payload.script.contains("__CODEX_NN_THEME_CSS_JSON__"));
        assert!(!payload.script.contains("__CODEX_NN_THEME_ART_JSON__"));
        assert!(!payload.script.contains("__CODEX_NN_THEME_CONFIG_JSON__"));
        assert!(!payload.script.contains("__CODEX_NN_THEME_VERSION_JSON__"));
        assert!(!payload.script.contains("__CODEX_NN_THEME_REVISION_JSON__"));
        assert!(payload.script.len() > image.len());
    }

    #[test]
    fn changes_revision_when_theme_content_changes() {
        let manifest: ThemeManifest = serde_json::from_str(include_str!(
            "../../theme-packs/strawberry-starlight/theme.json"
        ))
        .unwrap();
        let image = include_bytes!("../../theme-packs/strawberry-starlight/background.webp");
        let first = build_payload(&manifest, image).unwrap();
        let repeated = build_payload(&manifest, image).unwrap();
        let mut changed_manifest = manifest.clone();
        changed_manifest.name.push_str(" changed");
        let changed = build_payload(&changed_manifest, image).unwrap();

        assert_eq!(first.revision, repeated.revision);
        assert_ne!(first.revision, changed.revision);
    }

    #[test]
    fn filters_auxiliary_and_non_codex_page_targets() {
        let target = |kind: &str, url: &str, websocket: &str| Target {
            id: "target".into(),
            title: String::new(),
            url: url.into(),
            web_socket_debugger_url: websocket.into(),
            kind: kind.into(),
        };

        assert!(is_codex_page_target(&target(
            "page",
            "app://-/index.html",
            "ws://127.0.0.1/devtools/page/main",
        )));
        assert!(!is_codex_page_target(&target(
            "page",
            "app://-/index.html?initialRoute=%2Favatar-overlay",
            "ws://127.0.0.1/devtools/page/avatar",
        )));
        assert!(!is_codex_page_target(&target(
            "page",
            "app://-/index.html?INITIALROUTE=%2Fsettings",
            "ws://127.0.0.1/devtools/page/settings",
        )));
        assert!(!is_codex_page_target(&target(
            "worker",
            "app://-/index.html",
            "ws://127.0.0.1/devtools/page/worker",
        )));
        assert!(!is_codex_page_target(&target(
            "page",
            "https://example.com",
            "ws://127.0.0.1/devtools/page/external",
        )));
        assert!(!is_codex_page_target(&target(
            "page",
            "app://-/index.html",
            "",
        )));
    }
}
