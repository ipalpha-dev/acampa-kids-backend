import { config } from "../config";
import { format, type Locale } from "./locales";

/** Every SMS the backend sends — PT / EN / ES / FR / DE. Keep under ~160 chars when interpolated. */
export type SmsKey =
  | "otp"
  | "adminInvite"
  | "coalesceTail"
  | "coalesceTailMany"
  | "coalesceLink"
  | "checkinDone"
  | "checkinDoneShort"
  | "checkinRoom"
  | "checkinRoomKids"
  | "checkinBus"
  | "checkinReminder"
  | "birthday"
  | "birthdayAge"
  | "birthdayRoom"
  | "parentEditMedical"
  | "parentEditNotes"
  | "occurrence"
  | "foreignLookup"
  | "foreignLookupPlural"
  | "photos"
  | "busCheckin"
  | "parentWelcomeOne"
  | "parentWelcomeMany"
  | "parentWelcomeFallback"
  | "parentWelcomeEnterPhone"
  | "parentWelcomeEnter"
  | "enrolRoles"
  | "enrolOpen"
  | "enrolNewRoles"
  | "enrolEnterPhone"
  | "enrolEnter"
  | "kidLost"
  | "kidLostTo"
  | "kidGained"
  | "kidGainedRoom"
  | "kidsLost"
  | "kidsLostTo"
  | "kidsGained"
  | "kidsGainedRoom"
  | "myRoomNow"
  | "myRoomNone"
  | "myRoomRoleCaretaker"
  | "myRoomRoleHelper"
  | "myTeamNow"
  | "myTeamNone"
  | "myBusNow"
  | "myBusNone"
  | "roomsKidsGainedLost"
  | "roomsKidsGained"
  | "roomsKidsLost"
  | "roomsKidsSame"
  | "roomsKidsCountGainLose"
  | "roomsKidsCountGain"
  | "roomsKidsCountLose"
  | "roleAssigned"
  | "roleEventCancelled"
  | "roleLeft"
  | "roleChanged"
  | "roleMoved"
  | "roleRenamed"
  | "roleNowAuto"
  | "roleNowManual"
  | "instructionsNew"
  | "instructionsRenamed"
  | "instructionsUpdated"
  | "prepNew"
  | "prepRenamed"
  | "prepUpdated"
  | "otherRole"
  | "importFinished"
  | "importErrors"
  | "and"
  | "changeMore"
  | "changeMorePlural"
  | "verbIsOne"
  | "verbIsMany"
  | "verbBecameOne"
  | "verbBecameMany"
  | "kidPluralSuffix"
  | "childSingular"
  | "childPlural"
  | "childNewSingular"
  | "childNewPlural"
  | "camperSingular"
  | "camperPlural"
  | "staffTeam"
  | "guardianOf"
  | "seeIn"
  | "ofHer"
  | "ofHim"
  | "her"
  | "him"
  | "theF"
  | "theM"
  | "enrolledF"
  | "enrolledM"
  | "enrolledFp"
  | "enrolledMp"
  | "fieldAllergies"
  | "fieldDrugAllergies"
  | "fieldHealthIssues"
  | "fieldMedications"
  | "fieldFoodRestrictions"
  | "fieldHealthNotes"
  | "fieldWeightKg"
  | "fieldInsurance"
  | "fieldInsuranceCard"
  | "fieldGeneralNotes"
  | "fieldNeurodivergent"
  | "roleOrganizer"
  | "roleGameOrganizer"
  | "roleScoreHelper"
  | "roleCheckinHelper"
  | "roleBusHelper"
  | "roleBusHelperNamed"
  | "roleMedical"
  | "roleVestHelper"
  | "rolePhotographer"
  | "roleParentContact";

export type Catalog = Record<SmsKey, string>;

