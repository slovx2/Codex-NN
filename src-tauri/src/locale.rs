use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, RwLock,
};

use serde::{Deserialize, Serialize};

use crate::paths::{atomic_write, AppPaths};

const SETTINGS_SCHEMA_VERSION: u8 = 1;
const LANGUAGE_ZH_CN: u8 = 0;
const LANGUAGE_EN: u8 = 1;

static CURRENT_LANGUAGE: AtomicU8 = AtomicU8::new(LANGUAGE_ZH_CN);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LanguagePreference {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolvedLanguage {
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

impl ResolvedLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::En => "en",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSettings {
    pub preference: LanguagePreference,
    pub resolved_language: ResolvedLanguage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    schema_version: u8,
    preference: LanguagePreference,
    resolved_language: ResolvedLanguage,
}

impl Default for PersistedSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            preference: LanguagePreference::System,
            resolved_language: ResolvedLanguage::ZhCn,
        }
    }
}

pub struct LanguageManager {
    paths: AppPaths,
    settings: RwLock<PersistedSettings>,
}

impl LanguageManager {
    pub fn load(paths: &AppPaths) -> Result<Arc<Self>, String> {
        let settings = std::fs::read(&paths.settings)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedSettings>(&bytes).ok())
            .filter(|settings| settings.schema_version == SETTINGS_SCHEMA_VERSION)
            .unwrap_or_default();
        set_current(settings.resolved_language);
        let manager = Arc::new(Self {
            paths: paths.clone(),
            settings: RwLock::new(settings),
        });
        manager.persist(&settings)?;
        Ok(manager)
    }

    pub fn sync(&self, system_locale: &str) -> Result<LanguageSettings, String> {
        let mut settings = self.settings.write().map_err(|_| {
            localize(
                "语言设置正在更新，请重试",
                "Language settings are being updated. Try again.",
            )
        })?;
        let resolved = resolve(settings.preference, system_locale);
        if settings.resolved_language != resolved {
            let next = PersistedSettings {
                resolved_language: resolved,
                ..*settings
            };
            self.persist(&next)?;
            *settings = next;
        }
        set_current(resolved);
        Ok(settings.public())
    }

    pub fn set_preference(
        &self,
        preference: LanguagePreference,
        system_locale: &str,
    ) -> Result<LanguageSettings, String> {
        let mut settings = self.settings.write().map_err(|_| {
            localize(
                "语言设置正在更新，请重试",
                "Language settings are being updated. Try again.",
            )
        })?;
        let next = PersistedSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            preference,
            resolved_language: resolve(preference, system_locale),
        };
        self.persist(&next)?;
        *settings = next;
        set_current(next.resolved_language);
        Ok(next.public())
    }

    fn persist(&self, settings: &PersistedSettings) -> Result<(), String> {
        let mut bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        atomic_write(&self.paths.settings, &bytes)
    }
}

impl PersistedSettings {
    fn public(self) -> LanguageSettings {
        LanguageSettings {
            preference: self.preference,
            resolved_language: self.resolved_language,
        }
    }
}

pub fn resolve(preference: LanguagePreference, system_locale: &str) -> ResolvedLanguage {
    match preference {
        LanguagePreference::ZhCn => ResolvedLanguage::ZhCn,
        LanguagePreference::En => ResolvedLanguage::En,
        LanguagePreference::System => {
            if system_locale.trim().to_ascii_lowercase().starts_with("zh") {
                ResolvedLanguage::ZhCn
            } else {
                ResolvedLanguage::En
            }
        }
    }
}

pub fn current() -> ResolvedLanguage {
    match CURRENT_LANGUAGE.load(Ordering::Relaxed) {
        LANGUAGE_EN => ResolvedLanguage::En,
        _ => ResolvedLanguage::ZhCn,
    }
}

pub fn set_current(language: ResolvedLanguage) {
    CURRENT_LANGUAGE.store(
        match language {
            ResolvedLanguage::ZhCn => LANGUAGE_ZH_CN,
            ResolvedLanguage::En => LANGUAGE_EN,
        },
        Ordering::Relaxed,
    );
}

