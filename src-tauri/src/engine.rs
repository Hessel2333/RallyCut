use crate::{media::*, model::*};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

pub fn fingerprint(segment: &Match, assets: &[Asset], preset: &Preset) -> String {
    let content: Vec<_> = segment
        .ranges
        .iter()
        .map(|r| {
            (
                &r.asset_id,
                assets
                    .iter()
                    .find(|a| a.id == r.asset_id)
                    .map(|a| a.sha256.as_str())
                    .unwrap_or(""),
                r.start_us,
                r.end_us,
            )
        })
        .collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(content, preset)).unwrap())
    )
}
pub fn build_args(job: &Job, encoder: &str, partial: &Path) -> Result<Vec<String>> {
    validate_ranges(&job.segment.ranges, &job.assets)?;
    let p = &job.preset;
    if p.width < 2
        || p.height < 2
        || p.width > 7680
        || p.height > 4320
        || p.width % 2 != 0
        || p.height % 2 != 0
        || p.bitrate_kbps < 100
        || p.bitrate_kbps > 100000
        || p.audio_kbps < 32
        || p.audio_kbps > 512
    {
        return Err("导出参数超出支持范围".into());
    }
    if !["libx264", "h264_nvenc", "h264_qsv", "h264_amf"].contains(&encoder) {
        return Err("不支持的编码器".into());
    }
    let first = job
        .assets
        .iter()
        .find(|a| a.id == job.segment.ranges[0].asset_id)
        .ok_or("素材缺失")?;
    let fps = if p.force_60 {
        "60/1"
    } else {
        video(&first.metadata)?["avg_frame_rate"]
            .as_str()
            .ok_or("缺失帧率")?
    };
    rational(fps)?;
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-v", "error", "-n"]
        .map(str::to_string)
        .to_vec();
    let mut filters = vec![];
    let mut concat = String::new();
    for (i, r) in job.segment.ranges.iter().enumerate() {
        let a = job
            .assets
            .iter()
            .find(|a| a.id == r.asset_id)
            .ok_or("素材缺失")?;
        let v = video(&a.metadata)?;
        let tr = v["color_transfer"].as_str().unwrap_or("unknown");
        let prim = v["color_primaries"].as_str().unwrap_or("unknown");
        if ["smpte2084", "arib-std-b67"].contains(&tr) || prim == "bt2020" {
            return Err(format!(
                "{} 为 HDR/广色域素材，首版尚不支持其色彩转换",
                a.name
            ));
        }
        if (tr != "bt709" || prim != "bt709") && !p.acknowledge_sdr {
            return Err(format!(
                "{} 色彩信息不完整。请确认它是普通 SDR（不是 D-Log）后启用 SDR 确认",
                a.name
            ));
        }
        if !Path::new(&a.path).is_file() {
            return Err(format!("素材离线：{}，请重新定位", a.name));
        }
        args.extend([
            "-ss".into(),
            seconds(r.start_us),
            "-i".into(),
            a.path.clone(),
        ]);
        let d = seconds(r.end_us - r.start_us);
        filters.push(format!("[{i}:v:0]trim=duration={d},setpts=PTS-STARTPTS,scale={}:{}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}]",p.width,p.height,p.width,p.height));
        let has_audio = a.metadata["streams"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["codec_type"] == "audio");
        filters.push(if has_audio{format!("[{i}:a:0]atrim=duration={d},aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={d},asetpts=PTS-STARTPTS[a{i}]")}else{format!("anullsrc=r=48000:cl=stereo,atrim=duration={d},asetpts=PTS-STARTPTS[a{i}]")});
        concat.push_str(&format!("[v{i}][a{i}]"));
    }
    filters.push(format!(
        "{concat}concat=n={}:v=1:a=1[v][a]",
        job.segment.ranges.len()
    ));
    args.extend([
        "-filter_complex".into(),
        filters.join(";"),
        "-map".into(),
        "[v]".into(),
        "-map".into(),
        "[a]".into(),
        "-c:v".into(),
        encoder.into(),
        "-b:v".into(),
        format!("{}k", p.bitrate_kbps),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{}k", p.audio_kbps),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        partial.to_string_lossy().into_owned(),
    ]);
    Ok(args)
}
pub fn process(
    ffmpeg: &str,
    args: &[String],
    cancel: &AtomicBool,
    mut progress: impl FnMut(i64, String),
) -> Result<()> {
    let mut child = command(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 FFmpeg：{e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = thread::spawn(move || {
        for l in BufReader::new(stdout).lines() {
            if let Ok(l) = l {
                if tx.send(l).is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    });
    let errors = thread::spawn(move || {
        let mut b = String::new();
        let _ = BufReader::new(stderr)
            .take(512 * 1024)
            .read_to_string(&mut b);
        b
    });
    let mut time = 0;
    let mut speed = String::new();
    let result = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            break Err("已取消".into());
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(l) => {
                if let Some(v) = l.strip_prefix("out_time_us=") {
                    time = v.parse().unwrap_or(time);
                }
                if let Some(v) = l.strip_prefix("speed=") {
                    speed = v.trim().into();
                }
                if l.starts_with("progress=") {
                    progress(time, speed.clone());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = child.wait().map_err(|e| e.to_string());
                break match status {
                    Ok(s) if s.success() => Ok(()),
                    Ok(_) => Err("FFmpeg 处理失败".into()),
                    Err(e) => Err(e),
                };
            }
        }
    };
    let _ = reader.join();
    let log = errors.join().unwrap_or_default();
    result.map_err(|e| {
        if log.is_empty() {
            e
        } else {
            format!("{e}\n{log}")
        }
    })
}
pub fn export(
    job: &mut Job,
    ffmpeg: &str,
    ffprobe: &str,
    hardware: &[String],
    cancel: &AtomicBool,
    mut update: impl FnMut(&Job),
) -> Result<()> {
    let out = std::path::PathBuf::from(&job.output);
    let parent = out.parent().ok_or("输出目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if out.exists() {
        return Err("输出文件已存在；请重新加入队列以生成新名称".into());
    }
    let partial = parent.join(format!(".{}.partial.mp4", job.id));
    if partial.exists() {
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
    }
    let total: i64 = job
        .segment
        .ranges
        .iter()
        .map(|r| r.end_us - r.start_us)
        .sum();
    let encoder = if job.preset.encoder == "auto" {
        hardware.first().map(String::as_str).unwrap_or("libx264")
    } else {
        job.preset.encoder.as_str()
    }
    .to_string();
    let result = (|| {
        job.status = "preparing".into();
        job.progress = 0.0;
        update(job);
        // Local references use bounded samples; copied assets retain full verification.
        for a in &job.assets {
            if cancel.load(Ordering::Relaxed) {
                return Err("已取消".into());
            }
            if identity_signature(Path::new(&a.path), &a.sha256, cancel)? != a.sha256 {
                return Err(format!("素材内容已改变：{}，请重新导入", a.name));
            }
        }
        let args = build_args(job, &encoder, &partial)?;
        job.status = "exporting".into();
        job.speed = format!("编码器：{encoder}");
        update(job);
        let first = process(ffmpeg, &args, cancel, |us, speed| {
            job.progress = (us as f64 / total as f64).clamp(0.0, 0.99);
            job.speed = format!("{encoder} · {speed}");
            update(job);
        });
        if let Err(e) = first {
            if job.preset.encoder == "auto"
                && encoder != "libx264"
                && !cancel.load(Ordering::Relaxed)
            {
                job.error = format!("硬件编码失败，已回退 CPU：{e}");
                let _ = fs::remove_file(&partial);
                let args = build_args(job, "libx264", &partial)?;
                process(ffmpeg, &args, cancel, |us, s| {
                    job.progress = (us as f64 / total as f64).clamp(0.0, 0.99);
                    job.speed = format!("CPU 回退 · {s}");
                    update(job);
                })?;
            } else {
                return Err(e);
            }
        }
        job.status = "validating".into();
        job.progress = 1.0;
        update(job);
        let meta = probe(ffprobe, &partial)?;
        let actual = duration(&meta)?;
        let v = video(&meta)?;
        if (actual - total).abs() > 150_000
            || v["width"].as_u64() != Some(job.preset.width as u64)
            || v["height"].as_u64() != Some(job.preset.height as u64)
            || v["codec_name"] != "h264"
        {
            return Err(format!(
                "输出基本验证失败：预期 {} 微秒，实际 {actual}",
                total
            ));
        }
        let mut points = vec![0, (total - 500_000).max(0)];
        let mut boundary = 0;
        for r in &job.segment.ranges {
            boundary += r.end_us - r.start_us;
            if boundary < total {
                points.push((boundary - 250_000).max(0));
            }
        }
        for at in points {
            let args = [
                "-v",
                "error",
                "-xerror",
                "-ss",
                &seconds(at),
                "-i",
                &partial.to_string_lossy(),
                "-t",
                "0.5",
                "-f",
                "null",
                "-",
            ]
            .map(str::to_string);
            process(ffmpeg, &args, cancel, |_, _| {})?;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        commit_no_replace(&partial, &out)?;
        job.validation = "基本验证 + 首尾及拼接边界抽样解码（非完整解码）".into();
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_encoder() {
        let c = AtomicBool::new(false);
        assert!(process("does-not-exist", &[], &c, |_, _| {}).is_err());
    }
    #[test]
    fn names() {
        assert_eq!(safe_name("第01局:决赛?"), "第01局_决赛_");
    }
}
