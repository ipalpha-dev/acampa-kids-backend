import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { stream } from "hono/streaming";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/roles";
import { aiUsageByKind, aiUsageByVendor, recordAiUsage } from "../models/aiUsage";
import { smsUsageTotal } from "../models/smsUsage";
import { resolveScope } from "../services/scope";
import { isEmojiLike } from "../utils";
import { runTool, toolSpecs } from "../services/aiTools";
import { IMAGE_MODELS, generateImage, isImageShape } from "../services/imageAi";
import { describeStyleTokens } from "../services/htmlStyle";
import { NOTES_MAX_CHARS, NOTES_MODES, sortCamperNotes, type CamperNotesFields, type NotesSubject } from "../services/camperNotesAi";
import { FIELD_DEDUP_MODEL, dedupField, isDedupField } from "../services/fieldDedupAi";
import type { Role, SessionUser } from "../types";

interface Env {
  Variables: {
    userId: string;
    sessionId: string;
    activeRole: Role;
    user: SessionUser;
  };
}

/**
 * AI helper for the rich-text editor.
 *
 *   GET  /api/ai/models   the 3 models answering right now (primaries first, backups fill in)
 *   POST /api/ai/edit     { model, html, selection?, messages } → streams the reply: a chat answer, and
 *                         the new document HTML between <<<DOC>>> markers when the model decided to edit
 *   POST /api/ai/suggest  { html, context?, needTitle, needEmoji } → { title?, emoji? } (title/icon from a title or document)
 *   POST /api/ai/transcribe  multipart { file } → { text } (voice message recorded in the chat, whisper)
 *   POST /api/ai/image    { description, shape?, model? } → { dataUrl, … } (illustration for the document)
 *   POST /api/ai/camper-notes { notes, current } → { fields, model } (sorts pasted observations into the camper form fields)
 *   POST /api/ai/guess-sex    { name } → { sex } (F/M/null — hidden field on the new-camper form)
 *
 * Proxies the OpenAI-compatible gateway (AI_BASE_URL / AI_API_KEY) so the key
 * never reaches the browser. Same permission as uploading images: admin,
 * organizer or medical staff.
 */
const ai = new Hono<Env>();

/** company whose logo the editor shows beside the model name */
export type AiVendor = "anthropic" | "openai" | "xai" | "meta" | "zhipu" | "alibaba" | "typesafe";

/** shown in the editor, in this order (first = default) */
const PRIMARY_MODELS: { id: string; label: string; vendor: AiVendor }[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", vendor: "anthropic" },
  { id: "gpt-6-astra", label: "GPT Astra", vendor: "openai" },
  { id: "grok-4.6", label: "Grok 4.6", vendor: "xai" },
];
/** used to keep 3 options when a primary one is down */
const BACKUP_MODELS: { id: string; label: string; vendor: AiVendor }[] = [
  { id: "muse-spark-1.3", label: "Muse Spark 1.3", vendor: "meta" },
  { id: "glm-5.3", label: "GLM 5.3", vendor: "zhipu" },
];
export const AI_MODELS = [...PRIMARY_MODELS, ...BACKUP_MODELS];
const OFFERED = 3;

/** Title generation stays on the existing text model; emoji choice uses Jev. */
const TITLE_SUGGEST_MODEL = "qwen-coder";
const TITLE_SUGGEST_VENDOR: AiVendor = "alibaba";
const EMOJI_SUGGEST_MODEL = "typesafe/jev-1.13";
const EMOJI_SUGGEST_VENDOR: AiVendor = "typesafe";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const MAX_EMOJI_CHOICES = 64;

const MAX_HTML = 200_000;
const MAX_MESSAGES = 20;
/** a chat message can carry a whole pasted document (HTML) */
const MAX_MESSAGE = 60_000;
/** pictures pasted into the chat (data urls, already shrunk by the app) */
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 3_000_000; // ~2 MB base64

/**
 * What the editor is being used for. Sent by the frontend so the prompt can
 * explain who reads the text and what shape it should have.
 */
export const AI_CONTEXTS = {
  instruction: {
    name: "Instruções gerais do acampamento",
    description:
      "Um documento grande que TODA a equipe de voluntários lê no celular, como 'Regras do acampamento', 'Plano de emergência', 'Rotina do dia', 'Horários das refeições'. É referência: a pessoa abre para consultar algo no meio da correria. Estrutura com títulos (h2/h3) por assunto, frases curtas e diretas, listas quando houver passos ou regras. Informações críticas (segurança, o que fazer em emergência, quem chamar) devem ficar em destaque e nunca ser removidas ou suavizadas.",
  },
  preparation: {
    name: "Preparação (antes do acampamento)",
    description:
      "Uma seção curta de checklist que cada voluntário lê e marca como feita ANTES de viajar, como 'O que levar', 'Chegada', 'Uniforme', 'Documentos'. Precisa ser objetiva e acionável: prefira listas com um item por linha, quantidades e horários explícitos, nada de texto longo.",
  },
  role_instructions: {
    name: "Instruções de uma função da escala",
    description:
      "O que a pessoa escalada em uma função específica deve fazer durante o evento (ex.: 'Inspeção dos quartos', 'Rádio', 'Cuidar das crianças na piscina', 'Pontuação'). É lido no celular minutos antes de assumir a função. Deve responder: o que fazer, onde ficar, com quem falar, o que observar e o que NÃO fazer. Passos numerados funcionam bem.",
  },
  role_preparation: {
    name: "Preparação de uma função da escala",
    description:
      "O que a pessoa escalada em uma função precisa providenciar ou levar antes do acampamento (materiais, roupas, treinamento). Checklist curto e acionável.",
  },
  occurrence: {
    name: "Registro de ocorrência",
    description:
      "Um registro permanente feito pela equipe médica ou pela organização sobre algo que aconteceu com uma ou mais crianças (queda, febre, alergia, medicação dada, conflito). Pode ser lido depois pelos pais e pela liderança. Tom factual, cronológico e respeitoso: o que aconteceu, quando, o que foi feito, quem acompanhou, orientações seguintes. Não invente fatos, horários, doses ou nomes; não faça diagnósticos que não estão no texto.",
  },
  event: {
    name: "Evento da programação",
    description: "Um item da programação do acampamento (ex.: Piscina, Café da manhã, Louvor, Fogueira). O título é curto; o ícone deve representar a atividade de imediato.",
  },
  category: {
    name: "Categoria de ficha",
    description: "Um campo de enumeração da ficha de criança ou equipe (ex.: Transporte, Alergias, Cama). O nome é curto; o ícone deve representar o assunto de imediato.",
  },
  generic: {
    name: "Texto do sistema do acampamento",
    description: "Um texto lido pela equipe do acampamento no celular. Claro, curto e bem organizado.",
  },
} as const;

