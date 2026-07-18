import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { confirmDialog } from "./app-dialog";
import { setupMarketplace } from "./marketplace";
import type {
  AppSnapshot,
  ClaudeThemeDesignerPluginStatus,
  DiagnosticReport,
  SessionState,
  ThemeDesignerPluginStatus,
  ThemeInstallOutcome,
  ThemeSummary,
  VerificationReport
} from "./types";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("缺少 #app 根节点");

let snapshot: AppSnapshot | null = null;
let themes: ThemeSummary[] = [];
let selectedThemeId = "";
let designerPlugin: ThemeDesignerPluginStatus | null = null;
let claudeDesignerPlugin: ClaudeThemeDesignerPluginStatus | null = null;
let busy = false;
let appliedAccent = "";
let checkingForUpdates = false;

const DEFAULT_ACCENT = "#e2556d";
const MARKETPLACE_ENABLED: boolean = false;

root.innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">NN</div>
        <div><h1>Codex 暖暖</h1><p>Codex 主题管理器</p></div>
      </div>
      <nav class="navigation" aria-label="主导航">
        <button class="nav-item active" data-page="home"><span>⌂</span><b>首页</b></button>
        <button class="nav-item" data-page="themes"><span>◫</span><b>主题库</b></button>
        ${MARKETPLACE_ENABLED ? `<button class="nav-item" data-page="marketplace"><span>◎</span><b>主题广场</b></button>` : ""}
        <button class="nav-item" data-page="designer"><span>✦</span><b>设计主题</b></button>
        <button class="nav-item" data-page="diagnostics"><span>⌁</span><b>诊断</b></button>
        <button id="settings-nav-item" class="nav-item" data-page="settings"><span>⚙</span><b>设置</b><i id="settings-update-dot" class="nav-update-dot" hidden></i></button>
      </nav>
      <div class="sidebar-status">
        <div class="sidebar-status-row"><span id="codex-dot" class="state-dot"></span><span>Codex</span><strong id="codex-state">读取中</strong></div>
        <div class="sidebar-status-row"><span id="theme-dot" class="state-dot"></span><span>主题会话</span><strong id="theme-state">读取中</strong></div>
      </div>
    </aside>

    <main class="workspace">
      <section id="page-home" class="page active">
        <header class="page-heading">
          <div><span class="eyebrow">OVERVIEW</span><h2>让 Codex 穿上喜欢的主题</h2><p>选择主题、启动 Codex，然后保持暖暖在后台运行。</p></div>
          <span id="header-status" class="status-pill neutral">读取中</span>
        </header>
        <div class="home-layout">
          <article class="preview-panel">
            <div id="hero-card" class="hero-card"></div>
            <div class="preview-meta">
              <div><span>当前主题</span><h3 id="current-theme-name">未设置</h3></div>
              <button class="text-button" data-open-page="themes">更换主题 →</button>
            </div>
          </article>
          <article class="control-panel">
            <div class="codex-heading">
              <div class="codex-icon">C</div>
              <div><span>官方 Codex</span><h3 id="codex-version">正在检测</h3></div>
            </div>
            <div class="primary-action-block">
              <button id="launch-button" class="button primary" data-operation>启动 Codex</button>
              <small>从这里启动或重启，才能使主题生效</small>
            </div>
            <button id="apply-button" class="button secondary" data-operation>应用当前主题</button>
            <div class="secondary-actions">
              <button id="pause-button" class="button subtle" data-operation>暂停主题</button>
              <button id="restore-button" class="button subtle danger" data-operation>完全恢复</button>
            </div>
            <div id="home-details" class="status-list"></div>
          </article>
        </div>
      </section>

      <section id="page-themes" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">LOCAL LIBRARY</span><h2>我的主题</h2><p>通过 ZIP 主题包安装，选择后可立即热切换。</p></div>
          <div class="heading-actions">
            ${MARKETPLACE_ENABLED ? `<button class="button subtle compact-button" data-open-page="marketplace">逛主题广场</button>` : ""}
            <button id="import-dream-skin-button" class="button secondary compact-button" data-operation>导入 Dream Skin</button>
            <button id="import-theme-button" class="button primary compact-button" data-operation>＋ 安装主题包</button>
          </div>
        </header>
        <div id="theme-list" class="theme-grid"></div>
        <footer class="theme-footer">
          <div><span>已选择</span><strong id="selected-theme-name">尚未选择主题</strong></div>
          <button id="activate-theme-button" class="button primary compact-button" data-operation>应用主题</button>
        </footer>
      </section>

      ${MARKETPLACE_ENABLED ? `<section id="page-marketplace" class="page">
        <header class="page-heading compact marketplace-heading">
          <div><span class="eyebrow">THEME PLAZA</span><h2>主题广场</h2><p>发现网友分享的主题，下载后由本地校验器安全安装。</p></div>
          <div class="marketplace-tabs" role="tablist" aria-label="主题广场视图">
            <button id="marketplace-discover-tab" class="marketplace-tab active" role="tab" aria-selected="true">发现主题</button>
            <button id="marketplace-mine-tab" class="marketplace-tab" role="tab" aria-selected="false">我的上传</button>
          </div>
        </header>
        <div id="marketplace-content" class="marketplace-content">
          <div class="marketplace-loading">正在连接主题广场…</div>
        </div>
      </section>` : ""}

      <section id="page-designer" class="page">
        <header class="page-heading compact designer-heading">
          <div><span class="eyebrow">THEME STUDIO</span><h2>让 AI 帮你设计 Codex 主题</h2><p>从概念稿出发，生成可直接安装的 Codex NN schema v1 主题包。</p></div>
          <div class="designer-provider-tabs" role="tablist" aria-label="选择主题设计助手">
            <button id="designer-provider-codex-tab" class="designer-provider-tab active" type="button" role="tab" aria-selected="true" aria-controls="designer-codex-panel" tabindex="0" data-designer-provider="codex">Codex</button>
            <button id="designer-provider-claude-tab" class="designer-provider-tab" type="button" role="tab" aria-selected="false" aria-controls="designer-claude-panel" tabindex="-1" data-designer-provider="claude">Claude Code</button>
          </div>
        </header>
        <div class="designer-layout">
          <article class="designer-hero">
            <span class="designer-spark">✦</span>
            <div><span>CODEX NN THEME DESIGNER</span><h3>描述一个世界，让 AI 把它变成主题</h3><p>你可以提供概念稿，也可以只描述风格。设计助手会先展示完整界面概念，等你确认后再生成背景、配色、文案和主题 ZIP。</p></div>
          </article>
          <article id="designer-codex-panel" class="plugin-panel" role="tabpanel" aria-labelledby="designer-provider-codex-tab">
            <div class="plugin-heading">
              <div class="plugin-icon">NN</div>
              <div><span>Codex 插件</span><h3>主题设计插件</h3></div>
              <strong id="designer-plugin-state" class="plugin-state neutral">检测中</strong>
            </div>
            <p>安装后，Codex 可完成概念确认和 schema v1 打包，并通过本地 MCP 直接安装、切换和诊断主题效果。</p>
            <ol class="designer-steps">
              <li><i>1</i><span><b>提供想法</b><small>文字描述或现有概念稿</small></span></li>
              <li><i>2</i><span><b>确认概念</b><small>先看整体界面与视觉语言</small></span></li>
              <li><i>3</i><span><b>获得主题包</b><small>图片、文案、配色与 ZIP</small></span></li>
            </ol>
            <div id="designer-plugin-message" class="plugin-message">正在检查 Codex 插件状态</div>
            <div class="plugin-actions">
              <button id="install-designer-plugin-button" class="button primary" data-operation disabled>安装主题设计插件</button>
              <button id="uninstall-designer-plugin-button" class="button subtle danger" data-operation disabled>卸载插件</button>
            </div>
          </article>
          <article id="designer-claude-panel" class="plugin-panel claude-plugin-panel" role="tabpanel" aria-labelledby="designer-provider-claude-tab" hidden>
            <div class="plugin-heading">
              <div class="plugin-icon claude-plugin-icon">CC</div>
              <div><span>Claude Code 插件</span><h3>主题设计插件</h3></div>
              <strong id="claude-designer-plugin-state" class="plugin-state neutral">检测中</strong>
            </div>
            <p>只安装主题设计插件，并沿用 Claude Code 现有的账号、模型与接口配置；不会读取或修改 Claude Code 配置。</p>
            <ol class="designer-steps">
              <li><i>1</i><span><b>安装插件</b><small>仅添加 Codex NN 主题设计能力</small></span></li>
              <li><i>2</i><span><b>描述主题</b><small>在 Claude Code 中提供想法或概念稿</small></span></li>
              <li><i>3</i><span><b>预览并热更新</b><small>通过本地 MCP 安装、切换和诊断</small></span></li>
            </ol>
            <div id="claude-designer-plugin-message" class="plugin-message">正在检查 Claude Code 插件状态</div>
            <div class="plugin-actions">
              <button id="install-claude-designer-plugin-button" class="button primary" data-operation disabled>安装 Claude Code 插件</button>
              <button id="uninstall-claude-designer-plugin-button" class="button subtle danger" data-operation disabled>卸载插件</button>
            </div>
          </article>
        </div>
      </section>

      <section id="page-diagnostics" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">DIAGNOSTICS</span><h2>运行诊断</h2><p>静态检查不会修改或重启 Codex，实时验证需要活动主题会话。</p></div>
        </header>
        <div class="diagnostic-actions">
          <button id="diagnose-button" class="diagnostic-action" data-operation><span>✓</span><b>静态诊断</b><small>检查安装、主题与端口</small></button>
          <button id="verify-button" class="diagnostic-action" data-operation><span>◉</span><b>实时验证</b><small>检查当前注入结果</small></button>
          <button id="screenshot-button" class="diagnostic-action" data-operation><span>▣</span><b>验证并截图</b><small>保存当前验证画面</small></button>
        </div>
        <div id="diagnostic-results" class="diagnostic-results empty-state">还没有诊断结果</div>
      </section>

      <section id="page-settings" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">SETTINGS</span><h2>设置</h2></div>
        </header>
        <div class="settings-actions">
          <button id="check-update-button" class="button secondary compact-button" data-operation>检查更新</button>
        </div>
      </section>
    </main>
  </div>
  <div id="dream-import-dialog" class="modal-backdrop" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="dream-import-title">
      <button id="close-dream-import-button" class="modal-close" aria-label="关闭">×</button>
      <span class="eyebrow">DREAM SKIN IMPORT</span>
      <h3 id="dream-import-title">导入 Dream Skin macOS 主题</h3>
      <p>选择 Dream Skin 主题目录，或选择只包含 theme.json 与图片的 ZIP。导入后会转换为 Codex NN schema v1 并直接安装。</p>
      <div class="dream-import-options">
        <button id="choose-dream-folder-button" class="import-option" data-operation><span>▤</span><b>选择主题目录</b><small>适用于 themes/&lt;id&gt; 文件夹</small></button>
        <button id="choose-dream-zip-button" class="import-option" data-operation><span>◇</span><b>选择 ZIP</b><small>支持根目录或单层包装目录</small></button>
      </div>
    </div>
  </div>
  ${MARKETPLACE_ENABLED ? `<div id="marketplace-detail-dialog" class="modal-backdrop" hidden>
    <div id="marketplace-detail-card" class="modal-card marketplace-detail-card" role="dialog" aria-modal="true" aria-labelledby="marketplace-detail-title"></div>
  </div>` : ""}
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素 #${id}`);
  return element as T;
};

