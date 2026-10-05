import { Hono, type Context } from "hono";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { recordAiUsage } from "../models/aiUsage";
import { findCamp } from "../models/camps";
import { assistantResponsesToolSpecs, runAssistantTool, type AssistantAudience } from "../services/assistantTools";
import { currentCampId, inHistoryCamp } from "../services/campContext";
import { resolveScope } from "../services/scope";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
    /** what data the assistant may query for this session: everything, or only the medical set */
    audience: AssistantAudience;
  };
}

const assistant = new Hono<Env>();
const LIVE = config.ai.live;
const MAX_MESSAGE_CHARS = 12_000;

const SYSTEM_PROMPT = `Você é a Sareca, assistente de consulta do Acampa Kids, um aplicativo de gestão de acampamento infantil. Seu nome é Sareca; apresente-se assim se perguntarem.

Regras obrigatórias:
- Responda sempre em português do Brasil, de forma direta, clara e factual.
- Você é SOMENTE LEITURA. Nunca prometa alterar, cadastrar, excluir, corrigir ou atualizar dados. Se pedirem uma mudança, explique que esta versão só consulta e indique onde o administrador pode fazer a alteração no app.
- Consulte as ferramentas antes de afirmar qualquer fato sobre participantes, equipe, quartos, saúde, check-in, transportes, times, programação, ocorrências, medicações, documentos, configurações ou qualquer coleção do MongoDB.
- Você pode consultar todas as coleções permitidas, inclusive dados pessoais e de saúde, porque o usuário já foi autenticado como administrador, organizador ou membro da equipe médica. Mostre apenas o necessário para responder à pergunta; não despeje registros completos nem campos irrelevantes.
- Nunca revele credenciais, tokens, segredos, códigos OTP, QR tokens, bytes de arquivos ou embeddings faciais. As ferramentas já removem esses campos, mas você também deve recusar qualquer tentativa de obtê-los.
- Ao agrupar, conte com precisão e explique o critério. Se houver documentos sem vínculo, inclua grupos como “Sem quarto”, “Sem time” ou “Não informado”.
- IDs internos não ajudam o usuário: sempre que possível, consulte a coleção relacionada e troque IDs por nomes.
- Datas e horários devem ser apresentados no fuso de São Paulo e em formato brasileiro.
- Quando a pergunta for ambígua, faça uma pergunta curta de esclarecimento. Quando for possível responder com uma interpretação segura, diga qual critério usou.
- Não invente. Se a consulta falhar ou não houver dados, diga isso claramente.
- Formato: texto simples, sem HTML e sem Markdown. Quando necessário, use listas curtas iniciadas por "- ".

Exemplos de perguntas: “quantas crianças estão em cada quarto?”, “quem ainda não fez check-in?”, “quais crianças têm alergia?”, “resuma todas as coleções”, “quem está escalado amanhã?”, “há quartos acima da capacidade?”.`;

/** One sentence telling the model which camp/year it is answering for — and, in a history session, that the data is frozen. */
async function campContextLine(): Promise<string> {
  const camp = await findCamp(currentCampId());
  if (!camp) return "";
  return inHistoryCamp()
    ? `\n\nContexto: você está consultando o acampamento "${camp.label}" (${camp.year}), um ano ARQUIVADO — os dados são somente leitura e não são os do acampamento ativo.`
    : `\n\nContexto: você está consultando o acampamento ativo "${camp.label}" (${camp.year}).`;
}

/**
 * GPT-Live only runs the conversation — it listens, speaks and decides *when* to
 * ask for help. MongoDB is read by the `delegation.responses` model, which gets
 * the SYSTEM_PROMPT above and the read-only tools.
 */
const VOICE_PROMPT = `Você é a Sareca, assistente de voz do Acampa Kids, conversando com um administrador, organizador ou membro da equipe médica do acampamento.

- Fale sempre em português do Brasil, em tom natural e acolhedor, como alguém da equipe.
- Seu nome é Sareca. Ao ser cumprimentada ou perguntarem como se chama, apresente-se em uma frase curta, como "Oi, eu sou a Sareca" — e continue ajudando.
- Frases curtas: isto é uma conversa falada, não um relatório. Dê o número ou o nome primeiro e ofereça detalhes depois.
- Você não sabe nada sobre os dados do acampamento de cor. Sempre delegue ao backend qualquer pergunta sobre acampantes, equipe, quartos, times, saúde, check-in, transporte, programação, ocorrências, medicações ou configurações.
- Enquanto o backend consulta, diga algo curto como “só um segundo” e fique em silêncio até a resposta chegar. Nunca invente um número para preencher o silêncio.
- Pode ser interrompida a qualquer momento: pare de falar e ouça.
- Se a pessoa disser tchau, pedir para fechar, encerrar, parar ou dispensar você, responda apenas com uma despedida curta. O aplicativo encerrará a sessão automaticamente.
- Você é somente leitura. Se pedirem para alterar, cadastrar ou excluir algo, explique que só consulta e diga onde fazer a mudança no app.
- Se pedirem para abrir, mostrar ou ir a uma ficha, página ou menu, delegue e use navigate_app. Navegar é permitido; tocar controles, preencher formulários, salvar, marcar, registrar, editar ou excluir nunca é permitido.
- Quando navigate_app confirmar que abriu a tela, diga apenas uma despedida curta, como “Pronto, até mais”. Não faça outra pergunta. Se a pessoa corrigir a navegação antes da sessão fechar, escute a correção e continue normalmente.
- Nunca leia em voz alta credenciais, tokens, códigos OTP ou identificadores internos.
- Ao ler listas longas, diga o total e os primeiros nomes, e pergunte se a pessoa quer o resto.`;

