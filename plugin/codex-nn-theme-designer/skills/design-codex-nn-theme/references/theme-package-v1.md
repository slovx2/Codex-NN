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
- 颜色只使用 `#RRGGBB`、`rgb(...)` 或 `rgba(...)`。
- 图片仅支持 PNG、JPEG、WebP，最大 16 MB，宽高均不得超过 3200 像素。
- 完整 ZIP 最大 20 MB，使用 Stored 或 Deflate 压缩。

## 布局预设

- `standard`：通用布局，跟随 Codex 明暗外观，适合大多数自定义主题。
- `dreamSkin`：浅色梦幻布局，突出头图、行动卡和装饰。
- `strawberryStarlight`：珍珠玻璃、水晶心和粉紫星光视觉。
- `azureNeon`：深色烟熏玻璃、传送门环和青蓝霓虹视觉。

选择最接近概念稿的预设，不要因为背景颜色相近就忽略组件、字体和装饰语言。
