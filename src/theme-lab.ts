import "./theme-lab.css";

interface FixtureManifest {
  capturedAt: string;
  browser: string;
  sanitized: boolean;
  states: FixtureState[];
}

interface FixtureState {
  name: string;
  label: string;
  width: number;
  height: number;
  devicePixelRatio: number;
  shell: string;
  layout: string;
  page: string;
  styleSheetCount: number;
  elementCount: number;
  assetCount: number;
}

interface PreviewSize {
  label: string;
  width: number;
  height: number;
}

interface ImageMetadata {
  width: number;
  height: number;
  ratio: number;
  wide: boolean;
  aspect: string;
  taskMode: "ambient" | "banner";
}

interface ThemeConfig {
  id: string;
  image: string;
  layoutPreset?: string;
  artMetadata?: ImageMetadata;
  artKey?: string;
  colorMode?: "auto" | "explicit";
  explicitColorKeys?: string[];
  colors?: Record<string, string>;
  [key: string]: unknown;
}

type HistoryMode = "push" | "replace" | "none";

const fixtureBase = "/__codex_fixture__/";
const query = new URLSearchParams(window.location.search);
const defaultTheme = query.get("theme") || "miku-future-collab";
const defaultRoute = query.get("route") || "home";
const injectionSource = query.get("engine") === "upstream" ? "upstream" : "codex-nn";
const fixtureRouteLabels: Record<string, string> = {
  "新建任务": "home",
  "New task": "home",
  "拉取请求": "pull-requests",
  "Pull requests": "pull-requests",
  "已安排": "scheduled",
  "Scheduled": "scheduled",
  "插件": "plugins",
  "Plugins": "plugins",
};
function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`主题实验室缺少元素：${selector}`);
  return element;
}

const app = requiredElement<HTMLElement>("#theme-lab");

app.innerHTML = `
  <header class="lab-toolbar">
    <div class="lab-brand">
      <span>CODEX NN</span>
      <strong>主题实验室</strong>
      <small id="fixture-meta">正在读取本地快照…</small>
    </div>
    <nav class="lab-routes" id="lab-routes" aria-label="页面状态"></nav>
    <div class="lab-actions" role="group" aria-label="预览尺寸">
      <select id="theme-select" aria-label="预览主题">
        <option value="dream-skin-gothic">Dream Skin · Gothic Void Crusade</option>
        <option value="adventure-atlas">云海远行图鉴</option>
        <option value="caishen-readable">财神护航</option>
        <option value="miku-future-collab">初音未来</option>
        <option value="strawberry-starlight">星莓绮梦</option>
        <option value="azure-neon-frontier">苍蓝矩阵</option>
        <option value="portal-dimension-lab">瑞克与莫蒂</option>
      </select>
      <button type="button" data-size="capture">抓取尺寸</button>
      <button type="button" class="is-active" data-size="desktop">1440 × 900</button>
      <button type="button" data-size="compact">1024 × 768</button>
      <button type="button" data-size="wide">1728 × 1000</button>
      <button type="button" id="refresh-theme">刷新主题</button>
    </div>
  </header>
  <section class="lab-stage" aria-label="Codex 主题预览">
    <div class="lab-viewport" id="lab-viewport">
      <iframe
        id="codex-preview"
        title="Codex 主题预览"
        sandbox="allow-same-origin allow-scripts"
      ></iframe>
      <div class="fixture-navigation-overlay" id="fixture-navigation-overlay"></div>
    </div>
    <div class="lab-loading" id="lab-loading">正在还原 Codex 页面…</div>
  </section>
  <footer class="lab-status">
    <span id="lab-status-text">等待 fixture</span>
    <span>修改 nn-theme.css 后会自动更新</span>
  </footer>
  <button
    type="button"
    class="lab-fullscreen-toggle"
    id="lab-fullscreen-toggle"
    aria-pressed="true"
    aria-label="退出全屏预览"
    title="退出全屏预览"
  ><span aria-hidden="true">⛶</span></button>
`;

