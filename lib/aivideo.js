// Agenttien itse tekemät tekoälyvideot: käsikirjoitus → puhe (TTS) → kuvat/klipit → tekstitykset → valmis 9:16 Reel.
// Toimii ilman maksullisia palveluita (koneen oma puhesyntetisaattori + värikortit) ja paranee avaimilla.
import { execFile } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './powers.js';
import { run, probe, FFMPEG, ENC, MEDIA_DIR, AI_DIR, resolveVideo, setKnownMeta, mediaTools } from './media.js';

const SECRETS = path.resolve('data', 'secrets.json');
const MUSIC_DIR = path.join(WORKSPACE, 'music');
const W = 1080, H = 1920, FPS = 30;
const PALETTE = [['0x4c1d95', '0x1e1b4b'], ['0x0e7490', '0x0f172a'], ['0xbe185d', '0x3b0764'], ['0x15803d', '0x052e16'], ['0xc2410c', '0x431407'], ['0x1d4ed8', '0x172554']];

function secrets() {
  try { return existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, 'utf8')) : {}; } catch { return {}; }
}
export function saveAiKeys({ elevenlabsKey, elevenlabsVoice, openaiKey }) {
  const s = secrets();
  s.ai = { ...(s.ai || {}) };
  if (elevenlabsKey !== undefined) s.ai.elevenlabsKey = elevenlabsKey || undefined;
  if (elevenlabsVoice !== undefined) s.ai.elevenlabsVoice = elevenlabsVoice || undefined;
  if (openaiKey !== undefined) s.ai.openaiKey = openaiKey || undefined;
  writeFileSync(SECRETS, JSON.stringify(s, null, 1), { mode: 0o600 });
}
function keys() {
  const a = secrets().ai || {};
  return {
    eleven: process.env.ELEVENLABS_API_KEY || a.elevenlabsKey || '',
    elevenVoice: process.env.ELEVENLABS_VOICE_ID || a.elevenlabsVoice || '',
    openai: process.env.OPENAI_API_KEY || a.openaiKey || '',
  };
}

const exists = (cmd, args = ['--help']) => new Promise(r => execFile(cmd, args, { timeout: 15000, windowsHide: true }, e => r(!(e && e.code === 'ENOENT'))));

let caps;
export async function aiCapabilities(force = false) {
  if (caps && !force) return caps;
  const k = keys();
  const tts = [];
  if (k.eleven && k.elevenVoice) tts.push('elevenlabs');
  if (await exists('edge-tts')) tts.push('edge');
  if (process.platform === 'win32') tts.push('windows');
  else if (process.platform === 'darwin') tts.push('mac');
  else if (await exists('espeak-ng')) tts.push('espeak');
  tts.push('silent');
  const images = [];
  if (k.openai) images.push('openai');
  images.push('pollinations', 'card');
  caps = { tts, images, ffmpeg: (await mediaTools()).ffmpeg };
  return caps;
}
export const keyStatus = () => { const k = keys(); return { elevenlabs: Boolean(k.eleven), elevenlabsVoice: Boolean(k.elevenVoice), openai: Boolean(k.openai) }; };

// ---------- puhe ----------
async function duration(file) { return (await probe(file)).duration || 0; }

async function tts(text, outBase, { provider, voice }) {
  const k = keys();
  if (provider === 'elevenlabs') {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(k.elevenVoice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': k.eleven, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }), signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = outBase + '.mp3'; await fs.writeFile(out, Buffer.from(await res.arrayBuffer())); return out;
  }
  if (provider === 'edge') {
    const out = outBase + '.mp3';
    await run('edge-tts', ['--voice', voice || 'fi-FI-NooraNeural', '--text', text, '--write-media', out], { timeout: 120000 });
    return out;
  }
  if (provider === 'windows') {
    const out = outBase + '.wav';
    // Teksti välitetään ympäristömuuttujassa – ei koskaan komentorivin osana.
    await new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like $env:TTS_LANG } | Select-Object -First 1; ' +
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.SetOutputToWaveFile($env:TTS_OUT); $s.Speak($env:TTS_TEXT); $s.Dispose()'],
      { env: { ...process.env, TTS_TEXT: text, TTS_OUT: out, TTS_LANG: (voice && /^[a-z]{2}-/i.test(voice) ? voice.slice(0, 5) : 'fi-FI') + '*' }, timeout: 120000, windowsHide: true },
      e => (e ? reject(new Error('Windowsin puhesyntetisaattori: ' + e.message.slice(0, 200))) : resolve())));
    return out;
  }
  if (provider === 'mac') {
    const out = outBase + '.aiff'; await run('say', ['-o', out, text], { timeout: 120000 }); return out;
  }
  if (provider === 'espeak') {
    const out = outBase + '.wav'; await run('espeak-ng', ['-v', 'fi', '-s', '165', '-w', out, text], { timeout: 120000 }); return out;
  }
  // silent: hiljaisuus arvioidun puhenopeuden mukaan (≈ 2,6 sanaa/s), tekstitykset kertovat sisällön
  const secs = Math.max(2, text.split(/\s+/).length / 2.6);
  const out = outBase + '.wav';
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', secs.toFixed(2), '-y', out]);
  return out;
}

