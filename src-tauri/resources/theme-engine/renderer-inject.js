((cssText, artDataUrl, themeConfig) => {
  const STATE_KEY = "__CODEX_NN_THEME_STATE__";
  const DISABLED_KEY = "__CODEX_NN_THEME_DISABLED__";
  const STYLE_ID = "codex-nn-theme-style";
  const CHROME_ID = "codex-nn-theme-chrome";
  const SHELL_ATTR = "data-nn-theme-shell";
  const LAYOUT_ATTR = "data-nn-theme-layout";
  const VERSION = __CODEX_NN_THEME_VERSION_JSON__;
  const THEME = themeConfig && typeof themeConfig === "object" ? themeConfig : {};
  const LAYOUT = ({
    dreamSkin: "dream-skin",
    strawberryStarlight: "strawberry-starlight",
    azureNeon: "azure-neon",
  })[THEME.layoutPreset] || "standard";
  const THEME_VARIABLES = [
    "--ds-bg", "--ds-panel", "--ds-panel-2", "--ds-green", "--ds-lime",
    "--ds-cyan", "--ds-purple", "--ds-text", "--ds-muted", "--ds-line",
    "--nn-theme-name", "--nn-theme-tagline", "--nn-theme-project-prefix",
    "--nn-theme-project-label",
  ];
  window[DISABLED_KEY] = false;

  const previous = window[STATE_KEY];
  if (previous?.observer) previous.observer.disconnect();
  if (previous?.timer) clearInterval(previous.timer);
  if (previous?.scheduler?.timeout) clearTimeout(previous.scheduler.timeout);
  if (previous?.scheduler?.frame) cancelAnimationFrame(previous.scheduler.frame);
  if (previous?.resizeHandler) window.removeEventListener("resize", previous.resizeHandler);
  if (previous?.mediaHandler && previous?.mediaQuery) {
    try { previous.mediaQuery.removeEventListener("change", previous.mediaHandler); } catch {}
  }
  if (previous?.artUrl) URL.revokeObjectURL(previous.artUrl);

  const artUrl = (() => {
    const comma = artDataUrl.indexOf(",");
    const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
    const binary = atob(artDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  })();

  const cssString = (value) => JSON.stringify(String(value ?? ""));

  const setAttribute = (node, name, value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };

  const setProperty = (node, name, value) => {
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  };

  const setText = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };

  const parseRgb = (value) => {
    if (!value || value === "transparent") return null;
    const m = String(value).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
  };

  const luminance = ({ r, g, b }) => {
    const lin = [r, g, b].map((c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };

  /** Detect Codex app light/dark shell for CSS branching. */
  const detectShellMode = () => {
    const root = document.documentElement;
    const body = document.body;
    const cls = `${root.className || ""} ${body?.className || ""}`.toLowerCase();

    if (/\b(dark|theme-dark|appearance-dark)\b/.test(cls)) return "dark";
    if (/\b(light|theme-light|appearance-light)\b/.test(cls)) return "light";

    const dataTheme = (
      root.getAttribute("data-theme") ||
      root.getAttribute("data-appearance") ||
      root.getAttribute("data-color-mode") ||
      body?.getAttribute("data-theme") ||
      body?.getAttribute("data-appearance") ||
      ""
    ).toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";

    // Radios in profile menu (if present in DOM)
    const checked = document.querySelector('input[name="appearance-theme"]:checked');
    if (checked) {
      const label = (checked.getAttribute("aria-label") || checked.value || "").toLowerCase();
      if (label.includes("暗") || label.includes("dark")) return "dark";
      if (label.includes("浅") || label.includes("light")) return "light";
      if (label.includes("系统") || label.includes("system")) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      }
    }

    try {
      const cs = getComputedStyle(root).colorScheme || "";
      if (cs.includes("dark") && !cs.includes("light")) return "dark";
      if (cs.includes("light") && !cs.includes("dark")) return "light";
    } catch {}

    // Background luminance of main surfaces
    const samples = [
      body,
      document.querySelector("main.main-surface"),
      document.querySelector("aside.app-shell-left-panel"),
    ].filter(Boolean);
    let votesLight = 0;
    let votesDark = 0;
    for (const el of samples) {
      try {
        const rgb = parseRgb(getComputedStyle(el).backgroundColor);
        if (!rgb) continue;
        const L = luminance(rgb);
        if (L >= 0.55) votesLight += 1;
        else if (L <= 0.25) votesDark += 1;
      } catch {}
    }
    if (votesLight > votesDark) return "light";
    if (votesDark > votesLight) return "dark";

    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch {}
    return "light";
  };

  const applyTheme = (root, shell) => {
    const colors = THEME.colors || {};
    const accent = colors.accent || (shell === "light" ? "#e25563" : "#7cff46");
    const accentAlt = colors.accentAlt || accent;
    const secondary = colors.secondary || (shell === "light" ? "#f3a8af" : "#36d7e8");
    const highlight = colors.highlight || (shell === "light" ? "#c93d4c" : "#642a8c");

    let variables;
    if (shell === "light") {
      variables = {
        "--ds-bg": colors.background || "#f6f2f3",
        "--ds-panel": colors.panel || "#ffffff",
        "--ds-panel-2": colors.panelAlt || "#fff7f8",
        "--ds-green": accent,
        "--ds-lime": accentAlt,
        "--ds-cyan": secondary,
        "--ds-purple": highlight,
        "--ds-text": colors.text || "#1f1a1b",
        "--ds-muted": colors.muted || "#6b5f62",
        "--ds-line": colors.line || "rgba(196, 120, 128, .22)",
      };
    } else {
      variables = {
        "--ds-bg": colors.background || "#071116",
        "--ds-panel": colors.panel || "#0b1a20",
        "--ds-panel-2": colors.panelAlt || "#10272c",
        "--ds-green": accent,
        "--ds-lime": accentAlt,
        "--ds-cyan": secondary,
        "--ds-purple": highlight,
        "--ds-text": colors.text || "#e9fff1",
        "--ds-muted": colors.muted || "#9ebdb3",
        "--ds-line": colors.line || "rgba(124, 255, 70, .28)",
      };
    }

    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === "string" && value) setProperty(root, name, value);
    }
    setProperty(root, "--nn-theme-name", cssString(THEME.name || "Codex 暖暖"));
    setProperty(root, "--nn-theme-tagline", cssString(THEME.tagline || "Make something wonderful."));
    setProperty(root, "--nn-theme-project-prefix", cssString(THEME.projectPrefix || "选择项目 · "));
    setProperty(root, "--nn-theme-project-label", cssString(THEME.projectLabel || "◉  选择项目"));
  };

  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) {
    existingStyle.textContent = cssText;
    existingStyle.dataset.nnThemeVersion = VERSION;
  }

  const ensure = () => {
    if (window[DISABLED_KEY]) return;
    const root = document.documentElement;
    if (!root) return;
    const shell = LAYOUT === "dream-skin" || LAYOUT === "strawberry-starlight"
      ? "light"
      : LAYOUT === "azure-neon" ? "dark" : detectShellMode();
    root.classList.add("codex-nn-theme");
    setAttribute(root, SHELL_ATTR, shell);
    setAttribute(root, LAYOUT_ATTR, LAYOUT);
    setProperty(root, "--nn-theme-art", `url("${artUrl}")`);
    applyTheme(root, shell);

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || root).appendChild(style);
    }
    if (style.dataset.nnThemeVersion !== VERSION) {
      style.textContent = cssText;
      style.dataset.nnThemeVersion = VERSION;
    }

    const shellMain = document.querySelector("main.main-surface") || document.querySelector("main");
    const homeIndicator = document.querySelector('[data-testid="home-icon"]');
    const home = homeIndicator?.closest('[role="main"]') ||
      [...document.querySelectorAll('[role="main"]')].find((candidate) =>
        candidate.querySelector('[data-feature="game-source"]') &&
        candidate.querySelector('.group\\\\/home-suggestions')) || null;
    for (const candidate of document.querySelectorAll('[role="main"].nn-theme-home')) {
      if (candidate !== home) candidate.classList.remove("nn-theme-home");
    }
    if (home) home.classList.add("nn-theme-home");

    if (!shellMain || !document.body) return;
    shellMain.classList.toggle("nn-theme-home-shell", Boolean(home));
    let chrome = document.getElementById(CHROME_ID);
    if (!chrome || chrome.parentElement !== document.body || !chrome.querySelector(".nn-dream-brand")) {
      chrome?.remove();
      chrome = document.createElement("div");
      chrome.id = CHROME_ID;
      chrome.setAttribute("aria-hidden", "true");
      chrome.innerHTML = `
        <div class="nn-theme-brand">
          <span class="nn-theme-portal-mark">◉</span>
          <span><b></b><small></small></span>
        </div>
        <div class="nn-theme-status"><i></i><span></span></div>
        <div class="nn-theme-quote"></div>
        <div class="nn-theme-particles"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="nn-theme-orbit"></div>
        <div class="nn-dream-brand"><span class="nn-dream-note">♫</span><span><b></b><small></small></span></div>
        <div class="nn-dream-signature"></div>
        <div class="nn-dream-sparkles"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div class="nn-dream-ribbon"><span>♡</span>🎀<span>✦</span></div>
        <div class="nn-dream-polaroid"></div>`;
      document.body.appendChild(chrome);
    }
    setText(chrome.querySelector(".nn-theme-brand b"), THEME.name || "Codex 暖暖");
    setText(chrome.querySelector(".nn-theme-brand small"), THEME.brandSubtitle || "CODEX NN");
    setText(chrome.querySelector(".nn-theme-portal-mark"), LAYOUT === "strawberry-starlight" ? "♡" : "◈");
    setText(chrome.querySelector(".nn-theme-status span"), THEME.statusText || "CODEX NN ONLINE");
    setText(chrome.querySelector(".nn-theme-quote"), THEME.quote || "MAKE SOMETHING WONDERFUL");
    setText(chrome.querySelector(".nn-dream-brand b"), THEME.name || "Codex Dream Skin");
    setText(chrome.querySelector(".nn-dream-brand small"), THEME.brandSubtitle || "Codex App 限定版 ✦");
    setText(chrome.querySelector(".nn-dream-signature"), THEME.quote || "Dream Skin ♡");
    const shellBox = shellMain.getBoundingClientRect();
    setProperty(chrome, "left", `${Math.round(shellBox.left)}px`);
    setProperty(chrome, "top", `${Math.round(shellBox.top)}px`);
    setProperty(chrome, "width", `${Math.round(shellBox.width)}px`);
    setProperty(chrome, "height", `${Math.round(shellBox.height)}px`);
    chrome.classList.toggle("nn-theme-home-shell", Boolean(home));
    setAttribute(chrome, "data-nn-theme-shell", shell);
  };

  const cleanup = () => {
    window[DISABLED_KEY] = true;
    document.documentElement?.classList.remove("codex-nn-theme");
    document.documentElement?.removeAttribute(SHELL_ATTR);
    document.documentElement?.removeAttribute(LAYOUT_ATTR);
    document.documentElement?.style.removeProperty("--nn-theme-art");
    for (const name of THEME_VARIABLES) document.documentElement?.style.removeProperty(name);
    document.querySelectorAll(".nn-theme-home").forEach((node) => node.classList.remove("nn-theme-home"));
    document.querySelectorAll(".nn-theme-home-shell").forEach((node) => node.classList.remove("nn-theme-home-shell"));
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(CHROME_ID)?.remove();
    const state = window[STATE_KEY];
    state?.observer?.disconnect();
    if (state?.timer) clearInterval(state.timer);
    if (state?.scheduler?.timeout) clearTimeout(state.scheduler.timeout);
    if (state?.scheduler?.frame) cancelAnimationFrame(state.scheduler.frame);
    if (state?.resizeHandler) window.removeEventListener("resize", state.resizeHandler);
    if (state?.mediaHandler && state?.mediaQuery) {
      try { state.mediaQuery.removeEventListener("change", state.mediaHandler); } catch {}
    }
    if (state?.artUrl) URL.revokeObjectURL(state.artUrl);
    delete window[STATE_KEY];
    return true;
  };

  const scheduler = { frame: null, timeout: null, lastRun: 0 };
  const runScheduledEnsure = (timestamp = performance.now()) => {
    scheduler.frame = null;
    scheduler.timeout = null;
    const remaining = 100 - (timestamp - scheduler.lastRun);
    if (remaining > 0) {
      scheduler.timeout = setTimeout(runScheduledEnsure, remaining);
      return;
    }
    scheduler.lastRun = performance.now();
    ensure();
  };
  const scheduleEnsure = () => {
    if (scheduler.frame !== null || scheduler.timeout !== null) return;
    scheduler.frame = requestAnimationFrame(runScheduledEnsure);
  };
  const layoutSelector = '[data-testid="home-icon"], [data-feature="game-source"], .thread-scroll-container';
  const touchesLayout = (node) => node?.nodeType === Node.ELEMENT_NODE && (
    node.matches?.(layoutSelector) || node.querySelector?.(layoutSelector)
  );
  const observer = new MutationObserver((records) => {
    const layoutChanged = records.some((record) => record.type === "childList" && (
      [...record.addedNodes].some(touchesLayout) || [...record.removedNodes].some(touchesLayout)
    ));
    if (!layoutChanged) {
      scheduleEnsure();
      return;
    }
    if (scheduler.frame !== null) cancelAnimationFrame(scheduler.frame);
    if (scheduler.timeout !== null) clearTimeout(scheduler.timeout);
    scheduler.frame = null;
    scheduler.timeout = null;
    scheduler.lastRun = performance.now();
    ensure();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-appearance", "data-color-mode", "style"],
  });
  const timer = setInterval(ensure, 4000);
  const resizeHandler = scheduleEnsure;
  window.addEventListener("resize", resizeHandler, { passive: true });

  let mediaQuery = null;
  let mediaHandler = null;
  try {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaHandler = () => scheduleEnsure();
    mediaQuery.addEventListener("change", mediaHandler);
  } catch {}

  window[STATE_KEY] = {
    ensure,
    cleanup,
    observer,
    timer,
    scheduler,
    resizeHandler,
    mediaQuery,
    mediaHandler,
    artUrl,
    version: VERSION,
    themeId: THEME.id || "custom",
    layout: LAYOUT,
    detectShellMode,
  };
  ensure();
  return {
    installed: true,
    version: VERSION,
    themeId: THEME.id || "custom",
    shell: LAYOUT === "dream-skin" || LAYOUT === "strawberry-starlight"
      ? "light"
      : LAYOUT === "azure-neon" ? "dark" : detectShellMode(),
    layout: LAYOUT,
  };
})(__CODEX_NN_THEME_CSS_JSON__, __CODEX_NN_THEME_ART_JSON__, __CODEX_NN_THEME_CONFIG_JSON__)
