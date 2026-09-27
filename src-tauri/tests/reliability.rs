use rallycut_lib::{engine, media, model::*, store::Store};
use std::sync::atomic::AtomicBool;

#[test]
fn retry_resolves_relocated_asset_without_changing_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let db = Store::open(&dir.path().join("isolated.sqlite3")).unwrap();
    let old = dir.path().join("source.mp4");
    let new = dir.path().join("moved.mp4");
    std::fs::write(&old, b"original bytes").unwrap();
    let digest = media::hash_file(&old, &AtomicBool::new(false), |_| {}).unwrap();
    let asset: Asset = serde_json::from_value(serde_json::json!({"id":"a","path":old,"original_path":old,"name":"source","size":14,"sha256":digest,"verification":"verified-copy","duration_us":100,"metadata":{},"available":true})).unwrap();
    let job: Job = serde_json::from_value(serde_json::json!({"id":"j","session_id":"s","segment":{"id":"m","name":"old name","ranges":[{"asset_id":"a","start_us":10,"end_us":50}],"note":""},"assets":[asset],"preset":Preset::default(),"output":dir.path().join("out.mp4"),"status":"interrupted","progress":0,"speed":"","error":"","fingerprint":"content","validation":""})).unwrap();
    db.put("job", "j", &job).unwrap();
    std::fs::rename(&old, &new).unwrap();
    let mut relocated = asset.clone();
    relocated.path = new.to_string_lossy().into();
    db.put("asset", "a", &relocated).unwrap();
    let resolved =
        engine::resolve_locations(&db.get("job", "j").unwrap(), &db.list("asset").unwrap())
            .unwrap();
    assert_eq!(resolved.assets[0].path, relocated.path);
    assert_eq!(
        serde_json::to_value(&resolved.segment).unwrap(),
        serde_json::to_value(&job.segment).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&resolved.preset).unwrap(),
        serde_json::to_value(&job.preset).unwrap()
    );
    assert_eq!(resolved.fingerprint, job.fingerprint);
    assert_eq!(
        db.get::<Job>("job", "j").unwrap().assets[0].path,
        asset.path
    );
    let mut legacy = job.clone();
    legacy.assets[0].sha256 = "sample-v1-partial".into();
    legacy.assets[0].verification = "sampled-reference".into();
    let mut uncertain = relocated.clone();
    uncertain.sha256 = legacy.assets[0].sha256.clone();
    uncertain.verification = "sampled-reference".into();
    assert!(
        engine::resolve_locations(&legacy, &[uncertain]).is_err(),
        "a matching partial sample cannot establish relocated historical content"
    );
    relocated.sha256 = "different".into();
    assert!(engine::resolve_locations(&job, &[relocated]).is_err());
    assert!(engine::resolve_locations(&job, &[]).is_err());
}
