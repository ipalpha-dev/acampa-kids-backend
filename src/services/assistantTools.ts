import { ObjectId } from "mongodb";
import { getDb } from "../db";

/**
 * Read-only MongoDB tools for the camp assistant.
 *
 * Security rules (decision 90 — ALLOWLISTS, never denylists):
 * - only the collections named below are visible; anything else in the
 *   database (sessions, sign-ins, import jobs, a leftover of an older version
 *   such as `campers` / `staff` / `users`) does not exist for the assistant
 * - only the FIELDS named per collection are visible: every query runs as an
 *   aggregation whose first stage projects the allowlist, so a filter, sort
 *   or pipeline stage over any other field (a name / phone / health snapshot
 *   on an old document, `qrToken`, thumbnails, face embeddings, file bytes)
 *   sees nothing — it cannot even be used as a match oracle
 * - Acampa's Mongo holds camp operations only (CONTRACTS §15): no names,
 *   contacts or health — those live in IPAlpha and are not reachable here
 * - aggregation stages that can write, join or run server-side code are rejected
 * - every query has a result and execution-time cap
 *
 * A new field / collection = a new entry here, after checking it is camp ops
 * (ids, flags, camp texts) — never person data.
 */

interface AssistantCollection {
  description: string;
  /** the ONLY fields the assistant sees (`_id` is always there) */
  fields: readonly string[];
}

const CHECKIN_FIELDS = ["checkin", "busCheckin", "busReturnCheckin"] as const;

const COLLECTIONS: Record<string, AssistantCollection> = {
  participants: {
    description: "Participantes do acampamento por personId (kind camper = criança, team = equipe): quarto, cama, líder (caretakerId), time, transporte, check-ins, colete, observações. Sem nomes nem saúde (ficam no IPAlpha).",
    fields: [
      "personId", "kind", "team", "transportation", "bedroom", ...CHECKIN_FIELDS, "generalNotes", "draft", "createdAt", "updatedAt",
      // kids
      "invitedBy", "caretakerId", "bed", "bedroomPreference", "parentEditedAt",
      // team
      "active", "roomRole", "vest", "prepDone", "welcomeSentAt", "photosSmsSentAt", "foreignLookupCount", "foreignLookupCamperIds", "foreignLookupAlertedAt",
    ],
  },
  bedrooms: { description: "Quartos, alas, quantidade de beliches/camas e capacidade.", fields: ["name", "group", "bunkBeds", "singleBeds", "notes", "draft", "createdAt", "updatedAt"] },
  teams: { description: "Times do acampamento e suas cores.", fields: ["name", "color", "order", "draft", "createdAt", "updatedAt"] },
  transports: { description: "Ônibus, carros, números, cores e capacidade.", fields: ["kind", "name", "color", "number", "capacity", "order", "draft", "createdAt", "updatedAt"] },
  categories: { description: "Categorias e opções usadas nas fichas, como alergias e condições crônicas.", fields: ["key", "name", "emoji", "description", "appliesTo", "selection", "options", "order", "createdAt", "updatedAt"] },
  schedule_events: { description: "Programação: eventos, datas, horários, funções e pessoas escaladas.", fields: ["date", "title", "emoji", "startTime", "endTime", "notes", "roles", "visibleToParents", "assignments", "createdAt", "updatedAt"] },
  schedule_roles: { description: "Funções da programação, instruções e preparação.", fields: ["name", "emoji", "instructions", "preparation", "forRoomRoles", "hasDetail", "detailFromTeam", "detailPlaceholder", "createdAt", "updatedAt"] },
  scores: { description: "Histórico do placar por time, evento e acampante.", fields: ["teamId", "points", "kind", "note", "camperId", "eventId", "byPersonId", "createdAt"] },
  checkinLog: { description: "Auditoria de check-ins e cancelamentos de check-in.", fields: ["who", "personId", "kind", "action", "at", "byPersonId", "byRole", "note"] },
  medicationDoses: { description: "Doses de medicamentos registradas pela equipe médica.", fields: ["personId", "medKey", "medName", "dose", "day", "slot", "scheduled", "givenAt", "byPersonId", "note"] },
  occurrences: { description: "Ocorrências registradas pela administração, organização e equipe médica.", fields: ["campers", "staff", "description", "createdByPersonId", "createdByRole", "createdByGroup", "createdAt"] },
  instructions: { description: "Documentos de instruções gerais.", fields: ["title", "emoji", "audience", "content", "order", "createdAt", "updatedAt"] },
  prep_sections: { description: "Seções e checklists de preparação.", fields: ["title", "emoji", "audiences", "content", "order", "createdAt", "updatedAt"] },
  settings: {
    description: "Configurações gerais, janelas, listas de ajudantes e contatos.",
    fields: [
      "checkinLocations", "notifications", "checkinWindow", "busReturnWindow", "busHelpers", "parentContacts", "staffAccessWindow", "parentAccessWindow",
      "checkinTestMode", "kidsRoomsDraft", "scoreDraft", "scoreHideWindow", "wizardMode", "galleryPublished", "checkinReminder", "updatedAt",
    ],
  },
  gallery: { description: "Metadados do álbum de fotos.", fields: ["fileId", "order", "caption", "eventId", "byPersonId", "createdAt", "updatedAt"] },
  files: { description: "Metadados dos arquivos enviados; o conteúdo binário não é disponibilizado.", fields: ["name", "type", "size", "byPersonId", "createdAt"] },
  camperChangeLog: { description: "Histórico de alterações nas fichas dos acampantes (quais campos, nunca os valores).", fields: ["personId", "at", "byPersonId", "byRole", "medical", "fields"] },
  camperLookups: { description: "Auditoria de leituras emergenciais de crachás.", fields: ["at", "camperId", "byStaffId", "belonged"] },
  ai_usage: { description: "Métricas de uso das funções de IA.", fields: ["at", "vendor", "model", "kind", "promptTokens", "completionTokens", "ok"] },
  sms_usage: { description: "Métricas de envio de mensagens (modelo e quantidade).", fields: ["at", "templateSlug", "channel", "sent"] },
};

