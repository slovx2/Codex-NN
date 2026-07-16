import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rawVersion = process.argv[2] ?? "";
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`发布版本必须使用 x.y.z 格式，收到：${rawVersion || "空值"}`);
}

async function read(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

async function write(relativePath, content) {
  await writeFile(resolve(root, relativePath), content);
}

async function updateJson(relativePath, update) {
  const content = JSON.parse(await read(relativePath));
  update(content);
  await write(relativePath, `${JSON.stringify(content, null, 2)}\n`);
}

await updateJson("package.json", (content) => {
  content.version = version;
});
await updateJson("package-lock.json", (content) => {
  content.version = version;
  content.packages[""].version = version;
});
await updateJson("src-tauri/tauri.conf.json", (content) => {
  content.version = version;
});

const cargoToml = (await read("src-tauri/Cargo.toml")).replace(
  /(^\[package\][\s\S]*?^version = ")[^"]+("$)/m,
  `$1${version}$2`
);
await write("src-tauri/Cargo.toml", cargoToml);

const cargoLock = (await read("src-tauri/Cargo.lock")).replace(
  /(^name = "codex-nn"\nversion = ")[^"]+("$)/m,
  `$1${version}$2`
);
await write("src-tauri/Cargo.lock", cargoLock);

const nsis = (await read("scripts/CodexNN.nsi"))
  .replace(/CodexNN_[0-9]+\.[0-9]+\.[0-9]+_x64-setup\.exe/g, `CodexNN_${version}_x64-setup.exe`)
  .replace(/("DisplayVersion" ")[0-9]+\.[0-9]+\.[0-9]+(")/g, `$1${version}$2`);
await write("scripts/CodexNN.nsi", nsis);

const buildScript = (await read("scripts/build-desktop.sh")).replace(
  /CodexNN_[0-9]+\.[0-9]+\.[0-9]+_x64-setup\.exe/g,
  `CodexNN_${version}_x64-setup.exe`
);
await write("scripts/build-desktop.sh", buildScript);

console.log(`发布构建版本已设置为 ${version}`);
