import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ThemeEngineState = {
  ensure: () => void;
  cleanup: () => boolean;
  observer: MutationObserver;
  themeId: string;
  revision: string;
  layout: string;
  detectShellMode: () => string;
};

declare global {
  interface Window {
    __CODEX_NN_THEME_STATE__?: ThemeEngineState;
  }
}

const template = readFileSync(
  resolve("src-tauri/resources/theme-engine/renderer-inject.js"),
  "utf-8"
);
const engineCss = readFileSync(
  resolve("src-tauri/resources/theme-engine/nn-theme.css"),
  "utf-8"
);
const themeCss = engineCss;
const cdpSource = readFileSync(resolve("src-tauri/src/cdp.rs"), "utf-8");
const verifyScriptMatch = cdpSource.match(/const VERIFY_SCRIPT: &str = r#"([\s\S]*?)"#;/);
if (!verifyScriptMatch) throw new Error("无法读取 VERIFY_SCRIPT");
const verifyScript = verifyScriptMatch[1];

function manifest(layoutPreset = "standard", id = "engine-test") {
  return {
    schemaVersion: 1,
    id,
    name: "引擎测试主题",
    layoutPreset,
    brandSubtitle: "ENGINE TEST",
    tagline: "主题引擎测试",
    projectPrefix: "项目 · ",
    projectLabel: "选择项目",
    statusText: "ONLINE",
    quote: "TEST THE ENGINE",
    image: "background.png",
    appearance: layoutPreset === "azureNeon" ? "dark" :
      ["strawberryStarlight", "mikuFuture", "adventureAtlas"].includes(layoutPreset) ? "light" : "auto",
    art: {
      focusX: 0.74,
      focusY: 0.48,
      safeArea: "left",
      taskMode: "ambient"
    },
    artMetadata: {
      width: 1600,
      height: 900,
      ratio: 1600 / 900,
      wide: true,
      aspect: "wide",
      taskMode: "ambient"
    },
    colors: {
      background: "#071116",
      panel: "#0b1a20",
      panelAlt: "#10272c",
      accent: "#e25563",
      accentAlt: "#f07a86",
      secondary: "#f3a8af",
      highlight: "#c93d4c",
      text: "#f2fff7",
      muted: "#a7c2ba",
      line: "rgba(226, 85, 99, 0.32)"
    }
  };
}

function renderScript(
  layoutPreset = "standard",
  id = "engine-test",
  theme = manifest(layoutPreset, id),
  artDataUrl = "data:image/png;base64,aW1hZ2U="
): string {
  return template
    .replace("__CODEX_NN_THEME_CSS_JSON__", JSON.stringify(".codex-nn-theme { color: red; }"))
    .replace("__CODEX_NN_THEME_ART_JSON__", JSON.stringify(artDataUrl))
    .replace("__CODEX_NN_THEME_CONFIG_JSON__", JSON.stringify(theme))
    .replace("__CODEX_NN_THEME_VERSION_JSON__", JSON.stringify("test-version"))
    .replace("__CODEX_NN_THEME_REVISION_JSON__", JSON.stringify(`revision-${id}`));
}

function install(layoutPreset = "standard", id = "engine-test"): Record<string, unknown> {
  return window.eval(renderScript(layoutPreset, id)) as Record<string, unknown>;
}

async function flushEngineMutations(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  document.documentElement.className = "light";
  document.body.innerHTML = `
    <aside class="app-shell-left-panel"></aside>
    <main class="main-surface">
      <section role="main">
        <span data-testid="home-icon"></span>
        <div data-feature="game-source"></div>
        <div class="group/home-suggestions"><button>一</button><button>二</button></div>
        <div class="composer-surface-chrome"></div>
      </section>
    </main>
  `;
  let artSequence = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:theme-art-${++artSequence}`)
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: (handle: number) => window.clearTimeout(handle)
  });
});

afterEach(() => {
  window.__CODEX_NN_THEME_STATE__?.cleanup();
  document.querySelectorAll("[data-test-theme-css]").forEach((node) => node.remove());
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});

describe("主题注入引擎", () => {
  it("为宽屏聊天页提供整窗背景和分层可读性表面", () => {
    expect(engineCss).toContain('[data-nn-art-wide="true"]');
    expect(engineCss).toContain("background-image: var(--nn-theme-art) !important");
    expect(engineCss).toContain("--nn-task-sidebar");
    expect(engineCss).toContain("--nn-immersive-composer");
    expect(engineCss).toContain(":has(main.main-surface:not(.nn-theme-home-shell)) .composer-surface-chrome");
    expect(engineCss).toContain('[data-nn-theme-layout="strawberry-starlight"][data-nn-art-wide="true"]');
    expect(engineCss).toContain('[data-nn-theme-layout="azure-neon"] main.main-surface');
    expect(engineCss).toContain(':not([data-nn-theme-layout="dream-skin"])[data-nn-art-wide="true"]');
    expect(engineCss).toContain('.thread-scroll-container .bg-gradient-to-t.from-token-main-surface-primary');
    expect(engineCss).toContain('[class~="group/application-menu-top-bar"]');
    expect(engineCss).toContain('> :not(header.app-header-tint)');
  });

  it.each([
    ["standard", "standard", "light"],
    ["dreamSkin", "dream-skin", "light"],
    ["strawberryStarlight", "strawberry-starlight", "light"],
    ["azureNeon", "azure-neon", "dark"],
    ["mikuFuture", "miku-future", "light"],
    ["adventureAtlas", "adventure-atlas", "light"]
  ])("映射 %s 布局并选择正确 Shell", (preset, layout, shell) => {
    const result = install(preset, `layout-${preset}`);

    expect(result).toMatchObject({ layout, shell });
    expect(document.documentElement.dataset.nnThemeLayout).toBe(layout);
    expect(document.documentElement.dataset.nnThemeShell).toBe(shell);
    expect(document.documentElement.dataset.nnThemePage).toBe("home");
  });

  it.each([
    ["dreamSkin", false],
    ["strawberryStarlight", true],
    ["azureNeon", true],
    ["mikuFuture", true],
    ["adventureAtlas", true]
  ])("%s 在新版首页 Portal 中保留行动卡", (preset, composedHome) => {
    document.body.innerHTML = `
      <aside class="app-shell-left-panel"></aside>
      <main class="main-surface">
        <section role="main">
          <div class="min-h-full">
            <div class="hero-row">
              <div id="hero-shell">
                <div><div><div data-feature="game-source"></div></div></div>
                <div id="suggestions-slot">
                  <section class="group/home-suggestions">
                    <div><button><span><span><svg></svg></span></span><span>行动一</span></button></div>
                  </section>
                </div>
              </div>
            </div>
            <div><div class="composer-surface-chrome"></div></div>
          </div>
        </section>
      </main>
    `;
    const style = document.createElement("style");
    style.dataset.testThemeCss = "true";
    style.textContent = themeCss;
    document.head.appendChild(style);

    install(preset, `portal-${preset}`);

    const route = document.querySelector('[role="main"]')!;
    const suggestions = document.querySelector(".group\\/home-suggestions")!;
    const slot = document.getElementById("suggestions-slot")!;
    expect(suggestions.classList.contains("nn-theme-suggestions")).toBe(true);
    expect(slot.classList.contains("nn-theme-suggestions-slot")).toBe(true);
    expect(route.classList.contains("nn-theme-home")).toBe(composedHome);
    expect(getComputedStyle(suggestions).zIndex).toBe("3");
    if (composedHome) {
      const heroStyle = getComputedStyle(document.getElementById("hero-shell")!);
      expect(heroStyle.zIndex).toBe("2");
      expect(heroStyle.overflow).toBe("visible");
      expect(getComputedStyle(slot).zIndex).toBe("3");

      const followUpArea = document.createElement("div");
      const followUpSlot = document.createElement("div");
      followUpArea.appendChild(followUpSlot);
      route.appendChild(followUpArea);
      followUpSlot.appendChild(suggestions);
      window.__CODEX_NN_THEME_STATE__?.ensure();
      expect(slot.classList.contains("nn-theme-suggestions-slot")).toBe(false);
      expect(followUpSlot.classList.contains("nn-theme-suggestions-slot")).toBe(false);
      expect(suggestions.classList.contains("nn-theme-suggestions")).toBe(true);
    } else {
      expect(getComputedStyle(suggestions.querySelector("button")!).borderRadius).toBe("18px");
    }
  });

  it("Miku 预设标记侧栏入口并以几何中心定位行动卡图标", () => {
    document.body.innerHTML = `
      <aside class="app-shell-left-panel">
        <button>新建任务</button>
        <button>拉取请求</button>
        <button data-app-action-sidebar-section-toggle>项目</button>
      </aside>
      <main class="main-surface">
        <section role="main">
          <span data-testid="home-icon"></span>
          <div data-feature="game-source"></div>
          <section class="group/home-suggestions">
            <button><span><span id="miku-action-icon"><svg></svg></span></span><span>行动</span></button>
          </section>
          <div class="composer-surface-chrome"></div>
        </section>
      </main>
    `;
    const style = document.createElement("style");
    style.dataset.testThemeCss = "true";
    style.textContent = themeCss;
    document.head.appendChild(style);

    install("mikuFuture", "miku-layout-test");

    expect(document.querySelector("button")?.dataset.nnSidebarItem).toBe("new-task");
    expect(document.querySelectorAll("button")[1]?.dataset.nnSidebarItem).toBe("pull-requests");
    expect(document.querySelectorAll("button")[2]?.dataset.nnSidebarSection).toBe("projects");
    expect(document.querySelector(".nn-miku-header-decor")).not.toBeNull();
    const icon = document.querySelector<SVGElement>("#miku-action-icon > svg")!;
    expect(getComputedStyle(icon).position).toBe("absolute");
    expect(getComputedStyle(icon).left).toBe("50%");
    expect(getComputedStyle(icon).top).toBe("50%");
    expect(getComputedStyle(icon).transform).toContain("-50%");

    expect(window.__CODEX_NN_THEME_STATE__?.cleanup()).toBe(true);
    expect(document.querySelector("[data-nn-sidebar-item]")).toBeNull();
    expect(document.querySelector("[data-nn-sidebar-section]")).toBeNull();
  });

  it.each([
    ["strawberryStarlight", "strawberry-starlight", "light"],
    ["azureNeon", "azure-neon", "dark"],
    ["mikuFuture", "miku-future", "light"],
    ["adventureAtlas", "adventure-atlas", "light"]
  ])("%s 从首页切到聊天页后保留原布局和装饰层", (preset, layout, shell) => {
    install(preset, `built-in-${preset}`);
    const route = document.querySelector('[role="main"]')!;

    expect(route.classList.contains("nn-theme-home")).toBe(true);
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(true);
    expect(document.getElementById("codex-nn-theme-chrome")).not.toBeNull();
    expect(document.querySelector('[class^="nn-dream-"]')).toBeNull();

    route.innerHTML = `
      <div class="thread-scroll-container"></div>
      <div class="composer-surface-chrome"></div>
    `;
    window.__CODEX_NN_THEME_STATE__?.ensure();

    expect(document.documentElement.dataset.nnThemeLayout).toBe(layout);
    expect(document.documentElement.dataset.nnThemeShell).toBe(shell);
    expect(document.documentElement.dataset.nnThemePage).toBe("thread");
    expect(document.documentElement.dataset.nnTaskMode).toBe("ambient");
    expect(route.classList.contains("nn-theme-home")).toBe(false);
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.getElementById("codex-nn-theme-chrome")).not.toBeNull();
    expect(document.getElementById("codex-nn-theme-chrome")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.querySelector('[class^="nn-dream-"]')).toBeNull();
  });

  it("冒险图鉴标记侧栏导航和对话，并在清理时完整撤销", () => {
    document.querySelector("aside")!.innerHTML = `
      <button aria-label="切换模式，当前模式：Codex"><span>Codex</span></button>
      <button><div><span><svg></svg></span><span class="text-fade-truncate">新建任务</span></div></button>
      <div data-app-action-sidebar-scroll>
        <section><div role="listitem"><div class="group" role="button">远行手记</div></div></section>
      </div>
    `;

    install("adventureAtlas", "adventure-sidebar-test");

    const sidebar = document.querySelector("aside")!;
    expect(sidebar.classList.contains("nn-adventure-sidebar")).toBe(true);
    expect(sidebar.querySelector('[data-nn-adventure-brand="true"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-nn-adventure-icon="＋"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-nn-adventure-thread="true"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-nn-adventure-section="0"]')).not.toBeNull();
    expect(document.querySelectorAll(".nn-adventure-frame")).toHaveLength(1);
    expect(document.querySelectorAll(".nn-adventure-windrose")).toHaveLength(1);

    window.__CODEX_NN_THEME_STATE__?.ensure();
    expect(document.querySelectorAll(".nn-adventure-frame")).toHaveLength(1);
    window.__CODEX_NN_THEME_STATE__?.cleanup();
    expect(sidebar.classList.contains("nn-adventure-sidebar")).toBe(false);
    expect(sidebar.querySelector("[data-nn-adventure-brand]")).toBeNull();
    expect(sidebar.querySelector("[data-nn-adventure-nav]")).toBeNull();
    expect(sidebar.querySelector("[data-nn-adventure-thread]")).toBeNull();
    expect(sidebar.querySelector("[data-nn-adventure-section]")).toBeNull();
  });

  it("安装主题并通过重复 ensure 保持单一装饰层", () => {
    const result = install();
    const state = window.__CODEX_NN_THEME_STATE__;

    expect(result).toMatchObject({ installed: true, themeId: "engine-test", layout: "standard" });
    expect(result.revision).toBe("revision-engine-test");
    expect(document.documentElement.classList.contains("codex-nn-theme")).toBe(true);
    expect(document.documentElement.dataset.nnThemeShell).toBe("light");
    expect(document.documentElement.dataset.nnArtWide).toBe("true");
    expect(document.documentElement.dataset.nnArtSafeArea).toBe("left");
    expect(document.documentElement.dataset.nnTaskMode).toBe("ambient");
    expect(document.documentElement.style.getPropertyValue("--nn-art-position")).toBe("74.00% 48.00%");
    expect(document.getElementById("codex-nn-theme-style")?.textContent).toContain("color: red");
    expect(document.querySelector('[role="main"]')?.classList.contains("nn-theme-home")).toBe(true);
    expect(document.querySelector(".nn-theme-brand b")?.textContent).toBe("引擎测试主题");

    state?.ensure();
    state?.ensure();
    expect(document.querySelectorAll("#codex-nn-theme-chrome")).toHaveLength(1);
    expect(document.querySelectorAll("#codex-nn-theme-style")).toHaveLength(1);
  });

  it("只有主题显式声明 taskMode 才在聊天页使用主题图", () => {
    const theme = manifest("dreamSkin", "task-mode-opt-in");
    delete (theme.art as { taskMode?: string }).taskMode;
    window.eval(renderScript("dreamSkin", "task-mode-opt-in", theme));

    expect(document.documentElement.dataset.nnTaskMode).toBe("off");

    window.eval(renderScript("dreamSkin", "task-mode-auto", {
      ...theme,
      id: "task-mode-auto",
      art: { ...theme.art, taskMode: "auto" }
    }));
    expect(document.documentElement.dataset.nnTaskMode).toBe("ambient");
  });

  it("Dream Skin 自动跟随原生外观并完整清理", () => {
    document.documentElement.className = "dark";
    install("dreamSkin", "dream-test");
    const state = window.__CODEX_NN_THEME_STATE__;

    expect(state?.layout).toBe("dream-skin");
    expect(document.documentElement.dataset.nnThemeShell).toBe("dark");
    expect(document.documentElement.dataset.nnThemePage).toBe("home");
    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.getElementById("codex-nn-theme-chrome")).toBeNull();
    expect(state?.cleanup()).toBe(true);
    expect(document.documentElement.classList.contains("codex-nn-theme")).toBe(false);
    expect(document.documentElement.hasAttribute("data-nn-theme-page")).toBe(false);
    expect(document.getElementById("codex-nn-theme-style")).toBeNull();
    expect(document.getElementById("codex-nn-theme-chrome")).toBeNull();
    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(document.documentElement.hasAttribute("data-nn-art-wide")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--nn-art-position")).toBe("");
  });

  it("重新注入时断开旧观察器并撤销旧图片 URL", () => {
    install("standard", "first-theme");
    const previous = window.__CODEX_NN_THEME_STATE__;
    const disconnect = vi.spyOn(previous!.observer, "disconnect");

    install("standard", "second-theme");

    expect(disconnect).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:theme-art-1");
    expect(window.__CODEX_NN_THEME_STATE__?.themeId).toBe("second-theme");
    expect(document.querySelectorAll("#codex-nn-theme-chrome")).toHaveLength(1);
    expect(previous?.cleanup()).toBe(false);
  });

  it("关键路由节点变化时不等待动画帧就更新布局", async () => {
    install("azureNeon", "route-test");
    await flushEngineMutations();
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 991);

    const route = document.querySelector('[role="main"]')!;
    route.innerHTML = '<div class="thread-scroll-container"></div>';
    await Promise.resolve();

    expect(route.classList.contains("nn-theme-home")).toBe(false);
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.documentElement.dataset.nnThemePage).toBe("thread");
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("新主题图片无效时保留当前主题", () => {
    install("standard", "active-theme");
    const previous = window.__CODEX_NN_THEME_STATE__;
    const style = document.getElementById("codex-nn-theme-style");

    expect(() => window.eval(renderScript(
      "dreamSkin",
      "invalid-theme",
      manifest("dreamSkin", "invalid-theme"),
      "not-a-data-url"
    ))).toThrow("Invalid theme art data URL");

    expect(window.__CODEX_NN_THEME_STATE__).toBe(previous);
    expect(document.getElementById("codex-nn-theme-style")).toBe(style);
    expect(document.documentElement.dataset.nnThemeLayout).toBe("standard");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("Dream Skin 在新版首页缺少 role 和 home icon 时仍保留原生布局", () => {
    const route = document.querySelector("section")!;
    route.removeAttribute("role");
    route.querySelector('[data-testid="home-icon"]')?.remove();
    const originalClassName = route.className;
    const originalStyle = route.getAttribute("style");

    install("dreamSkin", "native-home-test");

    expect(document.documentElement.dataset.nnThemePage).toBe("home");
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(route.className).toBe(originalClassName);
    expect(route.getAttribute("style")).toBe(originalStyle);
  });

  it.each(["standard", "strawberryStarlight", "azureNeon"])(
    "%s 在新版首页缺少 role 时仍完整应用 Hero 状态",
    (preset) => {
      const route = document.querySelector("section")!;
      route.removeAttribute("role");

      install(preset, `roleless-${preset}`);

      expect(document.documentElement.dataset.nnThemePage).toBe("home");
      expect(route.classList.contains("nn-theme-home")).toBe(true);
      expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(true);
    }
  );

  it("Dream Skin 在首页没有建议卡时仍识别页面状态", () => {
    document.querySelector(".group\\/home-suggestions")?.remove();

    install("dreamSkin", "home-without-suggestions-test");

    expect(document.documentElement.dataset.nnThemePage).toBe("home");
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.querySelector(".nn-theme-home")).toBeNull();
  });

  it("切换到 Dream Skin 时清除旧版 Hero 状态", () => {
    install("standard", "legacy-hero-test");
    expect(document.querySelector(".nn-theme-home")).not.toBeNull();

    install("dreamSkin", "native-wallpaper-test");

    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.documentElement.dataset.nnThemePage).toBe("home");
    expect(document.querySelectorAll("#codex-nn-theme-style")).toHaveLength(1);
    expect(document.querySelectorAll("#codex-nn-theme-chrome")).toHaveLength(0);
  });

  it("Dream Skin 在 composer 暂时卸载时不会误判为任务页", () => {
    document.querySelector(".composer-surface-chrome")?.remove();

    install("dreamSkin", "home-without-composer-test");

    expect(document.documentElement.dataset.nnThemePage).toBe("home");
    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
  });

  it("Dream Skin CSS 不包含原生布局几何重排", () => {
    const start = themeCss.indexOf("/* Dream Skin keeps Codex geometry native");
    const end = themeCss.indexOf("/* 两个内置主题共享原生布局", start);
    const dreamSkinCss = themeCss.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(dreamSkinCss).toContain("var(--nn-theme-art)");
    expect(dreamSkinCss).toContain('data-nn-theme-page="thread"');
    expect(dreamSkinCss).not.toMatch(
      /^\s*(?:position|inset|top|right|bottom|left|width|height|min-width|max-width|min-height|max-height|margin|padding|overflow|display|flex|grid-template)\s*:/m
    );
  });

  it("Dream Skin 聊天页缺省关闭主题图", () => {
    const route = document.querySelector('[role="main"]')!;
    route.innerHTML = `
      <div class="thread-scroll-container"></div>
      <div class="composer-surface-chrome"></div>
    `;
    const theme = manifest("dreamSkin", "dream-task-off");
    delete (theme.art as { taskMode?: string }).taskMode;

    window.eval(renderScript("dreamSkin", "dream-task-off", theme));

    expect(document.documentElement.dataset.nnThemePage).toBe("thread");
    expect(document.documentElement.dataset.nnTaskMode).toBe("off");
    expect(document.querySelector(".nn-theme-home")).toBeNull();
    expect(document.getElementById("codex-nn-theme-chrome")).toBeNull();
    expect(themeCss).toContain('[data-nn-theme-page="thread"][data-nn-task-mode="off"]');
    expect(themeCss).toMatch(
      /\[data-nn-theme-layout="dream-skin"\] body::before \{\s*content: none !important;/
    );
  });

  it("Dream Skin ambient 聊天页使用原生整窗壁纸", () => {
    const route = document.querySelector('[role="main"]')!;
    route.innerHTML = `
      <div class="thread-scroll-container"></div>
      <div class="composer-surface-chrome"></div>
    `;

    install("dreamSkin", "dream-task-ambient");

    expect(document.documentElement.dataset.nnThemePage).toBe("thread");
    expect(document.documentElement.dataset.nnTaskMode).toBe("ambient");
    expect(document.querySelector("main")?.classList.contains("nn-theme-home-shell")).toBe(false);
    expect(document.getElementById("codex-nn-theme-chrome")).toBeNull();
    expect(themeCss).toContain('[data-nn-theme-page="thread"][data-nn-task-mode="ambient"]');
    expect(themeCss).toContain("background-position: center, var(--nn-art-position) !important");
  });

  it("Dream Skin 透明化全高分栏表面但不影响局部控件", () => {
    document.documentElement.className = "codex-nn-theme";
    document.documentElement.dataset.nnThemeLayout = "dream-skin";
    document.documentElement.dataset.nnThemePage = "home";
    const style = document.createElement("style");
    style.dataset.testThemeCss = "true";
    style.textContent = `
      .bg-token-main-surface-primary { background: rgb(250, 250, 250); }
      ${themeCss}
    `;
    document.head.appendChild(style);
    document.querySelector("main")!.innerHTML = `
      <div><aside><div><div id="absolute-pane" class="absolute bg-token-main-surface-primary"></div></div></aside></div>
      <div><div id="full-height-pane" class="isolate h-full bg-token-main-surface-primary"></div></div>
      <button id="local-control" class="bg-token-main-surface-primary">控件</button>
    `;

    expect(getComputedStyle(document.getElementById("absolute-pane")!).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)"
    );
    expect(getComputedStyle(document.getElementById("full-height-pane")!).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)"
    );
    expect(getComputedStyle(document.getElementById("local-control")!).backgroundColor).toBe(
      "rgb(250, 250, 250)"
    );
  });

  it("CDP 验证 Dream Skin 无装饰层，并拒绝页面状态不一致", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 50,
      left: 0,
      width: 100,
      height: 50,
      toJSON: () => ({})
    } as DOMRect);
    install("dreamSkin", "verify-native-dream");

    const valid = window.eval(verifyScript) as { pass: boolean };
    expect(valid.pass).toBe(true);

    document.documentElement.dataset.nnThemePage = "thread";
    const stale = window.eval(verifyScript) as { pass: boolean };
    expect(stale.pass).toBe(false);
  });

  it("CDP 验证拒绝组合任务页残留的 Hero 状态", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 50,
      left: 0,
      width: 100,
      height: 50,
      toJSON: () => ({})
    } as DOMRect);
    const route = document.querySelector('[role="main"]')!;
    route.innerHTML = `
      <div><div><div></div></div></div>
      <span data-testid="home-icon"></span>
      <div data-feature="game-source"></div>
      <div class="group/home-suggestions"><button>一</button><button>二</button></div>
      <div class="composer-surface-chrome"></div>
    `;
    install("standard", "verify-composed-layout");
    const chrome = document.getElementById("codex-nn-theme-chrome")!;
    chrome.style.pointerEvents = "none";
    expect((window.eval(verifyScript) as { pass: boolean }).pass).toBe(true);

    route.appendChild(Object.assign(document.createElement("div"), { className: "thread-scroll-container" }));
    document.documentElement.dataset.nnThemePage = "thread";
    expect((window.eval(verifyScript) as { pass: boolean }).pass).toBe(false);
  });

  it("稳定 DOM 上重复 ensure 不会触发观察器回环", async () => {
    install("strawberryStarlight", "stable-test");
    await flushEngineMutations();
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 992);

    window.__CODEX_NN_THEME_STATE__?.ensure();
    await Promise.resolve();

    expect(requestFrame).not.toHaveBeenCalled();
    expect(document.querySelectorAll("#codex-nn-theme-chrome")).toHaveLength(1);
  });
});
