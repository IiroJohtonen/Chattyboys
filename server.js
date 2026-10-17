// Chattyboys – kolme Claude-agenttia keskustelee reaaliajassa. Ei ulkoisia riippuvuuksia.
import http from 'node:http';
import { promises as fs, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { complete, backendName, resolveClaude } from './lib/llm.js';
import { AGENTS, AGENT_IDS, systemPrompt, turnPrompt, parseReply } from './lib/agents.js';
import { BUILTIN_POWERS, executePower, installScript, listWorkspace, readWorkspaceFile } from './lib/powers.js';
import { discoverSkills, readSkill } from './lib/skills.js';
import * as ig from './lib/instagram.js';
import * as media from './lib/media.js';
import * as aivideo from './lib/aivideo.js';
import { WORKSPACE } from './lib/powers.js';
import { browserStatus, login as igBrowserLogin, logout as igBrowserLogout, publishViaBrowser } from './lib/igbrowser.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1'; // vain omalta koneelta – käyttää tunnuksiasi
const DATA = path.resolve('data');
const STATE_FILE = path.join(DATA, 'state.json');
mkdirSync(DATA, { recursive: true });

const DEFAULT_CONFIG = {
  model: process.env.MODEL || 'claude-sonnet-5-5',
  dailyTokenLimit: Number(process.env.DAILY_TOKEN_LIMIT || 150_000), // ~30–40 puheenvuoroa
  maxTurnsPerDay: Number(process.env.MAX_TURNS_PER_DAY || 60),
  turnDelaySec: Number(process.env.TURN_DELAY_SEC || 20),
  contextMessages: 24,
  maxOpenInbox: 3, // pysähdytään odottamaan, jos näin monta pyyntöä on vastaamatta
  language: 'suomi',
  igDailyPublishLimit: Number(process.env.IG_DAILY_PUBLISH_LIMIT || 2),
  ttsProvider: process.env.TTS_PROVIDER || 'auto',   // auto | elevenlabs | edge | windows | mac | espeak | silent
  ttsVoice: process.env.TTS_VOICE || '',             // esim. fi-FI-NooraNeural (edge) tai fi-FI (windows)
  imageProvider: process.env.IMAGE_PROVIDER || 'auto', // auto | openai | pollinations | card
  autoAnalyzeVideos: Number(process.env.AUTO_ANALYZE_VIDEOS ?? 1), // 1 = agentit "katsovat" uudet videot automaattisesti
};

const today = () => new Date().toISOString().slice(0, 10);
const now = () => Date.now();

// ---------- tila ----------
function freshState() {
  return {
    config: { ...DEFAULT_CONFIG },
    running: false,
    status: 'idle',
    speaking: null,
    lastError: null,
    topic: 'Miten voisimme alkaa tienata rahaa verkossa – nopeasti mutta kestävästi?',
    moods: {},
    messages: [],
    ideas: [],
    notes: [],
    powers: BUILTIN_POWERS.map(p => ({ ...p, proposedBy: 'system', autoRun: false })),
    inbox: [],
    usage: { date: today(), tokens: 0, turns: 0, costUsd: 0 },
    usageHistory: [],
    enabledSkills: [],
    pendingSkills: {},
    igLog: [],
  };
}

let state = freshState();
let skills = []; // koneelta löydetyt taidot
let aiCaps = null; // käytettävissä olevat ääni- ja kuvapalvelut
const refreshAiCaps = async () => { aiCaps = await aivideo.aiCapabilities(true).catch(() => null); };
async function refreshSkills() { skills = await discoverSkills(); }
const enabledSkillList = () => skills.filter(k => state.enabledSkills?.includes(k.id));
if (existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...saved, config: { ...DEFAULT_CONFIG, ...saved.config } };
    for (const b of BUILTIN_POWERS) {
      const p = state.powers.find(x => x.name === b.name);
      if (!p) state.powers.push({ ...b, proposedBy: 'system', autoRun: false });
      else Object.assign(p, { kind: b.kind, description: b.description, input_hint: b.input_hint, confirm: b.confirm });
    }
  } catch (e) { console.error('Tilan lataus epäonnistui, aloitetaan alusta:', e.message); }
}
state.running = false; state.speaking = null; state.status = 'idle';

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)), 300);
}