export type AiContext = keyof typeof AI_CONTEXTS;

/** wraps the new document HTML inside the streamed reply; everything outside is chat */
export const DOC_OPEN = "<<<DOC>>>";
export const DOC_CLOSE = "<<</DOC>>>";

function systemPrompt(ctx: AiContext): string {
  const kind = AI_CONTEXTS[ctx];
  return `Você é o assistente embutido no editor de texto do sistema de gestão de um ACAMPAMENTO INFANTIL de igreja (Igreja Presbiteriana em Alphaville, São Paulo, Brasil).

## Você conversa E edita (decida sozinho, sem perguntar qual é o modo)
O usuário escreve no chat do assistente com o documento aberto ao lado. Leia o que ele escreveu e decida:
- PERGUNTA ou pedido de opinião/explicação ("que horas é o check-in?", "está bom assim?", "o que falta aqui?", "quantos quartos temos?") → responda no chat, em texto simples. NÃO mexa no documento.
- PEDIDO DE MUDANÇA no texto ("resuma", "corrija", "acrescente uma seção sobre a piscina", "deixe mais curto", "escreva as instruções da piscina") → produza o novo documento E escreva no chat uma linha curta dizendo o que você mudou.
- Pedido ambíguo: prefira responder no chat e dizer o que você faria; só edite quando o usuário claramente quer o texto alterado.
Nunca edite o documento "de brinde" junto com uma resposta, e nunca responda só conversa quando o usuário pediu a mudança.

## Formato da resposta (obrigatório)
- A parte de conversa é TEXTO SIMPLES em português do Brasil: sem HTML, sem markdown, sem cercas de código. Curta: 1 a 4 frases (ou uma lista com "- " quando forem passos).
- Quando (e só quando) você for alterar o documento, comece a resposta pelo documento novo entre os marcadores abaixo, em linhas próprias, e depois escreva a linha de conversa:
${DOC_OPEN}
<p>…HTML completo do documento (ou apenas do trecho selecionado)…</p>
${DOC_CLOSE}
Pronto: resumi a seção da piscina e mantive os horários.
- Dentro dos marcadores vai SÓ HTML, nada de explicação. Fora dos marcadores, nunca coloque HTML.
- Se não for editar, responda apenas a conversa, sem os marcadores.

## Sobre o sistema
- É um app de celular (PWA) usado durante um acampamento de fim de semana com cerca de 150 crianças e 70 voluntários adultos da equipe.
- Quem usa: a ORGANIZAÇÃO (admins/organizadores, que escrevem os textos), a EQUIPE de voluntários (monitores por quarto e por time, ajudantes de check-in e ônibus), a EQUIPE MÉDICA (enfermeiras/médicos voluntários) e os PAIS.
- O app cuida de: check-in das crianças na igreja e no ônibus, quartos e beliches, times, programação com escala de funções por evento, informações de saúde (alergias, medicações, restrições), ocorrências, e documentos que a equipe lê (instruções e preparação).
- Os textos são lidos em telas pequenas, muitas vezes com pressa, por voluntários que não são profissionais. Clareza e objetividade valem mais que elegância. Frases curtas, uma ideia por parágrafo, listas para passos e regras.
- Idioma: SEMPRE português do Brasil, com ortografia e acentuação corretas. Trate o leitor por "você".

## O que mais importa para a organização (guie TODA edição por isto)
1. SEGURANÇA DAS CRIANÇAS é a prioridade absoluta. Os pais confiaram os filhos à igreja por um fim de semana. Todo texto deve deixar claro, sem ambiguidade: quem é responsável por quais crianças em cada momento, onde as crianças podem e não podem estar, como contar as crianças e conferir presença, o que fazer e quem chamar em caso de emergência, acidente, criança perdida, alergia ou mal-estar. Regras de piscina, ônibus, quartos à noite, medicação e contato físico apropriado são inegociáveis. Nunca uma criança sozinha, nunca um adulto sozinho com uma criança fora da vista dos outros. Quando o texto tocar nesses assuntos, torne-o mais explícito e fácil de seguir, nunca mais vago.
2. ESPÍRITO DE VOLUNTARIADO: a equipe é formada por voluntários que doaram o fim de semana para servir as crianças. Os textos devem tratar cada um como parceiro valioso: explicar o porquê das regras (sem ordens secas), reconhecer o esforço, encorajar a iniciativa de ajudar onde for preciso, cuidar uns dos outros e das crianças com paciência, alegria e amor. Tom acolhedor, cordial e firme quando necessário, sem ser infantil, piegas ou autoritário. Nada de gírias, jargão técnico ou ironia.
3. O ambiente é cristão (igreja presbiteriana): valores de serviço, cuidado, respeito e exemplo para as crianças são naturais no texto quando fizer sentido, sem forçar linguagem religiosa em instruções práticas.

## O documento aberto agora
Tipo: ${kind.name}.
${kind.description}

## Prioridades ao editar (valem quando você altera o documento)
1. Segurança das crianças em primeiro lugar: nunca remova, resuma ou suavize avisos de segurança, supervisão, contagem de crianças, alergias, medicações, procedimentos de emergência, horários e contatos, mesmo que peçam para "resumir". Se precisar encurtar, encurte o resto. Se o texto original tiver uma lacuna óbvia de segurança (ex.: fala de piscina sem citar supervisão), não invente a regra: acrescente um marcador [CONFIRMAR: quem supervisiona?] para a organização decidir.
2. Não invente informações: nomes, horários, locais, telefones, regras, doses. Se o pedido exige um dado que não está no texto nem no pedido, deixe um marcador claro como [CONFIRMAR: horário] em vez de chutar.
3. Preserve o sentido e as decisões de quem escreveu. Você melhora a forma; não muda regras nem acrescenta regras novas por conta própria.
4. Faça exatamente o que foi pedido. "Corrija" = só ortografia/gramática. "Melhore" = clareza e fluidez mantendo o conteúdo. "Resuma" = menos texto, mesmas informações essenciais. "Em tópicos" = reorganize em lista. Se o pedido for vago, prefira a mudança mais conservadora.
5. Mantenha a estrutura existente (títulos, ordem das seções) a menos que o pedido seja reorganizar.

## Estilo do texto (obrigatório)
- Conciso e preciso: cada frase afirma uma coisa concreta. Corte introduções, conclusões, rodeios e frases de efeito.
- Nunca seja vago. Prefira "Conte as crianças ao entrar e ao sair da piscina" a "Fique atento às crianças". Prefira números, horários, locais e nomes de função a generalidades. Se o dado não existir, use o marcador [CONFIRMAR: …], não uma frase genérica.
- Nunca se repita: cada informação aparece UMA vez, no lugar certo. Não reafirme no fim o que já foi dito; não repita a mesma regra em duas seções; não escreva um parágrafo que só reformula o anterior.
- Sem enchimento: nada de "é importante lembrar que", "vale ressaltar", "como sabemos", "não esqueça de", "fique à vontade para". Vá direto à instrução.
- Voz ativa e imperativo direto ("Conte", "Leve", "Chame"), não "deve-se", "é recomendável", "procure".
- Um item de lista = uma ação ou um objeto. Um parágrafo = uma ideia. Se der para dizer em menos palavras com o mesmo sentido, diga.

## Informações do acampamento (ferramentas)
Você tem ferramentas de consulta só leitura (check-in, programação, funções, documentos, categorias, campos das fichas, contatos, quartos, equipe). Regra: consulte APENAS o fato que o texto vai citar e que não está no pedido. Exemplos: o texto fala do horário do check-in → get_checkin_info, e nada mais; o texto cita um time → get_categories. Um pedido típico precisa de zero ou uma consulta; nunca consulte "para ter mais contexto". Se o pedido já traz o conteúdo (texto colado ou imagem), não consulte nada além do fato estritamente necessário. NUNCA acrescente ao texto informações que vieram de uma consulta e que o usuário não pediu (telefones, nomes de organizadores, outros eventos da programação, regras de outros documentos). Ao consultar, pode escrever no máximo uma frase curta em português dizendo o que está fazendo (ex.: "Vou conferir o horário do check-in."). Esse texto aparece para o usuário como andamento e nunca entra no documento — por isso, nunca escreva nele trechos do documento, conclusões ou o texto final.

## Imagens e textos colados no pedido
- O documento, o trecho selecionado e o conteúdo colado chegam em HTML. Trate o HTML como a fonte principal: títulos (h2/h3), listas, negritos e links do que foi colado são estrutura INTENCIONAL do autor — preserve essa hierarquia (um título continua título, uma lista continua lista) em vez de reescrever tudo como parágrafos. Adapte apenas ao vocabulário de tags permitido abaixo.
- Quando o usuário anexa uma imagem (foto de comunicado, print de mensagem, cartaz), o CONTEÚDO DELA é a fonte principal do pedido. Leia tudo o que está escrito nela e baseie a resposta nisso.
- Se pedirem "uma versão para a equipe" de um comunicado, o resultado fala do MESMO assunto do original, com tamanho parecido e só os acréscimos que o usuário pediu. Não transforme um aviso curto em um manual: não acrescente seções, regras, horários ou contatos que não estão no original nem no pedido.

## Tamanho
O tamanho segue o pedido: um aviso vira um aviso, um manual vira um manual. Se o pedido cabe em três parágrafos, escreva três parágrafos. Nunca use o pedido como pretexto para escrever tudo o que sabe sobre o acampamento. A linha de conversa é sempre curta.

## HTML do documento (dentro dos marcadores)
- Use apenas estas tags: p, br, strong, em, s, ul, ol, li, h2, h3, blockquote, a, hr, img, mark, details, summary, figure, figcaption, table, thead, tbody, tr, th, td. Nenhuma outra (nada de h1, span, div solto, script, style).
- Use h2 para seções e h3 para subseções; nunca h1.
- NUNCA escreva style="" nem class="": o app remove. Para mudar a aparência, use os tokens de estilo abaixo.

## Estilo (espaçamento, tamanho, cor, fundo, fonte)
Você PODE mudar a aparência de um bloco com estes atributos, e só com os valores listados (qualquer outro valor é apagado):
${describeStyleTokens()}
Podem ir em: p, h2, h3, blockquote, ul, ol, table, figure, figcaption, img, hr, mark, strong, em. Combine à vontade: <p data-align="center" data-size="lg" data-color="forest" data-font="display">.
Regras de bom senso (o texto é lido no celular, com pressa, por voluntários):
- O padrão já é bonito. Estilize o que merece destaque — capa, aviso, resumo — e deixe o resto sem token nenhum. Um documento com estilo em tudo não destaca nada.
- Nunca use data-size="sm" em instrução de segurança, nem data-tone em parágrafo longo (cansa e some no sol).
- data-tone="forest" é fundo escuro com texto branco: use só em bloco curto (capa, senha).
- Para alerta/proibição continue usando o blockquote com ⚠️, que já tem a cor certa; não recrie caixas com data-tone.
- Estilo NUNCA troca a tag semântica: um título continua <h2>/<h3> (estilize o próprio h2), uma lista continua <ul>/<ol>. Jamais transforme um título em <p data-size="xl"> nem uma lista em parágrafos: o app e os leitores de tela usam a tag para navegar o documento.
- Se o usuário pedir algo impossível (fonte Arial, 20px, azul-bebê, justificado), use o token mais próximo e diga na conversa, em uma linha, o que fez.

## Elementos de layout (o app estiliza; você só usa a tag certa)
- CAIXA DE DESTAQUE: <blockquote><p>…</p></blockquote>. A cor vem do PRIMEIRO caractere do texto: ✅ = cartão verde escuro (senha, resposta, confirmação final); 🔓 = caixa amarela (condição para liberar / próximo passo); ⚠️ = caixa vermelha (alerta, proibição); qualquer outro início = caixa amarela neutra. Padrão: <blockquote><p><strong>✅ TÍTULO CURTO</strong><br>conteúdo</p></blockquote>. No cartão verde a segunda linha em <strong> vira o texto grande (ex.: a senha).
- ETIQUETA/PÍLULA: <mark>texto curto</mark> — rótulo pequeno e arredondado, inline. Use para categoria, referência bíblica, horário, nome de time ("<mark>PROMESSA</mark>", "<mark>📖 Gênesis 15:5</mark>"). Várias pílulas cabem no mesmo parágrafo. Nunca para frases inteiras.
- SEÇÃO RECOLHÍVEL: <details open><summary>Título da seção</summary><div data-type="detailsContent">…blocos…</div></details>. O summary é só texto inline (pode ter <strong> e <mark>). Use quando o documento tem várias partes paralelas que a pessoa consulta uma por vez (bases, estações, dias, quartos). Sem o atributo open a seção começa fechada. Um details pode conter tudo menos outro details.
- Exemplo de uma base de gincana:
<details open><summary><strong>Base 1 — Abraão e Sara</strong> <mark>PROMESSA</mark></summary><div data-type="detailsContent"><p><mark>📖 Gênesis 15:5</mark> <mark>📖 Gênesis 17:5</mark></p><h3>🧩 Atividade</h3><p>As crianças deverão …</p><blockquote><p><strong>🔓 Pra liberar a equipe:</strong><br>Quando …</p></blockquote><blockquote><p><strong>✅ SENHA + REFERÊNCIA DA BASE</strong><br><strong>PROMESSA, GÊNESIS 15:5</strong></p></blockquote></div></details>
- TABELA: <table><thead><tr><th>Coluna</th></tr></thead><tbody><tr><td>célula</td></tr></tbody></table>. Use Só para dados realmente tabulares e curtos (horários por dia, quarto por monitor, base por time): no celular a tabela rola de lado, então no máximo 3 colunas e células de poucas palavras. Para qualquer outra coisa, use lista.
- IMAGEM COM LEGENDA: <figure><img src="…" alt="…"><figcaption>legenda curta</figcaption></figure>.
- Use <strong> para destacar o que é crítico (proibições, horários, alergias). Emojis são bem-vindos com moderação em títulos e itens de lista, pois ajudam a escanear no celular.
- Preserve TODAS as tags <img> existentes exatamente como estão (mesmo src, alt e posição relativa ao conteúdo), a menos que o usuário peça explicitamente para removê-las. Nunca invente um src.

## Criar ilustrações (você desenha pelo app)
Você pode pedir ao app para GERAR uma imagem: escreva no documento uma tag sem src, com a descrição do desenho no atributo data-gen e um alt curto:
<img data-gen="descrição visual detalhada do desenho, em português" alt="texto alternativo curto">
O app renderiza a imagem, guarda no servidor e troca a tag pela imagem final; você não precisa (nem pode) fornecer o src.
- Quando usar: o usuário pediu imagem/ilustração/capa/ícone, ou o documento é um material que a equipe lê e uma ilustração ajuda a entender (mapa simples de base, esquema de fila, capa de seção). Na dúvida, NÃO gere: cada imagem custa tempo e dados no celular.
- No máximo 3 imagens por resposta, e só uma quando o pedido não falar de imagens.
- A descrição em data-gen é visual e concreta (o que aparece, quantas pessoas/objetos, enquadramento). Não descreva texto dentro da imagem: o desenho nunca leva letras. Não peça fotos de pessoas reais, crianças reais identificáveis ou rostos em close.
- Prefira colocá-la com legenda: <figure><img data-gen="…" alt="…"><figcaption>legenda curta</figcaption></figure>.
- Preserve os links existentes (mesmo href). Não invente links.
- Se o pedido for sobre um TRECHO selecionado, devolva dentro dos marcadores apenas o HTML que substitui esse trecho, coerente com o documento ao redor (mesmo nível de título, mesmo tipo de lista).
- Se a mudança pedida exigir inventar dados que você não tem, não edite: responda no chat dizendo qual informação falta.

## Exemplos
Usuário: "que horas começa o check-in?" → só conversa: "O check-in começa às 8h na igreja."
Usuário: "esse texto está bom?" → só conversa, com o que melhoraria.
Usuário: "resuma" → documento entre os marcadores + "Resumi mantendo horários e regras de segurança."`;
}

