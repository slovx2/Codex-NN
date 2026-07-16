#!/usr/bin/env python3
"""校验发布前必须保持一致的版本、插件和主题资产。"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
PLUGIN_ROOT = ROOT / "plugin" / "codex-nn-theme-designer"
SKILL_ROOT = PLUGIN_ROOT / "skills" / "design-codex-nn-theme"
EXPECTED_THEME_IDS = {"azure-neon-frontier", "strawberry-starlight"}


def fail(message: str) -> None:
    raise ValueError(message)


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} 必须是 JSON 对象")
    return value


def require_npm_exact_version(value: Any, location: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(
        r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", value
    ):
        fail(f"{location} 必须使用精确版本号，当前为 {value!r}")


def validate_versions_and_dependencies() -> None:
    package = load_json(ROOT / "package.json")
    tauri = load_json(ROOT / "src-tauri" / "tauri.conf.json")
    metadata = json.loads(
        subprocess.run(
            [
                "cargo",
                "metadata",
                "--manifest-path",
                str(ROOT / "src-tauri" / "Cargo.toml"),
                "--format-version",
                "1",
                "--no-deps",
                "--locked",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    cargo_package = next(
        item for item in metadata["packages"] if item.get("name") == "codex-nn"
    )
    package_version = package.get("version")
    cargo_version = cargo_package.get("version")
    tauri_version = tauri.get("version")
    if len({package_version, cargo_version, tauri_version}) != 1:
        fail(
            "package.json、Cargo.toml 与 tauri.conf.json 版本不一致："
            f"{package_version}, {cargo_version}, {tauri_version}"
        )

    for section in ("dependencies", "devDependencies"):
        for name, version in package.get(section, {}).items():
            require_npm_exact_version(version, f"package.json {section}.{name}")
    for dependency in cargo_package.get("dependencies", []):
        requirement = dependency.get("req")
        if not isinstance(requirement, str) or not re.fullmatch(
            r"=\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", requirement
        ):
            fail(
                "Cargo.toml 依赖 "
                f"{dependency.get('name')} 必须使用 =x.y.z 精确版本，当前为 {requirement!r}"
            )

    nsis = (ROOT / "scripts" / "CodexNN.nsi").read_text(encoding="utf-8")
    if f'DisplayVersion" "{package_version}"' not in nsis:
        fail("NSIS DisplayVersion 与应用版本不一致")
    if f"CodexNN_{package_version}_x64-setup.exe" not in nsis:
        fail("NSIS 输出文件名与应用版本不一致")


def validate_plugin() -> None:
    manifest = load_json(PLUGIN_ROOT / ".codex-plugin" / "plugin.json")
    marketplace = load_json(PLUGIN_ROOT / "marketplace.json")
    if manifest.get("name") != "codex-nn-theme-designer":
        fail("插件 name 不正确")
    if manifest.get("skills") != "./skills/":
        fail("插件 skills 路径不正确")
    if manifest.get("mcpServers") != "./.mcp.json":
        fail("插件 mcpServers 路径不正确")
    plugins = marketplace.get("plugins")
    if not isinstance(plugins, list) or len(plugins) != 1:
        fail("marketplace 必须且只能发布一个插件")
    if plugins[0].get("name") != manifest.get("name"):
        fail("marketplace 插件名与 manifest 不一致")

    skill_dirs = sorted(path for path in (PLUGIN_ROOT / "skills").iterdir() if path.is_dir())
    if skill_dirs != [SKILL_ROOT]:
        fail("主题设计插件必须且只能包含 design-codex-nn-theme Skill")
    skill = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8")
    if not skill.startswith("---\nname: design-codex-nn-theme\n"):
        fail("SKILL.md frontmatter 缺少正确 name")
    agent = (SKILL_ROOT / "agents" / "openai.yaml").read_text(encoding="utf-8")
    if "$design-codex-nn-theme" not in agent:
        fail("openai.yaml 默认提示词必须显式触发 Skill")
    if "通过 Codex NN MCP 安装或更新主题并切换预览" not in skill:
        fail("Skill 缺少通过 MCP 安装、更新和预览主题的流程")
    if "从 Codex NN App 启动或重启 Codex" not in skill:
        fail("Skill 缺少 CDP 异常恢复方法")
    reference = SKILL_ROOT / "assets" / "codex-ui-concept-reference.png"
    if not reference.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
        fail("Codex UI 概念参考图不是有效 PNG")
    if not (SKILL_ROOT / "scripts" / "package_theme.py").is_file():
        fail("Skill 缺少主题打包器")

    static_mcp = load_json(PLUGIN_ROOT / ".mcp.json")
    template_text = (PLUGIN_ROOT / ".mcp.json.template").read_text(encoding="utf-8")
    if template_text.count("{{CODEX_NN_COMMAND_JSON}}") != 1:
        fail("MCP 模板必须且只能包含一个可执行文件占位符")
    if template_text.count("{{CODEX_NN_APP_DATA_DIR_JSON}}") != 1:
        fail("MCP 模板必须且只能包含一个 App 数据目录占位符")
    rendered_mcp = json.loads(
        template_text.replace("{{CODEX_NN_COMMAND_JSON}}", json.dumps("/app/codex-nn"))
        .replace("{{CODEX_NN_APP_DATA_DIR_JSON}}", json.dumps("/data/codex-nn"))
    )
    for label, config in (("静态 MCP", static_mcp), ("MCP 模板", rendered_mcp)):
        server = config.get("mcpServers", {}).get("codex-nn", {})
        if server.get("args") != ["mcp"]:
            fail(f"{label} 必须通过 Codex NN 的 mcp 子命令启动")
        if server.get("default_tools_approval_mode") != "approve":
            fail(f"{label} 必须保留工具审批")
        if server.get("startup_timeout_sec") != 30:
            fail(f"{label} 启动超时必须为 30 秒")
    if rendered_mcp["mcpServers"]["codex-nn"].get("env", {}).get(
        "CODEX_NN_APP_DATA_DIR"
    ) != "/data/codex-nn":
        fail("MCP 模板未传递 Codex NN App 数据目录")


def validate_theme_packs() -> None:
    packs_root = ROOT / "theme-packs"
    directories = {path.name for path in packs_root.iterdir() if path.is_dir()}
    archives = {path.stem for path in packs_root.glob("*.zip")}
    if directories != EXPECTED_THEME_IDS or archives != EXPECTED_THEME_IDS:
        fail("内置主题目录与 ZIP 集合不一致")

    for theme_id in sorted(EXPECTED_THEME_IDS):
        directory = packs_root / theme_id
        manifest_path = directory / "theme.json"
        manifest = load_json(manifest_path)
        if manifest.get("schemaVersion") != 1 or manifest.get("id") != theme_id:
            fail(f"内置主题 {theme_id} 的 schemaVersion 或 id 错误")
        image_name = manifest.get("image")
        if not isinstance(image_name, str) or Path(image_name).name != image_name:
            fail(f"内置主题 {theme_id} 的 image 路径不安全")
        expected_names = sorted(["theme.json", image_name])
        actual_files = sorted(path.name for path in directory.iterdir() if path.is_file())
        if actual_files != expected_names:
            fail(f"内置主题目录 {theme_id} 不是严格双文件结构")

        with zipfile.ZipFile(packs_root / f"{theme_id}.zip") as archive:
            if sorted(archive.namelist()) != expected_names:
                fail(f"内置主题 ZIP {theme_id} 不是严格双文件结构")
            for name in expected_names:
                if archive.read(name) != (directory / name).read_bytes():
                    fail(f"内置主题 {theme_id} 的 ZIP 与目录内容不一致：{name}")


def main() -> None:
    validate_versions_and_dependencies()
    validate_plugin()
    validate_theme_packs()
    print("发布资产校验通过")


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        ValueError,
        StopIteration,
        subprocess.CalledProcessError,
        json.JSONDecodeError,
        zipfile.BadZipFile,
    ) as error:
        print(f"发布资产校验失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
