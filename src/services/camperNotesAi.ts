import { config } from "../config";
import { listCategories } from "../models/categories";
import { CAMPER_CATEGORY_KEYS, MEDICATION_TIMES_MAX, MEDICATIONS_MAX, type Medication } from "../types";
import { formatCpf, normalizeBrazilPhone } from "../utils";
import type { AiVendor } from "../routes/ai";

/**
 * "Organizar observações": the free-text observations that came with a kid's
 * registration (health, medicines, preferences, emergency contacts, insurance,
 * all mixed) are sorted into the right fields of the camper record. Only what
 * fits nowhere stays in "Observações gerais".
 *
 * Two modes share the same field spec (`FIELD_SPEC`) and the same output
 * normalisation, but differ in the model chain, the reasoning budget and the
 * tone of the rules:
 *
 *   "live"  — the admin form (`POST /api/ai/camper-notes`). Runs on paste /
 *             blur while the user watches, and the Save button only waits 8 s.
 *             Speed matters: Opus 5 → GPT 5.6 Terra → Grok 4.5, low reasoning.
 *             Rules favour "when in doubt leave it in generalNotes" so a fast
 *             answer never mis-files a fact the admin wouldn't notice.
 *
 *   "bulk"  — offline import of the whole registration export (a script, no
 *             user waiting). Quality matters: Grok 4.6 → Fable 5.1 → GPT 5.6,
 *             high reasoning, and the rules ask for a full second pass (every
 *             fact accounted for, nothing duplicated, formats exact) since no
 *             human reviews each record right away.
 *
 * Non-streaming, JSON in/out. Tries the chain's models in order until one
 * answers with parseable JSON.
 */

export type NotesMode = "live" | "bulk";

export interface NotesModel {
  id: string;
  label: string;
  vendor: AiVendor;
}

export interface NotesModeConfig {
  /** in order: first is the default, the rest are fallbacks */
  models: NotesModel[];
  /** how much the model may think; "xhigh" is the ceiling on /chat/completions ("max" needs the Responses API) */
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  /**
   * "fast" buys ~2.5x output tokens/s at premium rates, so the form can afford
   * high reasoning. Only OpenAI and Anthropic offer it, and each spells it
   * differently — see `callNotesModel`. Omitted = standard speed.
   */
  speed?: "fast";
  /** one model may take this long before we move to the next */
  timeoutMs: number;
}

export const NOTES_MODES: Record<NotesMode, NotesModeConfig> = {
  live: {
    models: [
      { id: "claude-opus-5", label: "Opus 5", vendor: "anthropic" },
      { id: "gpt-5.6-terra", label: "GPT 5.6 Terra", vendor: "openai" },
      { id: "grok-4.5", label: "Grok 4.5", vendor: "xai" },
    ],
    reasoningEffort: "low",
    speed: "fast",
    timeoutMs: 40_000,
  },
  bulk: {
    models: [
      { id: "grok-4.6", label: "Grok 4.6", vendor: "xai" },
      { id: "claude-fable-5-1", label: "Fable 5.1", vendor: "anthropic" },
      { id: "gpt-5.6-sol", label: "GPT 5.6 Sol", vendor: "openai" },
      { id: "glm-5.3", label: "GLM 5.3", vendor: "zhipu" },
    ],
    reasoningEffort: "high",
    timeoutMs: 180_000,
  },
};

export const NOTES_MAX_CHARS = 4_000;

/** the form fields the model may fill (all optional in the answer) */
export interface CamperNotesFields {
  /** category option ids */
  allergies: string[];
  drugAllergies: string[];
  healthIssues: string[];
  neurodivergent: boolean;
  medications: Medication[];
  foodRestrictions: string;
  healthNotes: string;
  bedroomPreference: string;
  emergencyContact: string;
  /** kilograms, null when the text doesn't say */
  weightKg: number | null;
  insurance: string;
  insuranceCard: string;
  /** the kid's own identity/registration fields */
  cpf: string;
  rg: string;
  school: string;
  schoolGrade: string;
  church: string;
  invitedBy: string;
  /** the guardian block */
  guardianName: string;
  guardianPhone: string;
  guardianCpf: string;
  guardianEmail: string;
  /** what was left in the general notes after sorting */
  generalNotes: string;
}

export interface CamperNotesInput {
  /** the text to sort (current content of the leftover box) */
  notes: string;
  /** whose record: decides the fields (default "camper") */
  subject?: NotesSubject;
  /** what the form already holds — the answer must keep it */
  current: Partial<CamperNotesFields>;
}

export interface CamperNotesResult {
  fields: CamperNotesFields;
  model: string;
  vendor: AiVendor;
  usage: { promptTokens: number; completionTokens: number };
  /** models that failed before this one answered */
  failed: string[];
}

interface OptionList {
  key: string;
  labels: string[];
  /** lower-cased label → option id */
  byLabel: Map<string, string>;
  /** option id → label */
  byId: Map<string, string>;
}

async function optionLists(): Promise<Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>> {
  const cats = await listCategories();
  const build = (key: string): OptionList => {
    const c = cats.find((x) => x.key === key);
    const options = (c?.options ?? []).filter((o) => o.active && !/^nenhum/i.test(o.label));
    return {
      key,
      labels: options.map((o) => o.label),
      byLabel: new Map(options.map((o) => [o.label.toLowerCase(), o.id])),
      byId: new Map(options.map((o) => [o.id, o.label])),
    };
  };
  return {
    allergies: build(CAMPER_CATEGORY_KEYS.allergies),
    drugAllergies: build(CAMPER_CATEGORY_KEYS.drugAllergies),
    healthIssues: build(CAMPER_CATEGORY_KEYS.healthIssues),
  };
}

interface OptionLabels {
  allergies: string[];
  drugAllergies: string[];
  healthIssues: string[];
}