const pt: Catalog = {
  otp: "{prefix}: {code} é seu código de acesso. Vale por {minutes} min. Se não foi você, ignore.",
  adminInvite: "{prefix}: {name}, agora você administra o Acampa Kids. Entre com este celular: {url}",
  coalesceTail: " +{rest} mudança. Veja em {link}",
  coalesceTailMany: " +{rest} mudanças. Veja em {link}",
  coalesceLink: ". {link}",
  checkinDone: "{prefix}: {name}, check-in feito!{info} Confira as crianças do seu quarto em {link}",
  checkinDoneShort: "{prefix}: {name}, check-in feito!{info} {link}",
  checkinRoom: "Seu quarto: {room}",
  checkinRoomKids: "Seu quarto: {room} ({kids} crianças)",
  checkinBus: "Transporte: {bus}",
  checkinReminder: "{prefix}: {name}, chegou a hora do seu check-in! Ao chegar na igreja, faça o check-in em {link}",
  birthday: "{prefix}: {name}, hoje é aniversário {of} {kid}{age}{room}! 🎂 Vamos fazer o dia {pron} especial.",
  birthdayAge: " ({years} anos)",
  birthdayRoom: ", do quarto {room}",
  parentEditMedical: "{prefix}: {name}, {by} alterou dados médicos de {kid}{list}. Veja em {link}",
  parentEditNotes: "{prefix}: {name}, {by} alterou observações de {kid}{list}. Veja em {link}",
  occurrence: "{prefix}: {name}, nova ocorrência registrada por {by}{who}. Veja em {link}",
  foreignLookup: "{prefix}: {name}, {staff} leu {count} criança fora do escopo{list}. Veja em {link}",
  foreignLookupPlural: "{prefix}: {name}, {staff} leu {count} crianças fora do escopo{list}. Veja em {link}",
  photos: "as fotos do acampamento já estão no app 📷",
  busCheckin: "{prefix}: {greet}{article} {kid} está a caminho de um fim de semana incrível para aprender sobre Jesus! Aproveite o fim de semana livre: vamos cuidar muito bem {pron}.",
  parentWelcomeOne: "{who} no Acampa Kids! Acompanhe tudo pelo app.",
  parentWelcomeMany: "{who} no Acampa Kids! Acompanhe tudo pelo app.",
  parentWelcomeFallback: "sua criança está inscrita",
  parentWelcomeEnterPhone: " Entre com o celular {phone} em {link}",
  parentWelcomeEnter: " Entre em {link}",
  enrolRoles: "você agora é {roles}",
  enrolOpen: "o app do acampamento está liberado para você",
  enrolNewRoles: "você recebeu {count} novas funções no acampamento",
  enrolEnterPhone: " Entre com o celular {phone} em {link}",
  enrolEnter: " Entre em {link}",
  kidLost: "{kid} não está mais sob seus cuidados",
  kidLostTo: "{kid} não está mais sob seus cuidados (agora com {to})",
  kidGained: "{kid} passou a ser sua responsabilidade (agora {n} criança com você)",
  kidGainedRoom: "{kid} (quarto {room}) passou a ser sua responsabilidade (agora {n} criança{s} com você)",
  kidsLost: "{names} não {verb} mais sob seus cuidados",
  kidsLostTo: "{names} não {verb} mais sob seus cuidados (agora com {to})",
  kidsGained: "{names} {verb} a ser sua responsabilidade",
  kidsGainedRoom: "{names} {verb} a ser sua responsabilidade (quarto {room})",
  myRoomNow: "seu quarto agora é o {room}",
  myRoomNone: "você saiu do seu quarto",
  myRoomRoleCaretaker: "agora você é LÍDER de crianças no seu quarto (veja quais no app)",
  myRoomRoleHelper: "agora você é AUXILIAR no seu quarto (sem crianças próprias)",
  myTeamNow: "seu time agora é {team}",
  myTeamNone: "você saiu do seu time",
  myBusNow: "seu transporte agora é {bus}",
  myBusNone: "você ficou sem transporte definido",
  roomsKidsGainedLost: "{gained} {gVerb} sob seus cuidados; {lost} não {lVerb}",
  roomsKidsGained: "{gained} {gVerb} sob seus cuidados",
  roomsKidsLost: "{lost} não {lVerb} mais sob seus cuidados",
  roomsKidsSame: "as crianças são as mesmas",
  roomsKidsCountGainLose: "você ganhou {g} e perdeu {l} {kids}",
  roomsKidsCountGain: "você ganhou {g} {kids}",
  roomsKidsCountLose: "você perdeu {l} {kids}",
  roleAssigned: "{event}: você é {duty}",
  roleEventCancelled: "{event} foi cancelado",
  roleLeft: "{event}: você saiu da escala",
  roleChanged: "{event}: agora você é {duty}",
  roleMoved: "{title} mudou para {when}: você é {duty}",
  roleRenamed: 'sua função "{before}" agora se chama "{after}"',
  roleNowAuto: "a função {role} agora vale para {audience}: confira sua escala",
  roleNowManual: "a função {role} agora só vale para quem for escalado: confira sua escala",
  instructionsNew: 'novas instruções: "{title}"',
  instructionsRenamed: 'instruções "{before}" viraram "{after}"',
  instructionsUpdated: 'instruções "{title}" atualizadas',
  prepNew: 'nova preparação: "{title}"',
  prepRenamed: 'preparação "{before}" virou "{after}"',
  prepUpdated: 'preparação "{title}" atualizada',
  otherRole: "outra função",
  importFinished: "AcampaKids: a revisão por IA da importação {file} terminou. {ok}/{total} {subject} revisados.",
  importErrors: "AcampaKids: a revisão por IA de {file} teve {errors}/{total} erros. Verifique o worker.",
  and: " e ",
  changeMore: "mudança",
  changeMorePlural: "mudanças",
  verbIsOne: "está",
  verbIsMany: "estão",
  verbBecameOne: "passou",
  verbBecameMany: "passaram",
  kidPluralSuffix: "s",
  childSingular: "criança",
  childPlural: "crianças",
  childNewSingular: "criança nova",
  childNewPlural: "crianças novas",
  camperSingular: "criança",
  camperPlural: "crianças",
  staffTeam: "equipe",
  guardianOf: "responsável de {name}",
  seeIn: "Veja em {link}",
  ofHer: "da",
  ofHim: "do",
  her: "dela",
  him: "dele",
  theF: "a",
  theM: "o",
  enrolledF: "a {name} está inscrita",
  enrolledM: "o {name} está inscrito",
  enrolledFp: "{names} estão inscritas",
  enrolledMp: "{names} estão inscritos",
  fieldAllergies: "alergias",
  fieldDrugAllergies: "alergia a medicamentos",
  fieldHealthIssues: "condição de saúde",
  fieldMedications: "medicação",
  fieldFoodRestrictions: "alimentação",
  fieldHealthNotes: "observações médicas",
  fieldWeightKg: "peso",
  fieldInsurance: "convênio",
  fieldInsuranceCard: "carteirinha do convênio",
  fieldGeneralNotes: "observações",
  fieldNeurodivergent: "neurodivergente",
  roleOrganizer: "organizador (acesso de administração)",
  roleGameOrganizer: "organizador dos jogos (programação e placar)",
  roleScoreHelper: "ajudante do placar (lança pontos)",
  roleCheckinHelper: "ajudante do check-in",
  roleBusHelper: "na porta do ônibus (embarque das crianças)",
  roleBusHelperNamed: "na porta do {vehicle} (embarque das crianças)",
  roleMedical: "equipe médica",
  roleVestHelper: "responsável pelos coletes (entrega e devolução)",
  rolePhotographer: "fotógrafo do acampamento (envia as fotos)",
  roleParentContact: "contato dos pais ({title})",
};

