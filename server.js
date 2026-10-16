// Chattyboys – kolme Claude-agenttia keskustelee reaaliajassa. Ei ulkoisia riippuvuuksia.
import http from 'node:http';
import { promises as fs, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { complete, backendName, resolveClaude } from './lib/llm.js';
import { AGENTS, AGENT_IDS, systemPrompt, turnPrompt, parseReply } from './lib/agents.js';
import { BUILTIN_POWERS, executePower, installScript, listWorkspace, readWorkspaceFile } from './lib/powers.js';

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
  };
}

let state = freshState();
if (existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...saved, config: { ...DEFAULT_CONFIG, ...saved.config } };
    for (const b of BUILTIN_POWERS) if (!state.powers.find(p => p.name === b.name)) state.powers.push({ ...b, proposedBy: 'system' });
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
  const { messages, ...rest } = state;
  return { ...rest, backend: backendName(), agents: AGENTS, estPerTurn: estPerTurn() };
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
      prompt: turnPrompt(state, agentId, state.config),
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
      if (p.kind === 'script' && !p.autoRun) {
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

async function runPowerAsync(p, input, who) {
  try {
    const out = await executePower(p, input);
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
        const keep = { config: state.config, usage: state.usage, usageHistory: state.usageHistory };
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
      for (const k of Object.keys(DEFAULT_CONFIG)) if (b[k] !== undefined && b[k] !== '') {
        state.config[k] = typeof DEFAULT_CONFIG[k] === 'number' ? Math.max(0, Number(b[k])) : String(b[k]);
      }
      if (state.status === 'budget' && !budgetBlock()) state.status = 'idle';
      broadcastMeta();
      return json(res, 200, { ok: true });
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

server.listen(PORT, HOST, () => {
  console.log(`\n  🦄🦉🦊  Chattyboys käynnissä: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Taustapalvelu: ${backendName()} · malli: ${state.config.model}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    const bin = resolveClaude();
    console.log(bin ? `  Claude-ohjelma: ${[bin.cmd, ...bin.pre].join(' ')}`
      : '  ⚠️  claude-ohjelmaa EI löytynyt! Asenna: npm install -g @anthropic-ai/claude-code, kirjaudu komennolla claude ja käynnistä tämä uudelleen.');
  }
  console.log(`  Päiväraja: ${state.config.dailyTokenLimit.toLocaleString('fi-FI')} tokenia / ${state.config.maxTurnsPerDay} vuoroa\n`);
});
