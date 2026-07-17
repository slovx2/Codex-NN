# Codex NN schema v1

主题 ZIP 根目录只能包含 `theme.json` 和一张本地图片。禁止目录、CSS、JavaScript、远程资源和加密文件。

## 清单

```json
{
  "schemaVersion": 1,
  "id": "example-theme",
  "name": "示例主题",
  "layoutPreset": "standard",
  "brandSubtitle": "CODEX NN",
  "tagline": "把喜欢的画面变成可交互的 Codex 工作台。",
  "projectPrefix": "选择项目 · ",
  "projectLabel": "◉  选择项目",
  "statusText": "THEME ONLINE",
  "quote": "MAKE SOMETHING WONDERFUL",
  "image": "background.webp",
  "appearance": "auto",
  "art": {
    "focusX": 0.72,
    "focusY": 0.45,
    "safeArea": "left",
    "taskMode": "ambient"
  },
  "colors": {
    "background": "#071116",
    "panel": "#0b1a20",
    "panelAlt": "#10272c",
    "accent": "#e25563",
    "accentAlt": "#f07a86",
    "secondary": "#f3a8af",
    "highlight": "#c93d4c",
    "text": "#f2fff7",
    "muted": "#a7c2ba",
    "line": "rgba(226, 85, 99, 0.32)"
  }
}
```

## 字段限制

- `schemaVersion` 必须是数字 `1`。
- `id` 最长 80 字符，以小写字母开头，只能包含小写字母、数字和连字符。
- `name` 必填且最长 80 字符；`tagline` 最长 160 字符；其他文字字段最长 80 字符。
- `appearance` 使用 `auto | light | dark`；通常选 `auto`，只有布局明确限定明暗外观时才固定。
- `art.focusX` / `art.focusY` 使用 `0..1`；`safeArea` 使用 `auto | left | right | center | none`；`taskMode` 使用 `auto | ambient | banner | off`。只有显式设置 `taskMode` 才会把主题图用于聊天页，缺省等同于 `off`。
- `colors` 可以省略或只覆盖少量颜色，其余颜色由背景图在本地分析生成；显式颜色只使用 `#RRGGBB`、`rgb(...)` 或 `rgba(...)`。
- 图片仅支持 PNG、JPEG、WebP，最大 16 MB，任一边不得超过 16384 像素，总像素不得超过 5000 万。
- 完整 ZIP 最大 20 MB，使用 Stored 或 Deflate 压缩。

优先使用 16:9 纯背景，把主体放在一侧并为文字保留低信息安全区。启用 `taskMode` 后，聊天页会把宽屏图连续铺到侧栏和主内容下方，再叠加可读性表面；不要把文字、输入框或其他 UI 烘焙进图片。

## 布局预设

- `standard`：通用布局，跟随 Codex 明暗外观，适合大多数自定义主题。
- `dreamSkin`：跟随 `appearance` 的沉浸式整窗壁纸，保留 Codex 原生布局，并以玻璃表面保证可读性。
- `strawberryStarlight`：珍珠玻璃、水晶心和粉紫星光视觉。
- `azureNeon`：深色烟熏玻璃、传送门环和青蓝霓虹视觉。

选择最接近概念稿的预设，不要因为背景颜色相近就忽略组件、字体和装饰语言。