function rollDay() {
  if (state.usage.date !== today()) {
    state.usageHistory = [...state.usageHistory, state.usage].slice(-30);
    state.usage = { date: today(), tokens: 0, turns: 0, costUsd: 0 };
  }
}

// ---------- SSE ----------
const clients = new Set();
function send(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}
function meta() {
  const { messages, pendingSkills, ...rest } = state;
  return { ...rest, skills, instagram: { connected: ig.igConnected(), username: ig.igConfig().username, browser: browserStatus().loggedIn }, ai: { caps: aiCaps, keys: aivideo.keyStatus() }, backend: backendName(), agents: AGENTS, estPerTurn: estPerTurn() };
}
const broadcastMeta = () => { save(); send('meta', meta()); };

function addMessage(m) {
  const msg = { id: randomUUID(), ts: now(), actions: [], ...m };
  state.messages.push(msg);
  if (state.messages.length > 1000) state.messages = state.messages.slice(-800);
  send('message', msg);
  save();
  return msg;
}
const sysMsg = (text, extra = {}) => addMessage({ from: 'system', text, ...extra });

// ---------- budjetti ----------
const turnTokens = [];
function estPerTurn() {
  if (!turnTokens.length) return 6000;
  return Math.round(turnTokens.reduce((a, b) => a + b, 0) / turnTokens.length * 1.2);
}
function budgetBlock() {
  rollDay();
  const c = state.config;
  if (state.usage.turns >= c.maxTurnsPerDay) return `Päivän vuororaja (${c.maxTurnsPerDay}) täynnä`;
  if (state.usage.tokens + estPerTurn() > c.dailyTokenLimit) return `Päivän tokenibudjetti (${c.dailyTokenLimit.toLocaleString('fi-FI')}) täynnä`;
  return null;
}

// ---------- vuorot ----------
async function videosForPrompt() {
  const videos = await media.listVideos().catch(() => []);
  const igOn = ig.igConnected() || browserStatus().loggedIn;
  if (!videos.length && !igOn) return null;
  return videos.map(v => ({ ...v, line: media.videoLine(v) }));
}

const BRAND_FILE = path.join(WORKSPACE, 'brand.md');
async function readBrand() {
  try { return (await fs.readFile(BRAND_FILE, 'utf8')).trim().slice(0, 1500); } catch { return ''; }
}

function takeLoaded(agentId) {
  const l = state.pendingSkills?.[agentId] || [];
  if (state.pendingSkills) delete state.pendingSkills[agentId];
  return l;
}

let busy = false, timer = null, consecutiveErrors = 0, lastNext = null;

function pickSpeaker() {
  const last = [...state.messages].reverse().find(m => AGENT_IDS.includes(m.from) || m.from === 'user');
  if (last?.from === 'user') {
    const t = last.text.toLowerCase();
    const named = AGENT_IDS.find(id => t.includes(AGENTS[id].name.toLowerCase()));
    if (named) return named;
  }
  const lastAgent = [...state.messages].reverse().find(m => AGENT_IDS.includes(m.from))?.from;
  if (lastNext && AGENT_IDS.includes(lastNext) && lastNext !== lastAgent) return lastNext;
  const i = AGENT_IDS.indexOf(lastAgent);
  return AGENT_IDS[(i + 1) % AGENT_IDS.length];
}

function schedule(delayMs) {
  clearTimeout(timer);
  if (!state.running) return;
  timer = setTimeout(() => runTurn().catch(e => console.error(e)), delayMs);
}