const frame = requiredElement<HTMLIFrameElement>("#codex-preview");
const viewport = requiredElement<HTMLElement>("#lab-viewport");
const navigationOverlay = requiredElement<HTMLElement>("#fixture-navigation-overlay");
const stage = requiredElement<HTMLElement>(".lab-stage");
const loading = requiredElement<HTMLElement>("#lab-loading");
const meta = requiredElement<HTMLElement>("#fixture-meta");
const routes = requiredElement<HTMLElement>("#lab-routes");
const themeSelect = requiredElement<HTMLSelectElement>("#theme-select");
const statusText = requiredElement<HTMLElement>("#lab-status-text");
const fullscreenToggle = requiredElement<HTMLButtonElement>("#lab-fullscreen-toggle");
if ([...themeSelect.options].some((option) => option.value === defaultTheme)) {
  themeSelect.value = defaultTheme;
}

let manifest: FixtureManifest | null = null;
let activeState: FixtureState | null = null;
let activeSize: PreviewSize = { label: "桌面", width: 1440, height: 900 };
let activeScale = 1;

function setFullscreen(fullscreen: boolean): void {
  app.classList.toggle("is-fullscreen", fullscreen);
  fullscreenToggle.ariaPressed = String(fullscreen);
  fullscreenToggle.setAttribute("aria-label", fullscreen ? "退出全屏预览" : "进入全屏预览");
  fullscreenToggle.title = fullscreen ? "退出全屏预览" : "进入全屏预览";
  window.requestAnimationFrame(() => resizePreview(activeSize));
}

function setStatus(message: string, kind: "idle" | "ready" | "error" = "idle"): void {
  statusText.textContent = message;
  statusText.dataset.kind = kind;
}

function availableSizes(): Record<string, PreviewSize> {
  return {
    capture: {
      label: "抓取尺寸",
      width: activeState?.width ?? 1440,
      height: activeState?.height ?? 900,
    },
    desktop: { label: "桌面", width: 1440, height: 900 },
    compact: { label: "紧凑", width: 1024, height: 768 },
    wide: { label: "宽屏", width: 1728, height: 1000 },
  };
}

function resizePreview(size: PreviewSize): void {
  activeSize = size;
  frame.style.width = `${size.width}px`;
  frame.style.height = `${size.height}px`;
  const gutter = app.classList.contains("is-fullscreen") ? 0 : 48;
  const availableWidth = Math.max(stage.clientWidth - gutter, 320);
  const availableHeight = Math.max(stage.clientHeight - gutter, 240);
  const scale = Math.min(availableWidth / size.width, availableHeight / size.height, 1);
  activeScale = scale;
  viewport.style.width = `${size.width * scale}px`;
  viewport.style.height = `${size.height * scale}px`;
  frame.style.zoom = String(scale);
  frame.style.transform = "none";
  viewport.dataset.size = `${size.width} × ${size.height} · ${Math.round(scale * 100)}%`;
  if (frame.classList.contains("is-ready")) renderNavigationOverlay();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("读取主题图片失败")), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function imageMetadata(dataUrl: string): Promise<ImageMetadata> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const candidate = new Image();
    candidate.addEventListener("load", () => resolve(candidate), { once: true });
    candidate.addEventListener("error", () => reject(new Error("无法解析主题图片")), { once: true });
    candidate.src = dataUrl;
  });
  const ratio = image.naturalWidth / image.naturalHeight;
  const aspect = ratio >= 2.25 ? "ultrawide" : ratio >= 1.45 ? "wide"
    : ratio >= 1.08 ? "landscape" : ratio >= 0.9 ? "square" : "portrait";
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    ratio,
    wide: ratio >= 1.75,
    aspect,
    taskMode: ratio >= 2.25 ? "banner" : "ambient",
  };
}

