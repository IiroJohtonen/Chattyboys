// Instagram (virallinen Instagram Graph API). Tunnukset tallennetaan vain omalle koneelle
// tiedostoon data/secrets.json eikä niitä koskaan lähetetä selaimeen tai agenteille.
import { readFileSync, writeFileSync, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './powers.js';

const SECRETS = path.resolve('data', 'secrets.json');
export const VIDEO_DIR = path.join(WORKSPACE, 'videos');
const VIDEO_EXT = /\.(mp4|mov)$/i;

function loadSecrets() {
  try { return existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {}; } catch { return {}; }
}
let secrets = loadSecrets();

export function igConfig() {
  const ig = secrets.instagram || {};
  return {
    token: process.env.IG_ACCESS_TOKEN || ig.token || '',
    userId: process.env.IG_USER_ID || ig.userId || '',
    host: process.env.IG_HOST || ig.host || 'graph.instagram.com',
    version: process.env.IG_API_VERSION || ig.version || 'v23.0',
    username: ig.username || '',
  };
}
export const igConnected = () => Boolean(igConfig().token);

async function call(method, endpoint, params = {}) {
  const c = igConfig();
  if (!c.token) throw new Error('Instagram ei ole yhdistetty (Asetukset → Instagram)');
  const url = new URL(`https://${c.host}/${c.version}/${endpoint.replace(/^\//, '')}`);
  const body = new URLSearchParams({ ...params, access_token: c.token });
  let res;
  if (method === 'GET') {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } else {
    res = await fetch(url, { method, body, signal: AbortSignal.timeout(60000) });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Instagram ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// Tallenna tunnukset ja tarkista ne hakemalla tilin tiedot.
export async function connect({ token, userId, host, version }) {
  const prev = secrets.instagram;
  secrets.instagram = { ...prev, token: token || prev?.token, userId: userId || prev?.userId, host: host || prev?.host, version: version || prev?.version };
  let me;
  try { me = await call('GET', 'me', { fields: 'user_id,username,id' }); }
  catch (e) { if (prev) secrets.instagram = prev; else delete secrets.instagram; throw e; }
  secrets.instagram.userId = secrets.instagram.userId || me.user_id || me.id;
  secrets.instagram.username = me.username || '';
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 1), { mode: 0o600 });
  return { username: secrets.instagram.username, userId: secrets.instagram.userId };
}

export function disconnect() {
  delete secrets.instagram;
  writeFileSync(SECRETS, JSON.stringify(secrets, null, 1), { mode: 0o600 });
}

export async function listVideos() {
  await fs.mkdir(VIDEO_DIR, { recursive: true });
  const out = [];
  for (const name of await fs.readdir(VIDEO_DIR)) {
    if (!VIDEO_EXT.test(name)) continue;
    const st = await fs.stat(path.join(VIDEO_DIR, name));
    out.push({ file: `videos/${name}`, mb: +(st.size / 1048576).toFixed(1) });
  }
  return out;
}

// Omien julkaisujen tilastot: tykkäykset, kommentit sekä (Reelseille) katselut, tavoittavuus, jaot ja tallennukset.
export async function insights({ limit = 12 } = {}) {
  const { userId } = igConfig();
  const media = await call('GET', `${userId}/media`, {
    fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count',
    limit: String(Math.min(Number(limit) || 12, 25)),
  });
  const rows = [];
  for (const m of media.data || []) {
    const row = {
      when: m.timestamp?.slice(0, 10), type: m.media_product_type || m.media_type,
      likes: m.like_count ?? 0, comments: m.comments_count ?? 0,
      caption: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 80), url: m.permalink,
    };
    try {
      const ins = await call('GET', `${m.id}/insights`, { metric: 'views,reach,shares,saved,total_interactions' });
      for (const x of ins.data || []) row[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? null;
    } catch { /* kaikilla mediatyypeillä ei ole kaikkia mittareita */ }
    rows.push(row);
  }
  rows.sort((a, b) => (b.views ?? b.reach ?? 0) - (a.views ?? a.reach ?? 0));
  return rows.length
    ? rows.map((r, i) => `${i + 1}. ${r.when} ${r.type} – katselut ${r.views ?? '?'}, tavoittavuus ${r.reach ?? '?'}, tykkäykset ${r.likes}, kommentit ${r.comments}, jaot ${r.shares ?? '?'}, tallennukset ${r.saved ?? '?'}\n   "${r.caption}" ${r.url}`).join('\n')
    : 'Tilillä ei ole vielä julkaisuja.';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Julkaise Reel. Video joko julkisesta URL:sta tai työtilan videos/-kansiosta (suora lataus).
export async function publishReel({ video, caption = '', share_to_feed = true }) {
  const c = igConfig();
  const params = { media_type: 'REELS', caption: String(caption).slice(0, 2200), share_to_feed: String(share_to_feed !== false) };
  let localFile = null;
  if (/^https:\/\//i.test(video || '')) params.video_url = video;
  else {
    const rel = String(video || '').replace(/^\/+/, '');
    const full = path.resolve(WORKSPACE, rel);
    if (!full.startsWith(VIDEO_DIR + path.sep) || !VIDEO_EXT.test(full) || !existsSync(full)) {
      throw new Error(`Videota ${video} ei löydy kansiosta videos/ (sallitut: .mp4, .mov)`);
    }
    localFile = full;
    params.upload_type = 'resumable';
  }

  const container = await call('POST', `${c.userId}/media`, params);
  if (localFile) {
    const bytes = await fs.readFile(localFile);
    const up = await fetch(`https://rupload.facebook.com/ig-api-upload/${c.version}/${container.id}`, {
      method: 'POST',
      headers: { Authorization: `OAuth ${c.token}`, offset: '0', file_size: String(bytes.length) },
      body: bytes,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || upData.success === false) {
      throw new Error(`Videon lataus epäonnistui (${up.status}): ${upData.debug_info?.message || JSON.stringify(upData).slice(0, 200)}. Kokeile antaa videosta julkinen https-linkki.`);
    }
  }

  // Odota käsittelyä (max ~5 min).
  let status = 'IN_PROGRESS';
  for (let i = 0; i < 60 && status === 'IN_PROGRESS'; i++) {
    await sleep(5000);
    const s = await call('GET', container.id, { fields: 'status_code,status' });
    status = s.status_code;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram ei hyväksynyt videota: ${s.status || status}`);
  }
  if (status !== 'FINISHED') throw new Error(`Video on yhä käsittelyssä (${status}) – yritä julkaisua myöhemmin`);

  const pub = await call('POST', `${c.userId}/media_publish`, { creation_id: container.id });
  let permalink = '';
  try { permalink = (await call('GET', pub.id, { fields: 'permalink' })).permalink; } catch { /* ok */ }
  return { id: pub.id, permalink };
}
