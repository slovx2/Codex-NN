import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { confirmDialog } from "./app-dialog";
import {
  currentSystemLocale,
  resolveSystemLanguage,
  setResolvedLanguage,
  t,
  type LanguagePreference,
  type LanguageSettings
} from "./i18n";
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

const systemLocale = currentSystemLocale();
let languageSettings = await invoke<LanguageSettings>("sync_language", { systemLocale })
  .catch((): LanguageSettings => ({
    preference: "system",
    resolvedLanguage: resolveSystemLanguage(systemLocale)
  }));
setResolvedLanguage(languageSettings.resolvedLanguage);

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error(t("missingRoot"));

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
        <div><h1>${t("appName")}</h1><p>${t("appSubtitle")}</p></div>
      </div>
      <nav class="navigation" aria-label="${t("navAria")}">
        <button class="nav-item active" data-page="home"><span>⌂</span><b>${t("home")}</b></button>
        <button class="nav-item" data-page="themes"><span>◫</span><b>${t("themes")}</b></button>
        ${MARKETPLACE_ENABLED ? `<button class="nav-item" data-page="marketplace"><span>◎</span><b>${t("marketplace")}</b></button>` : ""}
        <button class="nav-item" data-page="designer"><span>✦</span><b>${t("designer")}</b></button>
        <button class="nav-item" data-page="diagnostics"><span>⌁</span><b>${t("diagnostics")}</b></button>
        <button id="settings-nav-item" class="nav-item" data-page="settings"><span>⚙</span><b>${t("settings")}</b><i id="settings-update-dot" class="nav-update-dot" hidden></i></button>
      </nav>
      <div class="sidebar-status">
        <div class="sidebar-status-row"><span id="codex-dot" class="state-dot"></span><span>Codex</span><strong id="codex-state">${t("loading")}</strong></div>
        <div class="sidebar-status-row"><span id="theme-dot" class="state-dot"></span><span>${t("currentTheme")}</span><strong id="theme-state">${t("loading")}</strong></div>
      </div>
    </aside>

    <main class="workspace">
      <section id="page-home" class="page active">
        <header class="page-heading">
          <div><span class="eyebrow">OVERVIEW</span><h2>${t("overviewTitle")}</h2><p>${t("overviewDescription")}</p></div>
          <span id="header-status" class="status-pill neutral">${t("loading")}</span>
        </header>
        <div class="home-layout">
          <article class="preview-panel">
            <div id="hero-card" class="hero-card"></div>
            <div class="preview-meta">
              <div><span>${t("currentTheme")}</span><h3 id="current-theme-name">${t("notSet")}</h3></div>
              <button class="text-button" data-open-page="themes">${t("changeTheme")}</button>
            </div>
          </article>
          <article class="control-panel">
            <div class="codex-heading">
              <div class="codex-icon">C</div>
              <div><span>${t("officialCodex")}</span><h3 id="codex-version">${t("detecting")}</h3></div>
            </div>
            <div class="primary-action-block">
              <button id="launch-button" class="button primary" data-operation>${t("launchCodex")}</button>
              <small>${t("launchHint")}</small>
            </div>
            <button id="apply-button" class="button secondary" data-operation>${t("applyCurrentTheme")}</button>
            <div class="secondary-actions">
              <button id="pause-button" class="button subtle" data-operation>${t("pauseTheme")}</button>
              <button id="restore-button" class="button subtle danger" data-operation>${t("restoreCompletely")}</button>
            </div>
            <div id="home-details" class="status-list"></div>
          </article>
        </div>
      </section>

      <section id="page-themes" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">LOCAL LIBRARY</span><h2>${t("localLibraryTitle")}</h2><p>${t("localLibraryDescription")}</p></div>
          <div class="heading-actions">
            ${MARKETPLACE_ENABLED ? `<button class="button subtle compact-button" data-open-page="marketplace">${t("browseMarketplace")}</button>` : ""}
            <button id="import-dream-skin-button" class="button secondary compact-button" data-operation>${t("importDreamSkin")}</button>
            <button id="import-theme-button" class="button primary compact-button" data-operation>${t("installThemePackage")}</button>
          </div>
        </header>
        <div id="theme-list" class="theme-grid"></div>
        <footer class="theme-footer">
          <div><span>${t("selected")}</span><strong id="selected-theme-name">${t("noThemeSelected")}</strong></div>
          <button id="activate-theme-button" class="button primary compact-button" data-operation>${t("applyTheme")}</button>
        </footer>
      </section>

      ${MARKETPLACE_ENABLED ? `<section id="page-marketplace" class="page">
        <header class="page-heading compact marketplace-heading">
          <div><span class="eyebrow">THEME PLAZA</span><h2>${t("marketplace")}</h2><p>${t("marketplaceDescription")}</p></div>
          <div class="marketplace-tabs" role="tablist" aria-label="${t("marketplace")}">
            <button id="marketplace-discover-tab" class="marketplace-tab active" role="tab" aria-selected="true">${t("discoverThemes")}</button>
            <button id="marketplace-mine-tab" class="marketplace-tab" role="tab" aria-selected="false">${t("myUploads")}</button>
          </div>
        </header>
        <div id="marketplace-content" class="marketplace-content">
          <div class="marketplace-loading">${t("connectingMarketplace")}</div>
        </div>
      </section>` : ""}

      <section id="page-designer" class="page">
        <header class="page-heading compact designer-heading">
          <div><span class="eyebrow">THEME STUDIO</span><h2>${t("designerTitle")}</h2><p>${t("designerDescription")}</p></div>
          <div class="designer-provider-tabs" role="tablist" aria-label="${t("designerProviderAria")}">
            <button id="designer-provider-codex-tab" class="designer-provider-tab active" type="button" role="tab" aria-selected="true" aria-controls="designer-codex-panel" tabindex="0" data-designer-provider="codex">Codex</button>
            <button id="designer-provider-claude-tab" class="designer-provider-tab" type="button" role="tab" aria-selected="false" aria-controls="designer-claude-panel" tabindex="-1" data-designer-provider="claude">Claude Code</button>
          </div>
        </header>
        <div class="designer-layout">
          <article class="designer-hero">
            <span class="designer-spark">✦</span>
            <div><span>CODEX NN THEME DESIGNER</span><h3>${t("designerHeroTitle")}</h3><p>${t("designerHeroDescription")}</p></div>
          </article>
          <article id="designer-codex-panel" class="plugin-panel" role="tabpanel" aria-labelledby="designer-provider-codex-tab">
            <div class="plugin-heading">
              <div class="plugin-icon">NN</div>
              <div><span>${t("codexPlugin")}</span><h3>${t("themeDesignerPlugin")}</h3></div>
              <strong id="designer-plugin-state" class="plugin-state neutral">${t("checking")}</strong>
            </div>
            <p>${t("pluginDescription")}</p>
            <ol class="designer-steps">
              <li><i>1</i><span><b>${t("provideIdea")}</b><small>${t("ideaHint")}</small></span></li>
              <li><i>2</i><span><b>${t("confirmConcept")}</b><small>${t("conceptHint")}</small></span></li>
              <li><i>3</i><span><b>${t("getThemePackage")}</b><small>${t("packageHint")}</small></span></li>
            </ol>
            <div id="designer-plugin-message" class="plugin-message">${t("checkingPlugin")}</div>
            <div class="plugin-actions">
              <button id="install-designer-plugin-button" class="button primary" data-operation disabled>${t("installPlugin")}</button>
              <button id="uninstall-designer-plugin-button" class="button subtle danger" data-operation disabled>${t("uninstallPlugin")}</button>
            </div>
          </article>
          <article id="designer-claude-panel" class="plugin-panel claude-plugin-panel" role="tabpanel" aria-labelledby="designer-provider-claude-tab" hidden>
            <div class="plugin-heading">
              <div class="plugin-icon claude-plugin-icon">CC</div>
              <div><span>${t("claudeCodePlugin")}</span><h3>${t("themeDesignerPlugin")}</h3></div>
              <strong id="claude-designer-plugin-state" class="plugin-state neutral">${t("checking")}</strong>
            </div>
            <p>${t("claudePluginDescription")}</p>
            <ol class="designer-steps">
              <li><i>1</i><span><b>${t("installClaudeStep")}</b><small>${t("installClaudeStepHint")}</small></span></li>
              <li><i>2</i><span><b>${t("describeTheme")}</b><small>${t("describeThemeHint")}</small></span></li>
              <li><i>3</i><span><b>${t("previewAndHotUpdate")}</b><small>${t("previewAndHotUpdateHint")}</small></span></li>
            </ol>
            <div id="claude-designer-plugin-message" class="plugin-message">${t("checkingClaudePlugin")}</div>
            <div class="plugin-actions">
              <button id="install-claude-designer-plugin-button" class="button primary" data-operation disabled>${t("installClaudePlugin")}</button>
              <button id="uninstall-claude-designer-plugin-button" class="button subtle danger" data-operation disabled>${t("uninstallPlugin")}</button>
            </div>
          </article>
        </div>
      </section>

      <section id="page-diagnostics" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">DIAGNOSTICS</span><h2>${t("diagnosticsTitle")}</h2><p>${t("diagnosticsDescription")}</p></div>
        </header>
        <div class="diagnostic-actions">
          <button id="diagnose-button" class="diagnostic-action" data-operation><span>✓</span><b>${t("staticDiagnostics")}</b><small>${t("staticDiagnosticsHint")}</small></button>
          <button id="verify-button" class="diagnostic-action" data-operation><span>◉</span><b>${t("liveVerification")}</b><small>${t("liveVerificationHint")}</small></button>
          <button id="screenshot-button" class="diagnostic-action" data-operation><span>▣</span><b>${t("verifyAndScreenshot")}</b><small>${t("verifyAndScreenshotHint")}</small></button>
        </div>
        <div id="diagnostic-results" class="diagnostic-results empty-state">${t("noDiagnosticResults")}</div>
      </section>

      <section id="page-settings" class="page">
        <header class="page-heading compact">
          <div><span class="eyebrow">SETTINGS</span><h2>${t("settings")}</h2></div>
        </header>
        <div class="settings-list">
          <label class="settings-row" for="language-select">
            <span><strong>${t("language")}</strong><small>${t("languageDescription")}</small></span>
            <select id="language-select" class="settings-select">
              <option value="system" ${languageSettings.preference === "system" ? "selected" : ""}>${t("followSystem")}</option>
              <option value="zh-CN" ${languageSettings.preference === "zh-CN" ? "selected" : ""}>${t("simplifiedChinese")}</option>
              <option value="en" ${languageSettings.preference === "en" ? "selected" : ""}>${t("english")}</option>
            </select>
          </label>
          <div class="settings-row">
            <span><strong>${t("checkForUpdates")}</strong></span>
            <button id="check-update-button" class="button secondary compact-button" data-operation>${t("checkForUpdates")}</button>
          </div>
        </div>
      </section>
    </main>
  </div>
  <div id="dream-import-dialog" class="modal-backdrop" hidden>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="dream-import-title">
      <button id="close-dream-import-button" class="modal-close" aria-label="${t("close")}">×</button>
      <span class="eyebrow">DREAM SKIN IMPORT</span>
      <h3 id="dream-import-title">${t("dreamImportTitle")}</h3>
      <p>${t("dreamImportDescription")}</p>
      <div class="dream-import-options">
        <button id="choose-dream-folder-button" class="import-option" data-operation><span>▤</span><b>${t("chooseThemeDirectory")}</b><small>${t("directoryHint")}</small></button>
        <button id="choose-dream-zip-button" class="import-option" data-operation><span>◇</span><b>${t("chooseZip")}</b><small>${t("zipHint")}</small></button>
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
  if (!element) throw new Error(t("missingElement", { id }));
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
const restoredPage = window.sessionStorage.getItem("codexnn:page");
if (restoredPage && document.getElementById(`page-${restoredPage}`)) showPage(restoredPage);
window.sessionStorage.removeItem("codexnn:page");

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
byId<HTMLSelectElement>("language-select").addEventListener("change", (event) => {
  void changeLanguage((event.currentTarget as HTMLSelectElement).value as LanguagePreference);
});

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
      version: t("unknown"),
      message: t("readingPluginFailed", { error: errorMessage(error) })
    }));
  const claudePluginStatus = invoke<ClaudeThemeDesignerPluginStatus>("get_claude_theme_designer_plugin_status")
    .catch((error): ClaudeThemeDesignerPluginStatus => ({
      installed: false,
      managed: false,
      conflict: true,
      version: t("unknown"),
      message: t("readingClaudePluginFailed", { error: errorMessage(error) }),
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

async function changeLanguage(preference: LanguagePreference): Promise<void> {
  const select = byId<HTMLSelectElement>("language-select");
  select.disabled = true;
  try {
    languageSettings = await invoke<LanguageSettings>("set_language_preference", {
      preference,
      systemLocale
    });
    const activePage = document.querySelector<HTMLElement>(".page.active")?.id.replace("page-", "") ?? "home";
    window.sessionStorage.setItem("codexnn:page", activePage);
    window.location.reload();
  } catch (error) {
    select.value = languageSettings.preference;
    select.disabled = false;
    showToast(t("languageChangeFailed", { error: errorMessage(error) }), true);
  }
}

async function checkForUpdates(manual = false): Promise<void> {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const updateButton = byId<HTMLButtonElement>("check-update-button");
  updateButton.disabled = true;
  updateButton.textContent = t("checkingUpdates");
  try {
    const update = await check();
    if (!update) {
      setUpdateAvailable(false);
      if (manual) showToast(t("alreadyLatest"));
      return;
    }
    setUpdateAvailable(true);
    const confirmed = await confirmDialog(
      t("updateAvailable", { version: update.version }),
      { title: t("updateTitle"), kind: "info" }
    );
    if (!confirmed) return;
    await runOperation(t("downloadingUpdate"), async () => {
      await update.downloadAndInstall();
      setUpdateAvailable(false);
      const restart = await confirmDialog(t("updateInstalledRestart"), {
        title: t("updateComplete"),
        kind: "info"
      });
      if (restart) await relaunch();
    });
  } catch (error) {
    console.warn("自动检查更新失败", error);
    if (manual) showToast(t("updateCheckFailed", { error: errorMessage(error) }), true);
  } finally {
    checkingForUpdates = false;
    updateButton.textContent = t("checkForUpdates");
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
  byId("codex-state").textContent = snapshot.codex.running ? t("running") : snapshot.codex.installed ? t("notRunning") : t("notInstalled");
  byId("codex-dot").className = `state-dot ${snapshot.codex.running ? "success" : snapshot.codex.installed ? "neutral" : "danger"}`;

  const theme = snapshot.activeTheme;
  const hero = byId("hero-card");
  hero.style.backgroundImage = theme?.previewDataUrl ? `url("${theme.previewDataUrl}")` : "none";
  hero.innerHTML = `<div class="hero-copy"><span>${theme?.builtIn ? t("builtInTheme") : t("currentTheme")}</span><h3>${escapeHtml(theme?.name ?? t("notSet"))}</h3><p>${escapeHtml(theme?.tagline ?? t("chooseFromLibrary"))}</p></div>`;
  byId("current-theme-name").textContent = theme?.name ?? t("notSet");
  byId("codex-version").textContent = snapshot.codex.installed ? `Codex ${snapshot.codex.version ?? t("unknownVersion")}` : t("codexNotFound");
  byId("launch-button").textContent = snapshot.codex.running ? t("restartCodex") : t("launchCodex");
  byId("home-details").innerHTML = `
    <div><span>${t("runtimeStatus")}</span><strong>${snapshot.codex.running ? t("running") : t("notRunning")}</strong></div>
    <div><span>${t("localPort")}</span><strong>${snapshot.port ? `127.0.0.1:${snapshot.port}` : t("notEnabled")}</strong></div>
    <div><span>${t("backgroundWatcher")}</span><strong>${snapshot.watcherRunning ? t("running") : t("notRunning")}</strong></div>
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
    list.innerHTML = `<div class="empty-library">${t("themeLibraryEmpty")}</div>`;
    return;
  }
  list.innerHTML = themes.map((theme) => `
    <article class="theme-card ${theme.id === selectedThemeId ? "selected" : ""}" data-theme-card="${escapeHtml(theme.id)}">
      <button class="theme-select" data-theme-id="${escapeHtml(theme.id)}">
        <span class="theme-preview" style="background-image:url('${theme.previewDataUrl}')"></span>
        <span class="theme-card-body">
          <span class="theme-card-top"><em>${theme.builtIn ? t("builtIn") : t("installed")}</em>${theme.active ? `<i>${t("currentTheme")}</i>` : ""}</span>
          <strong>${escapeHtml(theme.name)}</strong>
          <small>${escapeHtml(theme.tagline || theme.quote)}</small>
          <span class="theme-accent"><i style="background:${escapeHtml(theme.accent)}"></i>${theme.active ? t("inUse") : t("clickToSelect")}</span>
        </span>
      </button>
      ${theme.builtIn ? "" : `<button class="theme-delete" data-delete-theme="${escapeHtml(theme.id)}" title="${t("deleteThemeTitle")}" aria-label="${escapeHtml(t("deleteNamedThemeAria", { name: theme.name }))}">×</button>`}
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
  byId("selected-theme-name").textContent = selected?.name ?? t("noThemeSelected");
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
    state.textContent = t("checking");
    state.className = "plugin-state neutral";
    message.textContent = t("checkingPlugin");
    installButton.disabled = true;
    uninstallButton.disabled = true;
    renderClaudeDesignerPlugin();
    return;
  }
  if (designerPlugin.conflict) {
    state.textContent = t("needsAttention");
    state.className = "plugin-state danger";
  } else if (designerPlugin.installed) {
    state.textContent = t("readyInstalled");
    state.className = "plugin-state success";
  } else {
    state.textContent = t("notInstalled");
    state.className = "plugin-state neutral";
  }
  message.textContent = designerPlugin.message
    ?? (designerPlugin.installed
      ? t("pluginReady", { version: designerPlugin.version })
      : t("pluginNotInstalledHint"));
  installButton.textContent = designerPlugin.installed || designerPlugin.managed
    ? t("reinstallPlugin")
    : t("installPlugin");
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
    state.textContent = t("checking");
    state.className = "plugin-state neutral";
    message.textContent = t("checkingClaudePlugin");
    installButton.disabled = true;
    uninstallButton.disabled = true;
    return;
  }

  if (!claudeDesignerPlugin.claudeAvailable) {
    state.textContent = t("unavailable");
    state.className = "plugin-state danger";
  } else if (claudeDesignerPlugin.conflict) {
    state.textContent = t("needsAttention");
    state.className = "plugin-state danger";
  } else if (claudeDesignerPlugin.installed) {
    state.textContent = t("readyInstalled");
    state.className = "plugin-state success";
  } else {
    state.textContent = t("notInstalled");
    state.className = "plugin-state neutral";
  }

  message.textContent = claudeDesignerPlugin.message
    ?? (!claudeDesignerPlugin.claudeAvailable
      ? t("claudeNotFound")
      : claudeDesignerPlugin.installed
        ? t("claudePluginReady", { version: claudeDesignerPlugin.version })
        : t("claudePluginNotInstalledHint"));

  const unavailable = busy || !claudeDesignerPlugin.claudeAvailable || claudeDesignerPlugin.conflict;
  installButton.textContent = claudeDesignerPlugin.installed || claudeDesignerPlugin.managed
    ? t("reinstallClaudePlugin")
    : t("installClaudePlugin");
  installButton.disabled = unavailable;
  uninstallButton.disabled = unavailable || !claudeDesignerPlugin.managed;
}

async function launchCodex(): Promise<void> {
  await runOperation(snapshot?.codex.running ? t("restartingCodex") : t("launchingCodex"), async () => {
    snapshot = await invoke<AppSnapshot>("launch_codex");
    renderSnapshot();
    showToast(t("codexLaunched"));
  });
}

async function applyCurrentTheme(): Promise<void> {
  await runOperation(t("applyingCurrentTheme"), async () => {
    snapshot = await invoke<AppSnapshot>("apply_theme");
    renderSnapshot();
    showToast(t("currentThemeApplied"));
  });
}

async function pauseTheme(): Promise<void> {
  await runOperation(t("pausingTheme"), async () => {
    snapshot = await invoke<AppSnapshot>("pause_theme");
    renderSnapshot();
    showToast(t("themePaused"));
  });
}

async function restoreTheme(): Promise<void> {
  const confirmed = await confirmDialog(t("restoreConfirmation"), {
    title: t("appName"),
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation(t("restoringOfficialAppearance"), async () => {
    snapshot = await invoke<AppSnapshot>("restore_theme");
    renderSnapshot();
    showToast(t("restoredOfficialLaunch"));
  });
}

async function activateSelectedTheme(): Promise<void> {
  if (!selectedThemeId) {
    showToast(t("chooseThemeFirst"), true);
    return;
  }
  await runOperation(t("switchingTheme"), async () => {
    snapshot = await invoke<AppSnapshot>("activate_theme", { id: selectedThemeId });
    await refresh(true);
    if (snapshot.session === "active") {
      showToast(t("themeSwitchedLive"));
    } else {
      showToast(t("themeSelectedRestart"));
    }
  });
}

async function importThemePackage(): Promise<void> {
  const packagePath = await open({
    multiple: false,
    directory: false,
    filters: [{ name: t("themePackageFilter"), extensions: ["zip"] }]
  });
  if (typeof packagePath !== "string") return;
  await runOperation(t("checkingThemePackage"), async () => {
    let outcome = await invoke<ThemeInstallOutcome>("install_theme_package", {
      request: { packagePath, allowUpdate: false }
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(t("themeAlreadyInstalled", { name: outcome.theme.name }), {
        title: t("updateTheme"),
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
    showToast(outcome.updated
      ? t("themeUpdated", { name: outcome.theme.name })
      : t("themeInstalled", { name: outcome.theme.name }));
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
    title: t("chooseDreamDirectoryTitle")
  } : {
    multiple: false,
    directory: false,
    title: t("chooseDreamZipTitle"),
    filters: [{ name: t("dreamSkinPackage"), extensions: ["zip"] }]
  });
  if (typeof sourcePath !== "string") return;
  await runOperation(t("convertingDreamSkin"), async () => {
    let outcome = await invoke<ThemeInstallOutcome>("install_dream_skin_theme", {
      request: { sourcePath, allowUpdate: false }
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(t("convertedThemeAlreadyInstalled", { name: outcome.theme.name }), {
        title: t("updateDreamSkinTheme"),
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
      ? t("dreamSkinUpdated", { name: outcome.theme.name })
      : t("dreamSkinImported", { name: outcome.theme.name }));
  });
}

async function installDesignerPlugin(): Promise<void> {
  await runOperation(t("installingPlugin"), async () => {
    designerPlugin = await invoke<ThemeDesignerPluginStatus>("install_theme_designer_plugin");
    renderDesignerPlugin();
    if (!designerPlugin.installed) {
      throw new Error(designerPlugin.message ?? t("pluginInstallIncomplete"));
    }
    showToast(t("pluginInstalled"));
  });
}

async function uninstallDesignerPlugin(): Promise<void> {
  const confirmed = await confirmDialog(t("pluginUninstallConfirmation"), {
    title: t("uninstallPluginTitle"),
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation(t("uninstallingPlugin"), async () => {
    designerPlugin = await invoke<ThemeDesignerPluginStatus>("uninstall_theme_designer_plugin");
    renderDesignerPlugin();
    if (designerPlugin.managed || designerPlugin.conflict) {
      throw new Error(designerPlugin.message ?? t("pluginUninstallIncomplete"));
    }
    showToast(t("pluginUninstalled"));
  });
}

async function installClaudeDesignerPlugin(): Promise<void> {
  await runOperation(t("installingClaudePlugin"), async () => {
    claudeDesignerPlugin = await invoke<ClaudeThemeDesignerPluginStatus>("install_claude_theme_designer_plugin");
    renderClaudeDesignerPlugin();
    if (!claudeDesignerPlugin.installed) {
      throw new Error(claudeDesignerPlugin.message ?? t("claudePluginInstallIncomplete"));
    }
    showToast(t("claudePluginInstalled"));
  });
}

async function uninstallClaudeDesignerPlugin(): Promise<void> {
  const confirmed = await confirmDialog(t("claudePluginUninstallConfirmation"), {
    title: t("uninstallClaudePluginTitle"),
    kind: "warning"
  });
  if (!confirmed) return;

  await runOperation(t("uninstallingClaudePlugin"), async () => {
    claudeDesignerPlugin = await invoke<ClaudeThemeDesignerPluginStatus>("uninstall_claude_theme_designer_plugin");
    renderClaudeDesignerPlugin();
    if (claudeDesignerPlugin.managed || claudeDesignerPlugin.conflict) {
      throw new Error(claudeDesignerPlugin.message ?? t("claudePluginUninstallIncomplete"));
    }
    showToast(t("claudePluginUninstalled"));
  });
}

async function deleteTheme(id: string): Promise<void> {
  const theme = themes.find((item) => item.id === id);
  if (!theme || theme.builtIn) return;
  const confirmed = await confirmDialog(t("deleteThemeConfirmation", { name: theme.name }), {
    title: t("deleteTheme"),
    kind: "warning"
  });
  if (!confirmed) return;
  await runOperation(t("deletingTheme"), async () => {
    snapshot = await invoke<AppSnapshot>("delete_theme", { id });
    selectedThemeId = snapshot.activeTheme?.id ?? "";
    await refresh(true);
    showToast(t("themeDeleted", { name: theme.name }));
  });
}

async function runDiagnostics(): Promise<void> {
  await runOperation(t("checkingEnvironment"), async () => {
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
    filters: [{ name: t("pngImage"), extensions: ["png"] }]
  });
  if (path) await runVerification(path);
}

async function runVerification(screenshotPath: string | null): Promise<void> {
  await runOperation(t("verifyingTheme"), async () => {
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
      <div><strong>${report.pass ? t("verificationPassed") : t("verificationFailed")}</strong><small>${escapeHtml(report.message)}</small></div>
    </div>
    <div class="result-detail"><span>${t("cdpTargets")}</span><strong>${t("countUnit", { count: report.targetCount })}</strong></div>
    <div class="result-detail"><span>${t("port")}</span><strong>${report.port ? `127.0.0.1:${report.port}` : t("none")}</strong></div>
    ${report.screenshotPath ? `<p class="path-note">${escapeHtml(t("screenshotPath", { path: report.screenshotPath }))}</p>` : ""}
    <details><summary>${t("rawVerificationData")}</summary><pre>${escapeHtml(JSON.stringify(report.details, null, 2))}</pre></details>
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
    off: { label: t("sessionOff"), kind: "neutral" },
    starting: { label: t("sessionStarting"), kind: "working" },
    active: { label: t("sessionActive"), kind: "success" },
    paused: { label: t("sessionPaused"), kind: "warning" },
    stale: { label: t("sessionStale"), kind: "warning" },
    error: { label: t("sessionError"), kind: "danger" }
  }[state];
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try { return JSON.stringify(error); } catch { return t("unknownError"); }
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
    byId("header-status").textContent = t("initializationFailed");
  });
