# Codex NN schema v1

A theme ZIP root may contain only `theme.json` and one local image. Directories, CSS, JavaScript, remote assets, and encrypted files are forbidden. Fields shared with Dream Skin follow Dream Skin schema v1 semantics; `layoutPreset` is a Codex NN extension.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "example-theme",
  "name": "Example Theme",
  "layoutPreset": "standard",
  "brandSubtitle": "CODEX NN",
  "tagline": "Turn a favorite scene into an interactive Codex workspace.",
  "projectPrefix": "Choose project · ",
  "projectLabel": "◉  Choose a project",
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

## Field Limits

- `schemaVersion` must be the number `1`.
- `id` is at most 80 characters, starts with a lowercase letter, and contains only lowercase letters, digits, and hyphens.
- `name` is required and at most 80 characters. `tagline` is at most 160 characters. Other text fields are at most 80 characters.
- `appearance` accepts `auto | light | dark`. Prefer `auto` unless the layout requires a specific appearance.
- `art.focusX` and `art.focusY` use `0..1`; `safeArea` accepts `auto | left | right | center | none`; `taskMode` accepts `auto | ambient | banner | off`. Missing and `auto` select behavior from image proportions. Only explicit `off` disables the chat-page image.
- `colors` may be omitted or may override a subset. Remaining colors are derived locally from the background. Explicit colors accept only `#RRGGBB`, `rgb(...)`, or `rgba(...)`.
- Images may be PNG, JPEG, or WebP, at most 16 MB, no more than 16,384 pixels on either edge, and no more than 50 million total pixels.
- The complete ZIP is at most 20 MB and uses Stored or Deflate compression.

Prefer a clean 16:9 background. Put the subject on one side and reserve a low-information area for text. Wide images render once across the new-conversation page and can extend below the sidebar and main content on chat pages with readability surfaces layered above. Do not bake text, inputs, or other UI into the image.

## Layout Presets

- `standard`: General-purpose layout that follows Codex light or dark appearance.
- `dreamSkin`: Native renderer synchronized from Dream Skin 1.2.0. Shared fields and defaults follow Dream Skin schema v1.
- `strawberryStarlight`: Pearl glass, crystal hearts, and pink-purple starlight.
- `azureNeon`: Dark smoked glass, portal rings, and cyan-blue neon.
- `mikuFuture`: Light mint workspace, music decoration, and a large centered action card.
- `adventureAtlas`: Light parchment, compass, and watercolor-adventure styling for bright landscape images.
- `portalDimension`: Dark teal lab, fluorescent green portals, universe groups, and task coordinates.

Choose the preset whose components, typography, and decorative language best match the concept, not merely the closest background color.
