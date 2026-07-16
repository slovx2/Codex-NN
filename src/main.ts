import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type {
  AppSnapshot,
  DiagnosticReport,
  SessionState,
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
let busy = false;

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
        <button class="nav-item" data-page="diagnostics"><span>⌁</span><b>诊断</b></button>
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
          <button id="import-theme-button" class="button primary compact-button" data-operation>＋ 安装主题包</button>
        </header>
        <div id="theme-list" class="theme-grid"></div>
        <footer class="theme-footer">
          <div><span>已选择</span><strong id="selected-theme-name">尚未选择主题</strong></div>
          <button id="activate-theme-button" class="button primary compact-button" data-operation>应用主题</button>
        </footer>
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
    </main>
  </div>
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
byId("activate-theme-button").addEventListener("click", () => void activateSelectedTheme());
byId("diagnose-button").addEventListener("click", () => void runDiagnostics());
byId("verify-button").addEventListener("click", () => void runVerification(null));
byId("screenshot-button").addEventListener("click", () => void chooseScreenshot());

async function refresh(preserveSelection = true): Promise<void> {
  const previousSelection = preserveSelection ? selectedThemeId : "";
  [snapshot, themes] = await Promise.all([
    invoke<AppSnapshot>("get_app_snapshot"),
    invoke<ThemeSummary[]>("list_themes")
  ]);
  selectedThemeId = themes.some((theme) => theme.id === previousSelection)
    ? previousSelection
    : snapshot.activeTheme?.id ?? themes[0]?.id ?? "";
  renderSnapshot();
  renderThemes();
}

async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    const confirmed = await confirmDialog(
      `发现新版本 ${update.version}。是否立即下载并安装？`,
      { title: "Codex 暖暖更新", kind: "info" }
    );
    if (!confirmed) return;
    await runOperation("正在下载更新", async () => {
      await update.downloadAndInstall();
      const restart = await confirmDialog("更新已安装。是否立即重启 Codex 暖暖？", {
        title: "更新完成",
        kind: "info"
      });
      if (restart) await relaunch();
    });
  } catch (error) {
    console.warn("自动检查更新失败", error);
  }
}

function renderSnapshot(): void {
  if (!snapshot) return;
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
  if (!disabled) {
    byId<HTMLButtonElement>("launch-button").disabled = !snapshot?.codex.installed;
    byId<HTMLButtonElement>("apply-button").disabled = !snapshot?.activeTheme;
    byId<HTMLButtonElement>("activate-theme-button").disabled = !selectedThemeId;
  }
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