// ---------- kuvat ----------
async function genImage(prompt, out, provider, seed) {
  const k = keys();
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { authorization: `Bearer ${k.openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: '1024x1536', n: 1 }),
      signal: AbortSignal.timeout(180000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OpenAI-kuva ${res.status}: ${j.error?.message || ''}`);
    const d = j.data?.[0];
    if (d?.b64_json) await fs.writeFile(out, Buffer.from(d.b64_json, 'base64'));
    else if (d?.url) await fs.writeFile(out, Buffer.from(await (await fetch(d.url)).arrayBuffer()));
    else throw new Error('OpenAI ei palauttanut kuvaa');
    return out;
  }
  if (provider === 'pollinations') {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 400))}?width=${W}&height=${H}&nologo=true&seed=${seed}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) throw new Error(`Pollinations ${res.status}`);
    await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }
  return null;
}

// ---------- tekstitykset ----------
const assTime = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
const assText = s => String(s).replace(/[{}\\]/g, '').replace(/\r?\n/g, ' ').trim();

function chunk(text, maxWords = 5) {
  const words = assText(text).split(/\s+/).filter(Boolean), out = [];
  for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(' '));
  return out;
}

function buildAss(scenes) {
  let ev = '';
  for (const sc of scenes) {
    const parts = chunk(sc.say);
    const total = parts.reduce((a, p) => a + p.length, 0) || 1;
    let t = sc.start + 0.1;
    for (const p of parts) {
      const d = (sc.speech - 0.1) * (p.length / total);
      ev += `Dialogue: 0,${assTime(t)},${assTime(t + d)},Caption,,0,0,0,,${p}\n`;
      t += d;
    }
    if (sc.on_screen) ev += `Dialogue: 1,${assTime(sc.start)},${assTime(sc.start + sc.dur)},${sc.kind === 'card' ? 'CardTitle' : 'Title'},,0,0,0,,${assText(sc.on_screen).slice(0, 90)}\n`;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,80,80,420,1
Style: CardTitle,Arial,104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,3,5,90,90,0,1
Style: Title,Arial,86,&H0000E5FF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,2,8,70,70,260,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev}`;
}

// ---------- kohtaukset ----------
let gradients;
async function hasGradients() {
  if (gradients === undefined) gradients = /\bgradients\b/.test(await run(FFMPEG, ['-hide_banner', '-filters'], { timeout: 20000 }).catch(() => ''));
  return gradients;
}

async function renderScene(sc, i, dir, audio, dur) {
  const out = path.join(dir, `s${i}.mp4`);
  const fitV = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p`;
  const tail = ['-map', '0:v', '-map', '1:a', '-t', dur.toFixed(2), '-r', String(FPS), ...ENC, '-ar', '44100', '-ac', '2', '-y', out];
  let input;
  if (sc.kind === 'clip') {
    input = ['-stream_loop', '-1', '-ss', String(Math.max(0, Number(sc.clipStart) || 0)), '-i', sc.clipPath, '-i', audio, '-vf', fitV];
  } else if (sc.kind === 'image') {
    const frames = Math.ceil(dur * FPS);
    input = ['-loop', '1', '-i', sc.imagePath, '-i', audio, '-vf',
      `scale=${Math.round(W * 1.15)}:${Math.round(H * 1.15)}:force_original_aspect_ratio=increase,crop=${Math.round(W * 1.15)}:${Math.round(H * 1.15)},` +
      `zoompan=z='min(zoom+0.0009,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p`];
  } else {
    const [c0, c1] = PALETTE[i % PALETTE.length];
    const bg = (await hasGradients())
      ? `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${W}:y1=${H}:speed=0.008:r=${FPS}:d=${dur.toFixed(2)}`
      : `color=c=${c1}:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(2)}`;
    input = ['-f', 'lavfi', '-i', bg, '-i', audio, '-vf', 'vignette=PI/5,format=yuv420p'];
  }
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...input, ...tail], { timeout: 10 * 60_000 });
  return out;
}

const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'video';

