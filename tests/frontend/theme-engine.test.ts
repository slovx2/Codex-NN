import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ThemeEngineState = {
  ensure: () => void;
  cleanup: () => boolean;
  observer: MutationObserver;
  themeId: string;
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
      layoutPreset === "strawberryStarlight" ? "light" : "auto",
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
  theme = manifest(layoutPreset, id)
): string {
  return template
    .replace("__CODEX_NN_THEME_CSS_JSON__", JSON.stringify(".codex-nn-theme { color: red; }"))
    .replace("__CODEX_NN_THEME_ART_JSON__", JSON.stringify("data:image/png;base64,aW1hZ2U="))
    .replace("__CODEX_NN_THEME_CONFIG_JSON__", JSON.stringify(theme))
    .replace("__CODEX_NN_THEME_VERSION_JSON__", JSON.stringify("test-version"));
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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:theme-art")
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
    expect(engineCss).toContain('.thread-scroll-container .bg-gradient-to-t.from-token-main-surface-primary');
    expect(engineCss).toContain('[class~="group/application-menu-top-bar"]');
    expect(engineCss).toContain('> :not(header.app-header-tint)');
  });

  it.each([
    ["standard", "standard", "light"],
    ["dreamSkin", "dream-skin", "light"],
    ["strawberryStarlight", "strawberry-starlight", "light"],
    ["azureNeon", "azure-neon", "dark"]
  ])("映射 %s 布局并选择正确 Shell", (preset, layout, shell) => {
    const result = install(preset, `layout-${preset}`);

    expect(result).toMatchObject({ layout, shell });
    expect(document.documentElement.dataset.nnThemeLayout).toBe(layout);
    expect(document.documentElement.dataset.nnThemeShell).toBe(shell);
  });

  it("安装主题并通过重复 ensure 保持单一装饰层", () => {
    const result = install();
    const state = window.__CODEX_NN_THEME_STATE__;

    expect(result).toMatchObject({ installed: true, themeId: "engine-test", layout: "standard" });
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
    expect(state?.cleanup()).toBe(true);
    expect(document.documentElement.classList.contains("codex-nn-theme")).toBe(false);
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
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:theme-art");
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
    expect(requestFrame).not.toHaveBeenCalled();
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
