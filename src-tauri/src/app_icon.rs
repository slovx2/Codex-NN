use std::io::Cursor;

use image::{DynamicImage, ImageFormat};
use tauri::{image::Image, AppHandle, Manager};

use crate::{MAIN_WINDOW, TRAY_ID};

const DEFAULT_ACCENT: [u8; 3] = [0xe2, 0x55, 0x6d];
const SOURCE_ICON: &[u8] = include_bytes!("../icons/icon.png");

struct AccentIcon {
    rgba: Vec<u8>,
    png: Vec<u8>,
    width: u32,
    height: u32,
}

pub fn set_accent(app: &AppHandle, value: &str) -> Result<(), String> {
    let accent = parse_color(value).unwrap_or(DEFAULT_ACCENT);
    let icon = build_icon(accent)?;
    let app = app.clone();
    app.clone()
        .run_on_main_thread(move || apply_icon(&app, icon))
        .map_err(|error| format!("无法切换应用图标：{error}"))
}

fn build_icon(accent: [u8; 3]) -> Result<AccentIcon, String> {
    let mut image = image::load_from_memory(SOURCE_ICON)
        .map_err(|error| format!("无法读取内置应用图标：{error}"))?
        .to_rgba8();
    let (width, height) = image.dimensions();
    for pixel in image.pixels_mut() {
        let [red, green, blue, alpha] = pixel.0;
        if alpha == 0
            || (red.min(green).min(blue) > 235
                && red.max(green).max(blue) - red.min(green).min(blue) < 18)
        {
            continue;
        }
        let luminance =
            (u32::from(red) * 2126 + u32::from(green) * 7152 + u32::from(blue) * 722) / 10_000;
        let mapped = shade(accent, luminance as u8);
        pixel.0 = [mapped[0], mapped[1], mapped[2], alpha];
    }

    let rgba = image.as_raw().clone();
    let mut png = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|error| format!("无法生成应用图标：{error}"))?;
    Ok(AccentIcon {
        rgba,
        png: png.into_inner(),
        width,
        height,
    })
}

fn shade(accent: [u8; 3], luminance: u8) -> [u8; 3] {
    const PIVOT: u16 = 128;
    if u16::from(luminance) >= PIVOT {
        let amount = (u16::from(luminance) - PIVOT) * 180 / (255 - PIVOT);
        return accent
            .map(|channel| (u16::from(channel) + (255 - u16::from(channel)) * amount / 255) as u8);
    }
    let amount = (PIVOT - u16::from(luminance)) * 155 / PIVOT;
    accent.map(|channel| (u16::from(channel) * (255 - amount) / 255) as u8)
}

fn parse_color(value: &str) -> Option<[u8; 3]> {
    let value = value.trim();
    if let Some(hex) = value.strip_prefix('#') {
        if hex.len() == 6 {
            return Some([
                u8::from_str_radix(&hex[0..2], 16).ok()?,
                u8::from_str_radix(&hex[2..4], 16).ok()?,
                u8::from_str_radix(&hex[4..6], 16).ok()?,
            ]);
        }
        return None;
    }

    let body = value
        .strip_prefix("rgb(")
        .or_else(|| value.strip_prefix("rgba("))?
        .strip_suffix(')')?;
    let mut channels = if body.contains(',') {
        body.split(',').take(3).collect::<Vec<_>>()
    } else {
        body.split_whitespace()
            .take_while(|value| *value != "/")
            .take(3)
            .collect::<Vec<_>>()
    }
    .into_iter()
    .map(parse_channel);
    Some([channels.next()??, channels.next()??, channels.next()??])
}

fn parse_channel(value: &str) -> Option<u8> {
    let value = value.trim();
    if let Some(percent) = value.strip_suffix('%') {
        let percent = percent.trim().parse::<f32>().ok()?.clamp(0.0, 100.0);
        return Some((percent * 2.55).round() as u8);
    }
    Some(value.parse::<f32>().ok()?.clamp(0.0, 255.0).round() as u8)
}

fn apply_icon(app: &AppHandle, icon: AccentIcon) {
    let image = Image::new_owned(icon.rgba, icon.width, icon.height);
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_icon(image.clone());
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(image));
    }
    set_macos_dock_icon(&icon.png);
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png: &[u8]) {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(png);
    let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };
    let application = NSApplication::sharedApplication(main_thread);
    unsafe { application.setApplicationIconImage(Some(&icon)) };
}

#[cfg(not(target_os = "macos"))]
fn set_macos_dock_icon(_png: &[u8]) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_css_color_formats() {
        assert_eq!(parse_color("#e2556d"), Some([0xe2, 0x55, 0x6d]));
        assert_eq!(parse_color("rgb(12, 34, 56)"), Some([12, 34, 56]));
        assert_eq!(parse_color("rgba(100%, 50%, 0%, .5)"), Some([255, 128, 0]));
        assert_eq!(parse_color("rgb(12 34 56 / 80%)"), Some([12, 34, 56]));
    }

    #[test]
    fn rejects_invalid_colors_and_clamps_channels() {
        assert_eq!(parse_color("transparent"), None);
        assert_eq!(parse_color("#123"), None);
        assert_eq!(parse_color("rgb(nope, 2, 3)"), None);
        assert_eq!(parse_color("rgb(300, -10, 42)"), Some([255, 0, 42]));
    }

    #[test]
    fn shades_the_accent_around_the_source_luminance() {
        let accent = [180, 90, 45];
        assert_eq!(shade(accent, 128), accent);
        let dark = shade(accent, 0);
        let light = shade(accent, 255);
        assert!(dark.iter().zip(accent).all(|(value, base)| *value < base));
        assert!(light.iter().zip(accent).all(|(value, base)| *value > base));
    }

    #[test]
    fn builds_a_complete_png_and_rgba_icon() {
        let icon = build_icon([50, 160, 220]).unwrap();
        assert!(icon.width > 0 && icon.height > 0);
        assert_eq!(
            icon.rgba.len(),
            (icon.width as usize) * (icon.height as usize) * 4
        );
        assert!(icon.png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
