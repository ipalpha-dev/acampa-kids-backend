/**
 * Every message Acampa sends, as IPAlpha project message templates
 * (CONTRACTS §11/§13): notifications-api renders them in the recipient's
 * language (fallback pt-BR) and delivers by personId. This catalog is the
 * DEFAULT copy: provisioning seeds it per project (`bun scripts/templates-json.ts`
 * prints it; `POST /api/settings/message-templates/seed` creates the missing
 * ones) and the settings screen edits the live copy through `projects:templates`.
 *
 * Rules: slug `^[a-z0-9-]{3,60}$`; every `{var}` of every language is listed in
 * `variables`; SMS bodies ≤ 160 chars per language WITH realistic values
 * filled in (decision 45 — templates.test.ts renders them). Copy is pastoral (workspace AGENTS.md): gentle, no labels
 * about family shape, health or status; "responsável" / "família".
 */

export type TemplateLang = "pt-BR" | "en-US" | "es" | "fr" | "de";
export type LocalizedText = Record<TemplateLang, string>;

export interface TemplateDefault {
  slug: string;
  /** shown in the settings screen */
  name: string;
  channel: "sms" | "email";
  subject?: LocalizedText;
  body: LocalizedText;
  variables: string[];
}

const t = (pt: string, en: string, es: string, fr: string, de: string): LocalizedText => ({ "pt-BR": pt, "en-US": en, es, fr, de });

/** Prefix of every Acampa slug — templates live in the project, next to other apps' none. */
const P = "acampa-";

export const TEMPLATE_SLUGS = {
  checkinConfirmed: `${P}checkin-confirmed`,
  checkinReminder: `${P}checkin-reminder`,
  birthday: `${P}birthday`,
  parentEditMedical: `${P}parent-edit-medical`,
  parentEditNotes: `${P}parent-edit-notes`,
  occurrence: `${P}occurrence`,
  foreignLookup: `${P}foreign-lookup`,
  kidAssigned: `${P}kid-assigned`,
  kidUnassigned: `${P}kid-unassigned`,
  myRoom: `${P}my-room`,
  myRoomCaretaker: `${P}my-room-caretaker`,
  myRoomHelper: `${P}my-room-helper`,
  myTeam: `${P}my-team`,
  myBus: `${P}my-bus`,
  roleAssigned: `${P}role-assigned`,
  roleRemoved: `${P}role-removed`,
  eventCancelled: `${P}event-cancelled`,
  eventMoved: `${P}event-moved`,
  instructionsUpdated: `${P}instructions-updated`,
  preparationUpdated: `${P}preparation-updated`,
  photosPublished: `${P}photos-published`,
  busBoarded: `${P}bus-boarded`,
  parentWelcome: `${P}parent-welcome`,
  teamWelcome: `${P}team-welcome`,
  importFinished: `${P}import-finished`,
  importErrors: `${P}import-errors`,
  campDeleteCode: `${P}camp-delete-code`,
} as const;

export type TemplateKey = keyof typeof TEMPLATE_SLUGS;

/** The e-mail twin of an SMS slug (sent too when the catalog has one). */
export const emailSlug = (slug: string) => `${slug}-email`;

const S = TEMPLATE_SLUGS;

