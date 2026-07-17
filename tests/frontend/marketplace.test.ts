import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  open: vi.fn(),
  save: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
  open: mocks.open,
  save: mocks.save
}));

import { setupMarketplace } from "../../src/marketplace";

beforeEach(() => {
  document.body.innerHTML = `
    <button id="marketplace-discover-tab"></button>
    <button id="marketplace-mine-tab"></button>
    <div id="marketplace-content"></div>
    <div id="marketplace-detail-dialog" hidden>
      <div id="marketplace-detail-card"></div>
    </div>`;
  mocks.invoke.mockReset();
  mocks.confirm.mockReset();
  mocks.open.mockReset();
  mocks.save.mockReset();
});

test("主题广场支持匿名发现、登录等待、投稿状态、错误和空列表", async () => {
  let auth = { loggedIn: false, pending: false, user: null as null | { id: string; publicName: string } };
  let finishLogin: ((value: { status: string; auth: typeof auth }) => void) | null = null;
  let uploadError = false;
  let localThemes: Array<{ id: string; name: string; tagline: string; quote: string; accent: string; previewDataUrl: string; active: boolean; builtIn: boolean }> = [];
  let localSyncStates: Array<{
    localThemeId: string;
    manifestId: string;
    linked: boolean;
    themeId: string | null;
    versionId: string | null;
    versionNumber: number | null;
    packageSha256: string | null;
    role: "consumer" | "publisher" | null;
    localChanged: boolean;
  }> = [{
    localThemeId: "community-night",
    manifestId: "community-night",
    linked: true,
    themeId: "018f-theme",
    versionId: "018f-version-1",
    versionNumber: 1,
    packageSha256: "a".repeat(64),
    role: "consumer",
    localChanged: false
  }];
  let uploads = [
    {
      themeId: "018f-theme",
      versionId: "018f-version",
      manifestId: "community-night",
      versionNumber: 2,
      status: "reviewing",
      name: "社区夜色",
      tagline: "安静的深色主题",
      packageSha256: "a".repeat(64),
      packageSize: 1024,
      createdAt: "2026-07-17T08:00:00Z",
      reviewedAt: null
    }
  ];
  mocks.invoke.mockImplementation(async (command: string, args?: { allowUpdate?: boolean }) => {
    if (command === "marketplace_list_themes") {
      return {
        items: [{
          themeId: "018f-theme",
          versionId: "018f-version",
          manifestId: "community-night",
          name: "社区夜色",
          tagline: "安静的深色主题",
          authorName: "测试作者",
          versionNumber: 1,
          downloadCount: 12,
          cardPreviewUrl: "https://untrusted.invalid/card.jpg",
          publishedAt: "2026-07-17T08:00:00Z",
          previewDataUrl: "data:image/jpeg;base64,AA=="
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        pages: 1
      };
    }
    if (command === "marketplace_get_theme") {
      return {
        themeId: "018f-theme",
        versionId: "018f-version-2",
        manifestId: "community-night",
        name: "社区夜色",
        tagline: "安静的深色主题",
        authorName: "测试作者",
        versionNumber: 2,
        downloadCount: 12,
        cardPreviewUrl: "",
        publishedAt: "2026-07-17T08:00:00Z",
        previewDataUrl: "",
        quote: "保持专注",
        manifest: {},
        detailPreviewUrl: "",
        detailPreviewDataUrl: "data:image/jpeg;base64,AA==",
        packageSize: 1024,
        packageSha256: "b".repeat(64)
      };
    }
    if (command === "marketplace_auth_state") return auth;
    if (command === "marketplace_local_sync_states") return localSyncStates;
    if (command === "marketplace_start_login") {
      auth = { loggedIn: false, pending: true, user: null };
      return new Promise((resolve) => { finishLogin = resolve; });
    }
    if (command === "marketplace_list_my_uploads") {
      if (uploadError) throw new Error("投稿列表暂时不可用");
      return uploads;
    }
    if (command === "marketplace_install_theme") {
      return {
        installed: Boolean(args?.allowUpdate),
        updated: Boolean(args?.allowUpdate),
        needsConfirmation: !args?.allowUpdate,
        theme: {
          id: "community-night",
          name: "社区夜色",
          tagline: "安静的深色主题",
          quote: "保持专注",
          accent: "#8298a3",
          previewDataUrl: "",
          active: false,
          builtIn: false
        }
      };
    }
    if (command === "marketplace_upload_theme") {
      if (!args?.allowUpdate) {
        return {
          uploaded: false,
          needsConfirmation: true,
          isUpdate: true,
          name: "社区夜色",
          previousVersionNumber: 2,
          record: null
        };
      }
      const record = {
        ...uploads[0],
        versionId: "018f-version-3",
        versionNumber: 3,
        status: "reviewing"
      };
      uploads = [record];
      localSyncStates = [{ ...localSyncStates[0], versionId: record.versionId, versionNumber: 3, localChanged: false }];
      return {
        uploaded: true,
        needsConfirmation: false,
        isUpdate: true,
        name: record.name,
        previousVersionNumber: 2,
        record
      };
    }
    throw new Error(`未处理的命令：${command}`);
  });

  setupMarketplace({
    getInstalledThemes: () => localThemes,
    refreshLocalThemes: async () => undefined,
    showToast: vi.fn(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error)
  });
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "marketplace" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("社区夜色"));
  expect(document.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg/);
  expect(document.body.innerHTML).not.toContain("untrusted.invalid");

  (document.querySelector("[data-marketplace-theme]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("更新到 v2"));
  expect(document.body.textContent).toContain("保持专注");
  expect(document.body.textContent).toContain("可更新到 v2");
  mocks.confirm.mockResolvedValue(true);
  (document.getElementById("marketplace-install") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(
    expect.stringContaining("从 v1 更新到 v2"),
    expect.anything()
  ));
  await vi.waitFor(() => expect(document.getElementById("marketplace-detail-dialog")?.hidden).toBe(true));

  (document.getElementById("marketplace-mine-tab") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("使用 Google 登录"));
  (document.getElementById("marketplace-login") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("等待 Google 登录"));

  auth = { loggedIn: true, pending: false, user: { id: "user-1", publicName: "测试作者" } };
  finishLogin?.({ status: "complete", auth });
  await vi.waitFor(() => expect(document.body.textContent).toContain("审核中"));
  expect(document.body.textContent).toContain("公开昵称");

  localThemes = [{
    id: "community-night",
    name: "社区夜色",
    tagline: "安静的深色主题",
    quote: "保持专注",
    accent: "#8298a3",
    previewDataUrl: "",
    active: false,
    builtIn: false
  }];
  uploads = [{ ...uploads[0], status: "published" }];
  localSyncStates = [{
    localThemeId: "community-night",
    manifestId: "community-night",
    linked: true,
    themeId: "018f-theme",
    versionId: "018f-version",
    versionNumber: 2,
    packageSha256: "a".repeat(64),
    role: "publisher",
    localChanged: true
  }];
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("有未发布更改"));
  expect(document.getElementById("marketplace-upload-installed")?.textContent).toBe("发布更新");
  mocks.confirm.mockResolvedValue(true);
  (document.getElementById("marketplace-upload-installed") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(
    expect.stringContaining("是否发布为下一版本"),
    expect.anything()
  ));
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "marketplace_upload_theme",
    expect.objectContaining({ allowUpdate: true })
  ));
  await vi.waitFor(() => expect(document.body.textContent).toContain("v3"));

  uploadError = true;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("投稿列表暂时不可用"));

  uploadError = false;
  uploads = [];
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("还没有投稿"));
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "home" }));
});
