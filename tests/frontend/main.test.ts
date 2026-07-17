import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AppSnapshot,
  ThemeDesignerPluginStatus,
  ThemeInstallOutcome,
  ThemeSummary
} from "../../src/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  cssSupports: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  handlers: new Map<string, (args?: Record<string, unknown>) => unknown>()
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.confirm,
  open: mocks.open,
  save: mocks.save
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));

const builtInTheme = theme("strawberry-starlight", "星莓流光", true, true);
const customTheme = theme("custom-neon", "自定义霓虹", false, false);

function theme(id: string, name: string, active: boolean, builtIn: boolean): ThemeSummary {
  return {
    id,
    name,
    tagline: `${name}标语`,
    quote: `${name}引语`,
    accent: "#ff6688",
    previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
    active,
    builtIn
  };
}

function appSnapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    session: "off",
    port: null,
    watcherRunning: false,
    codex: {
      installed: true,
      running: false,
      version: "1.2.3",
      path: "/Applications/Codex.app",
      message: null
    },
    activeTheme: builtInTheme,
    lastError: null,
    ...overrides
  };
}

const pluginStatus = (overrides: Partial<ThemeDesignerPluginStatus> = {}): ThemeDesignerPluginStatus => ({
  installed: false,
  managed: false,
  conflict: false,
  version: "0.1.0",
  message: null,
  ...overrides
});

function installOutcome(overrides: Partial<ThemeInstallOutcome> = {}): ThemeInstallOutcome {
  return {
    installed: true,
    updated: false,
    needsConfirmation: false,
    theme: customTheme,
    ...overrides
  };
}

async function boot(): Promise<void> {
  await import("../../src/main");
  await vi.waitFor(() => expect(text("header-status")).not.toBe("读取中"));
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

function button(id: string): HTMLButtonElement {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`缺少按钮 #${id}`);
  return value;
}

function click(id: string): void {
  button(id).click();
}

function emit(name: string, payload: unknown): void {
  const listener = mocks.listeners.get(name);
  if (!listener) throw new Error(`事件未监听：${name}`);
  listener({ payload });
}

function setHandler(name: string, handler: (args?: Record<string, unknown>) => unknown): void {
  mocks.handlers.set(name, handler);
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  mocks.listeners.clear();
  mocks.handlers.clear();
  mocks.confirm.mockResolvedValue(true);
  mocks.open.mockResolvedValue(null);
  mocks.save.mockResolvedValue(null);
  mocks.check.mockResolvedValue(null);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.cssSupports.mockImplementation((_property: string, value: string) => value !== "not-a-color");
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { supports: mocks.cssSupports }
  });
  mocks.listen.mockImplementation((name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return Promise.resolve(() => undefined);
  });
  setHandler("get_app_snapshot", () => appSnapshot());
  setHandler("list_themes", () => [builtInTheme, customTheme]);
  setHandler("get_theme_designer_plugin_status", () => pluginStatus());
  setHandler("set_app_accent", () => null);
  mocks.invoke.mockImplementation((name: string, args?: Record<string, unknown>) => {
    const handler = mocks.handlers.get(name);
    if (!handler) return Promise.reject(new Error(`未模拟命令：${name}`));
    try {
      return Promise.resolve(handler(args));
    } catch (error) {
      return Promise.reject(error);
    }
  });
});

