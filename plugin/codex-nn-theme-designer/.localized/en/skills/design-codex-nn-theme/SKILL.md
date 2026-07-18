---
name: design-codex-nn-theme
description: Design Codex NN schema v1 themes from a user-provided concept image or a text description. Use when Codex needs to create, revise, validate, or package a Codex NN theme ZIP containing theme.json and one local PNG, JPEG, or WebP background.
---

# Design a Codex NN Theme

Confirm the concept first, then create the final assets. The deliverable is always a two-file Codex NN `schemaVersion: 1` ZIP.

## Workflow

1. Read the [theme package specification](references/theme-package-v1.md) and inspect the [Codex interface reference](assets/codex-ui-concept-reference.png).
2. Collect the user's theme description or concept image. When no artwork is available, use image generation to create a complete Codex interface concept; if image generation is unavailable, ask the user for source material.
3. Preserve the real Codex feature structure and hierarchy. Do not invent features. Use the reference only for composition and detail density; replace every adventure icon, label, project name, task name, and conversation title with content appropriate to the user's theme.
4. Present the concept and a short design summary. **Stop until the user explicitly approves it; do not generate the final background or ZIP before approval.**
5. After approval, generate one clean 16:9 background image. Choose an existing `layoutPreset` and set `appearance`, focus, safe area, chat-page mode, colors, and copy. Do not bake buttons, inputs, complete UI, text, logos, or watermarks into the background.
6. Call the Codex NN MCP tool `codex_nn_package_theme` with absolute paths to the two-file source directory and output ZIP. Fix schema, field, or image errors reported by the app until packaging succeeds.
7. Use the MCP to install or update the ZIP and switch to it for preview. After the user confirms the result, provide a clickable path to the ZIP.

If the MCP cannot connect, confirm that Codex NN is running. If diagnostics report a disconnected CDP endpoint, an expired port, or an invalid session, ask the user to launch or restart Codex from Codex NN and retry.

## Principles

- Prefer the real Codex interface or user screenshots over the reference. Preserve functional elements without inheriting the reference's strong theme content.
- Use one visual motif across the wallpaper, sidebar, native cards, input, typography, and decoration while maintaining readable contrast.
- The final package contains only `theme.json` and one PNG, JPEG, or WebP. CSS, JavaScript, and remote assets are forbidden.
- Prefer a 16:9 image. No edge may exceed 16,384 pixels, total pixels may not exceed 50 million, and the image may not exceed 16 MB. Preserve `id` when revising an existing theme.
- Put the subject on one side and keep a low-information safe area on the other. Missing or `auto` `taskMode` chooses the chat-page treatment from image proportions; use `off` only when the chat background must be disabled.
