//! Importación de ráster de fondo. Los comandos reciben bytes o UUID, nunca rutas.

use std::io::Cursor;
use std::sync::Arc;

use image::{
    codecs::webp::WebPEncoder, ColorType, DynamicImage, ExtendedColorType, ImageDecoder, ImageError,
    ImageFormat, ImageReader, Limits,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    State,
};
use tokio::sync::Semaphore;

use crate::{agents::Studio, db::background_image_id};

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;
const MAX_PIXELS: u64 = 12_000_000;
const DISPLAY_SIDE: u32 = 2048;
const THUMBNAIL_SIDE: u32 = 192;
const SIZE_ERROR: &str = "La imagen supera el límite de 8 MB.";
const DIMENSIONS_ERROR: &str = "La imagen supera el límite de 4096 px por lado o 12 megapíxeles.";
const FORMAT_ERROR: &str = "Selecciona un archivo PNG, JPEG o WebP válido.";
static IMPORTING: Semaphore = Semaphore::const_new(1);

#[derive(Debug)]
struct ManagedImage {
    data: Vec<u8>,
    thumbnail: Vec<u8>,
}

fn decode_error(error: ImageError) -> String {
    match error {
        ImageError::Limits(_) => DIMENSIONS_ERROR.into(),
        _ => FORMAT_ERROR.into(),
    }
}

fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Err(FORMAT_ERROR.into());
    }
    if width > MAX_SIDE || height > MAX_SIDE || u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(DIMENSIONS_ERROR.into());
    }
    Ok(())
}

fn encode_webp(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let encoder = WebPEncoder::new_lossless(&mut bytes);
    let (width, height) = (image.width(), image.height());
    let result = match image.color() {
        ColorType::Rgb8 => encoder.encode(image.as_bytes(), width, height, ExtendedColorType::Rgb8),
        ColorType::Rgba8 => encoder.encode(image.as_bytes(), width, height, ExtendedColorType::Rgba8),
        color if color.has_alpha() => encoder.encode(
            image.to_rgba8().as_raw(), width, height, ExtendedColorType::Rgba8,
        ),
        _ => encoder.encode(
            image.to_rgb8().as_raw(), width, height, ExtendedColorType::Rgb8,
        ),
    };
    result.map_err(|_| "No se pudo crear la copia de la imagen de fondo.".to_owned())?;
    Ok(bytes)
}

fn managed_image(data: &[u8]) -> Result<ManagedImage, String> {
    if data.len() > MAX_BYTES {
        return Err(SIZE_ERROR.into());
    }
    let format = image::guess_format(data).map_err(|_| FORMAT_ERROR)?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP) {
        return Err(FORMAT_ERROR.into());
    }

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    check_dimensions(width, height)?;
    limits.reserve(decoder.total_bytes()).map_err(decode_error)?;
    decoder.set_limits(limits).map_err(decode_error)?;
    let orientation = decoder.orientation().map_err(decode_error)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    if width.max(height) > DISPLAY_SIDE {
        image = image.thumbnail(DISPLAY_SIDE, DISPLAY_SIDE);
    }
    image.apply_orientation(orientation);
    // Guardamos un único fotograma, sin metadatos ni datos extra del archivo de origen.
    let mut data = encode_webp(&image)?;
    if data.len() > MAX_BYTES {
        image = image.thumbnail(1280, 1280);
        data = encode_webp(&image)?;
    }
    if data.len() > MAX_BYTES {
        return Err("La copia de la imagen de fondo supera los 8 MB.".into());
    }
    let thumbnail = if image.width().max(image.height()) > THUMBNAIL_SIDE {
        encode_webp(&image.thumbnail(THUMBNAIL_SIDE, THUMBNAIL_SIDE))?
    } else {
        data.clone()
    };
    Ok(ManagedImage { data, thumbnail })
}

#[tauri::command]
pub async fn background_image_import(
    studio: State<'_, Arc<Studio>>,
    request: Request<'_>,
) -> Result<String, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err(FORMAT_ERROR.into());
    };
    if data.len() > MAX_BYTES {
        return Err(SIZE_ERROR.into());
    }
    let permit = IMPORTING
        .try_acquire()
        .map_err(|_| "Hay una imagen de fondo importándose. Vuelve a intentarlo en unos segundos.")?;
    let data = data.clone();
    let db = studio.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let image = managed_image(&data)?;
        db.add_background_image(&image.data, &image.thumbnail).map(|id| id.to_string()).map_err(|err| err.to_string())
    })
    .await
    .map_err(|_| "No se pudo importar la imagen de fondo.")?
}

#[tauri::command]
pub async fn background_image_read(studio: State<'_, Arc<Studio>>, id: String, thumbnail: Option<bool>) -> Result<Response, String> {
    let id = background_image_id(&id).map_err(|err| err.to_string())?;
    let db = studio.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.read_background_image(id, thumbnail.unwrap_or(false)).map(Response::new).map_err(|err| err.to_string())
    })
    .await
    .map_err(|_| "No se pudo abrir la imagen de fondo.")?
}

#[tauri::command]
pub async fn background_images_release(studio: State<'_, Arc<Studio>>, ids: Vec<String>) -> Result<(), String> {
    let ids = ids
        .iter()
        .map(|id| background_image_id(id))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let db = studio.db.clone();
    tauri::async_runtime::spawn_blocking(move || db.release_background_images(&ids).map_err(|err| err.to_string()))
        .await
        .map_err(|_| "No se pudieron retirar las imágenes de fondo.")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn fixture(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let picture = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, image::Rgb([40, 120, 214])));
        let mut data = Cursor::new(Vec::new());
        picture.write_to(&mut data, format).unwrap();
        data.into_inner()
    }

    #[test]
    fn supported_formats_become_static_webp_and_large_images_resize() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let image = managed_image(&fixture(format, 2304, 32)).unwrap();
            assert_eq!(image::guess_format(&image.data).unwrap(), ImageFormat::WebP);
            assert_eq!(ImageReader::with_format(Cursor::new(image.data), ImageFormat::WebP).into_dimensions().unwrap(), (2048, 28));
            assert_eq!(ImageReader::with_format(Cursor::new(image.thumbnail), ImageFormat::WebP).into_dimensions().unwrap(), (192, 3));
        }
    }

    #[test]
    fn invalid_formats_headers_and_dimensions_fail() {
        assert_eq!(managed_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap_err(), FORMAT_ERROR);
        assert_eq!(managed_image(b"<html><img src='image.png'></html>").unwrap_err(), FORMAT_ERROR);
        let mut damaged = fixture(ImageFormat::Png, 10, 10);
        damaged.truncate(12);
        assert_eq!(managed_image(&damaged).unwrap_err(), FORMAT_ERROR);
        assert_eq!(managed_image(&vec![0; MAX_BYTES + 1]).unwrap_err(), SIZE_ERROR);
        assert_eq!(managed_image(&fixture(ImageFormat::Png, MAX_SIDE + 1, 3)).unwrap_err(), DIMENSIONS_ERROR);
        assert_eq!(check_dimensions(4000, 3100).unwrap_err(), DIMENSIONS_ERROR);
    }
}