/** The collections + fields the assistant may see (tests / audits read this). */
export function assistantAllowlist(audience: AssistantAudience): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(collectionsFor(audience)).map(([name, c]) => [name, c.fields]));
}

/**
 * Who is asking. `all` (admin / organizer) reaches every collection below;
 * `medical` (a member of the medical team) is limited to the campers and the
 * reference data needed to READ their health — never staff, accounts,
 * settings, occurrences, audit logs, scores, photos or imports.
 */
export type AssistantAudience = "all" | "medical";

const MEDICAL_COLLECTIONS: readonly string[] = ["participants", "bedrooms", "teams", "transports", "categories", "medicationDoses"];

function collectionsFor(audience: AssistantAudience): Record<string, AssistantCollection> {
  if (audience === "all") return COLLECTIONS;
  return Object.fromEntries(MEDICAL_COLLECTIONS.map((name) => [name, COLLECTIONS[name]]));
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };
const NAVIGATION_DESTINATIONS = [
  "home", "campers", "camper", "staff", "staff_member", "bedrooms", "bedroom", "buses",
  "schedule", "event", "schedule_roles", "preparation", "instructions", "instruction",
  "occurrences", "medications", "checkin", "scoreboard", "scoreboard_team", "scoreboard_event",
  "gallery", "profile", "settings", "general_settings", "trials", "categories", "cleanup", "teams",
  "preparation_settings", "instructions_settings", "checkin_settings", "organizers", "game_organizers",
  "medical_staff", "vest_helpers", "photographers", "contacts", "notifications", "seeds", "about",
] as const;
const MAX_ROWS = 200;
const MAX_RESULT_CHARS = 120_000;
const MAX_TIME_MS = 8_000;
const SAFE_FILTER_OPERATORS = new Set([
  "$and", "$or", "$nor", "$not", "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$type", "$regex", "$options", "$size", "$all", "$elemMatch",
]);
const SAFE_AGGREGATE_STAGES = new Set(["$match", "$group", "$project", "$sort", "$limit", "$skip", "$unwind", "$count", "$addFields", "$set", "$unset", "$sortByCount"]);
const FORBIDDEN_KEYS = new Set(["$where", "$function", "$accumulator", "$merge", "$out"]);

export interface AssistantTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

function collectionOf(value: unknown, allowed: Record<string, AssistantCollection>): { name: string; config: AssistantCollection } {
  const name = typeof value === "string" ? value : "";
  const config = allowed[name];
  if (!config) throw new Error(`Coleção não permitida: ${name || "(vazia)"}`);
  return { name, config };
}

