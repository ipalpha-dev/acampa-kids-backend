/**
 * IPAlpha core (auth-api, persons-api, projects-api, notifications-api). IPAlpha
 * owns identity and roles (CONTRACTS_ACAMPA §10–§15): without every REQUIRED
 * variable nobody can sign in (the login answers IPALPHA_UNAVAILABLE) — the
 * rest of the API still boots.
 */
export const IPALPHA_REQUIRED_ENV = [
  "IPALPHA_AUTH_API_URL",
  "IPALPHA_AUTH_ORIGIN",
  "IPALPHA_PERSONS_API_URL",
  "IPALPHA_PROJECTS_API_URL",
  "IPALPHA_NOTIFICATIONS_API_URL",
  "IPALPHA_TOKEN_ISSUER",
  "IPALPHA_CLIENT_ID",
  "IPALPHA_ENTRY_POINT",
  "IPALPHA_CLIENT_SECRET",
  "IPALPHA_REDIRECT_URI",
  "IPALPHA_SYSTEM_CLIENT_ID",
  "IPALPHA_SYSTEM_CLIENT_SECRET",
  "IPALPHA_PROJECT_ID",
  "SESSION_TOKEN_KEY",
] as const;

export interface IpalphaConfig {
  /** true only when every IPALPHA_REQUIRED_ENV variable is set */
  enabled: boolean;
  /** names (never values) of the required variables that are missing */
  missing: string[];
  authApiUrl: string;
  authOrigin: string;
  personsApiUrl: string;
  projectsApiUrl: string;
  notificationsApiUrl: string;
  tokenIssuer: string;
  clientId: string;
  entryPoint: string;
  clientSecret: string;
  redirectUri: string;
  systemClientId: string;
  systemClientSecret: string;
  /** the long-lived, yearly Acampa project in projects-api */
  projectId: string;
  /** 32-byte AES-256-GCM key (base64 or hex) that encrypts the per-role core tokens kept in the session */
  sessionTokenKey: string;
}

const trimSlash = (v: string) => v.replace(/\/+$/, "");

export function readIpalphaConfig(env: Record<string, string | undefined>): IpalphaConfig {
  const get = (name: string) => (env[name] ?? "").trim();
  const missing = IPALPHA_REQUIRED_ENV.filter((name) => !get(name));
  return {
    enabled: missing.length === 0,
    missing,
    authApiUrl: trimSlash(get("IPALPHA_AUTH_API_URL")),
    authOrigin: trimSlash(get("IPALPHA_AUTH_ORIGIN")),
    personsApiUrl: trimSlash(get("IPALPHA_PERSONS_API_URL")),
    projectsApiUrl: trimSlash(get("IPALPHA_PROJECTS_API_URL")),
    notificationsApiUrl: trimSlash(get("IPALPHA_NOTIFICATIONS_API_URL")),
    tokenIssuer: get("IPALPHA_TOKEN_ISSUER"),
    clientId: get("IPALPHA_CLIENT_ID"),
    entryPoint: get("IPALPHA_ENTRY_POINT"),
    clientSecret: get("IPALPHA_CLIENT_SECRET"),
    redirectUri: get("IPALPHA_REDIRECT_URI"),
    systemClientId: get("IPALPHA_SYSTEM_CLIENT_ID"),
    systemClientSecret: get("IPALPHA_SYSTEM_CLIENT_SECRET"),
    projectId: get("IPALPHA_PROJECT_ID"),
    sessionTokenKey: get("SESSION_TOKEN_KEY"),
  };
}

/** `SUPER_ADMIN_PERSON_IDS` (comma list of IPAlpha person ids) — deployment owners, always coordenação. */
export function readSuperAdminPersonIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

