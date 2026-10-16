// Videoiden ymmärtäminen ja muokkaus: ffprobe (tiedot), ffmpeg (avainkuvat, muokkaukset),
// valinnainen Whisper (puheen litterointi) ja Claude (avainkuvien kuvailu).
// Kaikki komennot ajetaan argumenttilistoina ilman shelliä – agentit valitsevat vain valmiista toiminnoista.
import { execFile } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WORKSPACE } from './powers.js';
import { completeWithImages } from './llm.js';

export const VIDEO_DIR = path.join(WORKSPACE, 'videos');
export const EDIT_DIR = path.join(VIDEO_DIR, 'edits');
const MEDIA_DIR = path.resolve('data', 'media');
const INDEX = path.join(MEDIA_DIR, 'index.json');
const VIDEO_EXT = /\.(mp4|mov)$/i;
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
const WHISPER = process.env.WHISPER_BIN || 'whisper';

mkdirSync(MEDIA_DIR, { recursive: true });
let index = {};
try { if (existsSync(INDEX)) index = JSON.parse(readFileSync(INDEX, 'utf8')); } catch { index = {}; }
const saveIndex = () => writeFileSync(INDEX, JSON.stringify(index, null, 1));
export const videoMeta = file => index[file] || null;
export const allMeta = () => index;

