// Taidot = Claude Code -pluginien ja -skillien SKILL.md-ohjeet. Ne haetaan koneelta
// (~/.claude/plugins, ~/.claude/skills ja projektin ./skills) ja agentit voivat lukea niitä.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILL_ROOTS = [
  path.join(os.homedir(), '.claude', 'plugins'),
  path.join(os.homedir(), '.claude', 'skills'),
  path.resolve('skills'),
];

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// Plugin-nimi polusta: .../plugins/<...>/<plugin>/skills/<skill>/SKILL.md → <plugin>
function pluginOf(file, root) {
  const parts = path.relative(root, file).split(path.sep);
  const i = parts.lastIndexOf('skills');
  if (i > 0) {
    let j = i - 1; // ohita versio- ja hakemistotasot, esim. social-media-skills/1.0.1/skills
    while (j > 0 && /^(v?\d+(\.\d+)*|[0-9a-f]{7,}|unknown|latest)$/i.test(parts[j])) j--;
    return parts[j];
  }
  return root.endsWith(path.join('.claude', 'skills')) ? 'omat skillit' : root.endsWith('skills') ? 'projekti' : 'muut';
}

async function walk(dir, depth, out) {
  if (depth > 8) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, depth + 1, out);
    else if (e.name === 'SKILL.md') out.push(full);
  }
}

export async function discoverSkills() {
  const found = new Map();
  for (const root of SKILL_ROOTS) {
    const files = [];
    await walk(root, 0, files);
    for (const file of files) {
      let text;
      try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      const fm = frontmatter(text);
      const name = (fm.name || path.basename(path.dirname(file))).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const plugin = pluginOf(file, root);
      const id = `${plugin}:${name}`.slice(0, 120);
      if (found.has(id)) continue;
      found.set(id, { id, name, plugin, description: String(fm.description || '').slice(0, 300), path: file, size: text.length });
    }
  }
  return [...found.values()].sort((a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name));
}

export async function readSkill(skill, max = 8000) {
  const text = (await fs.readFile(skill.path, 'utf8')).replace(/^---[\s\S]*?---\r?\n/, '');
  return text.length > max ? text.slice(0, max) + `\n…(${text.length - max} merkkiä katkaistu)` : text;
}
