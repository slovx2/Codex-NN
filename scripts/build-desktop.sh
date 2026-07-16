#!/usr/bin/env bash

set -euo pipefail

TARGET=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --target=*)
      TARGET="${1#--target=}"
      shift
      ;;
    *)
      printf '未知参数：%s\n' "$1" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少构建命令：%s。%s\n' "$1" "${2:-}" >&2
    exit 1
  }
}

require_rust_target() {
  rustup target list --installed | /usr/bin/grep -qx "$1" || {
    printf '缺少 Rust target：%s，请先运行 rustup target add %s\n' "$1" "$1" >&2
    exit 1
  }
}

require_command npm
require_command rustup
cd "$APP_DIR"

case "$TARGET" in
  macos)
    [ "$(uname -s)" = "Darwin" ] || {
      printf 'macOS 安装包必须在 macOS 上构建。\n' >&2
      exit 1
    }
    require_rust_target aarch64-apple-darwin
    require_rust_target x86_64-apple-darwin
    npm run build
    npx tauri build --target universal-apple-darwin
    ;;
  windows)
    require_command x86_64-w64-mingw32-gcc "请安装 mingw-w64。"
    require_command docker "Windows NSIS 交叉打包需要 Docker。"
    require_rust_target x86_64-pc-windows-gnu
    npm run build
    npx tauri build --bundles app --target x86_64-pc-windows-gnu

    RELEASE_DIR="$APP_DIR/src-tauri/target/x86_64-pc-windows-gnu/release"
    NSIS_DIR="$RELEASE_DIR/bundle/nsis"
    /bin/mkdir -p "$NSIS_DIR"
    docker run --rm \
      -v "$RELEASE_DIR:/work" \
      -v "$SCRIPT_DIR:/scripts:ro" \
      debian:bookworm-slim \
      sh -lc 'apt-get update >/tmp/apt-update.log && apt-get install -y nsis >/tmp/apt-install.log && makensis /scripts/CodexNN.nsi'
    printf 'Windows 安装包：%s\n' "$NSIS_DIR/CodexNN_0.1.0_x64-setup.exe"
    ;;
  *)
    printf '用法：bash scripts/build-desktop.sh --target macos|windows\n' >&2
    exit 1
    ;;
esac