/**
 * Whose record is being sorted — decides which fields exist and where the
 * leftovers go:
 *   "camper" — admin form of a kid: every field; leftovers → generalNotes.
 *   "parent" — the parent's "Informações de saúde" dialog: the kid's medical block
 *              only (no room preference, emergency contact or neurodivergent
 *              flag — the parent can't edit those, so such facts stay in
 *              generalNotes for the organization to move); leftovers → generalNotes.
 *   "staff"  — a volunteer: allergies, drug allergies, conditions, medication,
 *              food; there is no generalNotes, so leftovers → healthNotes.
 */
export type NotesSubject = "camper" | "parent" | "staff";

type FieldKey = keyof CamperNotesFields;

const SUBJECT_FIELDS: Record<NotesSubject, FieldKey[]> = {
  camper: ["allergies", "drugAllergies", "healthIssues", "neurodivergent", "medications", "foodRestrictions", "healthNotes", "bedroomPreference", "weightKg", "insurance", "insuranceCard", "emergencyContact", "cpf", "rg", "school", "schoolGrade", "church", "invitedBy", "guardianName", "guardianPhone", "guardianCpf", "guardianEmail", "generalNotes"],
  parent: ["allergies", "drugAllergies", "healthIssues", "medications", "foodRestrictions", "healthNotes", "weightKg", "insurance", "insuranceCard", "generalNotes"],
  staff: ["allergies", "drugAllergies", "healthIssues", "medications", "foodRestrictions", "healthNotes"],
};

/** the field that receives whatever fits nowhere else */
const LEFTOVER_FIELD: Record<NotesSubject, "generalNotes" | "healthNotes"> = { camper: "generalNotes", parent: "generalNotes", staff: "healthNotes" };

export function subjectFields(subject: NotesSubject): FieldKey[] {
  return SUBJECT_FIELDS[subject];
}

