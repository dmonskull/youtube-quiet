// Watch real YouTube videos and record what the player does.
// Start Chrome with test/launch.sh first, then:
//   node test/live.mjs [--off] [--journey] [--keep-ads] [--seconds=45] [--out=dir] <videoId|url> ...
// --off pauses filtering first, to see what an unfiltered session is served.
// --journey also seeks to the middle (mid-roll territory) and then opens the
//   next video in-page, which is when the player fetches a fresh response.
// --keep-ads leaves the ad lists in place, so the engine's last-resort handling
//   of an ad that actually starts can be watched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { CDP, PORT, extensionId, pause } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = name => args.find(arg => arg.startsWith(`--${name}`));
const off = Boolean(flag('off'));
const seconds = Number(flag('seconds')?.split('=')[1] || 45);
const outDir = flag('out')?.split('=')[1] || 'test/out';
const journey = Boolean(flag('journey'));
const keepAds = Boolean(flag('keep-ads'));
const videos = args.filter(arg => !arg.startsWith('--'));
const ACTIONS = journey ? [
  { at: 12, name: 'seek to 50%', js: `(() => { const p = document.getElementById('movie_player'); p.seekTo(p.getDuration() * 0.5, true); return Math.round(p.getDuration() * 0.5); })()` },
  { at: 26, name: 'open next video in page', js: `(() => { const a = document.querySelector('ytd-watch-next-secondary-results-renderer a[href^="/watch"], #related a[href^="/watch"]'); a?.click(); return a?.href || null; })()` }
] : [];
if (videos.length === 0) videos.push('dQw4w9WgXcQ');

const SNAPSHOT = `(() => {
  const player = document.getElementById('movie_player');
  const video = player?.querySelector('video');
  let response = null, stats = null;
  try { response = player?.getPlayerResponse?.(); } catch {}
  try { stats = player?.getStatsForNerds?.(); } catch {}
  const text = selector => document.querySelector(selector)?.innerText?.trim().slice(0, 160) || null;
  return {
    ad: Boolean(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))),
    stitched: typeof stats?.debug_info === 'string' && stats.debug_info.startsWith('SSAP, AD'),
    t: video ? Math.round(video.currentTime * 10) / 10 : null,
    dur: video && Number.isFinite(video.duration) ? Math.round(video.duration) : null,
    paused: video ? video.paused : null,
    ready: video ? video.readyState : null,
    muted: video ? video.muted : null,
    res: stats?.resolution || null,
    buffer: stats?.buffer_health_seconds || null,
    adKeys: ['adPlacements', 'adSlots', 'playerAds'].filter(key => response && response[key] !== undefined),
    playability: response?.playabilityStatus?.status || null,
    playlist: (() => { try { return player?.getPlaylistId?.() || null; } catch { return null; } })(),
    reason: response?.playabilityStatus?.reason || null,
    enforcement: Boolean(document.querySelector('ytd-enforcement-message-view-model')),
    error: text('.ytp-error-content-wrap') || text('#player-error-message-container'),
    consent: Boolean(document.querySelector('ytd-consent-bump-v2-lightbox, form[action*="consent"]')),
    adText: text('.ytp-ad-player-overlay-layout, .ytp-ad-text, .ytp-ad-preview-container'),
    quiet: window.__ytQuiet ? { ...window.__ytQuiet } : null,
    url: location.href.slice(0, 90)
  };
})()`;