pub fn initialize_from_env() {
    if std::env::var("CODEX_NN_LANGUAGE").as_deref() == Ok("en") {
        set_current(ResolvedLanguage::En);
    }
}

pub fn localize(zh_cn: &str, en: &str) -> String {
    match current() {
        ResolvedLanguage::ZhCn => zh_cn,
        ResolvedLanguage::En => en,
    }
    .to_string()
}

pub fn select<'a>(zh_cn: &'a str, en: &'a str) -> &'a str {
    match current() {
        ResolvedLanguage::ZhCn => zh_cn,
        ResolvedLanguage::En => en,
    }
}

pub fn translate_error(message: String) -> String {
    if current() != ResolvedLanguage::En
        || !message
            .chars()
            .any(|value| ('\u{4e00}'..='\u{9fff}').contains(&value))
    {
        return message;
    }
    let exact = [
        ("主题目录和输出 ZIP 必须使用绝对路径", "The theme directory and output ZIP must use absolute paths"),
        ("输出文件必须使用 .zip 扩展名", "The output file must use the .zip extension"),
        ("主题来源必须是普通目录，不能是符号链接", "The theme source must be a regular directory, not a symbolic link"),
        ("输出 ZIP 必须放在主题目录之外", "The output ZIP must be outside the theme directory"),
        ("输出路径必须是普通文件，不能是目录或符号链接", "The output path must be a regular file, not a directory or symbolic link"),
        ("theme.json 必须是 1 字节到 64 KB 的普通文件", "theme.json must be a regular file between 1 byte and 64 KB"),
        ("主题图片必须是 1 字节到 16 MB 的普通文件", "The theme image must be a regular file between 1 byte and 16 MB"),
        ("主题目录只允许普通文件", "The theme directory may contain only regular files"),
        ("主题目录必须且只能包含 theme.json 和清单引用的图片", "The theme directory must contain only theme.json and the image referenced by the manifest"),
        ("内置主题不可覆盖", "Built-in themes cannot be overwritten"),
        ("内置主题不可删除", "Built-in themes cannot be deleted"),
        ("主题目录与主题 ID 不匹配", "The theme directory does not match the theme ID"),
        ("主题 ZIP 必须是 1 字节到 20 MB 的文件", "The theme ZIP must be a file between 1 byte and 20 MB"),
        ("主题包必须使用 .zip 扩展名", "The theme package must use the .zip extension"),
        ("主题 ZIP 根目录必须且只能包含 theme.json 和一张主题图片", "The ZIP root must contain only theme.json and one theme image"),
        ("主题 ZIP 不支持加密文件", "Encrypted files are not supported in theme ZIPs"),
        ("主题 ZIP 仅支持 Stored 或 Deflate 压缩", "Theme ZIPs support only Stored or Deflate compression"),
        ("主题 ZIP 不允许目录，文件必须直接位于根目录", "Theme ZIPs cannot contain directories; files must be in the root"),
        ("主题 ZIP 不允许符号链接", "Theme ZIPs cannot contain symbolic links"),
        ("主题 ZIP 包含不安全路径", "The theme ZIP contains an unsafe path"),
        ("主题 ZIP 文件必须直接位于根目录", "Theme ZIP files must be directly in the root"),
        ("主题 ZIP 包含重复文件", "The theme ZIP contains duplicate files"),
        ("主题 ZIP 解压后超过 20 MB", "The extracted theme ZIP exceeds 20 MB"),
        ("主题 ZIP 缺少 theme.json", "The theme ZIP is missing theme.json"),
        ("主题 ZIP 必须只包含 theme.json 和清单引用的主题图片", "The theme ZIP must contain only theme.json and the referenced theme image"),
        ("无法识别主题图片格式", "Unable to identify the theme image format"),
        ("主题图片内容与扩展名不一致", "The theme image content does not match its extension"),
        ("主题外观只能是 auto、light 或 dark", "Theme appearance must be auto, light, or dark"),
        ("主题安全区只能是 auto、left、right、center 或 none", "Theme safe area must be auto, left, right, center, or none"),
        ("主题任务页模式只能是 auto、ambient、banner 或 off", "Theme task mode must be auto, ambient, banner, or off"),
        ("主题图片必须直接位于主题目录", "The theme image must be directly inside the theme directory"),
        ("主题图片宽高必须大于 0", "Theme image dimensions must be greater than zero"),
        ("主题图片任一边不可超过 16384 像素", "No theme image edge may exceed 16,384 pixels"),
        ("主题图片总像素不可超过 5000 万", "The theme image may not exceed 50 million pixels"),
        ("主题 ID 只能包含小写字母、数字和连字符，且最长 80 字符", "The theme ID may contain only lowercase letters, digits, and hyphens and must not exceed 80 characters"),
        ("主题图片仅支持 PNG、JPEG 或 WebP", "Theme images support only PNG, JPEG, or WebP"),
        ("主题图片必须位于主题目录内", "The theme image must be inside the theme directory"),
    ];
    if let Some((_, english)) = exact.iter().find(|(chinese, _)| *chinese == message) {
        return (*english).into();
    }
    let replacements = [
        ("无法读取主题目录", "Unable to read the theme directory"),
        ("无法解析主题目录", "Unable to resolve the theme directory"),
        ("输出 ZIP 文件名必须是 UTF-8", "The output ZIP filename must be UTF-8"),
        ("输出 ZIP 缺少父目录", "The output ZIP has no parent directory"),
        ("无法创建输出目录", "Unable to create the output directory"),
        ("无法解析输出目录", "Unable to resolve the output directory"),
        ("无法读取 theme.json", "Unable to read theme.json"),
        ("theme.json 格式错误", "theme.json has an invalid format"),
        ("无法读取主题图片", "Unable to read the theme image"),
        ("无法读取主题文件", "Unable to read a theme file"),
        ("主题文件名必须是 UTF-8", "Theme filenames must be UTF-8"),
        ("无法创建主题 ZIP", "Unable to create the theme ZIP"),
        ("无法写入 theme.json", "Unable to write theme.json"),
        ("无法写入主题图片", "Unable to write the theme image"),
        ("无法完成主题 ZIP", "Unable to finish the theme ZIP"),
        ("无法保存主题 ZIP", "Unable to save the theme ZIP"),
        ("无法备份原主题 ZIP", "Unable to back up the original theme ZIP"),
        ("无法更新主题 ZIP", "Unable to update the theme ZIP"),
        ("无法读取主题库", "Unable to read the theme library"),
        ("主题图片为空或超过 16 MB", "The theme image is empty or exceeds 16 MB"),
        ("无法创建主题临时目录", "Unable to create the temporary theme directory"),
        ("无法备份现有主题", "Unable to back up the existing theme"),
        ("无法更新主题", "Unable to update the theme"),
        ("无法安装主题", "Unable to install the theme"),
        ("主题不存在", "Theme not found"),
        ("无法移除主题", "Unable to remove the theme"),
        ("无法清理主题文件", "Unable to clean up theme files"),
        ("无法移除旧版默认主题", "Unable to remove the legacy default theme"),
        ("内置主题", "Built-in theme"),
        ("的清单格式错误", " manifest has an invalid format"),
        ("的 ID 不匹配", " ID does not match"),
        ("无法创建内置主题", "Unable to create built-in theme"),
        ("的图片损坏", " image is corrupt"),
        ("无法读取主题包", "Unable to read the theme package"),
        ("无法打开主题包", "Unable to open the theme package"),
        ("主题 ZIP 格式错误", "The theme ZIP has an invalid format"),
        ("无法读取 ZIP 条目", "Unable to read a ZIP entry"),
        ("主题 ZIP 文件名必须是 UTF-8", "Theme ZIP filenames must be UTF-8"),
        ("无法识别主题图片", "Unable to identify the theme image"),
        ("无法读取主题图片尺寸", "Unable to read theme image dimensions"),
        ("无法解码主题图片", "Unable to decode the theme image"),
        ("不支持主题 schema", "Unsupported theme schema"),
        ("主题布局只能是 standard、dreamSkin、strawberryStarlight、azureNeon、mikuFuture、adventureAtlas 或 portalDimension", "Theme layout must be standard, dreamSkin, strawberryStarlight, azureNeon, mikuFuture, adventureAtlas, or portalDimension"),
        ("主题名称", "Theme name"),
        ("品牌副标题", "Brand subtitle"),
        ("主题标语", "Theme tagline"),
        ("项目提示", "Project prefix"),
        ("项目标题", "Project label"),
        ("状态文字", "Status text"),
        ("装饰引语", "Decorative quote"),
        ("主题字段", "Theme field"),
        ("必须是 0 到 1 之间的数字", "must be a number between 0 and 1"),
        ("主题颜色", "Theme color"),
        ("格式错误", "has an invalid format"),
        ("不能为空", "cannot be empty"),
        ("不可超过", "cannot exceed"),
        ("个字符", "characters"),
        ("无法生成主题预览", "Unable to generate the theme preview"),
        ("无法创建广场预览缓存", "Unable to create the Theme Plaza preview cache"),
        ("无法创建广场临时目录", "Unable to create the Theme Plaza temporary directory"),
        ("无法创建主题广场网络客户端", "Unable to create the Theme Plaza network client"),
        ("主题广场登录地址无效", "The Theme Plaza sign-in URL is invalid"),
        ("无法打开系统浏览器", "Unable to open the system browser"),
        ("浏览器授权超时，请重新登录", "Browser authorization timed out. Sign in again."),
        ("浏览器授权回跳失败", "The browser authorization callback failed"),
        ("主题包校验任务异常结束", "The theme package validation task ended unexpectedly"),
        ("主题投稿准备任务异常结束", "The theme submission preparation task ended unexpectedly"),
        ("上传主题包不能超过 20 MB", "The uploaded theme package cannot exceed 20 MB"),
        ("保存位置必须是绝对 .zip 路径", "The save destination must be an absolute .zip path"),
        ("保存位置不能是目录或符号链接", "The save destination cannot be a directory or symbolic link"),
        ("资源服务返回了不支持的上传方式", "The asset service returned an unsupported upload method"),
        ("上传主题资源失败", "Uploading theme assets failed"),
        ("下载主题预览失败", "Downloading the theme preview failed"),
        ("远程预览图大小不符合要求", "The remote preview size is invalid"),
        ("远程预览图过大", "The remote preview is too large"),
        ("无法缓存主题预览", "Unable to cache the theme preview"),
        ("远程主题包大小不符合要求", "The remote theme package size is invalid"),
        ("下载主题包失败", "Downloading the theme package failed"),
        ("远程主题包大小与服务记录不一致", "The remote theme package size does not match the service record"),
        ("无法创建主题下载临时文件", "Unable to create the temporary theme download file"),
        ("远程主题包过大", "The remote theme package is too large"),
        ("远程主题包超过 20 MB", "The remote theme package exceeds 20 MB"),
        ("无法写入主题下载临时文件", "Unable to write the temporary theme download file"),
        ("无法完成主题下载", "Unable to finish downloading the theme"),
        ("主题包完整性校验失败", "Theme package integrity validation failed"),
        ("主题包 ID 与广场记录不一致", "The theme package ID does not match the Theme Plaza record"),
        ("无法创建投稿临时包", "Unable to create the temporary submission package"),
        ("无法写入投稿清单", "Unable to write the submission manifest"),
        ("无法序列化投稿清单", "Unable to serialize the submission manifest"),
        ("无法写入投稿背景", "Unable to write the submission background"),
        ("无法完成投稿临时包", "Unable to finish the temporary submission package"),
        ("请先使用 Google 登录", "Sign in with Google first"),
        ("无法保存登录凭证", "Unable to save sign-in credentials"),
        ("无法序列化本地登录状态", "Unable to serialize the local sign-in state"),
        ("无法保存本地登录状态", "Unable to save the local sign-in state"),
        ("无法读取本地登录状态", "Unable to read the local sign-in state"),
        ("本地登录状态已损坏", "The local sign-in state is corrupt"),
        ("无法清除本地登录状态", "Unable to clear the local sign-in state"),
        ("登录状态已更新，请重试刚才的操作", "The sign-in state was refreshed. Retry the previous action."),
        ("主题广场返回了无法识别的数据", "Theme Plaza returned unrecognized data"),
        ("主题广场响应缺少数据", "The Theme Plaza response is missing data"),
        ("连接主题广场超时", "The Theme Plaza connection timed out"),
        ("无法连接主题广场", "Unable to connect to Theme Plaza"),
        ("无法启动本机登录回跳", "Unable to start the local sign-in callback"),
        ("无法读取本机登录端口", "Unable to read the local sign-in port"),
        ("授权失败", "Authorization failed"),
        ("授权 state 校验失败", "Authorization state validation failed"),
        ("授权回跳缺少 code", "The authorization callback is missing a code"),
        ("保存位置缺少父目录", "The save destination has no parent directory"),
        ("无法创建保存目录", "Unable to create the save directory"),
        ("无法复制主题包", "Unable to copy the theme package"),
        ("无法保存主题包", "Unable to save the theme package"),
        ("无法备份原主题包", "Unable to back up the original theme package"),
        ("无法读取私密主题授权", "Unable to read private-theme grants"),
        ("私密主题授权已损坏", "Private-theme grants are corrupt"),
        ("私密主题授权版本不受支持", "The private-theme grant version is unsupported"),
        ("无法保存私密主题授权", "Unable to save private-theme grants"),
        ("无法读取主题云端关联", "Unable to read cloud theme links"),
        ("主题云端关联已损坏", "Cloud theme links are corrupt"),
        ("主题云端关联版本不受支持", "The cloud theme link version is unsupported"),
        ("无法保存主题云端关联", "Unable to save cloud theme links"),
        ("无法计算本地主题指纹", "Unable to calculate the local theme fingerprint"),
        ("无法解码主题背景", "Unable to decode the theme background"),
        ("远程预览图格式不正确", "The remote preview format is invalid"),
        ("无法识别远程预览图", "Unable to identify the remote preview"),
        ("远程预览图损坏", "The remote preview is corrupt"),
        ("远程预览图尺寸不正确", "The remote preview dimensions are invalid"),
        ("无法整理远程预览图", "Unable to process the remote preview"),
        ("主题预览图压缩后仍然过大", "The compressed theme preview is still too large"),
        ("Codex 中的主题设计插件配置已被手动修改，未自动覆盖。", "The Theme Designer configuration in Codex was modified manually and was not overwritten."),
        ("检测到无法识别的插件托管状态，请先手动处理。", "An unrecognized managed plugin state was found. Resolve it manually first."),
        ("Codex 中已存在冲突的主题设计插件配置，未自动覆盖。", "A conflicting Theme Designer configuration already exists in Codex and was not overwritten."),
        ("插件配置已被手动修改，请先恢复或移除冲突配置", "The plugin configuration was modified manually. Restore or remove the conflicting configuration first."),
        ("检测到无法识别的插件托管状态", "An unrecognized managed plugin state was found"),
        ("Codex 中已存在同名 marketplace 或插件配置", "Codex already contains a marketplace or plugin with the same name"),
        ("Codex 的 features.plugins 不是布尔值，未自动覆盖", "Codex features.plugins is not a boolean and was not overwritten"),
        ("缺少 MCP 工具名称", "The MCP tool name is missing"),
        ("不支持的 MCP 方法", "Unsupported MCP method"),
        ("未知工具", "Unknown tool"),
        ("无法连接 Codex NN App", "Unable to connect to the Codex NN app"),
        ("请确认 Codex NN 正在运行；若 CDP 异常，请从 App 启动或重启 Codex。", "Confirm that Codex NN is running. If CDP is unavailable, launch or restart Codex from the app."),
        ("Agent API 返回无效 JSON", "The Agent API returned invalid JSON"),
        ("无法定位 Codex NN 应用数据目录", "Unable to locate the Codex NN app data directory"),
        ("Codex NN Agent API 未运行。请先打开 Codex NN。状态文件", "The Codex NN Agent API is not running. Open Codex NN first. State file"),
        ("Codex NN Agent API 状态损坏", "The Codex NN Agent API state is corrupt"),
        ("Codex NN Agent API 状态无效，请重启 Codex NN", "The Codex NN Agent API state is invalid. Restart Codex NN."),
        ("必填", "is required"),
        ("必须是绝对 ZIP 路径", "must be an absolute ZIP path"),
        ("必须是绝对目录路径", "must be an absolute directory path"),
        ("Codex NN 操作失败", "The Codex NN operation failed"),
        ("无法读取 Dream Skin 主题来源", "Unable to read the Dream Skin theme source"),
        ("Dream Skin 主题来源不允许符号链接", "The Dream Skin theme source cannot be a symbolic link"),
        ("Dream Skin 主题来源必须是主题目录或 ZIP 文件", "The Dream Skin theme source must be a theme directory or ZIP file"),
        ("无法读取 Dream Skin 主题目录", "Unable to read the Dream Skin theme directory"),
        ("无法读取主题目录条目", "Unable to read a theme directory entry"),
        ("Dream Skin 主题文件名必须是 UTF-8", "Dream Skin theme filenames must be UTF-8"),
        ("Dream Skin 主题目录包含不支持的额外条目", "The Dream Skin theme directory contains an unsupported extra entry"),
        ("Dream Skin ZIP 必须是 1 字节到 20 MB 的文件", "The Dream Skin ZIP must be a file between 1 byte and 20 MB"),
        ("无法打开 Dream Skin ZIP", "Unable to open the Dream Skin ZIP"),
        ("Dream Skin ZIP 格式错误", "The Dream Skin ZIP has an invalid format"),
        ("Dream Skin ZIP 不支持加密文件", "Dream Skin ZIPs do not support encrypted files"),
        ("Dream Skin ZIP 仅支持 Stored 或 Deflate 压缩", "Dream Skin ZIPs support only Stored or Deflate compression"),
        ("Dream Skin ZIP 不允许符号链接", "Dream Skin ZIPs cannot contain symbolic links"),
        ("Dream Skin ZIP 包含不安全路径", "The Dream Skin ZIP contains an unsafe path"),
        ("Dream Skin ZIP 文件名必须是 UTF-8", "Dream Skin ZIP filenames must be UTF-8"),
        ("Dream Skin ZIP 包含重复文件", "The Dream Skin ZIP contains duplicate files"),
        ("Dream Skin ZIP 解压后超过 20 MB", "The extracted Dream Skin ZIP exceeds 20 MB"),
        ("Dream Skin ZIP 必须包含唯一的 theme.json", "The Dream Skin ZIP must contain exactly one theme.json"),
        ("Dream Skin ZIP 最多允许一层包装目录", "The Dream Skin ZIP may have at most one wrapper directory"),
        ("Dream Skin ZIP 只能包含 theme.json 和清单引用的图片", "The Dream Skin ZIP may contain only theme.json and the referenced image"),
        ("Dream Skin theme.json 格式错误", "Dream Skin theme.json has an invalid format"),
        ("不支持 Dream Skin schema", "Unsupported Dream Skin schema"),
        ("Dream Skin 主题图片必须直接位于主题目录", "The Dream Skin image must be directly inside the theme directory"),
        ("Dream Skin 主题图片仅支持 PNG、JPEG 或 WebP", "Dream Skin images support only PNG, JPEG, or WebP"),
        ("不允许是符号链接", "cannot be a symbolic link"),
        ("必须是普通文件", "must be a regular file"),
        ("无法读取 macOS 元数据", "Unable to read macOS metadata"),
        ("为空或超过大小限制", "is empty or exceeds the size limit"),
        ("无法解压", "Unable to extract"),
        ("超过大小限制", "exceeds the size limit"),
        ("无法读取 Dream Skin ZIP 条目", "Unable to read a Dream Skin ZIP entry"),
        ("临时主题包路径缺少父目录", "The temporary theme package path has no parent directory"),
        ("无法创建临时主题包目录", "Unable to create the temporary theme package directory"),
        ("无法创建临时主题包", "Unable to create the temporary theme package"),
        ("无法写入临时 theme.json", "Unable to write temporary theme.json"),
        ("无法序列化转换主题", "Unable to serialize the converted theme"),
        ("无法写入临时主题图片", "Unable to write the temporary theme image"),
        ("无法完成临时主题包", "Unable to finish the temporary theme package"),
        ("无法切换应用图标", "Unable to change the app icon"),
        ("无法读取内置应用图标", "Unable to read the built-in app icon"),
        ("无法生成应用图标", "Unable to generate the app icon"),
        ("：", ": "),
    ];
    replacements
        .iter()
        .fold(message, |translated, (zh, en)| translated.replace(zh, en))
}

