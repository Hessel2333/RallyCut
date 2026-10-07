//! Advisory boundary comparison. A fixed camera can look identical across a recording gap.
use crate::{engine, model::*, AppState};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};
use tauri::Manager;
const WIDTH: usize = 160;
const HEIGHT: usize = 90;

#[derive(Clone, Serialize, Deserialize)]
pub struct BoundaryReview {
    pub status: String,
    pub difference: f64,
    pub tail_image: String,
    pub head_image: String,
}
fn compare(a: &[u8], b: &[u8]) -> Result<(String, f64)> {
    if a.len() != WIDTH * HEIGHT * 3 || b.len() != a.len() {
        return Err("未能读取完整的首尾画面".into());
    }
    let difference = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| (f64::from(x) - f64::from(y)).abs())
        .sum::<f64>()
        / (a.len() as f64 * 255.0);
    let variance = |bytes: &[u8]| {
        let mean = bytes.iter().map(|&v| f64::from(v)).sum::<f64>() / bytes.len() as f64;
        bytes
            .iter()
            .map(|&v| (f64::from(v) - mean).powi(2))
            .sum::<f64>()
            / bytes.len() as f64
    };
    let status = if variance(a) < 50.0 || variance(b) < 50.0 {
        "unknown"
    } else if difference < 0.035 {
        "similar"
    } else if difference > 0.12 {
        "interrupted"
    } else {
        "review"
    };
    Ok((status.into(), difference))
}
fn image(bytes: &[u8]) -> String {
    // A small, uncompressed BMP avoids another decoder/encoder dependency.
    let size = 54 + bytes.len();
    let mut bmp = vec![0u8; 54];
    bmp[..2].copy_from_slice(b"BM");
    bmp[2..6].copy_from_slice(&(size as u32).to_le_bytes());
    bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
    bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
    bmp[18..22].copy_from_slice(&(WIDTH as i32).to_le_bytes());
    bmp[22..26].copy_from_slice(&(-(HEIGHT as i32)).to_le_bytes());
    bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
    bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
    for pixel in bytes.chunks_exact(3) {
        bmp.extend([pixel[2], pixel[1], pixel[0]]);
    }
    format!(
        "data:image/bmp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bmp)
    )
}
fn frame(
    ffmpeg: &str,
    asset: &Asset,
    tail: bool,
    cache: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    let meta = std::fs::metadata(&asset.path).map_err(|_| "素材离线，请重新定位")?;
    let identity = format!(
        "{}:{}:{}:{:?}:{}:{tail}:v2",
        asset.path,
        asset.sha256,
        meta.len(),
        meta.modified(),
        asset.duration_us
    );
    let path = cache.join(format!("{:x}.rgb", Sha256::digest(identity.as_bytes())));
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == WIDTH * HEIGHT * 3 {
            return Ok(bytes);
        }
    }
    let partial = cache.join(format!("{}.rgb", id()));
    // Decode a bounded tail window and reverse only downscaled frames so the
    // comparison uses the last decodable frame, including fractional-rate media.
    let time = if tail {
        -(asset.duration_us as f64 / 1e6).min(1.0)
    } else {
        0.0
    };
    let seek_flag = if tail { "-sseof" } else { "-ss" };
    let filter = if tail {
        "scale=160:90,format=rgb24,reverse"
    } else {
        "scale=160:90,format=rgb24"
    };
    let result = (|| {
        engine::process(
            ffmpeg,
            &[
                "-v",
                "error",
                "-nostdin",
                "-n",
                seek_flag,
                &format!("{time:.6}"),
                "-i",
                &asset.path,
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-vf",
                filter,
                "-f",
                "rawvideo",
                &partial.to_string_lossy(),
            ]
            .map(str::to_string),
            cancel,
            |_, _| {},
        )?;
        let bytes = std::fs::read(&partial).map_err(crate::error)?;
        if bytes.len() != WIDTH * HEIGHT * 3 {
            return Err("首尾取帧失败，请手动检查衔接".into());
        }
        let _ = std::fs::rename(&partial, path);
        Ok(bytes)
    })();
    let _ = std::fs::remove_file(partial);
    result
}
#[tauri::command]
pub async fn analyze_boundary(
    app: tauri::AppHandle,
    session_id: String,
    left_id: String,
    right_id: String,
) -> Result<BoundaryReview> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = app.state::<AppState>();
        let (left, right): (Asset, Asset) = {
            let db = s.db.lock().unwrap();
            let session: Session = db.get("session", &session_id)?;
            if !session
                .asset_ids
                .windows(2)
                .any(|pair| pair[0] == left_id && pair[1] == right_id)
            {
                return Err("请选择同一拍摄记录内相邻的素材".into());
            }
            (db.get("asset", &left_id)?, db.get("asset", &right_id)?)
        };
        let cache = s.data.join("cache").join("boundaries");
        std::fs::create_dir_all(&cache).map_err(crate::error)?;
        let token = id();
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut cancels = s.cancels.lock().unwrap();
            if s.exit_authorized.load(std::sync::atomic::Ordering::SeqCst)
                || s.update_active.load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("应用正在退出或更新".into());
            }
            cancels.insert(token.clone(), cancel.clone());
        }
        let result = (|| {
            let ffmpeg = crate::tools(&s).ffmpeg.path;
            let a = frame(&ffmpeg, &left, true, &cache, &cancel)?;
            let b = frame(&ffmpeg, &right, false, &cache, &cancel)?;
            let (status, difference) = compare(&a, &b)?;
            Ok(BoundaryReview {
                status,
                difference,
                tail_image: image(&a),
                head_image: image(&b),
            })
        })();
        s.cancels.lock().unwrap().remove(&token);
        result
    })
    .await
    .map_err(crate::error)?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn black_frames_are_unknown_and_similar_frames_never_prove_continuity() {
        let black = vec![0; WIDTH * HEIGHT * 3];
        assert_eq!(compare(&black, &black).unwrap().0, "unknown");
        let a: Vec<_> = (0..black.len()).map(|i| (i % 256) as u8).collect();
        let b: Vec<_> = a.iter().map(|v| 255 - v).collect();
        assert_eq!(compare(&a, &a).unwrap().0, "similar");
        assert_eq!(compare(&a, &b).unwrap().0, "interrupted");
        assert!(compare(&[], &[]).is_err());
        assert!(image(&a).starts_with("data:image/bmp;base64,Qk"));
    }
}