function showPage(page: string): void {
  document.querySelectorAll<HTMLElement>(".page").forEach((item) => item.classList.toggle("active", item.id === `page-${page}`));
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === page));
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: page }));
}

document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page ?? "home"));
});
document.querySelectorAll<HTMLButtonElement>("[data-open-page]").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.openPage ?? "home"));
});

byId("launch-button").addEventListener("click", () => void launchCodex());
byId("apply-button").addEventListener("click", () => void applyCurrentTheme());
byId("pause-button").addEventListener("click", () => void pauseTheme());
byId("restore-button").addEventListener("click", () => void restoreTheme());
byId("import-theme-button").addEventListener("click", () => void importThemePackage());
byId("import-dream-skin-button").addEventListener("click", () => openDreamImportDialog());
byId("close-dream-import-button").addEventListener("click", () => closeDreamImportDialog());
byId("choose-dream-folder-button").addEventListener("click", () => void chooseDreamSkinSource(true));
byId("choose-dream-zip-button").addEventListener("click", () => void chooseDreamSkinSource(false));
byId("install-designer-plugin-button").addEventListener("click", () => void installDesignerPlugin());
byId("uninstall-designer-plugin-button").addEventListener("click", () => void uninstallDesignerPlugin());
byId("install-claude-designer-plugin-button").addEventListener("click", () => void installClaudeDesignerPlugin());
byId("uninstall-claude-designer-plugin-button").addEventListener("click", () => void uninstallClaudeDesignerPlugin());
byId("activate-theme-button").addEventListener("click", () => void activateSelectedTheme());
byId("diagnose-button").addEventListener("click", () => void runDiagnostics());
byId("verify-button").addEventListener("click", () => void runVerification(null));
byId("screenshot-button").addEventListener("click", () => void chooseScreenshot());
byId("check-update-button").addEventListener("click", () => void checkForUpdates(true));

