#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(ROOT, "plugin", "codex-nn-theme-designer");
const SKILL_ROOT = join(PLUGIN_ROOT, "skills", "design-codex-nn-theme");
const EXPECTED_THEME_IDS = new Set([
  "azure-neon-frontier",
  "miku-future-collab",
  "strawberry-starlight"
]);
const EXPECTED_THEME_APPEARANCE = {
  "azure-neon-frontier": "dark",
  "miku-future-collab": "light",
  "strawberry-starlight": "light"
};

function fail(message) {
  throw new Error(message);
}

function text(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function json(path) {
  const value = JSON.parse(text(path));
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail(`${relative(ROOT, path)} 必须是 JSON 对象`);
  }
  return value;
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function requireExactVersion(value, location) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    fail(`${location} 必须使用精确版本号，当前为 ${JSON.stringify(value)}`);
  }
}

function validateVersionsAndDependencies() {
  const packageJson = json(join(ROOT, "package.json"));
  const tauri = json(join(ROOT, "src-tauri", "tauri.conf.json"));
  const metadata = JSON.parse(execFileSync("cargo", [
    "metadata",
    "--manifest-path", join(ROOT, "src-tauri", "Cargo.toml"),
    "--format-version", "1",
    "--no-deps",
    "--locked"
  ], { cwd: ROOT, encoding: "utf8" }));
  const cargoPackage = metadata.packages.find((item) => item.name === "codex-nn");
  if (!cargoPackage) fail("Cargo metadata 缺少 codex-nn 包");
  const versions = new Set([packageJson.version, tauri.version, cargoPackage.version]);
  if (versions.size !== 1) {
    fail(`package.json、Cargo.toml 与 tauri.conf.json 版本不一致：${[...versions].join(", ")}`);
  }

  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(packageJson[section] ?? {})) {
      requireExactVersion(version, `package.json ${section}.${name}`);
    }
  }
  for (const dependency of cargoPackage.dependencies) {
    if (typeof dependency.req !== "string" || !/^=\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependency.req)) {
      fail(`Cargo.toml 依赖 ${dependency.name} 必须使用 =x.y.z 精确版本，当前为 ${dependency.req}`);
    }
  }

  const version = packageJson.version;
  const nsis = text(join(ROOT, "scripts", "CodexNN.nsi"));
  const buildScript = text(join(ROOT, "scripts", "build-desktop.sh"));
  if (!nsis.includes(`DisplayVersion\" \"${version}`) || !nsis.includes(`CodexNN_${version}_x64-setup.exe`)) {
    fail("NSIS 版本或输出文件名与应用版本不一致");
  }
  if (!buildScript.includes(`CodexNN_${version}_x64-setup.exe`)) {
    fail("桌面构建脚本的 Windows 输出文件名与应用版本不一致");
  }
  if (packageJson.scripts?.["release:prepare"] !== "node scripts/prepare-release.mjs") {
    fail("package.json 缺少固定的 release:prepare 版本同步命令");
  }
  if (packageJson.scripts?.["validate:release-assets"] !== "node scripts/validate-release-assets.mjs") {
    fail("package.json 缺少 Node 发布资产校验命令");
  }

  const prepare = text(join(ROOT, "scripts", "prepare-release.mjs"));
  for (const requiredPath of [
    "package.json", "package-lock.json", "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "scripts/CodexNN.nsi",
    "scripts/build-desktop.sh"
  ]) {
    if (!prepare.includes(requiredPath)) fail(`发布版本同步脚本缺少 ${requiredPath}`);
  }
  const workflow = text(join(ROOT, ".github", "workflows", "release.yml"));
  if (!workflow.includes("needs:\n      - quality-gate\n      - windows-gate")) {
    fail("Release job 必须等待 macOS 与 Windows 质量门禁");
  }
  if (!workflow.includes('npm run release:prepare -- "$RELEASE_VERSION"')) {
    fail("Release job 未同步目标发布版本");
  }
  if (workflow.includes("setup-python") || workflow.includes("python ")) {
    fail("发布工作流不应依赖 Python");
  }
}

function validateMcp(label, config) {
  const server = config.mcpServers?.["codex-nn"] ?? {};
  if (JSON.stringify(server.args) !== JSON.stringify(["mcp"])) {
    fail(`${label} 必须通过 Codex NN 的 mcp 子命令启动`);
  }
  if (server.default_tools_approval_mode !== "approve") fail(`${label} 必须保留工具审批`);
  if (server.startup_timeout_sec !== 30) fail(`${label} 启动超时必须为 30 秒`);
}

