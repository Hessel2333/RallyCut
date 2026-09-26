export type Range = { asset_id: string; start_us: number; end_us: number };
export type Asset = {
  id: string;
  original_path: string;
  path: string;
  name: string;
  size: number;
  sha256: string;
  verification: string;
  duration_us: number;
  metadata: { streams: Record<string, any>[]; format: Record<string, any> };
  available: boolean;
};
export type Match = { id: string; name: string; ranges: Range[]; note: string };
export type Session = {
  id: string;
  name: string;
  date: string;
  asset_ids: string[];
  matches: Match[];
};
export type Preset = {
  codec: "h264" | "hevc";
  width: number;
  height: number;
  bitrate_kbps: number;
  audio_kbps: number;
  force_60: boolean;
  encoder: string;
  acknowledge_sdr: boolean;
};
export type Job = {
  id: string;
  session_id: string;
  segment: Match;
  assets: Asset[];
  preset: Preset;
  output: string;
  status: string;
  progress: number;
  speed: string;
  error: string;
  fingerprint: string;
  validation: string;
};
export type Settings = {
  theme?: string;
  ffmpeg: string;
  ffprobe: string;
  library: string;
  output: string;
  folder_template?: string;
};
export type Snapshot = {
  match_numbers: Record<string, number>;
  assets: Asset[];
  sessions: Session[];
  jobs: Job[];
  settings: Settings;
  paused: boolean;
  data_dir: string;
};
export type ExportPreferences = {
  current: Preset;
  presets: { id: string; name: string; preset: Preset }[];
};
export type Tools = {
  ffmpeg: { path: string; version: string; available: boolean };
  ffprobe: { path: string; version: string; available: boolean };
};
