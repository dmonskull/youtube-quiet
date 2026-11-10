// Offline check of every engine layer against a fake YouTube page.
// Start Chrome with test/launch.sh first, then: node test/fixture.mjs
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { CDP, PORT, extensionId, pause } from './cdp.mjs';

const PLAYER_JSON = JSON.stringify({
  videoDetails: { videoId: 'fixture' },
  adPlacements: [{ adPlacementRenderer: {} }],
  adSlots: [{ adSlotRenderer: { slotEntryTrigger: 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT' } }],
  playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
  adBreakHeartbeatParams: 'keep'
});
const SHORTS_JSON = JSON.stringify({
  entries: [
    { command: { reelWatchEndpoint: { videoId: 'a' } } },
    { command: { reelWatchEndpoint: { videoId: 'ad', adClientParams: { isAd: true } } } },
    { command: { reelWatchEndpoint: { videoId: 'b' } } }
  ]
});
const WATCH_JSON = JSON.stringify([{ page: 'watch' }, { playerResponse: JSON.parse(PLAYER_JSON) }]);
// The decoy YouTube uses to catch filters: ad keys that are not ad lists.
const DECOY_JSON = '{"adPlacements":true,"playerAds":true,"playerResponse":{"adPlacements":true,"playerAds":true,"playerConfig":{}},"playerConfig":{}}';
const DECOY_URL = `data:application/json;base64,${Buffer.from(DECOY_JSON).toString('base64')}`;

const PAGE = `<!doctype html><title>YouTube Quiet fixture</title>
<body>
<div id="movie_player" class="html5-video-player"><video></video></div>
<ytd-ad-slot-renderer id="slot">ad</ytd-ad-slot-renderer>
<div id="player-ads">companion</div>
<tp-yt-paper-dialog id="dialog"><ytd-enforcement-message-view-model></ytd-enforcement-message-view-model></tp-yt-paper-dialog>
<script>
var ytInitialPlayerResponse = ${PLAYER_JSON};
const out = window.fixture = { engine: window.__ytQuiet?.version || null, reloadCalls: [] };
const fakePlayer = document.getElementById('movie_player');
fakePlayer.getVideoData = () => ({ video_id: 'fixture' });
fakePlayer.loadVideoById = request => { out.reloadCalls.push(request); };
const keys = o => ['adPlacements', 'adSlots', 'playerAds'].filter(k => o && o[k] !== undefined);
(async () => {
  try {
    out.initial = keys(ytInitialPlayerResponse);
    out.initialKept = ytInitialPlayerResponse.videoDetails?.videoId;

    const viaJson = await fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: '{}' });
    out.fetchUrl = viaJson.url;
    out.fetchJson = keys(await viaJson.json());
    const viaText = JSON.parse(await (await fetch(new Request('/youtubei/v1/player?x=1'))).text());
    out.fetchText = keys(viaText);
    out.fetchKept = viaText.adBreakHeartbeatParams;

    out.xhrText = await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/youtubei/v1/player?x=2');
      xhr.onload = () => resolve(keys(JSON.parse(xhr.responseText)));
      xhr.send('{}');
    });
    out.xhrJson = await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/youtubei/v1/player?x=3');
      xhr.responseType = 'json';
      xhr.onload = () => resolve(keys(xhr.response));
      xhr.send('{}');
    });

    const watch = await (await fetch('/youtubei/v1/get_watch?prettyPrint=false')).json();
    out.getWatch = keys(watch[1].playerResponse);

    const shorts = await (await fetch('/youtubei/v1/reel/reel_watch_sequence')).json();
    out.shorts = shorts.entries.map(e => e.command.reelWatchEndpoint.videoId);

    // A page can borrow untouched functions from a blank iframe.
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    out.frameFetch = keys(JSON.parse(await (await frame.contentWindow.fetch('/youtubei/v1/player?x=4')).text()));
    const holder = document.createElement('div');
    holder.innerHTML = '<p><iframe></iframe></p>';
    document.body.append(holder);
    const inner = holder.querySelector('iframe').contentWindow;
    out.nestedFrameFetch = keys(await (await inner.fetch('/youtubei/v1/player?x=5')).json());

    // Player requests leave with the idle marking, plain or gzipped.
    const playerBody = extra => JSON.stringify({ videoId: 'fixture', context: { client: {} }, playbackContext: { contentPlaybackContext: { lactMilliseconds: '5' } }, ...extra });
    await fetch('/youtubei/v1/player?shape=plain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: playerBody({ params: 'abcd' }) });
    const packed = await new Response(new Blob([playerBody({})]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    await fetch(new Request('/youtubei/v1/player?shape=gzip', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: packed }));
    await fetch('/youtubei/v1/player?shape=other', { method: 'POST', body: JSON.stringify({ videoId: 'fixture' }) });

    // Decoys must come back exactly as sent, whichever way they are read.
    const spoofed = new Request(${JSON.stringify(DECOY_URL)});
    Object.defineProperty(spoofed, 'url', { value: location.origin + '/youtubei/v1/player?key=decoy' });
    const decoyResponse = await fetch(spoofed);
    out.decoyFetchText = await decoyResponse.clone().text();
    out.decoyFetchJson = JSON.stringify(await decoyResponse.json());
    out.decoyParse = JSON.stringify(JSON.parse(${JSON.stringify(DECOY_JSON)}));
    out.realShapedParse = keys(JSON.parse(${JSON.stringify(PLAYER_JSON)}));

    // Unrelated requests must come through untouched.
    out.otherText = await (await fetch('/youtubei/v1/browse')).text();

    // The 17 s penalty timer is shortened; an ordinary 17 s timer is not.
    out.penaltyMs = await new Promise(resolve => {
      const start = performance.now();
      setTimeout((() => resolve(Math.round(performance.now() - start))).bind(null), 17000);
      setTimeout(() => resolve(-1), 3000);
    });
    let plainFired = false;
    const plain = setTimeout(() => { plainFired = true; }, 17000);
    await new Promise(r => setTimeout(r, 300));
    out.plainTimerFiredEarly = plainFired;
    clearTimeout(plain);

    // Player watchdog: mute while an ad shows, restore afterwards.
    const player = document.getElementById('movie_player');
    const video = player.querySelector('video');
    video.muted = false;
    player.classList.add('ad-showing');
    await new Promise(r => setTimeout(r, 300));
    out.mutedDuringAd = video.muted;
    player.classList.remove('ad-showing');
    await new Promise(r => setTimeout(r, 300));
    out.mutedAfterAd = video.muted;

    out.dialogRemoved = !document.getElementById('dialog');
    out.slotDisplay = getComputedStyle(document.getElementById('slot')).display;
    out.playerAdsDisplay = getComputedStyle(document.getElementById('player-ads')).display;
    out.counts = window.__ytQuiet ? { ...window.__ytQuiet } : null;
    out.nativeLooking = [fetch, JSON.parse, setTimeout, XMLHttpRequest.prototype.open, Node.prototype.appendChild]
      .every(fn => Function.prototype.toString.call(fn).includes('[native code]'));
  } catch (error) {
    out.error = String(error && error.stack || error);
  }
  out.done = true;
})();
</script>
</body>`;

const cdp = await CDP.connect(PORT);
try {
  const id = await extensionId(cdp);
  const popup = await cdp.open(`chrome-extension://${id}/popup.html`);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const setEnabled = async wanted => {
    if ((await cdp.eval(`document.querySelector('#toggle').getAttribute('aria-checked')`, popup.sessionId)) !== String(wanted)) {
      await cdp.eval(`document.querySelector('#toggle').click()`, popup.sessionId);
    }
    await cdp.poll(`!document.querySelector('#toggle').disabled && document.querySelector('#toggle').getAttribute('aria-checked') === '${wanted}'`, popup.sessionId);
  };
  await setEnabled(true);
  await cdp.eval(`document.querySelector('#reset').click()`, popup.sessionId);

  const page = await cdp.open();
  const blockedByRules = [];
  cdp.on('Network.loadingFailed', (params, sessionId) => {
    if (sessionId === page.sessionId && params.blockedReason) blockedByRules.push(params.blockedReason);
  });
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId === page.sessionId) pageErrors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
  });
  await cdp.send('Network.enable', {}, page.sessionId);
  // YouTube's own service worker would answer the fixture URL with a 404.
  await cdp.send('Network.setBypassServiceWorker', { bypass: true }, page.sessionId);
  const sentBodies = {};
  cdp.on('Fetch.requestPaused', async (params, sessionId) => {
    if (sessionId !== page.sessionId) return;
    const url = params.request.url;
    const shape = /[?&]shape=(\w+)/.exec(url);
    if (shape) {
      const entry = params.request.postDataEntries?.[0]?.bytes;
      let raw = entry ? Buffer.from(entry, 'base64') : Buffer.from(params.request.postData || '');
      const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
      if (gzipped) raw = zlib.gunzipSync(raw);
      sentBodies[shape[1]] = { gzipped, encoding: params.request.headers['Content-Encoding'] || null, body: JSON.parse(raw.toString()) };
    }
    const [type, body] = url.includes('__quiet_fixture') ? ['text/html', PAGE]
      : url.includes('reel_watch_sequence') ? ['application/json', SHORTS_JSON]
      : url.includes('get_watch') ? ['application/json', WATCH_JSON]
      : ['application/json; charset=UTF-8', PLAYER_JSON];
    await cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: type }],
      body: Buffer.from(body).toString('base64')
    }, sessionId).catch(() => {});
  });
  await cdp.send('Fetch.enable', { patterns: [
    { urlPattern: 'https://www.youtube.com/__quiet_fixture*' },
    { urlPattern: 'https://www.youtube.com/youtubei/*' }
  ] }, page.sessionId);

  // ---- filtering on
  await cdp.send('Page.navigate', { url: 'https://www.youtube.com/__quiet_fixture' }, page.sessionId);
  await cdp.poll('window.fixture?.done', page.sessionId, 20000).catch(async error => {
    console.log('page state:', JSON.stringify(await cdp.eval('({ fixture: window.fixture, engine: window.__ytQuiet, title: document.title })', page.sessionId)), pageErrors);
    throw error;
  });
  const on = await cdp.eval('window.fixture', page.sessionId);
  console.log('ON ', JSON.stringify(on, null, 1));
  assert.equal(on.error, undefined);
  assert.equal(on.engine, '0.1.0');
  for (const key of ['initial', 'fetchJson', 'fetchText', 'xhrText', 'xhrJson', 'getWatch', 'frameFetch', 'nestedFrameFetch']) {
    assert.deepEqual(on[key], [], `${key} still has ad keys`);
  }
  assert.equal(on.decoyFetchText, DECOY_JSON, 'decoy fetch text was modified');
  assert.equal(on.decoyFetchJson, DECOY_JSON, 'decoy fetch json was modified');
  assert.equal(on.decoyParse, DECOY_JSON, 'decoy JSON.parse was modified');
  assert.deepEqual(on.realShapedParse, ['adPlacements', 'adSlots', 'playerAds'], 'JSON.parse must stay untouched on www.youtube.com');
  assert.equal(on.initialKept, 'fixture');
  assert.equal(on.fetchKept, 'keep');
  assert.match(on.fetchUrl, /youtubei\/v1\/player/);
  assert.deepEqual(on.shorts, ['a', 'b']);
  assert.equal(on.otherText, PLAYER_JSON, 'unrelated response was modified');
  assert(on.penaltyMs >= 0 && on.penaltyMs < 1000, `penalty timer took ${on.penaltyMs}`);
  assert.equal(on.plainTimerFiredEarly, false);
  assert.equal(on.mutedDuringAd, true);
  assert.equal(on.mutedAfterAd, false);
  assert.equal(on.dialogRemoved, true);
  assert.equal(on.slotDisplay, 'none');
  assert.notEqual(on.playerAdsDisplay, 'none');
  assert.equal(on.nativeLooking, true);
  // One count per filtered response: initial, 2 fetch, 2 XHR, get_watch, shorts,
  // 2 frames, 3 shaping requests.
  assert.deepEqual(on.counts, { version: '0.1.0', pruned: 12, skipped: 1, dialogs: 1, reloads: 1, shaped: 2 });

  // The embedded response had a pre-roll due, so the video was requested again.
  assert.deepEqual(on.reloadCalls, [{ videoId: 'fixture', startSeconds: 0 }]);

  // Outgoing player requests carry the idle marking; other bodies are untouched.
  console.log('SENT', JSON.stringify(sentBodies));
  assert.equal(sentBodies.plain.body.params, '8AUBabcd');
  assert(Number(sentBodies.plain.body.playbackContext.contentPlaybackContext.lactMilliseconds) > 1e12);
  assert.equal(sentBodies.gzip.gzipped, true, 'gzipped request must stay gzipped');
  assert.equal(sentBodies.gzip.body.params, '8AUB');
  assert(Number(sentBodies.gzip.body.playbackContext.contentPlaybackContext.lactMilliseconds) > 1e12);
  assert.deepEqual(sentBodies.other.body, { videoId: 'fixture' });

  // Network rule: an ad request from a YouTube page is blocked.
  await cdp.eval(`fetch('https://googleads.g.doubleclick.net/pagead/id').catch(() => {})`, page.sessionId);
  await pause(500);
  assert(blockedByRules.length > 0, 'doubleclick request was not blocked');

  // Counts reach the popup.
  await pause(1500);
  await cdp.send('Page.reload', {}, popup.sessionId);
  await cdp.poll(`document.querySelector('#toggle')?.disabled === false`, popup.sessionId);
  const shown = await cdp.eval(`[document.querySelector('#pruned').textContent, document.querySelector('#skipped').textContent]`, popup.sessionId);
  assert.deepEqual(shown, ['12', '1'], `popup shows ${shown}`);

  // ---- other hosts: embedded player responses are parsed from strings
  const MUSIC_PAGE = `<!doctype html><title>fixture</title><script>
    const keys = o => ['adPlacements', 'adSlots', 'playerAds'].filter(k => o && o[k] !== undefined);
    window.fixture = {
      embedded: keys(JSON.parse(${JSON.stringify(PLAYER_JSON)})),
      nested: keys(JSON.parse(${JSON.stringify(WATCH_JSON)})[1].playerResponse),
      decoy: JSON.stringify(JSON.parse(${JSON.stringify(DECOY_JSON)})),
      done: true
    };
  </` + `script>`;
  const music = await cdp.open();
  cdp.on('Fetch.requestPaused', async (params, sessionId) => {
    if (sessionId !== music.sessionId) return;
    await cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
      body: Buffer.from(MUSIC_PAGE).toString('base64')
    }, sessionId).catch(() => {});
  });
  await cdp.send('Network.enable', {}, music.sessionId);
  await cdp.send('Network.setBypassServiceWorker', { bypass: true }, music.sessionId);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://music.youtube.com/__quiet_fixture*' }] }, music.sessionId);
  await cdp.send('Page.navigate', { url: 'https://music.youtube.com/__quiet_fixture' }, music.sessionId);
  await cdp.poll('window.fixture?.done', music.sessionId, 20000);
  const onMusic = await cdp.eval('window.fixture', music.sessionId);
  console.log('MUSIC', JSON.stringify(onMusic));
  assert.deepEqual(onMusic.embedded, []);
  assert.deepEqual(onMusic.nested, []);
  assert.equal(onMusic.decoy, DECOY_JSON);
  await cdp.send('Target.closeTarget', { targetId: music.targetId });

  // ---- filtering off
  await setEnabled(false);
  await cdp.send('Page.navigate', { url: 'https://www.youtube.com/__quiet_fixture?off' }, page.sessionId);
  await cdp.poll(`window.fixture?.done && location.search === '?off'`, page.sessionId, 20000);
  const off = await cdp.eval('window.fixture', page.sessionId);
  console.log('OFF', JSON.stringify(off, null, 1));
  assert.equal(off.engine, null);
  assert.deepEqual(off.initial, ['adPlacements', 'adSlots', 'playerAds']);
  assert.deepEqual(off.fetchJson, ['adPlacements', 'adSlots', 'playerAds']);
  assert.equal(off.penaltyMs, -1);
  assert.equal(off.dialogRemoved, false);
  assert.notEqual(off.slotDisplay, 'none');

  await setEnabled(true);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  console.log('\nfixture: all checks passed');
} finally {
  cdp.close();
}