function run(cmd, args, { cwd, timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(Object.assign(new Error(`${cmd} puuttuu`), { missing: cmd }));
        return reject(new Error(`${path.basename(cmd)}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
      }
      resolve(stdout);
    });
  });
}

let tools;
export async function mediaTools() {
  if (tools) return tools;
  const has = async (cmd, args) => { try { await run(cmd, args, { timeout: 20000 }); return true; } catch (e) { return !e.missing; } };
  tools = { ffmpeg: await has(FFMPEG, ['-version']), whisper: await has(WHISPER, ['--help']) };
  return tools;
}

// Videopolku työtilan sisällä → absoluuttinen polku (vain videos/-kansiosta).
export function resolveVideo(rel) {
  const full = path.resolve(WORKSPACE, String(rel || '').replace(/^\/+/, ''));
  if (!full.startsWith(VIDEO_DIR + path.sep) || !VIDEO_EXT.test(full) || !existsSync(full)) {
    throw new Error(`Videota ${rel} ei löydy kansiosta videos/ (sallitut: .mp4, .mov)`);
  }
  return full;
}
const relOf = full => path.relative(WORKSPACE, full).split(path.sep).join('/');

export async function listVideos() {
  await fs.mkdir(EDIT_DIR, { recursive: true });
  const out = [];
  for (const dir of [VIDEO_DIR, EDIT_DIR]) {
    for (const name of await fs.readdir(dir)) {
      if (!VIDEO_EXT.test(name)) continue;
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      out.push({ file: relOf(full), mb: +(st.size / 1048576).toFixed(1), mtime: st.mtimeMs, size: st.size });
    }
  }
  return out;
}

export async function probe(full) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', full], { timeout: 60000 }));
  const v = (j.streams || []).find(s => s.codec_type === 'video') || {};
  let w = v.width, h = v.height;
  const rot = Math.abs(Number(v.tags?.rotate || v.side_data_list?.find(d => d.rotation !== undefined)?.rotation || 0));
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return {
    duration: +Number(j.format?.duration || 0).toFixed(1), width: w, height: h,
    vertical: h > w, ratio: w && h ? `${w}:${h}` : '?',
    hasAudio: (j.streams || []).some(s => s.codec_type === 'audio'),
  };
}

function srtToText(srt) {
  return srt.replace(/\r/g, '').split('\n').filter(l => l && !/^\d+$/.test(l) && !/-->/.test(l)).join(' ').replace(/\s+/g, ' ').trim();
}

async function transcribe(full, outDir) {
  if (!(await mediaTools()).whisper) return null;
  await run(WHISPER, [full, '--model', process.env.WHISPER_MODEL || 'base', '--output_format', 'srt', '--output_dir', outDir, '--fp16', 'False'], { timeout: 20 * 60_000 });
  const srtPath = path.join(outDir, path.basename(full).replace(/\.[^.]+$/, '') + '.srt');
  if (!existsSync(srtPath)) return null;
  return { srt: srtPath, text: srtToText(readFileSync(srtPath, 'utf8')).slice(0, 4000) };
}

// Analysoi video kerran: tiedot, avainkuvat, litterointi ja Clauden kuvaus. Palauttaa käytetyt tokenit.
export async function analyzeVideo(rel, { model } = {}) {
  const full = resolveVideo(rel);
  if (!(await mediaTools()).ffmpeg) throw new Error('ffmpeg puuttuu – asenna se, jotta agentit näkevät videot');
  const st = await fs.stat(full);
  const key = createHash('sha1').update(`${rel}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12);
  if (index[rel]?.key === key && index[rel].analysis) return { tokens: 0, meta: index[rel] };

  const dir = path.join(MEDIA_DIR, key);
  await fs.mkdir(dir, { recursive: true });
  const info = await probe(full);

  // 1 ruutu koukusta (0,5 s) + 5 tasaisesti koko videosta.
  const d = Math.max(info.duration, 1);
  const times = [Math.min(0.5, d / 2), ...[0, 1, 2, 3, 4].map(i => d * (i + 0.5) / 5)];
  const images = [];
  for (const [i, t] of times.entries()) {
    const out = path.join(dir, `f${i}.jpg`);
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', full, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '5', '-y', out], { timeout: 60000 });
    if (existsSync(out)) images.push({ base64: readFileSync(out).toString('base64'), t });
  }

  let transcript = null;
  try { transcript = info.hasAudio ? await transcribe(full, dir) : null; } catch (e) { transcript = { text: '', error: e.message }; }

  const text = `Video: ${rel}
Kesto ${info.duration} s, ${info.width}x${info.height} (${info.vertical ? 'pysty' : 'vaaka/neliö'}), ääni: ${info.hasAudio ? 'kyllä' : 'ei'}.
Ruudut ajanhetkiltä: ${images.map(im => im.t.toFixed(1) + ' s').join(', ')} (ensimmäinen = koukku).
Puhe: ${transcript?.text ? transcript.text : '(ei litterointia saatavilla)'}

Analysoi video Instagram Reels -julkaisua varten. Vastaa pelkällä JSONilla:
{"summary":"mitä videolla tapahtuu (max 300 merkkiä)","hook":"miten ensimmäiset 2 s vangitsevat huomion, arvosana 1-10","on_screen_text":"näkyvä teksti tai tyhjä","mood":"tunnelma","audience":"kenelle tämä sopii","strengths":"vahvuudet","weaknesses":"heikkoudet ja parannusehdotukset (esim. lyhennä, lisää koukkuteksti, tekstitys)","caption_ideas":["3 kuvatekstiehdotusta"]}`;

  const { text: reply, tokens } = await completeWithImages({
    system: 'Olet kokenut lyhytvideoiden ja Instagram Reelsin sisältöanalyytikko. Kuvaile vain sitä mitä näet ja kuulet – älä keksi.',
    text, images: images.map(im => ({ base64: im.base64 })), model,
  });
  let analysis;
  try { analysis = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)); } catch { analysis = { summary: reply.slice(0, 400) }; }

  index[rel] = { key, ...info, transcript: transcript?.text || '', srt: transcript?.srt || null, transcriptError: transcript?.error, analysis, analyzedAt: Date.now() };
  saveIndex();
  return { tokens, meta: index[rel] };
}

export function setOwnerNote(rel, note) {
  index[rel] = { ...(index[rel] || {}), ownerNote: String(note || '').slice(0, 1000) };
  saveIndex();
}

// Lyhyt kuvaus agenttien kehotteeseen.
export function videoLine(v) {
  const m = index[v.file];
  if (!m?.analysis) return `${v.file} (${v.mb} Mt, ei analysoitu)${m?.ownerNote ? ` – omistaja: ${m.ownerNote}` : ''}`;
  const a = m.analysis;
  return `${v.file} – ${m.duration} s, ${m.vertical ? '9:16' : m.ratio}${m.hasAudio ? '' : ', ei ääntä'}${m.srt ? ', tekstitettävissä' : ''}
     sisältö: ${a.summary || ''} | koukku: ${a.hook || '?'} | heikkoudet: ${String(a.weaknesses || '').slice(0, 160)}${m.ownerNote ? `\n     omistaja: ${m.ownerNote}` : ''}`;
}