function dreamSkinPayload(renderer: string, css: string, artDataUrl: string, theme: ThemeConfig): string {
  const explicitColorKeys = [
    "background", "panel", "panelAlt", "accent", "accentAlt",
    "secondary", "highlight", "text", "muted", "line",
  ].filter((key) => Object.hasOwn(theme.colors ?? {}, key));
  const config = { ...theme };
  delete config.layoutPreset;
  config.colorMode = explicitColorKeys.length ? "explicit" : "auto";
  config.explicitColorKeys = explicitColorKeys;
  const revision = `${theme.id}-theme-lab`;
  const upstream = renderer
    .replace("__DREAM_SKIN_CSS_JSON__", JSON.stringify(css))
    .replace("__DREAM_SKIN_ART_JSON__", JSON.stringify(artDataUrl))
    .replace("__DREAM_SKIN_THEME_JSON__", JSON.stringify(config))
    .replace("__DREAM_SKIN_VERSION_JSON__", JSON.stringify("1.2.0"))
    .replace("__DREAM_SKIN_STYLE_REVISION_JSON__", JSON.stringify("theme-lab"))
    .replace("__DREAM_SKIN_PAYLOAD_REVISION_JSON__", JSON.stringify(revision));
  return `(() => {
    const previousNn = window.__CODEX_NN_THEME_STATE__;
    if (previousNn && previousNn !== window.__CODEX_DREAM_SKIN_STATE__) {
      try { previousNn.cleanup?.(); } catch {}
    }
    const result = (${upstream});
    const dreamState = window.__CODEX_DREAM_SKIN_STATE__;
    if (!dreamState) return result;
    const cleanupDreamSkin = dreamState.cleanup;
    const bridge = Object.create(dreamState);
    bridge.engine = "dream-skin";
    bridge.layout = "dream-skin";
    bridge.version = "theme-lab";
    bridge.themeId = ${JSON.stringify(theme.id)};
    bridge.revision = ${JSON.stringify(revision)};
    bridge.cleanup = () => {
      const cleaned = Reflect.apply(cleanupDreamSkin, dreamState, []);
      if (window.__CODEX_NN_THEME_STATE__ === bridge) delete window.__CODEX_NN_THEME_STATE__;
      return cleaned;
    };
    window.__CODEX_NN_THEME_STATE__ = bridge;
    return { ...result, engine: "dream-skin", layout: "dream-skin" };
  })()`;
}

async function applyTheme(): Promise<void> {
  const document = frame.contentDocument;
  if (!document?.documentElement) return;
  const themeId = themeSelect.value || defaultTheme;
  const externalDreamSkin = themeId === "dream-skin-gothic";
  const base = externalDreamSkin ? "/__dream_skin_theme__/" : `/theme-packs/${themeId}/`;
  const themeResponse = await fetch(`${base}theme.json?t=${Date.now()}`, { cache: "no-store" });
  if (!themeResponse.ok) throw new Error("读取主题清单失败");
  const theme = await themeResponse.json() as ThemeConfig;
  if (externalDreamSkin) theme.layoutPreset = "dreamSkin";
  const useDreamSkin = theme.layoutPreset === "dreamSkin";
  const engineBase = useDreamSkin && injectionSource === "upstream"
    ? "/__dream_skin_upstream__/"
    : "/__theme_source__/";
  const cssName = useDreamSkin ? "dream-skin.css" : "nn-theme.css";
  const rendererName = useDreamSkin
    ? injectionSource === "upstream" ? "renderer-inject.js" : "dream-skin-renderer-inject.js"
    : "renderer-inject.js";
  const [cssResponse, rendererResponse, artResponse] = await Promise.all([
    fetch(`${engineBase}${cssName}?t=${Date.now()}`, { cache: "no-store" }),
    fetch(`${engineBase}${rendererName}?t=${Date.now()}`, { cache: "no-store" }),
    fetch(`${base}${theme.image}?t=${Date.now()}`, { cache: "no-store" }),
  ]);
  if (!cssResponse.ok || !rendererResponse.ok) throw new Error("读取本地主题引擎失败");
  if (!artResponse.ok) throw new Error("读取主题背景失败");
  const [css, renderer, artDataUrl] = await Promise.all([
    cssResponse.text(),
    rendererResponse.text(),
    artResponse.blob().then(blobToDataUrl),
  ]);
  const metadata = await imageMetadata(artDataUrl);
  theme.artMetadata = metadata;
  theme.artKey = `${theme.id}-${metadata.width}x${metadata.height}`;
  const payload = useDreamSkin
    ? dreamSkinPayload(renderer, css, artDataUrl, theme)
    : renderer
      .replace("__CODEX_NN_THEME_CSS_JSON__", JSON.stringify(css))
      .replace("__CODEX_NN_THEME_ART_JSON__", JSON.stringify(artDataUrl))
      .replace("__CODEX_NN_THEME_CONFIG_JSON__", JSON.stringify(theme))
      .replace("__CODEX_NN_THEME_VERSION_JSON__", JSON.stringify("theme-lab"))
      .replace("__CODEX_NN_THEME_REVISION_JSON__", JSON.stringify(`${theme.id}-${Date.now()}`));
  document.defaultView?.eval(payload);
  setStatus(`${theme.id} · ${activeSize.width} × ${activeSize.height}`, "ready");
  renderNavigationOverlay();
}