const en: Catalog = {
  otp: "{prefix}: {code} is your access code. Valid for {minutes} min. If this wasn't you, ignore it.",
  adminInvite: "{prefix}: {name}, you now admin Acampa Kids. Sign in with this phone: {url}",
  coalesceTail: " +{rest} change. See {link}",
  coalesceTailMany: " +{rest} changes. See {link}",
  coalesceLink: ". {link}",
  checkinDone: "{prefix}: {name}, checked in!{info} See the kids in your room at {link}",
  checkinDoneShort: "{prefix}: {name}, checked in!{info} {link}",
  checkinRoom: "Your room: {room}",
  checkinRoomKids: "Your room: {room} ({kids} kids)",
  checkinBus: "Transport: {bus}",
  checkinReminder: "{prefix}: {name}, time for check-in! When you arrive at church, check in at {link}",
  birthday: "{prefix}: {name}, today is {kid}'s birthday{age}{room}! 🎂 Let's make {pron} day special.",
  birthdayAge: " ({years} yrs)",
  birthdayRoom: ", room {room}",
  parentEditMedical: "{prefix}: {name}, {by} updated {kid}'s medical info{list}. See {link}",
  parentEditNotes: "{prefix}: {name}, {by} updated {kid}'s notes{list}. See {link}",
  occurrence: "{prefix}: {name}, new incident logged by {by}{who}. See {link}",
  foreignLookup: "{prefix}: {name}, {staff} scanned {count} kid out of scope{list}. See {link}",
  foreignLookupPlural: "{prefix}: {name}, {staff} scanned {count} kids out of scope{list}. See {link}",
  photos: "camp photos are now in the app 📷",
  busCheckin: "{prefix}: {greet}{article} {kid} is on the way to an amazing weekend learning about Jesus! Enjoy your free weekend — we'll take great care of {pron}.",
  parentWelcomeOne: "{who} in Acampa Kids! Follow everything in the app.",
  parentWelcomeMany: "{who} in Acampa Kids! Follow everything in the app.",
  parentWelcomeFallback: "your child is enrolled",
  parentWelcomeEnterPhone: " Sign in with phone {phone} at {link}",
  parentWelcomeEnter: " Sign in at {link}",
  enrolRoles: "you are now {roles}",
  enrolOpen: "the camp app is open for you",
  enrolNewRoles: "you received {count} new roles at camp",
  enrolEnterPhone: " Sign in with phone {phone} at {link}",
  enrolEnter: " Sign in at {link}",
  kidLost: "{kid} is no longer in your care",
  kidLostTo: "{kid} is no longer in your care (now with {to})",
  kidGained: "{kid} is now your responsibility (you now have {n} kid)",
  kidGainedRoom: "{kid} (room {room}) is now your responsibility (you now have {n} kid{s})",
  kidsLost: "{names} {verb} no longer in your care",
  kidsLostTo: "{names} {verb} no longer in your care (now with {to})",
  kidsGained: "{names} {verb} now your responsibility",
  kidsGainedRoom: "{names} {verb} now your responsibility (room {room})",
  myRoomNow: "your room is now {room}",
  myRoomNone: "you left your room",
  myRoomRoleCaretaker: "you are now a ROOM LEADER (see your kids in the app)",
  myRoomRoleHelper: "you are now a ROOM HELPER (no kids of your own)",
  myTeamNow: "your team is now {team}",
  myTeamNone: "you left your team",
  myBusNow: "your transport is now {bus}",
  myBusNone: "you have no transport assigned",
  roomsKidsGainedLost: "{gained} {gVerb} in your care; {lost} {lVerb}",
  roomsKidsGained: "{gained} {gVerb} in your care",
  roomsKidsLost: "{lost} {lVerb} no longer in your care",
  roomsKidsSame: "the kids are the same",
  roomsKidsCountGainLose: "you gained {g} and lost {l} {kids}",
  roomsKidsCountGain: "you gained {g} {kids}",
  roomsKidsCountLose: "you lost {l} {kids}",
  roleAssigned: "{event}: you are {duty}",
  roleEventCancelled: "{event} was cancelled",
  roleLeft: "{event}: you left the roster",
  roleChanged: "{event}: you are now {duty}",
  roleMoved: "{title} moved to {when}: you are {duty}",
  roleRenamed: 'your role "{before}" is now called "{after}"',
  roleNowAuto: "role {role} now covers {audience}: check your schedule",
  roleNowManual: "role {role} is now assignment-only: check your schedule",
  instructionsNew: 'new instructions: "{title}"',
  instructionsRenamed: 'instructions "{before}" became "{after}"',
  instructionsUpdated: 'instructions "{title}" updated',
  prepNew: 'new prep: "{title}"',
  prepRenamed: 'prep "{before}" became "{after}"',
  prepUpdated: 'prep "{title}" updated',
  otherRole: "another role",
  importFinished: "AcampaKids: AI review of import {file} finished. {ok}/{total} {subject} reviewed.",
  importErrors: "AcampaKids: AI review of {file} had {errors}/{total} errors. Check the worker.",
  and: " and ",
  changeMore: "change",
  changeMorePlural: "changes",
  verbIsOne: "is",
  verbIsMany: "are",
  verbBecameOne: "is",
  verbBecameMany: "are",
  kidPluralSuffix: "s",
  childSingular: "kid",
  childPlural: "kids",
  childNewSingular: "new kid",
  childNewPlural: "new kids",
  camperSingular: "camper",
  camperPlural: "campers",
  staffTeam: "staff",
  guardianOf: "guardian of {name}",
  seeIn: "See {link}",
  ofHer: "",
  ofHim: "",
  her: "her",
  him: "his",
  theF: "",
  theM: "",
  enrolledF: "{name} is enrolled",
  enrolledM: "{name} is enrolled",
  enrolledFp: "{names} are enrolled",
  enrolledMp: "{names} are enrolled",
  fieldAllergies: "allergies",
  fieldDrugAllergies: "drug allergies",
  fieldHealthIssues: "health condition",
  fieldMedications: "medication",
  fieldFoodRestrictions: "diet",
  fieldHealthNotes: "medical notes",
  fieldWeightKg: "weight",
  fieldInsurance: "insurance",
  fieldInsuranceCard: "insurance card",
  fieldGeneralNotes: "notes",
  fieldNeurodivergent: "neurodivergent",
  roleOrganizer: "organizer (admin access)",
  roleGameOrganizer: "games organizer (schedule & scoreboard)",
  roleScoreHelper: "scoreboard helper (awards points)",
  roleCheckinHelper: "check-in helper",
  roleBusHelper: "at the bus door (kids boarding)",
  roleBusHelperNamed: "at the door of the {vehicle} (kids boarding)",
  roleMedical: "medical team",
  roleVestHelper: "vest helper (hand out & collect)",
  rolePhotographer: "camp photographer (uploads photos)",
  roleParentContact: "parent contact ({title})",
};

