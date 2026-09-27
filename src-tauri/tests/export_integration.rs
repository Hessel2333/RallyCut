use rallycut_lib::{engine, media, model::*};
use std::{
    path::Path,
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
#[test]
#[ignore = "Requires native FFmpeg with libx264 and ffprobe"]
fn relocated_retry_and_post_commit_recovery_preserve_content() {
    use rallycut_lib::{artifacts, store::Store};
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    ff(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30000/1001:duration=2",
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
        &dir.path().join("final.mp4"),
        100_000,
        1_100_000,
    );
    // This relocation requires a historical full identity, not the sampled
    // reference fixture used by the unrelated playback/encoding tests.
    j.assets[0].sha256 = media::hash_file(&source, &AtomicBool::new(false), |_| {}).unwrap();
    j.assets[0].verification = "verified-copy".into();
    let original = serde_json::to_value(&j).unwrap();
    let db_path = dir.path().join("isolated.sqlite3");
    let db = Store::open(&db_path).unwrap();
    db.put("asset", &j.assets[0].id, &j.assets[0]).unwrap();
    db.put("job", &j.id, &j).unwrap();
    let moved = dir.path().join("moved.mp4");
    std::fs::rename(&source, &moved).unwrap();
    let cancel = AtomicBool::new(false);
    assert!(engine::export(
        &mut j,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &[],
        &cancel,
        |_| {}
    )
    .is_err());
    let mut relocated = j.assets[0].clone();
    relocated.path = moved.to_string_lossy().into();
    media::verify_identity(&moved, &relocated.sha256).unwrap();
    db.put("asset", &relocated.id, &relocated).unwrap();
    let mut runtime = engine::resolve_locations(&j, &db.list("asset").unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(&runtime.segment).unwrap(),
        original["segment"]
    );
    assert_eq!(
        serde_json::to_value(&runtime.preset).unwrap(),
        original["preset"]
    );
    engine::export(
        &mut runtime,
        &tool("ffmpeg"),
        &tool("ffprobe"),
        &[],
        &cancel,
        |_| {},
    )
    .unwrap();
    let final_hash = media::hash_file(Path::new(&j.output), &cancel, |_| {}).unwrap();
    // Crash after filesystem commit, before final SQLite transaction.
    j.status = "validating".into();
    db.put("job", &j.id, &j).unwrap();
    drop(db);
    let db = Store::open(&db_path).unwrap();
    let mut recovered: Job = db.get("job", &j.id).unwrap();
    assert_eq!(recovered.status, "interrupted");
    let artifact = artifacts::recover(&recovered, &cancel).unwrap();
    assert_eq!(artifact.file_sha256, final_hash);
    assert_ne!(artifact.file_sha256, artifact.content_fingerprint);
    recovered.status = "completed".into();
    db.finish_job(&recovered, Some(&artifact)).unwrap();
    db.put("publication", "evidence", &serde_json::json!({"id":"evidence","draft_id":"d","account_id":"test","payload":{},"status":"submitted","aid":1,"bvid":null,"error":"","created_ms":0,"checked_ms":null,"platform_status":""})).unwrap();
    db.delete_jobs(&[j.id.clone()]).unwrap();
    assert_eq!(
        db.get::<artifacts::ExportArtifact>("artifact", &j.id)
            .unwrap()
            .file_sha256,
        final_hash
    );
    assert!(db
        .get::<serde_json::Value>("publication", "evidence")
        .is_ok());
    assert_eq!(
        media::hash_file(Path::new(&j.output), &cancel, |_| {}).unwrap(),
        final_hash
    );
    std::fs::write(&j.output, b"changed").unwrap();
    assert!(artifacts::recover(&recovered, &cancel).is_err());
}
fn ff(args: &[&str]) {
    // Declare color on generated frames as well as the encoder output. Newer
    // FFmpeg versions propagate frame color properties over output options.
    let args: Vec<String> = args
        .iter()
        .map(|arg| {
            if arg.starts_with("testsrc2=") {
                format!("{arg},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709")
            } else {
                (*arg).to_string()
            }
        })
        .collect();
    let o = media::command(&tool("ffmpeg"))
        .args(["-hide_banner", "-v", "error", "-y"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}
fn asset(path: &Path) -> Asset {
    let metadata = media::probe(&tool("ffprobe"), path).unwrap();
    let stream = media::video(&metadata).unwrap();
    assert_eq!(
        stream["color_transfer"], "bt709",
        "synthetic fixture transfer"
    );
    assert_eq!(
        stream["color_primaries"], "bt709",
        "synthetic fixture primaries"
    );
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
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let dir = root.join("cross-file");
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

#[test]
#[ignore = "Requires native FFmpeg with libx264 and ffprobe"]
fn cover_frame_persists_independently_and_never_overwrites() {
    use rallycut_lib::{
        covers::{capture, image_data, CoverCandidate},
        store::Store,
    };
    let d = tempfile::tempdir().unwrap();
    let source = d.path().join("video.mp4");
    ff(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=2",
        "-c:v",
        "libx264",
        source.to_str().unwrap(),
    ]);
    let before = std::fs::read(&source).unwrap();
    let cover = d.path().join("frame.jpg");
    let cancel = AtomicBool::new(false);
    capture(
        &tool("ffmpeg"),
        source.to_str().unwrap(),
        1_000_000,
        &cover,
        &cancel,
    )
    .unwrap();
    assert!(image_data(&cover)
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    let probe = media::probe(&tool("ffprobe"), &cover).unwrap();
    assert!(probe.to_string().contains("1280"));
    let bytes = std::fs::read(&cover).unwrap();
    assert!(capture(
        &tool("ffmpeg"),
        source.to_str().unwrap(),
        0,
        &cover,
        &cancel
    )
    .is_err());
    assert_eq!(std::fs::read(&cover).unwrap(), bytes);
    assert_eq!(std::fs::read(&source).unwrap(), before);
    let dbpath = d.path().join("isolated.sqlite3");
    let candidate = CoverCandidate {
        id: "c".into(),
        session_id: "s".into(),
        asset_id: "a".into(),
        name: "frame".into(),
        time_us: 1_000_000,
        path: cover.to_string_lossy().into(),
    };
    {
        let db = Store::open(&dbpath).unwrap();
        db.put("cover_candidate", "c", &candidate).unwrap();
    }
    let db = Store::open(&dbpath).unwrap();
    let restored: CoverCandidate = db.get("cover_candidate", "c").unwrap();
    assert_eq!(restored.time_us, 1_000_000);
    assert_eq!(
        image_data(Path::new(&restored.path)).unwrap(),
        image_data(&cover).unwrap()
    );
}