async function loadManifest(): Promise<void> {
  const response = await fetch(`${fixtureBase}manifest.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("尚未生成 Codex fixture");
  manifest = await response.json() as FixtureManifest;
  if (!manifest.states.length) throw new Error("fixture 没有可预览页面");
  routes.replaceChildren(...manifest.states.map((state) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = state.label;
    button.dataset.route = state.name;
    button.addEventListener("click", () => switchState(state, "push"));
    return button;
  }));
  switchState(manifest.states.find((state) => state.name === defaultRoute) ?? manifest.states[0], "replace");
}

function syncLocation(state: FixtureState, mode: HistoryMode): void {
  if (mode === "none") return;
  const url = new URL(window.location.href);
  url.searchParams.set("route", state.name);
  url.searchParams.set("theme", themeSelect.value || defaultTheme);
  const historyState = { route: state.name, theme: themeSelect.value || defaultTheme };
  if (mode === "push") window.history.pushState(historyState, "", url);
  else window.history.replaceState(historyState, "", url);
}

function switchState(state: FixtureState, historyMode: HistoryMode = "push"): void {
  activeState = state;
  syncLocation(state, historyMode);
  const captured = manifest
    ? new Date(manifest.capturedAt).toLocaleString("zh-CN", { hour12: false })
    : "";
  meta.textContent = `${manifest?.browser ?? "Codex"} · ${state.label} · ${captured}`;
  routes.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.route === state.name);
  });
  loading.hidden = false;
  loading.textContent = `正在还原${state.label}…`;
  frame.classList.remove("is-ready");
  navigationOverlay.replaceChildren();
  resizePreview(activeSize);
  frame.src = `${fixtureBase}${state.name}/index.html?t=${Date.now()}`;
}

function installFixtureNavigation(): void {
  const view = frame.contentWindow;
  if (!view) return;
  const script = `(() => {
    if (window.__CODEX_FIXTURE_NAVIGATION__) return;
    const routes = ${JSON.stringify(fixtureRouteLabels)};
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target?.closest) return;
      const navTarget = target.closest("aside button, aside [role='button']");
      if (!navTarget) return;
      const taskRow = target.closest("[role='button'].cursor-interaction");
      const taskList = taskRow?.closest("[role='list']");
      const taskListLabel = taskList?.getAttribute("aria-label")?.trim();
      const label = (navTarget.getAttribute("aria-label") || navTarget.textContent || "")
        .replace(/\\s+/g, " ")
        .trim();
      const route = taskListLabel === "任务" || taskListLabel === "Tasks"
        ? "thread"
        : routes[label];
      if (!route) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.parent.postMessage({ type: "codex-fixture:navigate", route }, window.location.origin);
    }, true);
    window.__CODEX_FIXTURE_NAVIGATION__ = true;
  })()`;
  (view as Window & { eval(source: string): unknown }).eval(script);
}

function renderNavigationOverlay(): void {
  const document = frame.contentDocument;
  if (!document || !manifest) return;
  const targets: Array<{ element: Element; route: string; label: string }> = [];
  for (const element of document.querySelectorAll("aside button")) {
    const label = (element.getAttribute("aria-label") || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const route = fixtureRouteLabels[label];
    if (route) targets.push({ element, route, label });
  }
  for (const list of document.querySelectorAll('[role="list"]')) {
    const label = list.getAttribute("aria-label")?.trim();
    if (label !== "任务" && label !== "Tasks") continue;
    for (const element of list.querySelectorAll('[role="button"].cursor-interaction')) {
      targets.push({
        element,
        route: "thread",
        label: (element.textContent || "任务").replace(/\s+/g, " ").trim(),
      });
    }
  }
  navigationOverlay.replaceChildren(...targets.map((target) => {
    const state = manifest?.states.find((item) => item.name === target.route);
    const rect = target.element.getBoundingClientRect();
    const button = window.document.createElement("button");
    button.type = "button";
    button.className = "fixture-navigation-target";
    button.dataset.route = target.route;
    button.setAttribute("aria-label", `模拟跳转：${state?.label || target.label}`);
    button.title = `模拟跳转：${state?.label || target.label}`;
    button.style.left = `${rect.left * activeScale}px`;
    button.style.top = `${rect.top * activeScale}px`;
    button.style.width = `${rect.width * activeScale}px`;
    button.style.height = `${rect.height * activeScale}px`;
    button.addEventListener("click", () => {
      if (state) switchState(state, "push");
    });
    return button;
  }));
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== frame.contentWindow || !manifest) return;
  if (event.data?.type !== "codex-fixture:navigate" || typeof event.data.route !== "string") return;
  const state = manifest.states.find((item) => item.name === event.data.route);
  if (state) switchState(state, "push");
});

frame.addEventListener("load", () => {
  installFixtureNavigation();
  void applyTheme()
    .then(() => {
      loading.hidden = true;
      frame.classList.add("is-ready");
      renderNavigationOverlay();
    })
    .catch((error: unknown) => {
      loading.textContent = error instanceof Error ? error.message : String(error);
      setStatus("页面还原失败", "error");
    });
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-size]")) {
  button.addEventListener("click", () => {
    const size = availableSizes()[button.dataset.size ?? ""];
    if (!size) return;
    document.querySelectorAll("[data-size]").forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    resizePreview(size);
    void applyTheme();
  });
}

document.querySelector<HTMLButtonElement>("#refresh-theme")?.addEventListener("click", () => {
  void applyTheme().catch((error: unknown) => {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  });
});

fullscreenToggle.addEventListener("click", () => {
  setFullscreen(!app.classList.contains("is-fullscreen"));
});

themeSelect.addEventListener("change", () => {
  if (activeState) syncLocation(activeState, "replace");
  void applyTheme().catch((error: unknown) => {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  });
});

window.addEventListener("resize", () => resizePreview(activeSize));
window.addEventListener("popstate", () => {
  if (!manifest) return;
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme");
  if (theme && [...themeSelect.options].some((option) => option.value === theme)) {
    themeSelect.value = theme;
  }
  const route = params.get("route") || "home";
  const state = manifest.states.find((item) => item.name === route);
  if (state && state.name !== activeState?.name) switchState(state, "none");
  else void applyTheme();
});

void loadManifest().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  meta.textContent = message;
  loading.textContent = `${message}，请先运行 npm run theme:fixture`;
  setStatus("缺少 fixture", "error");
});

setFullscreen(true);

if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", () => {
    window.setTimeout(() => void applyTheme(), 80);
  });
}
