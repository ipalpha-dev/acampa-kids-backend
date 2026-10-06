import type { BedroomGroup, CamperSex } from "../types";

/**
 * The wizard's sample camp (decision 92): FULLY synthetic, built from scratch
 * by a seeded PRNG — no network, no file, nothing copied from a real camp.
 * Previews / dev only (the wizard refuses it elsewhere — decision 71).
 *
 * Fixture conventions (keep them when editing this file):
 * - every person name ends "(exemplo)";
 * - phones are only `+55 11 90000-00xx`, emails only `@example.test`;
 * - schools / churches / insurances are invented ("Escola Exemplo …");
 * - no CPF / RG at all;
 * - health text is invented, gentle and marked "(exemplo)".
 * Phones are unique per adult: core finds an adult by phone, so one phone is
 * one person (some team members are also the responsible for kids).
 */

export interface SampleCamp {
  fictional: true;
  note: string;
  teams: { name: string; color: string }[];
  rooms: { name: string; group: BedroomGroup; bunkBeds: number; singleBeds: number }[];
  transports: { kind: "bus" | "car"; number?: string; color?: string; name?: string }[];
  staff: { name: string; phone: string; team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; roomRole: "caretaker" | "helper"; active: boolean; healthNotes: string }[];
  campers: {
    name: string; birthDate: string | null; sex: CamperSex; cpf: string; rg: string; school: string; schoolGrade: string; church: string; invitedBy: string;
    team: string | null; room: string | null; roomGroup: BedroomGroup | null; transportation: string | null; bed: string | null; weightKg: number | null;
    allergies: string[]; healthIssues: string[]; foodRestrictions: string; healthNotes: string; generalNotes: string; bedroomPreference: string;
    insurance: string; insuranceCard: string; emergencyContact: string; guardianName: string; guardianPhone: string; guardianCpf: string; guardianEmail: string;
  }[];
}

export const SAMPLE_KIDS = 150;
export const SAMPLE_STAFF = 70;
/** phones 00‥99: team 00‥69, of which 40‥69 also bring kids; 70‥99 are responsibles only */
const PARENT_STAFF_FROM = 40;

const GIRL_NAMES = ["Alice", "Beatriz", "Cecília", "Clara", "Elisa", "Giovana", "Isadora", "Júlia", "Laura", "Lívia", "Luísa", "Manuela", "Marina", "Mel", "Mirela", "Olívia", "Rebeca", "Sara", "Sofia", "Valentina", "Yasmin", "Lara", "Ester", "Raquel", "Débora", "Noemi", "Lídia", "Ana Luz", "Maria Flor", "Helô"];
const BOY_NAMES = ["Arthur", "Benício", "Caio", "Davi", "Enzo", "Felipe", "Gael", "Heitor", "Isaque", "Joaquim", "Lorenzo", "Mateus", "Miguel", "Noah", "Otávio", "Rafael", "Samuel", "Théo", "Vicente", "Benjamin", "Elias", "Josué", "Levi", "Natã", "Gideão", "Jonas", "Tobias", "Ravi", "João Pedro", "Calebe"];
const WOMAN_NAMES = ["Adriana", "Bianca", "Camila", "Daniela", "Fernanda", "Gabriela", "Helena", "Isabel", "Juliana", "Karina", "Letícia", "Mariana", "Natália", "Patrícia", "Renata", "Simone", "Tatiana", "Vanessa", "Priscila", "Rute"];
const MAN_NAMES = ["André", "Bruno", "Carlos", "Diego", "Eduardo", "Fábio", "Gustavo", "Hugo", "Igor", "Leandro", "Marcelo", "Nelson", "Paulo", "Ricardo", "Sérgio", "Thiago", "Vinícius", "Wagner", "Rodrigo", "Daniel"];
const SURNAMES = ["Amarante", "Bragança", "Cordeiro", "Dourado", "Esteves", "Fontoura", "Galvão", "Horta", "Ipiranga", "Jordão", "Lacerda", "Macedo", "Nogueira", "Orvalho", "Prates", "Quintela", "Rosário", "Siqueira", "Toledo", "Valadares", "Vilela", "Xavante", "Zanetti", "Aragão", "Bonfim", "Candeias", "Damasceno", "Figueiral", "Laranjeira", "Serrado"];

const TEAMS: SampleCamp["teams"] = [
  { name: "Equipe Oliveira", color: "#2E7D32" },
  { name: "Equipe Videira", color: "#6A1B9A" },
  { name: "Equipe Cedro", color: "#5D4037" },
  { name: "Equipe Figueira", color: "#F9A825" },
  { name: "Equipe Palmeira", color: "#00897B" },
  { name: "Equipe Romã", color: "#C62828" },
  { name: "Equipe Trigo", color: "#EF6C00" },
  { name: "Equipe Mostarda", color: "#1565C0" },
];