const es: Catalog = {
  otp: "{prefix}: {code} es tu código de acceso. Válido {minutes} min. Si no fuiste tú, ignóralo.",
  adminInvite: "{prefix}: {name}, ahora administras Acampa Kids. Entra con este celular: {url}",
  coalesceTail: " +{rest} cambio. Ver en {link}",
  coalesceTailMany: " +{rest} cambios. Ver en {link}",
  coalesceLink: ". {link}",
  checkinDone: "{prefix}: {name}, ¡check-in listo!{info} Revisa los niños de tu habitación en {link}",
  checkinDoneShort: "{prefix}: {name}, ¡check-in listo!{info} {link}",
  checkinRoom: "Tu habitación: {room}",
  checkinRoomKids: "Tu habitación: {room} ({kids} niños)",
  checkinBus: "Transporte: {bus}",
  checkinReminder: "{prefix}: {name}, ¡llegó la hora del check-in! Al llegar a la iglesia, hazlo en {link}",
  birthday: "{prefix}: {name}, hoy es el cumpleaños {of} {kid}{age}{room}! 🎂 Hagamos especial el día {pron}.",
  birthdayAge: " ({years} años)",
  birthdayRoom: ", habitación {room}",
  parentEditMedical: "{prefix}: {name}, {by} cambió datos médicos de {kid}{list}. Ver en {link}",
  parentEditNotes: "{prefix}: {name}, {by} cambió observaciones de {kid}{list}. Ver en {link}",
  occurrence: "{prefix}: {name}, nuevo incidente registrado por {by}{who}. Ver en {link}",
  foreignLookup: "{prefix}: {name}, {staff} leyó {count} niño fuera de alcance{list}. Ver en {link}",
  foreignLookupPlural: "{prefix}: {name}, {staff} leyó {count} niños fuera de alcance{list}. Ver en {link}",
  photos: "las fotos del campamento ya están en la app 📷",
  busCheckin: "{prefix}: {greet}{article} {kid} va camino a un fin de semana increíble para aprender de Jesús! Disfruta tu fin de semana libre: cuidaremos muy bien {pron}.",
  parentWelcomeOne: "{who} en Acampa Kids! Sigue todo por la app.",
  parentWelcomeMany: "{who} en Acampa Kids! Sigue todo por la app.",
  parentWelcomeFallback: "tu hijo/a está inscrito/a",
  parentWelcomeEnterPhone: " Entra con el celular {phone} en {link}",
  parentWelcomeEnter: " Entra en {link}",
  enrolRoles: "ahora eres {roles}",
  enrolOpen: "la app del campamento está liberada para ti",
  enrolNewRoles: "recibiste {count} nuevas funciones en el campamento",
  enrolEnterPhone: " Entra con el celular {phone} en {link}",
  enrolEnter: " Entra en {link}",
  kidLost: "{kid} ya no está bajo tu cuidado",
  kidLostTo: "{kid} ya no está bajo tu cuidado (ahora con {to})",
  kidGained: "{kid} pasó a ser tu responsabilidad (ahora {n} niño contigo)",
  kidGainedRoom: "{kid} (hab. {room}) pasó a ser tu responsabilidad (ahora {n} niño{s} contigo)",
  kidsLost: "{names} ya no {verb} bajo tu cuidado",
  kidsLostTo: "{names} ya no {verb} bajo tu cuidado (ahora con {to})",
  kidsGained: "{names} {verb} a ser tu responsabilidad",
  kidsGainedRoom: "{names} {verb} a ser tu responsabilidad (hab. {room})",
  myRoomNow: "tu habitación ahora es {room}",
  myRoomNone: "saliste de tu habitación",
  myRoomRoleCaretaker: "ahora eres LÍDER de niños en tu habitación (mira quiénes en la app)",
  myRoomRoleHelper: "ahora eres AUXILIAR en tu habitación (sin niños propios)",
  myTeamNow: "tu equipo ahora es {team}",
  myTeamNone: "saliste de tu equipo",
  myBusNow: "tu transporte ahora es {bus}",
  myBusNone: "quedaste sin transporte definido",
  roomsKidsGainedLost: "{gained} {gVerb} bajo tu cuidado; {lost} ya no {lVerb}",
  roomsKidsGained: "{gained} {gVerb} bajo tu cuidado",
  roomsKidsLost: "{lost} ya no {lVerb} bajo tu cuidado",
  roomsKidsSame: "los niños son los mismos",
  roomsKidsCountGainLose: "ganaste {g} y perdiste {l} {kids}",
  roomsKidsCountGain: "ganaste {g} {kids}",
  roomsKidsCountLose: "perdiste {l} {kids}",
  roleAssigned: "{event}: eres {duty}",
  roleEventCancelled: "{event} fue cancelado",
  roleLeft: "{event}: saliste de la escala",
  roleChanged: "{event}: ahora eres {duty}",
  roleMoved: "{title} cambió a {when}: eres {duty}",
  roleRenamed: 'tu función "{before}" ahora se llama "{after}"',
  roleNowAuto: "la función {role} ahora vale para {audience}: revisa tu escala",
  roleNowManual: "la función {role} ahora solo vale para quien sea escalado: revisa tu escala",
  instructionsNew: 'nuevas instrucciones: "{title}"',
  instructionsRenamed: 'instrucciones "{before}" pasaron a "{after}"',
  instructionsUpdated: 'instrucciones "{title}" actualizadas',
  prepNew: 'nueva preparación: "{title}"',
  prepRenamed: 'preparación "{before}" pasó a "{after}"',
  prepUpdated: 'preparación "{title}" actualizada',
  otherRole: "otra función",
  importFinished: "AcampaKids: la revisión por IA de la importación {file} terminó. {ok}/{total} {subject} revisados.",
  importErrors: "AcampaKids: la revisión por IA de {file} tuvo {errors}/{total} errores. Revisa el worker.",
  and: " y ",
  changeMore: "cambio",
  changeMorePlural: "cambios",
  verbIsOne: "está",
  verbIsMany: "están",
  verbBecameOne: "pasó",
  verbBecameMany: "pasaron",
  kidPluralSuffix: "s",
  childSingular: "niño",
  childPlural: "niños",
  childNewSingular: "niño nuevo",
  childNewPlural: "niños nuevos",
  camperSingular: "niño",
  camperPlural: "niños",
  staffTeam: "equipo",
  guardianOf: "responsable de {name}",
  seeIn: "Ver en {link}",
  ofHer: "de",
  ofHim: "de",
  her: "de ella",
  him: "de él",
  theF: "la",
  theM: "el",
  enrolledF: "la {name} está inscrita",
  enrolledM: "el {name} está inscrito",
  enrolledFp: "{names} están inscritas",
  enrolledMp: "{names} están inscritos",
  fieldAllergies: "alergias",
  fieldDrugAllergies: "alergia a medicamentos",
  fieldHealthIssues: "condición de salud",
  fieldMedications: "medicación",
  fieldFoodRestrictions: "alimentación",
  fieldHealthNotes: "observaciones médicas",
  fieldWeightKg: "peso",
  fieldInsurance: "seguro",
  fieldInsuranceCard: "carnet del seguro",
  fieldGeneralNotes: "observaciones",
  fieldNeurodivergent: "neurodivergente",
  roleOrganizer: "organizador (acceso de administración)",
  roleGameOrganizer: "organizador de juegos (programación y marcador)",
  roleScoreHelper: "ayudante del marcador (asigna puntos)",
  roleCheckinHelper: "ayudante del check-in",
  roleBusHelper: "en la puerta del autobús (embarque de los niños)",
  roleBusHelperNamed: "en la puerta del {vehicle} (embarque de los niños)",
  roleMedical: "equipo médico",
  roleVestHelper: "responsable de chalecos (entrega y devolución)",
  rolePhotographer: "fotógrafo del campamento (sube las fotos)",
  roleParentContact: "contacto de padres ({title})",
};