pub fn result<T>(result: Result<T, String>) -> Result<T, String> {
    result.map_err(translate_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ResetLanguage;

    impl Drop for ResetLanguage {
        fn drop(&mut self) {
            set_current(ResolvedLanguage::ZhCn);
        }
    }

    #[test]
    fn resolves_system_and_explicit_languages() {
        assert_eq!(
            resolve(LanguagePreference::System, "zh-Hans-CN"),
            ResolvedLanguage::ZhCn
        );
        assert_eq!(
            resolve(LanguagePreference::System, "en-US"),
            ResolvedLanguage::En
        );
        assert_eq!(
            resolve(LanguagePreference::System, "ja-JP"),
            ResolvedLanguage::En
        );
        assert_eq!(
            resolve(LanguagePreference::ZhCn, "en-US"),
            ResolvedLanguage::ZhCn
        );
        assert_eq!(
            resolve(LanguagePreference::En, "zh-CN"),
            ResolvedLanguage::En
        );
    }

    #[test]
    fn persists_language_settings() {
        let _reset = ResetLanguage;
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(root.path().join("app-data")).unwrap();
        let manager = LanguageManager::load(&paths).unwrap();
        let initial = manager.sync("en-US").unwrap();
        assert_eq!(initial.preference, LanguagePreference::System);
        assert_eq!(initial.resolved_language, ResolvedLanguage::En);

        for (preference, expected) in [
            (LanguagePreference::System, ResolvedLanguage::En),
            (LanguagePreference::ZhCn, ResolvedLanguage::ZhCn),
            (LanguagePreference::En, ResolvedLanguage::En),
        ] {
            let settings = manager.set_preference(preference, "en-US").unwrap();
            assert_eq!(settings.preference, preference);
            assert_eq!(settings.resolved_language, expected);
        }
        let restored = LanguageManager::load(&paths)
            .unwrap()
            .sync("zh-CN")
            .unwrap();
        assert_eq!(restored.preference, LanguagePreference::En);
        assert_eq!(restored.resolved_language, ResolvedLanguage::En);
    }

    #[test]
    fn invalid_settings_fall_back_to_system_preference() {
        let _reset = ResetLanguage;
        let root = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_root(root.path().join("app-data")).unwrap();
        std::fs::write(
            &paths.settings,
            br#"{"schemaVersion":1,"preference":"invalid","resolvedLanguage":"en"}"#,
        )
        .unwrap();

        let settings = LanguageManager::load(&paths)
            .unwrap()
            .sync("ja-JP")
            .unwrap();

        assert_eq!(settings.preference, LanguagePreference::System);
        assert_eq!(settings.resolved_language, ResolvedLanguage::En);
    }
}