async function runTurn({ force = false } = {}) {
  if (busy) return;
  if (!state.running && !force) return;

  const block = budgetBlock();
  if (block) {
    state.running = false; state.status = 'budget';
    sysMsg(`⛔ ${block}. Agentit lepäävät huomiseen asti (voit nostaa rajaa asetuksista).`);
    return broadcastMeta();
  }
  const open = state.inbox.filter(i => i.status === 'open').length;
  if (open >= state.config.maxOpenInbox && !force) {
    state.status = 'waiting';
    broadcastMeta();
    return; // jatketaan kun omistaja vastaa
  }

  busy = true;
  const agentId = pickSpeaker();
  const agent = AGENTS[agentId];
  state.speaking = agentId; state.status = 'thinking';
  broadcastMeta();

  try {
    const { text, tokens, costUsd } = await complete({
      system: systemPrompt(agent, state.config),
      prompt: turnPrompt(state, agentId, state.config, { skills: enabledSkillList(), loaded: takeLoaded(agentId), videos: await videosForPrompt(), brand: await readBrand() }),
      model: state.config.model,
    });
    rollDay();
    state.usage.tokens += tokens;
    state.usage.turns += 1;
    if (costUsd) state.usage.costUsd = +(state.usage.costUsd + costUsd).toFixed(4);
    turnTokens.push(tokens); if (turnTokens.length > 10) turnTokens.shift();

    const reply = parseReply(text);
    if (reply.mood) state.moods[agentId] = String(reply.mood).slice(0, 4);
    if (reply.topic) state.topic = String(reply.topic).slice(0, 160);
    lastNext = reply.next;

    const msg = addMessage({ from: agentId, text: String(reply.say || '').trim() || '…', tokens });
    const actions = Array.isArray(reply.actions) ? reply.actions.slice(0, 3) : [];
    const summaries = [];
    for (const a of actions) {
      try { const s = await handleAction(agentId, a); if (s) summaries.push(s); }
      catch (e) { summaries.push({ icon: '⚠️', summary: `${a.type} epäonnistui: ${e.message}` }); }
    }
    if (summaries.length) {
      msg.actions = summaries;
      send('message-update', { id: msg.id, actions: summaries });
    }
    consecutiveErrors = 0;
    state.lastError = null;
  } catch (e) {
    consecutiveErrors++;
    state.lastError = e.message;
    console.error('Vuoro epäonnistui:', e.message);
    if (consecutiveErrors >= 3) {
      state.running = false;
      sysMsg(`⚠️ Kolme virhettä peräkkäin – pysäytetty. Viimeisin: ${e.message}`);
    }
  } finally {
    busy = false;
    state.speaking = null;
    state.status = state.running ? 'running' : (state.status === 'budget' ? 'budget' : 'idle');
    broadcastMeta();
    schedule(state.config.turnDelaySec * 1000);
  }
}

function addInbox(item) {
  const it = { id: randomUUID().slice(0, 8), status: 'open', ts: now(), ...item };
  state.inbox.unshift(it);
  if (state.inbox.length > 200) state.inbox = state.inbox.slice(0, 200);
  return it;
}

