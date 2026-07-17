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

type HistoryMode = "push" | "replace" | "none";

const fixtureBase = "/__codex_fixture__/";
const themeCssUrl = "/__theme_source__/nn-theme.css";
const rendererUrl = "/__theme_source__/renderer-inject.js";
const query = new URLSearchParams(window.location.search);
const defaultTheme = query.get("theme") || "miku-future-collab";
const defaultRoute = query.get("route") || "home";
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
        <option value="adventure-atlas">云海远行图鉴</option>
        <option value="miku-future-collab">初音未来</option>
        <option value="strawberry-starlight">星莓绮梦</option>
        <option value="azure-neon-frontier">苍蓝矩阵</option>
      </select>
      <button type="button" data-size="capture">抓取尺寸</button>
      <button type="button" data-size="desktop">1440 × 900</button>
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
if ([...themeSelect.options].some((option) => option.value === defaultTheme)) {
  themeSelect.value = defaultTheme;
}

let manifest: FixtureManifest | null = null;
let activeState: FixtureState | null = null;
let activeSize: PreviewSize = { label: "桌面", width: 1440, height: 900 };
let activeScale = 1;

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
  const availableWidth = Math.max(stage.clientWidth - 48, 320);
  const availableHeight = Math.max(stage.clientHeight - 48, 240);
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

async function applyTheme(): Promise<void> {
  const document = frame.contentDocument;
  if (!document?.documentElement) return;
  const themeId = themeSelect.value || defaultTheme;
  const base = `/theme-packs/${themeId}/`;
  const [cssResponse, rendererResponse, themeResponse] = await Promise.all([
    fetch(`${themeCssUrl}?t=${Date.now()}`, { cache: "no-store" }),
    fetch(`${rendererUrl}?t=${Date.now()}`, { cache: "no-store" }),
    fetch(`${base}theme.json?t=${Date.now()}`, { cache: "no-store" }),
  ]);
  if (!cssResponse.ok || !rendererResponse.ok || !themeResponse.ok) {
    throw new Error("读取本地主题引擎失败");
  }
  const [css, renderer, theme] = await Promise.all([
    cssResponse.text(),
    rendererResponse.text(),
    themeResponse.json() as Promise<{ id: string; image: string }>,
  ]);
  const artResponse = await fetch(`${base}${theme.image}?t=${Date.now()}`, { cache: "no-store" });
  if (!artResponse.ok) throw new Error("读取主题背景失败");
  const artDataUrl = await blobToDataUrl(await artResponse.blob());
  const payload = renderer
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
  resizePreview(availableSizes().capture);
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

if (import.meta.hot) {
  import.meta.hot.on("vite:afterUpdate", () => {
    window.setTimeout(() => void applyTheme(), 80);
  });
}