document.querySelectorAll<HTMLButtonElement>("[data-designer-provider]").forEach((tab) => {
  tab.addEventListener("click", () => switchDesignerProvider(tab.dataset.designerProvider === "claude" ? "claude" : "codex"));
  tab.addEventListener("keydown", handleDesignerProviderKeydown);
});

if (MARKETPLACE_ENABLED) {
  setupMarketplace({
    getInstalledThemes: () => themes,
    refreshLocalThemes: () => refresh(true),
    showToast,
    errorMessage
  });
}

async function refresh(preserveSelection = true): Promise<void> {
  const previousSelection = preserveSelection ? selectedThemeId : "";
  const pluginStatus = invoke<ThemeDesignerPluginStatus>("get_theme_designer_plugin_status")
    .catch((error): ThemeDesignerPluginStatus => ({
      installed: false,
      managed: false,
      conflict: true,
      version: "未知",
      message: `无法读取 Codex 插件状态：${errorMessage(error)}`
    }));
  const claudePluginStatus = invoke<ClaudeThemeDesignerPluginStatus>("get_claude_theme_designer_plugin_status")
    .catch((error): ClaudeThemeDesignerPluginStatus => ({
      installed: false,
      managed: false,
      conflict: true,
      version: "未知",
      message: `无法读取 Claude Code 插件状态：${errorMessage(error)}`,
      claudeAvailable: false
    }));
  [snapshot, themes, designerPlugin, claudeDesignerPlugin] = await Promise.all([
    invoke<AppSnapshot>("get_app_snapshot"),
    invoke<ThemeSummary[]>("list_themes"),
    pluginStatus,
    claudePluginStatus
  ]);
  selectedThemeId = themes.some((theme) => theme.id === previousSelection)
    ? previousSelection
    : snapshot.activeTheme?.id ?? themes[0]?.id ?? "";
  renderSnapshot();
  renderThemes();
  renderDesignerPlugin();
}