/** one line of the field spec per field; `who` is "a criança" or "a pessoa" */
function fieldLines(lists: OptionLabels, subject: NotesSubject): Record<FieldKey, string> {
  const kid = subject !== "staff";
  const who = kid ? "a criança" : "a pessoa";
  const author = kid ? "os pais" : "a pessoa";
  const leftover = LEFTOVER_FIELD[subject];
  return {
    allergies: `- "allergies": lista de strings. Alergias (ambiente, insetos, alimentos). Use SOMENTE valores desta lista, escritos exatamente assim: ${JSON.stringify(lists.allergies)}. Encaixe o que ${author} escreveu no item da lista que o cobre (camarão → "Peixe / frutos do mar", leite → "Lactose / leite", pó/ácaro → "Poeira / mofo", abelha/formiga/pernilongo → "Picada de inseto", rinite → "Rinite alérgica"). Se nenhum item cobre, NÃO invente um valor: descreva a alergia em "healthNotes" ("Alergia a água gelada"). Alergia ALIMENTAR: marque aqui E escreva o alimento em "foodRestrictions" ("Não pode comer camarão").`,
    drugAllergies: `- "drugAllergies": lista de strings. Alergia a medicamentos. Use SOMENTE valores desta lista: ${JSON.stringify(lists.drugAllergies)}. Medicamento fora da lista → "Outro medicamento" (se existir na lista) E o nome do remédio em "healthNotes".`,
    healthIssues: `- "healthIssues": lista de strings. Condições crônicas. Use SOMENTE valores desta lista: ${JSON.stringify(lists.healthIssues)}. Condição fora da lista → descreva em "healthNotes".`,
    neurodivergent: `- "neurodivergent": boolean. true se o texto indica TEA/autismo, TDAH ou outra neurodivergência diagnosticada. Se não menciona, false.`,
    medications: `- "medications": lista de objetos {"name","dose","times","asNeeded","notes"}. Um item por medicamento de uso ROTINEIRO ou de crise que a equipe médica precisa ter à mão. "name": nome comercial ou princípio ativo como escrito ("Aerolin", "Ritalina", "Colírio"). "dose": SÓ a quantidade por administração ("10mg", "5ml", "4 puffs", "1 comprimido"), vazio se não informada — nunca horário ou condição aqui. "times": lista de horários "HH:MM"; SEMPRE traduza momentos do dia: café da manhã/manhã/ao acordar = "08:30", almoço = "12:30", lanche/tarde = "16:30", jantar = "19:00", noite/antes de dormir = "22:00"; "a cada refeição"/"nas refeições" = ["08:30","12:30","19:00"]; um horário por administração; vazio só quando o texto não dá nenhum momento. "asNeeded": true SOMENTE quando é em caso de crise/necessidade ("se tiver crise", "se precisar", bombinha/Aerolin sem horário); false quando há horário. "notes": condição e modo de uso, curto ("em crise de asma, com espaçador, 10 s entre os jatos"); se a dose muda por horário, diga aqui ("meio comprimido no almoço"). Não repita nome, dose nem horários nas notes.
  Exemplo: "Ritalina 10mg no café da manhã e meio comprimido no almoço. Colírio antes de dormir. Aerolin 4 puffs se tiver crise" → [{"name":"Ritalina","dose":"10mg","times":["08:30","12:30"],"asNeeded":false,"notes":"meio comprimido no almoço"},{"name":"Colírio","dose":"","times":["22:00"],"asNeeded":false,"notes":""},{"name":"Aerolin","dose":"4 puffs","times":[],"asNeeded":true,"notes":"em crise de asma"}]`,
    foodRestrictions: `- "foodRestrictions": string. Restrições e preferências ALIMENTARES (intolerâncias, dieta, vegetariano, "seletiva", "não come carne"). Alergia alimentar entra em "allergies" (se estiver na lista) e a orientação prática aqui.`,
    healthNotes:
      leftover === "healthNotes"
        ? `- "healthNotes": string. Para a EQUIPE MÉDICA: o que fazer em crise, condições/doenças fora da lista, alergias fora da lista, cuidados (convulsão, pressão, gestação, limitação física, cirurgia recente, fisioterapia, órteses) E TAMBÉM tudo o que não coube em nenhum outro campo. O que sobra fica com as palavras originais do texto (só retire os trechos movidos). Se tudo foi para outros campos, devolva "".`
        : `- "healthNotes": string. Para a EQUIPE MÉDICA: o que fazer em crise, condições/doenças fora da lista, alergias fora da lista, cuidados físicos (sonambulismo, enurese/xixi na cama, vômitos, convulsão, febre frequente, dor), fisioterapia, órteses. Frases curtas; assuntos diferentes em linhas diferentes.`,
    bedroomPreference: `- "bedroomPreference": string. Com quem ${who} quer dividir o quarto e pedidos sobre a CAMA. Formato: nomes separados por vírgula, iniciais maiúsculas, mantendo entre parênteses o vínculo ou a ressalva que ${author} escreveu: "Bernardo Faria, Lucas (primo), Daniel Araújo (convidado, não confirmado)". Pedido sobre a cama vem depois dos nomes, separado por " · ", com o motivo curto se houver: "Enzo Dalfovo · só cama de baixo (vira dormindo)", "cama de cima só com proteção lateral". Se o texto só diz "cama de baixo", escreva "só cama de baixo".`,
    weightKg: `- "weightKg": number ou null. Peso em kg quando o texto informa ("Peso: 28.5kg" → 28.5, "30kgkg" → 30). null se não há.`,
    insurance: `- "insurance": string. Nome do convênio/plano de saúde ("Sulamerica", "Bradesco Saúde", "Amil Black"); iniciais maiúsculas, sem o número da carteirinha. "Não tem" / "particular" → "Não tem". Vazio se não há.`,
    insuranceCard: `- "insuranceCard": string. Número da carteirinha do convênio, só dígitos e espaços como escrito. Vazio se não há.`,
    cpf: `- "cpf": string. CPF DA CRIANÇA no formato "123.456.789-00". Só se o texto deixa claro que é o CPF da criança, não o do responsável. Vazio se não há.`,
    rg: `- "rg": string. RG/identidade DA CRIANÇA, como escrito ("12.345.678-9"), incluindo o órgão emissor se informado. Vazio se não há.`,
    school: `- "school": string. Nome da ESCOLA/colégio onde a criança estuda, iniciais maiúsculas ("Colégio Adventista"). Sem a série. Vazio se não há.`,
    schoolGrade: `- "schoolGrade": string. SÉRIE/ano escolar da criança como escrito ("5º ano", "2ª série do fundamental"). Vazio se não há.`,
    church: `- "church": string. IGREJA que a criança frequenta, iniciais maiúsculas ("Igreja Batista Central"). Vazio se não há.`,
    invitedBy: `- "invitedBy": string. Quem CONVIDOU a criança para o acampamento, nome com iniciais maiúsculas. Vazio se não há.`,
    guardianName: `- "guardianName": string. Nome do RESPONSÁVEL (pai, mãe ou responsável legal que fez a inscrição), iniciais maiúsculas e acentos. NÃO é contato de emergência. Vazio se não há.`,
    guardianPhone: `- "guardianPhone": string. Telefone do responsável no formato "11 99999-4999" (DDD, espaço, 5 dígitos, hífen, 4 dígitos); se faltar o DDD, use 11. É o telefone do responsável principal, NÃO o de emergência. Vazio se não há.`,
    guardianCpf: `- "guardianCpf": string. CPF DO RESPONSÁVEL no formato "123.456.789-00". Vazio se não há.`,
    guardianEmail: `- "guardianEmail": string. E-mail do responsável, minúsculas. Vazio se não há.`,
    emergencyContact: `- "emergencyContact": string. Contatos de emergência. Formato SEMPRE: "Nome (vínculo) 11 99999-4999". Vínculo = parentesco (pai, mãe, avó, tia, madrasta…) e só se informado; nunca escreva "(emergência)" ou "(contato)". Telefone SEMPRE como "11 99999-4999" (DDD, espaço, 5 dígitos, hífen, 4 dígitos); se faltar o DDD, use 11. Vários contatos separados por " / ". Se só há telefone, escreva só o telefone. Nome com iniciais maiúsculas e acentos corretos.`,
    generalNotes:
      subject === "parent"
        ? `- "generalNotes": string. Tudo o que não é saúde: comportamento, emoções, medos, primeira vez no acampamento, não sabe nadar, objeto de apego, com quem quer ficar no quarto ou nas brincadeiras, contatos de emergência e telefones (a organização move depois). Mantenha as palavras originais do texto: só retire os trechos que foram para outros campos, sem reescrever nem resumir. Se tudo foi para outros campos, devolva "".`
        : `- "generalNotes": string. Para os MONITORES do quarto e do time: comportamento, emoções, medos (do escuro, de dormir sozinho), acompanhamento psicológico/terapia, primeira vez no acampamento, não sabe nadar, objeto de apego (pelúcia, paninho), com quem ficar nas brincadeiras, seletividade e manias sem risco, pendências de cadastro. Mantenha as palavras originais do texto: só retire os trechos que foram para outros campos, sem reescrever nem resumir. Se tudo foi para outros campos, devolva "".`,
  };
}