const GIRL_ROOMS = ["Lírio", "Violeta", "Girassol", "Orquídea", "Margarida", "Hortênsia", "Camélia", "Tulipa", "Azaleia", "Begônia", "Gardênia", "Magnólia", "Jasmim", "Dália", "Íris", "Acácia"];
const BOY_ROOMS = ["Águia", "Leão", "Cervo", "Falcão", "Lobo-guará", "Tucano", "Jaguar", "Pelicano", "Castor", "Tamanduá"];
const STAFF_ROOMS = ["Apoio A", "Apoio B", "Apoio C", "Apoio D", "Apoio E", "Apoio F", "Apoio G", "Apoio H"];

const TRANSPORTS: SampleCamp["transports"] = [
  { kind: "bus", number: "11", color: "#7C3AED" },
  { kind: "bus", number: "12", color: "#0EA5E9" },
  { kind: "bus", number: "13", color: "#16A34A" },
  { kind: "bus", number: "14", color: "#DB2777" },
  { kind: "car", name: "Carro de apoio (exemplo)" },
];
const BUS_KEYS = ["bus:11", "bus:12", "bus:13", "bus:14"];

const SCHOOLS = ["Escola Exemplo Aurora", "Escola Exemplo Horizonte", "Escola Exemplo Ipê Amarelo", "Escola Exemplo Jardim das Letras", "Escola Exemplo Novo Caminho", "Escola Exemplo Sabiá", "Escola Exemplo Arco-Íris", "Escola Exemplo Vale Verde", "Escola Exemplo Pé de Feijão", "Escola Exemplo Bem-te-vi"];
const CHURCHES = ["Igreja Exemplo da Colina", "Comunidade Exemplo Esperança", "Igreja Exemplo Monte Sião", "Igreja Exemplo Fonte Viva", "Comunidade Exemplo Boas Novas"];
const INSURANCES = ["Plano Exemplo Saúde", "Convênio Exemplo Vida", "Saúde Exemplo Mais", "Plano Exemplo Família"];

// gentle, invented health / care text — written for this generator, never copied
const ALLERGIES = ["Rinite (exemplo)", "Alergia a amendoim (exemplo)", "Alergia a camarão (exemplo)", "Alergia a poeira (exemplo)", "Alergia a penicilina (exemplo)", "Alergia a picada de formiga (exemplo)"];
const HEALTH_ISSUES = ["Asma leve (exemplo)", "Bronquite (exemplo)", "Enxaqueca (exemplo)", "Dermatite (exemplo)"];
const FOOD = ["Sem lactose (exemplo)", "Sem glúten (exemplo)", "Não come carne de porco (exemplo)", "Prefere comida sem pimenta (exemplo)"];
const KID_HEALTH_NOTES = [
  "Usa bombinha antes de brincadeiras de corrida; a família envia na mala (exemplo).",
  "Toma xarope antialérgico às 20h, 5 ml (exemplo).",
  "Sente enjoo em viagens longas; sentar na frente do ônibus ajuda (exemplo).",
  "Usa óculos; lembrar de guardar no estojo antes de dormir (exemplo).",
  "Pele sensível: protetor solar fator 50 a cada duas horas (exemplo).",
  "Toma vitamina pela manhã, junto do café (exemplo).",
  "Lavar bem as mãos antes das refeições; a família pediu atenção (exemplo).",
];
const KID_GENERAL_NOTES = [
  "Primeira vez no acampamento (exemplo).",
  "Adora cantar; pode ajudar na hora da música (exemplo).",
  "Fica mais à vontade depois do primeiro dia; um acolhimento ajuda (exemplo).",
  "Gosta de desenhar no tempo livre (exemplo).",
];
const BED_REMARKS = ["só cama de baixo (exemplo)", "prefere cama de cima (exemplo)"];
const STAFF_HEALTH_NOTES = ["Alergia a dipirona (exemplo).", "Usa lentes de contato (exemplo).", "Toma remédio contínuo pela manhã (exemplo).", "Alergia a frutos do mar (exemplo).", "Evita esforço pesado por causa da coluna (exemplo)."];
const CONTACT_RELATIONS_F = ["tia", "avó", "madrinha", "amiga da família"];
const CONTACT_RELATIONS_M = ["tio", "avô", "padrinho", "amigo da família"];

