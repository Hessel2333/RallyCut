import type { Match, Preset } from "./types";
export type Artifact = {
  id: string;
  session_id?: string;
  match_id?: string;
  content_fingerprint: string;
  segment?: Match;
  preset?: Preset;
  path: string;
  size: number;
  duration_us: number;
  codec: string;
  validation: string;
  file_sha256: string;
  created_ms: number;
  availability: string;
};
export type DraftPart = {
  id: string;
  artifact_id: string | null;
  job_id: string | null;
  name: string;
};
export type PublicationDraft = {
  id: string;
  revision: number;
  account_id: string | null;
  title: string;
  description: string;
  cover_path: string;
  category: number;
  tags: string;
  visibility: string;
  parts: DraftPart[];
  status: string;
  error: string;
};
export type UploadPart = {
  id: string;
  draft_id: string;
  part_id: string;
  artifact_id: string;
  account_id: string;
  file_sha256: string;
  bytes: number;
  total: number;
  status: string;
  remote: { filename: string } | null;
  error: string;
  attempts: number;
};
export type Publication = {
  id: string;
  draft_id: string;
  status: string;
  aid: number | null;
  bvid: string | null;
  error: string;
  checked_ms: number | null;
  platform_status: string;
};
export type PublicationSnapshot = {
  drafts: PublicationDraft[];
  artifacts: Artifact[];
  uploads: UploadPart[];
  publications: Publication[];
  active: boolean;
};
export const publicationStatus: Record<string, string> = {
  draft: "草稿",
  waiting_artifacts: "等待成片",
  ready: "可上传",
  uploading: "上传中",
  uploaded: "文件已上传",
  uploaded_unverified: "远端文件待核对",
  awaiting_confirmation: "待确认提交",
  submitting: "提交中",
  submitted: "已提交",
  processing: "平台处理中",
  published: "已发布",
  returned: "被退回",
  auth_expired: "认证失效",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  unknown: "结果待核实",
};