describe("主应用界面", () => {
  it("初始化状态、切换导航并选择主题", async () => {
    const unsafeTheme = { ...builtInTheme, name: "<script>坏名字</script>" };
    setHandler("get_app_snapshot", () => appSnapshot({ activeTheme: unsafeTheme }));
    setHandler("list_themes", () => [unsafeTheme, customTheme]);

    await boot();

    expect(text("header-status")).toBe("未启用");
    expect(text("codex-version")).toBe("Codex 1.2.3");
    expect(document.querySelector("#hero-card script")).toBeNull();
    expect(text("current-theme-name")).toContain("<script>");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff6688");
    expect(mocks.invoke).toHaveBeenCalledWith("set_app_accent", { accent: "#ff6688" });
    click("import-dream-skin-button");
    expect(document.getElementById("dream-import-dialog")?.hidden).toBe(false);
    click("close-dream-import-button");
    expect(document.getElementById("dream-import-dialog")?.hidden).toBe(true);

    button("activate-theme-button");
    const customSelect = document.querySelector<HTMLButtonElement>('[data-theme-id="custom-neon"]');
    customSelect?.click();
    expect(text("selected-theme-name")).toBe("自定义霓虹");
    document.querySelector<HTMLButtonElement>('[data-page="diagnostics"]')?.click();
    expect(document.getElementById("page-diagnostics")?.classList.contains("active")).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-open-page="themes"]')?.click();
    expect(document.getElementById("page-themes")?.classList.contains("active")).toBe(true);
  });

  it("非法主题强调色回退到应用默认色", async () => {
    const invalidAccent = { ...builtInTheme, accent: "not-a-color" };
    setHandler("get_app_snapshot", () => appSnapshot({ activeTheme: invalidAccent }));
    setHandler("list_themes", () => [invalidAccent]);

    await boot();

    expect(mocks.cssSupports).toHaveBeenCalledWith("color", "not-a-color");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#e2556d");
    expect(mocks.invoke).toHaveBeenCalledWith("set_app_accent", { accent: "#e2556d" });
  });

  it("启动、应用、暂停、恢复和切换主题", async () => {
    const active = appSnapshot({
      session: "active",
      port: 9341,
      watcherRunning: true,
      codex: { ...appSnapshot().codex, running: true }
    });
    setHandler("launch_codex", () => active);
    setHandler("apply_theme", () => active);
    setHandler("pause_theme", () => appSnapshot({ session: "paused" }));
    setHandler("restore_theme", () => appSnapshot());
    setHandler("activate_theme", (args) => {
      const activated = appSnapshot({
        session: "active",
        activeTheme: { ...customTheme, id: String(args?.id), active: true }
      });
      setHandler("get_app_snapshot", () => activated);
      return activated;
    });

    await boot();
    click("launch-button");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("launch_codex"));
    expect(text("header-status")).toBe("主题已启用");
    await vi.waitFor(() => expect(button("apply-button").disabled).toBe(false));
    click("apply-button");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("apply_theme"));
    await vi.waitFor(() => expect(button("pause-button").disabled).toBe(false));
    click("pause-button");
    await vi.waitFor(() => expect(text("header-status")).toBe("已暂停"));

    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    click("restore-button");
    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalledWith("restore_theme");
    click("restore-button");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("restore_theme"));

    document.querySelector<HTMLButtonElement>('[data-theme-id="custom-neon"]')?.click();
    click("activate-theme-button");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_theme", { id: "custom-neon" }));
    await vi.waitFor(() => expect(text("toast")).toContain("热切换"));
  });

  it("安装与更新普通主题包", async () => {
    mocks.open.mockResolvedValue("/tmp/custom.zip");
    const pending = installOutcome({ installed: false, needsConfirmation: true });
    const updated = installOutcome({ updated: true });
    let installs = 0;
    setHandler("install_theme_package", (args) => {
      installs += 1;
      const request = args?.request as { packagePath: string; allowUpdate: boolean };
      expect(request.packagePath).toBe("/tmp/custom.zip");
      return request.allowUpdate ? updated : pending;
    });

    await boot();
    click("import-theme-button");

    await vi.waitFor(() => expect(installs).toBe(2));
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("已经安装"), expect.anything());
    expect(text("toast")).toContain("已更新");
  });

  it("从目录和 ZIP 导入 Dream Skin 主题", async () => {
    mocks.open
      .mockResolvedValueOnce("/tmp/dream-directory")
      .mockResolvedValueOnce("/tmp/dream.zip");
    const requests: Array<{ sourcePath: string; allowUpdate: boolean }> = [];
    setHandler("install_dream_skin_theme", (args) => {
      const request = args?.request as { sourcePath: string; allowUpdate: boolean };
      requests.push(request);
      return installOutcome();
    });

    await boot();
    click("import-dream-skin-button");
    click("choose-dream-folder-button");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({ sourcePath: "/tmp/dream-directory", allowUpdate: false });

    click("import-dream-skin-button");
    click("choose-dream-zip-button");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.sourcePath).toBe("/tmp/dream.zip");
  });

  it("确认后更新已存在的 Dream Skin 主题", async () => {
    mocks.open.mockResolvedValue("/tmp/dream.zip");
    const requests: boolean[] = [];
    setHandler("install_dream_skin_theme", (args) => {
      const request = args?.request as { allowUpdate: boolean };
      requests.push(request.allowUpdate);
      return request.allowUpdate
        ? installOutcome({ updated: true })
        : installOutcome({ installed: false, needsConfirmation: true });
    });

    await boot();
    click("import-dream-skin-button");
    click("choose-dream-zip-button");

    await vi.waitFor(() => expect(requests).toEqual([false, true]));
    expect(text("toast")).toContain("已更新 Dream Skin");
  });

  it("取消文件选择时不执行安装或验证", async () => {
    setHandler("get_app_snapshot", () => appSnapshot({ activeTheme: null }));
    setHandler("list_themes", () => []);
    await boot();

    expect(text("theme-list")).toContain("主题库为空");
    click("import-theme-button");
    click("import-dream-skin-button");
    click("choose-dream-folder-button");
    click("screenshot-button");
    await Promise.resolve();

    expect(mocks.invoke).not.toHaveBeenCalledWith("install_theme_package", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("install_dream_skin_theme", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("verify_theme", expect.anything());
    expect(button("activate-theme-button").disabled).toBe(true);
  });
});