const cdp = await CDP.connect(PORT);
const report = { when: new Date().toISOString(), filtering: !off, browser: null, runs: [] };
try {
  report.browser = (await cdp.send('Browser.getVersion')).product;
  const id = await extensionId(cdp).catch(() => null);
  if (id) {
    const popup = await cdp.open(`chrome-extension://${id}/popup.html`);
    await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
    const wanted = String(!off);
    if ((await cdp.eval(`document.querySelector('#toggle').getAttribute('aria-checked')`, popup.sessionId)) !== wanted) {
      await cdp.eval(`document.querySelector('#toggle').click()`, popup.sessionId);
    }
    await cdp.poll(`!document.querySelector('#toggle').disabled && document.querySelector('#toggle').getAttribute('aria-checked') === '${wanted}'`, popup.sessionId);
    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  } else if (!off) {
    throw new Error('Extension is not loaded');
  }

  await fs.mkdir(outDir, { recursive: true });
  for (const video of videos) {
    const url = video.startsWith('http') ? video : `https://www.youtube.com/watch?v=${video}`;
    const page = await cdp.open();
    const net = { blocked: 0, playerCalls: 0, adHosts: 0 };
    const errors = [];
    cdp.on('Network.requestWillBeSent', (params, sessionId) => {
      if (sessionId !== page.sessionId) return;
      if (/\/youtubei\/v1\/player/.test(params.request.url)) net.playerCalls++;
      if (/doubleclick\.net|googlesyndication|\/pagead\/|\/api\/stats\/ads/.test(params.request.url)) net.adHosts++;
    });
    cdp.on('Network.loadingFailed', (params, sessionId) => {
      if (sessionId === page.sessionId && params.blockedReason) net.blocked++;
    });
    cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
      if (sessionId === page.sessionId) errors.push(String(params.exceptionDetails.exception?.description || params.exceptionDetails.text).slice(0, 200));
    });
    await cdp.send('Network.enable', {}, page.sessionId);
    if (keepAds) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ytQuietTest = { keepAds: true };' }, page.sessionId);
    await cdp.send('Page.navigate', { url }, page.sessionId);

    const timeline = [];
    const totals = { firstFrameMs: null, samples: 0, adSamples: 0, stitchedSamples: 0, enforcementSamples: 0, stalledSamples: 0 };
    let last = '';
    let previousT = null;
    const started = Date.now();
    const todo = [...ACTIONS];
    while (Date.now() - started < seconds * 1000) {
      await pause(250);
      if (todo.length && Date.now() - started >= todo[0].at * 1000) {
        const action = todo.shift();
        const result = await cdp.eval(action.js, page.sessionId).catch(error => `failed: ${error.message.slice(0, 80)}`);
        timeline.push({ at: Math.round((Date.now() - started) / 100) / 10, action: `${action.name} -> ${result}` });
      }
      const snap = await cdp.eval(SNAPSHOT, page.sessionId).catch(() => null);
      if (!snap) continue;
      totals.samples++;
      if (totals.firstFrameMs === null && !snap.ad && snap.t > 0.2) totals.firstFrameMs = Date.now() - started;
      if (snap.ad) totals.adSamples++;
      if (snap.stitched) totals.stitchedSamples++;
      if (snap.enforcement) totals.enforcementSamples++;
      if (snap.t !== null && snap.t === previousT && !snap.ad) totals.stalledSamples++;
      previousT = snap.t;
      const { t, buffer, ...rest } = snap;
      const key = JSON.stringify(rest);
      if (key !== last) {
        last = key;
        timeline.push({ at: Math.round((Date.now() - started) / 100) / 10, ...snap });
      }
    }
    const final = await cdp.eval(SNAPSHOT, page.sessionId).catch(() => null);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId).catch(() => null);
    const name = `${off ? 'off' : 'on'}-${video.replace(/[^\w-]/g, '_').slice(-24)}`;
    if (shot) await fs.writeFile(path.join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    const run = { url, totals, net, final, errors: errors.slice(0, 8), timeline };
    report.runs.push(run);
    console.log(`\n=== ${url} (${off ? 'filtering OFF' : 'filtering ON'})`);
    console.log('totals', JSON.stringify(totals), 'net', JSON.stringify(net));
    console.log('final ', JSON.stringify(final));
    for (const row of timeline) {
      if (row.action) { console.log(`  +${String(row.at).padStart(5)}s >>> ${row.action}`); continue; }
      console.log(`  +${String(row.at).padStart(5)}s ad=${row.ad ? 1 : 0} ssap=${row.stitched ? 1 : 0} t=${row.t} paused=${row.paused} ready=${row.ready} muted=${row.muted} res=${row.res} keys=[${row.adKeys}] play=${row.playability}${row.playlist ? ' list=' + row.playlist.slice(0, 10) : ''} enf=${row.enforcement ? 1 : 0} consent=${row.consent ? 1 : 0} quiet=${row.quiet ? `${row.quiet.pruned}/${row.quiet.skipped}/${row.quiet.dialogs}/r${row.quiet.reloads}/s${row.quiet.shaped || 0}` : 'none'} v=${row.url.split('v=')[1] || ''}${row.adText ? ' adText=' + JSON.stringify(row.adText) : ''}${row.error ? ' error=' + JSON.stringify(row.error) : ''}`);
    }
    if (errors.length) console.log('page errors:', errors.slice(0, 8));
    await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => console.log('  (tab was already closed)'));
  }
  await fs.writeFile(path.join(outDir, `live-${off ? 'off' : 'on'}.json`), JSON.stringify(report, null, 2));
} finally {
  cdp.close();
}