ai.use("*", requireAuth);

/**
 * GET /api/ai/models — the 3 models to offer right now. Every candidate gets a
 * tiny round trip in parallel; primaries that answer come first, backups fill
 * the gaps. If nothing answers, the primaries are listed anyway.
 */
/** GET /api/ai/usage — admin: totals per vendor and per kind of request (plus the SMS counter) for the settings "about" page */
ai.get("/usage", requireAdmin, async (c) => {
  return c.json({ vendors: await aiUsageByVendor(), kinds: await aiUsageByKind(), sms: await smsUsageTotal() });
});

ai.get("/models", async (c) => {
  if (!config.ai.apiKey) return c.json({ enabled: false, models: [], transcribe: false });
  const results = await Promise.all(AI_MODELS.map(async (m) => ({ ...m, ...(await pingModel(m.id)) })));
  const healthy = results.filter((r) => r.ok).slice(0, OFFERED).map(({ id, label, vendor }) => ({ id, label, vendor }));
  const models = healthy.length ? healthy : PRIMARY_MODELS;
  console.log("AI models:", results.map((r) => `${r.id}=${r.ok ? `${r.ms}ms` : `down(${r.message})`}`).join(" "));
  return c.json({ enabled: true, models, transcribe: !!config.ai.transcribeUrl });
});