#[cfg(test)]
mod media_tests {
    use super::*;
    #[test]
    #[ignore = "requires native FFmpeg; run with RALLYCUT_FFMPEG_DIR"]
    fn real_boundary_proxy_and_share_export() {
        let tools = std::env::var("RALLYCUT_FFMPEG_DIR").expect("FFmpeg directory");
        let ffmpeg = Path::new(&tools)
            .join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            })
            .to_string_lossy()
            .into_owned();
        let ffprobe = Path::new(&tools)
            .join(if cfg!(windows) {
                "ffprobe.exe"
            } else {
                "ffprobe"
            })
            .to_string_lossy()
            .into_owned();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.mp4");
        let cancel = AtomicBool::new(false);
        engine::process(
            &ffmpeg,
            &[
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=60000/1001:duration=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-colorspace",
                "bt709",
                &path.to_string_lossy(),
            ]
            .map(str::to_string),
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let metadata = crate::media::probe(&ffprobe, &path).unwrap();
        let asset = Asset {
            id: "test".into(),
            original_path: path.to_string_lossy().into(),
            path: path.to_string_lossy().into(),
            name: "source.mp4".into(),
            size: std::fs::metadata(&path).unwrap().len(),
            sha256: crate::media::reference_signature(&path, &cancel).unwrap(),
            verification: "sampled-reference".into(),
            duration_us: crate::media::duration(&metadata).unwrap(),
            metadata,
            available: true,
        };
        let tail = frame(&ffmpeg, &asset, true, dir.path(), &cancel).unwrap();
        let head = frame(&ffmpeg, &asset, false, dir.path(), &cancel).unwrap();
        assert_eq!(tail.len(), WIDTH * HEIGHT * 3);
        assert!(compare(&head, &tail).is_ok());
        assert_eq!(
            frame(&ffmpeg, &asset, true, dir.path(), &cancel).unwrap(),
            tail
        );
        let proxy = crate::preview::generate(
            &asset,
            "proxy",
            dir.path(),
            &ffmpeg,
            &ffprobe,
            &cancel,
            |_, _| {},
        )
        .unwrap();
        let proxy_meta = crate::media::probe(&ffprobe, Path::new(&proxy.path)).unwrap();
        assert!(
            (crate::media::duration(&proxy_meta).unwrap() - asset.duration_us).abs() <= 100_000
        );
        let frames = crate::media::command(&ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_frames",
                "-show_entries",
                "frame=key_frame,pict_type",
                "-of",
                "json",
                &proxy.path,
            ])
            .output()
            .unwrap();
        let frames: serde_json::Value = serde_json::from_slice(&frames.stdout).unwrap();
        let mut distance = 0;
        for f in frames["frames"].as_array().unwrap() {
            if f["key_frame"] == 1 {
                distance = 0;
            } else {
                distance += 1;
            }
            assert!(distance < 12);
            assert_ne!(f["pict_type"], "B");
        }
        let segment = Match {
            id: "clip-test".into(),
            name: "精彩片段".into(),
            note: "".into(),
            chapters: vec![],
            ranges: vec![Range {
                asset_id: asset.id.clone(),
                start_us: 200_000,
                end_us: 1_200_000,
            }],
        };
        let preset = Preset {
            codec: "h264".into(),
            width: 1920,
            height: 1080,
            bitrate_kbps: 6000,
            audio_kbps: 128,
            force_60: true,
            encoder: "libx264".into(),
            acknowledge_sdr: true,
        };
        let mut job = Job {
            id: "test-share".into(),
            session_id: "test".into(),
            fingerprint: engine::fingerprint(&segment, &[asset.clone()], &preset),
            segment,
            assets: vec![asset],
            preset,
            output: dir.path().join("share.mp4").to_string_lossy().into(),
            status: "waiting".into(),
            progress: 0.0,
            speed: "".into(),
            error: "".into(),
            validation: "".into(),
        };
        engine::export(&mut job, &ffmpeg, &ffprobe, &[], &cancel, |_| {}).unwrap();
        let meta = crate::media::probe(&ffprobe, Path::new(&job.output)).unwrap();
        let video = crate::media::video(&meta).unwrap();
        assert_eq!(video["codec_name"], "h264");
        assert_eq!(video["width"], 1920);
        assert_eq!(video["height"], 1080);
        assert_eq!(video["avg_frame_rate"], "60/1");
        assert!((crate::media::duration(&meta).unwrap() - 1_000_000).abs() <= 100_000);
    }
}