async function checkForUpdates(manual = false): Promise<void> {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const updateButton = byId<HTMLButtonElement>("check-update-button");
  updateButton.disabled = true;
  updateButton.textContent = "检查中";
  try {
    const update = await check();
    if (!update) {
      setUpdateAvailable(false);
      if (manual) showToast("当前已是最新版本");
      return;
    }
    setUpdateAvailable(true);
    const confirmed = await confirmDialog(
      `发现新版本 ${update.version}。是否立即下载并安装？`,
      { title: "Codex 暖暖更新", kind: "info" }
    );
    if (!confirmed) return;
    await runOperation("正在下载更新", async () => {
      await update.downloadAndInstall();
      setUpdateAvailable(false);
      const restart = await confirmDialog("更新已安装。是否立即重启 Codex 暖暖？", {
        title: "更新完成",
        kind: "info"
      });
      if (restart) await relaunch();
    });
  } catch (error) {
    console.warn("自动检查更新失败", error);
    if (manual) showToast(`检查更新失败：${errorMessage(error)}`, true);
  } finally {
    checkingForUpdates = false;
    updateButton.textContent = "检查更新";
    updateButton.disabled = busy;
  }
}

function setUpdateAvailable(available: boolean): void {
  byId("settings-update-dot").hidden = !available;
  byId("settings-nav-item").dataset.updateAvailable = String(available);
}

function renderSnapshot(): void {
  if (!snapshot) return;
  syncAppAccent(snapshot.activeTheme?.accent);
  const status = sessionMeta(snapshot.session);
  const header = byId("header-status");
  header.textContent = status.label;
  header.className = `status-pill ${status.kind}`;
  byId("theme-state").textContent = status.label;
  byId("theme-dot").className = `state-dot ${status.kind}`;
  byId("codex-state").textContent = snapshot.codex.running ? "运行中" : snapshot.codex.installed ? "未运行" : "未安装";
  byId("codex-dot").className = `state-dot ${snapshot.codex.running ? "success" : snapshot.codex.installed ? "neutral" : "danger"}`;

  const theme = snapshot.activeTheme;
  const hero = byId("hero-card");
  hero.style.backgroundImage = theme?.previewDataUrl ? `url("${theme.previewDataUrl}")` : "none";
  hero.innerHTML = `<div class="hero-copy"><span>${theme?.builtIn ? "内置主题" : "当前主题"}</span><h3>${escapeHtml(theme?.name ?? "未设置")}</h3><p>${escapeHtml(theme?.tagline ?? "请从主题库选择主题")}</p></div>`;
  byId("current-theme-name").textContent = theme?.name ?? "未设置";
  byId("codex-version").textContent = snapshot.codex.installed ? `Codex ${snapshot.codex.version ?? "未知版本"}` : "未找到官方 Codex";
  byId("launch-button").textContent = snapshot.codex.running ? "重启 Codex" : "启动 Codex";
  byId("home-details").innerHTML = `
    <div><span>运行状态</span><strong>${snapshot.codex.running ? "正在运行" : "未运行"}</strong></div>
    <div><span>本机端口</span><strong>${snapshot.port ? `127.0.0.1:${snapshot.port}` : "尚未启用"}</strong></div>
    <div><span>后台守护</span><strong>${snapshot.watcherRunning ? "运行中" : "未运行"}</strong></div>
    ${snapshot.lastError ? `<p class="error-note">${escapeHtml(snapshot.lastError)}</p>` : ""}
  `;
  setButtonsDisabled(busy);
}