/** the "where does X go" guide; each line lists the fields it needs so it only shows when they exist */
const GUIDE: { needs: FieldKey[]; line: string }[] = [
  { needs: ["medications"], line: `- Remédio de rotina ou de crise → "medications" (e a condição em "healthIssues" se estiver na lista).` },
  { needs: ["bedroomPreference"], line: `- "Não dormir em cima porque cai/vira/se mexe" → "bedroomPreference" (é pedido de cama, não saúde).` },
  { needs: ["generalNotes"], line: `- "Faz xixi na cama", "sonâmbulo", "vomita se come demais" → "healthNotes".` },
  { needs: ["generalNotes"], line: `- "Faz terapia", "passa na psicóloga", "medo do escuro", "explode quando provocado" → "generalNotes".` },
  { needs: ["foodRestrictions"], line: `- "Come pouco", "seletivo", "vegetariano", "não come carne", "sem lactose" → "foodRestrictions".` },
  { needs: ["weightKg", "insurance"], line: `- "Peso: 30kg | Convênio médico: Amil (carteirinha 1234)" → "weightKg", "insurance", "insuranceCard"; nada disso fica em "generalNotes".` },
  { needs: ["medications"], line: `- "Medicação de uso diário: Atentah 25mg pela manhã, Depakene 5ml à noite" → um item em "medications" por remédio, com os horários traduzidos.` },
  { needs: ["medications"], line: `- "Profilaxia com antibiótico caso necessidade / antes de procedimentos" → "medications" (asNeeded, com a instrução) + "healthNotes". Instrução de uso ou profilaxia NUNCA é "drugAllergies": alergia só com a palavra dos pais ("alergia a", "reação", "não pode tomar").` },
  { needs: ["emergencyContact"], line: `- Quem chamar e telefone → "emergencyContact". Nome do responsável principal sem telefone novo → fica em "generalNotes" só se houver pendência.` },
  { needs: ["guardianName", "emergencyContact"], line: `- Nome/telefone/CPF/e-mail do PAI ou MÃE que inscreveu → "guardianName"/"guardianPhone"/"guardianCpf"/"guardianEmail". Quem chamar EM EMERGÊNCIA → "emergencyContact". São campos diferentes.` },
  { needs: ["school", "church"], line: `- "Estuda no Colégio X, 5º ano | Igreja Batista | Convidado por Fulano" → "school", "schoolGrade", "church", "invitedBy"; nada disso fica em "generalNotes".` },
  { needs: ["cpf", "rg"], line: `- Documentos: CPF e RG DA CRIANÇA → "cpf"/"rg"; CPF do responsável → "guardianCpf".` },
];

/**
 * The part of the prompt both modes share: what each field means, the exact
 * output formats and the "where does X go" guide, restricted to the fields
 * of the subject. Tuned until Grok, Claude and GPT gave the same field
 * placement (the prompt lab over the old registration export was removed —
 * decision 90: old data is never read).
 */
function fieldSpec(lists: OptionLabels, subject: NotesSubject): string {
  const fields = SUBJECT_FIELDS[subject];
  const lines = fieldLines(lists, subject);
  const has = (k: FieldKey) => fields.includes(k);
  const guide = GUIDE.filter((g) => g.needs.every(has)).map((g) => g.line);
  const extra: string[] = [];
  if (subject === "parent") extra.push(`- Contato de emergência, telefone, com quem dividir o quarto → "generalNotes" (não há campo para isso aqui).`);
  if (subject === "staff") extra.push(`- Convênio, peso, telefone de emergência, preferências de quarto → "healthNotes" em uma linha curta (não há campo para isso aqui).`);
  return `## Campos da ficha (responda um objeto JSON com exatamente estas chaves)
${fields.map((k) => lines[k]).join("\n")}

## Onde cada coisa vai (guia rápido)
${[...guide, ...extra].join("\n")}`;
}

/** rules every mode enforces (numbered so the mode-specific ones can continue the list); `leftover` is the box the text came from */
function commonRules(leftover: "generalNotes" | "healthNotes"): string {
  return `1. Você só MOVE informação: NÃO invente, NÃO acrescente e NÃO complete nada. Só use o que está no texto e nos campos atuais. Nada de doses, horários, nomes, telefones, resumos, explicações ou valores padrão que não estão escritos. NÃO dê nomes de diagnóstico que os pais não escreveram ("vira dormindo" não é sonambulismo; "faz xixi na cama" fica assim, não vira "enurese" a menos que esteja escrito).
2. Cada informação aparece UMA vez, no campo mais específico. Depois de mover uma informação, ela NÃO fica em "${leftover}". Uma condição marcada em "healthIssues" ou um remédio descrito em "medications" (com sua instrução de crise) NÃO é repetido em "healthNotes"; lá fica só o que não coube ("asma controlada há 1 ano", "cardiopatia: insuficiência da válvula pulmonar"). Antes de responder, releia as sobras frase por frase contra os CAMPOS ATUAIS: fato já coberto por qualquer campo (atual ou novo), mesmo dito com outras palavras, sai das sobras.
3. Os campos que você devolve SUBSTITUEM os atuais: repita o conteúdo que já existe neles (listas e textos) e acrescente o novo. Nunca remova o que já está lá; nunca duplique um item já presente. Para listas, a união; para textos, o atual e o novo em linhas/frases separadas. EXCEÇÃO: se o texto das observações CONTRADIZ um valor atual (peso, convênio, carteirinha, telefone), o valor das observações prevalece — é a informação mais recente, e o valor antigo é descartado.
4. Normalize a escrita do que vai para os campos: corrija ortografia e acentuação, iniciais maiúsculas em nomes próprios, remova CAIXA ALTA, emojis e repetições ("NOAHHHHHH Ribeiro" → "Noah Ribeiro"). Mantenha o sentido e os fatos exatos (doses, quantidades, nomes de remédios). O que SOBRA em "${leftover}" fica escrito como estava: mesmas frases e palavras, só sem os trechos que foram movidos — não reescreva, não resuma, não reorganize.
5. Português do Brasil. Sem comentários, sem markdown, sem cercas de código: responda SOMENTE o objeto JSON.`;
}

