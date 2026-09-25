use rallycut_lib::{engine, media, model::*};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
fn tool(n: &str) -> String {
    Path::new(
        &std::env::var("RALLYCUT_FFMPEG_DIR")
            .expect("Set RALLYCUT_FFMPEG_DIR to run ignored FFmpeg integration tests"),
    )
    .join(if cfg!(windows) {
        format!("{n}.exe")
    } else {
        n.into()
    })
    .to_string_lossy()
    .into()
}
fn ff(args: &[&str]) {
    let o = media::command(&tool("ffmpeg"))
        .args(["-hide_banner", "-v", "error", "-y"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
fn asset(path: &Path) -> Asset {
    let metadata = media::probe(&tool("ffprobe"), path).unwrap();
    Asset {
        id: id(),
        path: path.to_string_lossy().into(),
        original_path: path.to_string_lossy().into(),
        name: path.file_name().unwrap().to_string_lossy().into(),
        size: path.metadata().unwrap().len(),
        sha256: media::reference_signature(path, &AtomicBool::new(false)).unwrap(),
        verification: "sampled-reference".into(),
        duration_us: media::duration(&metadata).unwrap(),
        metadata,
        available: true,
    }
}
#[test]
#[ignore = "requires FFmpeg with libx265"]
fn hevc_export_uses_matching_encoder_and_validates_hvc1() {
    let d = tempfile::tempdir().unwrap();
    let source = d.path().join("source.mp4");
    ff(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=60:duration=2",
        "-c:v",
        "libx264",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        source.to_str().unwrap(),
    ]);
    let mut j = job(
        vec![asset(&source)],
        &d.path().join("hevc.mp4"),
        0,
        1_000_000,
    );
    j.preset.codec = "hevc".into();
    j.preset.encoder = "auto".into();
    assert!(engine::build_args(&j, "libx264", Path::new("wrong.mp4")).is_err());
    let c = AtomicBool::new(false);
    let hw = media::hardware(&tool("ffmpeg"));
    engine::export(&mut j, &tool("ffmpeg"), &tool("ffprobe"), &hw, &c, |_| {}).unwrap();
    let meta = media::probe(&tool("ffprobe"), Path::new(&j.output)).unwrap();
    let v = media::video(&meta).unwrap();
    assert_eq!(v["codec_name"], "hevc");
    assert_eq!(v["codec_tag_string"], "hvc1");
    assert!(!j.speed.contains("h264"));
    j.id = id();
    j.output = d.path().join("cpu.mp4").to_string_lossy().into();
    // H.264 capabilities must not be selected for a HEVC job.
    engine::export(
        &mut j,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &["h264_nvenc".into()],
        &c,
        |_| {},
    )
    .unwrap();
    assert!(j.speed.contains("libx265"));
    #[cfg(windows)]
    {
        j.id = id();
        j.output = d.path().join("fallback.mp4").to_string_lossy().into();
        engine::export(
            &mut j,
            &tool("ffmpeg"),
            &tool("ffprobe"),
            &["hevc_videotoolbox".into()],
            &c,
            |_| {},
        )
        .unwrap();
        assert!(j.error.contains("回退 CPU"));
        let meta = media::probe(&tool("ffprobe"), Path::new(&j.output)).unwrap();
        assert_eq!(media::video(&meta).unwrap()["codec_name"], "hevc");
    }
}
fn job(assets: Vec<Asset>, output: &Path, start: i64, end: i64) -> Job {
    let segment = Match {
        id: id(),
        name: "跨文件测试".into(),
        ranges: map_range(&assets, start, end).unwrap(),
        note: "".into(),
    };
    let preset = Preset {
        width: 320,
        height: 180,
        bitrate_kbps: 1200,
        encoder: "libx264".into(),
        ..Default::default()
    };
    let fingerprint = engine::fingerprint(&segment, &assets, &preset);
    Job {
        id: id(),
        session_id: "integration".into(),
        segment,
        assets,
        preset,
        output: output.to_string_lossy().into(),
        status: "waiting".into(),
        progress: 0.,
        speed: "".into(),
        error: "".into(),
        fingerprint,
        validation: "".into(),
    }
}
fn frame(p: &Path, t: &str) -> Vec<u8> {
    let o = media::command(&tool("ffmpeg"))
        .args(["-v", "error", "-ss", t, "-i"])
        .arg(p)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=160:90,format=gray",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .unwrap();
    assert!(o.status.success());
    o.stdout
}
fn pcm(p: &Path, start: &str, duration: &str) -> Vec<f64> {
    let o = media::command(&tool("ffmpeg"))
        .args(["-v", "error", "-ss", start, "-i"])
        .arg(p)
        .args([
            "-t", duration, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-",
        ])
        .output()
        .unwrap();
    assert!(o.status.success());
    o.stdout
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f64)
        .collect()
}

#[test]
#[ignore = "Requires native FFmpeg and generates synthetic fixtures"]
fn real_cross_file_export() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".test-data");
    std::fs::create_dir_all(&root).unwrap();
    let dir = root.join(format!("run-{}", id()));
    std::fs::create_dir(&dir).unwrap();
    let source = dir.join("连续源.mp4");
    let a = dir.join("A 中文 ' 01.mp4");
    let b = dir.join("B 中文 02.mp4");
    let output = dir.join("比赛12-18.mp4");
    ff(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=60:duration=30",
        "-f",
        "lavfi",
        "-i",
        "aevalsrc=0.15*sin(2*PI*(440*t+80*max(t-15\\,0)^2)):s=48000:d=30",
        "-vf",
        r"drawtext=fontfile='C\:/Windows/Fonts/consola.ttf':text='%{pts\:hms}':x=12:y=12:fontsize=24:fontcolor=white:box=1:boxcolor=black",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "15",
        "-g",
        "60",
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        source.to_str().unwrap(),
    ]);
    for (p, s) in [(&a, "0"), (&b, "15")] {
        ff(&[
            "-ss",
            s,
            "-i",
            source.to_str().unwrap(),
            "-t",
            "15",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            p.to_str().unwrap(),
        ]);
    }
    // Make the adjacent files exact video-duration inputs; the second split may contain AAC preroll.
    let assets = vec![asset(&a), asset(&b)];
    assert_eq!(assets[0].duration_us, 15_000_000);
    assert_eq!(assets[1].duration_us, 15_000_000);
    let mut j = job(assets.clone(), &output, 12_000_000, 18_000_000);
    assert_eq!(j.segment.ranges[1].end_us, 3_000_000);
    let c = AtomicBool::new(false);
    engine::export(&mut j, &tool("ffmpeg"), &tool("ffprobe"), &[], &c, |_| {}).unwrap();
    assert!(
        (media::duration(&media::probe(&tool("ffprobe"), &output).unwrap()).unwrap() - 6_000_000)
            .abs()
            < 40_000
    );
    let mut frame_errors = vec![];
    for (out_t, src_t) in [
        ("0.5", "12.5"),
        ("2.8", "14.8"),
        ("3.2", "15.2"),
        ("5.5", "17.5"),
    ] {
        let expected = frame(&source, src_t);
        let actual = frame(&output, out_t);
        assert_eq!(expected.len(), actual.len());
        let mae = expected
            .iter()
            .zip(&actual)
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .sum::<f64>()
            / actual.len() as f64;
        frame_errors.push(mae);
        assert!(mae < 12., "frame {out_t} MAE {mae}");
    }
    let expected = pcm(&source, "12", "6");
    let actual = pcm(&output, "0", "6");
    let mut correlations = vec![];
    for center in [48000usize, 143000, 192000, 240000] {
        let lo = center - 12000;
        let hi = center + 12000;
        let mut best = -1f64;
        let mut best_lag = 0;
        for lag in -1600i32..=1600 {
            let mut xy = 0.;
            let mut xx = 0.;
            let mut yy = 0.;
            for i in (lo..hi).step_by(8) {
                let k = (i as i32 + lag) as usize;
                if k >= actual.len() || i >= expected.len() {
                    continue;
                }
                let x = expected[i];
                let y = actual[k];
                xy += x * y;
                xx += x * x;
                yy += y * y;
            }
            let corr = xy / (xx * yy).sqrt();
            if corr > best {
                best = corr;
                best_lag = lag;
            }
        }
        assert!(best > 0.85, "audio correlation {best} at {center}");
        correlations.push((center, best, best_lag));
    }
    // Full decode is integration-test-only; application labels its shorter validation as sampling.
    ff(&["-xerror", "-i", output.to_str().unwrap(), "-f", "null", "-"]);
    ff(&[
        "-ss",
        "2.9",
        "-i",
        output.to_str().unwrap(),
        "-frames:v",
        "1",
        dir.join("boundary-before.png").to_str().unwrap(),
    ]);
    ff(&[
        "-ss",
        "3.1",
        "-i",
        output.to_str().unwrap(),
        "-frames:v",
        "1",
        dir.join("boundary-after.png").to_str().unwrap(),
    ]);
    ff(&[
        "-i",
        output.to_str().unwrap(),
        "-vn",
        dir.join("audio-check.wav").to_str().unwrap(),
    ]);
    assert!(
        engine::export(&mut j, &tool("ffmpeg"), &tool("ffprobe"), &[], &c, |_| {}).is_err(),
        "must not overwrite"
    );
    let old = j.fingerprint.clone();
    j.preset.bitrate_kbps += 1;
    assert_ne!(old, engine::fingerprint(&j.segment, &j.assets, &j.preset));
    j.preset.bitrate_kbps -= 1;
    j.segment.ranges[0].start_us += 1;
    assert_ne!(old, engine::fingerprint(&j.segment, &j.assets, &j.preset));
    let silent = dir.join("silent.mp4");
    ff(&[
        "-i",
        b.to_str().unwrap(),
        "-an",
        "-c:v",
        "copy",
        silent.to_str().unwrap(),
    ]);
    let mut mix = job(
        vec![assets[0].clone(), asset(&silent)],
        &dir.join("silent-mix.mp4"),
        12_000_000,
        18_000_000,
    );
    engine::export(&mut mix, &tool("ffmpeg"), &tool("ffprobe"), &[], &c, |_| {}).unwrap();
    let silence = pcm(Path::new(&mix.output), "4", "1");
    assert!(silence.iter().map(|v| v.abs()).sum::<f64>() / (silence.len() as f64) < 2.);
    let mut cancelled = job(assets.clone(), &dir.join("cancelled.mp4"), 0, 30_000_000);
    let result = engine::export(
        &mut cancelled,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &[],
        &c,
        |j| {
            if j.status == "exporting" {
                c.store(true, Ordering::Relaxed)
            }
        },
    );
    assert!(result.is_err());
    assert!(!Path::new(&cancelled.output).exists());
    c.store(false, Ordering::Relaxed);
    let mut unavailable = job(assets.clone(), &dir.join("bad-encoder.mp4"), 0, 1_000_000);
    unavailable.preset.encoder = "nonexistent".into();
    assert!(engine::export(
        &mut unavailable,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &[],
        &c,
        |_| {}
    )
    .is_err());
    let mut hdr = job(assets, &dir.join("hdr.mp4"), 0, 1_000_000);
    hdr.assets[0].metadata["streams"][0]["color_transfer"] = "smpte2084".into();
    assert!(engine::build_args(&hdr, "libx264", Path::new("x.mp4"))
        .unwrap_err()
        .contains("HDR"));
    let report = serde_json::json!({"synthetic":true,"output":output,"frame_mae":frame_errors,"audio_correlations_and_lags":correlations,"validation":"full decode + sampled frame comparison + audio waveform correlation"});
    std::fs::write(
        dir.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    std::fs::write(root.join("latest.txt"), dir.to_string_lossy().as_bytes()).unwrap();
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[test]
#[ignore = "Requires native FFmpeg"]
fn fractional_rate_mixed_parameters_and_proxy() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("fractional.mp4");
    let b = dir.path().join("different.mp4");
    for (path, size, rate) in [(&a, "320x180", "60000/1001"), (&b, "640x360", "60/1")] {
        ff(&[
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={size}:rate={rate}"),
            "-frames:v",
            "120",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-colorspace",
            "bt709",
            path.to_str().unwrap(),
        ]);
    }
    let aa = asset(&a);
    assert_eq!(aa.duration_us, 2_002_000);
    assert_eq!(
        media::video(&aa.metadata).unwrap()["avg_frame_rate"],
        "60000/1001"
    );
    let c = AtomicBool::new(false);
    let mut j = job(
        vec![aa.clone(), asset(&b)],
        &dir.path().join("fraction-output.mp4"),
        1_000_000,
        3_000_000,
    );
    engine::export(&mut j, &tool("ffmpeg"), &tool("ffprobe"), &[], &c, |_| {}).unwrap();
    let output_meta = media::probe(&tool("ffprobe"), Path::new(&j.output)).unwrap();
    assert_eq!(
        media::video(&output_meta).unwrap()["avg_frame_rate"],
        "60000/1001"
    );
    j.id = id();
    j.output = dir.path().join("forced60.mp4").to_string_lossy().into();
    j.preset.force_60 = true;
    engine::export(&mut j, &tool("ffmpeg"), &tool("ffprobe"), &[], &c, |_| {}).unwrap();
    assert_eq!(
        media::video(&media::probe(&tool("ffprobe"), Path::new(&j.output)).unwrap()).unwrap()
            ["avg_frame_rate"],
        "60/1"
    );
    let cache = dir.path().join("cache");
    let proxy = rallycut_lib::preview::generate(
        &aa,
        "proxy",
        &cache,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &c,
        |_, _| {},
    )
    .unwrap();
    assert_eq!(proxy.time_offset_us, 0);
    assert_eq!(proxy.duration_us, aa.duration_us);
    let again = rallycut_lib::preview::generate(
        &aa,
        "proxy",
        &cache,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &c,
        |_, _| panic!("cached proxy should not encode"),
    )
    .unwrap();
    assert_eq!(proxy.path, again.path);
    let thumb = rallycut_lib::preview::generate(
        &aa,
        "thumbnail",
        &cache,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &c,
        |_, _| {},
    )
    .unwrap();
    assert!(Path::new(&thumb.path).is_file());
}
