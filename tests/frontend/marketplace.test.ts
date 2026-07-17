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
  mocks.invoke.mockImplementation(async (command: string) => {
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
        versionId: "018f-version",
        manifestId: "community-night",
        name: "社区夜色",
        tagline: "安静的深色主题",
        authorName: "测试作者",
        versionNumber: 1,
        downloadCount: 12,
        cardPreviewUrl: "",
        publishedAt: "2026-07-17T08:00:00Z",
        previewDataUrl: "",
        quote: "保持专注",
        manifest: {},
        detailPreviewUrl: "",
        detailPreviewDataUrl: "data:image/jpeg;base64,AA==",
        packageSize: 1024,
        packageSha256: "a".repeat(64)
      };
    }
    if (command === "marketplace_auth_state") return auth;
    if (command === "marketplace_local_sync_states") return [];
    if (command === "marketplace_start_login") {
      auth = { loggedIn: false, pending: true, user: null };
      return new Promise((resolve) => { finishLogin = resolve; });
    }
    if (command === "marketplace_list_my_uploads") {
      if (uploadError) throw new Error("投稿列表暂时不可用");
      return uploads;
    }
    throw new Error(`未处理的命令：${command}`);
  });

  setupMarketplace({
    getInstalledThemes: () => [],
    refreshLocalThemes: async () => undefined,
    showToast: vi.fn(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error)
  });
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "marketplace" }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("社区夜色"));
  expect(document.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg/);
  expect(document.body.innerHTML).not.toContain("untrusted.invalid");

  (document.querySelector("[data-marketplace-theme]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("下载并安装"));
  expect(document.body.textContent).toContain("保持专注");
  (document.querySelector("[data-close-marketplace]") as HTMLButtonElement).click();

  (document.getElementById("marketplace-mine-tab") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("使用 Google 登录"));
  (document.getElementById("marketplace-login") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("等待 Google 登录"));

  auth = { loggedIn: true, pending: false, user: { id: "user-1", publicName: "测试作者" } };
  finishLogin?.({ status: "complete", auth });
  await vi.waitFor(() => expect(document.body.textContent).toContain("审核中"));
  expect(document.body.textContent).toContain("公开昵称");

  uploadError = true;
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("投稿列表暂时不可用"));

  uploadError = false;
  uploads = [];
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("还没有投稿"));
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "home" }));
});