/**
 * LIVE prompt — the admin form.
 *
 * Context: the organizer just pasted (or finished typing) the registration
 * text into "Observações gerais" and is looking at the form; the answer
 * replaces the fields in front of them within seconds and Save only waits 8 s.
 * The prompt therefore:
 *   - describes the situation as "the text is in the general notes box";
 *   - tells the model the form already has values it must not lose;
 *   - biases toward caution: an ambiguous sentence stays in generalNotes
 *     rather than being guessed into a health field, because the admin will
 *     see the leftovers and can move them by hand, but won't re-read every
 *     health field to catch a wrong guess;
 *   - asks for one pass, no deliberation ("decida rápido").
 */
export function notesSystemPromptLive(lists: OptionLabels, subject: NotesSubject = "camper"): string {
  return `${intro(subject)} A pessoa está com o formulário aberto esperando: distribua cada informação para o campo certo e deixe em "${LEFTOVER_LABEL[subject]}" SOMENTE o que não cabe em nenhum outro campo.

${fieldSpec(lists, subject)}

## Regras
${commonRules(LEFTOVER_FIELD[subject])}
6. Decida rápido e com segurança: se uma frase for ambígua ou você não tiver certeza do campo, deixe-a em "${LEFTOVER_FIELD[subject]}" em vez de chutar. Quem está editando vê o que sobrou ali e move à mão; um dado no campo errado não percebe.
7. Não reescreva o que já está bom: se um campo atual já contém a informação no formato certo, devolva-o igual.`;
}

/**
 * BULK prompt — offline import of the whole registration export.
 *
 * Context: a script feeds every kid's raw registration text (the pipe-joined
 * "Peso | Convênio | Condição crônica | Medicação | Outras observações |
 * Prefere dividir quarto com" blob plus allergies and emergency contact) with
 * empty current fields, and writes the answer straight into the database.
 * Nobody reviews each record right away, so the prompt:
 *   - frames the task as a complete, careful triage of one record;
 *   - asks the model to account for every fact in the text (checklist) and
 *     to leave "generalNotes" empty when everything found a home — nothing
 *     may be silently dropped, and nothing may be duplicated;
 *   - demands the exact formats (phone, names, medication times) since the
 *     output is stored as-is and shown to the medical team and monitors;
 *   - allows the model to spend its reasoning budget on a self-check pass
 *     before answering (the chain runs with high reasoning effort).
 */
export function notesSystemPromptBulk(lists: OptionLabels, subject: NotesSubject = "camper"): string {
  const raw =
    subject === "staff"
      ? "O texto é o que a pessoa escreveu na inscrição de voluntário sobre a própria saúde, com erros de digitação, CAIXA ALTA e frases soltas."
      : 'O texto costuma vir como campos colados com " | " (Escola, Série, Igreja, Convidado por, CPF, RG, Responsável, Peso, Convênio médico, Condição crônica, Medicação de uso diário, Outras observações, Prefere dividir quarto com), mais alergias e contato de emergência, tudo com erros de digitação, CAIXA ALTA e frases soltas.';
  return `Você faz a triagem da ficha de ${subject === "staff" ? "UM voluntário adulto da equipe" : "UMA criança"} para o sistema de um ACAMPAMENTO INFANTIL de igreja (Brasil), a partir do texto bruto da inscrição. ${raw} Sua resposta é gravada direto no banco e lida pela equipe médica e pelos monitores sem revisão imediata: ela precisa estar completa, sem repetições e nos formatos exatos.

${fieldSpec(lists, subject)}

## Regras
${commonRules(LEFTOVER_FIELD[subject])}
6. Cada fato do texto tem UM destino. Antes de responder, percorra o texto frase por frase e confira: (a) todo remédio, condição, alergia, restrição alimentar e demais dados foram para o campo próprio; (b) nada ficou em "${LEFTOVER_FIELD[subject]}" que caiba em outro campo; (c) nada do texto foi descartado — se sobrou algo que não cabe em lugar nenhum, ele está em "${LEFTOVER_FIELD[subject]}"; (d) nenhuma informação aparece em dois campos.
7. Formatos são obrigatórios, não sugestões: telefones "11 99999-4999" (DDD, espaço, 5 dígitos, hífen, 4 dígitos), contatos "Nome (vínculo) telefone" separados por " / ", horários "HH:MM" traduzidos dos momentos do dia, nomes com iniciais maiúsculas e acentos, listas só com valores exatamente iguais aos permitidos.
8. Se depois da conferência TUDO encontrou um campo, "${LEFTOVER_FIELD[subject]}" é "". Não escreva "sem observações", "nada a declarar" nem resumos do que foi movido.
9. Nunca marque "neurodivergent": true, um item de "healthIssues" ou uma alergia por dedução: só com a palavra dos pais no texto (TDAH, TEA/autismo, asma, etc.).`;
}

/** the system prompt of a mode */
export function notesSystemPrompt(mode: NotesMode, lists: OptionLabels, subject: NotesSubject = "camper"): string {
  return mode === "bulk" ? notesSystemPromptBulk(lists, subject) : notesSystemPromptLive(lists, subject);
}

/** what the leftover box is called on screen */
const LEFTOVER_LABEL: Record<NotesSubject, string> = { camper: "Observações gerais", parent: "Observações", staff: "Outras observações de saúde" };