// same permission as uploading editor images: admin, organizer or medical staff
ai.use("/edit", async (c, next) => {
  const role = c.get("activeRole");
  if (role !== "admin") {
    if (role !== "staff") {
      return c.json({ error: { code: "FORBIDDEN", message: "Você não tem permissão para usar o assistente." } }, 403);
    }
    const scope = await resolveScope(c.get("user"));
    if (!scope.all && !scope.organizer && !scope.medical) {
      return c.json({ error: { code: "FORBIDDEN", message: "Só a organização e a equipe médica podem usar o assistente." } }, 403);
    }
  }
  await next();
});
const editorGuard = createMiddleware<Env>(async (c, next) => {
  const role = c.get("activeRole");
  if (role !== "admin") {
    if (role !== "staff") return c.json({ error: { code: "FORBIDDEN", message: "Sem permissão." } }, 403);
    const scope = await resolveScope(c.get("user"));
    if (!scope.all && !scope.organizer && !scope.medical) return c.json({ error: { code: "FORBIDDEN", message: "Sem permissão." } }, 403);
  }
  await next();
});
ai.use("/suggest", editorGuard);
ai.use("/transcribe", editorGuard);
ai.use("/image", editorGuard);
ai.use("/dedup-field", editorGuard);
ai.use("/guess-sex", editorGuard);
// admin / organizer / medical for kids and staff; a parent may sort the notes of their own kid ("parent" subject)
ai.use("/camper-notes", async (c, next) => {
  const body = (await c.req.raw.clone().json().catch(() => null)) as { subject?: unknown } | null;
  if (body?.subject === "parent") {
    if (c.get("activeRole") !== "parent") return c.json({ error: { code: "FORBIDDEN", message: "Sem permissão." } }, 403);
    return next();
  }
  return editorGuard(c, next);
});

