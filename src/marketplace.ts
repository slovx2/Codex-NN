import { invoke } from "@tauri-apps/api/core";
import { confirm as confirmDialog, open, save } from "@tauri-apps/plugin-dialog";
import type {
  MarketplaceAuthState,
  MarketplaceLocalSyncState,
  MarketplaceLoginResult,
  MarketplacePage,
  MarketplaceThemeCard,
  MarketplaceThemeDetail,
  MarketplaceUploadOutcome,
  MarketplaceUploadRecord,
  MarketplaceUser,
  ThemeInstallOutcome,
  ThemeSummary
} from "./types";

type MarketplaceOptions = {
  getInstalledThemes: () => ThemeSummary[];
  refreshLocalThemes: () => Promise<void>;
  showToast: (message: string, error?: boolean) => void;
  errorMessage: (error: unknown) => string;
};

type MarketplaceTab = "discover" | "mine";

export function setupMarketplace(options: MarketplaceOptions): void {
  const content = byId("marketplace-content");
  const discoverTab = byId<HTMLButtonElement>("marketplace-discover-tab");
  const mineTab = byId<HTMLButtonElement>("marketplace-mine-tab");
  const detailDialog = byId("marketplace-detail-dialog");
  const detailCard = byId("marketplace-detail-card");

  let activeTab: MarketplaceTab = "discover";
  let activePage = false;
  let query = "";
  let sort = "latest";
  let page = 1;
  let themesPage: MarketplacePage | null = null;
  let discoverError = "";
  let discoverLoading = false;
  let discoverRequest = 0;
  let auth: MarketplaceAuthState | null = null;
  let uploads: MarketplaceUploadRecord[] = [];
  let localSyncStates: MarketplaceLocalSyncState[] = [];
  let mineError = "";
  let mineLoading = false;
  let mineBusy = false;
  let pollingTimer = 0;

  discoverTab.addEventListener("click", () => switchTab("discover"));
  mineTab.addEventListener("click", () => switchTab("mine"));
  detailDialog.addEventListener("click", (event) => {
    if (event.target === detailDialog) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !detailDialog.hidden) closeDetail();
  });
  window.addEventListener("codexnn:page-changed", (event) => {
    activePage = (event as CustomEvent<string>).detail === "marketplace";
    if (activePage) {
      if (activeTab === "discover" && !themesPage && !discoverLoading) void loadDiscover();
      if (activeTab === "mine") void refreshMine(true);
    }
    updatePolling();
  });
  document.addEventListener("visibilitychange", () => {
    updatePolling();
    if (document.visibilityState === "visible" && activePage && activeTab === "mine") {
      void refreshMine(true);
    }
  });
  window.addEventListener("focus", () => {
    if (activePage && activeTab === "mine") void refreshMine(true);
  });

  function switchTab(tab: MarketplaceTab): void {
    activeTab = tab;
    discoverTab.classList.toggle("active", tab === "discover");
    mineTab.classList.toggle("active", tab === "mine");
    discoverTab.setAttribute("aria-selected", String(tab === "discover"));
    mineTab.setAttribute("aria-selected", String(tab === "mine"));
    if (tab === "discover") {
      renderDiscover();
      if (!themesPage && !discoverLoading) void loadDiscover();
    } else {
      renderMine();
      void refreshMine(true);
    }
    updatePolling();
  }

  async function loadDiscover(): Promise<void> {
    const requestId = ++discoverRequest;
    discoverLoading = true;
    discoverError = "";
    renderDiscover();
    try {
      const result = await invoke<MarketplacePage>("marketplace_list_themes", {
        query,
        sort,
        page
      });
      if (requestId !== discoverRequest) return;
      themesPage = result;
      page = result.page;
    } catch (error) {
      if (requestId !== discoverRequest) return;
      discoverError = options.errorMessage(error);
    } finally {
      if (requestId === discoverRequest) {
        discoverLoading = false;
        renderDiscover();
      }
    }
  }

  function renderDiscover(): void {
    content.innerHTML = `
      <div class="marketplace-toolbar">
        <form id="marketplace-search-form" class="marketplace-search">
          <input id="marketplace-search-input" value="${escapeHtml(query)}" maxlength="80" placeholder="搜索名称、ID、作者或简介" aria-label="搜索主题">
          <button class="button primary compact-button" type="submit">搜索</button>
        </form>
        <select id="marketplace-sort" class="marketplace-select" aria-label="主题排序">
          <option value="latest" ${sort === "latest" ? "selected" : ""}>最新发布</option>
          <option value="popular" ${sort === "popular" ? "selected" : ""}>下载最多</option>
        </select>
      </div>
      <div class="marketplace-results">
        ${discoverBody()}
      </div>
      ${themesPage && themesPage.pages > 0 ? `
        <footer class="marketplace-pagination">
          <span>共 ${themesPage.total} 个主题 · 第 ${themesPage.page} / ${themesPage.pages} 页</span>
          <div>
            <button id="marketplace-prev" class="button subtle compact-button" ${themesPage.page <= 1 ? "disabled" : ""}>上一页</button>
            <button id="marketplace-next" class="button subtle compact-button" ${themesPage.page >= themesPage.pages ? "disabled" : ""}>下一页</button>
          </div>
        </footer>` : ""}
    `;
    byId<HTMLFormElement>("marketplace-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      query = byId<HTMLInputElement>("marketplace-search-input").value.trim();
      page = 1;
      void loadDiscover();
    });
    byId<HTMLSelectElement>("marketplace-sort").addEventListener("change", (event) => {
      sort = (event.currentTarget as HTMLSelectElement).value;
      page = 1;
      void loadDiscover();
    });
    content.querySelectorAll<HTMLButtonElement>("[data-marketplace-theme]").forEach((button) => {
      button.addEventListener("click", () => void showDetail(button.dataset.marketplaceTheme ?? ""));
    });
    document.getElementById("marketplace-retry")?.addEventListener("click", () => void loadDiscover());
    document.getElementById("marketplace-prev")?.addEventListener("click", () => {
      page = Math.max(1, page - 1);
      void loadDiscover();
    });
    document.getElementById("marketplace-next")?.addEventListener("click", () => {
      page += 1;
      void loadDiscover();
    });
  }

  function discoverBody(): string {
    if (discoverLoading) return `<div class="marketplace-loading">正在读取主题与安全预览…</div>`;
    if (discoverError) {
      return `<div class="marketplace-empty"><strong>暂时无法读取主题</strong><p>${escapeHtml(discoverError)}</p><button id="marketplace-retry" class="button subtle compact-button">重新加载</button></div>`;
    }
    if (!themesPage?.items.length) {
      return `<div class="marketplace-empty"><strong>还没有找到主题</strong><p>可以换一个关键词，或者成为第一个投稿的人。</p></div>`;
    }
    return `<div class="marketplace-grid">${themesPage.items.map(themeCardHtml).join("")}</div>`;
  }

  function themeCardHtml(theme: MarketplaceThemeCard): string {
    const preview = theme.previewDataUrl
      ? `<img src="${theme.previewDataUrl}" alt="" loading="lazy">`
      : `<span class="marketplace-preview-placeholder">NN</span>`;
    return `
      <button class="marketplace-theme-card" data-marketplace-theme="${escapeHtml(theme.themeId)}">
        <span class="marketplace-theme-preview">${preview}</span>
        <span class="marketplace-theme-copy">
          <span><em>v${theme.versionNumber}</em><i>↓ ${theme.downloadCount}</i></span>
          <strong>${escapeHtml(theme.name)}</strong>
          <small>${escapeHtml(theme.tagline || theme.manifestId)}</small>
          <b>${escapeHtml(theme.authorName)}</b>
        </span>
      </button>`;
  }

  async function showDetail(themeId: string): Promise<void> {
    if (!themeId) return;
    detailDialog.hidden = false;
    detailCard.innerHTML = `<button class="modal-close" data-close-marketplace aria-label="关闭">×</button><div class="marketplace-loading">正在读取主题详情…</div>`;
    bindCloseDetail();
    try {
      const [detail, states] = await Promise.all([
        invoke<MarketplaceThemeDetail>("marketplace_get_theme", { themeId }),
        invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states")
      ]);
      localSyncStates = states;
      const sync = localSyncStates.find((item) => item.themeId === detail.themeId || item.manifestId === detail.manifestId);
      const syncView = detailSyncView(detail, sync);
      detailCard.innerHTML = `
        <button class="modal-close" data-close-marketplace aria-label="关闭">×</button>
        <div class="marketplace-detail-preview">
          ${detail.detailPreviewDataUrl ? `<img src="${detail.detailPreviewDataUrl}" alt="${escapeHtml(detail.name)} 预览">` : ""}
        </div>
        <div class="marketplace-detail-body">
          <span class="eyebrow">${escapeHtml(detail.manifestId)} · V${detail.versionNumber}</span>
          <h3 id="marketplace-detail-title">${escapeHtml(detail.name)}</h3>
          <p>${escapeHtml(detail.tagline)}</p>
          ${detail.quote ? `<blockquote>${escapeHtml(detail.quote)}</blockquote>` : ""}
          <div class="marketplace-detail-meta">
            <span>作者<strong>${escapeHtml(detail.authorName)}</strong></span>
            <span>下载<strong>${detail.downloadCount}</strong></span>
            <span>大小<strong>${formatBytes(detail.packageSize)}</strong></span>
          </div>
          ${syncView ? `<div class="marketplace-sync-note ${syncView.kind}"><strong>${syncView.label}</strong><span>${syncView.detail}</span></div>` : ""}
          <div class="marketplace-detail-actions">
            <button id="marketplace-install" class="button primary">${syncView?.action ?? "下载并安装"}</button>
            <button id="marketplace-save" class="button subtle">另存 ZIP</button>
          </div>
        </div>`;
      bindCloseDetail();
      byId("marketplace-install").addEventListener("click", () => void installTheme(detail, sync));
      byId("marketplace-save").addEventListener("click", () => void saveTheme(detail));
    } catch (error) {
      detailCard.innerHTML = `
        <button class="modal-close" data-close-marketplace aria-label="关闭">×</button>
        <div class="marketplace-empty"><strong>无法读取主题详情</strong><p>${escapeHtml(options.errorMessage(error))}</p></div>`;
      bindCloseDetail();
    }
  }

  function bindCloseDetail(): void {
    detailCard.querySelector<HTMLButtonElement>("[data-close-marketplace]")
      ?.addEventListener("click", closeDetail);
  }

  function closeDetail(): void {
    detailDialog.hidden = true;
    detailCard.innerHTML = "";
  }

  async function installTheme(
    detail: MarketplaceThemeDetail,
    sync: MarketplaceLocalSyncState | undefined
  ): Promise<void> {
    const button = byId<HTMLButtonElement>("marketplace-install");
    const idleLabel = button.textContent ?? "下载并安装";
    button.disabled = true;
    button.textContent = "下载并校验中";
    try {
      let outcome = await invoke<ThemeInstallOutcome>("marketplace_install_theme", {
        themeId: detail.themeId,
        allowUpdate: false
      });
      if (outcome.needsConfirmation) {
        const confirmed = await confirmDialog(
          installConfirmation(detail, sync, outcome.theme.name),
          { title: "更新主题", kind: "warning" }
        );
        if (!confirmed) return;
        outcome = await invoke<ThemeInstallOutcome>("marketplace_install_theme", {
          themeId: detail.themeId,
          allowUpdate: true
        });
      }
      if (!outcome.installed) return;
      await options.refreshLocalThemes();
      localSyncStates = await invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states");
      closeDetail();
      options.showToast(outcome.updated ? `已更新“${outcome.theme.name}”` : `已安装“${outcome.theme.name}”`);
    } catch (error) {
      options.showToast(options.errorMessage(error), true);
    } finally {
      if (document.body.contains(button)) {
        button.disabled = false;
        button.textContent = idleLabel;
      }
    }
  }

  async function saveTheme(detail: MarketplaceThemeDetail): Promise<void> {
    const destination = await save({
      defaultPath: `${detail.manifestId}.zip`,
      filters: [{ name: "Codex NN 主题包", extensions: ["zip"] }]
    });
    if (!destination) return;
    const button = byId<HTMLButtonElement>("marketplace-save");
    button.disabled = true;
    try {
      await invoke("marketplace_save_theme", { themeId: detail.themeId, destination });
      options.showToast("主题包已经过完整校验并保存");
    } catch (error) {
      options.showToast(options.errorMessage(error), true);
    } finally {
      if (document.body.contains(button)) button.disabled = false;
    }
  }

  async function refreshMine(loadAuth: boolean): Promise<void> {
    if (mineLoading || !activePage || activeTab !== "mine") return;
    mineLoading = true;
    mineError = "";
    if (!auth) renderMine();
    try {
      if (loadAuth || !auth) {
        auth = await invoke<MarketplaceAuthState>("marketplace_auth_state");
      }
      if (auth.loggedIn) {
        [uploads, localSyncStates] = await Promise.all([
          invoke<MarketplaceUploadRecord[]>("marketplace_list_my_uploads"),
          invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states")
        ]);
      } else {
        uploads = [];
        localSyncStates = await invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states");
      }
    } catch (error) {
      mineError = options.errorMessage(error);
    } finally {
      mineLoading = false;
      renderMine();
      updatePolling();
    }
  }

  function renderMine(): void {
    if (!auth && mineLoading) {
      content.innerHTML = `<div class="marketplace-loading">正在读取登录状态…</div>`;
      return;
    }
    if (!auth?.loggedIn) {
      content.innerHTML = `
        <div class="marketplace-login-panel">
          <span class="marketplace-login-mark">G</span>
          <h3>${auth?.pending ? "请在浏览器中完成登录" : "登录后分享你的主题"}</h3>
          <p>${auth?.pending ? "登录完成后，这里会自动继续。Token 不会出现在浏览器地址中。" : "发现主题不需要登录；只有上传、更新和下架主题时需要账号。"}</p>
          ${mineError ? `<div class="marketplace-inline-error">${escapeHtml(mineError)}</div>` : ""}
          <button id="marketplace-login" class="button primary" ${auth?.pending || mineBusy ? "disabled" : ""}>${auth?.pending ? "等待 Google 登录" : "使用 Google 登录"}</button>
        </div>`;
      document.getElementById("marketplace-login")?.addEventListener("click", () => void startLogin());
      return;
    }
    renderLoggedInMine(auth);
  }

  function renderLoggedInMine(state: MarketplaceAuthState): void {
    const localThemes = options.getInstalledThemes().filter((theme) => !theme.builtIn);
    content.innerHTML = `
      <div class="marketplace-account-bar">
        <form id="marketplace-profile-form" class="marketplace-profile-form">
          <span>公开昵称</span>
          <input id="marketplace-public-name" value="${escapeHtml(state.user?.publicName ?? "")}" minlength="2" maxlength="40" required>
          <button class="button subtle compact-button" ${mineBusy ? "disabled" : ""}>保存</button>
        </form>
        <button id="marketplace-logout" class="button subtle compact-button" ${mineBusy ? "disabled" : ""}>退出登录</button>
      </div>
      <div class="marketplace-upload-bar">
        <div><strong>分享或更新主题</strong><small>包上限 20 MB；本地内容与云端不一致时，会先询问再自动创建下一版本</small></div>
        <div class="marketplace-local-picker">
          <select id="marketplace-local-theme" class="marketplace-select" ${!localThemes.length || mineBusy ? "disabled" : ""}>
            ${localThemes.length
              ? localThemes.map((theme) => `<option value="${escapeHtml(theme.id)}">${escapeHtml(theme.name)} · ${escapeHtml(localThemeStatus(theme.id).label)}</option>`).join("")
              : `<option>没有可投稿的自定义主题</option>`}
          </select>
          <small id="marketplace-local-sync-copy"></small>
        </div>
        <button id="marketplace-upload-installed" class="button secondary compact-button" ${!localThemes.length || mineBusy ? "disabled" : ""}>发布主题</button>
        <button id="marketplace-upload-zip" class="button primary compact-button" ${mineBusy ? "disabled" : ""}>上传 / 更新 ZIP</button>
      </div>
      ${mineError ? `<div class="marketplace-inline-error">${escapeHtml(mineError)}</div>` : ""}
      <div class="marketplace-upload-list">
        ${mineLoading && !uploads.length
          ? `<div class="marketplace-loading">正在读取投稿记录…</div>`
          : uploads.length
            ? uploads.map(uploadHtml).join("")
            : `<div class="marketplace-empty"><strong>还没有投稿</strong><p>可以上传本地已安装主题，也可以选择一个主题 ZIP。</p></div>`}
      </div>`;
    byId<HTMLFormElement>("marketplace-profile-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void updateProfile();
    });
    byId("marketplace-logout").addEventListener("click", () => void logout());
    byId<HTMLSelectElement>("marketplace-local-theme").addEventListener("change", updateLocalPublishControl);
    byId("marketplace-upload-installed").addEventListener("click", () => void uploadInstalled());
    byId("marketplace-upload-zip").addEventListener("click", () => void uploadZip());
    content.querySelectorAll<HTMLButtonElement>("[data-withdraw-theme]").forEach((button) => {
      button.addEventListener("click", () => void withdrawTheme(button.dataset.withdrawTheme ?? ""));
    });
    updateLocalPublishControl();
  }

  function uploadHtml(record: MarketplaceUploadRecord): string {
    const status = uploadStatus(record.status);
    const canWithdraw = record.status === "published";
    return `
      <article class="marketplace-upload-item">
        <span class="marketplace-upload-icon">${escapeHtml(record.name.slice(0, 1).toUpperCase() || "N")}</span>
        <span class="marketplace-upload-copy">
          <span><strong>${escapeHtml(record.name)}</strong><em>v${record.versionNumber}</em></span>
          <small>${escapeHtml(record.manifestId)} · ${formatDate(record.createdAt)}</small>
        </span>
        <span class="marketplace-review-state ${status.kind}"><i></i>${status.label}</span>
        ${canWithdraw ? `<button class="button subtle danger compact-button" data-withdraw-theme="${escapeHtml(record.themeId)}" ${mineBusy ? "disabled" : ""}>下架</button>` : ""}
      </article>`;
  }

  async function startLogin(): Promise<void> {
    await runMineAction(async () => {
      auth = { loggedIn: false, pending: true, user: null };
      renderMine();
      const result = await invoke<MarketplaceLoginResult>("marketplace_start_login");
      auth = result.auth;
      if (auth.loggedIn) {
        await refreshUploadsOnly();
      }
      options.showToast("Google 登录已完成");
    });
  }

  async function logout(): Promise<void> {
    await runMineAction(async () => {
      auth = await invoke<MarketplaceAuthState>("marketplace_logout");
      uploads = [];
      options.showToast("已退出主题广场账号");
    });
  }

  async function updateProfile(): Promise<void> {
    const publicName = byId<HTMLInputElement>("marketplace-public-name").value.trim();
    await runMineAction(async () => {
      const user = await invoke<MarketplaceUser>("marketplace_update_profile", { publicName });
      if (auth) auth = { ...auth, user };
      options.showToast("公开昵称已更新");
    });
  }

  function latestUpload(manifestId: string): MarketplaceUploadRecord | undefined {
    return uploads
      .filter((record) => record.manifestId === manifestId)
      .sort((left, right) => right.versionNumber - left.versionNumber)[0];
  }

  function localThemeStatus(localThemeId: string): {
    label: string;
    detail: string;
    action: string;
    disabled: boolean;
  } {
    const state = localSyncStates.find((item) => item.localThemeId === localThemeId);
    const record = latestUpload(state?.manifestId ?? localThemeId);
    if (state?.role === "consumer") {
      return {
        label: `来自广场 v${state.versionNumber ?? "?"}`,
        detail: "这是消费端安装的主题；如要投稿，请先修改主题 ID。",
        action: "不可直接投稿",
        disabled: true
      };
    }
    if (record && ["uploading", "reviewing", "publishing"].includes(record.status)) {
      return {
        label: `v${record.versionNumber} 审核中`,
        detail: "当前版本完成审核后，才可以继续发布下一版。",
        action: "审核中",
        disabled: true
      };
    }
    if (state?.role === "publisher" && state.localChanged) {
      return {
        label: "有未发布更改",
        detail: `本地内容已不同于关联的云端 v${state.versionNumber ?? "?"}，可以发布更新。`,
        action: "发布更新",
        disabled: false
      };
    }
    if (state?.role === "publisher" && record?.status === "published" && state.versionId === record.versionId) {
      return {
        label: `已同步 v${record.versionNumber}`,
        detail: "本地内容和已发布版本一致。",
        action: "已同步",
        disabled: true
      };
    }
    if (record) {
      return {
        label: `云端已有 v${record.versionNumber}`,
        detail: "发布前会比较本地主题包，并在不一致时请求确认。",
        action: "检查并发布",
        disabled: false
      };
    }
    return {
      label: "尚未发布",
      detail: "首次发布后会建立本地与云端主题的关联。",
      action: "发布主题",
      disabled: false
    };
  }

  function updateLocalPublishControl(): void {
    const select = document.getElementById("marketplace-local-theme") as HTMLSelectElement | null;
    const button = document.getElementById("marketplace-upload-installed") as HTMLButtonElement | null;
    const copy = document.getElementById("marketplace-local-sync-copy");
    if (!select || !button || !copy) return;
    const exists = options.getInstalledThemes().some((theme) => theme.id === select.value && !theme.builtIn);
    const view = localThemeStatus(select.value);
    button.textContent = view.action;
    button.disabled = mineBusy || !exists || view.disabled;
    copy.textContent = view.detail;
  }

  async function uploadInstalled(): Promise<void> {
    const themeId = byId<HTMLSelectElement>("marketplace-local-theme").value;
    if (!themeId) return;
    await runMineAction(async () => {
      await submitUpload({ kind: "installed", themeId });
    });
  }

  async function uploadZip(): Promise<void> {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Codex NN 主题包", extensions: ["zip"] }]
    });
    if (typeof path !== "string") return;
    await runMineAction(async () => {
      await submitUpload({ kind: "package", path });
    });
  }

  async function submitUpload(source: { kind: "installed"; themeId: string } | { kind: "package"; path: string }): Promise<void> {
    let outcome = await invoke<MarketplaceUploadOutcome>("marketplace_upload_theme", {
      source,
      allowUpdate: false
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(
        `“${outcome.name}”与云端 v${outcome.previousVersionNumber ?? "?"} 不一致。是否发布为下一版本？`,
        { title: "发布主题更新", kind: "warning" }
      );
      if (!confirmed) return;
      outcome = await invoke<MarketplaceUploadOutcome>("marketplace_upload_theme", {
        source,
        allowUpdate: true
      });
    }
    if (!outcome.record) return;
    options.showToast(outcome.uploaded
      ? `${outcome.isUpdate ? `v${outcome.record.versionNumber} 更新` : "主题"}已提交，正在审核`
      : `已与云端 v${outcome.record.versionNumber} 同步`);
    await refreshUploadsOnly();
  }

  async function withdrawTheme(themeId: string): Promise<void> {
    const record = uploads.find((item) => item.themeId === themeId && item.status === "published");
    if (!record) return;
    const confirmed = await confirmDialog(
      `下架“${record.name}”后会立即从广场移除，但主题 ID 会永久保留。继续吗？`,
      { title: "下架主题", kind: "warning" }
    );
    if (!confirmed) return;
    await runMineAction(async () => {
      await invoke("marketplace_withdraw_theme", { themeId });
      options.showToast(`已下架“${record.name}”`);
      await refreshUploadsOnly();
    });
  }

  async function refreshUploadsOnly(): Promise<void> {
    [uploads, localSyncStates] = await Promise.all([
      invoke<MarketplaceUploadRecord[]>("marketplace_list_my_uploads"),
      invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states")
    ]);
  }

  async function runMineAction(action: () => Promise<void>): Promise<void> {
    if (mineBusy) return;
    mineBusy = true;
    mineError = "";
    renderMine();
    updatePolling();
    try {
      await action();
    } catch (error) {
      mineError = options.errorMessage(error);
      options.showToast(mineError, true);
    } finally {
      mineBusy = false;
      renderMine();
      updatePolling();
    }
  }

  function updatePolling(): void {
    window.clearInterval(pollingTimer);
    pollingTimer = 0;
    if (!activePage || activeTab !== "mine" || mineBusy || document.visibilityState !== "visible") return;
    pollingTimer = window.setInterval(() => void refreshMine(false), 2000);
  }

  renderDiscover();
}

