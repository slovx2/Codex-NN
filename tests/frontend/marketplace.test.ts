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

const card = {
  themeId: "018f-theme",
  versionId: "018f-version-2",
  manifestId: "community-night",
  title: "社区夜色",
  tags: ["深色", "安静", "专注", "第四个"],
  authorName: "测试作者",
  versionNumber: 2,
  downloadCount: 12,
  likeCount: 7,
  viewerLiked: false,
  cardPreviewUrl: "https://untrusted.invalid/card.jpg",
  publishedAt: "2026-07-17T08:00:00Z",
  previewDataUrl: "data:image/jpeg;base64,AA=="
};

const detail = {
  ...card,
  description: "适合长时间工作的安静深色主题",
  visibility: "public",
  manifest: {},
  detailPreviewUrl: "",
  detailPreviewDataUrl: "data:image/jpeg;base64,AA==",
  packageSize: 1024,
  packageSha256: "b".repeat(64)
};

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

function startMarketplace(localThemes: Array<Record<string, unknown>> = []): void {
  setupMarketplace({
    getInstalledThemes: () => localThemes as never,
    refreshLocalThemes: async () => undefined,
    showToast: vi.fn(),
    errorMessage: (error) => error instanceof Error ? error.message : String(error)
  });
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "marketplace" }));
}

test("发现页固定点赞排序信息层级，并在匿名点赞后登录重试", async () => {
  let auth = { loggedIn: false, pending: false, user: null as null | { id: string; publicName: string } };
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "marketplace_list_themes") {
      expect(args).toEqual({ query: "", page: 1 });
      return { items: [card], total: 1, page: 1, pageSize: 20, pages: 1 };
    }
    if (command === "marketplace_get_theme") return detail;
    if (command === "marketplace_local_sync_states") return [];
    if (command === "marketplace_auth_state") return auth;
    if (command === "marketplace_start_login") {
      auth = { loggedIn: true, pending: false, user: { id: "user-1", publicName: "访客" } };
      return { status: "complete", auth };
    }
    if (command === "marketplace_set_like") {
      expect(args).toEqual({ themeId: card.themeId, liked: true });
      return { liked: true, likeCount: 8 };
    }
    throw new Error(`未处理的命令：${command}`);
  });

  startMarketplace();
  await vi.waitFor(() => expect(document.body.textContent).toContain("社区夜色"));
  expect(document.body.textContent).toContain("测试作者");
  expect(document.body.textContent).toContain("♥ 7");
  expect(document.body.textContent).toContain("深色");
  expect(document.body.textContent).not.toContain("第四个");
  expect(document.getElementById("marketplace-sort")).toBeNull();
  expect(document.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg/);
  expect(document.body.innerHTML).not.toContain("untrusted.invalid");

  (document.querySelector("[data-marketplace-theme]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain(detail.description));
  expect(document.body.textContent).toContain("第四个");
  (document.getElementById("marketplace-like") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.getElementById("marketplace-like-count")?.textContent).toBe("8"));
  expect(document.getElementById("marketplace-like")?.textContent).toBe("取消点赞");
  expect(mocks.invoke).toHaveBeenCalledWith("marketplace_start_login");
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "home" }));
});

test("匿名用户可用永久分享码领取私密主题，分享码不进入 URL 参数", async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "marketplace_list_themes") {
      return { items: [], total: 0, page: 1, pageSize: 20, pages: 1 };
    }
    if (command === "marketplace_auth_state") {
      return { loggedIn: false, pending: false, user: null };
    }
    if (command === "marketplace_redeem_share_code") {
      expect(args).toEqual({ code: "CNN-1111-2222-3333-4444-5555" });
      return card.themeId;
    }
    if (command === "marketplace_get_theme") {
      return { ...detail, visibility: "private" };
    }
    if (command === "marketplace_local_sync_states") return [];
    throw new Error(`未处理的命令：${command}`);
  });

  startMarketplace();
  await vi.waitFor(() => expect(document.body.textContent).toContain("输入分享码"));
  (document.getElementById("marketplace-redeem") as HTMLButtonElement).click();
  const input = document.getElementById("marketplace-share-code") as HTMLInputElement;
  input.value = "CNN-1111-2222-3333-4444-5555";
  (document.getElementById("marketplace-redeem-form") as HTMLFormElement)
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.body.textContent).toContain(detail.description));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("当前这台机器"), expect.anything());
  expect(location.search).toBe("");
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "home" }));
});