const SMS: TemplateDefault[] = [
  {
    slug: S.checkinConfirmed,
    name: "Check-in da equipe confirmado",
    channel: "sms",
    variables: ["name", "room", "link"],
    body: t(
      "Acampa Kids: {name}, check-in feito! Quarto: {room}. Veja suas crianças: {link}",
      "Acampa Kids: {name}, you're checked in! Room: {room}. Your kids: {link}",
      "Acampa Kids: {name}, ¡check-in hecho! Habitación: {room}. Tus niños: {link}",
      "Acampa Kids : {name}, enregistrement fait ! Chambre : {room}. Tes enfants : {link}",
      "Acampa Kids: {name}, Check-in erledigt! Zimmer: {room}. Deine Kinder: {link}",
    ),
  },
  {
    slug: S.checkinReminder,
    name: "Lembrete de check-in da equipe",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, hora do seu check-in! Ao chegar, faça em {link}",
      "Acampa Kids: {name}, check-in time! When you arrive, use {link}",
      "Acampa Kids: {name}, ¡hora de tu check-in! Al llegar, usa {link}",
      "Acampa Kids : {name}, c'est l'heure de l'enregistrement ! Sur place : {link}",
      "Acampa Kids: {name}, Zeit für den Check-in! Bei Ankunft: {link}",
    ),
  },
  {
    slug: S.birthday,
    name: "Aniversário durante o acampamento",
    channel: "sms",
    variables: ["name", "kid", "room"],
    body: t(
      "Acampa Kids: {name}, hoje é aniversário de {kid} ({room})! 🎂 Vamos fazer o dia especial.",
      "Acampa Kids: {name}, today is {kid}'s birthday ({room})! 🎂 Let's make it special.",
      "Acampa Kids: {name}, ¡hoy cumple años {kid} ({room})! 🎂 Hagamos un día especial.",
      "Acampa Kids : {name}, c'est l'anniversaire de {kid} ({room}) ! 🎂 Rendons ce jour spécial.",
      "Acampa Kids: {name}, heute hat {kid} Geburtstag ({room})! 🎂 Machen wir ihn besonders.",
    ),
  },
  {
    slug: S.parentEditMedical,
    name: "Família atualizou informações de saúde",
    channel: "sms",
    variables: ["name", "kid", "link"],
    body: t(
      "Acampa Kids: {name}, a família de {kid} atualizou a saúde. Veja: {link}",
      "Acampa Kids: {name}, {kid}'s family updated the health info. See {link}",
      "Acampa Kids: {name}, la familia de {kid} actualizó la salud. Mira: {link}",
      "Acampa Kids : {name}, la famille de {kid} a mis à jour la santé. Voir {link}",
      "Acampa Kids: {name}, die Familie von {kid} hat die Gesundheit aktualisiert: {link}",
    ),
  },
  {
    slug: S.parentEditNotes,
    name: "Família atualizou observações",
    channel: "sms",
    variables: ["name", "kid", "link"],
    body: t(
      "Acampa Kids: {name}, a família de {kid} atualizou as observações. Veja: {link}",
      "Acampa Kids: {name}, {kid}'s family updated the notes. See {link}",
      "Acampa Kids: {name}, la familia de {kid} actualizó las notas. Mira: {link}",
      "Acampa Kids : {name}, la famille de {kid} a mis à jour les notes. Voir {link}",
      "Acampa Kids: {name}, die Familie von {kid} hat die Hinweise aktualisiert: {link}",
    ),
  },
  {
    slug: S.occurrence,
    name: "Nova ocorrência registrada",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, uma nova ocorrência foi registrada. Veja: {link}",
      "Acampa Kids: {name}, a new incident note was recorded. See {link}",
      "Acampa Kids: {name}, se registró una nueva ocurrencia. Mira: {link}",
      "Acampa Kids : {name}, un nouvel événement a été noté. Voir {link}",
      "Acampa Kids: {name}, ein neuer Vorfall wurde notiert: {link}",
    ),
  },
  {
    slug: S.foreignLookup,
    name: "Leituras de crachá fora do quarto",
    channel: "sms",
    variables: ["name", "staff", "count", "link"],
    body: t(
      "Acampa Kids: {name}, {staff} leu {count} crachás de outros quartos. Veja: {link}",
      "Acampa Kids: {name}, {staff} scanned {count} badges from other rooms. See {link}",
      "Acampa Kids: {name}, {staff} leyó {count} credenciales de otras habitaciones: {link}",
      "Acampa Kids : {name}, {staff} a scanné {count} badges d'autres chambres : {link}",
      "Acampa Kids: {name}, {staff} hat {count} Ausweise anderer Zimmer gescannt: {link}",
    ),
  },
  {
    slug: S.kidAssigned,
    name: "Criança sob seus cuidados",
    channel: "sms",
    variables: ["name", "kid", "room", "link"],
    body: t(
      "Acampa Kids: {name}, {kid} agora está com você ({room}). Veja: {link}",
      "Acampa Kids: {name}, {kid} is now in your care ({room}). See {link}",
      "Acampa Kids: {name}, {kid} ahora está contigo ({room}). Mira: {link}",
      "Acampa Kids : {name}, {kid} est maintenant avec toi ({room}). Voir {link}",
      "Acampa Kids: {name}, {kid} ist jetzt bei dir ({room}): {link}",
    ),
  },
  {
    slug: S.kidUnassigned,
    name: "Criança passou para outro cuidado",
    channel: "sms",
    variables: ["name", "kid", "link"],
    body: t(
      "Acampa Kids: {name}, {kid} agora fica com outra pessoa da equipe. Veja: {link}",
      "Acampa Kids: {name}, {kid} is now with another team member. See {link}",
      "Acampa Kids: {name}, {kid} ahora está con otra persona del equipo: {link}",
      "Acampa Kids : {name}, {kid} est maintenant avec un autre membre : {link}",
      "Acampa Kids: {name}, {kid} ist jetzt bei jemand anderem im Team: {link}",
    ),
  },
  {
    slug: S.myRoom,
    name: "Seu quarto mudou",
    channel: "sms",
    variables: ["name", "room", "link"],
    body: t(
      "Acampa Kids: {name}, seu quarto agora é {room}. Veja: {link}",
      "Acampa Kids: {name}, your room is now {room}. See {link}",
      "Acampa Kids: {name}, tu habitación ahora es {room}. Mira: {link}",
      "Acampa Kids : {name}, ta chambre est maintenant {room}. Voir {link}",
      "Acampa Kids: {name}, dein Zimmer ist jetzt {room}: {link}",
    ),
  },
  {
    slug: S.myRoomCaretaker,
    name: "Você é líder no quarto",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, agora você é líder no seu quarto. Veja: {link}",
      "Acampa Kids: {name}, you are now a room leader. See {link}",
      "Acampa Kids: {name}, ahora eres líder de tu habitación. Mira: {link}",
      "Acampa Kids : {name}, tu es maintenant responsable de chambre : {link}",
      "Acampa Kids: {name}, du bist jetzt Zimmerleitung: {link}",
    ),
  },
  {
    slug: S.myRoomHelper,
    name: "Você é auxiliar no quarto",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, agora você é auxiliar no seu quarto. Veja: {link}",
      "Acampa Kids: {name}, you now help as a room assistant. See {link}",
      "Acampa Kids: {name}, ahora ayudas como auxiliar en tu habitación: {link}",
      "Acampa Kids : {name}, tu aides maintenant comme assistant(e) : {link}",
      "Acampa Kids: {name}, du hilfst jetzt als Zimmerhilfe: {link}",
    ),
  },
  {
    slug: S.myTeam,
    name: "Seu time mudou",
    channel: "sms",
    variables: ["name", "team", "link"],
    body: t(
      "Acampa Kids: {name}, seu time agora é {team}. Veja: {link}",
      "Acampa Kids: {name}, your team is now {team}. See {link}",
      "Acampa Kids: {name}, tu equipo ahora es {team}. Mira: {link}",
      "Acampa Kids : {name}, ton équipe est maintenant {team} : {link}",
      "Acampa Kids: {name}, dein Team ist jetzt {team}: {link}",
    ),
  },
  {
    slug: S.myBus,
    name: "Seu transporte mudou",
    channel: "sms",
    variables: ["name", "bus", "link"],
    body: t(
      "Acampa Kids: {name}, seu transporte agora é {bus}. Veja: {link}",
      "Acampa Kids: {name}, your transport is now {bus}. See {link}",
      "Acampa Kids: {name}, tu transporte ahora es {bus}. Mira: {link}",
      "Acampa Kids : {name}, ton transport est maintenant {bus} : {link}",
      "Acampa Kids: {name}, dein Transport ist jetzt {bus}: {link}",
    ),
  },
  {
    slug: S.roleAssigned,
    name: "Nova função na programação",
    channel: "sms",
    variables: ["name", "event", "duty", "link"],
    body: t(
      "Acampa Kids: {name}, em {event} você serve em {duty}. {link}",
      "Acampa Kids: {name}, at {event} you serve in {duty}. {link}",
      "Acampa Kids: {name}, en {event} sirves en {duty}. {link}",
      "Acampa Kids : {name}, à {event} tu sers à {duty}. {link}",
      "Acampa Kids: {name}, bei {event} dienst du bei {duty}. {link}",
    ),
  },
  {
    slug: S.roleRemoved,
    name: "Função na programação retirada",
    channel: "sms",
    variables: ["name", "event", "link"],
    body: t(
      "Acampa Kids: {name}, sua função em {event} mudou. Veja: {link}",
      "Acampa Kids: {name}, your duty at {event} changed. See {link}",
      "Acampa Kids: {name}, tu función en {event} cambió. Mira: {link}",
      "Acampa Kids : {name}, ta fonction à {event} a changé : {link}",
      "Acampa Kids: {name}, deine Aufgabe bei {event} hat sich geändert: {link}",
    ),
  },
  {
    slug: S.eventCancelled,
    name: "Atividade cancelada",
    channel: "sms",
    variables: ["name", "event", "link"],
    body: t(
      "Acampa Kids: {name}, {event} saiu da programação. Veja: {link}",
      "Acampa Kids: {name}, {event} was removed from the schedule. See {link}",
      "Acampa Kids: {name}, {event} salió del programa. Mira: {link}",
      "Acampa Kids : {name}, {event} a été retiré du programme : {link}",
      "Acampa Kids: {name}, {event} wurde aus dem Plan genommen: {link}",
    ),
  },
  {
    slug: S.eventMoved,
    name: "Atividade mudou de horário",
    channel: "sms",
    variables: ["name", "event", "when", "link"],
    body: t(
      "Acampa Kids: {name}, {event} agora é {when}. {link}",
      "Acampa Kids: {name}, {event} is now {when}. {link}",
      "Acampa Kids: {name}, {event} ahora es {when}. {link}",
      "Acampa Kids : {name}, {event} a lieu {when}. {link}",
      "Acampa Kids: {name}, {event} ist jetzt {when}. {link}",
    ),
  },
  {
    slug: S.instructionsUpdated,
    name: "Instruções atualizadas",
    channel: "sms",
    variables: ["name", "title", "link"],
    body: t(
      "Acampa Kids: {name}, as instruções \"{title}\" mudaram. Leia: {link}",
      "Acampa Kids: {name}, the instructions \"{title}\" changed. Read: {link}",
      "Acampa Kids: {name}, las instrucciones \"{title}\" cambiaron. Lee: {link}",
      "Acampa Kids : {name}, les consignes « {title} » ont changé : {link}",
      "Acampa Kids: {name}, die Anleitung „{title}“ wurde geändert: {link}",
    ),
  },
  {
    slug: S.preparationUpdated,
    name: "Preparação atualizada",
    channel: "sms",
    variables: ["name", "title", "link"],
    body: t(
      "Acampa Kids: {name}, a preparação \"{title}\" mudou. Veja: {link}",
      "Acampa Kids: {name}, the preparation \"{title}\" changed. See {link}",
      "Acampa Kids: {name}, la preparación \"{title}\" cambió. Mira: {link}",
      "Acampa Kids : {name}, la préparation « {title} » a changé : {link}",
      "Acampa Kids: {name}, die Vorbereitung „{title}“ wurde geändert: {link}",
    ),
  },
  {
    slug: S.photosPublished,
    name: "Fotos do acampamento publicadas",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, as fotos do acampamento já estão no app 📷 {link}",
      "Acampa Kids: {name}, the camp photos are in the app 📷 {link}",
      "Acampa Kids: {name}, las fotos del campamento ya están en la app 📷 {link}",
      "Acampa Kids : {name}, les photos du camp sont dans l'appli 📷 {link}",
      "Acampa Kids: {name}, die Camp-Fotos sind in der App 📷 {link}",
    ),
  },
  {
    slug: S.busBoarded,
    name: "Criança embarcou no ônibus",
    channel: "sms",
    variables: ["name", "kid"],
    body: t(
      "Acampa Kids: {name}, {kid} já está com a nossa equipe a caminho de um fim de semana incrível! 🚌",
      "Acampa Kids: {name}, {kid} is with our team on the way to an amazing weekend! 🚌",
      "Acampa Kids: {name}, ¡{kid} ya está con nuestro equipo rumbo a un fin de semana increíble! 🚌",
      "Acampa Kids : {name}, {kid} est avec notre équipe, en route pour un super week-end ! 🚌",
      "Acampa Kids: {name}, {kid} ist bei unserem Team, unterwegs zu einem tollen Wochenende! 🚌",
    ),
  },
  {
    slug: S.parentWelcome,
    name: "Boas-vindas à família",
    channel: "sms",
    variables: ["name", "kids", "link"],
    body: t(
      "Acampa Kids: {name}, que alegria ter {kids} no acampamento! Acompanhe pelo app: {link}",
      "Acampa Kids: {name}, so glad to have {kids} at camp! Follow along in the app: {link}",
      "Acampa Kids: {name}, ¡qué alegría tener a {kids} en el campamento! Síguelo en {link}",
      "Acampa Kids : {name}, quelle joie d'accueillir {kids} ! Suis le camp sur {link}",
      "Acampa Kids: {name}, schön, dass {kids} dabei ist! Alles in der App: {link}",
    ),
  },
  {
    slug: S.teamWelcome,
    name: "Boas-vindas à equipe",
    channel: "sms",
    variables: ["name", "link"],
    body: t(
      "Acampa Kids: {name}, que bom servir com você! O app da equipe está liberado: {link}",
      "Acampa Kids: {name}, glad to serve with you! The team app is open: {link}",
      "Acampa Kids: {name}, ¡qué bueno servir contigo! La app del equipo está abierta: {link}",
      "Acampa Kids : {name}, quelle joie de servir avec toi ! L'appli est ouverte : {link}",
      "Acampa Kids: {name}, schön, mit dir zu dienen! Die Team-App ist offen: {link}",
    ),
  },
  {
    slug: S.importFinished,
    name: "Importação concluída",
    channel: "sms",
    variables: ["name", "count", "link"],
    body: t(
      "Acampa Kids: {name}, a importação terminou: {count} cadastros revisados. Veja: {link}",
      "Acampa Kids: {name}, the import finished: {count} records reviewed. See {link}",
      "Acampa Kids: {name}, la importación terminó: {count} registros revisados: {link}",
      "Acampa Kids : {name}, import terminé : {count} fiches vérifiées. Voir {link}",
      "Acampa Kids: {name}, Import fertig: {count} Einträge geprüft: {link}",
    ),
  },
  {
    slug: S.importErrors,
    name: "Importação precisa de atenção",
    channel: "sms",
    variables: ["name", "failed", "total", "link"],
    body: t(
      "Acampa Kids: {name}, {failed} de {total} cadastros importados precisam de revisão: {link}",
      "Acampa Kids: {name}, {failed} of {total} imported records need a review: {link}",
      "Acampa Kids: {name}, {failed} de {total} registros importados necesitan revisión: {link}",
      "Acampa Kids : {name}, {failed} fiches sur {total} sont à vérifier : {link}",
      "Acampa Kids: {name}, {failed} von {total} Einträgen brauchen eine Prüfung: {link}",
    ),
  },
  {
    slug: S.campDeleteCode,
    name: "Código para apagar um ano do acampamento",
    channel: "sms",
    variables: ["name", "code", "minutes"],
    body: t(
      "Acampa Kids: {name}, o código para apagar este ano do acampamento é {code}. Vale {minutes} min.",
      "Acampa Kids: {name}, the code to delete this camp year is {code}. Valid {minutes} min.",
      "Acampa Kids: {name}, el código para borrar este año es {code}. Vale {minutes} min.",
      "Acampa Kids : {name}, le code pour supprimer cette année est {code}. Valable {minutes} min.",
      "Acampa Kids: {name}, der Code zum Löschen dieses Jahres ist {code}. {minutes} Min. gültig.",
    ),
  },
];