/** opening sentence of the live prompt: who wrote the text and where it was pasted */
function intro(subject: NotesSubject): string {
  switch (subject) {
    case "staff":
      return `Você organiza a ficha de saúde de um VOLUNTÁRIO ADULTO da equipe de um ACAMPAMENTO INFANTIL de igreja (Brasil). A organização acabou de colar no campo "Outras observações de saúde" o texto livre que a pessoa escreveu na inscrição: alergias, remédios, condições, alimentação, tudo misturado.`;
    case "parent":
      return `Você organiza a ficha de saúde de uma criança no sistema de um ACAMPAMENTO INFANTIL de igreja (Brasil). O pai ou a mãe acabou de escrever ou colar no campo "Observações" um texto livre sobre o filho: saúde, medicamentos, alimentação, convênio, comportamento, tudo misturado.`;
    default:
      return `Você organiza a ficha de uma criança no sistema de um ACAMPAMENTO INFANTIL de igreja (Brasil). A organização acabou de colar no campo "Observações gerais" o texto livre que os pais escreveram na inscrição: saúde, medicamentos, preferências de quarto, contatos de emergência, convênio, comportamento, tudo misturado.`;
  }
}

function userMessage(input: CamperNotesInput, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>): string {
  const cur = input.current;
  const labels = (list: OptionList, ids?: string[]) => (ids ?? []).map((id) => list.byId.get(id) ?? id).filter(Boolean);
  const current = {
    allergies: labels(lists.allergies, cur.allergies),
    drugAllergies: labels(lists.drugAllergies, cur.drugAllergies),
    healthIssues: labels(lists.healthIssues, cur.healthIssues),
    neurodivergent: cur.neurodivergent === true,
    medications: cur.medications ?? [],
    foodRestrictions: cur.foodRestrictions ?? "",
    healthNotes: cur.healthNotes ?? "",
    bedroomPreference: cur.bedroomPreference ?? "",
    emergencyContact: cur.emergencyContact ?? "",
    weightKg: cur.weightKg ?? null,
    insurance: cur.insurance ?? "",
    insuranceCard: cur.insuranceCard ?? "",
    cpf: cur.cpf ?? "",
    rg: cur.rg ?? "",
    school: cur.school ?? "",
    schoolGrade: cur.schoolGrade ?? "",
    church: cur.church ?? "",
    invitedBy: cur.invitedBy ?? "",
    guardianName: cur.guardianName ?? "",
    guardianPhone: cur.guardianPhone ?? "",
    guardianCpf: cur.guardianCpf ?? "",
    guardianEmail: cur.guardianEmail ?? "",
  };
  const fields = SUBJECT_FIELDS[input.subject ?? "camper"];
  const shown = Object.fromEntries(Object.entries(current).filter(([k]) => fields.includes(k as FieldKey) && k !== LEFTOVER_FIELD[input.subject ?? "camper"]));
  return `CAMPOS ATUAIS DA FICHA (mantenha e complete):\n${JSON.stringify(shown, null, 1)}\n\nOBSERVAÇÕES GERAIS (texto a organizar):\n${input.notes.trim() || "(vazio)"}`;
}

// ── normalisation of the model output ─────────────────────────────────

