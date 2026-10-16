const $ = s => document.querySelector(s);
let S = null;            // meta-tila palvelimelta
let messages = [];
let activeTab = 'inbox';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('fi-FI');
const time = ts => new Date(ts).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });

function md(text) {
  const lines = esc(text).split('\n');
  let html = '', list = false;
  for (const raw of lines) {
    let l = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const li = l.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${li[1]}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (l.trim()) html += `<p>${l}</p>`;
  }
  return html + (list ? '</ul>' : '');
}

const agentOf = id => S?.agents?.[id];
const colorOf = id => id === 'user' ? 'var(--accent2)' : id === 'system' ? 'var(--muted)' : (agentOf(id)?.color || 'var(--accent)');

async function api(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) toast('⚠️ ' + (j.error || r.status));
  return j;
}

function toast(t) {
  const el = $('#toast'); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- renderöinti ----------
function renderStage() {
  const counts = {};
  for (const m of messages) counts[m.from] = (counts[m.from] || 0) + 1;
  $('#stage').innerHTML = Object.values(S.agents).map(a => {
    const last = [...messages].reverse().find(m => m.from === a.id);
    return `<div class="agent ${S.speaking === a.id ? 'speaking' : ''}" style="--c:${a.color}">
      <div class="avatar">${a.emoji}<span class="mood">${esc(S.moods?.[a.id] || '🙂')}</span></div>
      <div class="agent-info">
        <div class="agent-name">${esc(a.name)}</div>
        <div class="agent-role">${esc(a.role)}</div>
        <div class="agent-last">${S.speaking === a.id ? 'miettii…' : esc(last?.text?.slice(0, 90) || 'odottaa vuoroaan')}</div>
      </div>
      <div class="agent-stats"><b>${counts[a.id] || 0}</b>viestiä</div>
    </div>`;
  }).join('');
}

function renderHeader() {
  const c = S.config, u = S.usage;
  $('#backend').textContent = `${S.backend} · ${c.model || 'oletusmalli'}`;
  const tp = Math.min(100, u.tokens / c.dailyTokenLimit * 100);
  const rp = Math.min(100, u.turns / c.maxTurnsPerDay * 100);
  $('#tok-label').textContent = `${fmt(u.tokens)} / ${fmt(c.dailyTokenLimit)}`;
  $('#turn-label').textContent = `${u.turns} / ${c.maxTurnsPerDay}`;
  for (const [el, p] of [[$('#tok-bar'), tp], [$('#turn-bar'), rp]]) {
    el.style.width = p + '%'; el.className = p > 85 ? 'high' : p > 60 ? 'mid' : '';
  }
  const labels = { idle: 'Tauolla', running: 'Käynnissä', thinking: 'Miettii…', waiting: 'Odottaa sinua', budget: 'Päiväraja täynnä' };
  const st = S.running && S.status === 'idle' ? 'running' : S.status;
  $('#status').className = 'pill ' + st;
  $('#status').textContent = labels[st] || st;
  $('#status').title = S.lastError ? 'Viimeisin virhe: ' + S.lastError : '';
  $('#btn-start').hidden = S.running;
  $('#btn-pause').hidden = !S.running;
  $('#topic').textContent = S.topic;

  const t = $('#typing');
  if (S.speaking) {
    const a = agentOf(S.speaking);
    t.hidden = false; t.style.setProperty('--c', a.color);
    t.innerHTML = `<span class="dots"><i></i><i></i><i></i></span> ${a.emoji} ${esc(a.name)} kirjoittaa…`;
  } else t.hidden = true;
}

function msgHtml(m) {
  const a = agentOf(m.from);
  const cls = m.from === 'user' ? 'user' : m.from === 'system' ? 'system' + (m.tool ? ' tool' : '') : 'bot';
  if (m.from === 'system') return `<div class="msg ${cls}" data-id="${m.id}"><div class="bubble">${esc(m.text)}</div></div>`;
  const name = m.from === 'user' ? 'Sinä' : a?.name || m.from;
  const av = m.from === 'user' ? '🧑' : a?.emoji || '🤖';
  const chips = m.actions?.length ? `<div class="chips">${m.actions.map(x => `<span class="chip">${x.icon} ${esc(x.summary)}</span>`).join('')}</div>` : '';
  return `<div class="msg ${cls}" data-id="${m.id}" style="--c:${colorOf(m.from)}">
    <div class="av">${av}</div>
    <div class="bubble"><div class="who">${esc(name)} <time>${time(m.ts)}</time></div>${md(m.text)}${chips}</div>
  </div>`;
}

function renderFeed() {
  const feed = $('#feed');
  if (!messages.length) {
    feed.innerHTML = `<div class="empty"><div class="big">🦄 🦉 🦊</div>
      <p><b>Vilma</b>, <b>Tauno</b> ja <b>Rax</b> odottavat.<br>Paina <b>Käynnistä</b>, niin he alkavat ideoida miten tehdä rahaa verkossa.
      He kysyvät sinulta asioita ja pyytävät lupaa ennen kuin tekevät mitään oikeassa maailmassa.</p></div>`;
    return;
  }
  feed.innerHTML = messages.map(msgHtml).join('');
  feed.scrollTop = feed.scrollHeight;
}

function appendMessage(m) {
  const feed = $('#feed');
  if (feed.querySelector('.empty')) feed.innerHTML = '';
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
  feed.insertAdjacentHTML('beforeend', msgHtml(m));
  if (nearBottom || m.from === 'user') feed.scrollTop = feed.scrollHeight;
}

function who(id) {
  const a = agentOf(id);
  return a ? `${a.emoji} ${esc(a.name)}` : esc(id);
}

function renderInbox() {
  const open = S.inbox.filter(i => i.status === 'open');
  const closed = S.inbox.filter(i => i.status !== 'open').slice(0, 15);
  const cnt = $('#inbox-count'); cnt.hidden = !open.length; cnt.textContent = open.length;
  document.title = open.length ? `(${open.length}) Chattyboys` : 'Chattyboys';

  const typeLabel = { question: '❓ Kysymys', permission: '🔐 Lupapyyntö', power: '⚡ Uusi voima', task: '🧑‍🔧 Tehtävä sinulle', run: '▶️ Ajopyyntö' };
  const card = i => {
    const c = colorOf(i.from);
    const isOpen = i.status === 'open';
    let body = `<div class="item-title">${esc(i.title)}</div>`;
    if (i.detail) body += `<div class="item-detail">${esc(i.detail)}</div>`;
    if (i.code) body += `<pre>${esc(i.code)}</pre>`;
    let actions = '';
    if (isOpen) {
      const ph = i.type === 'question' ? 'Vastauksesi…' : i.type === 'task' ? 'Mitä teit / tulos (esim. linkki)…' : 'Kommentti (valinnainen)…';
      const yes = { question: 'Vastaa', permission: 'Hyväksy', power: 'Myönnä voima', task: 'Tehty', run: 'Aja' }[i.type];
      actions = `<textarea placeholder="${ph}" data-text="${i.id}"></textarea>
        <div class="item-actions">
          <button class="btn sm ok" data-act="approve" data-id="${i.id}">${yes}</button>
          <button class="btn sm danger" data-act="deny" data-id="${i.id}">${i.type === 'question' ? 'Ohita' : 'Hylkää'}</button>
        </div>`;
    } else {
      actions = `<div class="item-detail">${i.status === 'denied' ? '🚫 Hylätty' : '✅ Käsitelty'}${i.answer ? ': ' + esc(i.answer) : ''}</div>`;
    }
    const extra = (i.risk ? `<span class="risk ${esc(i.risk)}">riski: ${esc(i.risk)}</span>` : '') + (i.cost ? ` <span class="risk medium">${fmt(i.cost)} €</span>` : '');
    return `<div class="item ${isOpen ? '' : 'closed'}" style="--c:${c}">
      <div class="item-head"><span class="tag">${typeLabel[i.type] || i.type}</span> · ${who(i.from)} ${extra}<span class="right">${time(i.ts)}</span></div>
      ${body}${actions}</div>`;
  };
  $('#panel-inbox').innerHTML = (open.length ? open.map(card).join('') : `<div class="panel-empty">Ei avoimia pyyntöjä 🎉<br>Agentit kysyvät täällä kysymyksiä, pyytävät lupia ja ehdottavat uusia voimia.</div>`)
    + (closed.length ? `<div class="section-title">Aiemmat</div>` + closed.map(card).join('') : '');
}

function renderIdeas() {
  const order = { live: 0, building: 1, researching: 2, idea: 3, dropped: 4 };
  const ideas = [...S.ideas].sort((a, b) => (order[a.status] - order[b.status]) || (b.votes - a.votes) || (b.potential_eur_month - a.potential_eur_month));
  const statusFi = { idea: 'idea', researching: 'tutkitaan', building: 'rakennetaan', live: 'LIVE', dropped: 'hylätty' };
  const effortFi = { low: 'pieni', medium: 'keskikok.', high: 'iso' };
  const total = S.ideas.filter(i => i.status !== 'dropped').reduce((s, i) => s + (i.potential_eur_month || 0), 0);
  $('#panel-ideas').innerHTML = (ideas.length ? `<div class="section-title">Arvioitu potentiaali yhteensä: <span style="color:var(--ok)">${fmt(total)} €/kk</span></div>` + ideas.map(i => `
    <div class="item" style="--c:${colorOf(i.by)}">
      <div class="item-head"><span class="tag">${esc(i.id)}</span> · ${who(i.by)} <span class="right status-tag ${esc(i.status)}">${statusFi[i.status] || esc(i.status)}</span></div>
      <div class="item-title">${esc(i.title)}</div>
      <div class="item-detail">${esc(i.summary)}</div>
      <div class="idea-meta"><span class="money">~${fmt(i.potential_eur_month)} €/kk</span><span>vaiva: ${effortFi[i.effort] || esc(i.effort)}</span>
        <span style="margin-left:auto">${i.votes ? (i.votes > 0 ? '👍' : '👎') + ' ' + i.votes : ''}</span>
        <button class="btn sm ghost" data-vote="1" data-idea="${i.id}" title="Tykkään">👍</button>
        <button class="btn sm ghost" data-vote="-1" data-idea="${i.id}" title="En tykkää">👎</button></div>
    </div>`).join('') : `<div class="panel-empty">Ei vielä ideoita. Agentit lisäävät ne tänne keskustelun edetessä.</div>`)
    + (S.notes.length ? `<div class="section-title">📝 Yhteinen muistio</div><ul class="notes">${S.notes.map(n => `<li>${esc(n.text)} <small>— ${esc(agentOf(n.by)?.name || n.by)}</small></li>`).join('')}</ul>` : '');
}

function renderPowers() {
  const kindFi = { builtin: 'sisäänrakennettu', script: 'skripti', manual: 'sinä suoritat' };
  const statusFi = { enabled: 'käytössä', pending: 'odottaa', locked: 'lukittu', rejected: 'hylätty' };
  $('#panel-powers').innerHTML = `<p class="hint">Voimat ovat kykyjä, joita agentit rakentavat itselleen. Jokainen vaatii hyväksyntäsi. Skriptit ajetaan rajatussa Node-prosessissa (vain työtilan tiedostot, 30 s aikaraja).</p>` +
    S.powers.map(p => `
    <div class="item" style="--c:${p.status === 'enabled' ? 'var(--ok)' : p.status === 'pending' ? 'var(--warn)' : 'var(--border)'}">
      <div class="item-head"><span class="tag">⚡ ${esc(p.name)}</span> · ${kindFi[p.kind] || p.kind} · ${p.proposedBy === 'system' ? 'valmis' : who(p.proposedBy)}
        <span class="right status-tag ${esc(p.status)}">${statusFi[p.status] || esc(p.status)}</span></div>
      <div class="item-detail">${esc(p.description)}</div>
      ${p.code ? `<div class="item-actions"><button class="btn sm ghost" data-code="${esc(p.name)}">Näytä koodi</button></div>` : ''}
      <div class="item-actions">
        ${p.kind === 'script' && p.status === 'enabled' ? `<label class="toggle"><input type="checkbox" data-auto="${esc(p.name)}" ${p.autoRun ? 'checked' : ''}> aja kysymättä</label>` : ''}
        ${p.status === 'enabled' && !p.name.startsWith('workspace_') ? `<button class="btn sm danger" data-pstatus="disabled" data-power="${esc(p.name)}">Poista käytöstä</button>` : ''}
        ${p.status === 'locked' ? `<button class="btn sm" data-pstatus="enabled" data-power="${esc(p.name)}">Avaa</button>` : ''}
      </div>
    </div>`).join('');
}

let skillFilter = '';
function renderSkills() {
  const panel = $('#panel-skills');
  if (panel.contains(document.activeElement) && document.activeElement.id === 'skill-filter') return;
  const on = new Set(S.enabledSkills || []);
  const q = skillFilter.toLowerCase();
  const list = (S.skills || []).filter(k => !q || (k.id + ' ' + k.description).toLowerCase().includes(q));
  const groups = {};
  for (const k of list) (groups[k.plugin] ||= []).push(k);
  panel.innerHTML = `<p class="hint">Taidot ovat Claude Code -pluginien asiantuntijaohjeita (SKILL.md). Rastita ne, jotka agentit saavat käyttöönsä – he näkevät listan ja lukevat koko ohjeen tarvittaessa.
      Asenna uusia plugineja Claude Codessa komennolla <code>/plugin</code> ja paina Päivitä.</p>
    <div class="item-actions" style="margin:0">
      <input id="skill-filter" class="search" placeholder="Hae taitoja… (esim. viral, reels, instagram)" value="${esc(skillFilter)}">
      <button class="btn sm" data-skills-refresh="1">↻ Päivitä</button>
    </div>
    <div class="section-title">Käytössä ${on.size} / löydetty ${(S.skills || []).length}</div>` +
    (list.length ? Object.entries(groups).map(([plugin, ks]) => `
      <div class="section-title">🧩 ${esc(plugin)}</div>` + ks.map(k => `
      <label class="item skill ${on.has(k.id) ? 'on' : ''}" style="--c:${on.has(k.id) ? 'var(--ok)' : 'var(--border)'}">
        <input type="checkbox" data-skill="${esc(k.id)}" ${on.has(k.id) ? 'checked' : ''}>
        <span><span class="item-title">${esc(k.name)}</span><span class="item-detail">${esc(k.description || '')}</span></span>
      </label>`).join('')).join('')
      : `<div class="panel-empty">Taitoja ei löytynyt. Asenna plugineja Claude Codessa (<code>/plugin</code>) tai lisää SKILL.md-tiedostoja projektin <code>skills/</code>-kansioon.</div>`);
}

async function renderFiles() {
  if (activeTab !== 'files') return;
  const files = await fetch('/api/files').then(r => r.json()).catch(() => []);
  $('#panel-files').innerHTML = `<p class="hint">Agenttien työtila (<code>workspace/</code>). Täältä löydät heidän kirjoittamansa luonnokset, suunnitelmat ja sivut.</p>` +
    (files.length ? files.map(f => `<div class="file" data-file="${esc(f.path)}"><span>📄 ${esc(f.path)}</span><span>${fmt(f.size)} t</span></div>`).join('')
      : `<div class="panel-empty">Työtila on tyhjä.</div>`);
}

function renderSettings() {
  const f = $('#settings');
  for (const [k, v] of Object.entries(S.config)) if (f.elements[k] && document.activeElement !== f.elements[k]) f.elements[k].value = v;
  const turns = Math.floor(S.config.dailyTokenLimit / (S.estPerTurn || 6000));
  $('#cost-hint').textContent = `Nykyisellä kulutuksella (~${fmt(S.estPerTurn)} tokenia/vuoro) päiväraja riittää noin ${turns} puheenvuoroon. Agentit pysähtyvät automaattisesti ennen rajaa.`;
}

function renderAll() {
  renderHeader(); renderStage(); renderInbox(); renderIdeas(); renderPowers(); renderSkills(); renderSettings();
}

// ---------- tapahtumat ----------
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('snapshot', e => {
    const d = JSON.parse(e.data); messages = d.messages || []; delete d.messages; S = d;
    renderAll(); renderFeed();
  });
  es.addEventListener('meta', e => {
    const prevOpen = S?.inbox?.filter(i => i.status === 'open').length || 0;
    S = JSON.parse(e.data); renderAll();
    const open = S.inbox.filter(i => i.status === 'open').length;
    if (open > prevOpen) toast('📥 Agentit tarvitsevat sinua – katso Pyynnöt');
  });
  es.addEventListener('message', e => {
    const m = JSON.parse(e.data); messages.push(m); appendMessage(m); renderStage();
    if (activeTab === 'files' && m.tool) renderFiles();
  });
  es.addEventListener('message-update', e => {
    const { id, actions } = JSON.parse(e.data);
    const m = messages.find(x => x.id === id); if (!m) return;
    m.actions = actions;
    const el = document.querySelector(`.msg[data-id="${id}"]`);
    if (el) el.outerHTML = msgHtml(m);
    if (actions.some(a => a.summary.includes('workspace_write'))) renderFiles();
  });
  es.onerror = () => { $('#backend').textContent = 'yhteys katkesi – yhdistetään uudelleen…'; };
}