function detailSyncView(
  detail: MarketplaceThemeDetail,
  sync: MarketplaceLocalSyncState | undefined
): { label: string; detail: string; action: string; kind: string } | null {
  if (!sync || sync.themeId !== detail.themeId) return null;
  const linkedVersion = sync.versionNumber ?? 0;
  const cloudUpdate = detail.versionNumber > linkedVersion;
  const sameVersionConflict = detail.versionNumber === linkedVersion
    && sync.packageSha256 !== detail.packageSha256;
  if (sync.localChanged && cloudUpdate) {
    return {
      label: "本地和云端都有更新",
      detail: `本地有修改，云端已更新到 v${detail.versionNumber}；安装前会再次确认是否覆盖本地内容。`,
      action: `检查并更新到 v${detail.versionNumber}`,
      kind: "warning"
    };
  }
  if (sameVersionConflict) {
    return {
      label: "同一版本内容不一致",
      detail: `本地关联和云端都是 v${detail.versionNumber}，但主题包哈希不同；不会静默覆盖。`,
      action: "检查并重新安装",
      kind: "warning"
    };
  }
  if (cloudUpdate) {
    return {
      label: `可更新到 v${detail.versionNumber}`,
      detail: `本地关联版本为 v${linkedVersion}，更新后会同步新的云端版本信息。`,
      action: `更新到 v${detail.versionNumber}`,
      kind: "update"
    };
  }
  if (sync.localChanged) {
    return {
      label: "本地有未同步修改",
      detail: `云端仍为 v${detail.versionNumber}；重新安装会覆盖本地修改，因此会先请求确认。`,
      action: "重新安装云端版本",
      kind: "warning"
    };
  }
  return {
    label: `已同步 v${detail.versionNumber}`,
    detail: "本地主题与当前云端版本一致。",
    action: "重新安装",
    kind: "synced"
  };
}

