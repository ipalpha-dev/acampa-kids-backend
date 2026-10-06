import { listCategories } from "../models/categories";
import { listTransports } from "../models/transports";
import { transportLabel } from "../routes/transports";
import { listBedrooms } from "../models/bedrooms";
import { listEvents, listRoles } from "../models/schedule";
import { listInstructions } from "../models/instructions";
import { listPrepSections } from "../models/preparation";
import { listStaff } from "../models/staff";
import { listTeams } from "../models/teams";
import { getSettings } from "../models/settings";
import { bedroomCapacity, COORDINATION_ROLE } from "../types";
import { membersOf } from "./members";
import { namesOf } from "./people";
import { assignmentDetail, autoAudienceLabel, isAutomatic, teamMap } from "./schedule";

/**
 * Read-only "tools" the editor's AI helper may call when a request needs facts
 * about the camp (times, teams, rooms, contacts, field names…). Nothing is
 * pushed up-front: the model asks, the backend answers with a compact JSON.
 *
 * Privacy: the model never receives camper data (only the *fields* a camper
 * record has), nor any health data, phone or e-mail. Team names (read live
 * from IPAlpha) appear only where the app already shows them to the whole
 * team (assignments, contacts, lists).
 */

export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };

/** Plain-text summary of a rich-text HTML (tools return text, not markup). */
function textOf(html: string, max = 1500): string {
  const t = html
    .replace(/<(li)[^>]*>/gi, "\n- ")
    .replace(/<\/(p|h2|h3|li|blockquote|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function labelMaps() {
  const [cats, teams, transports, rows] = await Promise.all([listCategories(), listTeams(), listTransports(), listStaff({ active: true })]);
  const names = await namesOf(rows.map((s) => s._id));
  const staff = rows.map((s) => ({ ...s, name: names.get(s._id)?.name ?? "" }));
  const option = new Map<string, string>();
  for (const c of cats) for (const o of c.options) option.set(o.id, o.label);
  for (const t of teams) option.set(t._id, t.name); // teams are looked up like options (Staff.team / Camper.team)
  for (const t of transports) option.set(t._id, transportLabel(t)); // vehicles too (Staff.transportation / busHelpers.vehicleId)
  const staffName = new Map(staff.map((s) => [s._id, s.name]));
  return { cats, staff, option, staffName };
}

export const AI_TOOLS: AiTool[] = [
  {
    name: "get_app_overview",
    description:
      "Como o app do acampamento funciona: perfis de acesso (pais, equipe, equipe médica, organização), telas, check-ins (igreja e ônibus), quartos, times, programação com escala de funções, documentos (Instruções e Preparação), ocorrências e notificações por SMS. Use quando precisar explicar um processo do app ou saber quem vê o quê.",
    parameters: NO_ARGS,
    run: async () => ({
      perfis: {
        pais: "Vêem a ficha do próprio filho e confirmam os dados no check-in da igreja. Recebem a lista de contatos importantes.",
        equipe: "Voluntários. Vêem a programação, a própria escala, o próprio quarto (crianças e colegas do quarto), Instruções e Preparação (checklist pessoal). Acesso à parte do app pode ser limitado a uma janela de datas.",
        equipe_medica: "Vê todas as crianças com dados de saúde (alergias, medicamentos, condições), todos os quartos e veículos. Registra ocorrências (só as da própria equipe médica). Só leitura no resto.",
        organizacao: "Admin + organizadores. Gerenciam crianças, equipe, quartos, check-ins, programação, documentos e a maioria das configurações. Só o admin edita a lista de organizadores, categorias, notificações e Sobre. Organizadores dos jogos (Configurações → Jogos) editam a programação e lançam pontos no Placar.",
        ajudantes_checkin: "Membros da equipe que, dentro da janela de check-in, fazem a chamada das crianças na igreja (com os pais) ou na porta de um veículo (ônibus/van).",
      },
      processos: {
        checkin_igreja: "No dia da saída, na igreja: o pai/mãe entrega a criança, os dados da ficha são confirmados e o check-in é registrado. Depois disso a criança está sob responsabilidade da equipe.",
        checkin_onibus: "Segunda chamada, dentro do veículo, antes de sair: confirma que cada criança embarcou no veículo certo.",
        quartos: "Cada criança e cada membro da equipe tem um quarto (alas: meninas, meninos, equipe). Cada quarto tem beliches e camas de solteiro; monitores do quarto cuidam das crianças dele.",
        times: "Crianças e equipe são divididos em times (Configurações → Times: nome e cor) para gincanas. O Placar registra os pontos de cada time; só o admin, os organizadores e os organizadores dos jogos lançam pontos.",
        programacao: "Eventos por dia e hora. Cada evento lista funções (papéis) e quem está escalado em cada uma, com um detalhe opcional (time, base, turno). Funções 'para todos' valem para toda a equipe.",
        instrucoes: "Documentos longos de referência para toda a equipe (regras, plano de emergência, rotina).",
        preparacao: "Checklists curtos que cada voluntário marca antes da viagem; funções podem ter a própria preparação.",
        ocorrencias: "Registros permanentes de algo que aconteceu com crianças/equipe (saúde, incidentes). Feitos pela equipe médica e pela organização. Cada grupo só vê as que o próprio grupo registrou; o admin vê todas.",
        notificacoes: "SMS automáticos (e e-mail com o detalhe, quando há endereço) para a pessoa afetada quando muda quarto, escala, documentos ou quando o check-in dela é registrado.",
      },
    }),
  },
  {
    name: "get_checkin_info",
    description:
      "SÓ o check-in das crianças: janela oficial (data e horário de abertura e fechamento, definida pela organização), como funciona a chamada na igreja e no ônibus, e os nomes dos ajudantes de check-in. Use quando o texto falar de check-in, chegada ou entrega das crianças. Não traz o resto da programação nem contatos.",
    parameters: NO_ARGS,
    run: async () => {
      const [settings, { option }, checkin] = await Promise.all([getSettings(), labelMaps(), membersOf("checkin").catch(() => [])]);
      const names = await namesOf([...checkin.map((m) => m.personId), ...settings.busHelpers.helpers.map((h) => h.personId)]);
      const name = (id: string) => names.get(id)?.name;
      const fmt = (d: Date | null) => (d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null);
      return {
        janela_checkin: { abre: fmt(settings.checkinWindow.from) ?? "[não definido]", fecha: fmt(settings.checkinWindow.until) ?? "[não definido]" },
        como_funciona: {
          igreja: "O pai/mãe entrega a criança, confirma os dados da ficha no app e o ajudante registra o check-in. A partir daí a criança está sob responsabilidade da equipe.",
          onibus: "Segunda chamada, na porta do veículo, antes de sair: confirma que cada criança embarcou no veículo certo.",
        },
        ajudantes_checkin_igreja: checkin.map((m) => name(m.personId)).filter(Boolean),
        ajudantes_onibus: settings.busHelpers.helpers.map((h) => ({ veiculo: option.get(h.vehicleId) ?? h.vehicleId, nome: name(h.personId) })).filter((h) => h.nome),
      };
    },
  },
  {
    name: "get_schedule",
    description:
      "A programação de eventos (dias, horários, títulos, funções e escalados). Use SÓ quando o pedido for sobre a programação, a sequência de atividades ou quem faz o quê em um evento. Para horário de check-in use get_checkin_info. Prefira informar a data para receber só um dia.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "Opcional: só os eventos de um dia, formato YYYY-MM-DD." } },
      additionalProperties: false,
    },
    run: async (args) => {
      const [events, roles, staffList, teams, { staffName }] = await Promise.all([listEvents(), listRoles(), listStaff(), listTeams(), labelMaps()]);
      const roleById = new Map(roles.map((r) => [r._id, r]));
      const staffById = new Map(staffList.map((s) => [s._id, s]));
      const teamById = teamMap(teams);
      const date = typeof args.date === "string" ? args.date : null;
      return events
        .filter((e) => !date || e.date === date)
        .map((e) => ({
          data: e.date,
          inicio: e.startTime,
          fim: e.endTime,
          evento: `${e.emoji} ${e.title}`.trim(),
          observacoes: e.notes || undefined,
          funcoes: e.roles.map((rid) => {
            const r = roleById.get(rid);
            const people = e.assignments
              .filter((a) => a.roleId === rid)
              .map((a) => {
                const who = staffName.get(a.staffId) ?? "?";
                const { detail } = assignmentDetail(r, a, staffById.get(a.staffId), teamById);
                return detail ? `${who} (${detail})` : who;
              });
            return {
              funcao: r ? `${r.emoji} ${r.name}`.trim() : rid,
              // vale automaticamente para uma posição E/OU tem gente escalada à mão
              vale_para: r && isAutomatic(r) ? autoAudienceLabel(r) : undefined,
              escalados: people.length ? people : undefined,
            };
          }),
        }));
    },
  },
  {
    name: "get_roles",
    description:
      "As funções (papéis) da escala, com instruções e preparação de cada uma. Use SÓ quando o texto for sobre uma função específica ou precisar do nome certo de uma função.",
    parameters: NO_ARGS,
    run: async () =>
      (await listRoles()).map((r) => ({
        funcao: `${r.emoji} ${r.name}`.trim(),
        vale_para: isAutomatic(r) ? autoAudienceLabel(r) : undefined,
        detalhe: r.hasDetail ? (r.detailFromTeam ? "o time da pessoa" : r.detailPlaceholder || "sim") : undefined,
        instrucoes: textOf(r.instructions, 600) || undefined,
        preparacao: textOf(r.preparation, 400) || undefined,
      })),
  },
  {
    name: "get_documents",
    description:
      "Títulos e resumo dos documentos já escritos (Instruções e Preparação). Use SÓ quando o pedido citar outro documento ou pedir para não repetir o que já existe. Não use para 'enriquecer' um texto que já tem o conteúdo no pedido.",
    parameters: {
      type: "object",
      properties: { full: { type: "string", description: "Opcional: título exato de um documento para receber o texto completo." } },
      additionalProperties: false,
    },
    run: async (args) => {
      const [docs, prep] = await Promise.all([listInstructions(), listPrepSections()]);
      const full = typeof args.full === "string" ? args.full.trim().toLowerCase() : null;
      const pick = (title: string, html: string) => (full && title.toLowerCase() === full ? textOf(html, 12_000) : textOf(html, 300));
      return {
        instrucoes: docs.map((d) => ({ titulo: `${d.emoji} ${d.title}`.trim(), texto: pick(d.title, d.content) })),
        preparacao: prep.map((p) => ({ titulo: `${p.emoji} ${p.title}`.trim(), texto: pick(p.title, p.content) })),
      };
    },
  },
  {
    name: "get_categories",
    description:
      "As listas fechadas do app: os TIMES (nome, cor), os TRANSPORTES (ônibus com cor e número, ou carros) e as categorias com suas opções: posição da cama, alergias, alergias a medicamentos, condições crônicas. Use para citar nomes corretos de times, veículos ou opções de saúde.",
    parameters: NO_ARGS,
    run: async () => {
      const [cats, teams, transports, { staffName }] = await Promise.all([listCategories(), listTeams(), listTransports(), labelMaps()]);
      return {
        times: teams.map((t) => ({ nome: t.name, cor: t.color })),
        transportes: transports.map((t) => (t.kind === "bus" ? { nome: transportLabel(t), tipo: "ônibus", cor: t.color ?? undefined, numero: t.number ?? undefined } : { nome: t.name, tipo: "carro" })),
        categorias: cats.map((c) => ({ categoria: `${c.emoji} ${c.name}`.trim(), chave: c.key, aplica_a: c.appliesTo, escolha: c.selection === "single" ? "uma opção" : "várias opções", descricao: c.description || undefined, opcoes: c.options.filter((o) => o.active).map((o) => o.label) })),
      };
    },
  },
  {
    name: "get_record_fields",
    description:
      "Os CAMPOS da ficha de uma criança e da ficha de um membro da equipe (sem dados pessoais): o que a organização sabe sobre cada pessoa. Use para orientar a equipe sobre onde encontrar uma informação no app (ex.: 'veja o campo Medicamentos na ficha').",
    parameters: NO_ARGS,
    run: async () => ({
      crianca: {
        identificacao: ["Nome", "Data de nascimento (idade)", "Peso (kg)"],
        onde_fica: "Nome, documentos, responsáveis e saúde ficam no cadastro IPAlpha da pessoa; o app do acampamento guarda só quarto, time, transporte, check-ins e observações.",
        acampamento: ["Time", "Transporte (veículo)", "Quarto", "Cama (posição)", "Preferência de quarto (com quem quer ficar)"],
        saude: ["Alergias", "Alergias a medicamentos", "Condições crônicas", "Medicamentos em uso (texto)", "Restrições alimentares", "Observações de saúde"],
        responsaveis: ["Nome do responsável", "Telefone do responsável", "Contato de emergência", "Convênio", "Carteirinha do convênio"],
        outros: ["Observações gerais", "Check-in na igreja (quando, por quem)", "Check-in no ônibus (quando, por quem)"],
      },
      equipe: {
        identificacao: ["Nome"],
        acampamento: ["Time", "Transporte (veículo)", "Quarto", "Ativo/inativo"],
        saude: ["Alergias", "Alergias a medicamentos", "Condições crônicas", "Medicamentos em uso", "Restrições alimentares", "Observações de saúde"],
        outros: ["Check-in na igreja", "Itens da Preparação marcados como feitos"],
      },
      quem_ve_saude: "Equipe médica e admin vêem a saúde de todas as crianças; os monitores vêem a das crianças do próprio quarto; ajudantes de ônibus não vêem saúde.",
    }),
  },
  {
    name: "get_contacts",
    description:
      "Quem procurar (só NOMES e a função — telefones ficam no IPAlpha e nunca vêm aqui): coordenação, contatos divulgados aos pais, organização, equipe médica, ajudantes. Use SÓ quando o usuário pedir explicitamente para incluir 'quem chamar', ou quando o texto original já tiver uma seção de contatos. Nunca acrescente contatos por conta própria.",
    parameters: NO_ARGS,
    run: async () => {
      const settings = await getSettings();
      const roles = ["coordenacao", "organizacao", "organizacao-jogos", "pontuacao", "saude", "coletes", "checkin"] as const;
      const lists = await Promise.all(roles.map((r) => membersOf(r).catch(() => [])));
      const ids = [...lists.flat().map((m) => m.personId), ...settings.parentContacts.map((c) => c.personId), ...settings.busHelpers.helpers.map((h) => h.personId)];
      const names = await namesOf(ids);
      const list = (i: number) => [...new Set(lists[i].map((m) => names.get(m.personId)?.name).filter(Boolean))];
      const { option } = await labelMaps();
      return {
        coordenacao: list(roles.indexOf(COORDINATION_ROLE)),
        contatos_para_pais: settings.parentContacts.map((c) => ({ funcao: c.title, nome: names.get(c.personId)?.name })),
        organizacao: list(1),
        organizacao_dos_jogos: list(2),
        ajudantes_do_placar: list(3),
        equipe_medica: list(4),
        responsaveis_coletes: list(5),
        ajudantes_checkin_igreja: list(6),
        ajudantes_onibus: settings.busHelpers.helpers.map((h) => ({ veiculo: option.get(h.vehicleId) ?? h.vehicleId, nome: names.get(h.personId)?.name })),
      };
    },
  },
  {
    name: "get_bedrooms",
    description:
      "Os quartos: nome/número, ala (meninas, meninos, equipe), capacidade e quais membros da equipe são os monitores de cada quarto. Não inclui crianças. Use para citar quartos ou explicar a organização dos dormitórios.",
    parameters: NO_ARGS,
    run: async () => {
      const [rooms, { staff }] = await Promise.all([listBedrooms(), labelMaps()]);
      const monitors = new Map<string, string[]>();
      for (const s of staff) if (s.bedroom) monitors.set(s.bedroom, [...(monitors.get(s.bedroom) ?? []), s.name]);
      const ala = { girls: "meninas", boys: "meninos", staff: "equipe" } as const;
      return rooms.map((r) => ({ quarto: r.name, ala: ala[r.group], capacidade: bedroomCapacity(r), beliches: r.bunkBeds, camas_solteiro: r.singleBeds, observacoes: r.notes || undefined, monitores: monitors.get(r._id) }));
    },
  },
  {
    name: "get_team_summary",
    description:
      "Resumo da equipe de voluntários (sem dados de saúde): quantidade, nomes por time e por veículo. Use para citar nomes corretos ou tamanho da equipe.",
    parameters: NO_ARGS,
    run: async () => {
      const { staff, option } = await labelMaps();
      const group = (key: (s: (typeof staff)[number]) => string | null) => {
        const m = new Map<string, string[]>();
        for (const s of staff) {
          const k = key(s);
          const label = k ? (option.get(k) ?? k) : "(sem)";
          m.set(label, [...(m.get(label) ?? []), s.name]);
        }
        return Object.fromEntries(m);
      };
      return { total: staff.length, por_time: group((s) => s.team), por_veiculo: group((s) => s.transportation) };
    },
  },
];

export function toolSpecs() {
  return AI_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

const MAX_RESULT = 40_000;

export async function runTool(name: string, rawArgs: string): Promise<string> {
  const tool = AI_TOOLS.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `ferramenta desconhecida: ${name}` });
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    /* tolerate bad json → no args */
  }
  try {
    const out = JSON.stringify(await tool.run(args));
    return out.length > MAX_RESULT ? `${out.slice(0, MAX_RESULT)}…(cortado)` : out;
  } catch (err) {
    console.error("AI tool failed", name, err);
    return JSON.stringify({ error: "não foi possível obter essa informação agora" });
  }
}
