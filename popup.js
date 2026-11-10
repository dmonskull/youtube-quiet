const toggle = document.getElementById('toggle');
const status = document.getElementById('status');
const detail = document.getElementById('detail');
const notice = document.getElementById('notice');
const reload = document.getElementById('reload');
const reset = document.getElementById('reset');
const YOUTUBE_TAB = /^https:\/\/(www\.|m\.|music\.)?youtube(-nocookie)?\.com\//;
let enabled = false;
let youtubeTab = null;

function paint(result) {
  enabled = result.enabled;
  toggle.setAttribute('aria-checked', String(enabled));
  status.textContent = enabled ? 'Filtering enabled' : 'Filtering paused';
  detail.textContent = enabled ? 'Ads filtered on new page loads' : 'Normal playback on new page loads';
  document.getElementById('pruned').textContent = result.stats.pruned.toLocaleString();
  document.getElementById('skipped').textContent = result.stats.skipped.toLocaleString();
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.error) throw new Error(result?.error || 'Extension did not respond');
  return result;
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    paint(await send({ type: 'set-enabled', enabled: !enabled }));
    notice.textContent = 'Setting saved. Reload every open YouTube tab to apply it.';
  } catch (error) {
    notice.textContent = `Could not save: ${error.message}`;
  } finally {
    toggle.disabled = false;
  }
});

reload.addEventListener('click', async () => {
  if (youtubeTab === null) return;
  reload.disabled = true;
  try {
    await chrome.tabs.reload(youtubeTab);
    notice.textContent = 'YouTube is reloading with your current setting.';
  } catch (error) {
    notice.textContent = `Could not reload: ${error.message}`;
  } finally {
    reload.disabled = false;
  }
});

reset.addEventListener('click', async () => {
  try {
    paint(await send({ type: 'reset-stats' }));
  } catch (error) {
    notice.textContent = `Could not reset: ${error.message}`;
  }
});

(async () => {
  document.getElementById('version').textContent = `EXPERIMENTAL · v${chrome.runtime.getManifest().version}`;
  try {
    paint(await send({ type: 'status' }));
    toggle.disabled = false;
  } catch (error) {
    status.textContent = 'Setup needs attention';
    detail.textContent = 'Reload the extension in your browser';
    notice.textContent = error.message;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined && tab.url && YOUTUBE_TAB.test(tab.url)) {
      youtubeTab = tab.id;
      reload.disabled = false;
    } else {
      reload.textContent = 'Open a YouTube tab to reload it';
    }
  } catch {
    reload.textContent = 'Reload YouTube in your browser';
  }
})();