function syncAppAccent(themeAccent: string | undefined): void {
  const candidate = themeAccent?.trim() ?? "";
  const accent = candidate && CSS.supports("color", candidate) ? candidate : DEFAULT_ACCENT;
  document.documentElement.style.setProperty("--accent", accent);
  if (accent === appliedAccent) return;
  appliedAccent = accent;
  void invoke("set_app_accent", { accent }).catch((error) => {
    console.warn("同步应用图标颜色失败", error);
  });
}

function renderThemes(): void {
  const list = byId("theme-list");
  if (!themes.length) {
    list.innerHTML = `<div class="empty-library">主题库为空</div>`;
    return;
  }
  list.innerHTML = themes.map((theme) => `
    <article class="theme-card ${theme.id === selectedThemeId ? "selected" : ""}" data-theme-card="${escapeHtml(theme.id)}">
      <button class="theme-select" data-theme-id="${escapeHtml(theme.id)}">
        <span class="theme-preview" style="background-image:url('${theme.previewDataUrl}')"></span>
        <span class="theme-card-body">
          <span class="theme-card-top"><em>${theme.builtIn ? "内置" : "已安装"}</em>${theme.active ? "<i>当前主题</i>" : ""}</span>
          <strong>${escapeHtml(theme.name)}</strong>
          <small>${escapeHtml(theme.tagline || theme.quote)}</small>
          <span class="theme-accent"><i style="background:${escapeHtml(theme.accent)}"></i>${theme.active ? "正在使用" : "点击选择"}</span>
        </span>
      </button>
      ${theme.builtIn ? "" : `<button class="theme-delete" data-delete-theme="${escapeHtml(theme.id)}" title="删除主题" aria-label="删除 ${escapeHtml(theme.name)}">×</button>`}
    </article>
  `).join("");
  list.querySelectorAll<HTMLButtonElement>("[data-theme-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedThemeId = button.dataset.themeId ?? "";
      renderThemes();
    });
  });
  list.querySelectorAll<HTMLButtonElement>("[data-delete-theme]").forEach((button) => {
    button.addEventListener("click", () => void deleteTheme(button.dataset.deleteTheme ?? ""));
  });
  const selected = themes.find((theme) => theme.id === selectedThemeId);
  byId("selected-theme-name").textContent = selected?.name ?? "尚未选择主题";
  setButtonsDisabled(busy);
}

type DesignerProvider = "codex" | "claude";