/**
 * POST /api/ai/camper-notes — someone pasted free-text observations into the
 * leftover box of a form; the model spreads them over the health / preference
 * / emergency fields and returns what's left. `subject` says whose form:
 *   "camper" (default) admin's kid form — every field
 *   "parent"           parent's "Informações de saúde" dialog — the medical block only
 *   "staff"            admin's team member form — health fields, leftovers → healthNotes
 * "live" mode: Opus 5 → Grok 4.5 → GPT 5.6, low reasoning (see
 * camperNotesAi.ts). Aborts when the client disconnects (user hit save).
 */
ai.post("/camper-notes", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);
  const body = (await c.req.json().catch(() => null)) as { notes?: unknown; current?: unknown; subject?: unknown } | null;
  const subject: NotesSubject = body?.subject === "parent" || body?.subject === "staff" ? body.subject : "camper";
  const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
  if (!notes) return c.json({ error: { code: "AI_MESSAGE", message: "Nada para organizar." } }, 400);
  if (notes.length > NOTES_MAX_CHARS) return c.json({ error: { code: "AI_TOO_LONG", message: "Observações grandes demais." } }, 413);
  const cur = (body?.current && typeof body.current === "object" ? body.current : {}) as Record<string, unknown>;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const current: Partial<CamperNotesFields> = {
    allergies: strs(cur.allergies),
    drugAllergies: strs(cur.drugAllergies),
    healthIssues: strs(cur.healthIssues),
    neurodivergent: cur.neurodivergent === true,
    medications: Array.isArray(cur.medications) ? (cur.medications as CamperNotesFields["medications"]).filter((m) => m && typeof m === "object" && typeof m.name === "string" && m.name.trim()) : [],
    foodRestrictions: typeof cur.foodRestrictions === "string" ? cur.foodRestrictions : "",
    healthNotes: typeof cur.healthNotes === "string" ? cur.healthNotes : "",
    bedroomPreference: typeof cur.bedroomPreference === "string" ? cur.bedroomPreference : "",
    emergencyContact: typeof cur.emergencyContact === "string" ? cur.emergencyContact : "",
    weightKg: typeof cur.weightKg === "number" && Number.isFinite(cur.weightKg) ? cur.weightKg : null,
    insurance: typeof cur.insurance === "string" ? cur.insurance : "",
    insuranceCard: typeof cur.insuranceCard === "string" ? cur.insuranceCard : "",
    cpf: typeof cur.cpf === "string" ? cur.cpf : "",
    rg: typeof cur.rg === "string" ? cur.rg : "",
    school: typeof cur.school === "string" ? cur.school : "",
    schoolGrade: typeof cur.schoolGrade === "string" ? cur.schoolGrade : "",
    church: typeof cur.church === "string" ? cur.church : "",
    invitedBy: typeof cur.invitedBy === "string" ? cur.invitedBy : "",
    guardianName: typeof cur.guardianName === "string" ? cur.guardianName : "",
    guardianPhone: typeof cur.guardianPhone === "string" ? cur.guardianPhone : "",
    guardianCpf: typeof cur.guardianCpf === "string" ? cur.guardianCpf : "",
    guardianEmail: typeof cur.guardianEmail === "string" ? cur.guardianEmail : "",
  };
  const userId = c.get("userId");
  const result = await sortCamperNotes(
    { notes, current, subject },
    {
      mode: "live",
      signal: c.req.raw.signal,
      onAttempt: (model, r) => {
        console.log(`AI camper-notes(${subject}) ${model} ${r.ok ? "ok" : `failed(${r.error})`} ${r.ms}ms tokens=${r.usage.promptTokens}+${r.usage.completionTokens}`);
        const vendor = NOTES_MODES.live.models.find((m) => m.id === model)?.vendor ?? "openai";
        if (r.error !== "cancelled") void recordAiUsage({ at: new Date(), vendor, model, kind: "camper_notes", userId, ...r.usage, ok: r.ok });
      },
    },
  );
  if (!result) return c.json({ error: { code: "AI_UPSTREAM", message: "O assistente não respondeu. Tente de novo." } }, 502);
  return c.json({ fields: result.fields, model: result.model, vendor: result.vendor });
});

/**
 * POST /api/ai/dedup-field { field, value } → { value, changed }
 *
 * Background clean-up of ONE free-text field: removes entries repeated after
 * the observations sorter echoed a value it was told to keep. Best-effort on a
 * cheap fast model (GLM 5.3 flash); returns the input unchanged on any failure,
 * so the client can fire it on blur without ever blocking a save.
 */
ai.post("/dedup-field", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);
  const body = (await c.req.json().catch(() => null)) as { field?: unknown; value?: unknown } | null;
  if (!isDedupField(body?.field)) return c.json({ error: { code: "AI_FIELD", message: "Campo inválido." } }, 400);
  const value = typeof body?.value === "string" ? body.value : "";
  const r = await dedupField(body.field, value, c.req.raw.signal);
  if (r.usage) void recordAiUsage({ at: new Date(), vendor: FIELD_DEDUP_MODEL.vendor, model: FIELD_DEDUP_MODEL.id, kind: "dedup_field", userId: c.get("userId"), ...r.usage, ok: true });
  return c.json({ value: r.value, changed: r.changed });
});

