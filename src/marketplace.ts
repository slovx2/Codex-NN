import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { confirmDialog } from "./app-dialog";
import { mt } from "./i18n-marketplace";
import { resolvedLanguage } from "./i18n";
import type {
  MarketplaceAuthState,
  MarketplaceLikeResult,
  MarketplaceListingInput,
  MarketplaceLocalSyncState,
  MarketplaceLoginResult,
  MarketplacePage,
  MarketplaceShareCode,
  MarketplaceThemeCard,
  MarketplaceThemeDetail,
  MarketplaceUploadOutcome,
  MarketplaceUploadPreparation,
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
  let cancelActiveDialog: (() => void) | null = null;
  const shareCodeStats = new Map<string, MarketplaceShareCode[]>();

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
          <input id="marketplace-search-input" value="${escapeHtml(query)}" maxlength="80" placeholder="${mt("searchPlaceholder")}" aria-label="${mt("searchThemesAria")}">
          <button class="button primary compact-button" type="submit">${mt("search")}</button>
        </form>
        <button id="marketplace-redeem" class="button subtle compact-button">${mt("enterShareCode")}</button>
      </div>
      <div class="marketplace-results">
        ${discoverBody()}
      </div>
      ${themesPage && themesPage.pages > 0 ? `
        <footer class="marketplace-pagination">
          <span>${mt("pagination", { total: themesPage.total, page: themesPage.page, pages: themesPage.pages })}</span>
          <div>
            <button id="marketplace-prev" class="button subtle compact-button" ${themesPage.page <= 1 ? "disabled" : ""}>${mt("previous")}</button>
            <button id="marketplace-next" class="button subtle compact-button" ${themesPage.page >= themesPage.pages ? "disabled" : ""}>${mt("next")}</button>
          </div>
        </footer>` : ""}
    `;
    byId<HTMLFormElement>("marketplace-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      query = byId<HTMLInputElement>("marketplace-search-input").value.trim();
      page = 1;
      void loadDiscover();
    });
    byId("marketplace-redeem").addEventListener("click", showRedeemDialog);
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
    if (discoverLoading) return `<div class="marketplace-loading">${mt("loadingThemes")}</div>`;
    if (discoverError) {
      return `<div class="marketplace-empty"><strong>${mt("themesUnavailable")}</strong><p>${escapeHtml(discoverError)}</p><button id="marketplace-retry" class="button subtle compact-button">${mt("reload")}</button></div>`;
    }
    if (!themesPage?.items.length) {
      return `<div class="marketplace-empty"><strong>${mt("noThemes")}</strong><p>${mt("noThemesHint")}</p></div>`;
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
          <b>${escapeHtml(theme.authorName)}</b>
          <strong>${escapeHtml(theme.title)}</strong>
          <span class="marketplace-card-tags">${theme.tags.slice(0, 3).map(tagHtml).join("")}</span>
          <span class="marketplace-card-stats"><em>v${theme.versionNumber}</em><i>♥ ${theme.likeCount}</i></span>
        </span>
      </button>`;
  }

  async function showDetail(themeId: string): Promise<void> {
    if (!themeId) return;
    detailDialog.hidden = false;
    detailCard.innerHTML = `<button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button><div class="marketplace-loading">${mt("loadingDetail")}</div>`;
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
        <button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button>
        <div class="marketplace-detail-preview">
          ${detail.detailPreviewDataUrl ? `<img src="${detail.detailPreviewDataUrl}" alt="${escapeHtml(mt("previewAlt", { title: detail.title }))}">` : ""}
        </div>
        <div class="marketplace-detail-body">
          <span class="eyebrow">${escapeHtml(detail.manifestId)} · V${detail.versionNumber}</span>
          <h3 id="marketplace-detail-title">${escapeHtml(detail.title)}</h3>
          <p>${escapeHtml(detail.description || mt("noDescription"))}</p>
          <div class="marketplace-tags">${detail.tags.map(tagHtml).join("")}</div>
          <div class="marketplace-detail-meta">
            <span>${mt("author")}<strong>${escapeHtml(detail.authorName)}</strong></span>
            <span>${mt("likes")}<strong id="marketplace-like-count">${detail.likeCount}</strong></span>
            <span>${mt("downloads")}<strong>${detail.downloadCount}</strong></span>
            <span>${mt("size")}<strong>${formatBytes(detail.packageSize)}</strong></span>
          </div>
          ${syncView ? `<div class="marketplace-sync-note ${syncView.kind}"><strong>${syncView.label}</strong><span>${syncView.detail}</span></div>` : ""}
          <div class="marketplace-detail-actions">
            <button id="marketplace-like" class="button subtle">${detail.viewerLiked ? mt("unlike") : mt("like")}</button>
            <button id="marketplace-install" class="button primary">${syncView?.action ?? mt("downloadInstall")}</button>
            <button id="marketplace-save" class="button subtle">${mt("saveZip")}</button>
          </div>
        </div>`;
      bindCloseDetail();
      byId("marketplace-like").addEventListener("click", () => void toggleLike(detail));
      byId("marketplace-install").addEventListener("click", () => void installTheme(detail, sync));
      byId("marketplace-save").addEventListener("click", () => void saveTheme(detail));
    } catch (error) {
      detailCard.innerHTML = `
        <button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button>
        <div class="marketplace-empty"><strong>${mt("detailUnavailable")}</strong><p>${escapeHtml(options.errorMessage(error))}</p></div>`;
      bindCloseDetail();
    }
  }

  function bindCloseDetail(): void {
    detailCard.querySelector<HTMLButtonElement>("[data-close-marketplace]")
      ?.addEventListener("click", closeDetail);
  }

  function closeDetail(): void {
    const cancel = cancelActiveDialog;
    cancelActiveDialog = null;
    detailDialog.hidden = true;
    detailCard.innerHTML = "";
    cancel?.();
  }

  function showRedeemDialog(): void {
    detailDialog.hidden = false;
    detailCard.innerHTML = `
      <button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button>
      <form id="marketplace-redeem-form" class="marketplace-form-card">
        <span class="eyebrow">PRIVATE THEME</span>
        <h3 id="marketplace-detail-title">${mt("permanentShareCode")}</h3>
        <p>${mt("shareCodeSafety")}</p>
        <label>${mt("shareCode")}<input id="marketplace-share-code" autocomplete="off" spellcheck="false" placeholder="CNN-XXXX-XXXX-XXXX-XXXX-XXXX" required></label>
        <div class="marketplace-detail-actions">
          <button type="button" class="button subtle" data-close-marketplace>${mt("cancel")}</button>
          <button id="marketplace-redeem-submit" class="button primary">${mt("viewTheme")}</button>
        </div>
      </form>`;
    detailCard.querySelectorAll<HTMLElement>("[data-close-marketplace]").forEach((button) => {
      button.addEventListener("click", closeDetail);
    });
    byId<HTMLFormElement>("marketplace-redeem-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void redeemShareCode();
    });
    byId<HTMLInputElement>("marketplace-share-code").focus();
  }

  async function redeemShareCode(): Promise<void> {
    const code = byId<HTMLInputElement>("marketplace-share-code").value.trim();
    const button = byId<HTMLButtonElement>("marketplace-redeem-submit");
    if (!code || button.disabled) return;
    button.disabled = true;
    try {
      auth = auth ?? await invoke<MarketplaceAuthState>("marketplace_auth_state");
      if (!auth.loggedIn) {
        const continueAnonymously = await confirmDialog(
          mt("loginRecommendation"),
          { title: mt("loginRecommendedTitle"), kind: "warning" }
        );
        if (!continueAnonymously) {
          closeDetail();
          switchTab("mine");
          return;
        }
      }
      const themeId = await invoke<string>("marketplace_redeem_share_code", { code });
      closeDetail();
      await showDetail(themeId);
    } catch (error) {
      options.showToast(options.errorMessage(error), true);
      button.disabled = false;
    }
  }

  async function toggleLike(detail: MarketplaceThemeDetail): Promise<void> {
    const button = byId<HTMLButtonElement>("marketplace-like");
    if (button.disabled) return;
    button.disabled = true;
    try {
      auth = auth ?? await invoke<MarketplaceAuthState>("marketplace_auth_state");
      if (!auth.loggedIn) {
        button.textContent = mt("waitingGoogle");
        const login = await invoke<MarketplaceLoginResult>("marketplace_start_login");
        auth = login.auth;
        if (!auth.loggedIn) throw new Error(mt("loginIncomplete"));
      }
      const result = await invoke<MarketplaceLikeResult>("marketplace_set_like", {
        themeId: detail.themeId,
        liked: !detail.viewerLiked
      });
      detail.viewerLiked = result.liked;
      detail.likeCount = result.likeCount;
      button.textContent = result.liked ? mt("unlike") : mt("like");
      byId("marketplace-like-count").textContent = String(result.likeCount);
      const card = themesPage?.items.find((item) => item.themeId === detail.themeId);
      if (card) {
        card.viewerLiked = result.liked;
        card.likeCount = result.likeCount;
      }
    } catch (error) {
      options.showToast(options.errorMessage(error), true);
    } finally {
      if (document.body.contains(button)) button.disabled = false;
    }
  }

  async function installTheme(
    detail: MarketplaceThemeDetail,
    sync: MarketplaceLocalSyncState | undefined
  ): Promise<void> {
    const button = byId<HTMLButtonElement>("marketplace-install");
    const idleLabel = button.textContent ?? mt("downloadInstall");
    button.disabled = true;
    button.textContent = mt("downloadingValidating");
    try {
      let outcome = await invoke<ThemeInstallOutcome>("marketplace_install_theme", {
        themeId: detail.themeId,
        allowUpdate: false
      });
      if (outcome.needsConfirmation) {
        const confirmed = await confirmDialog(
          installConfirmation(detail, sync, outcome.theme.name),
          { title: mt("updateTheme"), kind: "warning" }
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
      options.showToast(outcome.updated
        ? mt("themeUpdated", { name: outcome.theme.name })
        : mt("themeInstalled", { name: outcome.theme.name }));
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
      filters: [{ name: mt("themePackageFilter"), extensions: ["zip"] }]
    });
    if (!destination) return;
    const button = byId<HTMLButtonElement>("marketplace-save");
    button.disabled = true;
    try {
      await invoke("marketplace_save_theme", { themeId: detail.themeId, destination });
      options.showToast(mt("packageSaved"));
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
        await refreshShareCodeStats();
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
      content.innerHTML = `<div class="marketplace-loading">${mt("loadingAuth")}</div>`;
      return;
    }
    if (!auth?.loggedIn) {
      content.innerHTML = `
        <div class="marketplace-login-panel">
          <span class="marketplace-login-mark">G</span>
          <h3>${auth?.pending ? mt("finishLogin") : mt("shareAfterLogin")}</h3>
          <p>${auth?.pending ? mt("pendingLoginHint") : mt("loginHint")}</p>
          ${mineError ? `<div class="marketplace-inline-error">${escapeHtml(mineError)}</div>` : ""}
          <button id="marketplace-login" class="button primary" ${auth?.pending || mineBusy ? "disabled" : ""}>${auth?.pending ? mt("waitingGoogle") : mt("googleLogin")}</button>
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
          <span>${mt("publicName")}</span>
          <input id="marketplace-public-name" value="${escapeHtml(state.user?.publicName ?? "")}" minlength="2" maxlength="40" required>
          <button class="button subtle compact-button" ${mineBusy ? "disabled" : ""}>${mt("save")}</button>
        </form>
        <button id="marketplace-logout" class="button subtle compact-button" ${mineBusy ? "disabled" : ""}>${mt("logout")}</button>
      </div>
      <div class="marketplace-upload-bar">
        <div><strong>${mt("publishHeading")}</strong><small>${mt("publishHint")}</small></div>
        <div class="marketplace-local-picker">
          <select id="marketplace-local-theme" class="marketplace-select" ${!localThemes.length || mineBusy ? "disabled" : ""}>
            ${localThemes.length
              ? localThemes.map((theme) => `<option value="${escapeHtml(theme.id)}">${escapeHtml(theme.name)} · ${escapeHtml(localThemeStatus(theme.id).label)}</option>`).join("")
              : `<option>${mt("noCustomThemes")}</option>`}
          </select>
          <small id="marketplace-local-sync-copy"></small>
        </div>
        <button id="marketplace-upload-installed" class="button secondary compact-button" ${!localThemes.length || mineBusy ? "disabled" : ""}>${mt("publishTheme")}</button>
        <button id="marketplace-upload-zip" class="button primary compact-button" ${mineBusy ? "disabled" : ""}>${mt("uploadZip")}</button>
      </div>
      ${mineError ? `<div class="marketplace-inline-error">${escapeHtml(mineError)}</div>` : ""}
      <div class="marketplace-upload-list">
        ${mineLoading && !uploads.length
          ? `<div class="marketplace-loading">${mt("loadingUploads")}</div>`
          : uploads.length
            ? uploads.map(uploadHtml).join("")
            : `<div class="marketplace-empty"><strong>${mt("noUploads")}</strong><p>${mt("noUploadsHint")}</p></div>`}
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
    content.querySelectorAll<HTMLButtonElement>("[data-restore-theme]").forEach((button) => {
      button.addEventListener("click", () => void restoreTheme(button.dataset.restoreTheme ?? ""));
    });
    content.querySelectorAll<HTMLButtonElement>("[data-create-share-code]").forEach((button) => {
      button.addEventListener("click", () => void createShareCode(button.dataset.createShareCode ?? ""));
    });
    updateLocalPublishControl();
  }

  function uploadHtml(record: MarketplaceUploadRecord): string {
    const status = uploadStatus(record.status);
    const isLatest = latestUpload(record.manifestId)?.versionId === record.versionId;
    const canWithdraw = isLatest && record.status === "published";
    const canRestore = isLatest && record.status === "withdrawn";
    const canShare = isLatest && record.status === "published" && record.visibility === "private";
    const shareCodes = shareCodeStats.get(record.themeId) ?? [];
    const redemptions = shareCodes.reduce((total, item) => total + item.redemptionCount, 0);
    return `
      <article class="marketplace-upload-item">
        <span class="marketplace-upload-icon">${escapeHtml(record.title.slice(0, 1).toUpperCase() || "N")}</span>
        <span class="marketplace-upload-copy">
          <span><strong>${escapeHtml(record.title)}</strong><em>v${record.versionNumber} · ${record.visibility === "private" ? mt("private") : mt("public")}</em></span>
          <small>${escapeHtml(record.manifestId)} · ${formatDate(record.createdAt)}${shareCodes.length ? ` · ${mt("shareCodeStats", { codes: shareCodes.length, redemptions })}` : ""}</small>
        </span>
        <span class="marketplace-upload-actions">
          <span class="marketplace-review-state ${status.kind}"><i></i>${status.label}</span>
          ${canShare ? `<button class="button subtle compact-button" data-create-share-code="${escapeHtml(record.themeId)}" ${mineBusy ? "disabled" : ""}>${mt("createShareCode")}</button>` : ""}
          ${canWithdraw ? `<button class="button subtle danger compact-button" data-withdraw-theme="${escapeHtml(record.themeId)}" ${mineBusy ? "disabled" : ""}>${mt("withdraw")}</button>` : ""}
          ${canRestore ? `<button class="button subtle compact-button" data-restore-theme="${escapeHtml(record.themeId)}" ${mineBusy ? "disabled" : ""}>${mt("restore")}</button>` : ""}
        </span>
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
      options.showToast(mt("googleLoginComplete"));
    });
  }

  async function logout(): Promise<void> {
    await runMineAction(async () => {
      auth = await invoke<MarketplaceAuthState>("marketplace_logout");
      uploads = [];
      options.showToast(mt("loggedOut"));
    });
  }

  async function updateProfile(): Promise<void> {
    const publicName = byId<HTMLInputElement>("marketplace-public-name").value.trim();
    await runMineAction(async () => {
      const user = await invoke<MarketplaceUser>("marketplace_update_profile", { publicName });
      if (auth) auth = { ...auth, user };
      options.showToast(mt("publicNameUpdated"));
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
        label: mt("fromMarketplace", { version: state.versionNumber ?? "?" }),
        detail: mt("consumerThemeHint"),
        action: mt("cannotPublish"),
        disabled: true
      };
    }
    if (record && ["uploading", "reviewing", "publishing"].includes(record.status)) {
      return {
        label: mt("reviewingVersion", { version: record.versionNumber }),
        detail: mt("reviewingHint"),
        action: mt("reviewing"),
        disabled: true
      };
    }
    if (state?.role === "publisher" && state.localChanged) {
      return {
        label: mt("unpublishedChanges"),
        detail: mt("localChangedHint", { version: state.versionNumber ?? "?" }),
        action: mt("publishUpdate"),
        disabled: false
      };
    }
    if (state?.role === "publisher" && record?.status === "published" && state.versionId === record.versionId) {
      return {
        label: mt("syncedVersion", { version: record.versionNumber }),
        detail: mt("syncedHint"),
        action: mt("synced"),
        disabled: true
      };
    }
    if (record) {
      return {
        label: mt("cloudVersion", { version: record.versionNumber }),
        detail: mt("compareBeforePublish"),
        action: mt("inspectPublish"),
        disabled: false
      };
    }
    return {
      label: mt("neverPublished"),
      detail: mt("firstPublishHint"),
      action: mt("publishTheme"),
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
      filters: [{ name: mt("themePackageFilter"), extensions: ["zip"] }]
    });
    if (typeof path !== "string") return;
    await runMineAction(async () => {
      await submitUpload({ kind: "package", path });
    });
  }

  async function submitUpload(source: { kind: "installed"; themeId: string } | { kind: "package"; path: string }): Promise<void> {
    const preparation = await invoke<MarketplaceUploadPreparation>("marketplace_prepare_upload", { source });
    const listing = await collectUploadListing(preparation);
    if (!listing) return;
    let outcome = await invoke<MarketplaceUploadOutcome>("marketplace_upload_theme", {
      source,
      listing,
      allowUpdate: false
    });
    if (outcome.needsConfirmation) {
      const confirmed = await confirmDialog(
        mt("publishMismatch", { title: outcome.title, version: outcome.previousVersionNumber ?? "?" }),
        { title: mt("publishUpdateTitle"), kind: "warning" }
      );
      if (!confirmed) return;
      outcome = await invoke<MarketplaceUploadOutcome>("marketplace_upload_theme", {
        source,
        listing,
        allowUpdate: true
      });
    }
    if (!outcome.record) return;
    options.showToast(outcome.uploaded
      ? mt("submittedReview", {
          subject: outcome.isUpdate
            ? mt("versionUpdate", { version: outcome.record.versionNumber })
            : mt("themeSubject")
        })
      : mt("syncedCloud", { version: outcome.record.versionNumber }));
    await refreshUploadsOnly();
  }

  async function withdrawTheme(themeId: string): Promise<void> {
    const record = uploads.find((item) => item.themeId === themeId && item.status === "published");
    if (!record) return;
    const confirmed = await confirmDialog(
      mt("withdrawConfirm", { title: record.title }),
      { title: mt("withdrawTitle"), kind: "warning" }
    );
    if (!confirmed) return;
    await runMineAction(async () => {
      await invoke("marketplace_withdraw_theme", { themeId });
      options.showToast(mt("withdrawnToast", { title: record.title }));
      await refreshUploadsOnly();
    });
  }

  async function restoreTheme(themeId: string): Promise<void> {
    const record = uploads.find((item) => item.themeId === themeId && item.status === "withdrawn");
    if (!record) return;
    await runMineAction(async () => {
      await invoke("marketplace_restore_theme", { themeId });
      options.showToast(mt("restoredToast", { title: record.title }));
      await refreshUploadsOnly();
    });
  }

  async function createShareCode(themeId: string): Promise<void> {
    const confirmed = await confirmDialog(
      mt("permanentCodeConfirm"),
      { title: mt("permanentCodeTitle"), kind: "warning" }
    );
    if (!confirmed) return;
    await runMineAction(async () => {
      const created = await invoke<MarketplaceShareCode>("marketplace_create_share_code", { themeId });
      shareCodeStats.set(themeId, [created, ...(shareCodeStats.get(themeId) ?? [])]);
      showCreatedShareCode(created.code);
    });
  }

  function showCreatedShareCode(code: string): void {
    detailDialog.hidden = false;
    detailCard.innerHTML = `
      <button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button>
      <div class="marketplace-form-card">
        <span class="eyebrow">SHARE CODE</span>
        <h3 id="marketplace-detail-title">${mt("codeCreated")}</h3>
        <p>${mt("codeOneTimeHint")}</p>
        <code class="marketplace-share-code-result">${escapeHtml(code)}</code>
        <button class="button primary" data-close-marketplace>${mt("savedClose")}</button>
      </div>`;
    detailCard.querySelectorAll<HTMLElement>("[data-close-marketplace]").forEach((button) => {
      button.addEventListener("click", closeDetail);
    });
  }

  function collectUploadListing(
    preparation: MarketplaceUploadPreparation
  ): Promise<MarketplaceListingInput | null> {
    return new Promise((resolve) => {
      let tags = [...preparation.listing.tags];
      let settled = false;
      const finish = (value: MarketplaceListingInput | null): void => {
        if (settled) return;
        settled = true;
        cancelActiveDialog = null;
        detailDialog.hidden = true;
        detailCard.innerHTML = "";
        resolve(value);
      };
      cancelActiveDialog = () => finish(null);
      detailDialog.hidden = false;
      detailCard.innerHTML = `
        <button class="modal-close" data-close-marketplace aria-label="${mt("close")}">×</button>
        <form id="marketplace-listing-form" class="marketplace-form-card marketplace-listing-form">
          <span class="eyebrow">PUBLISH THEME</span>
          <h3 id="marketplace-detail-title">${mt("listingTitle")}</h3>
          <p>${mt("listingHint")}</p>
          <label>${mt("title")} <small>${mt("titleLimit")}</small>
            <input id="marketplace-listing-title" maxlength="80" required value="${escapeHtml(preparation.listing.title)}">
          </label>
          <label>${mt("description")} <small>${mt("descriptionLimit")}</small>
            <textarea id="marketplace-listing-description" maxlength="1000" rows="5">${escapeHtml(preparation.listing.description)}</textarea>
          </label>
          <label>${mt("tags")} <small>${mt("tagsLimit")}</small>
            <div id="marketplace-tag-editor" class="marketplace-tag-editor">
              <div id="marketplace-tag-chips" class="marketplace-tags"></div>
              <input id="marketplace-tag-input" maxlength="24" placeholder="${mt("addTag")}">
            </div>
          </label>
          <label>${mt("visibility")}
            <select id="marketplace-listing-visibility" class="marketplace-select">
              <option value="public" ${preparation.listing.visibility === "public" ? "selected" : ""}>${mt("publicVisibility")}</option>
              <option value="private" ${preparation.listing.visibility === "private" ? "selected" : ""} ${preparation.existingVisibility === "public" ? "disabled" : ""}>${mt("privateVisibility")}</option>
            </select>
          </label>
          ${preparation.existingVisibility === "public" ? `<div class="marketplace-inline-note">${mt("publicImmutable")}</div>` : `<div class="marketplace-inline-note">${mt("privateCanPublish")}</div>`}
          <div id="marketplace-listing-error" class="marketplace-inline-error" hidden></div>
          <div class="marketplace-detail-actions">
            <button type="button" class="button subtle" data-close-marketplace>${mt("cancel")}</button>
            <button class="button primary">${mt("continuePublish")}</button>
          </div>
        </form>`;
      const chips = byId("marketplace-tag-chips");
      const tagInput = byId<HTMLInputElement>("marketplace-tag-input");
      const renderTags = (): void => {
        chips.innerHTML = tags.map((tag, index) => `<button type="button" class="marketplace-tag" data-remove-tag="${index}">${escapeHtml(tag)} ×</button>`).join("");
        chips.querySelectorAll<HTMLButtonElement>("[data-remove-tag]").forEach((button) => {
          button.addEventListener("click", () => {
            tags.splice(Number(button.dataset.removeTag), 1);
            renderTags();
          });
        });
      };
      const addTag = (): void => {
        const tag = tagInput.value.trim();
        tagInput.value = "";
        if (!tag) return;
        if ([...tag].length > 24 || /[\p{C}]/u.test(tag)) {
          showListingError(mt("invalidTag"));
          return;
        }
        if (tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) return;
        if (tags.length >= 10) {
          showListingError(mt("tooManyTags"));
          return;
        }
        tags.push(tag);
        renderTags();
      };
      const showListingError = (message: string): void => {
        const error = byId("marketplace-listing-error");
        error.textContent = message;
        error.hidden = false;
      };
      renderTags();
      tagInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          addTag();
        }
      });
      tagInput.addEventListener("blur", addTag);
      detailCard.querySelectorAll<HTMLElement>("[data-close-marketplace]").forEach((button) => {
        button.addEventListener("click", () => finish(null));
      });
      byId<HTMLFormElement>("marketplace-listing-form").addEventListener("submit", (event) => {
        event.preventDefault();
        addTag();
        const title = byId<HTMLInputElement>("marketplace-listing-title").value.trim();
        const description = byId<HTMLTextAreaElement>("marketplace-listing-description").value.trim();
        if (![...title].length || [...title].length > 80) {
          showListingError(mt("invalidTitle"));
          return;
        }
        if ([...description].length > 1000) {
          showListingError(mt("invalidDescription"));
          return;
        }
        const visibility = byId<HTMLSelectElement>("marketplace-listing-visibility").value;
        finish({ title, description, tags, visibility: visibility as "public" | "private" });
      });
    });
  }

  async function refreshShareCodeStats(): Promise<void> {
    const themeIds = [...new Set(uploads
      .filter((record) => record.visibility === "private")
      .map((record) => record.themeId))];
    await Promise.all(themeIds.map(async (themeId) => {
      const codes = await invoke<MarketplaceShareCode[]>("marketplace_list_share_codes", { themeId });
      shareCodeStats.set(themeId, codes);
    }));
  }

  async function refreshUploadsOnly(): Promise<void> {
    [uploads, localSyncStates] = await Promise.all([
      invoke<MarketplaceUploadRecord[]>("marketplace_list_my_uploads"),
      invoke<MarketplaceLocalSyncState[]>("marketplace_local_sync_states")
    ]);
    await refreshShareCodeStats();
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
      label: mt("localCloudChanged"),
      detail: mt("localCloudChangedHint", { version: detail.versionNumber }),
      action: mt("inspectUpdate", { version: detail.versionNumber }),
      kind: "warning"
    };
  }
  if (sameVersionConflict) {
    return {
      label: mt("sameVersionConflict"),
      detail: mt("sameVersionConflictHint", { version: detail.versionNumber }),
      action: mt("inspectReinstall"),
      kind: "warning"
    };
  }
  if (cloudUpdate) {
    return {
      label: mt("updateAvailable", { version: detail.versionNumber }),
      detail: mt("updateAvailableHint", { local: linkedVersion, version: detail.versionNumber }),
      action: mt("updateTo", { version: detail.versionNumber }),
      kind: "update"
    };
  }
  if (sync.localChanged) {
    return {
      label: mt("unsyncedLocal"),
      detail: mt("unsyncedLocalHint", { version: detail.versionNumber }),
      action: mt("reinstallCloud"),
      kind: "warning"
    };
  }
  return {
    label: mt("syncedVersion", { version: detail.versionNumber }),
    detail: mt("syncedCloudHint"),
    action: mt("reinstall"),
    kind: "synced"
  };
}

function installConfirmation(
  detail: MarketplaceThemeDetail,
  sync: MarketplaceLocalSyncState | undefined,
  themeName: string
): string {
  if (!sync || sync.themeId !== detail.themeId) {
    return mt("overwriteInstalled", { name: themeName });
  }
  if (sync.localChanged) {
    return mt("overwriteLocalChanges", { name: themeName, version: detail.versionNumber });
  }
  if (sync.versionNumber === detail.versionNumber && sync.packageSha256 !== detail.packageSha256) {
    return mt("overwriteHashConflict", { name: themeName, version: detail.versionNumber });
  }
  if ((sync.versionNumber ?? 0) < detail.versionNumber) {
    return mt("updateConfirmation", { name: themeName, local: sync.versionNumber ?? "?", version: detail.versionNumber });
  }
  return mt("reinstallConfirmation", { name: themeName, version: detail.versionNumber });
}

function uploadStatus(status: string): { label: string; kind: string } {
  const labels: Record<string, { label: string; kind: string }> = {
    uploading: { label: mt("statusUploading"), kind: "neutral" },
    reviewing: { label: mt("reviewing"), kind: "working" },
    publishing: { label: mt("reviewing"), kind: "working" },
    published: { label: mt("statusPublished"), kind: "success" },
    rejected: { label: mt("statusRejected"), kind: "danger" },
    publish_failed: { label: mt("statusFailed"), kind: "danger" },
    withdrawn: { label: mt("statusWithdrawn"), kind: "neutral" }
  };
  return labels[status] ?? { label: mt("statusProcessing"), kind: "working" };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(mt("missingElement", { id }));
  return element as T;
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function tagHtml(value: string): string {
  return `<span class="marketplace-tag">${escapeHtml(value)}</span>`;
}

function formatBytes(bytes: number): string {
  const locale = resolvedLanguage();
  if (bytes < 1024 * 1024) {
    return `${new Intl.NumberFormat(locale).format(Math.max(1, Math.round(bytes / 1024)))} KB`;
  }
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(resolvedLanguage(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
