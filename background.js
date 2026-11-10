const MATCHES = [
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://music.youtube.com/*',
  'https://www.youtube-nocookie.com/*'
];
const SCRIPTS = [
  // Response filtering has to live in the page's own world, before any page script.
  { id: 'youtube-quiet-engine', js: ['engine.js'], world: 'MAIN' },
  // Hides leftover ad slots and relays counts back to the extension.
  { id: 'youtube-quiet-page', js: ['bridge.js'], css: ['cosmetic.css'], world: 'ISOLATED' }
];
const RULESET = 'ad_requests';
const EMPTY_STATS = { pruned: 0, skipped: 0, dialogs: 0 };
let queue = Promise.resolve();

async function applyEnabled(enabled) {
  const ids = SCRIPTS.map(script => script.id);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
  const present = new Set(registered.map(script => script.id));
  if (enabled) {
    const missing = SCRIPTS.filter(script => !present.has(script.id));
    if (missing.length > 0) {
      await chrome.scripting.registerContentScripts(missing.map(script => ({
        ...script,
        matches: MATCHES,
        runAt: 'document_start',
        allFrames: true,
        persistAcrossSessions: true
      })));
    }
  } else if (present.size > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [...present] });
  }
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] }
  );
  await chrome.storage.local.set({ enabled });
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? '#d9483b' : '#5c5557' });
  return status();
}

async function status() {
  const { enabled = true, stats = EMPTY_STATS } = await chrome.storage.local.get(['enabled', 'stats']);
  return { enabled: enabled === true, stats: { ...EMPTY_STATS, ...stats } };
}

function serial(task) {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

function restore() {
  return serial(async () => {
    const { enabled = true } = await chrome.storage.local.get('enabled');
    return applyEnabled(enabled === true);
  });
}

function addCounts(counts) {
  return serial(async () => {
    const { stats = EMPTY_STATS } = await chrome.storage.local.get('stats');
    const next = { ...EMPTY_STATS, ...stats };
    for (const key of Object.keys(EMPTY_STATS)) {
      const value = counts?.[key];
      if (Number.isInteger(value) && value > 0 && value < 1000) next[key] += value;
    }
    await chrome.storage.local.set({ stats: next });
  });
}

chrome.runtime.onInstalled.addListener(() => { restore().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { restore().catch(console.error); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;

  // Counts come from the content script on a YouTube page.
  if (message?.type === 'count') {
    if (sender.tab) addCounts(message.counts).catch(console.error);
    return;
  }

  // Everything else may only come from the extension's own pages.
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  let task;
  if (message?.type === 'status') {
    task = restore();
  } else if (message?.type === 'set-enabled') {
    task = serial(() => {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid setting');
      return applyEnabled(message.enabled);
    });
  } else if (message?.type === 'reset-stats') {
    task = serial(async () => {
      await chrome.storage.local.set({ stats: EMPTY_STATS });
      return status();
    });
  } else {
    return;
  }
  task.then(result => respond(result), error => respond({ error: error.message }));
  return true;
});