const aiBaseUrl = (process.env.AI_BASE_URL ?? "https://ai-models.kevyn.com.br/v1").replace(/\/$/, "");
const aiApiKey = process.env.AI_API_KEY ?? "";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  mongoUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017",
  dbName: process.env.MONGODB_DB ?? "camping",

  /**
   * Where uploaded images live on disk (editor pictures + the photo album).
   * Point it at a mounted volume in production — Mongo keeps only the
   * metadata (name, type, size, uploader), the bytes are plain files named
   * by their unguessable id.
   */
  filesDir: process.env.FILES_DIR ?? "data/files",

  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  /** fallback session length; with IPAlpha on, auth-api's `sessionIdleHours` (entry point config) wins */
  sessionHours: Number(process.env.SESSION_HOURS ?? 96),

  /**
   * Reverse proxies in front of the API that append to X-Forwarded-For
   * (Traefik ingress = 1). The client IP is the entry that many hops from the
   * right — what our own ingress appended; entries further left are
   * client-supplied and never trusted. 0 = ignore the header, use the socket.
   */
  trustProxyHops: Math.max(0, Math.floor(Number(process.env.TRUST_PROXY_HOPS ?? 1)) || 0),

  /** IPAlpha login (see readIpalphaConfig) */
  ipalpha: readIpalphaConfig(process.env),

  otp: {
    length: 6,
    expireMinutes: Number(process.env.OTP_EXPIRE_MINUTES ?? 5),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 3),
    freezeMinutes: Number(process.env.ACCOUNT_FREEZE_MINUTES ?? 30),
    resendCooldownSeconds: Number(process.env.RESEND_COOLDOWN_SECONDS ?? 60),
  },

  /** public URL of the app, appended to notification SMS (empty = no link) */
  appUrl: process.env.APP_URL ?? "",

  /**
   * Origin used as a prefix for images in notification emails (`/icons/…`,
   * `/church-logo.png`, `/api/files/…`). Must be reachable by mail clients
   * (not localhost). `PUBLIC_ORIGIN`, else `BACKEND_PUBLIC_URL`, else `APP_URL`.
   * Empty = mail send is refused so the missing env is obvious.
   */
  publicOrigin: (process.env.PUBLIC_ORIGIN || process.env.BACKEND_PUBLIC_URL || process.env.APP_URL || "").replace(/\/$/, ""),

  mail: {
    /** SendGrid HTTP API. Empty key = mock (emails printed in the console). */
    apiKey: process.env.SENDGRID_API_KEY ?? "",
    from: process.env.MAIL_FROM ?? "",
    fromName: process.env.MAIL_FROM_NAME ?? "Acampa Kids",
  },

  comtele: {
    baseUrl: "https://sms.comtele.com.br/api/v2",
    apiKey: process.env.COMTELE_API_KEY ?? "",
    prefix: process.env.COMTELE_PREFIX ?? "AcampaKids",
  },

  /** Private InsightFace service used to index and search gallery faces. */
  face: {
    serviceUrl: (process.env.FACE_SERVICE_URL ?? "").replace(/\/$/, ""),
    /** Cosine similarity. Prefer recall: parents should find their kid even if a few other children come along. */
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD ?? 0.22),
    /** Weak detections still count — group shots and hats are the usual camp photo. */
    minDetectionScore: Number(process.env.FACE_MIN_DETECTION_SCORE ?? 0.4),
  },

  /** Spreadsheet import worker notifications. Values are normalized Brazilian E.164 numbers. */
  imports: {
    adminPhone: process.env.IMPORT_ADMIN_PHONE ?? "",
    superAdminPhone: process.env.IMPORT_SUPER_ADMIN_PHONE ?? "+5561985891092",
  },

  /**
   * Background import worker → API callback. The worker POSTs per-record
   * review results so the API can push a websocket event; the shared secret
   * authenticates it (empty = the endpoint refuses everything).
   */
  worker: {
    secret: process.env.WORKER_SECRET ?? "",
  },

  /** Account that is guaranteed the top-level admin role on every boot. */
  superAdminPhone: process.env.SUPER_ADMIN_PHONE ?? "",

  /** OpenAI-compatible gateway for the editor's AI helper (empty key = feature hidden) */
  ai: {
    baseUrl: aiBaseUrl,
    apiKey: aiApiKey,
    /** OpenRouter Decisions API used by Jev for emoji suggestions and import column mapping. */
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    /**
     * Two-way voice conversation with the assistant (GPT-Live, POST /v1/live/sessions).
     * GPT-Live owns the microphone and the speaker; it delegates every question to
     * the Responses model below, which is the one that calls the MongoDB tools.
     * Empty key = the assistant drawer shows as unavailable.
     */
    live: {
      baseUrl: (process.env.AI_LIVE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey: process.env.AI_LIVE_API_KEY ?? "",
      model: process.env.AI_LIVE_MODEL ?? "gpt-live-1",
      voice: process.env.AI_LIVE_VOICE ?? "marin",
      backendModel: process.env.AI_LIVE_BACKEND_MODEL ?? "gpt-5.6-terra",
    },
    /** OpenAI-compatible speech-to-text (whisper) for the editor's voice input; empty = mic hidden */
    transcribeUrl: (process.env.AI_TRANSCRIBE_URL ?? "https://whisper.kevyn.com.br/v1").replace(/\/$/, ""),
    transcribeModel: process.env.AI_TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo",
    transcribeKey: process.env.AI_TRANSCRIBE_KEY ?? "",
  },
};