function validatePlugin() {
  const manifest = json(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"));
  const marketplace = json(join(PLUGIN_ROOT, "marketplace.json"));
  if (manifest.name !== "codex-nn-theme-designer") fail("插件 name 不正确");
  if (manifest.skills !== "./skills/") fail("插件 skills 路径不正确");
  if (manifest.mcpServers !== "./.mcp.json") fail("插件 mcpServers 路径不正确");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    fail("marketplace 必须且只能发布一个插件");
  }
  if (marketplace.plugins[0].name !== manifest.name) fail("marketplace 插件名与 manifest 不一致");

  const skillDirectories = readdirSync(join(PLUGIN_ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (JSON.stringify(skillDirectories) !== JSON.stringify(["design-codex-nn-theme"])) {
    fail("主题设计插件必须且只能包含 design-codex-nn-theme Skill");
  }
  const skill = text(join(SKILL_ROOT, "SKILL.md"));
  if (!skill.startsWith("---\nname: design-codex-nn-theme\n")) fail("SKILL.md frontmatter 缺少正确 name");
  if (!skill.includes("codex_nn_package_theme")) fail("Skill 缺少 MCP 主题打包流程");
  if (!skill.includes("通过 MCP 安装或更新")) fail("Skill 缺少 MCP 安装、更新和预览流程");
  if (!skill.includes("从 Codex NN App 启动或重启 Codex")) fail("Skill 缺少 CDP 异常恢复方法");
  if (existsSync(join(SKILL_ROOT, "scripts", "package_theme.py"))) fail("Skill 不应继续携带 Python 打包器");
  const agent = text(join(SKILL_ROOT, "agents", "openai.yaml"));
  if (!agent.includes("$design-codex-nn-theme")) fail("openai.yaml 默认提示词必须显式触发 Skill");
  const reference = readFileSync(join(SKILL_ROOT, "assets", "codex-ui-concept-reference.png"));
  if (!reference.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    fail("Codex UI 概念参考图不是有效 PNG");
  }

  const staticMcp = json(join(PLUGIN_ROOT, ".mcp.json"));
  const template = text(join(PLUGIN_ROOT, ".mcp.json.template"));
  if (template.split("{{CODEX_NN_COMMAND_JSON}}").length !== 2) fail("MCP 模板可执行文件占位符数量错误");
  if (template.split("{{CODEX_NN_APP_DATA_DIR_JSON}}").length !== 2) fail("MCP 模板数据目录占位符数量错误");
  const renderedMcp = JSON.parse(template
    .replace("{{CODEX_NN_COMMAND_JSON}}", JSON.stringify("/app/codex-nn"))
    .replace("{{CODEX_NN_APP_DATA_DIR_JSON}}", JSON.stringify("/data/codex-nn")));
  validateMcp("静态 MCP", staticMcp);
  validateMcp("MCP 模板", renderedMcp);
  if (renderedMcp.mcpServers["codex-nn"].env?.CODEX_NN_APP_DATA_DIR !== "/data/codex-nn") {
    fail("MCP 模板未传递 Codex NN App 数据目录");
  }
}

function zipEntries(path) {
  const data = readFileSync(path);
  let eocd = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail(`${relative(ROOT, path)} 不是有效 ZIP`);
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) fail(`${relative(ROOT, path)} 中央目录损坏`);
    const compression = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (data.readUInt32LE(localOffset) !== 0x04034b50) fail(`${relative(ROOT, path)} 本地条目损坏`);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(start, start + compressedSize);
    const content = compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : null;
    if (!content) fail(`${relative(ROOT, path)} 使用不支持的 ZIP 压缩方式`);
    if (entries.has(name)) fail(`${relative(ROOT, path)} 包含重复文件 ${name}`);
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function validateThemePacks() {
  const root = join(ROOT, "theme-packs");
  const directories = new Set(readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const archives = new Set(readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => entry.name.slice(0, -4)));
  if (!sameSet(directories, EXPECTED_THEME_IDS) || !sameSet(archives, EXPECTED_THEME_IDS)) {
    fail("内置主题目录与 ZIP 集合不一致");
  }
  for (const id of [...EXPECTED_THEME_IDS].sort()) {
    const directory = join(root, id);
    const manifest = json(join(directory, "theme.json"));
    if (manifest.schemaVersion !== 1 || manifest.id !== id) fail(`内置主题 ${id} 的 schemaVersion 或 id 错误`);
    const expectedAppearance = EXPECTED_THEME_APPEARANCE[id];
    if (manifest.appearance !== expectedAppearance) fail(`内置主题 ${id} 的 appearance 错误`);
    if (
      typeof manifest.art?.focusX !== "number" || manifest.art.focusX < 0 || manifest.art.focusX > 1
      || typeof manifest.art?.focusY !== "number" || manifest.art.focusY < 0 || manifest.art.focusY > 1
      || !["left", "right", "center", "none"].includes(manifest.art?.safeArea)
      || !["ambient", "banner", "off"].includes(manifest.art?.taskMode)
    ) {
      fail(`内置主题 ${id} 的自适应图片元数据错误`);
    }
    if (typeof manifest.image !== "string" || manifest.image.includes("/") || manifest.image.includes("\\")) {
      fail(`内置主题 ${id} 的 image 路径不安全`);
    }
    const expected = new Set(["theme.json", manifest.image]);
    const actual = new Set(readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (!sameSet(actual, expected)) fail(`内置主题目录 ${id} 不是严格双文件结构`);
    const archive = zipEntries(join(root, `${id}.zip`));
    if (!sameSet(new Set(archive.keys()), expected)) fail(`内置主题 ZIP ${id} 不是严格双文件结构`);
    for (const name of expected) {
      if (!archive.get(name).equals(readFileSync(join(directory, name)))) {
        fail(`内置主题 ${id} 的 ZIP 与目录内容不一致：${name}`);
      }
    }
  }
}

try {
  validateVersionsAndDependencies();
  validatePlugin();
  validateThemePacks();
  console.log("发布资产校验通过");
} catch (error) {
  console.error(`发布资产校验失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