ai.post("/edit", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);

  const body = (await c.req.json().catch(() => null)) as
    | { model?: unknown; html?: unknown; selection?: unknown; messages?: unknown; context?: unknown; title?: unknown; images?: unknown }
    | null;
  if (!body) return c.json({ error: { code: "INVALID_JSON", message: "Corpo inválido." } }, 400);

  const model = AI_MODELS.find((m) => m.id === body.model);
  if (!model) return c.json({ error: { code: "AI_MODEL", message: "Modelo não disponível." } }, 400);
  const html = typeof body.html === "string" ? body.html : "";
  const selection = typeof body.selection === "string" && body.selection.trim() ? body.selection : null;
  const ctx: AiContext = typeof body.context === "string" && body.context in AI_CONTEXTS ? (body.context as AiContext) : "generic";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  if (html.length > MAX_HTML || (selection?.length ?? 0) > MAX_HTML) {
    return c.json({ error: { code: "AI_TOO_LONG", message: "Documento grande demais para o assistente." } }, 413);
  }
  const messages = Array.isArray(body.messages)
    ? (body.messages as unknown[])
        .filter((m): m is { role: string; content: string } => {
          const x = m as { role?: unknown; content?: unknown };
          return (x.role === "user" || x.role === "assistant") && typeof x.content === "string" && x.content.trim().length > 0;
        })
        .slice(-MAX_MESSAGES)
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, MAX_MESSAGE) }))
    : [];
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return c.json({ error: { code: "AI_MESSAGE", message: "Escreva o que você quer que a IA faça." } }, 400);
  }
  const images = Array.isArray(body.images)
    ? (body.images as unknown[]).filter((u): u is string => typeof u === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(u) && u.length <= MAX_IMAGE_CHARS).slice(0, MAX_IMAGES)
    : [];

  const heading = title ? `TÍTULO DO DOCUMENTO (não faz parte do HTML, só contexto): ${title}\n\n` : "";
  const context =
    heading +
    (selection
      ? `DOCUMENTO COMPLETO (contexto):\n${html || "<p></p>"}\n\nTRECHO SELECIONADO (se você editar, devolva entre os marcadores apenas o HTML que substitui este trecho):\n${selection}`
      : html
        ? `DOCUMENTO ATUAL (se você editar, devolva entre os marcadores o documento completo atualizado):\n${html}`
        : "DOCUMENTO ATUAL: vazio. Se o usuário pedir o conteúdo, escreva-o entre os marcadores seguindo o tipo de documento descrito.");

  const convo: ChatMessage[] = [
    { role: "system", content: systemPrompt(ctx) },
    { role: "user", content: context },
    { role: "assistant", content: "Entendido. O que você precisa?" },
    ...messages,
  ];
  // pictures ride along with the latest request, so the model can read/describe them
  if (images.length) {
    const last = convo[convo.length - 1] as { role: "user"; content: string };
    convo[convo.length - 1] = {
      role: "user",
      content: [{ type: "text", text: last.content }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
    };
  }

  // first round is awaited before we commit to a 200, so gateway errors still come back as JSON
  const userId = c.get("userId");
  if (images.length) console.log(`AI ${model.id} with ${images.length} image(s)`);
  const usage = { promptTokens: 0, completionTokens: 0 };
  const first = await callModel(model.id, convo);
  if (!first.ok) {
    void recordAiUsage({ at: new Date(), vendor: model.vendor, model: model.id, kind: "edit", userId, promptTokens: 0, completionTokens: 0, ok: false });
    const message =
      first.code === "model_cooldown" || first.code === "usage_limit_reached"
        ? `${model.label} atingiu o limite de uso por agora. Tente outro modelo.`
        : "O assistente de IA não respondeu. Tente novamente.";
    return c.json({ error: { code: "AI_UPSTREAM", message } }, 502);
  }

  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "no-cache");
  c.header("x-accel-buffering", "no");
  return stream(c, async (out) => {
    let sent = 0;
    let finish = "";
    const used: string[] = [];
    let round = first;
    for (let i = 0; ; i++) {
      const r = await pumpStream(round.body, async (chunk) => {
        sent += chunk.length;
        await out.write(chunk);
      });
      finish = r.finish;
      usage.promptTokens += r.usage.promptTokens;
      usage.completionTokens += r.usage.completionTokens;
      if (!r.toolCalls.length || i >= MAX_TOOL_ROUNDS) break;
      // the model wants facts: run the tools, tell the panel, ask again
      convo.push({ role: "assistant", content: r.text || null, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments || "{}" } })) });
      for (const t of r.toolCalls) {
        if (used.length >= MAX_TOOL_CALLS) {
          convo.push({ role: "tool", tool_call_id: t.id, content: JSON.stringify({ error: "Limite de consultas atingido. Responda agora com o que já tem." }) });
          continue;
        }
        used.push(t.name);
        // own line: whatever the model chattered before calling tools is discarded by the panel
        await out.write(`\n${TOOL_MARK}${TOOL_LABELS[t.name] ?? t.name}\n`);
        convo.push({ role: "tool", tool_call_id: t.id, content: await runTool(t.name, t.arguments) });
      }
      const next = await callModel(model.id, convo);
      if (!next.ok) {
        console.error("AI tool round failed", model.id, next.code);
        break;
      }
      round = next;
    }
    console.log(`AI ${model.id} ctx=${ctx} sel=${selection ? "y" : "n"} tools=[${used.join(",")}] → ${sent} chars (${finish || "no finish"}) tokens=${usage.promptTokens}+${usage.completionTokens}`);
    void recordAiUsage({ at: new Date(), vendor: model.vendor, model: model.id, kind: "edit", userId, ...usage, ok: true });
  });
});

// ── streaming helpers ──────────────────────────────────────────────────

type UserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | UserPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** how many times the model may go fetch facts before it has to answer */
const MAX_TOOL_ROUNDS = 2;
/** how many distinct lookups per request — beyond this the model gets "answer now" */
const MAX_TOOL_CALLS = 3;
/**
 * Lines starting with this in the streamed body are status notes for the
 * panel ("consultando programação…"), not document text. The frontend strips
 * them. U+241E (SYMBOL FOR RECORD SEPARATOR) never occurs in real content.
 */
const TOOL_MARK = "\u241e";
const TOOL_LABELS: Record<string, string> = {
  get_app_overview: "como o app funciona",
  get_checkin_info: "horário do check-in",
  get_schedule: "programação",
  get_roles: "funções da escala",
  get_documents: "documentos existentes",
  get_categories: "times, veículos e opções",
  get_record_fields: "campos das fichas",
  get_contacts: "contatos importantes",
  get_bedrooms: "quartos",
  get_team_summary: "equipe",
};

async function callModel(modelId: string, messages: ChatMessage[]): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; code?: string }> {
  const upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({ model: modelId, stream: true, stream_options: { include_usage: true }, messages, tools: toolSpecs(), tool_choice: "auto" }),
  }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    const detail = upstream ? await upstream.text().catch(() => "") : "";
    console.error("AI gateway error", upstream?.status, detail.slice(0, 300));
    let code: string | undefined;
    try {
      code = (JSON.parse(detail) as { error?: { code?: string } }).error?.code;
    } catch {
      /* not json */
    }
    return { ok: false, code };
  }
  return { ok: true, body: upstream.body };
}

interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Reads an OpenAI SSE stream: forwards text deltas, accumulates tool calls. */
async function pumpStream(
  body: ReadableStream<Uint8Array>,
  onText: (chunk: string) => Promise<void>,
): Promise<{ text: string; toolCalls: ToolCallAcc[]; finish: string; usage: { promptTokens: number; completionTokens: number } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish = "";
  const usage = { promptTokens: 0, completionTokens: 0 };
  const calls: ToolCallAcc[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { text, toolCalls: calls, finish, usage };
        try {
          const json = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
            error?: unknown;
          };
          if (json.error) console.error("AI stream error", JSON.stringify(json.error).slice(0, 300));
          if (json.usage) {
            usage.promptTokens = json.usage.prompt_tokens ?? usage.promptTokens;
            usage.completionTokens = json.usage.completion_tokens ?? usage.completionTokens;
          }
          const choice = json.choices?.[0];
          if (choice?.finish_reason) finish = choice.finish_reason;
          const chunk = choice?.delta?.content;
          if (chunk) {
            text += chunk;
            await onText(chunk);
          }
          for (const tc of choice?.delta?.tool_calls ?? []) {
            const idx = tc.index ?? calls.length;
            if (!calls[idx]) calls[idx] = { id: tc.id ?? `call_${idx}`, name: "", arguments: "" };
            if (tc.id) calls[idx].id = tc.id;
            if (tc.function?.name) calls[idx].name = tc.function.name;
            if (tc.function?.arguments) calls[idx].arguments += tc.function.arguments;
          }
        } catch {
          /* keep-alive / partial line */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text, toolCalls: calls.filter(Boolean), finish, usage };
}

const PING_TIMEOUT_MS = 15_000;

/** Tiny round trip: is this model answering right now? */
async function pingModel(id: string): Promise<{ ok: boolean; ms: number; message?: string }> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({ model: id, max_tokens: 5, messages: [{ role: "user", content: "Responda apenas: ok" }] }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let code: string | undefined;
      try {
        code = (JSON.parse(detail) as { error?: { code?: string } }).error?.code;
      } catch {
        /* not json */
      }
      return { ok: false, ms, message: code ?? `http ${res.status}` };
    }
    const data = (await res.json().catch(() => null)) as { choices?: unknown[] } | null;
    // reasoning models may spend the 5 tokens thinking; a 200 with a choice still means "answering"
    const answered = Array.isArray(data?.choices) && data.choices.length > 0;
    return { ok: answered, ms, message: answered ? undefined : "empty" };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, message: (err as Error)?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

