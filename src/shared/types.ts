export type QrMode = 'static' | 'dynamic_url' | 'dynamic_payload';

export type ContentType =
  | 'url'
  | 'text'
  | 'email'
  | 'phone'
  | 'sms'
  | 'vcard'
  | 'mecard'
  | 'maps'
  | 'facebook'
  | 'twitter'
  | 'youtube'
  | 'wifi'
  | 'event'
  | 'crypto'
  | 'mp3'
  | 'video'
  | 'pdf'
  | 'social'
  | 'app'
  | 'gallery'
  | 'rating'
  | 'feedback';

export type OutputFormat = 'png' | 'svg' | 'pdf' | 'eps';

export interface DesignConfig {
  body: string;
  eye: string;
  eyeBall: string;
  erf1: string[];
  erf2: string[];
  erf3: string[];
  brf1: string[];
  brf2: string[];
  brf3: string[];
  bodyColor: string;
  bgColor: string;
  eye1Color: string;
  eye2Color: string;
  eye3Color: string;
  eyeBall1Color: string;
  eyeBall2Color: string;
  eyeBall3Color: string;
  gradientColor1: string | null;
  gradientColor2: string | null;
  gradientType: 'linear' | 'radial';
  gradientOnEyes: boolean;
  logo: string | null;
  logoMode: 'default' | 'clean';
}

export interface QrRecord {
  id: string;
  name: string;
  mode: QrMode;
  contentType: ContentType;
  contentPayload: Record<string, unknown>;
  encodedPayload: string;
  yourlsKeyword?: string;
  yourlsShortUrl?: string;
  yourlsLongUrl?: string;
  designConfig: DesignConfig;
  sizePx: number;
  status: 'draft' | 'active' | 'archived' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastRenderedAt?: string;
}

export interface AuditEvent {
  id: string;
  qrCodeId: string;
  actorId: string;
  eventType: string;
  previous: unknown;
  next: unknown;
  createdAt: string;
}

export interface AssetRecord {
  id: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  publicPath: string;
  sha256: string;
  createdAt: string;
}