function installConfirmation(
  detail: MarketplaceThemeDetail,
  sync: MarketplaceLocalSyncState | undefined,
  themeName: string
): string {
  if (!sync || sync.themeId !== detail.themeId) {
    return `主题“${themeName}”已经安装。是否用广场版本覆盖？`;
  }
  if (sync.localChanged) {
    return `“${themeName}”在本地有修改。安装云端 v${detail.versionNumber} 会覆盖这些内容，是否继续？`;
  }
  if (sync.versionNumber === detail.versionNumber && sync.packageSha256 !== detail.packageSha256) {
    return `“${themeName}”的本地关联与云端同为 v${detail.versionNumber}，但主题包哈希不同。是否用云端包覆盖？`;
  }
  if ((sync.versionNumber ?? 0) < detail.versionNumber) {
    return `是否将“${themeName}”从 v${sync.versionNumber ?? "?"} 更新到 v${detail.versionNumber}？`;
  }
  return `“${themeName}”已经安装。是否重新安装云端 v${detail.versionNumber}？`;
}

function uploadStatus(status: string): { label: string; kind: string } {
  const labels: Record<string, { label: string; kind: string }> = {
    uploading: { label: "等待上传", kind: "neutral" },
    reviewing: { label: "审核中", kind: "working" },
    publishing: { label: "审核中", kind: "working" },
    published: { label: "已发布", kind: "success" },
    rejected: { label: "未通过", kind: "danger" },
    publish_failed: { label: "发布失败", kind: "danger" },
    withdrawn: { label: "已下架", kind: "neutral" }
  };
  return labels[status] ?? { label: "处理中", kind: "working" };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素 #${id}`);
  return element as T;
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