/** mulberry32 — tiny, deterministic, good enough for fixtures */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** the only phone shape in the sample: +55 11 90000-00xx */
export const samplePhone = (i: number) => `+55 11 90000-00${pad2(i)}`;
const ascii = (s: string) => s.normalize("NFD").replace(/[^\w]/g, "").toLowerCase();

/** grade in the Brazilian school year (cut-off 31 March) for a kid at camp in `year` */
function gradeOf(birth: Date, year: number): string {
  const schoolAge = year - birth.getUTCFullYear() - (birth.getUTCMonth() >= 3 ? 1 : 0);
  return schoolAge <= 5 ? "Jardim II" : `${Math.min(schoolAge - 5, 5)}º ano`;
}

/**
 * A synthetic camp. Same `seed` + `year` → same camp. Kids are in Jardim II
 * to 5º ano in `year` (born 1 Apr year-11 … 31 Mar year-5).
 */
export function generateCamp(options: { seed?: number; year?: number } = {}): SampleCamp {
  const seed = options.seed ?? 2026;
  const year = options.year ?? new Date().getUTCFullYear();
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const chance = (p: number) => rnd() < p;
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  };

  // unique "First Surname"
  const used = new Set<string>();
  const uniqueName = (firsts: readonly string[], surname?: string): string => {
    for (let tries = 0; ; tries++) {
      const base = `${pick(firsts)} ${surname ?? pick(SURNAMES)}`;
      const name = tries < 40 ? base : `${base} ${pick(SURNAMES)}`;
      if (!used.has(name)) {
        used.add(name);
        return name;
      }
    }
  };
  const tagged = (name: string) => `${name} (exemplo)`;

  // ── adults: one phone each ─────────────────────────────────────────
  const adults = Array.from({ length: 100 }, (_, i) => {
    const woman = chance(0.6);
    const surname = SURNAMES[i % SURNAMES.length]!;
    const plain = uniqueName(woman ? WOMAN_NAMES : MAN_NAMES, surname);
    return { plain, name: tagged(plain), surname, phone: samplePhone(i), email: `${ascii(plain.split(" ")[0]!)}.${ascii(surname)}.${pad2(i)}@example.test` };
  });

  // ── rooms ──────────────────────────────────────────────────────────
  const rooms: SampleCamp["rooms"] = [
    ...GIRL_ROOMS.map((name) => ({ name, group: "girls" as const, bunkBeds: 4, singleBeds: 1 })),
    ...BOY_ROOMS.map((name) => ({ name, group: "boys" as const, bunkBeds: chance(0.5) ? 4 : 5, singleBeds: 1 })),
    ...STAFF_ROOMS.map((name) => ({ name, group: "staff" as const, bunkBeds: 2, singleBeds: chance(0.5) ? 1 : 0 })),
  ];
  const capacity = (r: SampleCamp["rooms"][number]) => r.bunkBeds * 2 + r.singleBeds;
  const occupancy = new Map<string, number>(rooms.map((r) => [`${r.group}:${r.name}`, 0]));
  const takeBed = (group: BedroomGroup, preferred?: string): string | null => {
    const candidates = rooms.filter((r) => r.group === group && occupancy.get(`${group}:${r.name}`)! < capacity(r));
    if (!candidates.length) return null;
    const room = candidates.find((r) => r.name === preferred) ?? candidates.reduce((a, b) => (occupancy.get(`${group}:${a.name}`)! <= occupancy.get(`${group}:${b.name}`)! ? a : b));
    occupancy.set(`${group}:${room.name}`, occupancy.get(`${group}:${room.name}`)! + 1);
    return room.name;
  };

  // ── team (staff) ───────────────────────────────────────────────────
  // one caretaker per kids' room first, then helpers in the staff rooms
  const kidRooms = rooms.filter((r) => r.group !== "staff");
  const staff: SampleCamp["staff"] = adults.slice(0, SAMPLE_STAFF).map((a, i) => {
    const caretakerOf = kidRooms[i];
    const roomGroup: BedroomGroup | null = caretakerOf ? caretakerOf.group : i < SAMPLE_STAFF - 3 ? "staff" : null;
    const room = caretakerOf ? takeBed(caretakerOf.group, caretakerOf.name) : roomGroup ? takeBed("staff") : null;
    return {
      name: a.name,
      phone: a.phone,
      team: caretakerOf || chance(0.4) ? TEAMS[i % TEAMS.length]!.name : null,
      room,
      roomGroup: room ? roomGroup : null,
      transportation: chance(0.45) ? "car" : chance(0.9) ? pick(BUS_KEYS) : null,
      roomRole: caretakerOf ? "caretaker" : "helper",
      active: i !== SAMPLE_STAFF - 1,
      healthNotes: chance(0.22) ? pick(STAFF_HEALTH_NOTES) : "",
    };
  });

  // ── families → kids ────────────────────────────────────────────────
  const families = adults.slice(PARENT_STAFF_FROM);
  const kidFamily: number[] = families.map((_, f) => f); // every family brings at least one kid
  while (kidFamily.length < SAMPLE_KIDS) kidFamily.push(Math.floor(rnd() * families.length));

  const first = Date.UTC(year - 11, 3, 1); // born 1 Apr (year-11) … 31 Mar (year-5): Jardim II … 5º ano
  const last = Date.UTC(year - 5, 2, 31);
  const staffNames = staff.map((s) => s.name);

  type Kid = SampleCamp["campers"][number];
  const campers: Kid[] = kidFamily.map((f, i) => {
    const family = families[f]!;
    const sex: CamperSex = chance(0.52) ? "F" : "M";
    const plain = uniqueName(sex === "F" ? GIRL_NAMES : BOY_NAMES, family.surname);
    const birth = new Date(first + Math.floor(rnd() * ((last - first) / 86_400_000 + 1)) * 86_400_000);
    const age = year - birth.getUTCFullYear();
    let contact = adults[Math.floor(rnd() * adults.length)]!;
    if (contact.phone === family.phone) contact = adults[(adults.indexOf(contact) + 1) % adults.length]!;
    const insured = chance(0.7);
    const contactWoman = chance(0.6);
    return {
      name: tagged(plain),
      birthDate: birth.toISOString().slice(0, 10),
      sex,
      cpf: "",
      rg: "",
      school: chance(0.97) ? pick(SCHOOLS) : "",
      schoolGrade: gradeOf(birth, year),
      church: chance(0.85) ? pick(CHURCHES) : "",
      invitedBy: chance(0.35) ? pick(staffNames) : "",
      team: TEAMS[i % TEAMS.length]!.name,
      room: null,
      roomGroup: sex === "F" ? "girls" : "boys",
      transportation: chance(0.02) ? "car" : BUS_KEYS[i % BUS_KEYS.length]!,
      bed: pick(["cima", "baixo", "baixo", ""]),
      weightKg: Math.round((18 + (age - 5) * 3.2 + (rnd() - 0.5) * 8) * 10) / 10,
      allergies: chance(0.2) ? [pick(ALLERGIES)] : [],
      healthIssues: chance(0.11) ? [pick(HEALTH_ISSUES)] : [],
      foodRestrictions: chance(0.08) ? pick(FOOD) : "",
      healthNotes: chance(0.45) ? pick(KID_HEALTH_NOTES) : "",
      generalNotes: chance(0.2) ? pick(KID_GENERAL_NOTES) : "",
      bedroomPreference: "",
      insurance: insured ? pick(INSURANCES) : "",
      insuranceCard: insured && chance(0.6) ? `EXEMPLO-${String(1000 + i).padStart(6, "0")}` : "",
      emergencyContact: contactWoman ? `${pick(WOMAN_NAMES)} Exemplo (${pick(CONTACT_RELATIONS_F)}) ${contact.phone}` : `${pick(MAN_NAMES)} Exemplo (${pick(CONTACT_RELATIONS_M)}) ${contact.phone}`,
      guardianName: family.name,
      guardianPhone: family.phone,
      guardianCpf: "",
      guardianEmail: chance(0.98) ? family.email : "",
    };
  });

  // rooms by group, siblings of the same group together when there is space
  for (const k of shuffle([...campers])) {
    const sibling = campers.find((o) => o !== k && o.room && o.roomGroup === k.roomGroup && o.guardianPhone === k.guardianPhone);
    k.room = takeBed(k.roomGroup!, sibling?.room ?? undefined);
    if (!k.room) k.roomGroup = null;
  }

  // "quer ficar com …": a friend from the same room group, written like a family writes it — the first two
  // words of the name, which the frontend's preference matching resolves (first + second name)
  for (const k of campers) {
    if (!chance(0.7)) continue;
    const friends = campers.filter((o) => o !== k && o.roomGroup === k.roomGroup);
    const names = [pick(friends), ...(chance(0.3) ? [pick(friends)] : [])].map((o) => o.name.split(" ").slice(0, 2).join(" "));
    k.bedroomPreference = [...new Set(names)].join(", ") + (chance(0.15) ? ` · ${pick(BED_REMARKS)}` : "");
  }

  return {
    fictional: true,
    note: "Acampamento 100% fictício, gerado por src/sample/generateCamp.ts (decisão 92). Nenhum dado de pessoa real.",
    teams: TEAMS,
    rooms,
    transports: TRANSPORTS,
    staff,
    campers,
  };
}