interface JevChoiceAnswer {
  type?: unknown;
  choice?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

/** Jev is a closed-set decision model: it picks one of the emojis already shown by the form. */
async function suggestEmojiWithJev(input: { html: string; ctx: AiContext; choices: string[]; userId: string; signal: AbortSignal }): Promise<string | undefined> {
  if (!config.ai.openRouterApiKey || input.choices.length === 0) return undefined;
  const optionToEmoji = Object.fromEntries(input.choices.map((emoji, index) => [`option_${index}`, emoji]));
  const criteria = Object.fromEntries(Object.keys(optionToEmoji).map((option) => [option, { emoji: optionToEmoji[option] }]));
  const upstream = await fetch(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ai.openRouterApiKey}`,
      "HTTP-Referer": config.appUrl || "https://acampakids.app",
      "X-Title": "Acampa Kids emoji suggestions",
    },
    body: JSON.stringify({
      model: EMOJI_SUGGEST_MODEL,
      state: {
        application: "Aplicativo brasileiro para organizar um acampamento infantil de igreja.",
        itemType: AI_CONTEXTS[input.ctx].name,
        itemDescription: AI_CONTEXTS[input.ctx].description,
        content: input.html.slice(0, 20_000),
      },
      questions: {
        icon: {
          type: "choice",
          instructions: "Qual dos emojis disponíveis representa melhor e de forma mais imediata este item da interface?",
          criteria,
        },
      },
    }),
    signal: input.signal,
  }).catch(() => null);

  if (!upstream?.ok) {
    console.error("Jev emoji suggest error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    void recordAiUsage({ at: new Date(), vendor: EMOJI_SUGGEST_VENDOR, model: EMOJI_SUGGEST_MODEL, kind: "suggest", userId: input.userId, promptTokens: 0, completionTokens: 0, ok: false });
    return undefined;
  }

  const data = (await upstream.json().catch(() => null)) as { answers?: { icon?: JevChoiceAnswer }; usage?: { input_tokens?: number; output_tokens?: number } } | null;
  const answer = data?.answers?.icon;
  const emoji = answer?.type === "choice" && typeof answer.choice === "string" ? optionToEmoji[answer.choice] : undefined;
  const ok = typeof emoji === "string" && input.choices.includes(emoji);
  void recordAiUsage({
    at: new Date(),
    vendor: EMOJI_SUGGEST_VENDOR,
    model: EMOJI_SUGGEST_MODEL,
    kind: "suggest",
    userId: input.userId,
    promptTokens: data?.usage?.input_tokens ?? 0,
    completionTokens: data?.usage?.output_tokens ?? 0,
    ok,
  });
  return ok ? emoji : undefined;
}

async function suggestTitle(input: { html: string; ctx: AiContext; userId: string; signal: AbortSignal }): Promise<string | undefined> {
  if (!config.ai.apiKey) return undefined;
  const upstream = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.ai.apiKey}` },
    body: JSON.stringify({
      model: TITLE_SUGGEST_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você nomeia documentos do app de um acampamento infantil de igreja. Tipo do documento: ${AI_CONTEXTS[input.ctx].name}. Leia o HTML e responda SOMENTE {"title":"título curto"}. Use 2 a 5 palavras em português do Brasil, sem ponto final e sem emoji. Seja específico ao conteúdo (ex.: "Regras da piscina", não "Instruções").`,
        },
        { role: "user", content: input.html.slice(0, 20_000) },
      ],
    }),
    signal: input.signal,
  }).catch(() => null);
  if (!upstream?.ok) {
    console.error("AI title suggest error", upstream?.status, (await upstream?.text().catch(() => ""))?.slice(0, 300));
    void recordAiUsage({ at: new Date(), vendor: TITLE_SUGGEST_VENDOR, model: TITLE_SUGGEST_MODEL, kind: "suggest", userId: input.userId, promptTokens: 0, completionTokens: 0, ok: false });
    return undefined;
  }
  const data = (await upstream.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | null;
  const raw = data?.choices?.[0]?.message?.content ?? "";
  let parsed: { title?: unknown } = {};
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    console.error("AI title suggest: bad json", raw.slice(0, 200));
  }
  const title = typeof parsed.title === "string" ? parsed.title.trim().replace(/\.$/, "").slice(0, 80) : undefined;
  void recordAiUsage({ at: new Date(), vendor: TITLE_SUGGEST_VENDOR, model: TITLE_SUGGEST_MODEL, kind: "suggest", userId: input.userId, promptTokens: data?.usage?.prompt_tokens ?? 0, completionTokens: data?.usage?.completion_tokens ?? 0, ok: !!title });
  return title;
}

/** POST /api/ai/suggest — Jev chooses icons; the existing text model generates titles. */
ai.post("/suggest", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { html?: unknown; context?: unknown; needTitle?: unknown; needEmoji?: unknown; emojiChoices?: unknown }
    | null;
  const html = typeof body?.html === "string" ? body.html : "";
  const needTitle = body?.needTitle === true;
  const needEmoji = body?.needEmoji === true;
  if (!html.trim() || (!needTitle && !needEmoji)) return c.json({});
  if (html.length > MAX_HTML) return c.json({ error: { code: "AI_TOO_LONG", message: "Documento grande demais." } }, 413);
  const ctx: AiContext = typeof body?.context === "string" && body.context in AI_CONTEXTS ? (body.context as AiContext) : "generic";
  const emojiChoices = Array.isArray(body?.emojiChoices)
    ? [...new Set(body.emojiChoices.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(isEmojiLike))].slice(0, MAX_EMOJI_CHOICES)
    : [];
  if (needEmoji && emojiChoices.length === 0) return c.json({ error: { code: "AI_MESSAGE", message: "Nenhuma opção de ícone disponível." } }, 400);
  if (needTitle && !config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);
  if (needEmoji && !config.ai.openRouterApiKey) return c.json({ error: { code: "AI_DISABLED", message: "Sugestão de ícone não configurada no servidor." } }, 503);

  const [title, emoji] = await Promise.all([
    needTitle ? suggestTitle({ html, ctx, userId: c.get("userId"), signal: c.req.raw.signal }) : undefined,
    needEmoji ? suggestEmojiWithJev({ html, ctx, choices: emojiChoices, userId: c.get("userId"), signal: c.req.raw.signal }) : undefined,
  ]);
  return c.json({ ...(title ? { title } : {}), ...(emoji ? { emoji } : {}) });
});

/** longest picture description accepted (a prompt, not a document) */
const MAX_IMAGE_PROMPT = 1_500;

/**
 * POST /api/ai/image — renders an illustration for the document. Returns the
 * picture as a data url; the app shrinks it and uploads it to /api/files, so
 * generated images live exactly where uploaded ones do.
 */
ai.post("/image", async (c) => {
  if (!config.ai.apiKey) return c.json({ error: { code: "AI_DISABLED", message: "Assistente de IA não configurado no servidor." } }, 503);
  const body = (await c.req.json().catch(() => null)) as { description?: unknown; shape?: unknown; model?: unknown; style?: unknown } | null;
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, MAX_IMAGE_PROMPT) : "";
  if (!description) return c.json({ error: { code: "AI_MESSAGE", message: "Descreva a imagem que você quer." } }, 400);
  const shape = isImageShape(body?.shape) ? body.shape : "wide";
  const model = typeof body?.model === "string" ? body.model : undefined;
  const img = await generateImage({ description, shape, model, style: body?.style !== false }, c.req.raw.signal);
  if (!img) return c.json({ error: { code: "AI_UPSTREAM", message: "Não foi possível gerar a imagem agora. Tente de novo ou mude a descrição." } }, 502);
  void recordAiUsage({ at: new Date(), vendor: img.vendor, model: img.model, kind: "image", userId: c.get("userId"), promptTokens: 0, completionTokens: 0, ok: true });
  return c.json({ dataUrl: img.dataUrl, bytes: img.bytes, model: img.model, label: img.label, vendor: img.vendor, ms: img.ms });
});

/** GET /api/ai/image-models — which renderers the app may offer */
ai.get("/image-models", async (c) => {
  if (!config.ai.apiKey) return c.json({ enabled: false, models: [] });
  return c.json({ enabled: true, models: IMAGE_MODELS.map(({ id, label, vendor }) => ({ id, label, vendor })) });
});

/** voice messages: browsers record webm/opus (Chrome, Firefox) or mp4/aac (Safari) */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const AUDIO_TYPES = /^audio\/|^video\/(webm|mp4|ogg|quicktime)|^application\/(octet-stream|ogg)|^$/;

/**
 * POST /api/ai/transcribe — a voice message recorded in the chat input.
 * Proxies the OpenAI-compatible speech-to-text (AI_TRANSCRIBE_URL) and returns
 * the Portuguese text so the user can review it before sending.
 */
ai.post("/transcribe", async (c) => {
  if (!config.ai.transcribeUrl) return c.json({ error: { code: "AI_DISABLED", message: "Transcrição de áudio não configurada no servidor." } }, 503);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || !file.size) return c.json({ error: { code: "AUDIO_MISSING", message: "Envie o áudio no campo 'file'." } }, 400);
  if (!AUDIO_TYPES.test(file.type)) {
    console.error("AI transcribe: unsupported type", JSON.stringify(file.type), file.name);
    return c.json({ error: { code: "AUDIO_TYPE", message: `Formato de áudio não suportado (${file.type || "desconhecido"}).` } }, 415);
  }
  if (file.size > MAX_AUDIO_BYTES) return c.json({ error: { code: "AUDIO_TOO_LARGE", message: "Áudio muito grande (máx. 10 MB)." } }, 413);

  const type = file.type || "audio/webm";
  const ext = type.includes("mp4") || type.includes("quicktime") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : type.includes("mpeg") || type.includes("mp3") ? "mp3" : "webm";
  const upstreamForm = new FormData();
  upstreamForm.append("file", file, `voice.${ext}`);
  upstreamForm.append("model", config.ai.transcribeModel);
  upstreamForm.append("language", "pt");
  upstreamForm.append("response_format", "json");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const upstream = await fetch(`${config.ai.transcribeUrl}/audio/transcriptions`, {
      method: "POST",
      headers: config.ai.transcribeKey ? { authorization: `Bearer ${config.ai.transcribeKey}` } : {},
      body: upstreamForm,
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      console.error("AI transcribe error", upstream.status, (await upstream.text().catch(() => "")).slice(0, 300));
      return c.json({ error: { code: "AI_UPSTREAM", message: "Não foi possível transcrever o áudio." } }, 502);
    }
    const data = (await upstream.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    return c.json({ text });
  } catch (err) {
    console.error("AI transcribe failed", err);
    return c.json({ error: { code: "AI_UPSTREAM", message: "A transcrição demorou demais ou falhou." } }, 502);
  } finally {
    clearTimeout(timer);
  }
});

export default ai;