function switchDesignerProvider(provider: DesignerProvider, focus = false): void {
  document.querySelectorAll<HTMLButtonElement>("[data-designer-provider]").forEach((tab) => {
    const selected = tab.dataset.designerProvider === provider;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  byId("designer-codex-panel").hidden = provider !== "codex";
  byId("designer-claude-panel").hidden = provider !== "claude";
}

function handleDesignerProviderKeydown(event: KeyboardEvent): void {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-designer-provider]"));
  const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  let nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : currentIndex;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
  switchDesignerProvider(tabs[nextIndex]?.dataset.designerProvider === "claude" ? "claude" : "codex", true);
}

function renderDesignerPlugin(): void {
  const state = byId("designer-plugin-state");
  const message = byId("designer-plugin-message");
  const installButton = byId<HTMLButtonElement>("install-designer-plugin-button");
  const uninstallButton = byId<HTMLButtonElement>("uninstall-designer-plugin-button");
  if (!designerPlugin) {
    state.textContent = "检测中";
    state.className = "plugin-state neutral";
    message.textContent = "正在检查 Codex 插件状态";
    installButton.disabled = true;
    uninstallButton.disabled = true;
    renderClaudeDesignerPlugin();
    return;
  }
  if (designerPlugin.conflict) {
    state.textContent = "需要处理";
    state.className = "plugin-state danger";
  } else if (designerPlugin.installed) {
    state.textContent = "已安装";
    state.className = "plugin-state success";
  } else {
    state.textContent = "未安装";
    state.className = "plugin-state neutral";
  }
  message.textContent = designerPlugin.message
    ?? (designerPlugin.installed
      ? `插件 v${designerPlugin.version} 已就绪，请在 Codex 中新建任务使用。`
      : "插件通过本地 MCP 管理主题，不会修改模型或账号配置。");
  installButton.textContent = designerPlugin.installed || designerPlugin.managed
    ? "重新安装主题设计插件"
    : "安装主题设计插件";
  installButton.disabled = busy || !snapshot?.codex.installed || designerPlugin.conflict;
  uninstallButton.disabled = busy || !designerPlugin.managed || designerPlugin.conflict;
  renderClaudeDesignerPlugin();
}

function renderClaudeDesignerPlugin(): void {
  const state = byId("claude-designer-plugin-state");
  const message = byId("claude-designer-plugin-message");
  const installButton = byId<HTMLButtonElement>("install-claude-designer-plugin-button");
  const uninstallButton = byId<HTMLButtonElement>("uninstall-claude-designer-plugin-button");

  if (!claudeDesignerPlugin) {
    state.textContent = "检测中";
    state.className = "plugin-state neutral";
    message.textContent = "正在检查 Claude Code 插件状态";
    installButton.disabled = true;
    uninstallButton.disabled = true;
    return;
  }

  if (!claudeDesignerPlugin.claudeAvailable) {
    state.textContent = "不可用";
    state.className = "plugin-state danger";
  } else if (claudeDesignerPlugin.conflict) {
    state.textContent = "需要处理";
    state.className = "plugin-state danger";
  } else if (claudeDesignerPlugin.installed) {
    state.textContent = "已安装";
    state.className = "plugin-state success";
  } else {
    state.textContent = "未安装";
    state.className = "plugin-state neutral";
  }

  message.textContent = claudeDesignerPlugin.message
    ?? (!claudeDesignerPlugin.claudeAvailable
      ? "未找到 Claude Code，请先完成安装后再返回此处。"
      : claudeDesignerPlugin.installed
        ? `插件 v${claudeDesignerPlugin.version} 已就绪，将沿用 Claude Code 现有配置。`
        : "插件只增加主题设计能力，不会修改 Claude Code 的账号、模型或接口配置。");

  const unavailable = busy || !claudeDesignerPlugin.claudeAvailable || claudeDesignerPlugin.conflict;
  installButton.textContent = claudeDesignerPlugin.installed || claudeDesignerPlugin.managed
    ? "重新安装 Claude Code 插件"
    : "安装 Claude Code 插件";
  installButton.disabled = unavailable;
  uninstallButton.disabled = unavailable || !claudeDesignerPlugin.managed;
}

async function launchCodex(): Promise<void> {
  await runOperation(snapshot?.codex.running ? "正在重启 Codex" : "正在启动 Codex", async () => {
    snapshot = await invoke<AppSnapshot>("launch_codex");
    renderSnapshot();
    showToast("Codex 已启动，当前主题已生效");
  });
}

async function applyCurrentTheme(): Promise<void> {
  await runOperation("正在应用当前主题", async () => {
    snapshot = await invoke<AppSnapshot>("apply_theme");
    renderSnapshot();
    showToast("当前主题已热应用");
  });
}

async function pauseTheme(): Promise<void> {
  await runOperation("正在暂停主题", async () => {
    snapshot = await invoke<AppSnapshot>("pause_theme");
    renderSnapshot();
    showToast("主题已暂停");
  });
}

async function restoreTheme(): Promise<void> {
  const confirmed = await confirmDialog("完全恢复会移除主题，并在需要时重启 Codex 以关闭调试端口。继续吗？", {
    title: "Codex 暖暖",
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation("正在恢复官方外观", async () => {
    snapshot = await invoke<AppSnapshot>("restore_theme");
    renderSnapshot();
    showToast("Codex 已恢复官方启动方式");
  });
}

async function activateSelectedTheme(): Promise<void> {
  if (!selectedThemeId) {
    showToast("请先选择一个主题", true);
    return;
  }
  await runOperation("正在切换主题", async () => {
    snapshot = await invoke<AppSnapshot>("activate_theme", { id: selectedThemeId });
    await refresh(true);
    if (snapshot.session === "active") {
      showToast("主题已热切换");
    } else {
      showToast("已设为当前主题，请启动或重启 Codex 使其生效");
    }
  });
}

async function importThemePackage(): Promise<void> {
  const packagePath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Codex NN 主题包", extensions: ["zip"] }]
  });
  if (typeof packagePath !== "string") return;
  await runOperation("正在检查主题包", async () => {
    let outcome = await invoke<ThemeInstallOutcome>("install_theme_package", {
      request: { packagePath, allowUpdate: false }
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(`主题“${outcome.theme.name}”已经安装。是否更新现有主题？`, {
        title: "更新主题",
        kind: "warning"
      });
      if (!confirmed) return;
      outcome = await invoke<ThemeInstallOutcome>("install_theme_package", {
        request: { packagePath, allowUpdate: true }
      });
    }
    if (!outcome.installed) return;
    selectedThemeId = outcome.theme.id;
    await refresh(true);
    showToast(outcome.updated ? `已更新“${outcome.theme.name}”` : `已安装“${outcome.theme.name}”`);
  });
}

function openDreamImportDialog(): void {
  byId("dream-import-dialog").hidden = false;
  byId<HTMLButtonElement>("choose-dream-folder-button").focus();
}

function closeDreamImportDialog(): void {
  byId("dream-import-dialog").hidden = true;
}

async function chooseDreamSkinSource(directory: boolean): Promise<void> {
  closeDreamImportDialog();
  const sourcePath = await open(directory ? {
    multiple: false,
    directory: true,
    title: "选择 Dream Skin macOS 主题目录"
  } : {
    multiple: false,
    directory: false,
    title: "选择 Dream Skin macOS 主题 ZIP",
    filters: [{ name: "Dream Skin 主题包", extensions: ["zip"] }]
  });
  if (typeof sourcePath !== "string") return;
  await runOperation("正在转换 Dream Skin 主题", async () => {
    let outcome = await invoke<ThemeInstallOutcome>("install_dream_skin_theme", {
      request: { sourcePath, allowUpdate: false }
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(`转换后的主题“${outcome.theme.name}”已经安装。是否更新？`, {
        title: "更新 Dream Skin 主题",
        kind: "warning"
      });
      if (!confirmed) return;
      outcome = await invoke<ThemeInstallOutcome>("install_dream_skin_theme", {
        request: { sourcePath, allowUpdate: true }
      });
    }
    if (!outcome.installed) return;
    selectedThemeId = outcome.theme.id;
    await refresh(true);
    showToast(outcome.updated
      ? `已更新 Dream Skin 主题“${outcome.theme.name}”`
      : `已导入 Dream Skin 主题“${outcome.theme.name}”`);
  });
}

async function installDesignerPlugin(): Promise<void> {
  await runOperation("正在安装主题设计插件", async () => {
    designerPlugin = await invoke<ThemeDesignerPluginStatus>("install_theme_designer_plugin");
    renderDesignerPlugin();
    if (!designerPlugin.installed) {
      throw new Error(designerPlugin.message ?? "主题设计插件未能完成安装");
    }
    showToast("主题设计插件已安装，请在 Codex 中新建任务使用");
  });
}

async function uninstallDesignerPlugin(): Promise<void> {
  const confirmed = await confirmDialog("卸载后，新建的 Codex 任务将不再加载主题设计 Skill。继续吗？", {
    title: "卸载主题设计插件",
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation("正在卸载主题设计插件", async () => {
    designerPlugin = await invoke<ThemeDesignerPluginStatus>("uninstall_theme_designer_plugin");
    renderDesignerPlugin();
    if (designerPlugin.managed || designerPlugin.conflict) {
      throw new Error(designerPlugin.message ?? "主题设计插件未能完成卸载");
    }
    showToast("主题设计插件已卸载");
  });
}

async function installClaudeDesignerPlugin(): Promise<void> {
  await runOperation("正在安装 Claude Code 主题设计插件", async () => {
    claudeDesignerPlugin = await invoke<ClaudeThemeDesignerPluginStatus>("install_claude_theme_designer_plugin");
    renderClaudeDesignerPlugin();
    if (!claudeDesignerPlugin.installed) {
      throw new Error(claudeDesignerPlugin.message ?? "Claude Code 主题设计插件未能完成安装");
    }
    showToast("Claude Code 主题设计插件已安装");
  });
}

async function uninstallClaudeDesignerPlugin(): Promise<void> {
  const confirmed = await confirmDialog("卸载后，Claude Code 将不再加载主题设计插件；现有账号、模型和接口配置不会改变。继续吗？", {
    title: "卸载 Claude Code 主题设计插件",
    kind: "warning"
  });
  if (!confirmed) return;

  await runOperation("正在卸载 Claude Code 主题设计插件", async () => {
    claudeDesignerPlugin = await invoke<ClaudeThemeDesignerPluginStatus>("uninstall_claude_theme_designer_plugin");
    renderClaudeDesignerPlugin();
    if (claudeDesignerPlugin.managed || claudeDesignerPlugin.conflict) {
      throw new Error(claudeDesignerPlugin.message ?? "Claude Code 主题设计插件未能完成卸载");
    }
    showToast("Claude Code 主题设计插件已卸载");
  });
}

async function deleteTheme(id: string): Promise<void> {
  const theme = themes.find((item) => item.id === id);
  if (!theme || theme.builtIn) return;
  const confirmed = await confirmDialog(`确定删除主题“${theme.name}”吗？`, {
    title: "删除主题",
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation("正在删除主题", async () => {
    snapshot = await invoke<AppSnapshot>("delete_theme", { id });
    selectedThemeId = snapshot.activeTheme?.id ?? "";
    await refresh(true);
    showToast(`已删除“${theme.name}”`);
  });
}

async function runDiagnostics(): Promise<void> {
  await runOperation("正在检查本地环境", async () => {
    const report = await invoke<DiagnosticReport>("run_diagnostics");
    const output = byId("diagnostic-results");
    output.classList.remove("empty-state");
    output.innerHTML = report.checks.map((check) => `
      <div class="check-row ${check.pass ? "pass" : "fail"}">
        <span class="check-dot">${check.pass ? "✓" : "!"}</span>
        <span><strong>${escapeHtml(check.name)}</strong><small>${escapeHtml(check.detail)}</small></span>
      </div>
    `).join("");
  });
}

async function chooseScreenshot(): Promise<void> {
  const path = await save({
    defaultPath: "Codex-NN-Verification.png",
    filters: [{ name: "PNG 图片", extensions: ["png"] }]
  });
  if (path) await runVerification(path);
}

async function runVerification(screenshotPath: string | null): Promise<void> {
  await runOperation("正在验证实时主题", async () => {
    const report = await invoke<VerificationReport>("verify_theme", { screenshotPath });
    renderVerification(report);
    showToast(report.message, !report.pass);
  });
}

function renderVerification(report: VerificationReport): void {
  const output = byId("diagnostic-results");
  output.classList.remove("empty-state");
  output.innerHTML = `
    <div class="verification-summary ${report.pass ? "pass" : "fail"}">
      <span>${report.pass ? "✓" : "!"}</span>
      <div><strong>${report.pass ? "实时验证通过" : "实时验证未通过"}</strong><small>${escapeHtml(report.message)}</small></div>
    </div>
    <div class="result-detail"><span>CDP 目标</span><strong>${report.targetCount} 个</strong></div>
    <div class="result-detail"><span>端口</span><strong>${report.port ? `127.0.0.1:${report.port}` : "无"}</strong></div>
    ${report.screenshotPath ? `<p class="path-note">截图：${escapeHtml(report.screenshotPath)}</p>` : ""}
    <details><summary>查看原始验证数据</summary><pre>${escapeHtml(JSON.stringify(report.details, null, 2))}</pre></details>
  `;
}

async function runOperation(label: string, action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  showToast(label);
  try {
    await action();
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    busy = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>("[data-operation], .theme-delete, .theme-select")
    .forEach((button) => { button.disabled = disabled; });
  byId<HTMLButtonElement>("check-update-button").disabled = disabled || checkingForUpdates;
  if (!disabled) {
    byId<HTMLButtonElement>("launch-button").disabled = !snapshot?.codex.installed;
    byId<HTMLButtonElement>("apply-button").disabled = !snapshot?.activeTheme;
    byId<HTMLButtonElement>("activate-theme-button").disabled = !selectedThemeId;
  }
  renderDesignerPlugin();
}

function showToast(message: string, error = false): void {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast show ${error ? "error" : ""}`;
  window.clearTimeout(Number(toast.dataset.timer ?? 0));
  const timer = window.setTimeout(() => toast.classList.remove("show"), error ? 6500 : 3200);
  toast.dataset.timer = String(timer);
}

function sessionMeta(state: SessionState): { label: string; kind: string } {
  return {
    off: { label: "未启用", kind: "neutral" },
    starting: { label: "处理中", kind: "working" },
    active: { label: "主题已启用", kind: "success" },
    paused: { label: "已暂停", kind: "warning" },
    stale: { label: "等待启动", kind: "warning" },
    error: { label: "运行异常", kind: "danger" }
  }[state];
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return "发生未知错误"; }
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

void listen<{ phase: string; message: string }>("theme://progress", (event) => showToast(event.payload.message));
void listen<AppSnapshot>("theme://status-changed", (event) => {
  snapshot = event.payload;
  renderSnapshot();
});
void listen("theme://request-restore", () => void restoreTheme());
void listen<string>("theme://operation-error", (event) => showToast(event.payload, true));

void refresh(false)
  .then(() => checkForUpdates())
  .catch((error) => {
    showToast(errorMessage(error), true);
    byId("header-status").textContent = "初始化失败";
  });
