#!/usr/bin/env python3
"""校验并打包 Codex NN schema v1 主题。"""

from __future__ import annotations

import argparse
import json
import re
import struct
import zipfile
from pathlib import Path
from typing import Any

MAX_MANIFEST_BYTES = 64 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_PACKAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_EDGE = 3200
LAYOUTS = {"standard", "dreamSkin", "strawberryStarlight", "azureNeon"}
COLOR_KEYS = (
    "background",
    "panel",
    "panelAlt",
    "accent",
    "accentAlt",
    "secondary",
    "highlight",
    "text",
    "muted",
    "line",
)
TEXT_LIMITS = {
    "name": (80, True),
    "brandSubtitle": (80, False),
    "tagline": (160, False),
    "projectPrefix": (80, False),
    "projectLabel": (80, False),
    "statusText": (80, False),
    "quote": (80, False),
}
ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,79}$")
HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")
RGB_COLOR_PATTERN = re.compile(r"^rgba?\([0-9., %]+\)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="打包 Codex NN schema v1 主题")
    parser.add_argument("theme_dir", type=Path, help="包含 theme.json 和图片的目录")
    parser.add_argument("--output", required=True, type=Path, help="输出 ZIP 路径")
    return parser.parse_args()


def require_object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} 必须是 JSON 对象")
    return value


def validate_manifest(manifest: dict[str, Any]) -> str:
    if manifest.get("schemaVersion") != 1:
        raise ValueError("schemaVersion 必须是数字 1")

    theme_id = manifest.get("id")
    if not isinstance(theme_id, str) or ID_PATTERN.fullmatch(theme_id) is None:
        raise ValueError("id 必须以小写字母开头，且只能包含小写字母、数字和连字符")

    for key, (limit, required) in TEXT_LIMITS.items():
        value = manifest.get(key)
        if not isinstance(value, str):
            raise ValueError(f"{key} 必须是字符串")
        if required and not value.strip():
            raise ValueError(f"{key} 不能为空")
        if len(value) > limit:
            raise ValueError(f"{key} 不得超过 {limit} 个字符")

    layout = manifest.get("layoutPreset")
    if layout not in LAYOUTS:
        raise ValueError(f"layoutPreset 必须是：{', '.join(sorted(LAYOUTS))}")

    image = manifest.get("image")
    if not isinstance(image, str) or not image or Path(image).name != image:
        raise ValueError("image 必须是主题目录根部的文件名")

    colors = require_object(manifest.get("colors"), "colors")
    for key in COLOR_KEYS:
        value = colors.get(key)
        if not isinstance(value, str) or not (
            HEX_COLOR_PATTERN.fullmatch(value.strip())
            or RGB_COLOR_PATTERN.fullmatch(value.strip())
        ):
            raise ValueError(f"colors.{key} 格式错误")
    return image


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return struct.unpack(">II", data[16:24])
    return None


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(b"\xff\xd8"):
        return None
    position = 2
    start_of_frame = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while position + 4 <= len(data):
        if data[position] != 0xFF:
            position += 1
            continue
        while position < len(data) and data[position] == 0xFF:
            position += 1
        if position >= len(data):
            break
        marker = data[position]
        position += 1
        if marker in {0x01, *range(0xD0, 0xDA)}:
            continue
        if position + 2 > len(data):
            break
        segment_length = int.from_bytes(data[position : position + 2], "big")
        if segment_length < 2 or position + segment_length > len(data):
            break
        if marker in start_of_frame and segment_length >= 7:
            height = int.from_bytes(data[position + 3 : position + 5], "big")
            width = int.from_bytes(data[position + 5 : position + 7], "big")
            return width, height
        position += segment_length
    return None


def webp_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return None
    chunk = data[12:16]
    payload = data[20:]
    if chunk == b"VP8X" and len(payload) >= 10:
        width = 1 + int.from_bytes(payload[4:7], "little")
        height = 1 + int.from_bytes(payload[7:10], "little")
        return width, height
    if chunk == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
        width = int.from_bytes(payload[6:8], "little") & 0x3FFF
        height = int.from_bytes(payload[8:10], "little") & 0x3FFF
        return width, height
    if chunk == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
        bits = int.from_bytes(payload[1:5], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def validate_image(path: Path) -> None:
    size = path.stat().st_size
    if size < 1 or size > MAX_IMAGE_BYTES:
        raise ValueError("主题图片必须非空且不超过 16 MB")
    data = path.read_bytes()
    suffix = path.suffix.lower()
    dimensions = {
        ".png": png_dimensions,
        ".jpg": jpeg_dimensions,
        ".jpeg": jpeg_dimensions,
        ".webp": webp_dimensions,
    }.get(suffix)
    if dimensions is None:
        raise ValueError("主题图片只支持 PNG、JPEG 或 WebP")
    measured = dimensions(data)
    if measured is None:
        raise ValueError("图片内容与扩展名不一致或无法读取尺寸")
    width, height = measured
    if width < 1 or height < 1 or width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE:
        raise ValueError("主题图片宽高必须在 1–3200 像素之间")


def main() -> None:
    args = parse_args()
    theme_dir = args.theme_dir.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not theme_dir.is_dir():
        raise ValueError(f"主题目录不存在：{theme_dir}")
    if output.suffix.lower() != ".zip":
        raise ValueError("输出文件必须使用 .zip 扩展名")
    if output.parent == theme_dir:
        raise ValueError("输出 ZIP 必须放在主题目录之外")

    manifest_path = theme_dir / "theme.json"
    if not manifest_path.is_file():
        raise ValueError("主题目录缺少 theme.json")
    manifest_bytes = manifest_path.read_bytes()
    if not manifest_bytes or len(manifest_bytes) > MAX_MANIFEST_BYTES:
        raise ValueError("theme.json 为空或超过 64 KB")
    manifest = require_object(json.loads(manifest_bytes), "theme.json")
    image_name = validate_manifest(manifest)
    image_path = theme_dir / image_name
    if not image_path.is_file() or image_path.is_symlink():
        raise ValueError("清单引用的主题图片不存在或是符号链接")

    entries = sorted(item.name for item in theme_dir.iterdir())
    if entries != sorted(["theme.json", image_name]):
        raise ValueError("主题目录必须且只能包含 theme.json 和清单引用的图片")
    validate_image(image_path)

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("theme.json", manifest_bytes)
        archive.write(image_path, image_name)
    if output.stat().st_size > MAX_PACKAGE_BYTES:
        output.unlink(missing_ok=True)
        raise ValueError("主题 ZIP 超过 20 MB")
    print(f"已生成 Codex NN schema v1 主题包：{output}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise SystemExit(f"打包失败：{error}") from error
