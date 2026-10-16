// Instagram selaimen kautta (epävirallinen tapa). Omistaja kirjautuu itse näkyvään selainikkunaan;
// salasanaa ei tallenneta mihinkään. Kirjautuminen säilyy selaimen profiilissa kansiossa data/ig-browser.
// HUOM: automaatio rikkoo Instagramin käyttöehtoja – tili voi joutua tarkistukseen tai lukituksi.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE } from './powers.js';
import { VIDEO_DIR } from './instagram.js';

const PROFILE = path.resolve('data', 'ig-browser');
const STATUS = path.join(PROFILE, '..', 'ig-browser.json');
const VIDEO_EXT = /\.(mp4|mov)$/i;
const BASE = process.env.IG_WEB_BASE || 'https://www.instagram.com'; // testejä varten vaihdettavissa

export function browserStatus() {
  try { return existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : { loggedIn: false }; } catch { return { loggedIn: false }; }
}
function setStatus(s) { writeFileSync(STATUS, JSON.stringify(s, null, 1)); }

async function loadPlaywright() {
  try { return (await import('playwright')).chromium; } catch {
    throw new Error('Playwright puuttuu. Aja Chattyboys-kansiossa: npm install');
  }
}

async function launch({ headless }) {
  const chromium = await loadPlaywright();
  mkdirSync(PROFILE, { recursive: true });
  const opts = { headless, viewport: { width: 1280, height: 900 }, locale: 'en-US' };
  // Oletuksena Microsoft Edge (valmiina Windowsissa), sitten Chrome ja lopuksi Playwrightin oma Chromium.
  // Selaimen voi valita: IG_BROWSER=msedge | chrome | chromium
  const order = process.env.IG_BROWSER ? [process.env.IG_BROWSER] : ['msedge', 'chrome', 'chromium'];
  let lastErr;
  for (const channel of order) {
    try {
      return await chromium.launchPersistentContext(PROFILE, channel === 'chromium' ? opts : { ...opts, channel });
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Selainta ei saatu auki (${order.join(', ')}): ${lastErr?.message?.split('\n')[0]}`);
}

const hasSession = async ctx => (await ctx.cookies(BASE)).some(c => c.name === 'sessionid' && c.value);

// Avaa näkyvä selain, omistaja kirjautuu itse. Odottaa enintään 5 min.
export async function login() {
  const ctx = await launch({ headless: false });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${BASE}/accounts/login/`);
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      if (await hasSession(ctx)) {
        const id = (await ctx.cookies(BASE)).find(c => c.name === 'ds_user_id')?.value || '';
        await page.waitForTimeout(2000);
        setStatus({ loggedIn: true, userId: id, at: Date.now() });
        return { userId: id };
      }
      await page.waitForTimeout(1500);
    }
    throw new Error('Kirjautuminen ei valmistunut 5 minuutissa');
  } finally { await ctx.close().catch(() => {}); }
}

export function logout() { setStatus({ loggedIn: false }); }

// Klikkaa ensimmäistä näkyvää elementtiä, joka vastaa jotain annetuista teksteistä / aria-labeleista.
async function clickAny(page, labels, { timeout = 15000, role } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const l of labels) {
      const candidates = [
        page.getByRole(role || 'button', { name: l, exact: true }),
        page.getByRole('link', { name: l, exact: true }),
        page.locator(`svg[aria-label="${l}"]`),
        page.getByText(l, { exact: true }),
      ];
      for (const c of candidates) {
        const el = c.first();
        if (await el.isVisible().catch(() => false)) { await el.click(); return l; }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Painiketta ei löytynyt: ${labels.join(' / ')}`);
}

async function debugShot(page, step) {
  const file = `ig-virhe-${Date.now()}.png`;
  await page.screenshot({ path: path.join(WORKSPACE, file) }).catch(() => {});
  return `${step} epäonnistui – kuvakaappaus työtilassa: ${file}`;
}

// Julkaise video Reelinä instagram.comin kautta.
export async function publishViaBrowser({ video, caption = '' }) {
  if (!browserStatus().loggedIn) throw new Error('Instagram-selainkirjautumista ei ole tehty (⚙️ → Instagram → Kirjaudu selaimella)');
  const full = path.resolve(WORKSPACE, String(video || '').replace(/^\/+/, ''));
  if (!full.startsWith(VIDEO_DIR + path.sep) || !VIDEO_EXT.test(full) || !existsSync(full)) {
    throw new Error(`Videota ${video} ei löydy kansiosta videos/ (sallitut: .mp4, .mov)`);
  }

  const ctx = await launch({ headless: process.env.IG_BROWSER_HEADLESS === '1' });
  const page = ctx.pages()[0] || await ctx.newPage();
  let step = 'Instagramin avaaminen';
  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    if (!(await hasSession(ctx))) { logout(); throw new Error('Instagram-kirjautuminen on vanhentunut – kirjaudu uudelleen asetuksista'); }

    // Ohita mahdolliset "Turn on notifications" / "Save login info" -ikkunat.
    await clickAny(page, ['Not Now', 'Not now', 'Ei nyt'], { timeout: 3000 }).catch(() => {});

    step = 'Uusi julkaisu -painike';
    await clickAny(page, ['New post', 'Create', 'Uusi julkaisu', 'Luo']);
    await clickAny(page, ['Post', 'Julkaisu'], { timeout: 4000 }).catch(() => {}); // uudemmissa versioissa alavalikko

    step = 'Videon valinta';
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 15000 });
    await input.setInputFiles(full);
    await clickAny(page, ['OK'], { timeout: 6000 }).catch(() => {}); // "Video posts are now shared as reels"

    step = 'Rajaus- ja muokkausvaiheet';
    await clickAny(page, ['Next', 'Seuraava'], { timeout: 60000 });
    await page.waitForTimeout(1500);
    await clickAny(page, ['Next', 'Seuraava'], { timeout: 30000 });

    step = 'Kuvatekstin kirjoitus';
    const box = page.locator('div[aria-label="Write a caption..."], div[aria-label="Kirjoita kuvateksti..."], div[contenteditable="true"][role="textbox"], textarea').first();
    await box.waitFor({ state: 'visible', timeout: 20000 });
    await box.click();
    await page.keyboard.insertText(String(caption).slice(0, 2200));

    step = 'Jakaminen';
    await clickAny(page, ['Share', 'Jaa']);
    await page.getByText(/(reel|post) (has been|was) shared|on jaettu/i).locator('visible=true').first().waitFor({ timeout: 5 * 60_000 });
    await page.waitForTimeout(2000);
    return { id: 'selain', permalink: '' };
  } catch (e) {
    throw new Error(`${await debugShot(page, step)}. (${e.message.slice(0, 160)})`);
  } finally { await ctx.close().catch(() => {}); }
}