/** E-mail twins (sent next to the SMS when present). Plain text bodies; the subject is localized too. */
const EMAIL: TemplateDefault[] = [
  {
    slug: emailSlug(S.parentWelcome),
    name: "Boas-vindas à família (e-mail)",
    channel: "email",
    variables: ["name", "kids", "link"],
    subject: t("Bem-vindos ao Acampa Kids!", "Welcome to Acampa Kids!", "¡Bienvenidos a Acampa Kids!", "Bienvenue à Acampa Kids !", "Willkommen bei Acampa Kids!"),
    body: t(
      "Olá, {name}!\n\nQue alegria ter {kids} no acampamento. Pelo app você acompanha a programação, as fotos e os contatos da equipe: {link}\n\nCom carinho,\nEquipe Acampa Kids",
      "Hi {name}!\n\nWe're so glad to have {kids} at camp. In the app you can follow the schedule, the photos and the team contacts: {link}\n\nWith love,\nThe Acampa Kids team",
      "¡Hola, {name}!\n\nQué alegría tener a {kids} en el campamento. En la app sigues el programa, las fotos y los contactos del equipo: {link}\n\nCon cariño,\nEquipo Acampa Kids",
      "Bonjour {name} !\n\nQuelle joie d'accueillir {kids} au camp. Dans l'appli, tu suis le programme, les photos et les contacts de l'équipe : {link}\n\nAvec affection,\nL'équipe Acampa Kids",
      "Hallo {name}!\n\nWie schön, dass {kids} beim Camp dabei ist. In der App findest du Programm, Fotos und Team-Kontakte: {link}\n\nHerzlich,\nDein Acampa-Kids-Team",
    ),
  },
  {
    slug: emailSlug(S.busBoarded),
    name: "Criança embarcou no ônibus (e-mail)",
    channel: "email",
    variables: ["name", "kid"],
    subject: t("{kid} já está a caminho! 🚌", "{kid} is on the way! 🚌", "¡{kid} ya va en camino! 🚌", "{kid} est en route ! 🚌", "{kid} ist unterwegs! 🚌"),
    body: t(
      "Olá, {name}!\n\n{kid} já está com a nossa equipe a caminho de um fim de semana incrível.\n\nCom carinho,\nEquipe Acampa Kids",
      "Hi {name}!\n\n{kid} is with our team on the way to an amazing weekend.\n\nWith love,\nThe Acampa Kids team",
      "¡Hola, {name}!\n\n{kid} ya está con nuestro equipo camino a un fin de semana increíble.\n\nCon cariño,\nEquipo Acampa Kids",
      "Bonjour {name} !\n\n{kid} est avec notre équipe, en route pour un week-end génial.\n\nAvec affection,\nL'équipe Acampa Kids",
      "Hallo {name}!\n\n{kid} ist bei unserem Team, unterwegs zu einem tollen Wochenende.\n\nHerzlich,\nDein Acampa-Kids-Team",
    ),
  },
  {
    slug: emailSlug(S.teamWelcome),
    name: "Boas-vindas à equipe (e-mail)",
    channel: "email",
    variables: ["name", "link"],
    subject: t("O app da equipe está liberado", "The team app is open", "La app del equipo está abierta", "L'appli de l'équipe est ouverte", "Die Team-App ist offen"),
    body: t(
      "Olá, {name}!\n\nQue bom servir com você no Acampa Kids. O app da equipe já está liberado: {link}\n\nEquipe Acampa Kids",
      "Hi {name}!\n\nSo glad to serve with you at Acampa Kids. The team app is open: {link}\n\nThe Acampa Kids team",
      "¡Hola, {name}!\n\nQué bueno servir contigo en Acampa Kids. La app del equipo ya está abierta: {link}\n\nEquipo Acampa Kids",
      "Bonjour {name} !\n\nQuelle joie de servir avec toi à Acampa Kids. L'appli de l'équipe est ouverte : {link}\n\nL'équipe Acampa Kids",
      "Hallo {name}!\n\nSchön, mit dir bei Acampa Kids zu dienen. Die Team-App ist offen: {link}\n\nDein Acampa-Kids-Team",
    ),
  },
  {
    slug: emailSlug(S.occurrence),
    name: "Nova ocorrência registrada (e-mail)",
    channel: "email",
    variables: ["name", "link"],
    subject: t("Nova ocorrência no acampamento", "New incident note at camp", "Nueva ocurrencia en el campamento", "Nouvel événement au camp", "Neuer Vorfall im Camp"),
    body: t(
      "Olá, {name}.\n\nUma nova ocorrência foi registrada. Veja os detalhes no app: {link}",
      "Hi {name}.\n\nA new incident note was recorded. See the details in the app: {link}",
      "Hola, {name}.\n\nSe registró una nueva ocurrencia. Mira los detalles en la app: {link}",
      "Bonjour {name}.\n\nUn nouvel événement a été enregistré. Voir les détails dans l'appli : {link}",
      "Hallo {name}.\n\nEin neuer Vorfall wurde eingetragen. Details in der App: {link}",
    ),
  },
];

