<p align="center">
  <a href="./README.md">简体中文</a> · English
</p>

<p align="center">
  <img src="./src-tauri/icons/icon.png" width="128" height="128" alt="Codex NN icon">
</p>

<h1 align="center">Codex NN</h1>

<p align="center">
  <strong>Give Codex a fresh new look.</strong>
</p>

<p align="center">
  Visual theming · Easy setup · Instant switching
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-supported-111111?logo=apple" alt="macOS supported">
  <img src="https://img.shields.io/badge/Windows-supported-0078D4?logo=windows11" alt="Windows supported">
  <img src="https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

> [!IMPORTANT]
> Codex NN is a community project, not an official OpenAI product. It does not modify the official Codex installer, application files, or code signature.

## About

**Codex NN** is a visual theme manager for the official Codex Desktop app.

No manual file editing or repeated scripts are required. Open Codex NN, choose a theme, and launch or switch with one click to give Codex a completely new appearance.

## Highlights

- **Visual workflow**: preview, install, switch, and restore themes from a desktop interface
- **Ready to use**: includes the Strawberry Starlight and Azure Neon Frontier themes
- **Instant switching**: hot-swap themes while a managed theme session is running
- **Local theme library**: install, update, and manage your own ZIP theme packages
- **Full control**: launch or restart Codex, pause theming, or restore the official appearance
- **Diagnostics**: inspect the Codex installation, theme files, local port, and live result
- **Background companion**: stays in the system tray to maintain the active theme
- **Automatic updates**: checks GitHub Releases at startup and installs updates in the app
- **Cross-platform**: supports macOS and Windows

## Quick Start

### Install and Run

1. Install and launch the official Codex Desktop app at least once.
2. Download the installer for your system from [Releases](../../releases).
3. Install and open Codex NN.
4. Choose a theme in the theme library and select **Apply Theme**.
5. Launch or restart Codex from Codex NN for the theme to take effect.

> [!TIP]
> Keep Codex NN running in the background while a theme session is active. Closing the main window sends it to the system tray; quitting from the tray pauses the active theme automatically.

### Platform Support

| Platform | Supported Codex distribution | Installer |
| --- | --- | --- |
| macOS | Official Codex Desktop app | Universal `.dmg` / `.app` |
| Windows | Official Codex from Microsoft Store | x64 `.exe` |

Linux is not currently supported.

## Using Themes

In the theme library, select **Install Theme Package** and choose a ZIP file that follows the Codex NN theme format. Installed themes can be previewed, switched, updated, or removed.

A minimal theme package contains two files:

```text
my-theme.zip
├── theme.json
└── background.webp
```

Theme packages contain only a manifest and a local image. Scripts, CSS, remote resources, and encrypted files are not supported. See the [Theme Package v1 specification](./docs/theme-package-v1.md) for all fields, image requirements, and packaging instructions.

## How It Works

Codex NN connects to a locally running Codex page through the Chrome DevTools Protocol (CDP), listening only on `127.0.0.1`. It applies the selected theme and keeps the theme state active in the background.

- Does not modify the official Codex installation directory
- Does not replace official binaries
- Does not invalidate the application code signature
- Connects only to validated loopback ports owned by the current Codex process
- Can restore the official launch behavior and appearance at any time

## Security

During a managed theme session, Codex exposes a debugging port restricted to the local machine. Codex NN validates port ownership and rejects non-loopback connections, but you should still avoid running untrusted local software during a theme session.

Codex updates may change the interface and temporarily affect theme compatibility. If that happens, run Diagnostics or use **Restore Completely** to return to the official appearance.

## Contributing

Issues and pull requests are welcome, including bug reports, compatibility feedback, and improvements to Codex NN.

## License

Codex NN is open source under the [MIT License](./LICENSE).

## Credits and Disclaimer

Parts of the theme engine are adapted from Codex Dream Skin Studio. See [Third-Party Notices](./THIRD_PARTY_NOTICES.md) and the [corresponding license text](./THIRD_PARTY_LICENSE_CODEX_DREAM_SKIN.txt).

Codex, OpenAI, and related names and marks belong to their respective owners. This project is not affiliated with or endorsed by OpenAI.

---

<p align="center">
  If Codex NN makes your workspace more delightful, consider leaving a Star ⭐
</p>
