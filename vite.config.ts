import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const fixtureRoot = resolve("../codex-fixture/current");
const themeSourceRoot = resolve("src-tauri/resources/theme-engine");
const dreamSkinSourceRoot = resolve("../Codex-Dream-Skin/macos/assets");
const dreamSkinThemeRoot = resolve("../Codex-Dream-Skin/macos/presets/preset-gothic-void-crusade");
const fixtureMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

export default defineConfig({
  clearScreen: false,
  plugins: [{
    name: "codex-fixture",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const fixturePrefix = "/__codex_fixture__/";
        const sourcePrefix = "/__theme_source__/";
        const dreamSkinSourcePrefix = "/__dream_skin_upstream__/";
        const dreamSkinThemePrefix = "/__dream_skin_theme__/";
        let root: string;
        let relative: string;
        if (url.pathname.startsWith(fixturePrefix)) {
          root = fixtureRoot;
          relative = decodeURIComponent(url.pathname.slice(fixturePrefix.length)) || "index.html";
        } else if (url.pathname.startsWith(sourcePrefix)) {
          root = themeSourceRoot;
          relative = decodeURIComponent(url.pathname.slice(sourcePrefix.length));
        } else if (url.pathname.startsWith(dreamSkinSourcePrefix)) {
          root = dreamSkinSourceRoot;
          relative = decodeURIComponent(url.pathname.slice(dreamSkinSourcePrefix.length));
        } else if (url.pathname.startsWith(dreamSkinThemePrefix)) {
          root = dreamSkinThemeRoot;
          relative = decodeURIComponent(url.pathname.slice(dreamSkinThemePrefix.length));
        } else {
          return next();
        }
        const file = resolve(root, relative);
        if (file !== root && !file.startsWith(`${root}${sep}`)) {
          response.statusCode = 403;
          response.end("Forbidden");
          return;
        }
        try {
          const content = await readFile(file);
          response.setHeader("Content-Type", fixtureMimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream");
          response.setHeader("Cache-Control", "no-store");
          response.end(content);
        } catch {
          response.statusCode = 404;
          response.end("Fixture not found");
        }
      });
    }
  }],
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true
  }
});