export const TEMPLATE_DEFAULTS: TemplateDefault[] = [...SMS, ...EMAIL];

export function templateDefault(slug: string): TemplateDefault | null {
  return TEMPLATE_DEFAULTS.find((d) => d.slug === slug) ?? null;
}

/** Does the catalog define an e-mail twin for this SMS slug? */
export function hasEmailTwin(slug: string): boolean {
  return TEMPLATE_DEFAULTS.some((d) => d.slug === emailSlug(slug));
}

export const SMS_BODY_MAX = 160;
export const SLUG_RE = /^[a-z0-9-]{3,60}$/;

/** Placeholders used in a text (`{var}`). */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

/** The §11 rules core enforces, checked locally before a PATCH (null = valid). */
export function validateTemplate(tpl: Pick<TemplateDefault, "slug" | "channel" | "body" | "subject" | "variables">): string | null {
  if (!SLUG_RE.test(tpl.slug)) return "slug inválido";
  if (!tpl.body["pt-BR"]?.trim()) return "o texto em português é obrigatório";
  for (const [lang, text] of [...Object.entries(tpl.body), ...Object.entries(tpl.subject ?? {})]) {
    if (typeof text !== "string") return `texto inválido (${lang})`;
    const unknown = placeholders(text).filter((v) => !tpl.variables.includes(v));
    if (unknown.length) return `variáveis desconhecidas em ${lang}: ${unknown.join(", ")}`;
  }
  if (tpl.channel === "sms") for (const [lang, text] of Object.entries(tpl.body)) if (text.length > SMS_BODY_MAX) return `SMS acima de ${SMS_BODY_MAX} caracteres (${lang})`;
  return null;
}