describe("主题库与插件操作", () => {
  it("删除自定义主题并保留内置主题保护", async () => {
    let library = [builtInTheme, customTheme];
    setHandler("list_themes", () => library);
    setHandler("delete_theme", (args) => {
      expect(args).toEqual({ id: "custom-neon" });
      library = [builtInTheme];
      return appSnapshot();
    });

    await boot();
    expect(document.querySelector('[data-delete-theme="strawberry-starlight"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-delete-theme="custom-neon"]')?.click();

    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("delete_theme", { id: "custom-neon" }));
    expect(document.querySelector('[data-theme-id="custom-neon"]')).toBeNull();
    expect(text("toast")).toContain("已删除");
  });

  it("安装和卸载主题设计插件", async () => {
    setHandler("install_theme_designer_plugin", () => pluginStatus({
      installed: true,
      managed: true,
      message: "插件已经就绪"
    }));
    setHandler("uninstall_theme_designer_plugin", () => pluginStatus());

    await boot();
    click("install-designer-plugin-button");
    await vi.waitFor(() => expect(text("designer-plugin-state")).toBe("已安装"));
    expect(text("designer-plugin-message")).toBe("插件已经就绪");

    click("uninstall-designer-plugin-button");
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("uninstall_theme_designer_plugin"));
    expect(text("designer-plugin-state")).toBe("未安装");
  });

  it("插件配置冲突或状态读取失败时禁止覆盖", async () => {
    setHandler("get_theme_designer_plugin_status", () => {
      throw new Error("配置损坏");
    });

    await boot();

    expect(text("designer-plugin-state")).toBe("需要处理");
    expect(text("designer-plugin-message")).toContain("配置损坏");
    expect(button("install-designer-plugin-button").disabled).toBe(true);
    expect(button("uninstall-designer-plugin-button").disabled).toBe(true);
  });

  it("Codex 未安装时禁用启动和插件安装", async () => {
    setHandler("get_app_snapshot", () => appSnapshot({
      activeTheme: null,
      codex: {
        installed: false,
        running: false,
        version: null,
        path: null,
        message: "未找到 Codex"
      }
    }));

    await boot();

    expect(text("codex-state")).toBe("未安装");
    expect(button("launch-button").disabled).toBe(true);
    expect(button("apply-button").disabled).toBe(true);
    expect(button("install-designer-plugin-button").disabled).toBe(true);
  });

  it("插件命令返回未完成状态时显示明确错误", async () => {
    setHandler("install_theme_designer_plugin", () => pluginStatus({ message: "安装未完成" }));
    await boot();
    click("install-designer-plugin-button");
    await vi.waitFor(() => expect(text("toast")).toBe("安装未完成"));

    vi.resetModules();
    document.body.innerHTML = '<div id="app"></div>';
    mocks.listeners.clear();
    setHandler("get_theme_designer_plugin_status", () => pluginStatus({ installed: true, managed: true }));
    setHandler("uninstall_theme_designer_plugin", () => pluginStatus({
      managed: true,
      conflict: true,
      message: "配置已被手工修改"
    }));
    await boot();
    click("uninstall-designer-plugin-button");
    await vi.waitFor(() => expect(text("toast")).toBe("配置已被手工修改"));
  });
});