test("投稿元数据、不可逆公开、永久分享码和软下架恢复流程可用", async () => {
  const localThemes = [{
    id: "local-theme",
    name: "本地主题",
    tagline: "本地简介",
    quote: "",
    accent: "#334455",
    previewDataUrl: "",
    active: false,
    builtIn: false
  }];
  let uploads = [{
    themeId: "private-theme",
    versionId: "private-v1",
    manifestId: "private-theme",
    versionNumber: 1,
    status: "published",
    title: "私密主题",
    description: "",
    tags: ["私密"],
    visibility: "private",
    packageSha256: "a".repeat(64),
    packageSize: 1024,
    createdAt: "2026-07-17T08:00:00Z",
    reviewedAt: "2026-07-17T08:00:10Z"
  }, {
    themeId: "public-theme",
    versionId: "public-v1",
    manifestId: "public-theme",
    versionNumber: 1,
    status: "withdrawn",
    title: "已下架公开主题",
    description: "",
    tags: [],
    visibility: "public",
    packageSha256: "c".repeat(64),
    packageSize: 1024,
    createdAt: "2026-07-17T08:00:00Z",
    reviewedAt: "2026-07-17T08:00:10Z"
  }];
  mocks.confirm.mockResolvedValue(true);
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "marketplace_list_themes") {
      return { items: [], total: 0, page: 1, pageSize: 20, pages: 1 };
    }
    if (command === "marketplace_auth_state") {
      return { loggedIn: true, pending: false, user: { id: "owner", publicName: "作者" } };
    }
    if (command === "marketplace_list_my_uploads") return uploads;
    if (command === "marketplace_local_sync_states") return [];
    if (command === "marketplace_list_share_codes") {
      return [{
        shareCodeId: "code-1",
        code: "",
        createdAt: "2026-07-17T08:00:00Z",
        redemptionCount: 3,
        lastRedeemedAt: "2026-07-17T09:00:00Z"
      }];
    }
    if (command === "marketplace_prepare_upload") {
      return {
        manifestId: "local-theme",
        defaultTitle: "本地主题",
        defaultDescription: "本地简介",
        listing: { title: "公开主题", description: "简介", tags: ["初始"], visibility: "public" },
        existingVisibility: "public"
      };
    }
    if (command === "marketplace_upload_theme") {
      expect(args?.listing).toEqual({
        title: "修改后的标题",
        description: "简介",
        tags: ["初始", "新增"],
        visibility: "public"
      });
      return {
        uploaded: true,
        needsConfirmation: false,
        isUpdate: true,
        title: "修改后的标题",
        previousVersionNumber: 1,
        record: { ...uploads[1], status: "reviewing", title: "修改后的标题", versionNumber: 2 }
      };
    }
    if (command === "marketplace_create_share_code") {
      return {
        shareCodeId: "code-2",
        code: "CNN-AAAA-BBBB-CCCC-DDDD-EEEE",
        createdAt: "2026-07-17T10:00:00Z",
        redemptionCount: 0,
        lastRedeemedAt: null
      };
    }
    if (command === "marketplace_restore_theme") {
      uploads = uploads.map((item) => item.themeId === args?.themeId ? { ...item, status: "published" } : item);
      return null;
    }
    throw new Error(`未处理的命令：${command}`);
  });

  startMarketplace(localThemes);
  (document.getElementById("marketplace-mine-tab") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("3 次领取"));
  expect(document.body.textContent).toContain("已下架公开主题");
  (document.getElementById("marketplace-upload-installed") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.getElementById("marketplace-listing-form")).not.toBeNull());
  const privateOption = document.querySelector<HTMLOptionElement>("#marketplace-listing-visibility option[value=private]");
  expect(privateOption?.disabled).toBe(true);
  (document.getElementById("marketplace-listing-title") as HTMLInputElement).value = "修改后的标题";
  const tagInput = document.getElementById("marketplace-tag-input") as HTMLInputElement;
  tagInput.value = "新增";
  tagInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(document.body.textContent).toContain("新增 ×");
  (document.getElementById("marketplace-listing-form") as HTMLFormElement)
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "marketplace_upload_theme",
    expect.objectContaining({ allowUpdate: false })
  ));

  await vi.waitFor(() => expect(document.querySelector("[data-create-share-code]")).not.toBeNull());
  (document.querySelector("[data-create-share-code]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("CNN-AAAA-BBBB-CCCC-DDDD-EEEE"));
  expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("不能撤销或删除"), expect.anything());
  (document.querySelector("[data-close-marketplace]") as HTMLButtonElement).click();
  expect(document.body.textContent).not.toContain("CNN-AAAA-BBBB-CCCC-DDDD-EEEE");

  (document.querySelector("[data-restore-theme]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
    "marketplace_restore_theme",
    { themeId: "public-theme" }
  ));
  window.dispatchEvent(new CustomEvent("codexnn:page-changed", { detail: "home" }));
});
