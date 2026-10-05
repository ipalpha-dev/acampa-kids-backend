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
  /**
   * OPTIONAL (§21): dispatch-api origin for the ONE app-channel socket
   * (`{url}/api/dispatch/socket.io`, namespace `/apps`). Empty = no socket —
   * imports still work (webhook + reconciliation on the importer's reads).
   */
  dispatchUrl: string;
  /** OPTIONAL (§22): the app webhook signing secret (shown once in Mordomia / Developers portal). Empty = `POST /api/dispatch/webhook` refuses. */
  webhookSecret: string;
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
    dispatchUrl: trimSlash(get("IPALPHA_DISPATCH_URL")),
    webhookSecret: get("IPALPHA_WEBHOOK_SECRET"),
  };
}

/** `SUPER_ADMIN_PERSON_IDS` (comma list of IPAlpha person ids) — deployment owners, always coordenação. */
export function readSuperAdminPersonIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
}

const aiBaseUrl = (process.env.AI_BASE_URL ?? "https://ai-models.kevyn.com.br/v1").replace(/\/$/, "");
const aiApiKey = process.env.AI_API_KEY ?? "";

/** `IPALPHA_ENV` (prod | preview | dev …): synthetic-data tools (the wizard's sample camp) only in previews / dev. */
export function sampleDataAllowed(env: string | undefined): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return v === "preview" || v === "dev";
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  /** deployment kind (`IPALPHA_ENV`): `preview` / `dev` enable the synthetic sample camp (decision 71) */
  ipalphaEnv: (process.env.IPALPHA_ENV ?? "").trim().toLowerCase(),
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

  /** fallback session length when auth-api answers no `sessionIdleHours` (entry point config) */
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

  /** public URL of the app — the `{link}` of the message templates (empty = no link) */
  appUrl: process.env.APP_URL ?? "",

  /** Private InsightFace service used to index and search gallery faces. */
  face: {
    serviceUrl: (process.env.FACE_SERVICE_URL ?? "").replace(/\/$/, ""),
    /** Cosine similarity. Prefer recall: parents should find their kid even if a few other children come along. */
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD ?? 0.22),
    /** Weak detections still count — group shots and hats are the usual camp photo. */
    minDetectionScore: Number(process.env.FACE_MIN_DETECTION_SCORE ?? 0.4),
  },

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