describe("诊断、更新与事件", () => {
  it("展示静态诊断、实时验证和截图结果", async () => {
    setHandler("run_diagnostics", () => ({
      pass: false,
      checks: [
        { name: "官方 Codex", pass: true, detail: "已安装" },
        { name: "实时 CDP", pass: false, detail: "未连接" }
      ]
    }));
    setHandler("verify_theme", (args) => ({
      pass: args?.screenshotPath !== null,
      port: 9341,
      targetCount: 1,
      screenshotPath: args?.screenshotPath ?? null,
      details: { injected: true },
      message: args?.screenshotPath ? "截图验证通过" : "验证未通过"
    }));
    mocks.save.mockResolvedValue("/tmp/verification.png");

    await boot();
    click("diagnose-button");
    await vi.waitFor(() => expect(text("diagnostic-results")).toContain("实时 CDP"));
    expect(document.querySelectorAll(".check-row")).toHaveLength(2);

    click("verify-button");
    await vi.waitFor(() => expect(text("diagnostic-results")).toContain("实时验证未通过"));
    expect(document.getElementById("toast")?.classList.contains("error")).toBe(true);

    click("screenshot-button");
    await vi.waitFor(() => expect(text("diagnostic-results")).toContain("截图：/tmp/verification.png"));
    expect(text("diagnostic-results")).toContain("实时验证通过");
  });

  it("发现更新后下载、安装并按用户选择重启", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ version: "9.9.9", downloadAndInstall });
    mocks.confirm.mockResolvedValue(true);

    await boot();

    await vi.waitFor(() => expect(downloadAndInstall).toHaveBeenCalledOnce());
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("9.9.9"), expect.anything());
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(document.getElementById("settings-update-dot")?.hidden).toBe(true);
  });

  it("拒绝更新时保留设置红点且不下载", async () => {
    const downloadAndInstall = vi.fn();
    mocks.check.mockResolvedValue({ version: "9.9.9", downloadAndInstall });
    mocks.confirm.mockResolvedValue(false);
    await boot();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalled());
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(document.getElementById("settings-update-dot")?.hidden).toBe(false);
    expect(document.getElementById("settings-nav-item")?.dataset.updateAvailable).toBe("true");
    expect(text("header-status")).toBe("未启用");
  });

  it("可从设置页手动检查更新", async () => {
    mocks.check.mockResolvedValue(null);
    await boot();
    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(1));

    document.querySelector<HTMLButtonElement>('[data-page="settings"]')?.click();
    expect(document.getElementById("page-settings")?.classList.contains("active")).toBe(true);
    click("check-update-button");

    await vi.waitFor(() => expect(mocks.check).toHaveBeenCalledTimes(2));
    expect(text("toast")).toBe("当前已是最新版本");
    expect(text("check-update-button")).toBe("检查更新");
  });

  it("响应后台进度、状态、恢复请求和操作错误事件", async () => {
    setHandler("restore_theme", () => appSnapshot());
    await boot();

    emit("theme://progress", { phase: "apply", message: "正在注入" });
    expect(text("toast")).toBe("正在注入");
    emit("theme://status-changed", appSnapshot({ session: "error", lastError: "CDP 断开" }));
    expect(text("header-status")).toBe("运行异常");
    expect(text("home-details")).toContain("CDP 断开");
    emit("theme://operation-error", "后台操作失败");
    expect(text("toast")).toBe("后台操作失败");
    emit("theme://request-restore", null);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("restore_theme"));
  });

  it("操作异常时恢复按钮状态并显示错误", async () => {
    setHandler("launch_codex", () => {
      throw new Error("CDP 端口不可用");
    });
    await boot();

    click("launch-button");

    await vi.waitFor(() => expect(text("toast")).toContain("CDP 端口不可用"));
    expect(document.getElementById("toast")?.classList.contains("error")).toBe(true);
    expect(button("launch-button").disabled).toBe(false);
  });

  it("初始化失败时显示降级状态", async () => {
    setHandler("get_app_snapshot", () => {
      throw new Error("状态文件损坏");
    });

    await boot();

    expect(text("header-status")).toBe("初始化失败");
    expect(text("toast")).toContain("状态文件损坏");
  });

  it("覆盖全部会话状态和不可序列化错误", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    setHandler("launch_codex", () => {
      throw circular;
    });
    await boot();

    for (const [session, label] of [
      ["starting", "处理中"],
      ["stale", "等待启动"],
      ["paused", "已暂停"]
    ] as const) {
      emit("theme://status-changed", appSnapshot({ session }));
      expect(text("header-status")).toBe(label);
    }
    click("launch-button");
    await vi.waitFor(() => expect(text("toast")).toBe("发生未知错误"));
  });
});
