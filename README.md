<p align="center">
  简体中文 · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="./src-tauri/icons/icon.png" width="128" height="128" alt="Codex NN 图标">
</p>

<h1 align="center">Codex 暖暖</h1>

<p align="center">
  <strong>Codex NN，给 Codex 换套新衣服。</strong>
</p>

<p align="center">
  Codex 换肤神器 · 可视化操作 · 开箱即用 · 一键切换
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-supported-111111?logo=apple" alt="支持 macOS">
  <img src="https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11" alt="支持 Windows">
  <img src="https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

> [!IMPORTANT]
> Codex 暖暖是社区项目，并非 OpenAI 官方产品。项目不会修改 Codex 的官方安装包、程序文件或代码签名。

## 项目介绍

**Codex 暖暖（Codex NN）** 是为官方 Codex Desktop 打造的可视化主题管理器。

不用手动改文件，也不用反复执行脚本。打开 Codex 暖暖，选择喜欢的主题，然后一键启动或切换，就能为 Codex 换上全新的界面风格。

## 功能亮点

- **可视化操作**：主题预览、安装、切换、恢复都在桌面界面中完成
- **开箱即用**：内置「草莓星光」和「蔚蓝霓虹边境」两个主题，安装后即可开始使用
- **一键切换**：主题会话运行时支持热切换，不用重复配置
- **本地主题库**：通过 ZIP 安装、更新和管理自己的主题包
- **完整控制**：支持启动或重启 Codex、暂停主题和一键恢复官方外观
- **状态诊断**：检查 Codex 安装、主题文件和本地端口，也可实时验证换肤结果
- **后台守护**：关闭主窗口后驻留系统托盘，持续维护当前主题
- **自动更新**：启动时自动检查 GitHub Releases，并可在应用内完成下载安装
- **跨平台**：支持 macOS 与 Windows

## 快速开始

### 直接使用

1. 安装并至少启动一次官方 Codex Desktop。
2. 从 [Releases](../../releases) 下载当前系统对应的 Codex NN 安装包。
3. 安装并打开 Codex 暖暖。
4. 在「主题库」中选择主题，点击「应用主题」。
5. 通过 Codex 暖暖启动或重启 Codex，主题即可生效。

> [!TIP]
> 主题生效期间请让 Codex 暖暖在后台运行。关闭主窗口只会收进系统托盘；从托盘彻底退出时，当前主题会自动暂停。

### 平台支持

| 平台 | 支持的 Codex 安装来源 | 安装包 |
| --- | --- | --- |
| macOS | 官方 Codex Desktop 应用 | Universal `.dmg` / `.app` |
| Windows | Microsoft Store 官方 Codex | x64 `.exe` |

Linux 暂未支持。

## 使用主题

在「主题库」中点击「安装主题包」，选择符合 Codex NN 规范的 ZIP 文件即可。安装完成后可以预览、切换、更新或删除主题。

一个最小主题包包含以下两个文件：

```text
my-theme.zip
├── theme.json
└── background.webp
```

主题包仅包含声明文件和本地图片，不支持脚本、CSS、远程资源或加密文件。完整字段、图片规格和打包方法请查看 [主题包 v1 规范](./docs/theme-package-v1.md)。

## 工作方式

Codex NN 通过仅监听 `127.0.0.1` 的 Chrome DevTools Protocol（CDP）连接，为正在运行的 Codex 页面加载主题，并由后台守护进程维持主题状态。

- 不修改 Codex 官方安装目录
- 不替换官方二进制文件
- 不破坏应用代码签名
- 只连接经过校验、属于当前 Codex 进程的本机端口
- 可随时使用「完全恢复」回到官方启动方式和界面

## 安全说明

主题会话运行时，Codex 会开放一个仅限本机访问的调试端口。Codex NN 会校验端口归属并拒绝非回环连接，但仍建议不要在主题会话期间运行来源不明的本机程序。

Codex 更新可能改变界面结构，导致部分主题暂时失效。遇到问题时可以先使用「诊断」检查状态，或点击「完全恢复」回到官方外观。

## 参与贡献

欢迎通过 Issue 反馈问题、提交主题兼容建议，或通过 Pull Request 改进 Codex NN。

## 开源许可

Codex NN 基于 [MIT License](./LICENSE) 开源。

## 鸣谢与声明

主题引擎的部分实现参考并修改自 Codex Dream Skin Studio，详情请查看 [第三方声明](./THIRD_PARTY_NOTICES.md) 与 [对应许可文本](./THIRD_PARTY_LICENSE_CODEX_DREAM_SKIN.txt)。

Codex、OpenAI 及相关名称和标识归其各自权利人所有。本项目与 OpenAI 不存在隶属或背书关系。

---

<p align="center">
  如果 Codex 暖暖让你的工作台更有趣，欢迎点一个 Star ⭐
</p>
