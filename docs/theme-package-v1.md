# Codex NN 主题包 v1

主题包是一个标准 ZIP 文件，根目录必须且只能包含 `theme.json` 和一张主题图片：

```text
example-theme.zip
├── theme.json
└── background.webp
```

不要把这两个文件放入额外的文件夹。主题包不支持脚本、CSS、远程资源或加密文件。

## theme.json

v1 沿用 Codex Dream Skin 的运行时主题字段：

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

字段限制：

- `schemaVersion` 固定为数字 `1`。
- `layoutPreset` 可选 `standard`、`dreamSkin`、`strawberryStarlight` 或 `azureNeon`；旧清单缺省时按 `standard` 处理。
- `appearance` 可选 `auto`、`light` 或 `dark`。`auto` 跟随 Codex/系统外观，图片亮度不会擅自改变明暗模式。
- `art.focusX` / `art.focusY` 是 `0..1` 的归一化焦点坐标。
- `art.safeArea` 可选 `auto`、`left`、`right`、`center` 或 `none`，表示适合放置文字和控件的低信息区域。
- `art.taskMode` 是聊天页主题图的显式开关，可选 `auto`、`ambient`、`banner` 或 `off`。缺省或 `off` 时聊天页不使用主题图；`auto` 按图片比例选择模式，`ambient` 使用低干扰整窗背景，`banner` 适合超宽图。
- `id` 只能使用小写字母、数字和连字符，不能为空，最长 80 字符；后续更新同一主题时保持 ID 不变。
- `name` 必填，最长 80 字符；`tagline` 最长 160 字符；其余文字字段最长 80 字符。
- `colors` 可以省略或只提供需要覆盖的字段；缺省颜色由图片在本地分析生成。显式颜色使用 `#RRGGBB`、`rgb(...)` 或 `rgba(...)`。
- `image` 只能是 ZIP 根目录中的文件名，不允许目录或相对路径。

Codex NN 会在本地分析图片的主色、焦点、安全区和宽高比，不会上传图片。主题显式启用 `art.taskMode` 后，16:9 及更宽的图片会在聊天页铺成侧栏与主内容连续的单张整窗背景，同时通过半透明侧栏、消息和输入框表面保证文字可读。

## 图片与压缩限制

- 支持 PNG、JPEG 和 WebP，文件内容必须与扩展名一致。
- 图片最大 16 MB，任一边不得超过 16384 像素，总像素不得超过 5000 万。
- ZIP 最大 20 MB，解压后的文件总量最大 20 MB。
- 压缩方式使用 Stored 或 Deflate。

macOS/Linux 可在包含两个文件的目录中执行：

```bash
zip example-theme.zip theme.json background.webp
```

PowerShell 可执行：

```powershell
Compress-Archive -Path theme.json,background.webp -DestinationPath example-theme.zip
```

Codex NN 会在安装时校验整个主题包并生成本地预览图。相同 ID 的已安装主题可在确认后更新，内置主题不可覆盖或删除。

## Dream Skin macOS 主题

Codex NN 的“导入 Dream Skin”入口支持选择 Dream Skin 的 `themes/<id>` 目录，或选择根目录/单层包装目录中只含 `theme.json` 与图片的 ZIP。导入时会忽略 `.DS_Store`、`__MACOSX` 和推广字段，保留 `appearance`、`art` 与部分颜色覆盖，并转换为 `layoutPreset: "dreamSkin"` 的 Codex NN schema v1 主题后直接安装。
