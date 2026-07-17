use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, GenericImageView, ImageFormat,
    Rgb, RgbImage,
};
use sha2::{Digest, Sha256};

use crate::{models::ThemeManifest, theme};

pub(super) struct PreparedUpload {
    pub manifest: ThemeManifest,
    pub package: Vec<u8>,
    pub package_sha256: String,
    pub local_content_sha256: String,
    pub card: Vec<u8>,
    pub card_sha256: String,
    pub detail: Vec<u8>,
    pub detail_sha256: String,
}

pub(super) fn prepare_package(path: &Path) -> Result<PreparedUpload, String> {
    let prepared = theme::inspect_package(path)?;
    let package = std::fs::read(path).map_err(|error| format!("无法读取主题包：{error}"))?;
    if package.len() > 20 * 1024 * 1024 {
        return Err("上传主题包不能超过 20 MB".into());
    }
    let source = image::load_from_memory(&prepared.image)
        .map_err(|error| format!("无法解码主题背景：{error}"))?;
    let background = manifest_background(&prepared.manifest);
    let focus = (
        prepared.manifest.art.focus_x.unwrap_or(0.5).clamp(0.0, 1.0),
        prepared.manifest.art.focus_y.unwrap_or(0.5).clamp(0.0, 1.0),
    );
    let card = encode_bounded_preview(
        &source,
        focus,
        background,
        640,
        400,
        &[76, 70, 64],
        512 * 1024,
    )?;
    let detail = encode_bounded_preview(
        &source,
        focus,
        background,
        1280,
        800,
        &[82, 76, 70],
        2 * 1024 * 1024,
    )?;
    Ok(PreparedUpload {
        local_content_sha256: super::sync::content_sha256(&prepared.manifest, &prepared.image)?,
        manifest: prepared.manifest,
        package_sha256: sha256(&package),
        card_sha256: sha256(&card),
        detail_sha256: sha256(&detail),
        package,
        card,
        detail,
    })
}

pub(super) fn sanitize_remote_preview(
    bytes: &[u8],
    width: u32,
    height: u32,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err("远程预览图大小不符合要求".into());
    }
    if image::guess_format(bytes).map_err(|_| "无法识别远程预览图".to_string())?
        != ImageFormat::Jpeg
    {
        return Err("远程预览图格式不正确".into());
    }
    let image = image::load_from_memory_with_format(bytes, ImageFormat::Jpeg)
        .map_err(|error| format!("远程预览图损坏：{error}"))?;
    if image.dimensions() != (width, height) {
        return Err("远程预览图尺寸不正确".into());
    }
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 78)
        .encode_image(&image)
        .map_err(|error| format!("无法整理远程预览图：{error}"))?;
    Ok(output)
}

pub(super) fn data_url(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn encode_bounded_preview(
    source: &DynamicImage,
    focus: (f64, f64),
    background: Rgb<u8>,
    width: u32,
    height: u32,
    qualities: &[u8],
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let cropped = crop_to_ratio(source, focus, width as f64 / height as f64);
    let resized = cropped.resize_exact(width, height, FilterType::Lanczos3);
    let rgba = resized.to_rgba8();
    let mut rgb = RgbImage::from_pixel(width, height, background);
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let inverse = 255 - alpha;
        let base = rgb.get_pixel_mut(x, y);
        for channel in 0..3 {
            base[channel] = ((u16::from(pixel[channel]) * alpha
                + u16::from(background[channel]) * inverse)
                / 255) as u8;
        }
    }
    for quality in qualities {
        let mut output = Vec::new();
        JpegEncoder::new_with_quality(&mut output, *quality)
            .encode_image(&DynamicImage::ImageRgb8(rgb.clone()))
            .map_err(|error| format!("无法生成主题预览：{error}"))?;
        if output.len() <= max_bytes {
            return Ok(output);
        }
    }
    Err("主题预览图压缩后仍然过大".into())
}

fn crop_to_ratio(source: &DynamicImage, focus: (f64, f64), target_ratio: f64) -> DynamicImage {
    let (width, height) = source.dimensions();
    let source_ratio = f64::from(width) / f64::from(height);
    let (crop_width, crop_height) = if source_ratio > target_ratio {
        ((f64::from(height) * target_ratio).round() as u32, height)
    } else {
        (width, (f64::from(width) / target_ratio).round() as u32)
    };
    let center_x = (focus.0 * f64::from(width)).round() as i64;
    let center_y = (focus.1 * f64::from(height)).round() as i64;
    let x = (center_x - i64::from(crop_width) / 2).clamp(0, i64::from(width - crop_width)) as u32;
    let y =
        (center_y - i64::from(crop_height) / 2).clamp(0, i64::from(height - crop_height)) as u32;
    source.crop_imm(x, y, crop_width, crop_height)
}

fn manifest_background(manifest: &ThemeManifest) -> Rgb<u8> {
    let value = manifest.colors.background.as_deref().unwrap_or("#071116");
    if value.len() == 7 && value.starts_with('#') {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&value[1..3], 16),
            u8::from_str_radix(&value[3..5], 16),
            u8::from_str_radix(&value[5..7], 16),
        ) {
            return Rgb([r, g, b]);
        }
    }
    Rgb([0x07, 0x11, 0x16])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> DynamicImage {
        let mut image = image::RgbaImage::new(1600, 1000);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 255) as u8, (y % 255) as u8, 180, 210]);
        }
        DynamicImage::ImageRgba8(image)
    }

    #[test]
    fn crop_uses_focus_and_keeps_exact_ratio() {
        let image = DynamicImage::new_rgba8(2000, 1000);
        let cropped = crop_to_ratio(&image, (0.8, 0.5), 1.6);
        assert_eq!(cropped.dimensions(), (1600, 1000));
    }

    #[test]
    fn preview_encoding_is_deterministic_and_exact_size() {
        let first = encode_bounded_preview(
            &source(),
            (0.5, 0.5),
            Rgb([7, 17, 22]),
            640,
            400,
            &[76, 70, 64],
            512 * 1024,
        )
        .unwrap();
        let second = encode_bounded_preview(
            &source(),
            (0.5, 0.5),
            Rgb([7, 17, 22]),
            640,
            400,
            &[76, 70, 64],
            512 * 1024,
        )
        .unwrap();
        assert_eq!(sha256(&first), sha256(&second));
        assert_eq!(
            image::load_from_memory(&first).unwrap().dimensions(),
            (640, 400)
        );
        assert!(first.len() <= 512 * 1024);
    }

    #[test]
    fn remote_preview_rejects_wrong_format_and_dimensions() {
        let png = {
            let mut bytes = Vec::new();
            image::DynamicImage::new_rgb8(640, 400)
                .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
                .unwrap();
            bytes
        };
        assert!(sanitize_remote_preview(&png, 640, 400, 512 * 1024).is_err());
        let jpeg = encode_bounded_preview(
            &source(),
            (0.5, 0.5),
            Rgb([7, 17, 22]),
            320,
            200,
            &[76],
            512 * 1024,
        )
        .unwrap();
        assert!(sanitize_remote_preview(&jpeg, 640, 400, 512 * 1024).is_err());
    }
}