// ---------- muokkaus ----------
function outPath(full, op) {
  const base = path.basename(full).replace(/\.[^.]+$/, '').replace(/-(trim|vertical|hook|subs)\d*$/g, '');
  let n = 1, out;
  do { out = path.join(EDIT_DIR, `${base}-${op}${n > 1 ? n : ''}.mp4`); n++; } while (existsSync(out));
  return out;
}
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
const assEscape = s => String(s).replace(/[{}\\]/g, '').replace(/\r?\n/g, '\\N').slice(0, 120);

export async function editVideo(input = {}) {
  if (!(await mediaTools()).ffmpeg) throw new Error('ffmpeg puuttuu');
  const full = resolveVideo(input.video);
  await fs.mkdir(EDIT_DIR, { recursive: true });
  const op = String(input.op || '');
  let out, args, cwd;

  if (op === 'trim') {
    const start = Math.max(0, Number(input.start) || 0), end = Number(input.end);
    if (!(end > start)) throw new Error('trim: anna start ja end sekunteina (end > start)');
    out = outPath(full, 'trim');
    args = ['-ss', String(start), '-to', String(end), '-i', full, ...ENC, '-y', out];
  } else if (op === 'vertical') {
    out = outPath(full, 'vertical');
    args = ['-i', full, '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1', ...ENC, '-y', out];
  } else if (op === 'hook_text') {
    if (!input.text) throw new Error('hook_text: anna text');
    const secs = Math.min(Math.max(Number(input.seconds) || 3, 1), 10);
    const t = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
    cwd = await fs.mkdtemp(path.join(MEDIA_DIR, 'hook-'));
    await fs.writeFile(path.join(cwd, 'hook.ass'), `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Hook,Arial,78,&H00FFFFFF,&H00000000,&H80000000,1,1,6,2,8,60,60,260

[Events]
Format: Layer, Start, End, Style, Text
Dialogue: 0,${t(0)},${t(secs)},Hook,${assEscape(input.text)}
`);
    out = outPath(full, 'hook');
    args = ['-i', full, '-vf', 'subtitles=hook.ass', ...ENC, '-y', out];
  } else if (op === 'subtitles') {
    const m = index[relOf(full)];
    if (!m?.srt || !existsSync(m.srt)) throw new Error('subtitles: videolle ei ole litterointia (vaatii Whisperin ja analyysin)');
    cwd = path.dirname(m.srt);
    out = outPath(full, 'subs');
    args = ['-i', full, '-vf', `subtitles=${path.basename(m.srt)}:force_style='Fontname=Arial,Fontsize=16,Bold=1,Outline=2,MarginV=70'`, ...ENC, '-y', out];
  } else {
    throw new Error('op: trim | vertical | hook_text | subtitles');
  }

  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { cwd });
  if (cwd && path.basename(cwd).startsWith('hook-')) await fs.rm(cwd, { recursive: true, force: true });
  const rel = relOf(out);
  const info = await probe(out).catch(() => ({}));
  // Muokattu versio perii alkuperäisen analyysin, jotta sitä ei tarvitse analysoida uudelleen.
  const parentRel = relOf(full), parent = index[parentRel] || {};
  const label = { trim: `rajattu ${input.start}–${input.end} s`, vertical: 'muunnettu 9:16', hook_text: `koukkuteksti "${input.text}"`, subtitles: 'tekstitetty' }[op];
  index[rel] = {
    key: 'derived', ...info, derivedFrom: parentRel, op: label,
    transcript: op === 'trim' ? '' : parent.transcript || '', srt: op === 'trim' ? null : parent.srt || null,
    analysis: parent.analysis ? { ...parent.analysis, summary: `[${label}, versio videosta ${parentRel}] ${parent.analysis.summary || ''}` } : null,
    analyzedAt: Date.now(),
  };
  saveIndex();
  return `Valmis: ${rel} (${info.duration ?? '?'} s, ${info.width}x${info.height}). Uusi versio on kirjastossa julkaistavissa.`;
}
