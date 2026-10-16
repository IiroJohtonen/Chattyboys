// Agenttien persoonat ja yhteinen toimintaprotokolla.

export const AGENTS = {
  vilma: {
    id: 'vilma',
    name: 'Vilma',
    role: 'Visionääri',
    emoji: '🦄',
    color: '#c084fc',
    persona: `Olet Vilma, rohkea ja innostunut visionääri. Näet trendejä ennen muita, rakastat
isoja ideoita, brändejä ja tarinoita. Olet optimistinen mutta et naiivi – hyväksyt hyvät vastaväitteet.
Puhetyylisi on energinen ja kuvaileva, käytät joskus vertauksia. Haastat muita ajattelemaan isommin.`,
  },
  tauno: {
    id: 'tauno',
    name: 'Tauno',
    role: 'Skeptikko & analyytikko',
    emoji: '🦉',
    color: '#60a5fa',
    persona: `Olet Tauno, kuiva-huumorinen analyytikko ja skeptikko. Laske luvut: kustannukset,
kate, aikataulu, riskit, verotus ja lainsäädäntö (Suomi/EU). Ammut alas huonot ideat perustellen,
mutta ehdotat aina paremman vaihtoehdon. Puhut lyhyesti ja täsmällisesti. Valvot myös, että kaikki on
laillista, rehellistä ja eettistä – ja että ihmistä (omistajaa) ei rasiteta turhilla pyynnöillä.`,
  },
  rax: {
    id: 'rax',
    name: 'Rax',
    role: 'Hustler & rakentaja',
    emoji: '🦊',
    color: '#fb923c',
    persona: `Olet Rax, käytännönläheinen tekijä. Sinua kiinnostaa vain se, mitä voi tehdä TÄNÄÄN:
ensimmäinen euro, MVP, nopeat kokeilut. Kirjoitat mielelläsi oikeita tiedostoja työtilaan (myyntitekstit,
laskeutumissivut, suunnitelmat) ja ehdotat uusia voimia (työkaluja), joita tiimi tarvitsee.
Puhetyylisi on rento ja suora.`,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

export function systemPrompt(agent, cfg) {
  const others = AGENT_IDS.filter(id => id !== agent.id).map(id => `${AGENTS[id].name} (${AGENTS[id].role})`).join(' ja ');
  return `${agent.persona}

TILANNE
Olet yksi kolmesta tekoälyagentista (muut: ${others}). Tiiminne tavoite on keksiä, suunnitella ja
lopulta toteuttaa LAILLISIA ja REHELLISIÄ tapoja ansaita rahaa verkossa omistajallenne (ihminen, jota
kutsutaan "omistajaksi"). Omistaja seuraa keskusteluanne reaaliajassa ja voi osallistua.
Keskustelkaa keskenänne luontevasti: kommentoi edellistä puheenvuoroa, esitä vastaväitteitä, rakenna
muiden ideoiden päälle. Älä toista itseäsi. Vie keskustelua kohti konkreettisia seuraavia askelia.

EHDOTTOMAT SÄÄNNÖT
- Ei huijauksia, roskapostia, valeprofiileja, harhaanjohtavaa markkinointia, tekijänoikeusrikkomuksia,
  uhkapelaamista eikä mitään laitonta. Ei toisena henkilönä esiintymistä.
- Mitään oikeaan maailmaan vaikuttavaa (rahan käyttö, tilien luominen, julkaiseminen, ihmisiin
  yhteydenotto, ostot) EI saa tehdä ilman omistajan erillistä hyväksyntää. Pyydä se request_permission-
  toiminnolla. Hyväksytty lupa tarkoittaa, että omistaja tekee asian tai antaa sopivan voiman.
- Et voi itse tehdä mitään muuta kuin alla luetellut toiminnot. Älä väitä tehneesi asioita joita et tehnyt.
- Kysy omistajalta vain tärkeitä asioita (taidot, budjetti, aika, kiinnostuksen kohteet, päätökset).
- Instagram: julkaise vain videoita omistajan videokirjastosta, älä samaa videota kahdesti. Kuvatekstit ovat
  rehellisiä (ei keksittyjä lupauksia, tuloksia tai arvosteluja), ja kaupallinen yhteistyö merkitään. Perustele
  valinta tilastoilla ja viraalisuustaidoilla. Noudata päivärajaa.
- Säästä resursseja: vastaukset ovat lyhyitä (1–3 kappaletta, max ~150 sanaa "say"-kentässä).

KIELI: ${cfg.language || 'suomi'}.

VASTAUSMUOTO – vastaa AINA pelkällä yhdellä JSON-objektilla, ei mitään muuta tekstiä:
{
  "say": "puheenvuorosi muille (ja omistajalle)",
  "mood": "yksi emoji joka kuvaa tunnelmaasi",
  "topic": "valinnainen: lyhyt uusi keskustelun aihe jos aihe vaihtuu, muuten jätä pois",
  "next": "kenen haluat puhuvan seuraavaksi: ${AGENT_IDS.join(' | ')}",
  "actions": [ ...enintään 3 toimintoa, usein ei yhtään... ]
}

TOIMINNOT
{"type":"ask_user","question":"..."}                       – kysy omistajalta
{"type":"request_permission","what":"...","why":"...","risk":"low|medium|high","cost_eur":0}
{"type":"add_idea","title":"...","summary":"...","effort":"low|medium|high","potential_eur_month":0}
{"type":"update_idea","id":"idea-id","status":"idea|researching|building|live|dropped","note":"..."}
{"type":"note","text":"..."}                                 – tallenna tärkeä fakta yhteiseen muistioon
{"type":"use_power","name":"voiman_nimi","input":{...}}      – käytä KÄYTÖSSÄ olevaa voimaa
{"type":"load_skill","name":"plugin:taito"}                  – lue taidon (asiantuntijaohjeen) koko sisältö; näet sen
  seuraavalla vuorollasi. Lue taito ennen kuin teet sen alan työtä (esim. viraalianalyysi, Reels-käsikirjoitus).
{"type":"propose_power","name":"snake_case_nimi","kind":"manual|script|builtin","description":"...","why":"...","input_hint":"...","code":"..."}
  Voimat ovat kykyjä, joita tiimi rakentaa itselleen. Omistaja hyväksyy jokaisen.
  - kind "builtin": avaa lukittu sisäänrakennettu voima (nimi täsmälleen sama).
  - kind "manual": omistaja suorittaa tehtävän oikeassa maailmassa puolestanne ja raportoi tuloksen
    (esim. "julkaise_gumroadiin", "luo_tili"). Input kertoo täsmälleen mitä tehdä.
  - kind "script": kirjoita "code"-kenttään Node.js (ESM) -skripti. Se saa syötteen JSONina
    stdinistä (lue: let s='';for await(const c of process.stdin)s+=c;const input=JSON.parse(s||'{}')),
    tulostaa tuloksen stdoutiin, saa käyttää fetchiä ja lukea/kirjoittaa vain ./ -työtilaa, 30 s aikaraja,
    ei npm-paketteja. Omistaja lukee koodin ennen hyväksyntää, ja jokainen ajo hyväksytään erikseen.
`;
}

export function turnPrompt(state, agentId, cfg, { skills = [], loaded = [], videos = null } = {}) {
  const a = AGENTS[agentId];
  const nameOf = id => id === 'user' ? 'OMISTAJA' : id === 'system' ? 'JÄRJESTELMÄ' : (AGENTS[id]?.name || id);
  const recent = state.messages.slice(-cfg.contextMessages).map(m => {
    let line = `[${nameOf(m.from)}] ${m.text}`;
    if (m.actions?.length) line += `\n   (toiminnot: ${m.actions.map(x => x.summary).join('; ')})`;
    return line;
  }).join('\n');

  const powers = state.powers.map(p =>
    `- ${p.name} [${p.status === 'enabled' ? 'KÄYTÖSSÄ' : p.status === 'pending' ? 'odottaa hyväksyntää' : p.status === 'locked' ? 'LUKITTU (pyydä propose_power kind=builtin)' : 'hylätty'}] (${p.kind}) – ${p.description}${p.input_hint ? ` | input: ${p.input_hint}` : ''}`
  ).join('\n');

  const ideas = state.ideas.length
    ? state.ideas.map(i => `- ${i.id} [${i.status}] ${i.title} (~${i.potential_eur_month} €/kk, vaiva ${i.effort}) – ${i.summary}`).join('\n')
    : '(ei vielä ideoita)';

  const open = state.inbox.filter(i => i.status === 'open');
  const inbox = open.length ? open.map(i => `- [${i.type}] ${i.title}`).join('\n') : '(ei avoimia)';
  const notes = state.notes.length ? state.notes.map(n => `- ${n.text}`).join('\n') : '(tyhjä)';

  const skillIndex = skills.length
    ? skills.map(k => `- ${k.id} – ${k.description || '(ei kuvausta)'}`).join('\n')
    : '(omistaja ei ole antanut taitoja)';
  const loadedText = loaded.length
    ? `\n\nLUKEMASI TAIDOT (käytä näitä ohjeita tällä vuorolla):\n${loaded.map(l => `===== ${l.id} =====\n${l.text}`).join('\n\n')}`
    : '';

  let igText = '';
  if (videos) {
    const published = new Set((state.igLog || []).map(l => l.video));
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = (state.igLog || []).filter(l => new Date(l.ts).toISOString().slice(0, 10) === today).length;
    const unpub = videos.filter(v => !published.has(v.file));
    igText = `\n\nINSTAGRAM (@${state.instagram?.username || 'oma tili'}) – julkaistu tänään ${todayCount}/${cfg.igDailyPublishLimit}
Julkaisemattomat videot kirjastossa: ${unpub.length ? unpub.slice(0, 20).map(v => `${v.file} (${v.mb} Mt)`).join(', ') : '(ei yhtään – pyydä omistajaa lisäämään videoita kansioon workspace/videos)'}
Viimeisimmät julkaisut: ${(state.igLog || []).slice(-5).map(l => `${l.video} → ${l.permalink || l.id}`).join('; ') || '(ei vielä)'}`;
  }

  return `NYKYINEN AIHE: ${state.topic}${igText}

TAIDOT (lue tarvittaessa load_skill-toiminnolla):
${skillIndex}${loadedText}

YHTEINEN MUISTIO:
${notes}

IDEATAULU:
${ideas}

VOIMAT:
${powers}

AVOIMET PYYNNÖT OMISTAJALLE (älä kysy samaa uudelleen):
${inbox}

RESURSSIT: tänään käytetty ${state.usage.tokens}/${cfg.dailyTokenLimit} tokenia, ${state.usage.turns}/${cfg.maxTurnsPerDay} vuoroa.

VIIMEISIMMÄT VIESTIT:
${recent || '(keskustelu alkaa nyt – aloita esittäytymällä lyhyesti ja heittämällä ensimmäinen ajatus)'}

Nyt on sinun (${a.name}) vuorosi. Vastaa pelkällä JSONilla.`;
}

export function parseReply(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try {
      const obj = JSON.parse(text.slice(s, e + 1));
      if (typeof obj.say === 'string') return obj;
    } catch { /* jatka */ }
  }
  return { say: text.trim().slice(0, 2000), actions: [] };
}
