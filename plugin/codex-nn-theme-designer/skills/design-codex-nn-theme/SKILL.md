---
name: design-codex-nn-theme
description: Design Codex NN schema v1 themes from a user-provided concept image or a text description. Use when Codex needs to create, revise, validate, or package a Codex NN theme ZIP containing theme.json and one local PNG, JPEG, or WebP background.
---

# 设计 Codex NN 主题

先确认概念稿，再制作最终素材。交付物固定为 Codex NN `schemaVersion: 1` 双文件 ZIP。

## 工作流

1. 读取 [主题包规范](references/theme-package-v1.md)，并查看 [Codex 界面参考图](assets/codex-ui-concept-reference.png)。
2. 收集用户的主题描述或概念稿。没有素材时使用生图能力生成完整 Codex 界面概念稿；无法生图时请求用户补充素材。
3. 严格还原真实 Codex 的功能结构和层级，不新增不存在的功能。参考图只用于构图和细节密度；其中的冒险图标、文案、项目名、任务名和会话标题必须按用户主题全部重做。
4. 展示概念稿和简短设计摘要。**用户明确确认前停止，不得生成最终背景或 ZIP。**
5. 确认后生成一张纯背景图，并选择现有 `layoutPreset`，完成配色、文案和 `theme.json`。背景不得包含按钮、输入框、完整 UI、文字、Logo 或水印。
6. 调用 Codex NN MCP 的 `codex_nn_package_theme`，传入双文件主题目录和输出 ZIP 的绝对路径；根据 App 返回的 schema、字段或图片错误修正素材，直到打包成功。
7. 继续通过 MCP 安装或更新生成的 ZIP 并切换预览；用户确认效果后提供可点击 ZIP 路径。

MCP 连接失败时先确认 Codex NN 正在运行。诊断提示 CDP 未连接、端口失效或会话异常时，请用户从 Codex NN App 启动或重启 Codex，再重试操作。

## 原则

- 真实 Codex 界面或用户截图优先于参考图；忠实保留功能性元素，不继承参考图的强主题内容。
- 用单一视觉母题统一整窗壁纸、侧栏、原生卡片、输入框、字体和装饰，保证文字对比度。
- 最终包只含 `theme.json` 和一张 PNG、JPEG 或 WebP；禁止 CSS、JavaScript 和远程资源。
- 图片使用 16:9，最长边不超过 3200 像素、16 MB；修改已有主题时保留 `id`。
