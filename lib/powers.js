// Voimat = kyvyt, joita agentit voivat käyttää. Kaikki uudet voimat vaativat omistajan hyväksynnän.
import { spawn } from 'node:child_process';
import { promises as fs, mkdirSync } from 'node:fs';
import path from 'node:path';

export const WORKSPACE = path.resolve('workspace');
mkdirSync(path.join(WORKSPACE, 'powers'), { recursive: true });

export const BUILTIN_POWERS = [
  { name: 'workspace_write', kind: 'builtin', status: 'enabled', description: 'Kirjoita tiedosto työtilaan (luonnokset, suunnitelmat, sivut).', input_hint: '{"path":"suunnitelma.md","content":"..."}' },
  { name: 'workspace_read', kind: 'builtin', status: 'enabled', description: 'Lue tiedosto työtilasta.', input_hint: '{"path":"suunnitelma.md"}' },
  { name: 'workspace_list', kind: 'builtin', status: 'enabled', description: 'Listaa työtilan tiedostot.', input_hint: '{}' },
  { name: 'web_fetch', kind: 'builtin', status: 'locked', description: 'Hae verkkosivun tekstisisältö (vain luku).', input_hint: '{"url":"https://..."}' },
  { name: 'web_search', kind: 'builtin', status: 'locked', description: 'Hae verkosta (DuckDuckGo), palauttaa otsikot ja linkit.', input_hint: '{"query":"..."}' },
  { name: 'instagram_insights', kind: 'builtin', status: 'locked', description: 'Lue omistajan Instagram-julkaisujen tilastot (katselut, tavoittavuus, tykkäykset, jaot, tallennukset), parhaat ensin.', input_hint: '{"limit":12}' },
  { name: 'instagram_publish', kind: 'builtin', status: 'locked', confirm: true, description: 'Julkaise Reel omistajan Instagramiin videokirjastosta (videos/-kansio) tai julkisesta https-linkistä. Päiväraja asetuksissa.', input_hint: '{"video":"videos/nimi.mp4","caption":"teksti #hashtag"}' },
];

function safePath(p) {
  const full = path.resolve(WORKSPACE, String(p || '').replace(/^\/+/, ''));
  if (!full.startsWith(WORKSPACE + path.sep) && full !== WORKSPACE) throw new Error('Polku työtilan ulkopuolella');
  return full;
}

const clip = (s, n = 4000) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} merkkiä katkaistu)` : s);

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

export async function listWorkspace(dir = WORKSPACE, base = '') {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = path.join(base, e.name);
    if (e.isDirectory()) out.push(...await listWorkspace(path.join(dir, e.name), rel));
    else out.push({ path: rel, size: (await fs.stat(path.join(dir, e.name))).size });
  }
  return out;
}

export async function readWorkspaceFile(p) {
  return fs.readFile(safePath(p), 'utf8');
}

async function runBuiltin(name, input = {}) {
  switch (name) {
    case 'workspace_write': {
      const full = safePath(input.path);
      if (full.startsWith(path.join(WORKSPACE, 'powers')) || full.startsWith(path.join(WORKSPACE, 'videos'))) throw new Error('powers/- ja videos/-kansiot ovat suojattuja');
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, String(input.content ?? ''), 'utf8');
      return `Kirjoitettu ${input.path} (${String(input.content ?? '').length} merkkiä)`;
    }
    case 'workspace_read':
      return clip(await fs.readFile(safePath(input.path), 'utf8'));
    case 'workspace_list': {
      const files = await listWorkspace();
      return files.length ? files.map(f => `${f.path} (${f.size} t)`).join('\n') : '(tyhjä)';
    }
    case 'web_fetch': {
      const url = new URL(input.url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('Vain http(s)');
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Chattyboys' }, signal: AbortSignal.timeout(20000) });
      return clip(`HTTP ${r.status}\n` + htmlToText(await r.text()), 5000);
    }
    case 'web_search': {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(input.query || ''), {
        headers: { 'user-agent': 'Mozilla/5.0 Chattyboys' }, signal: AbortSignal.timeout(20000),
      });
      const html = await r.text();
      const results = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        .slice(0, 8).map(m => {
          let href = m[1];
          const u = href.match(/uddg=([^&]+)/); if (u) href = decodeURIComponent(u[1]);
          return `- ${htmlToText(m[2])}\n  ${href}\n  ${htmlToText(m[3])}`;
        });
      return results.length ? results.join('\n') : 'Ei tuloksia (tai haku estetty).';
    }
    default: throw new Error(`Tuntematon sisäänrakennettu voima ${name}`);
  }
}

export function scriptFile(name) {
  return path.join(WORKSPACE, 'powers', `${name.replace(/[^a-z0-9_]/gi, '_')}.mjs`);
}

export async function installScript(power) {
  await fs.writeFile(scriptFile(power.name), power.code || '', 'utf8');
}

function runScript(power, input) {
  return new Promise((resolve, reject) => {
    // Node:n permission model: tiedostot vain työtilassa, ei aliprosesseja. Verkko (fetch) sallittu.
    const child = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${WORKSPACE}`, `--allow-fs-write=${WORKSPACE}`,
      scriptFile(power.name),
    ], { cwd: WORKSPACE, env: { PATH: process.env.PATH, HTTPS_PROXY: process.env.HTTPS_PROXY || '' } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Aikaraja 30 s ylittyi')); }, 30_000);
    child.stdout.on('data', d => { out += d; if (out.length > 200_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => (err += d));
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(clip(out || '(ei tulostetta)'));
      else reject(new Error(`exit ${code}: ${clip(err || out, 1500)}`));
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

export async function executePower(power, input) {
  if (power.kind === 'builtin') return runBuiltin(power.name, input);
  if (power.kind === 'script') return runScript(power, input);
  throw new Error('manual-voimat suorittaa omistaja');
}
