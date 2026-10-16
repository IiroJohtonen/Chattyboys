// LLM-taustapalvelu. Kaksi tapaa käyttää omia Claude-tunnuksiasi:
//  1) ANTHROPIC_API_KEY asetettu  -> suora Messages API -kutsu (API-krediitit)
//  2) muuten                      -> paikallinen `claude` CLI (Claude Code -kirjautumisesi / tilauksesi)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
  const args = [
    '-p', '--output-format', 'json',
    '--system-prompt', system,
    '--tools', '',              // ei työkaluja: agentit puhuvat, palvelin toteuttaa toiminnot
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: dir, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude CLI aikakatkaisu (180 s)')); }, 180_000);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(timer); reject(new Error(`claude CLI ei käynnisty: ${e.message}. Asenna Claude Code ja kirjaudu (claude login) tai aseta ANTHROPIC_API_KEY.`)); });
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
