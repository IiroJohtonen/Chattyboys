// LLM-taustapalvelu. Kaksi tapaa käyttää omia Claude-tunnuksiasi:
//  1) ANTHROPIC_API_KEY asetettu  -> suora Messages API -kutsu (API-krediitit)
//  2) muuten                      -> paikallinen `claude` CLI (Claude Code -kirjautumisesi / tilauksesi)
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Etsi claude-ohjelma. Windowsissa npm asentaa sen claude.cmd-tiedostona, jota Node ei voi
// käynnistää ilman shelliä – silloin ajetaan paketin cli.js suoraan nodella.
let resolved;
export function resolveClaude() {
  if (resolved) return resolved;
  if (process.env.CLAUDE_BIN) return (resolved = { cmd: process.env.CLAUDE_BIN, pre: [] });
  if (process.platform !== 'win32') return (resolved = { cmd: 'claude', pre: [] });

  const candidates = [];
  try {
    candidates.push(...execFileSync('where.exe', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  } catch { /* ei PATHissa */ }
  const home = os.homedir();
  candidates.push(
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  );

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (/\.exe$/i.test(c)) return (resolved = { cmd: c, pre: [] });
    if (/\.cmd$/i.test(c)) {
      const pkg = path.join(path.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code');
      const exe = path.join(pkg, 'bin', 'claude.exe');
      if (existsSync(exe)) return (resolved = { cmd: exe, pre: [] });
      const cli = path.join(pkg, 'cli.js');
      if (existsSync(cli)) return (resolved = { cmd: process.execPath, pre: [cli] });
    }
  }
  return null;
}

export function backendName() {
  return process.env.ANTHROPIC_API_KEY ? 'Anthropic API (ANTHROPIC_API_KEY)' : 'Claude Code CLI (oma kirjautumisesi)';
}

function sumTokens(u = {}) {
  return (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

export async function complete({ system, prompt, model, maxTokens = 1500, cwd }) {
  return process.env.ANTHROPIC_API_KEY
    ? viaApi({ system, prompt, model, maxTokens })
    : viaCli({ system, prompt, model, cwd });
}

async function viaApi({ system, prompt, model, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return { text, tokens: sumTokens(data.usage), costUsd: null };
}

function viaCli({ system, prompt, model, cwd }) {
  const dir = cwd || path.resolve('data', 'cli');
  mkdirSync(dir, { recursive: true });
  const bin = resolveClaude();
  if (!bin) return Promise.reject(new Error('claude-ohjelmaa ei löydy. Asenna Claude Code (npm install -g @anthropic-ai/claude-code), kirjaudu komennolla claude ja käynnistä palvelin uudelleen – tai aseta ANTHROPIC_API_KEY.'));
  // Järjestelmäkehote tiedostona: välttää pitkät, rivinvaihtoja sisältävät komentoriviargumentit (Windows).
  const promptFile = path.join(dir, `system-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(promptFile, system, 'utf8');
  const args = [
    ...bin.pre,
    '-p', '--output-format', 'json',
    '--system-prompt-file', promptFile,
    '--tools', '',              // ei työkaluja: agentit puhuvat, palvelin toteuttaa toiminnot
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, args, { cwd: dir, env: process.env, windowsHide: true });
    const cleanup = () => { try { rmSync(promptFile); } catch { /* ok */ } };
    child.on('close', cleanup);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI aikakatkaisu (180 s)')); }, 180_000);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); cleanup(); reject(new Error(`claude CLI ei käynnisty (${bin.cmd}): ${e.message}. Asenna Claude Code (npm install -g @anthropic-ai/claude-code), kirjaudu komennolla claude ja käynnistä palvelin uudelleen – tai aseta ANTHROPIC_API_KEY.`)); });
    child.on('close', code => {
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(out); } catch {
        return reject(new Error(`claude CLI (koodi ${code}): ${(err || out).slice(0, 400)}`));
      }
      if (data.is_error) return reject(new Error(`claude CLI: ${String(data.result || data.subtype).slice(0, 400)}`));
      resolve({ text: data.result || '', tokens: sumTokens(data.usage), costUsd: data.total_cost_usd ?? null });
    });
    child.stdin.end(prompt);
  });
}

// Kuvat + teksti yhdessä kutsussa (esim. videon avainkuvien kuvailu). Ei työkaluja.
export async function completeWithImages({ system, text, images, model, cwd }) {
  const content = [
    ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.base64 } })),
    { type: 'text', text },
  ];
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-sonnet-5-5', max_tokens: 1200, system, messages: [{ role: 'user', content }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
    return { text: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'), tokens: sumTokens(data.usage) };
  }

  const bin = resolveClaude();
  if (!bin) throw new Error('claude-ohjelmaa ei löydy');
  const dir = cwd || path.resolve('data', 'cli');
  mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, `system-img-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(promptFile, system, 'utf8');
  const args = [...bin.pre, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--system-prompt-file', promptFile, '--tools', '', '--no-session-persistence'];
  if (model) args.push('--model', model);
  return new Promise((resolve, reject) => {
    const child = spawn(bin.cmd, args, { cwd: dir, env: process.env, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('kuva-analyysin aikakatkaisu')); }, 180_000);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try { rmSync(promptFile); } catch { /* ok */ }
      const result = out.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(j => j?.type === 'result');
      if (!result) return reject(new Error(`claude (koodi ${code}): ${(err || out).slice(0, 300)}`));
      if (result.is_error) return reject(new Error(String(result.result || result.subtype).slice(0, 300)));
      resolve({ text: result.result || '', tokens: sumTokens(result.usage) });
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}
