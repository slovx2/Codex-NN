import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DreamSkinState = {
  cleanup: () => boolean;
  ensure: (options?: { root?: boolean; route?: boolean; layout?: boolean }) => void;
  themeId: string;
  revision: string;
};

declare global {
  interface Window {
    __CODEX_DREAM_SKIN_STATE__?: DreamSkinState;
  }
}

const renderer = readFileSync(
  resolve("src-tauri/resources/theme-engine/dream-skin-renderer-inject.js"),
  "utf-8"
);
const css = readFileSync(
  resolve("src-tauri/resources/theme-engine/dream-skin.css"),
  "utf-8"
);
const nativeImage = window.Image;

function theme(taskMode?: "auto" | "ambient" | "banner" | "off") {
  return {
    schemaVersion: 1,
    id: `dream-${taskMode ?? "default"}`,
    name: "Dream Skin 兼容测试",
    brandSubtitle: "CODEX DREAM SKIN",
    tagline: "A native renderer contract test.",
    projectPrefix: "选择项目 · ",
    projectLabel: "◉  选择项目",
    statusText: "DREAM SKIN ONLINE",
    quote: "MAKE SOMETHING WONDERFUL",
    image: "background.png",
    appearance: "dark",
    art: {
      focusX: 0.76,
      focusY: 0.45,
      safeArea: "left",
      ...(taskMode ? { taskMode } : {}),
    },
    artMetadata: {
      width: 1600,
      height: 900,
      ratio: 1600 / 900,
      wide: true,
      aspect: "wide",
      taskMode: "ambient",
    },
    artKey: "dream-skin-test-art",
    explicitColorKeys: [
      "background", "panel", "panelAlt", "accent", "accentAlt",
      "secondary", "highlight", "text", "muted", "line",
    ],
    colors: {
      background: "#0d0d0e",
      panel: "#171513",
      panelAlt: "#211d18",
      accent: "#c8a55a",
      accentAlt: "#e3c27a",
      secondary: "#74352e",
      highlight: "#8a2f27",
      text: "#f3ead7",
      muted: "#b5a386",
      line: "rgba(200, 165, 90, .28)",
    },
  };
}

function payload(config = theme()): string {
  return renderer
    .replace("__DREAM_SKIN_CSS_JSON__", JSON.stringify(css))
    .replace("__DREAM_SKIN_ART_JSON__", JSON.stringify("data:image/png;base64,aW1hZ2U="))
    .replace("__DREAM_SKIN_THEME_JSON__", JSON.stringify(config))
    .replace("__DREAM_SKIN_VERSION_JSON__", JSON.stringify("1.2.0"))
    .replace("__DREAM_SKIN_STYLE_REVISION_JSON__", JSON.stringify("test-style"))
    .replace("__DREAM_SKIN_PAYLOAD_REVISION_JSON__", JSON.stringify(`revision-${config.id}`));
}

function install(config = theme()): Record<string, unknown> {
  return window.eval(payload(config)) as Record<string, unknown>;
}

beforeEach(() => {
  document.documentElement.className = "dark";
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = `
    <aside class="app-shell-left-panel"></aside>
    <main class="main-surface">
      <section role="main">
        <span data-testid="home-icon"></span>
        <div data-feature="game-source"></div>
        <div class="group/home-suggestions"><button>一</button><button>二</button></div>
        <div class="fixture_homeUtilityBar_test"></div>
        <div class="composer-surface-chrome"></div>
      </section>
    </main>
  `;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:dream-skin-art"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "Image", { configurable: true, value: undefined });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  window.__CODEX_DREAM_SKIN_STATE__?.cleanup();
  delete window.__CODEX_DREAM_SKIN_STATE__;
  Object.defineProperty(window, "Image", { configurable: true, value: nativeImage });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
});

describe("Dream Skin 1.2 原生兼容引擎", () => {
  it("安装首页、整窗宽图状态和新版 utility bar", () => {
    const result = install();

    expect(result).toMatchObject({
      installed: true,
      version: "1.2.0",
      themeId: "dream-default",
    });
    expect(document.documentElement.classList.contains("codex-dream-skin")).toBe(true);
    expect(document.documentElement.dataset.dreamShell).toBe("dark");
    expect(document.documentElement.dataset.dreamArtWide).toBe("true");
    expect(document.documentElement.dataset.dreamTaskMode).toBe("ambient");
    expect(document.documentElement.style.getPropertyValue("--dream-art-position")).toBe("76.00% 45.00%");
    expect(document.querySelector('[role="main"]')?.classList.contains("dream-skin-home")).toBe(true);
    expect(document.querySelector("main")?.classList.contains("dream-skin-home-shell")).toBe(true);
    expect(document.querySelector(".fixture_homeUtilityBar_test")?.classList.contains("dream-skin-home-utility")).toBe(true);
    expect(document.getElementById("codex-dream-skin-style")?.textContent).toBe(css);
    expect(document.getElementById("codex-dream-skin-chrome")).not.toBeNull();
  });

  it("taskMode 缺省与 auto 自动选型，显式 off 才关闭", () => {
    document.querySelector('[role="main"]')!.innerHTML = `
      <div class="thread-scroll-container"></div>
      <div class="composer-surface-chrome"></div>
    `;

    install(theme());
    expect(document.documentElement.dataset.dreamTaskMode).toBe("ambient");
    expect(document.querySelector("main")?.classList.contains("dream-skin-home-shell")).toBe(false);

    install(theme("auto"));
    expect(document.documentElement.dataset.dreamTaskMode).toBe("ambient");

    install(theme("off"));
    expect(document.documentElement.dataset.dreamTaskMode).toBe("off");
  });

  it("完整清理原生状态、装饰节点和图片 URL", () => {
    install();
    const state = window.__CODEX_DREAM_SKIN_STATE__;

    expect(state?.cleanup()).toBe(true);
    expect(document.documentElement.classList.contains("codex-dream-skin")).toBe(false);
    expect(document.documentElement.hasAttribute("data-dream-art-wide")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--dream-skin-art")).toBe("");
    expect(document.querySelector(".dream-skin-home")).toBeNull();
    expect(document.querySelector(".dream-skin-home-utility")).toBeNull();
    expect(document.getElementById("codex-dream-skin-style")).toBeNull();
    expect(document.getElementById("codex-dream-skin-chrome")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:dream-skin-art");
  });

  it("CSS 覆盖整窗首页、工具路由和输入区连续表面", () => {
    expect(css).toContain('[data-dream-art-wide="true"]:has(main.main-surface.dream-skin-home-shell) body');
    expect(css).toContain("background-image: var(--dream-skin-art) !important");
    expect(css).toContain(".dream-skin-home-utility");
    expect(css).toContain(".composer-surface-chrome");
    expect(css).toContain('div.sticky:has(input[type="text"])');
    expect(css).toContain("main.main-surface:not(.dream-skin-home-shell) [role=\"main\"]");
  });
});