function assertSafe(value: unknown, mode: "filter" | "pipeline"): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item, mode);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Operador proibido: ${key}`);
    if (key.startsWith("$") && mode === "filter" && !SAFE_FILTER_OPERATORS.has(key)) throw new Error(`Operador de filtro não permitido: ${key}`);
    assertSafe(child, mode);
  }
}

function normalizeIds(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeIds(v, parentKey));
  if (!value || typeof value !== "object") {
    if (parentKey === "_id" && typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, normalizeIds(child, key.startsWith("$") ? parentKey : key)]));
}

/** First stage of every query: only the allowlisted fields exist from here on. */
function allowlistStage(config: AssistantCollection): Record<string, unknown> {
  return { $project: Object.fromEntries(config.fields.map((field) => [field, 1])) };
}

/** The caller's projection, reduced to allowlisted paths (inclusive when any field is included). */
function requestedProjection(config: AssistantCollection, requested: unknown): Record<string, 0 | 1> | null {
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) return null;
  const allowed = new Set(["_id", ...config.fields]);
  const projection: Record<string, 0 | 1> = {};
  for (const [key, value] of Object.entries(requested as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.]+$/.test(key) || !allowed.has(key.split(".")[0])) continue;
    if (value === 0 || value === 1) projection[key] = value;
  }
  const inclusive = Object.entries(projection).some(([key, value]) => key !== "_id" && value === 1);
  if (inclusive) for (const [key, value] of Object.entries(projection)) if (value === 0 && key !== "_id") delete projection[key];
  return Object.keys(projection).length ? projection : null;
}

function sanitize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map((v) => sanitize(v));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Binary-like values are metadata only; bytes never leave the server.
    if (child && typeof child === "object" && ((child as { _bsontype?: string })._bsontype === "Binary" || child instanceof Uint8Array)) continue;
    out[key] = sanitize(child);
  }
  return out;
}

function compactResult(value: unknown): unknown {
  const json = JSON.stringify(value);
  if (json.length <= MAX_RESULT_CHARS) return value;
  return { truncated: true, message: "Resultado grande demais. Refine o filtro ou o agrupamento.", preview: json.slice(0, MAX_RESULT_CHARS) };
}

/** The read-only tools this session may call — scoped to the audience's collections. */
export function buildAssistantTools(audience: AssistantAudience): AssistantTool[] {
  const allowed = collectionsFor(audience);
  return [
  {
    name: "list_collections",
    description: "Lista todas as coleções de dados do aplicativo que o assistente pode consultar, com quantidade e campos disponíveis. Use primeiro quando não souber onde está uma informação.",
    parameters: NO_ARGS,
    run: async () => {
      const db = await getDb();
      return Promise.all(Object.entries(allowed).map(async ([name, config]) => {
        const count = await db.collection(name).estimatedDocumentCount();
        return { collection: name, description: config.description, count, fields: ["_id", ...config.fields] };
      }));
    },
  },
  {
    name: "read_collection",
    description: "Lê documentos de uma coleção permitida. Use filtros MongoDB simples, projeção e ordenação. É somente leitura e retorna no máximo 200 registros.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", enum: Object.keys(allowed) },
        filter: { type: "object", description: "Filtro MongoDB. Ex.: {\"bedroom\":\"id\"}, {\"checkin\":null}, {\"kind\":\"camper\"}", additionalProperties: true },
        projection: { type: "object", description: "Campos a incluir (1) ou excluir (0).", additionalProperties: { type: "integer", enum: [0, 1] } },
        sort: { type: "object", description: "Ordenação por campo: 1 crescente, -1 decrescente.", additionalProperties: { type: "integer", enum: [-1, 1] } },
        limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
      },
      required: ["collection"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { name, config } = collectionOf(args.collection, allowed);
      const filter = args.filter && typeof args.filter === "object" && !Array.isArray(args.filter) ? args.filter : {};
      assertSafe(filter, "filter");
      const rawSort = args.sort && typeof args.sort === "object" && !Array.isArray(args.sort) ? args.sort as Record<string, unknown> : {};
      const sort = Object.fromEntries(Object.entries(rawSort).filter(([key, value]) => /^[A-Za-z0-9_.]+$/.test(key) && (value === 1 || value === -1))) as Record<string, 1 | -1>;
      const limit = Math.min(MAX_ROWS, Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 50));
      const projection = requestedProjection(config, args.projection);
      // the allowlist projection comes FIRST: the filter / sort only ever see allowlisted fields
      const pipeline: Record<string, unknown>[] = [
        allowlistStage(config),
        { $match: normalizeIds(filter) as Record<string, unknown> },
        ...(Object.keys(sort).length ? [{ $sort: sort }] : []),
        { $limit: limit },
        ...(projection ? [{ $project: projection }] : []),
      ];
      const db = await getDb();
      const docs = await db.collection(name).aggregate(pipeline, { maxTimeMS: MAX_TIME_MS, allowDiskUse: false }).toArray();
      return compactResult({ collection: name, returned: docs.length, limit, rows: sanitize(docs) });
    },
  },
  {
    name: "aggregate_collection",
    description: "Conta, agrupa e resume uma coleção com pipeline MongoDB somente leitura. Use para totais, distribuições, médias e agrupamentos. Estágios de escrita, código e junções não são aceitos.",
    parameters: {
      type: "object",
      properties: {
        collection: { type: "string", enum: Object.keys(allowed) },
        pipeline: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: true } },
      },
      required: ["collection", "pipeline"],
      additionalProperties: false,
    },
    run: async (args) => {
      const { name, config } = collectionOf(args.collection, allowed);
      if (!Array.isArray(args.pipeline) || !args.pipeline.length || args.pipeline.length > 12) throw new Error("Pipeline inválido.");
      for (const stage of args.pipeline) {
        if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw new Error("Estágio inválido.");
        const keys = Object.keys(stage as Record<string, unknown>);
        if (keys.length !== 1 || !SAFE_AGGREGATE_STAGES.has(keys[0])) throw new Error(`Estágio não permitido: ${keys[0] ?? "vazio"}`);
        assertSafe(stage, "pipeline");
      }
      // the allowlist projection comes FIRST: no stage ever sees a field outside it
      const pipeline = [allowlistStage(config), ...(normalizeIds(args.pipeline) as Record<string, unknown>[])];
      // A final hard cap protects both Mongo and the model even when the caller omitted $limit.
      pipeline.push({ $limit: MAX_ROWS });
      const db = await getDb();
      const rows = await db.collection(name).aggregate(pipeline, { maxTimeMS: MAX_TIME_MS, allowDiskUse: false }).toArray();
      return compactResult({ collection: name, rows: sanitize(rows) });
    },
  },
  ];
}

export function assistantToolSpecs(audience: AssistantAudience) {
  return buildAssistantTools(audience).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

/** Same tools in the flat Responses-API shape, plus one client-side, read-only navigation action. */
export function assistantResponsesToolSpecs(audience: AssistantAudience) {
  return [
    ...buildAssistantTools(audience).map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters })),
    {
      type: "function",
      name: "navigate_app",
      description: "Abre uma página, menu ou ficha já existente no frontend do Acampa Kids. Use diretamente quando a pessoa pedir para abrir, mostrar ou ir a uma tela. Isto apenas navega: nunca cria, edita, salva, marca, registra, exclui ou altera dados. Para fichas, informe record_id quando já o souber; caso contrário passe em name o nome como foi ouvido. O frontend tolera pequenas diferenças de transcrição, como Kevin/Kevyn. Não consulte read_collection apenas para resolver o nome antes de navegar.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string", enum: NAVIGATION_DESTINATIONS },
          record_id: { type: "string", description: "ID existente do acampante, membro da equipe, quarto, evento, documento ou time." },
          name: { type: "string", description: "Nome ou título para localizar a ficha quando o ID não estiver disponível." },
        },
        required: ["destination"],
        additionalProperties: false,
      },
    },
  ];
}

export async function runAssistantTool(audience: AssistantAudience, name: string, rawArgs: string): Promise<string> {
  const tool = buildAssistantTools(audience).find((item) => item.name === name);
  if (!tool) return JSON.stringify({ error: `Ferramenta desconhecida: ${name}` });
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};
  } catch {
    return JSON.stringify({ error: "Argumentos inválidos." });
  }
  try {
    return JSON.stringify(await tool.run(args));
  } catch (error) {
    console.error("assistant tool failed", name, error);
    return JSON.stringify({ error: error instanceof Error ? error.message : "Consulta indisponível." });
  }
}