async function handleAction(agentId, a) {
  const who = AGENTS[agentId].name;
  switch (a.type) {
    case 'ask_user': {
      if (!a.question) return null;
      addInbox({ type: 'question', from: agentId, title: String(a.question).slice(0, 500) });
      return { icon: '❓', summary: `kysyi omistajalta: ${a.question}` };
    }
    case 'request_permission': {
      addInbox({ type: 'permission', from: agentId, title: String(a.what || '').slice(0, 300), detail: a.why, risk: a.risk || 'medium', cost: a.cost_eur || 0 });
      return { icon: '🔐', summary: `pyysi lupaa: ${a.what}` };
    }
    case 'add_idea': {
      const id = 'idea-' + (state.ideas.length + 1);
      state.ideas.push({ id, title: String(a.title || 'Nimetön').slice(0, 120), summary: String(a.summary || '').slice(0, 600), effort: a.effort || 'medium', potential_eur_month: Number(a.potential_eur_month) || 0, status: 'idea', by: agentId, votes: 0, ts: now() });
      return { icon: '💡', summary: `lisäsi idean ${id}: ${a.title}` };
    }
    case 'update_idea': {
      const idea = state.ideas.find(i => i.id === a.id);
      if (!idea) throw new Error(`ideaa ${a.id} ei löydy`);
      if (a.status) idea.status = a.status;
      if (a.note) idea.summary = (idea.summary + ' • ' + a.note).slice(-800);
      return { icon: '📌', summary: `${a.id} → ${idea.status}` };
    }
    case 'note': {
      if (!a.text) return null;
      state.notes.push({ text: String(a.text).slice(0, 300), by: agentId, ts: now() });
      if (state.notes.length > 30) state.notes.shift();
      return { icon: '📝', summary: `muistiinpano: ${a.text}` };
    }
    case 'request_video': {
      if (!a.title) throw new Error('title puuttuu');
      const slug = String(a.title).toLowerCase().replace(/[^a-z0-9äöå]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';
      const scenes = Array.isArray(a.scenes) ? a.scenes : [a.scenes].filter(Boolean);
      const script = `# ${a.title}\n\n**Pituus:** ~${a.length_s || '?'} s · **Muoto:** pysty 9:16\n\n**Koukku (2 ensimmäistä sekuntia):** ${a.hook || '-'}\n\n**Kohtaukset:**\n${scenes.map((x, i) => `${i + 1}. ${x}`).join('\n') || '-'}\n\n**Teksti ruudulla:** ${a.on_screen_text || '-'}\n\n**Huomioita:** ${a.notes || '-'}\n\n_Kirjoittanut: ${AGENTS[agentId].name}_\n`;
      await fs.mkdir(path.join(WORKSPACE, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(WORKSPACE, 'scripts', `${slug}.md`), script, 'utf8');
      addInbox({ type: 'footage', from: agentId, title: `Kuvaa video: ${String(a.title).slice(0, 120)}`, detail: script.replace(/[*_#]/g, '').trim() + `\n\nKun video on valmis, tallenna se kansioon workspace/videos/ ja merkitse tehdyksi.`, script: `scripts/${slug}.md` });
      return { icon: '🎥', summary: `pyysi kuvaamaan: ${a.title}` };
    }
    case 'load_skill': {
      const k = enabledSkillList().find(x => x.id === a.name || x.name === a.name);
      if (!k) throw new Error(`taitoa ${a.name} ei ole annettu`);
      state.pendingSkills ||= {};
      const list = (state.pendingSkills[agentId] ||= []);
      if (!list.find(l => l.id === k.id)) list.push({ id: k.id, text: await readSkill(k) });
      if (list.length > 2) list.shift(); // max 2 taitoa kerrallaan – säästää tokeneita
      return { icon: '🧠', summary: `luki taidon ${k.id}` };
    }
    case 'propose_power': {
      const name = String(a.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
      if (!name) throw new Error('nimi puuttuu');
      const existing = state.powers.find(p => p.name === name);
      if (existing?.status === 'enabled') return { icon: '⚡', summary: `voima ${name} on jo käytössä` };
      if (existing?.status === 'pending') return null;
      if (a.kind === 'builtin' && existing?.kind !== 'builtin') throw new Error(`sisäänrakennettua voimaa ${name} ei ole`);
      const kind = existing?.kind === 'builtin' ? 'builtin' : (a.kind === 'script' ? 'script' : 'manual');
      if (kind === 'script' && !a.code) throw new Error('script-voimalta puuttuu koodi');
      const power = existing || { name, kind, proposedBy: agentId, autoRun: false };
      Object.assign(power, {
        status: 'pending',
        description: existing?.kind === 'builtin' ? existing.description : String(a.description || '').slice(0, 400),
        why: a.why, input_hint: existing?.input_hint || a.input_hint,
        code: kind === 'script' ? String(a.code).slice(0, 20000) : undefined,
      });
      if (!existing) state.powers.push(power);
      addInbox({ type: 'power', from: agentId, title: `Uusi voima: ${name}`, detail: `${power.description}\n\nMiksi: ${a.why || '-'}`, power: name, kind, code: power.code });
      return { icon: '⚡', summary: `ehdotti voimaa ${name} (${kind})` };
    }
    case 'use_power': {
      const p = state.powers.find(x => x.name === a.name);
      if (!p) throw new Error(`voimaa ${a.name} ei ole`);
      if (p.status !== 'enabled') throw new Error(`voima ${a.name} ei ole käytössä (${p.status})`);
      if (p.kind === 'manual') {
        addInbox({ type: 'task', from: agentId, title: `${p.name}: ${typeof a.input === 'string' ? a.input : JSON.stringify(a.input)}`.slice(0, 600), power: p.name, input: a.input });
        return { icon: '🧑‍🔧', summary: `pyysi omistajaa suorittamaan ${p.name}` };
      }
      if ((p.kind === 'script' || p.confirm) && !p.autoRun) {
        addInbox({ type: 'run', from: agentId, title: `Aja ${p.name}`, detail: JSON.stringify(a.input ?? {}, null, 2), power: p.name, input: a.input });
        return { icon: '▶️', summary: `pyysi ajamaan ${p.name}` };
      }
      runPowerAsync(p, a.input, who);
      return { icon: '⚙️', summary: `käytti voimaa ${p.name}` };
    }
    default:
      return null;
  }
}

function publishedToday() {
  const today = new Date().toISOString().slice(0, 10);
  return (state.igLog || []).filter(l => new Date(l.ts).toISOString().slice(0, 10) === today).length;
}

let rendering = false;
async function runAiVideo(input, who) {
  if (rendering) throw new Error('Toinen tekoälyvideo on jo tekeillä – odota että se valmistuu');
  rendering = true;
  try {
    sysMsg(`🎬 ${who} tekee tekoälyvideota "${input?.title || ''}"… (kestää tyypillisesti 1–5 min)`, { tool: 'ai_video' });
    const r = await aivideo.makeAiVideo(input, { config: state.config });
    return `✅ Tekoälyvideo valmis: ${r.rel} (${r.seconds} s, ääni: ${r.tts}, kuvat: ${r.images}${r.music ? ', taustamusiikki' : ''}).` +
      (r.notes.length ? `\nHuomiot: ${r.notes.join('; ')}` : '') + '\nVideo on kirjastossa julkaistavissa.';
  } finally { rendering = false; }
}

let publishing = false;
async function runInstagram(p, input = {}, who) {
  if (['instagram_insights', 'instagram_comments', 'instagram_reply'].includes(p.name)) {
    if (!ig.igConnected()) throw new Error(`${p.name} vaatii virallisen Instagram-tunnuksen (selainkirjautuminen ei riitä)`);
    if (p.name === 'instagram_insights') return ig.insights(input);
    if (p.name === 'instagram_comments') return ig.comments(input);
    return ig.reply(input);
  }
  if (publishing) throw new Error('Toinen julkaisu on kesken – yritä hetken päästä');
  publishing = true;
  try { return await publishNow(input, who); } finally { publishing = false; }
}

async function publishNow(input, who) {
  if (publishedToday() >= state.config.igDailyPublishLimit) {
    throw new Error(`Päivän julkaisuraja (${state.config.igDailyPublishLimit}) täynnä – seuraava julkaisu huomenna`);
  }
  if ((state.igLog || []).some(l => l.video === input.video)) throw new Error(`${input.video} on jo julkaistu`);
  sysMsg(`📤 Julkaistaan ${input.video} Instagramiin… (käsittely voi kestää muutaman minuutin)`, { tool: 'instagram_publish' });
  if (String(input.video || '').startsWith('videos/ai/') && !/teko[äa]ly|\bAI\b/i.test(String(input.caption || ''))) {
    input = { ...input, caption: `${input.caption || ''}\n\n🤖 Video tehty tekoälyn avulla.`.trim() };
  }
  const r = ig.igConnected() ? await ig.publishReel(input) : await publishViaBrowser(input);
  state.igLog = [...(state.igLog || []), { ts: now(), video: input.video, caption: String(input.caption || '').slice(0, 300), id: r.id, permalink: r.permalink, by: who }].slice(-200);
  return `✅ Julkaistu! ${r.permalink || 'id ' + r.id}`;
}

async function runPowerAsync(p, input, who) {
  try {
    const out = p.name.startsWith('instagram_') ? await runInstagram(p, input, who)
      : p.name === 'video_edit' ? await media.editVideo(input)
      : p.name === 'ai_video' ? await runAiVideo(input, who)
      : await executePower(p, input);
    sysMsg(`⚙️ ${p.name} (${who}):\n${out}`, { tool: p.name });
  } catch (e) {
    sysMsg(`⚠️ ${p.name} epäonnistui: ${e.message}`, { tool: p.name });
  }
  broadcastMeta();
}

async function resolveInbox(id, { decision, text = '' }) {
  const it = state.inbox.find(i => i.id === id);
  if (!it || it.status !== 'open') throw new Error('Pyyntöä ei löydy tai se on jo käsitelty');
  const who = AGENTS[it.from]?.name || it.from;
  const note = text ? ` Omistajan kommentti: "${text}"` : '';
  it.status = decision === 'deny' ? 'denied' : 'done';
  it.answer = text; it.resolvedAt = now();

  switch (it.type) {
    case 'question':
      addMessage({ from: 'user', text: `Vastaus ${who}n kysymykseen "${it.title}": ${text || '(ohitettu)'}` });
      break;
    case 'permission':
      sysMsg(decision === 'deny' ? `🚫 Omistaja EI hyväksynyt: ${it.title}.${note}` : `✅ Omistaja hyväksyi: ${it.title}.${note}`);
      break;
    case 'power': {
      const p = state.powers.find(x => x.name === it.power);
      if (p) {
        if (decision === 'deny') p.status = p.kind === 'builtin' ? 'locked' : 'rejected';
        else { p.status = 'enabled'; if (p.kind === 'script') await installScript(p); }
      }
      sysMsg(decision === 'deny' ? `🚫 Voimaa ${it.power} ei hyväksytty.${note}` : `⚡ Uusi voima käytössä: ${it.power}!${note}`);
      break;
    }
    case 'footage':
      sysMsg(decision === 'deny' ? `🚫 Omistaja ei kuvaa videota "${it.title.replace(/^Kuvaa video: /, '')}".${note}` : `🎥 Omistaja kuvasi videon "${it.title.replace(/^Kuvaa video: /, '')}" – se ilmestyy kirjastoon.${note}`);
      setTimeout(() => analyzePending().catch(() => {}), 3000);
      break;
    case 'task':
      sysMsg(decision === 'deny' ? `🚫 Omistaja ei suorittanut tehtävää ${it.power}.${note}` : `🧑‍🔧 Omistaja suoritti ${it.power}. Tulos: ${text || '(ei kommenttia)'}`, { tool: it.power });
      break;
    case 'run': {
      const p = state.powers.find(x => x.name === it.power);
      if (decision === 'deny' || !p) sysMsg(`🚫 Ajoa ${it.power} ei hyväksytty.${note}`);
      else runPowerAsync(p, it.input, who);
      break;
    }
  }
  broadcastMeta();
  if (state.running && state.status === 'waiting') schedule(1500);
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('liian suuri'); }
  return s ? JSON.parse(s) : {};
}
function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ ...meta(), messages: state.messages.slice(-300) })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      const { action } = await body(req);
      if (action === 'start') {
        state.running = true; state.status = 'running';
        if (!state.messages.length) sysMsg(`🚀 Keskustelu alkaa. Aihe: ${state.topic}`);
        broadcastMeta(); schedule(500);
      } else if (action === 'pause') {
        state.running = false; clearTimeout(timer); state.status = busy ? 'thinking' : 'idle'; broadcastMeta();
      } else if (action === 'step') {
        runTurn({ force: true });
      } else if (action === 'reset') {
        clearTimeout(timer);
        const keep = { config: state.config, usage: state.usage, usageHistory: state.usageHistory, enabledSkills: state.enabledSkills };
        state = { ...freshState(), ...keep };
        send('snapshot', { ...meta(), messages: [] }); save();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/say') {
      const { text } = await body(req);
      if (text?.trim()) addMessage({ from: 'user', text: text.trim().slice(0, 2000) });
      if (state.running && !busy) schedule(1500);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/topic') {
      const { topic } = await body(req);
      if (topic?.trim()) { state.topic = topic.trim().slice(0, 160); sysMsg(`🎯 Omistaja vaihtoi aiheen: ${state.topic}`); broadcastMeta(); }
      return json(res, 200, { ok: true });
    }
    let m;
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/inbox\/([\w-]+)$/))) {
      await resolveInbox(m[1], await body(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/powers\/([\w-]+)$/))) {
      const p = state.powers.find(x => x.name === m[1]);
      if (!p) return json(res, 404, { error: 'ei löydy' });
      const b = await body(req);
      if (typeof b.autoRun === 'boolean') p.autoRun = b.autoRun;
      if (b.status === 'disabled') p.status = p.kind === 'builtin' ? 'locked' : 'rejected';
      if (b.status === 'enabled') { p.status = 'enabled'; if (p.kind === 'script') await installScript(p); }
      broadcastMeta();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/ideas\/([\w-]+)$/))) {
      const idea = state.ideas.find(i => i.id === m[1]);
      if (!idea) return json(res, 404, { error: 'ei löydy' });
      const b = await body(req);
      if (b.vote) { idea.votes = (idea.votes || 0) + b.vote; sysMsg(`${b.vote > 0 ? '👍' : '👎'} Omistaja ${b.vote > 0 ? 'tykkää' : 'ei tykkää'} ideasta ${idea.id}: ${idea.title}`); }
      if (b.status) idea.status = b.status;
      broadcastMeta();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const b = await body(req);
      for (const k of Object.keys(DEFAULT_CONFIG)) if (b[k] !== undefined && (b[k] !== '' || typeof DEFAULT_CONFIG[k] === 'string')) {
        state.config[k] = typeof DEFAULT_CONFIG[k] === 'number' ? Math.max(0, Number(b[k])) : String(b[k]);
      }
      if (state.status === 'budget' && !budgetBlock()) state.status = 'idle';
      broadcastMeta();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/instagram') {
      const b = await body(req);
      if (b.disconnect) { ig.disconnect(); broadcastMeta(); return json(res, 200, { ok: true }); }
      if (b.browserLogout) { igBrowserLogout(); broadcastMeta(); return json(res, 200, { ok: true }); }
      if (b.browserLogin) {
        try {
          await igBrowserLogin();
          sysMsg('📸 Instagram yhdistetty selainkirjautumisella. Huom: epävirallinen tapa – julkaise maltillisesti.');
          broadcastMeta();
          return json(res, 200, { ok: true });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      try {
        const r = await ig.connect({ token: b.token?.trim(), userId: b.userId?.trim(), host: b.host?.trim(), version: b.version?.trim() });
        sysMsg(`📸 Instagram yhdistetty: @${r.username}`);
        broadcastMeta();
        return json(res, 200, { ok: true, ...r });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/aikeys') {
      const b = await body(req);
      aivideo.saveAiKeys({ elevenlabsKey: b.elevenlabsKey?.trim(), elevenlabsVoice: b.elevenlabsVoice?.trim(), openaiKey: b.openaiKey?.trim() });
      await refreshAiCaps();
      broadcastMeta();
      return json(res, 200, { ok: true, caps: aiCaps });
    }
    if (url.pathname === '/api/brand') {
      if (req.method === 'POST') {
        const b = await body(req);
        await fs.mkdir(WORKSPACE, { recursive: true });
        await fs.writeFile(BRAND_FILE, String(b.text || '').slice(0, 5000), 'utf8');
        sysMsg('🎨 Omistaja päivitti brändiprofiilin.');
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { text: await fs.readFile(BRAND_FILE, 'utf8').catch(() => '') });
    }
    if (req.method === 'GET' && url.pathname === '/api/videos') {
      const tools = await media.mediaTools();
      const published = new Set((state.igLog || []).map(l => l.video));
      const list = (await media.listVideos()).map(v => ({ ...v, meta: media.videoMeta(v.file), published: published.has(v.file) }));
      return json(res, 200, { tools, videos: list });
    }
    if (req.method === 'POST' && url.pathname === '/api/videos') {
      const b = await body(req);
      if (b.note !== undefined) { media.resolveVideo(b.file); media.setOwnerNote(b.file, b.note); }
      if (b.analyze) setTimeout(() => analyzePending().catch(() => {}), 100);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/skills') {
      const b = await body(req);
      if (b.refresh) await refreshSkills();
      if (Array.isArray(b.enabled)) state.enabledSkills = b.enabled.filter(id => skills.some(k => k.id === id)).slice(0, 40);
      if (b.toggle) {
        const set = new Set(state.enabledSkills);
        set.has(b.toggle) ? set.delete(b.toggle) : skills.some(k => k.id === b.toggle) && set.add(b.toggle);
        state.enabledSkills = [...set].slice(0, 40);
      }
      broadcastMeta();
      return json(res, 200, { ok: true, count: skills.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/files') return json(res, 200, await listWorkspace());
    if (req.method === 'GET' && url.pathname === '/api/file') return json(res, 200, { content: await readWorkspaceFile(url.searchParams.get('path')) });

    // staattiset tiedostot
    const file = path.join(path.resolve('public'), url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(path.resolve('public'))) return json(res, 403, { error: 'kielletty' });
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'ei löydy' });
    json(res, 400, { error: e.message });
  }
});

// ---------- taustatyöt ----------
// 1) Agentit "katsovat" uudet videot: avainkuvat + litterointi + Clauden kuvaus (kerran per video).
let analyzing = false;
const analyzeFailed = new Map();
async function analyzePending() {
  if (analyzing || !state.config.autoAnalyzeVideos) return;
  if (!(await media.mediaTools()).ffmpeg) return;
  analyzing = true;
  try {
    for (const v of await media.listVideos()) {
      if (v.file.startsWith('videos/edits/') || v.file.startsWith('videos/ai/') || media.videoMeta(v.file)?.analysis) continue;
      if (now() - (analyzeFailed.get(v.file) || 0) < 3600_000) continue;
      if (budgetBlock()) break;
      try {
        const { tokens, meta: m } = await media.analyzeVideo(v.file, { model: state.config.model });
        state.usage.tokens += tokens;
        sysMsg(`🎬 Agentit katsoivat videon ${v.file}: ${m.analysis?.summary || ''}${m.transcriptError ? ' (litterointi epäonnistui)' : ''}`);
      } catch (e) {
        analyzeFailed.set(v.file, now());
        sysMsg(`⚠️ Videon ${v.file} analyysi epäonnistui: ${e.message}`);
      }
      broadcastMeta();
    }
  } finally { analyzing = false; }
}

// 2) Palautesilmukka: julkaisujen tulokset 24 h ja 7 pv kohdalla muistioon.
async function checkStats() {
  if (!ig.igConnected()) return;
  for (const l of state.igLog || []) {
    if (!l.id || l.id === 'selain') continue;
    const age = now() - l.ts;
    const due = !l.stats24 && age > 24 * 3600_000 ? 'stats24' : !l.stats7d && age > 7 * 24 * 3600_000 ? 'stats7d' : null;
    if (!due) continue;
    try {
      l[due] = await ig.mediaStats(l.id);
      const s = l[due], label = due === 'stats24' ? '24 h' : '7 pv';
      const line = `${l.video} ${label}: katselut ${s.views ?? '?'}, tavoittavuus ${s.reach ?? '?'}, tykkäykset ${s.likes}, kommentit ${s.comments}, jaot ${s.shares ?? '?'}, tallennukset ${s.saved ?? '?'}`;
      sysMsg(`📊 Tulokset – ${line}`);
      state.notes.push({ text: `Tulos: ${line}`.slice(0, 300), by: 'system', ts: now() });
      if (state.notes.length > 30) state.notes.shift();
    } catch (e) { console.error('Tilastojen haku epäonnistui:', e.message); }
  }
  broadcastMeta();
}

setInterval(() => analyzePending().catch(e => console.error(e)), 2 * 60_000);
setInterval(() => checkStats().catch(e => console.error(e)), 15 * 60_000);
setTimeout(() => { analyzePending().catch(() => {}); checkStats().catch(() => {}); }, 5000);

await refreshSkills();
await refreshAiCaps();
server.listen(PORT, HOST, () => {
  console.log(`\n  🦄🦉🦊  Chattyboys käynnissä: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Taustapalvelu: ${backendName()} · malli: ${state.config.model}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    const bin = resolveClaude();
    console.log(bin ? `  Claude-ohjelma: ${[bin.cmd, ...bin.pre].join(' ')}`
      : '  ⚠️  claude-ohjelmaa EI löytynyt! Asenna: npm install -g @anthropic-ai/claude-code, kirjaudu komennolla claude ja käynnistä tämä uudelleen.');
  }
  media.mediaTools().then(t => console.log(`  Videotyökalut: ffmpeg ${t.ffmpeg ? '✅ (' + media.FFMPEG + ')' : '❌ (asenna: winget install --id Gyan.FFmpeg -e – ja avaa uusi PowerShell)'} · whisper ${t.whisper ? '✅' : '– (valinnainen, puheen litterointi)'}`));
  if (aiCaps) console.log(`  Tekoälyvideot: ääni ${aiCaps.tts.join(' › ')} · kuvat ${aiCaps.images.join(' › ')}`);
  console.log(`  Taitoja löytyi: ${skills.length} (käytössä ${enabledSkillList().length})`);
  console.log(`  Päiväraja: ${state.config.dailyTokenLimit.toLocaleString('fi-FI')} tokenia / ${state.config.maxTurnsPerDay} vuoroa\n`);
});
