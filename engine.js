// YouTube Quiet engine. Runs in the page's own JavaScript world at document_start.
//
// How YouTube delivers ads, and what this does about each part:
//
//   1. The player response lists the ads to play. Those lists are removed
//      before the player reads them (embedded copy, fetch and XHR copies).
//   2. Removing the list is not enough for pre-rolls: YouTube's video servers
//      know one was due and hold the stream back for about the ad's length.
//      Player requests are therefore sent marked as an idle session, which is
//      not held back, and a stream that was already held is requested again.
//   3. If an ad still starts, the video is reloaded through that same request;
//      failing that, the ad is muted and skipped.
(() => {
  'use strict';
  if (window.__ytQuiet) return;

  const state = { version: '0.1.0', pruned: 0, skipped: 0, dialogs: 0, reloads: 0 };
  Object.defineProperty(window, '__ytQuiet', { value: state });

  // Test switch, readable only if set before any page script runs (the test
  // harness does that through DevTools). keepAds leaves the ad lists in place
  // so the fallback in part 3 can be exercised.
  const TEST = window.__ytQuietTest || {};

  // ------------------------------------------------------------ foundations

  // YouTube plants decoys to catch filters: a Request whose visible `url`
  // claims to be the player endpoint while the real one is a data: URL, and a
  // fake response holding `"adPlacements": true` that it re-parses every few
  // seconds. So nothing here trusts what the page shows it. URLs are read
  // through the browser's own getters, and only real ad lists inside a real
  // player response are removed.
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const native = {
    URL,
    Response,
    Blob,
    parse: JSON.parse,
    stringify: JSON.stringify,
    setTimeout: window.setTimeout.bind(window),
    href: getter(URL.prototype, 'href'),
    requestUrl: getter(Request.prototype, 'url'),
    requestClone: Request.prototype.clone,
    requestText: Request.prototype.text,
    requestBytes: Request.prototype.arrayBuffer,
    responseUrl: getter(Response.prototype, 'url'),
    responseText: Response.prototype.text,
    responseBytes: Response.prototype.arrayBuffer,
    xhrUrl: getter(XMLHttpRequest.prototype, 'responseURL'),
    frameWindow: getter(HTMLIFrameElement.prototype, 'contentWindow')
  };

  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];
  const AD_KEY_TEXT = /"(adPlacements|adSlots|playerAds)"(\s*:\s*\[)/g;
  const PREROLL_MARK = 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT';
  const HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubekids\.com)$/;
  const API_PATH = /^\/youtubei\/v1\/(?:player|get_watch|reel\/reel_watch_sequence|navigation\/resolve_url)$/;

  function report(kind, count = 1) {
    state[kind] += count;
    try {
      document.dispatchEvent(new CustomEvent('ytq-count', { detail: `${kind}:${count}` }));
    } catch { /* counting is best effort */ }
  }

  // Does this URL return a player response?
  function isPlayerUrl(raw) {
    if (typeof raw !== 'string' || raw === '') return false;
    let url;
    try { url = new native.URL(raw, location.href); } catch { return false; }
    if (url.protocol !== 'https:' || !HOSTS.test(url.hostname)) return false;
    if (API_PATH.test(url.pathname)) return true;
    if (url.pathname === '/playlist') return url.searchParams.has('list');
    if (url.pathname === '/watch') return url.searchParams.has('pbj');
    return false;
  }

  // The URL fetch() will really use for this argument, or null if unsure.
  function trueRequestUrl(input) {
    if (typeof input === 'string') return input;
    try { return native.requestUrl.call(input); } catch { /* not a Request */ }
    try { return native.href.call(input); } catch { /* not a URL */ }
    return null;
  }

  function isPlayerResponse(node) {
    return Boolean(node) && typeof node === 'object' && !Array.isArray(node) &&
      (typeof node.playabilityStatus === 'object' || typeof node.streamingData === 'object' || typeof node.videoDetails === 'object');
  }

  // --------------------------------------------- part 1: remove the ad lists

  function strip(node) {
    let removed = 0;
    if (TEST.keepAds || !isPlayerResponse(node)) return removed;
    for (const key of AD_KEYS) {
      if (Array.isArray(node[key])) {
        delete node[key];
        removed++;
      }
    }
    return removed;
  }

  function stripShortsAds(holder) {
    const entries = holder && holder.entries;
    if (TEST.keepAds || !Array.isArray(entries)) return 0;
    let removed = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.command?.reelWatchEndpoint?.adClientParams?.isAd === true) {
        entries.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  // Remove ad scheduling from a parsed response, wherever YouTube nests it.
  function prune(data) {
    if (!data || typeof data !== 'object') return 0;
    let removed = 0;
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      removed += strip(item);
      removed += strip(item.playerResponse);
    };
    if (Array.isArray(data)) {
      // Only the short arrays YouTube sends for page navigations.
      if (data.length <= 16) data.forEach(visit);
    } else {
      visit(data);
      removed += strip(data.endpoint?.watchEndpoint?.unserializedPrefetchData?.playerResponse);
      removed += stripShortsAds(data);
      removed += stripShortsAds(data.reelWatchSequenceResponse);
    }
    if (removed) report('pruned');
    return removed;
  }

  // Same job on the raw text of a response already known to come from a
  // player URL: rename the ad lists so the player never finds them.
  function pruneText(text) {
    if (TEST.keepAds || typeof text !== 'string') return null;
    AD_KEY_TEXT.lastIndex = 0;
    if (!AD_KEY_TEXT.test(text)) return null;
    report('pruned');
    return text.replace(AD_KEY_TEXT, '"no_$1"$2');
  }

  const cameFromPlayerUrl = response => {
    try { return isPlayerUrl(native.responseUrl.call(response)); } catch { return false; }
  };

  async function rewriteResponse(response) {
    try {
      if (!cameFromPlayerUrl(response) || !response.ok || response.bodyUsed) return response;
      const fixed = pruneText(await native.responseText.call(response.clone()));
      if (fixed === null) return response;
      const copy = new native.Response(fixed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
      for (const key of ['url', 'type', 'redirected']) {
        Object.defineProperty(copy, key, { value: response[key] });
      }
      return copy;
    } catch {
      return response;
    }
  }

  // ------------------------------------- part 2: ask for an unheld stream

  // Player parameter and idle time that together mark the session as idle.
  // Either one alone is not enough (measured: the stream is still held).
  const IDLE_PARAM = '8AUB';

  function shapePlayerBody(text) {
    if (typeof text !== 'string' || text.length > 400000 || text[0] !== '{') return null;
    const data = native.parse(text);
    const request = data && typeof data.playerRequest === 'object' && data.playerRequest ? data.playerRequest : data;
    const playback = request && request.playbackContext && request.playbackContext.contentPlaybackContext;
    if (!playback || typeof playback !== 'object' || typeof request.videoId !== 'string') return null;
    const params = typeof request.params === 'string' ? request.params : '';
    // Player params are a protobuf message; prepending a field merges it in.
    if (!params.startsWith(IDLE_PARAM)) request.params = IDLE_PARAM + params;
    playback.lactMilliseconds = String(Date.now());
    state.shaped = (state.shaped || 0) + 1;
    return native.stringify(data);
  }

  const recode = (data, Stream, format) =>
    new native.Response(new native.Blob([data]).stream().pipeThrough(new Stream(format)));

  // The fetch arguments to really send: the same ones, or a copy whose body
  // carries the idle marking. YouTube gzips the body, so it is unpacked first.
  async function shapeArgs(win, args) {
    try {
      const [input, init] = args;
      if (init && typeof init.body === 'string') {
        const shaped = shapePlayerBody(init.body);
        return shaped === null ? args : [input, { ...init, body: shaped }];
      }
      if (init && init.body != null) return args;
      let isRequest = false;
      try { native.requestUrl.call(input); isRequest = true; } catch { /* a string or URL without a body */ }
      if (!isRequest || input.bodyUsed || input.method !== 'POST') return args;
      const copy = native.requestClone.call(input);
      const encoding = (copy.headers.get('content-encoding') || '').toLowerCase();
      let text;
      if (!encoding) {
        text = await native.requestText.call(copy);
      } else if (encoding === 'gzip' || encoding === 'deflate') {
        text = await native.responseText.call(recode(await native.requestBytes.call(copy), DecompressionStream, encoding));
      } else {
        return args;
      }
      const shaped = shapePlayerBody(text);
      if (shaped === null) return args;
      const body = encoding ? await native.responseBytes.call(recode(shaped, CompressionStream, encoding)) : shaped;
      return [new win.Request(input, { body }), init];
    } catch {
      return args;
    }
  }

  // --------------------------------------------------------------- hooking

  // www.youtube.com probes JSON.parse directly, and parsed text carries no
  // origin to verify, so that hook is only used on the other YouTube hosts,
  // where the player response can arrive as an embedded string.
  const HOOK_JSON_PARSE = location.hostname !== 'www.youtube.com';
  const hooked = new WeakSet();

  // Install the filters in one JavaScript realm (the page, or a same-origin
  // frame the page could borrow untouched functions from).
  function hookRealm(win) {
    try {
      if (!win || hooked.has(win) || typeof win.fetch !== 'function') return;
      hooked.add(win);
    } catch {
      return; // cross-origin frame
    }

    win.fetch = new Proxy(win.fetch, {
      apply(target, self, args) {
        let ours = false;
        try { ours = isPlayerUrl(trueRequestUrl(args[0])); } catch { /* not ours */ }
        if (!ours) return Reflect.apply(target, self, args);
        return shapeArgs(win, args)
          .then(shaped => Reflect.apply(target, self, shaped))
          .then(rewriteResponse);
      }
    });

    // If the page reaches a response some other way, its readers still filter.
    const responseProto = win.Response.prototype;
    responseProto.json = new Proxy(responseProto.json, {
      apply(target, self, args) {
        const pending = Reflect.apply(target, self, args);
        if (!cameFromPlayerUrl(self)) return pending;
        return pending.then(data => {
          try { prune(data); } catch { /* leave the data as it came */ }
          return data;
        });
      }
    });
    responseProto.text = new Proxy(responseProto.text, {
      apply(target, self, args) {
        const pending = Reflect.apply(target, self, args);
        if (!cameFromPlayerUrl(self)) return pending;
        return pending.then(text => pruneText(text) ?? text);
      }
    });

    if (HOOK_JSON_PARSE) {
      win.JSON.parse = new Proxy(win.JSON.parse, {
        apply(target, self, args) {
          const data = Reflect.apply(target, self, args);
          try { prune(data); } catch { /* leave the data as it came */ }
          return data;
        }
      });
    }

    const xhrProto = win.XMLHttpRequest.prototype;
    const cache = new WeakMap();
    const fromPlayerUrl = xhr => {
      try { return xhr.readyState === 4 && isPlayerUrl(native.xhrUrl.call(xhr)); } catch { return false; }
    };
    for (const name of ['responseText', 'response']) {
      const original = Object.getOwnPropertyDescriptor(xhrProto, name);
      Object.defineProperty(xhrProto, name, {
        configurable: true,
        enumerable: original.enumerable,
        get() {
          const value = original.get.call(this);
          try {
            if (typeof value === 'string') {
              if (!fromPlayerUrl(this)) return value;
              const hit = cache.get(this);
              if (hit && hit.raw === value) return hit.fixed;
              const fixed = pruneText(value) ?? value;
              cache.set(this, { raw: value, fixed });
              return fixed;
            }
            if (value && typeof value === 'object' && this.responseType === 'json' && fromPlayerUrl(this)) prune(value);
          } catch { /* fall through with the untouched value */ }
          return value;
        }
      });
    }
  }

  hookRealm(window);

  // The page can pull pristine functions out of a blank same-origin iframe.
  // Filter such a frame when it is attached, and again whenever the page asks
  // for its window.
  const hookFrame = frame => {
    try { hookRealm(native.frameWindow.call(frame)); } catch { /* cross-origin or detached */ }
  };
  for (const name of ['contentWindow', 'contentDocument']) {
    const original = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, name);
    Object.defineProperty(HTMLIFrameElement.prototype, name, {
      configurable: true,
      enumerable: original.enumerable,
      get() {
        hookFrame(this);
        return original.get.call(this);
      }
    });
  }
  for (const name of ['appendChild', 'insertBefore']) {
    Node.prototype[name] = new Proxy(Node.prototype[name], {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args);
        try {
          if (args[0] && args[0].localName === 'iframe') hookFrame(args[0]);
        } catch { /* nothing to hook */ }
        return result;
      }
    });
  }

  // The first player response is embedded in the page HTML, not fetched, so
  // the request that produced it could not be shaped. Remember whether it had
  // a pre-roll due: if so its stream is being held, and the watchdog asks the
  // player to load the video again, which goes through the shaped request.
  const embedded = { videoId: null, held: false, at: 0 };

  function hasPreroll(node) {
    try {
      return isPlayerResponse(node) && Array.isArray(node.adSlots) &&
        native.stringify(node.adSlots).includes(PREROLL_MARK);
    } catch {
      return false;
    }
  }

  function guardGlobal(name) {
    try {
      let stored = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() { return stored; },
        set(value) {
          try {
            const held = hasPreroll(value);
            if (prune(value)) {
              embedded.videoId = value.videoDetails?.videoId || null;
              embedded.held = held;
              embedded.at = Date.now();
            }
          } catch { /* store it unchanged */ }
          stored = value;
        }
      });
    } catch { /* the page already locked this name */ }
  }
  guardGlobal('ytInitialPlayerResponse');

  // With no ad to show, the player can also park playback behind a 17 second
  // timer. Shorten exactly that timer; every other timer is left alone.
  const PENALTY_DELAY = 17000;
  const describe = Function.prototype.toString;
  window.setTimeout = new Proxy(window.setTimeout, {
    apply(target, self, args) {
      try {
        if (args[1] === PENALTY_DELAY && typeof args[0] === 'function' &&
            describe.call(args[0]).includes('[native code]')) {
          args[1] = 17;
        }
      } catch { /* keep the original delay */ }
      return Reflect.apply(target, self, args);
    }
  });

  // ------------------------------------------------- part 3: the watchdog

  const SKIP_BUTTONS = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button';
  const MAX_RELOADS_PER_VIDEO = 2;
  const reloads = new Map();
  const content = { videoId: null, time: 0 };
  const ad = { active: false, restoreMuted: false, lastJump: 0, reloadedAt: 0 };

  function findPlayer() {
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  // The video the page is on, taken from the address rather than the player,
  // which reports the ad's own id while an ad plays.
  function pageVideoId() {
    try {
      const url = new native.URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const match = /^\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(url.pathname);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function startSeconds(player) {
    try {
      const fromPlayer = Number(player.getPlayerResponse?.()?.playerConfig?.playbackStartConfig?.startSeconds);
      if (fromPlayer > 0) return fromPlayer;
      const raw = new native.URL(location.href).searchParams.get('t') || '';
      if (/^\d+$/.test(raw)) return Number(raw);
      const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
      if (parts && raw) return (Number(parts[1]) || 0) * 3600 + (Number(parts[2]) || 0) * 60 + (Number(parts[3]) || 0);
    } catch { /* start from the beginning */ }
    return 0;
  }

  // Ask the player for this video again. The new request is shaped, so the
  // stream it gets back is neither held nor preceded by an ad.
  function reload(player, videoId, seconds) {
    const count = reloads.get(videoId) || 0;
    if (!videoId || count >= MAX_RELOADS_PER_VIDEO || typeof player.loadVideoById !== 'function') return false;
    reloads.set(videoId, count + 1);
    report('reloads');
    player.loadVideoById({ videoId, startSeconds: Math.max(0, Math.floor(seconds || 0)) });
    return true;
  }

  // Swap a held embedded stream for a freshly requested one.
  function reloadHeldStream(player, video) {
    const id = embedded.videoId;
    if (!id) return;
    const current = typeof player.getVideoData === 'function' ? player.getVideoData()?.video_id : null;
    if (!current) return; // player is still starting up
    if (current !== id) { embedded.videoId = null; return; }
    let held = embedded.held;
    if (!held && Date.now() - embedded.at > 4000) {
      // Not flagged as held, yet nothing has arrived for a while.
      if (video && video.currentTime > 0) { embedded.videoId = null; return; }
      held = player.getPlayerState?.() === 3 && Boolean(video) && video.readyState === 0;
    }
    if (!held) return;
    embedded.videoId = null;
    reload(player, id, startSeconds(player));
  }

  // Ads stitched into the video stream leave no class on the player; the
  // player's own diagnostics are the only tell. Asking is costly, so the
  // answer is reused for a short while.
  const stitchedCheck = { at: 0, result: false };
  function stitchedAdPlaying(player) {
    const now = Date.now();
    if (now - stitchedCheck.at < 400) return stitchedCheck.result;
    stitchedCheck.at = now;
    try {
      const info = player.getStatsForNerds?.()?.debug_info;
      stitchedCheck.result = typeof info === 'string' && info.startsWith('SSAP, AD');
    } catch {
      stitchedCheck.result = false;
    }
    return stitchedCheck.result;
  }

  function watchPlayer(player, video) {
    const classic = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    const stitched = !classic && stitchedAdPlaying(player);

    if (!classic && !stitched) {
      if (ad.active) {
        ad.active = false;
        if (ad.restoreMuted && video) video.muted = false;
        ad.restoreMuted = false;
      }
      // Remember where the viewer is, to come back to after a mid-roll.
      if (video && video.currentTime > 0) {
        content.videoId = pageVideoId();
        content.time = video.currentTime;
      }
      return;
    }

    const now = Date.now();
    if (!ad.active) {
      ad.active = true;
      ad.restoreMuted = video ? !video.muted : false;
      ad.reloadedAt = 0;
      report('skipped');
      if (video) video.muted = true;
      // First choice: leave the ad by loading the video again.
      const id = pageVideoId();
      const resumeAt = id && id === content.videoId ? content.time : startSeconds(player);
      if (reload(player, id, resumeAt)) {
        ad.reloadedAt = now;
        return;
      }
    }
    if (video) video.muted = true;
    // Give a reload a moment to take over before forcing the ad along.
    if (ad.reloadedAt && now - ad.reloadedAt < 2500) return;
    if (now - ad.lastJump > 200) {
      ad.lastJump = now;
      try {
        if (stitched) {
          const progress = player.getProgressState?.();
          if (progress?.duration > 0) player.seekTo?.(progress.duration);
        } else if (video && Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }
      } catch { /* try again on the next pass */ }
      for (const button of player.querySelectorAll(SKIP_BUTTONS)) {
        try { button.click(); } catch { /* button went away */ }
      }
    }
  }

  // "Ad blockers are not allowed" interstitial: close it and carry on playing.
  function clearEnforcement() {
    const message = document.querySelector('ytd-enforcement-message-view-model');
    if (!message) return;
    const dialog = message.closest('tp-yt-paper-dialog') || message;
    dialog.remove();
    document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(node => node.remove());
    report('dialogs');
    const video = findPlayer()?.querySelector('video');
    if (video && video.paused) video.play().catch(() => {});
  }

  function pass() {
    try {
      const player = findPlayer();
      if (player) {
        const video = player.querySelector('video');
        reloadHeldStream(player, video);
        watchPlayer(player, video);
      }
    } catch { /* keep the watchdog alive */ }
    try { clearEnforcement(); } catch { /* keep the watchdog alive */ }
  }

  // YouTube mutates the page constantly; look at most every 50 ms.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    native.setTimeout(() => {
      scheduled = false;
      pass();
    }, 50);
  }

  function startWatchdog() {
    new MutationObserver(schedule).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class']
    });
    setInterval(pass, 500);
    pass();
  }
  if (document.documentElement) startWatchdog();
  else document.addEventListener('readystatechange', startWatchdog, { once: true });
})();