$('#btn-start').onclick = () => api('/api/control', { action: 'start' });
$('#btn-pause').onclick = () => api('/api/control', { action: 'pause' });
$('#btn-step').onclick = () => api('/api/control', { action: 'step' });
$('#btn-reset').onclick = () => confirm('Nollataanko keskustelu, ideat ja voimat?') && api('/api/control', { action: 'reset' });
$('#btn-topic').onclick = () => { const t = prompt('Uusi keskustelun aihe:', S.topic); if (t) api('/api/topic', { topic: t }); };

$('#composer').onsubmit = e => {
  e.preventDefault();
  const v = $('#say').value.trim(); if (!v) return;
  $('#say').value = ''; api('/api/say', { text: v });
};

$('#settings').onsubmit = e => {
  e.preventDefault();
  api('/api/config', Object.fromEntries(new FormData(e.target))).then(() => toast('✅ Asetukset tallennettu'));
};

$('#tabs').onclick = e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  activeTab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => (p.hidden = p.id !== 'panel-' + activeTab));
  renderFiles();
};

function modal(title, content) {
  $('#modal-body').innerHTML = `<div style="display:flex;align-items:center"><b>${esc(title)}</b><button class="btn sm ghost" style="margin-left:auto" onclick="this.closest('dialog').close()">✕</button></div><pre>${esc(content)}</pre>`;
  $('#modal').showModal();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act],[data-vote],[data-code],[data-file],[data-pstatus],[data-skills-refresh]');
  if (!t) return;
  if (t.dataset.skillsRefresh) { const r = await api('/api/skills', { refresh: true }); toast(`🧠 Löytyi ${r.count ?? 0} taitoa`); return; }
  if (t.dataset.act) {
    const text = document.querySelector(`textarea[data-text="${t.dataset.id}"]`)?.value || '';
    t.disabled = true;
    await api('/api/inbox/' + t.dataset.id, { decision: t.dataset.act, text });
  } else if (t.dataset.vote) {
    api('/api/ideas/' + t.dataset.idea, { vote: Number(t.dataset.vote) });
  } else if (t.dataset.code) {
    const p = S.powers.find(x => x.name === t.dataset.code); modal(p.name, p.code);
  } else if (t.dataset.file) {
    const r = await fetch('/api/file?path=' + encodeURIComponent(t.dataset.file)).then(r => r.json());
    modal(t.dataset.file, r.content ?? r.error);
  } else if (t.dataset.pstatus) {
    api('/api/powers/' + t.dataset.power, { status: t.dataset.pstatus });
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'skill-filter') {
    skillFilter = e.target.value;
    const pos = e.target.selectionStart;
    e.target.blur(); renderSkills();
    const f = $('#skill-filter'); f.focus(); f.setSelectionRange(pos, pos);
  }
});
document.addEventListener('change', e => {
  if (e.target.dataset.skill) api('/api/skills', { toggle: e.target.dataset.skill });
  if (e.target.dataset.auto) api('/api/powers/' + e.target.dataset.auto, { autoRun: e.target.checked });
});

connect();