/** "Alison(pai)/ 1196305-5033" → "Alison (pai) 11 96305-5033" — one pass over every phone-looking run */
export function formatEmergencyContact(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    // every run of digits/separators that looks like a phone: keep only its digits and rebuild
    .replace(/\+?\d[\d\s.()-]{7,}\d/g, (m) => {
      let digits = m.replace(/\D/g, "");
      if (digits.length === 12 || digits.length === 13) digits = digits.startsWith("55") ? digits.slice(2) : digits;
      if (digits.length === 8 || digits.length === 9) digits = `11${digits.length === 8 ? "9" : ""}${digits}`;
      if (digits.length === 10) digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
      const e164 = normalizeBrazilPhone(digits);
      if (!e164) return m;
      const n = e164.slice(3);
      return `${n.slice(0, 2)} ${n.slice(2, 7)}-${n.slice(7)}`;
    })
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .replace(/^['"`\s]+/, "")
    .trim()
    // "Alison (pai) / 11 96305-5033": a phone-only segment belongs to the name before it
    .split(" / ")
    .reduce<string[]>((acc, seg) => {
      const phoneOnly = /^\d{2} \d{5}-\d{4}$/.test(seg);
      const prev = acc[acc.length - 1];
      if (phoneOnly && prev && !/\d{5}-\d{4}/.test(prev)) acc[acc.length - 1] = `${prev} ${seg}`;
      else acc.push(seg);
      return acc;
    }, [])
    .join(" / ");
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function labelsToIds(list: OptionList, v: unknown, current: string[] = []): { ids: string[]; unmatched: string[] } {
  const ids = new Set(current.filter((id) => list.byId.has(id)));
  const unmatched: string[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item !== "string") continue;
      const id = list.byLabel.get(item.trim().toLowerCase());
      if (id) ids.add(id);
      else if (item.trim()) unmatched.push(item.trim());
    }
  }
  return { ids: [...ids], unmatched };
}

function toMedications(v: unknown, current: Medication[] = []): Medication[] {
  const out: Medication[] = [];
  const seen = new Set<string>();
  const push = (m: Medication) => {
    const k = m.name.toLowerCase();
    if (!m.name || seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  if (Array.isArray(v)) {
    for (const raw of v) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const times = Array.isArray(m.times) ? [...new Set((m.times as unknown[]).filter((t): t is string => typeof t === "string" && TIME_RE.test(t)))].sort().slice(0, MEDICATION_TIMES_MAX) : [];
      push({ name: str(m.name, 120), dose: str(m.dose, 120), times, asNeeded: m.asNeeded === true || (times.length === 0 && m.asNeeded !== false), notes: str(m.notes, 300) });
    }
  }
  // anything the model dropped from the form is kept
  for (const m of current) push(m);
  return out.slice(0, MEDICATIONS_MAX);
}

/** 28.5 | "28,5" | "30kg" → 28.5; anything outside 5–200 kg → null */
function toWeight(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".").replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n >= 5 && n <= 200 ? Math.round(n * 10) / 10 : null;
}

/** normalized key for dedupe: lower-case, accents/punctuation/spaces stripped (phones compare by their digits) */
function dedupeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Union of `current` and `next` segment by segment, keeping the first spelling
 * of each and never repeating one already present. A segment is a duplicate
 * when its normalized key matches (so a reformatted phone or a re-accented name
 * doesn't come back twice). This also absorbs the case where the model, told to
 * echo the current value, returns it again slightly reworded.
 *
 * `sep` is how the field lists several entries: " / " for the emergency contact
 * (so each contact dedupes on its own), newline for everything else.
 */
function mergeText(current: string, next: string, max: number, sep: "\n" | " / " = "\n"): string {
  const parts = sep === "\n" ? /\n/ : /\s*\/\s*/;
  const split = (s: string) =>
    s
      .split(parts)
      .map((x) => x.trim())
      .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of [...split(current), ...split(next)]) {
    const k = dedupeKey(seg);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(seg);
  }
  return out.join(sep).slice(0, max);
}

/** normalized keys of everything already filed (except one leftover), so repeats can be cut from that leftover */
function filedKeys(f: CamperNotesFields, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>, except: "generalNotes" | "healthNotes"): Set<string> {
  const keys = new Set<string>();
  const add = (v: unknown) => {
    const segs = typeof v === "string" ? v.split("\n").map((x) => x.trim()).filter(Boolean) : [];
    for (const s of segs) {
      const k = dedupeKey(s);
      if (k) keys.add(k);
    }
  };
  const label = (list: OptionList, id: string) => list.byId.get(id) ?? "";
  for (const id of f.allergies) add(label(lists.allergies, id));
  for (const id of f.drugAllergies) add(label(lists.drugAllergies, id));
  for (const id of f.healthIssues) add(label(lists.healthIssues, id));
  for (const m of f.medications) { add(m.name); add(m.dose); add(m.notes); }
  add(f.foodRestrictions);
  if (except !== "healthNotes") add(f.healthNotes);
  add(f.bedroomPreference);
  add(f.emergencyContact);
  if (f.weightKg != null) add(String(f.weightKg));
  add(f.insurance);
  add(f.insuranceCard);
  add(f.cpf);
  add(f.rg);
  add(f.school);
  add(f.schoolGrade);
  add(f.church);
  add(f.invitedBy);
  add(f.guardianName);
  add(f.guardianPhone);
  add(f.guardianCpf);
  add(f.guardianEmail);
  if (except !== "generalNotes") add(f.generalNotes);
  return keys;
}

/** drops leftover lines that say exactly what another field already holds ("Asma desde os 3 anos" stays: it adds facts) */
function dropFiledLines(leftover: string, filed: Set<string>): string {
  return leftover
    .split("\n")
    .map((x) => x.trim())
    .filter((line) => line && !filed.has(dedupeKey(line)))
    .join("\n");
}

export function normalizeNotesAnswer(raw: unknown, input: CamperNotesInput, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>): CamperNotesFields {
  const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const subject = input.subject ?? "camper";
  // the leftover box IS the text being sorted: never merge its old content back
  const cur = { ...input.current, [LEFTOVER_FIELD[subject]]: "" };
  const out = normalizeAll(a, cur, lists);
  // a fact already filed must not linger in the leftovers, even reworded identically by the model
  out.generalNotes = dropFiledLines(out.generalNotes, filedKeys(out, lists, "generalNotes"));
  out.healthNotes = dropFiledLines(out.healthNotes, filedKeys(out, lists, "healthNotes"));
  // fields the subject doesn't have never leave the server (the model was told not to use them; belt and braces)
  const blank: CamperNotesFields = { allergies: [], drugAllergies: [], healthIssues: [], neurodivergent: false, medications: [], foodRestrictions: "", healthNotes: "", bedroomPreference: "", emergencyContact: "", weightKg: null, insurance: "", insuranceCard: "", cpf: "", rg: "", school: "", schoolGrade: "", church: "", invitedBy: "", guardianName: "", guardianPhone: "", guardianCpf: "", guardianEmail: "", generalNotes: "" };
  const allowed = new Set(SUBJECT_FIELDS[subject]);
  return Object.fromEntries((Object.keys(blank) as FieldKey[]).map((k) => [k, allowed.has(k) ? out[k] : blank[k]])) as unknown as CamperNotesFields;
}

function normalizeAll(a: Record<string, unknown>, cur: Partial<CamperNotesFields>, lists: Record<"allergies" | "drugAllergies" | "healthIssues", OptionList>): CamperNotesFields {
  const allergies = labelsToIds(lists.allergies, a.allergies, cur.allergies);
  const drugAllergies = labelsToIds(lists.drugAllergies, a.drugAllergies, cur.drugAllergies);
  const healthIssues = labelsToIds(lists.healthIssues, a.healthIssues, cur.healthIssues);
  // labels the model made up outside the lists are not lost: they go to the health notes
  const extra = [...allergies.unmatched.map((x) => `Alergia: ${x}`), ...drugAllergies.unmatched.map((x) => `Alergia a medicamento: ${x}`), ...healthIssues.unmatched];
  let healthNotes = str(a.healthNotes, 1000);
  for (const line of extra) if (!healthNotes.toLowerCase().includes(line.toLowerCase().replace(/^.*?: /, ""))) healthNotes = mergeText(healthNotes, line, 1000);
  return {
    allergies: allergies.ids,
    drugAllergies: drugAllergies.ids,
    healthIssues: healthIssues.ids,
    neurodivergent: cur.neurodivergent === true || a.neurodivergent === true,
    medications: toMedications(a.medications, cur.medications),
    foodRestrictions: mergeText(cur.foodRestrictions ?? "", str(a.foodRestrictions, 1000), 1000),
    healthNotes: mergeText(cur.healthNotes ?? "", healthNotes, 1000),
    bedroomPreference: mergeText(cur.bedroomPreference ?? "", str(a.bedroomPreference, 120), 120).replace(/\n/g, ", "),
    emergencyContact: formatEmergencyContact(mergeText(cur.emergencyContact ?? "", str(a.emergencyContact, 120), 120, " / ")),
    // single-value fields: the observations are the latest word, so the model's answer replaces what the form had
    weightKg: toWeight(a.weightKg) ?? cur.weightKg ?? null,
    insurance: str(a.insurance, 120) || cur.insurance?.trim() || "",
    insuranceCard: str(a.insuranceCard, 120) || cur.insuranceCard?.trim() || "",
    // identity fields: the observations are the latest word, so the model's answer replaces what the form had
    cpf: formatCpf(str(a.cpf, 40) || cur.cpf?.trim() || ""),
    rg: str(a.rg, 40) || cur.rg?.trim() || "",
    school: str(a.school, 120) || cur.school?.trim() || "",
    schoolGrade: str(a.schoolGrade, 60) || cur.schoolGrade?.trim() || "",
    church: str(a.church, 120) || cur.church?.trim() || "",
    invitedBy: str(a.invitedBy, 120) || cur.invitedBy?.trim() || "",
    guardianName: str(a.guardianName, 120) || cur.guardianName?.trim() || "",
    guardianPhone: formatEmergencyContact(str(a.guardianPhone, 40)) || cur.guardianPhone?.trim() || "",
    guardianCpf: formatCpf(str(a.guardianCpf, 40) || cur.guardianCpf?.trim() || ""),
    guardianEmail: str(a.guardianEmail, 160).toLowerCase() || cur.guardianEmail?.trim() || "",
    generalNotes: str(a.generalNotes, 1000),
  };
}

// ── gateway call ───────────────────────────────────────────────────────

/** fast mode on the Messages API is still behind a beta flag */
const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

export interface RawNotesCall {
  ok: boolean;
  json?: unknown;
  usage: { promptTokens: number; completionTokens: number };
  error?: string;
  ms: number;
}

/** one model, one shot: returns the parsed JSON object or an error */
export async function callNotesModel(
  model: NotesModel,
  system: string,
  user: string,
  opts: { signal?: AbortSignal; reasoningEffort: NotesModeConfig["reasoningEffort"]; speed?: NotesModeConfig["speed"]; timeoutMs: number },
): Promise<RawNotesCall> {
  const { signal } = opts;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  const usage = { promptTokens: 0, completionTokens: 0 };
  try {
    // xAI and the rest 400 on the speed flags, so only the two vendors that have one get it
    const fast = opts.speed === "fast";
    const fastOpenai = fast && model.vendor === "openai";
    const fastAnthropic = fast && model.vendor === "anthropic";
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.ai.apiKey}`,
        ...(fastAnthropic ? { "anthropic-beta": ANTHROPIC_FAST_BETA } : {}),
      },
      body: JSON.stringify({
        model: model.id,
        temperature: 0,
        // live: the form waits on this, keep it short; bulk: nobody waits, think it through
        reasoning_effort: opts.reasoningEffort,
        ...(fastOpenai ? { service_tier: "fast" } : {}),
        ...(fastAnthropic ? { speed: "fast" } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      return { ok: false, usage, error: `http ${res.status} ${detail}`, ms: Date.now() - started };
    }
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
    usage.promptTokens = data?.usage?.prompt_tokens ?? 0;
    usage.completionTokens = data?.usage?.completion_tokens ?? 0;
    const content = data?.choices?.[0]?.message?.content ?? "";
    const text = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) return { ok: false, usage, error: `no json: ${text.slice(0, 120)}`, ms: Date.now() - started };
    try {
      return { ok: true, json: JSON.parse(text.slice(start, end + 1)), usage, ms: Date.now() - started };
    } catch {
      return { ok: false, usage, error: `bad json: ${text.slice(0, 120)}`, ms: Date.now() - started };
    }
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return { ok: false, usage, error: aborted ? (signal?.aborted ? "cancelled" : "timeout") : "unreachable", ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Runs the mode's model chain (first that answers wins); `null` when every
 * model failed or the caller cancelled.
 *
 *   mode "live" (default) — form: Opus 5 → GPT 5.6 Terra → Grok 4.5, low effort, 40 s each.
 *   mode "bulk"           — import script: Grok 4.6 → Fable 5.1 → GPT 5.6, high effort, 3 min each.
 *
 * `opts.models` overrides the chain (the prompt lab uses it to run one model at a time).
 */
export async function sortCamperNotes(
  input: CamperNotesInput,
  opts: { mode?: NotesMode; signal?: AbortSignal; models?: NotesModel[]; onAttempt?: (model: string, r: RawNotesCall) => void } = {},
): Promise<CamperNotesResult | null> {
  const mode = opts.mode ?? "live";
  const cfg = NOTES_MODES[mode];
  const lists = await optionLists();
  const system = notesSystemPrompt(mode, { allergies: lists.allergies.labels, drugAllergies: lists.drugAllergies.labels, healthIssues: lists.healthIssues.labels }, input.subject ?? "camper");
  const user = userMessage(input, lists);
  const failed: string[] = [];
  for (const m of opts.models ?? cfg.models) {
    if (opts.signal?.aborted) return null;
    const r = await callNotesModel(m, system, user, { signal: opts.signal, reasoningEffort: cfg.reasoningEffort, speed: cfg.speed, timeoutMs: cfg.timeoutMs });
    opts.onAttempt?.(m.id, r);
    if (r.ok) return { fields: normalizeNotesAnswer(r.json, input, lists), model: m.id, vendor: m.vendor, usage: r.usage, failed };
    if (r.error === "cancelled") return null;
    failed.push(m.id);
  }
  return null;
}