const fr: Catalog = {
  otp: "{prefix}: {code} est votre code d'accès. Valable {minutes} min. Si ce n'est pas vous, ignorez.",
  adminInvite: "{prefix}: {name}, vous administrez maintenant Acampa Kids. Connectez-vous avec ce portable: {url}",
  coalesceTail: " +{rest} changement. Voir {link}",
  coalesceTailMany: " +{rest} changements. Voir {link}",
  coalesceLink: ". {link}",
  checkinDone: "{prefix}: {name}, check-in fait!{info} Voir les enfants de votre chambre sur {link}",
  checkinDoneShort: "{prefix}: {name}, check-in fait!{info} {link}",
  checkinRoom: "Votre chambre: {room}",
  checkinRoomKids: "Votre chambre: {room} ({kids} enfants)",
  checkinBus: "Transport: {bus}",
  checkinReminder: "{prefix}: {name}, c'est l'heure du check-in! À l'église, faites-le sur {link}",
  birthday: "{prefix}: {name}, c'est l'anniversaire {of} {kid}{age}{room}! 🎂 Rendons sa journée spéciale.",
  birthdayAge: " ({years} ans)",
  birthdayRoom: ", chambre {room}",
  parentEditMedical: "{prefix}: {name}, {by} a modifié les données médicales de {kid}{list}. Voir {link}",
  parentEditNotes: "{prefix}: {name}, {by} a modifié les notes de {kid}{list}. Voir {link}",
  occurrence: "{prefix}: {name}, nouvel incident enregistré par {by}{who}. Voir {link}",
  foreignLookup: "{prefix}: {name}, {staff} a scanné {count} enfant hors périmètre{list}. Voir {link}",
  foreignLookupPlural: "{prefix}: {name}, {staff} a scanné {count} enfants hors périmètre{list}. Voir {link}",
  photos: "les photos du camp sont dans l'appli 📷",
  busCheckin: "{prefix}: {greet}{article} {kid} est en route pour un week-end génial pour apprendre sur Jésus! Profitez de votre week-end libre: nous prendrons bien soin {pron}.",
  parentWelcomeOne: "{who} dans Acampa Kids! Suivez tout dans l'appli.",
  parentWelcomeMany: "{who} dans Acampa Kids! Suivez tout dans l'appli.",
  parentWelcomeFallback: "votre enfant est inscrit",
  parentWelcomeEnterPhone: " Connectez-vous avec le portable {phone} sur {link}",
  parentWelcomeEnter: " Connectez-vous sur {link}",
  enrolRoles: "vous êtes maintenant {roles}",
  enrolOpen: "l'appli du camp est ouverte pour vous",
  enrolNewRoles: "vous avez reçu {count} nouvelles fonctions au camp",
  enrolEnterPhone: " Connectez-vous avec le portable {phone} sur {link}",
  enrolEnter: " Connectez-vous sur {link}",
  kidLost: "{kid} n'est plus sous votre responsabilité",
  kidLostTo: "{kid} n'est plus sous votre responsabilité (maintenant avec {to})",
  kidGained: "{kid} est maintenant sous votre responsabilité (vous avez {n} enfant)",
  kidGainedRoom: "{kid} (chambre {room}) est maintenant sous votre responsabilité (vous avez {n} enfant{s})",
  kidsLost: "{names} ne {verb} plus sous votre responsabilité",
  kidsLostTo: "{names} ne {verb} plus sous votre responsabilité (maintenant avec {to})",
  kidsGained: "{names} {verb} sous votre responsabilité",
  kidsGainedRoom: "{names} {verb} sous votre responsabilité (chambre {room})",
  myRoomNow: "votre chambre est maintenant {room}",
  myRoomNone: "vous avez quitté votre chambre",
  myRoomRoleCaretaker: "vous êtes maintenant RESPONSABLE d'enfants dans votre chambre (voir dans l'appli)",
  myRoomRoleHelper: "vous êtes maintenant AUXILIAIRE dans votre chambre (sans enfants propres)",
  myTeamNow: "votre équipe est maintenant {team}",
  myTeamNone: "vous avez quitté votre équipe",
  myBusNow: "votre transport est maintenant {bus}",
  myBusNone: "vous n'avez plus de transport défini",
  roomsKidsGainedLost: "{gained} {gVerb} sous votre responsabilité; {lost} ne {lVerb} plus",
  roomsKidsGained: "{gained} {gVerb} sous votre responsabilité",
  roomsKidsLost: "{lost} ne {lVerb} plus sous votre responsabilité",
  roomsKidsSame: "les enfants sont les mêmes",
  roomsKidsCountGainLose: "vous avez gagné {g} et perdu {l} {kids}",
  roomsKidsCountGain: "vous avez gagné {g} {kids}",
  roomsKidsCountLose: "vous avez perdu {l} {kids}",
  roleAssigned: "{event}: vous êtes {duty}",
  roleEventCancelled: "{event} a été annulé",
  roleLeft: "{event}: vous avez quitté le planning",
  roleChanged: "{event}: vous êtes maintenant {duty}",
  roleMoved: "{title} a changé pour {when}: vous êtes {duty}",
  roleRenamed: 'votre fonction "{before}" s\'appelle maintenant "{after}"',
  roleNowAuto: "la fonction {role} couvre maintenant {audience}: vérifiez votre planning",
  roleNowManual: "la fonction {role} est maintenant sur inscription seulement: vérifiez votre planning",
  instructionsNew: 'nouvelles instructions: "{title}"',
  instructionsRenamed: 'instructions "{before}" sont devenues "{after}"',
  instructionsUpdated: 'instructions "{title}" mises à jour',
  prepNew: 'nouvelle préparation: "{title}"',
  prepRenamed: 'préparation "{before}" est devenue "{after}"',
  prepUpdated: 'préparation "{title}" mise à jour',
  otherRole: "autre fonction",
  importFinished: "AcampaKids: la revue IA de l'import {file} est terminée. {ok}/{total} {subject} revus.",
  importErrors: "AcampaKids: la revue IA de {file} a eu {errors}/{total} erreurs. Vérifiez le worker.",
  and: " et ",
  changeMore: "changement",
  changeMorePlural: "changements",
  verbIsOne: "est",
  verbIsMany: "sont",
  verbBecameOne: "passe",
  verbBecameMany: "passent",
  kidPluralSuffix: "s",
  childSingular: "enfant",
  childPlural: "enfants",
  childNewSingular: "nouvel enfant",
  childNewPlural: "nouveaux enfants",
  camperSingular: "enfant",
  camperPlural: "enfants",
  staffTeam: "équipe",
  guardianOf: "responsable de {name}",
  seeIn: "Voir {link}",
  ofHer: "de",
  ofHim: "de",
  her: "d'elle",
  him: "de lui",
  theF: "la",
  theM: "le",
  enrolledF: "{name} est inscrite",
  enrolledM: "{name} est inscrit",
  enrolledFp: "{names} sont inscrites",
  enrolledMp: "{names} sont inscrits",
  fieldAllergies: "allergies",
  fieldDrugAllergies: "allergie aux médicaments",
  fieldHealthIssues: "état de santé",
  fieldMedications: "médication",
  fieldFoodRestrictions: "alimentation",
  fieldHealthNotes: "notes médicales",
  fieldWeightKg: "poids",
  fieldInsurance: "assurance",
  fieldInsuranceCard: "carte d'assurance",
  fieldGeneralNotes: "notes",
  fieldNeurodivergent: "neurodivergent",
  roleOrganizer: "organisateur (accès admin)",
  roleGameOrganizer: "organisateur des jeux (programme et score)",
  roleScoreHelper: "aide au score (attribue des points)",
  roleCheckinHelper: "aide au check-in",
  roleBusHelper: "à la porte du bus (embarquement des enfants)",
  roleBusHelperNamed: "à la porte du {vehicle} (embarquement des enfants)",
  roleMedical: "équipe médicale",
  roleVestHelper: "responsable des gilets (remise et retour)",
  rolePhotographer: "photographe du camp (envoie les photos)",
  roleParentContact: "contact parents ({title})",
};

