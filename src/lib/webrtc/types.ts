/** A Chrome webrtc-internals dump, normalised for analysis. */
export interface Dump {
  userAgent: string | null;
  browser: { name: string; version: number | null; os: string | null };
  getUserMedia: GetUserMediaEntry[];
  connections: PeerConnection[];
}

export interface GetUserMediaEntry {
  t: number | null;
  origin: string | null;
  audio: string | null;
  video: string | null;
  error: string | null;
  errorMessage: string | null;
  audioTrackInfo: string | null;
}

export interface PeerConnection {
  key: string;
  url: string | null;
  /** Sprinklr Voice Debug Console identifiers, when the URL carries them. */
  sprinklr: { host: string; caseNumber: string | null; conversationId: string | null; participantId: string | null } | null;
  rtcConfiguration: string | null;
  events: LogEvent[];
  stats: Map<string, StatSeries>;
}

export interface LogEvent {
  /** Epoch ms. */
  t: number;
  type: string;
  value: string;
}

export interface StatSeries {
  id: string;
  type: string;
  /** Epoch ms for each sample. */
  t: number[];
  /** Each field's values, aligned to `t` (missing early samples are null). */
  fields: Record<string, unknown[]>;
}