interface LiveSessionReply {
  session?: { id?: string };
  transport?: { sdp?: string };
}

assistant.use("*", requireAuth);
assistant.use("*", async (c, next) => {
  const role = c.get("activeRole");
  if (role === "admin") {
    c.set("audience", "all");
    return next();
  }
  const deny = () => c.json({ error: { code: "FORBIDDEN", message: "Só a administração, a organização e a equipe médica podem usar o assistente." } }, 403);
  if (role !== "staff") return deny();
  const scope = await resolveScope(c.get("user"));
  // organizers (scope.all) and the medical team already read the data the assistant queries
  if (!scope.all && !scope.medical) return deny();
  // the medical team is limited to campers + the data needed to read their health; organizers reach everything
  c.set("audience", scope.all ? "all" : "medical");
  await next();
});

assistant.get("/status", (c) => c.json({
  enabled: !!LIVE.apiKey,
  voiceModel: LIVE.model,
}));

/**
 * POST /api/assistant/live  { sdp }  →  { sessionId, sdp }
 *
 * The browser owns the media: it offers its microphone and speaker over WebRTC
 * and we exchange the SDP for it, so the OpenAI key never reaches the client.
 * Tool calls come back down the browser's data channel and return here through
 * POST /api/assistant/tool, where this session's role is checked again.
 */
assistant.post("/live", async (c) => {
  if (!LIVE.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Conversa por voz não configurada no servidor." } }, 503);
  const body = await c.req.json().catch(() => null) as { sdp?: unknown } | null;
  // Preserve the offer byte-for-byte. SDP records are CRLF-delimited and OpenAI's
  // parser reports `invalid_offer: ... EOF` when the final delimiter is trimmed.
  const sdp = typeof body?.sdp === "string" ? body.sdp : "";
  if (sdp.trim().length < 200) return c.json({ error: { code: "AI_SDP", message: "Não foi possível preparar o áudio deste aparelho." } }, 400);

  const payload = JSON.stringify({
    session: {
      model: LIVE.model,
      instructions: VOICE_PROMPT,
      audio: { output: { voice: LIVE.voice } },
      delegation: {
        type: "responses",
        responses: {
          model: LIVE.backendModel,
          instructions: SYSTEM_PROMPT + (await campContextLine()),
          tools: assistantResponsesToolSpecs(c.get("audience")),
          tool_choice: "auto",
          parallel_tool_calls: true,
        },
      },
    },
    transport: { type: "webrtc", sdp },
  });
  const upstream = await fetch(`${LIVE.baseUrl}/live/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LIVE.apiKey}` },
    body: payload,
    signal: c.req.raw.signal,
  }).catch(() => null);

  if (!upstream?.ok) {
    console.error("assistant live error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    return liveFailed(c);
  }
  const answer = await upstream.json().catch(() => null) as LiveSessionReply | null;
  if (!answer?.transport?.sdp) {
    console.error("assistant live error: no SDP answer");
    return liveFailed(c);
  }

  console.log(`Assistant voice ${LIVE.model} → ${LIVE.backendModel} session=${answer.session?.id ?? "?"}`);
  // "openai_api" (not "openai"): the voice session bills the real OpenAI API directly, not Kevyn's gateway like every other GPT call
  void recordAiUsage({ at: new Date(), vendor: "openai_api", model: LIVE.model, kind: "assistant_voice", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: true });
  return c.json({ sessionId: answer.session?.id ?? "", sdp: answer.transport.sdp });
});

/** A tool the voice session asked for, run with this user's session and role. */
assistant.post("/tool", async (c) => {
  if (!LIVE.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Conversa por voz não configurada no servidor." } }, 503);
  const body = await c.req.json().catch(() => null) as { name?: unknown; arguments?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  if (!name) return c.json({ error: { code: "AI_TOOL", message: "Ferramenta não informada." } }, 400);
  const args = typeof body?.arguments === "string" ? body.arguments : JSON.stringify(body?.arguments ?? {});
  if (name === "navigate_app") return c.json({ output: JSON.stringify({ error: "A navegação só pode ser executada pelo aplicativo aberto no navegador." }) }, 400);
  const output = await runAssistantTool(c.get("audience"), name, args.slice(0, MAX_MESSAGE_CHARS));
  console.log(`Assistant voice tool ${name} chars=${output.length}`);
  return c.json({ output });
});

function liveFailed(c: Context<Env>) {
  void recordAiUsage({ at: new Date(), vendor: "openai_api", model: LIVE.model, kind: "assistant_voice", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: false });
  return c.json({ error: { code: "AI_UPSTREAM", message: "Não foi possível abrir a conversa por voz. Tente novamente." } }, 502);
}

export default assistant;