// Pääfunktio. input: { title, scenes:[{say, visual, on_screen}], voice?, music? }
//   visual: "image: <kuvakehote englanniksi>" | "clip: videos/x.mp4@5" | "card"
export async function makeAiVideo(input = {}, { config = {}, onProgress = () => {} } = {}) {
  const c = await aiCapabilities();
  if (!c.ffmpeg) throw new Error('ffmpeg puuttuu');
  const scenes = (Array.isArray(input.scenes) ? input.scenes : []).filter(s => s && String(s.say || '').trim()).slice(0, 12);
  if (!input.title || !scenes.length) throw new Error('Anna title ja scenes: [{ say, visual, on_screen }]');
  const totalWords = scenes.reduce((a, s) => a + String(s.say).split(/\s+/).length, 0);
  if (totalWords > 260) throw new Error('Liian pitkä käsikirjoitus (max ~260 sanaa ≈ 90 s)');

  const ttsProvider = config.ttsProvider && config.ttsProvider !== 'auto' ? config.ttsProvider : c.tts[0];
  if (!c.tts.includes(ttsProvider)) throw new Error(`Äänipalvelu ${ttsProvider} ei ole käytettävissä (saatavilla: ${c.tts.join(', ')})`);
  const imgProvider = config.imageProvider && config.imageProvider !== 'auto' ? config.imageProvider : c.images[0];
  const voice = input.voice || config.ttsVoice || '';

  const dir = await fs.mkdtemp(path.join(MEDIA_DIR, 'ai-'));
  const notes = [];
  try {
    let t = 0;
    const built = [];
    for (const [i, s] of scenes.entries()) {
      onProgress(`kohtaus ${i + 1}/${scenes.length}: ääni`);
      let audio;
      try { audio = await tts(String(s.say).slice(0, 600), path.join(dir, `a${i}`), { provider: ttsProvider, voice }); }
      catch (e) { notes.push(`ääni kohtaus ${i + 1}: ${e.message} → hiljainen`); audio = await tts(String(s.say), path.join(dir, `a${i}`), { provider: 'silent' }); }
      const speech = await duration(audio);
      const dur = speech + 0.35;

      const sc = { say: s.say, on_screen: s.on_screen, start: t, speech, dur, kind: 'card' };
      const visual = String(s.visual || 'card').trim();
      if (/^clip:/i.test(visual)) {
        const [file, at] = visual.replace(/^clip:\s*/i, '').split('@');
        try { sc.clipPath = resolveVideo(file.trim()); sc.clipStart = at; sc.kind = 'clip'; } catch (e) { notes.push(e.message); }
      } else if (/^image:/i.test(visual) && imgProvider !== 'card') {
        onProgress(`kohtaus ${i + 1}/${scenes.length}: kuva`);
        const prompt = `${visual.replace(/^image:\s*/i, '')}, vertical 9:16 composition, high quality, no text, no watermark`;
        for (const p of [imgProvider, ...c.images.filter(x => x !== imgProvider && x !== 'card')]) {
          try { sc.imagePath = await genImage(prompt, path.join(dir, `i${i}.jpg`), p, 1000 + i); sc.kind = 'image'; break; }
          catch (e) { notes.push(`kuva kohtaus ${i + 1} (${p}): ${e.message}`); }
        }
      }
      onProgress(`kohtaus ${i + 1}/${scenes.length}: koostetaan`);
      sc.file = await renderScene(sc, i, dir, audio, dur);
      built.push(sc);
      t += dur;
    }

    onProgress('yhdistetään ja tekstitetään');
    await fs.writeFile(path.join(dir, 'list.txt'), built.map(s => `file '${path.basename(s.file)}'`).join('\n'));
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', '-y', 'joined.mp4'], { cwd: dir });
    await fs.writeFile(path.join(dir, 'subs.ass'), buildAss(built), 'utf8');

    await fs.mkdir(AI_DIR, { recursive: true });
    let out = path.join(AI_DIR, `${slugify(input.title)}.mp4`);
    for (let n = 2; existsSync(out); n++) out = path.join(AI_DIR, `${slugify(input.title)}-${n}.mp4`);

    const music = input.music !== false ? await pickMusic() : null;
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'joined.mp4'];
    if (music) {
      args.push('-stream_loop', '-1', '-i', music, '-filter_complex',
        `[0:v]subtitles=subs.ass[v];[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        '-map', '[v]', '-map', '[a]');
    } else {
      args.push('-vf', 'subtitles=subs.ass');
    }
    args.push(...ENC, '-shortest', '-y', out);
    await run(FFMPEG, args, { cwd: dir, timeout: 15 * 60_000 });

    const rel = path.relative(WORKSPACE, out).split(path.sep).join('/');
    const narration = built.map(s => s.say).join(' ');
    await fs.mkdir(path.join(WORKSPACE, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(WORKSPACE, 'scripts', `${path.basename(out, '.mp4')}.json`), JSON.stringify({ ...input, voice, ttsProvider, imgProvider }, null, 2));
    setKnownMeta(rel, {
      duration: +t.toFixed(1), width: W, height: H, vertical: true, ratio: '9:16', hasAudio: true, aiGenerated: true,
      transcript: narration.slice(0, 4000),
      analysis: {
        summary: `[Agenttien tekemä tekoälyvideo] ${input.title}: ${narration.slice(0, 220)}`,
        hook: built[0]?.on_screen || built[0]?.say?.slice(0, 80) || '',
        weaknesses: notes.length ? notes.join('; ').slice(0, 300) : '',
      },
    });
    return { rel, seconds: +t.toFixed(1), tts: ttsProvider, images: imgProvider, notes, music: Boolean(music) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function pickMusic() {
  try {
    const files = (await fs.readdir(MUSIC_DIR)).filter(f => /\.(mp3|m4a|wav|ogg)$/i.test(f));
    return files.length ? path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]) : null;
  } catch { return null; }
}