const de: Catalog = {
  otp: "{prefix}: {code} ist dein Zugangscode. {minutes} Min. gültig. Warst du das nicht? Einfach ignorieren.",
  adminInvite: "{prefix}: {name}, du verwaltest jetzt Acampa Kids. Melde dich mit diesem Handy an: {url}",
  coalesceTail: " +{rest} Änderung. Siehe {link}",
  coalesceTailMany: " +{rest} Änderungen. Siehe {link}",
  coalesceLink: ". {link}",
  checkinDone: "{prefix}: {name}, Check-in erledigt!{info} Die Kinder in deinem Zimmer siehst du unter {link}",
  checkinDoneShort: "{prefix}: {name}, Check-in erledigt!{info} {link}",
  checkinRoom: "Dein Zimmer: {room}",
  checkinRoomKids: "Dein Zimmer: {room} ({kids} Kinder)",
  checkinBus: "Transport: {bus}",
  checkinReminder: "{prefix}: {name}, Zeit für deinen Check-in! Wenn du an der Kirche ankommst, check ein unter {link}",
  birthday: "{prefix}: {name}, {of}{kid}{age}{room} hat heute Geburtstag! 🎂 Machen wir den Tag für {pron} besonders.",
  birthdayAge: " ({years} Jahre)",
  birthdayRoom: " aus Zimmer {room}",
  parentEditMedical: "{prefix}: {name}, {by} hat Gesundheitsangaben von {kid} geändert{list}. Siehe {link}",
  parentEditNotes: "{prefix}: {name}, {by} hat Hinweise zu {kid} geändert{list}. Siehe {link}",
  occurrence: "{prefix}: {name}, {by} hat ein neues Vorkommnis erfasst{who}. Siehe {link}",
  foreignLookup: "{prefix}: {name}, {staff} hat {count} Kind außerhalb des eigenen Bereichs gescannt{list}. Siehe {link}",
  foreignLookupPlural: "{prefix}: {name}, {staff} hat {count} Kinder außerhalb des eigenen Bereichs gescannt{list}. Siehe {link}",
  photos: "die Fotos vom Camp sind jetzt in der App 📷",
  busCheckin: "{prefix}: {greet}{article}{kid} ist unterwegs zu einem tollen Wochenende, um mehr über Jesus zu lernen! Genieß dein freies Wochenende: Wir kümmern uns gut um {pron}.",
  parentWelcomeOne: "{who} bei Acampa Kids angemeldet! Verfolge alles in der App.",
  parentWelcomeMany: "{who} bei Acampa Kids angemeldet! Verfolge alles in der App.",
  parentWelcomeFallback: "dein Kind ist",
  parentWelcomeEnterPhone: " Melde dich mit der Nummer {phone} an: {link}",
  parentWelcomeEnter: " Melde dich an: {link}",
  enrolRoles: "du bist jetzt {roles}",
  enrolOpen: "die Camp-App ist jetzt für dich freigeschaltet",
  enrolNewRoles: "du hast {count} neue Aufgaben im Camp",
  enrolEnterPhone: " Melde dich mit der Nummer {phone} an: {link}",
  enrolEnter: " Melde dich an: {link}",
  kidLost: "{kid} ist nicht mehr in deiner Obhut",
  kidLostTo: "{kid} ist nicht mehr in deiner Obhut (jetzt bei {to})",
  kidGained: "{kid} ist jetzt in deiner Obhut ({n} Kind bei dir)",
  kidGainedRoom: "{kid} (Zimmer {room}) ist jetzt in deiner Obhut ({n} Kind{s} bei dir)",
  kidsLost: "{names} {verb} nicht mehr in deiner Obhut",
  kidsLostTo: "{names} {verb} nicht mehr in deiner Obhut (jetzt bei {to})",
  kidsGained: "{names} {verb} jetzt in deiner Obhut",
  kidsGainedRoom: "{names} {verb} jetzt in deiner Obhut (Zimmer {room})",
  myRoomNow: "dein Zimmer ist jetzt {room}",
  myRoomNone: "du bist keinem Zimmer mehr zugeteilt",
  myRoomRoleCaretaker: "du bist jetzt LEITUNG im Zimmer (deine Kinder siehst du in der App)",
  myRoomRoleHelper: "du bist jetzt UNTERSTÜTZUNG im Zimmer (ohne zugeteilte Kinder)",
  myTeamNow: "dein Team ist jetzt {team}",
  myTeamNone: "du bist keinem Team mehr zugeteilt",
  myBusNow: "dein Transport ist jetzt {bus}",
  myBusNone: "dir ist gerade kein Transport zugeteilt",
  roomsKidsGainedLost: "{gained} {gVerb} jetzt in deiner Obhut; {lost} {lVerb} es nicht mehr",
  roomsKidsGained: "{gained} {gVerb} jetzt in deiner Obhut",
  roomsKidsLost: "{lost} {lVerb} nicht mehr in deiner Obhut",
  roomsKidsSame: "die Kinder bleiben dieselben",
  roomsKidsCountGainLose: "{kids} in deiner Obhut: +{g}, -{l}",
  roomsKidsCountGain: "{g} {kids} jetzt in deiner Obhut",
  roomsKidsCountLose: "{l} {kids} nicht mehr in deiner Obhut",
  roleAssigned: "{event}: deine Aufgabe ist {duty}",
  roleEventCancelled: "{event} wurde abgesagt",
  roleLeft: "{event}: du bist nicht mehr eingeteilt",
  roleChanged: "{event}: deine Aufgabe ist jetzt {duty}",
  roleMoved: "{title} verschoben auf {when}: deine Aufgabe ist {duty}",
  roleRenamed: 'deine Aufgabe "{before}" heißt jetzt "{after}"',
  roleNowAuto: "die Aufgabe {role} gilt jetzt für {audience}: schau in deinen Einsatzplan",
  roleNowManual: "die Aufgabe {role} gilt jetzt nur für Eingeteilte: schau in deinen Einsatzplan",
  instructionsNew: 'neue Hinweise: "{title}"',
  instructionsRenamed: 'Hinweise "{before}" heißen jetzt "{after}"',
  instructionsUpdated: 'Hinweise "{title}" aktualisiert',
  prepNew: 'neue Vorbereitung: "{title}"',
  prepRenamed: 'Vorbereitung "{before}" heißt jetzt "{after}"',
  prepUpdated: 'Vorbereitung "{title}" aktualisiert',
  otherRole: "andere Aufgabe",
  importFinished: "AcampaKids: KI-Prüfung des Imports {file} abgeschlossen. {ok}/{total} {subject} geprüft.",
  importErrors: "AcampaKids: KI-Prüfung von {file} hatte {errors}/{total} Fehler. Prüfe den Worker.",
  and: " und ",
  changeMore: "Änderung",
  changeMorePlural: "Änderungen",
  verbIsOne: "ist",
  verbIsMany: "sind",
  verbBecameOne: "ist",
  verbBecameMany: "sind",
  kidPluralSuffix: "er",
  childSingular: "Kind",
  childPlural: "Kinder",
  childNewSingular: "neues Kind",
  childNewPlural: "neue Kinder",
  camperSingular: "Kind",
  camperPlural: "Kinder",
  staffTeam: "Team",
  guardianOf: "Bezugsperson von {name}",
  seeIn: "Siehe {link}",
  ofHer: "",
  ofHim: "",
  her: "sie",
  him: "ihn",
  theF: "",
  theM: "",
  enrolledF: "{name} ist",
  enrolledM: "{name} ist",
  enrolledFp: "{names} sind",
  enrolledMp: "{names} sind",
  fieldAllergies: "Allergien",
  fieldDrugAllergies: "Medikamentenallergien",
  fieldHealthIssues: "Gesundheit",
  fieldMedications: "Medikamente",
  fieldFoodRestrictions: "Ernährung",
  fieldHealthNotes: "medizinische Hinweise",
  fieldWeightKg: "Gewicht",
  fieldInsurance: "Krankenversicherung",
  fieldInsuranceCard: "Versichertenkarte",
  fieldGeneralNotes: "Hinweise",
  fieldNeurodivergent: "neurodivergent",
  roleOrganizer: "im Orga-Team (Admin-Zugang)",
  roleGameOrganizer: "im Spiele-Team (Programm und Punktestand)",
  roleScoreHelper: "im Punkte-Team (trägt Punkte ein)",
  roleCheckinHelper: "im Check-in-Team",
  roleBusHelper: "an der Bustür (Einstieg der Kinder)",
  roleBusHelperNamed: "an der Tür von {vehicle} (Einstieg der Kinder)",
  roleMedical: "im Sanitätsteam",
  roleVestHelper: "für die Westen zuständig (Ausgabe und Rückgabe)",
  rolePhotographer: "im Foto-Team (lädt die Fotos hoch)",
  roleParentContact: "Ansprechperson für Familien ({title})",
};

const CATALOGS: Record<Locale, Catalog> = { pt, en, es, fr, de };

/** Every catalog, keyed by locale — exported for the completeness test. */
export { CATALOGS };

export function sms(locale: Locale, key: SmsKey, vars: Record<string, string | number> = {}): string {
  const catalog = CATALOGS[locale] ?? pt;
  return format(catalog[key] ?? pt[key], vars);
}

export function smsPrefix(): string {
  return config.comtele.prefix;
}

export function appLink(): string {
  return config.appUrl || "app";
}

/** Parent-edit field labels, localized. */
export function parentFieldLabel(locale: Locale, field: string): string {
  const map: Record<string, SmsKey> = {
    allergies: "fieldAllergies",
    drugAllergies: "fieldDrugAllergies",
    healthIssues: "fieldHealthIssues",
    medications: "fieldMedications",
    foodRestrictions: "fieldFoodRestrictions",
    healthNotes: "fieldHealthNotes",
    weightKg: "fieldWeightKg",
    insurance: "fieldInsurance",
    insuranceCard: "fieldInsuranceCard",
    generalNotes: "fieldGeneralNotes",
    neurodivergent: "fieldNeurodivergent",
  };
  const key = map[field];
  return key ? sms(locale, key) : field;
}
