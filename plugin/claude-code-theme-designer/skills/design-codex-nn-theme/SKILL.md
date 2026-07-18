---
name: design-codex-nn-theme
description: Design Codex NN schema v1 themes from a user-provided concept image or a text description. Use when Claude Code needs to create, revise, validate, package, install, switch, or diagnose a Codex NN theme ZIP containing theme.json and one local PNG, JPEG, or WebP background.
---

# 设计 Codex NN 主题

先确认完整界面概念，再制作最终素材。交付物固定为 Codex NN `schemaVersion: 1` 双文件 ZIP，并使用 Codex NN MCP 完成校验、安装、切换和诊断。

## 工作流

1. 完整读取 [主题包规范](references/theme-package-v1.md)，并查看 [Codex 界面参考图](assets/codex-ui-concept-reference.png)。
2. 收集用户的主题描述或概念稿。若只有文字描述，使用当前 Claude Code 会话可用的图像生成能力制作一张完整 Codex 界面概念稿；若当前会话没有图像生成能力，请用户提供概念稿或可用背景素材，不要假装已生成图像。
3. 严格还原真实 Codex 的功能结构和信息层级，不新增不存在的功能。参考图只用于构图和细节密度；其中的图标、文案、项目名、任务名和会话标题必须按用户主题重新设计。
4. 向用户展示完整界面概念稿和简短设计摘要。**这是强制门禁：用户明确确认概念前必须停止，不得生成最终纯背景、`theme.json`、主题 ZIP，也不得安装或切换主题。** 修改概念稿后需要再次获得明确确认。
5. 用户确认后，生成一张 16:9 纯背景图，并选择现有 `layoutPreset`，设置 `appearance`、焦点、安全区、聊天页模式、配色和文案。背景不得包含按钮、输入框、完整 UI、文字、Logo 或水印。
6. 创建只含 `theme.json` 和一张本地图片的目录。调用 Codex NN MCP 的 `codex_nn_package_theme`，以绝对路径传入 `source_path` 和 `output_path`；根据 MCP 返回的 schema、字段或图片错误修正素材，直到打包成功。
7. 调用 `codex_nn_install_theme` 安装新主题；若同 ID 已存在并需要覆盖，则在用户同意后调用 `codex_nn_update_theme`。随后调用 `codex_nn_activate_theme` 切换主题，并在需要时调用 `codex_nn_apply_theme` 热更新当前界面。
8. 调用 `codex_nn_diagnose` 检查 App、Codex、CDP 和当前主题状态。用户确认实际效果后，提供最终 ZIP 的可点击绝对路径。

MCP 连接失败时先确认 Codex NN 正在运行。诊断提示 CDP 未连接、端口失效或会话异常时，请用户从 Codex NN App 启动或重启 Codex；必要时调用 `codex_nn_launch_codex`，再重试切换或应用。

## 原则

- 真实 Codex 界面或用户截图优先于参考图；忠实保留功能性元素，不继承参考图的强主题内容。
- 用单一视觉母题统一整窗壁纸、侧栏、原生卡片、输入框、字体和装饰，保证文字对比度。
- 最终包只含 `theme.json` 和一张 PNG、JPEG 或 WebP；禁止 CSS、JavaScript、远程资源和加密文件。
- 图片优先使用 16:9，任一边不超过 16384 像素、总像素不超过 5000 万、文件不超过 16 MB；修改已有主题时保留 `id`。
- 主体放在一侧，另一侧保留低信息安全区；只有用户希望主题图出现在聊天页时才设置 `taskMode`，通常使用 `taskMode: "ambient"` 显示低干扰整窗背景。
