((cssText, artDataUrl, themeConfig) => {
  const STATE_KEY = "__CODEX_NN_THEME_STATE__";
  const DISABLED_KEY = "__CODEX_NN_THEME_DISABLED__";
  const STYLE_ID = "codex-nn-theme-style";
  const CHROME_ID = "codex-nn-theme-chrome";
  const SHELL_ATTR = "data-nn-theme-shell";
  const LAYOUT_ATTR = "data-nn-theme-layout";
  const PAGE_ATTR = "data-nn-theme-page";
  const ART_ATTRS = [
    "data-nn-art-wide", "data-nn-art-safe-area", "data-nn-task-mode",
    "data-nn-art-aspect", "data-nn-art-ready",
  ];
  const VERSION = __CODEX_NN_THEME_VERSION_JSON__;
  const REVISION = __CODEX_NN_THEME_REVISION_JSON__;
  const THEME = themeConfig && typeof themeConfig === "object" ? themeConfig : {};
  const ART = THEME.art && typeof THEME.art === "object" ? THEME.art : {};
  const ART_METADATA = THEME.artMetadata && typeof THEME.artMetadata === "object"
    ? THEME.artMetadata : null;
  const LAYOUT = ({
    dreamSkin: "dream-skin",
    strawberryStarlight: "strawberry-starlight",
    azureNeon: "azure-neon",
  })[THEME.layoutPreset] || "standard";
  const THEME_VARIABLES = [
    "--ds-bg", "--ds-panel", "--ds-panel-2", "--ds-green", "--ds-lime",
    "--ds-cyan", "--ds-purple", "--ds-text", "--ds-muted", "--ds-line",
    "--ds-bg-rgb", "--ds-panel-rgb", "--ds-panel-2-rgb", "--ds-accent-rgb",
    "--ds-secondary-rgb", "--ds-highlight-rgb", "--ds-text-rgb", "--ds-muted-rgb",
    "--nn-theme-name", "--nn-theme-tagline", "--nn-theme-project-prefix",
    "--nn-theme-project-label", "--nn-art-focus-x", "--nn-art-focus-y",
    "--nn-art-position",
  ];
  const ANALYSIS_CACHE_KEY = "__CODEX_NN_THEME_ANALYSIS_CACHE__";
  const analysisCache = window[ANALYSIS_CACHE_KEY] instanceof Map
    ? window[ANALYSIS_CACHE_KEY] : new Map();
  window[ANALYSIS_CACHE_KEY] = analysisCache;
  let artAnalysis = typeof THEME.artKey === "string"
    ? analysisCache.get(THEME.artKey) ?? null : null;
  let analysisTimer = null;
  const installToken = {};
  const artUrl = (() => {
    const comma = artDataUrl.indexOf(",");
    if (comma < 0) throw new Error("Invalid theme art data URL");
    const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
    const binary = atob(artDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  })();

  const previous = window[STATE_KEY];
  try { previous?.cleanup?.(); } catch {}
  if (window[STATE_KEY] === previous) {
    if (previous?.observer) previous.observer.disconnect();
    if (previous?.timer) clearInterval(previous.timer);
    if (previous?.scheduler?.timeout) clearTimeout(previous.scheduler.timeout);
    if (previous?.scheduler?.frame) cancelAnimationFrame(previous.scheduler.frame);
    if (previous?.analysisTimer) clearTimeout(previous.analysisTimer);
    if (previous?.resizeHandler) window.removeEventListener("resize", previous.resizeHandler);
    if (previous?.mediaHandler && previous?.mediaQuery) {
      try { previous.mediaQuery.removeEventListener("change", previous.mediaHandler); } catch {}
    }
    if (previous?.artUrl) URL.revokeObjectURL(previous.artUrl);
  }
  window[DISABLED_KEY] = false;

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

  const sharedAncestor = (first, second, boundary) => {
    if (!first || !second) return null;
    let candidate = first;
    while (candidate && candidate !== boundary) {
      if (candidate.contains(second)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  };

  const parseRgb = (value) => {
    if (!value || value === "transparent") return null;
    const hex = String(value).trim().match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const number = Number.parseInt(hex[1], 16);
      return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 };
    }
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

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const rgbString = (value) => {
    const rgb = parseRgb(value);
    return rgb ? `${Math.round(rgb.r)} ${Math.round(rgb.g)} ${Math.round(rgb.b)}` : null;
  };
  const rgbToHex = ({ r, g, b }) => `#${[r, g, b]
    .map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
  const rgbToHsl = ({ r, g, b }) => {
    const values = [r, g, b].map((value) => value / 255);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: lightness };
    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue;
    if (max === values[0]) hue = (values[1] - values[2]) / delta + (values[1] < values[2] ? 6 : 0);
    else if (max === values[1]) hue = (values[2] - values[0]) / delta + 2;
    else hue = (values[0] - values[1]) / delta + 4;
    return { h: hue * 60, s: saturation, l: lightness };
  };
  const hslToRgb = ({ h, s, l }) => {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s === 0) {
      const neutral = Math.round(l * 255);
      return { r: neutral, g: neutral, b: neutral };
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (offset) => {
      let value = hue + offset;
      if (value < 0) value += 1;
      if (value > 1) value -= 1;
      if (value < 1 / 6) return p + (q - p) * 6 * value;
      if (value < 1 / 2) return q;
      if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
      return p;
    };
    return { r: channel(1 / 3) * 255, g: channel(0) * 255, b: channel(-1 / 3) * 255 };
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
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {}
    return "light";
  };

  const makeAdaptivePalette = (sample, shell) => {
    const source = sample || { r: 108, g: 126, b: 136 };
    const hsl = rgbToHsl(source);
    const hue = hsl.s < 0.12 ? 214 : hsl.h;
    const saturation = clamp(hsl.s, 0.38, 0.72);
    const accent = hslToRgb({ h: hue, s: saturation, l: shell === "light" ? 0.42 : 0.66 });
    const accentAlt = hslToRgb({ h: hue + 12, s: saturation * 0.82, l: shell === "light" ? 0.52 : 0.73 });
    const secondary = hslToRgb({ h: hue - 24, s: saturation * 0.64, l: shell === "light" ? 0.56 : 0.62 });
    const highlight = hslToRgb({ h: hue + 24, s: saturation * 0.76, l: shell === "light" ? 0.36 : 0.58 });
    const neutral = (lightness, chroma = 0.08) => rgbToHex(hslToRgb({ h: hue, s: chroma, l: lightness }));
    return shell === "light" ? {
      background: neutral(0.965, 0.07),
      panel: neutral(0.987, 0.035),
      panelAlt: neutral(0.945, 0.09),
      accent: rgbToHex(accent),
      accentAlt: rgbToHex(accentAlt),
      secondary: rgbToHex(secondary),
      highlight: rgbToHex(highlight),
      text: neutral(0.13, 0.10),
      muted: neutral(0.42, 0.08),
      line: `rgba(${Math.round(accent.r)}, ${Math.round(accent.g)}, ${Math.round(accent.b)}, .24)`,
    } : {
      background: neutral(0.055, 0.045),
      panel: neutral(0.085, 0.04),
      panelAlt: neutral(0.125, 0.05),
      accent: rgbToHex(accent),
      accentAlt: rgbToHex(accentAlt),
      secondary: rgbToHex(secondary),
      highlight: rgbToHex(highlight),
      text: neutral(0.93, 0.025),
      muted: neutral(0.69, 0.03),
      line: `rgba(${Math.round(accent.r)}, ${Math.round(accent.g)}, ${Math.round(accent.b)}, .28)`,
    };
  };

  const resolvedShell = () => {
    if (THEME.appearance === "light" || THEME.appearance === "dark") return THEME.appearance;
    return detectShellMode();
  };

  const applyTheme = (root, shell) => {
    const colors = THEME.colors || {};
    const adaptive = makeAdaptivePalette(artAnalysis?.accentRgb, shell);
    const pick = (name) => typeof colors[name] === "string" ? colors[name] : adaptive[name];
    const accent = pick("accent");
    const variables = {
      "--ds-bg": pick("background"),
      "--ds-panel": pick("panel"),
      "--ds-panel-2": pick("panelAlt"),
      "--ds-green": accent,
      "--ds-lime": typeof colors.accentAlt === "string"
        ? colors.accentAlt : (typeof colors.accent === "string" ? accent : adaptive.accentAlt),
      "--ds-cyan": pick("secondary"),
      "--ds-purple": pick("highlight"),
      "--ds-text": pick("text"),
      "--ds-muted": pick("muted"),
      "--ds-line": pick("line"),
    };

    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === "string" && value) setProperty(root, name, value);
    }
    for (const [name, value] of Object.entries({
      "--ds-bg-rgb": variables["--ds-bg"],
      "--ds-panel-rgb": variables["--ds-panel"],
      "--ds-panel-2-rgb": variables["--ds-panel-2"],
      "--ds-accent-rgb": variables["--ds-green"],
      "--ds-secondary-rgb": variables["--ds-cyan"],
      "--ds-highlight-rgb": variables["--ds-purple"],
      "--ds-text-rgb": variables["--ds-text"],
      "--ds-muted-rgb": variables["--ds-muted"],
    })) {
      const rgb = rgbString(value);
      if (rgb) setProperty(root, name, rgb);
    }
    setProperty(root, "--nn-theme-name", cssString(THEME.name || "Codex 暖暖"));
    setProperty(root, "--nn-theme-tagline", cssString(THEME.tagline || "Make something wonderful."));
    setProperty(root, "--nn-theme-project-prefix", cssString(THEME.projectPrefix || "选择项目 · "));
    setProperty(root, "--nn-theme-project-label", cssString(THEME.projectLabel || "◉  选择项目"));
  };

  const applyArtMetadata = (root) => {
    const profile = artAnalysis || ART_METADATA;
    const inferredSafe = profile?.safeArea || "center";
    const requestedSafe = ART.safeArea && ART.safeArea !== "auto" ? ART.safeArea : inferredSafe;
    const safeArea = ["left", "right", "center", "none"].includes(requestedSafe)
      ? requestedSafe : "center";
    const focusX = typeof ART.focusX === "number" ? ART.focusX
      : profile?.focusX ?? (safeArea === "left" ? 0.72 : safeArea === "right" ? 0.28 : 0.5);
    const focusY = typeof ART.focusY === "number" ? ART.focusY : profile?.focusY ?? 0.5;
    const declaresTaskMode = Object.prototype.hasOwnProperty.call(ART, "taskMode");
    const requestedMode = !declaresTaskMode
      ? "off"
      : ART.taskMode === "auto"
        ? profile?.taskMode || "ambient"
        : ART.taskMode;
    const taskMode = ["ambient", "banner", "off"].includes(requestedMode)
      ? requestedMode : "ambient";
    const focusXValue = `${(clamp(focusX, 0, 1) * 100).toFixed(2)}%`;
    const focusYValue = `${(clamp(focusY, 0, 1) * 100).toFixed(2)}%`;

    setAttribute(root, "data-nn-art-wide", profile?.wide ? "true" : "false");
    setAttribute(root, "data-nn-art-safe-area", safeArea);
    setAttribute(root, "data-nn-task-mode", taskMode);
    setAttribute(root, "data-nn-art-aspect", profile?.aspect || "unknown");
    setAttribute(root, "data-nn-art-ready", artAnalysis ? "true" : "false");
    setProperty(root, "--nn-art-focus-x", focusXValue);
    setProperty(root, "--nn-art-focus-y", focusYValue);
    setProperty(root, "--nn-art-position", `${focusXValue} ${focusYValue}`);
  };

  const analyzeArt = () => new Promise((resolve) => {
    if (typeof window.Image !== "function" || !document?.createElement) {
      resolve(null);
      return;
    }
    const image = new window.Image();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (analysisTimer) clearTimeout(analysisTimer);
      analysisTimer = null;
      resolve(value);
    };
    analysisTimer = setTimeout(() => finish(null), 6000);
    image.onerror = () => finish(null);
    image.onload = () => {
      try {
        const ratio = image.naturalWidth / image.naturalHeight;
        if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("图片尺寸无效");
        const maxDimension = 96;
        const width = Math.max(16, Math.round(ratio >= 1 ? maxDimension : maxDimension * ratio));
        const height = Math.max(16, Math.round(ratio >= 1 ? maxDimension / ratio : maxDimension));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext?.("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas 不可用");
        context.drawImage(image, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        const samples = new Array(width * height);
        const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
        let lightTotal = 0;
        let count = 0;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            if (data[offset + 3] < 32) continue;
            const rgb = { r: data[offset], g: data[offset + 1], b: data[offset + 2] };
            const light = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
            const hsl = rgbToHsl(rgb);
            samples[y * width + x] = { light, saturation: hsl.s };
            lightTotal += light;
            count += 1;
            if (hsl.s >= 0.16 && hsl.l >= 0.16 && hsl.l <= 0.86) {
              const bin = bins[Math.min(23, Math.floor(hsl.h / 15))];
              const weight = hsl.s * (1 - Math.abs(hsl.l - 0.52) * 0.85);
              bin.weight += weight;
              bin.r += rgb.r * weight;
              bin.g += rgb.g * weight;
              bin.b += rgb.b * weight;
            }
          }
        }
        if (!count) throw new Error("图片没有可见像素");
        const brightness = lightTotal / count;
        const information = (start, end) => {
          let total = 0;
          let totalSquared = 0;
          let edges = 0;
          let edgeCount = 0;
          let pixels = 0;
          for (let y = 0; y < height; y += 1) {
            for (let x = start; x < end; x += 1) {
              const sample = samples[y * width + x];
              if (!sample) continue;
              total += sample.light;
              totalSquared += sample.light * sample.light;
              pixels += 1;
              const previous = x > start ? samples[y * width + x - 1] : null;
              const above = y > 0 ? samples[(y - 1) * width + x] : null;
              if (previous) { edges += Math.abs(sample.light - previous.light); edgeCount += 1; }
              if (above) { edges += Math.abs(sample.light - above.light); edgeCount += 1; }
            }
          }
          const mean = pixels ? total / pixels : 0;
          const variance = pixels ? Math.max(0, totalSquared / pixels - mean * mean) : 1;
          return Math.sqrt(variance) * 0.58 + (edgeCount ? edges / edgeCount : 1) * 0.42;
        };
        const zoneWidth = Math.max(1, Math.floor(width * 0.38));
        const leftInformation = information(0, zoneWidth);
        const rightInformation = information(width - zoneWidth, width);
        let safeArea = "center";
        if (leftInformation < rightInformation * 0.86) safeArea = "left";
        else if (rightInformation < leftInformation * 0.86) safeArea = "right";

        let saliencyTotal = 0;
        let saliencyX = 0;
        let saliencyY = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const sample = samples[y * width + x];
            if (!sample) continue;
            const previous = x > 0 ? samples[y * width + x - 1] : null;
            const above = y > 0 ? samples[(y - 1) * width + x] : null;
            const edge = (previous ? Math.abs(sample.light - previous.light) : 0)
              + (above ? Math.abs(sample.light - above.light) : 0);
            const weight = 0.01 + Math.abs(sample.light - brightness) * 0.48
              + sample.saturation * 0.34 + edge * 0.28;
            saliencyTotal += weight;
            saliencyX += (x + 0.5) / width * weight;
            saliencyY += (y + 0.5) / height * weight;
          }
        }
        let focusX = saliencyTotal ? saliencyX / saliencyTotal : 0.5;
        let focusY = saliencyTotal ? saliencyY / saliencyTotal : 0.5;
        if (safeArea === "left") focusX = Math.max(0.64, focusX);
        if (safeArea === "right") focusX = Math.min(0.36, focusX);
        focusX = clamp(focusX, 0.12, 0.88);
        focusY = clamp(focusY, 0.18, 0.82);
        const accentBin = bins.reduce((best, candidate) =>
          candidate.weight > best.weight ? candidate : best, bins[0]);
        const accentRgb = accentBin.weight > 0 ? {
          r: accentBin.r / accentBin.weight,
          g: accentBin.g / accentBin.weight,
          b: accentBin.b / accentBin.weight,
        } : null;
        const aspect = ratio >= 2.25 ? "ultrawide" : ratio >= 1.45 ? "wide"
          : ratio >= 1.08 ? "landscape" : ratio >= 0.9 ? "square" : "portrait";
        finish({
          width: image.naturalWidth,
          height: image.naturalHeight,
          ratio,
          wide: ratio >= 1.75,
          aspect,
          brightness,
          safeArea,
          focusX,
          focusY,
          taskMode: ratio >= 2.25 ? "banner" : "ambient",
          accentRgb,
        });
      } catch {
        finish(null);
      }
    };
    image.src = artUrl;
  });

  const existingStyle = document.getElementById(STYLE_ID);
  if (existingStyle) {
    existingStyle.textContent = cssText;
    existingStyle.dataset.nnThemeVersion = VERSION;
  }

  const ensure = () => {
    if (window[DISABLED_KEY]) return;
    const root = document.documentElement;
    if (!root) return;
    const shell = resolvedShell();
    root.classList.add("codex-nn-theme");
    setAttribute(root, SHELL_ATTR, shell);
    setAttribute(root, LAYOUT_ATTR, LAYOUT);
    setProperty(root, "--nn-theme-art", `url("${artUrl}")`);
    applyTheme(root, shell);
    applyArtMetadata(root);

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
    if (!shellMain || !document.body) return;
    const homeIndicator = shellMain.querySelector('[data-testid="home-icon"]');
    const gameSource = shellMain.querySelector('[data-feature="game-source"]');
    const composer = shellMain.querySelector(".composer-surface-chrome");
    const thread = shellMain.querySelector(".thread-scroll-container");
    const isHome = Boolean(gameSource && !thread);
    const home = isHome
      ? homeIndicator?.closest('[role="main"]') || gameSource?.closest('[role="main"]') ||
        sharedAncestor(gameSource, composer, shellMain)
      : null;
    for (const candidate of document.querySelectorAll(".nn-theme-home")) {
      if (LAYOUT === "dream-skin" || candidate !== home) {
        candidate.classList.remove("nn-theme-home");
      }
    }
    if (LAYOUT !== "dream-skin" && home) home.classList.add("nn-theme-home");

    const composedHome = Boolean(home && LAYOUT !== "dream-skin");
    setAttribute(root, PAGE_ATTR, isHome ? "home" : "thread");
    shellMain.classList.toggle("nn-theme-home-shell", composedHome);
    let chrome = document.getElementById(CHROME_ID);
    if (LAYOUT === "dream-skin") {
      chrome?.remove();
      return;
    }
    if (!chrome || chrome.parentElement !== document.body || !chrome.querySelector(".nn-theme-brand")) {
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
        <div class="nn-theme-orbit"></div>`;
      document.body.appendChild(chrome);
    }
    setText(chrome.querySelector(".nn-theme-brand b"), THEME.name || "Codex 暖暖");
    setText(chrome.querySelector(".nn-theme-brand small"), THEME.brandSubtitle || "CODEX NN");
    setText(chrome.querySelector(".nn-theme-portal-mark"), LAYOUT === "strawberry-starlight" ? "♡" : "◈");
    setText(chrome.querySelector(".nn-theme-status span"), THEME.statusText || "CODEX NN ONLINE");
    setText(chrome.querySelector(".nn-theme-quote"), THEME.quote || "MAKE SOMETHING WONDERFUL");
    const shellBox = shellMain.getBoundingClientRect();
    setProperty(chrome, "left", `${Math.round(shellBox.left)}px`);
    setProperty(chrome, "top", `${Math.round(shellBox.top)}px`);
    setProperty(chrome, "width", `${Math.round(shellBox.width)}px`);
    setProperty(chrome, "height", `${Math.round(shellBox.height)}px`);
    chrome.classList.toggle("nn-theme-home-shell", composedHome);
    setAttribute(chrome, "data-nn-theme-shell", shell);
  };

  const cleanup = () => {
    const state = window[STATE_KEY];
    if (state?.installToken !== installToken) return false;
    window[DISABLED_KEY] = true;
    document.documentElement?.classList.remove("codex-nn-theme");
    document.documentElement?.removeAttribute(SHELL_ATTR);
    document.documentElement?.removeAttribute(LAYOUT_ATTR);
    document.documentElement?.removeAttribute(PAGE_ATTR);
    for (const name of ART_ATTRS) document.documentElement?.removeAttribute(name);
    document.documentElement?.style.removeProperty("--nn-theme-art");
    for (const name of THEME_VARIABLES) document.documentElement?.style.removeProperty(name);
    document.querySelectorAll(".nn-theme-home").forEach((node) => node.classList.remove("nn-theme-home"));
    document.querySelectorAll(".nn-theme-home-shell").forEach((node) => node.classList.remove("nn-theme-home-shell"));
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(CHROME_ID)?.remove();
    state?.observer?.disconnect();
    if (state?.timer) clearInterval(state.timer);
    if (state?.scheduler?.timeout) clearTimeout(state.scheduler.timeout);
    if (state?.scheduler?.frame) cancelAnimationFrame(state.scheduler.frame);
    if (state?.analysisTimer) clearTimeout(state.analysisTimer);
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
    analysis: artAnalysis,
    analysisTimer,
    artMetadata: ART_METADATA,
    installToken,
    version: VERSION,
    themeId: THEME.id || "custom",
    revision: REVISION,
    layout: LAYOUT,
    detectShellMode,
  };
  ensure();
  if (!artAnalysis) {
    analyzeArt().then((analysis) => {
      const state = window[STATE_KEY];
      if (!analysis || state?.installToken !== installToken || window[DISABLED_KEY]) return;
      artAnalysis = analysis;
      state.analysis = analysis;
      state.analysisTimer = null;
      if (typeof THEME.artKey === "string") {
        analysisCache.set(THEME.artKey, analysis);
        while (analysisCache.size > 8) analysisCache.delete(analysisCache.keys().next().value);
      }
      ensure();
    }).catch(() => {});
    window[STATE_KEY].analysisTimer = analysisTimer;
  }
  return {
    installed: true,
    version: VERSION,
    themeId: THEME.id || "custom",
    revision: REVISION,
    shell: resolvedShell(),
    layout: LAYOUT,
  };
})(__CODEX_NN_THEME_CSS_JSON__, __CODEX_NN_THEME_ART_JSON__, __CODEX_NN_THEME_CONFIG_JSON__)
