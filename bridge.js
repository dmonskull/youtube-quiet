// Runs in the extension's isolated world. The engine cannot reach extension
// APIs from the page, so it announces what it did with DOM events and this
// script forwards the totals.
(() => {
  const KINDS = new Set(['pruned', 'skipped', 'dialogs']);
  let pending = {};
  let timer = null;

  function flush() {
    timer = null;
    const counts = pending;
    pending = {};
    try {
      chrome.runtime.sendMessage({ type: 'count', counts }).catch(() => {});
    } catch { /* extension was reloaded; this page needs a refresh */ }
  }

  document.addEventListener('ytq-count', event => {
    const [kind, amount] = String(event.detail).split(':');
    const count = Number(amount);
    if (!KINDS.has(kind) || !Number.isInteger(count) || count < 1 || count > 50) return;
    pending[kind] = (pending[kind] || 0) + count;
    if (timer === null) timer = setTimeout(flush, 1000);
  });
})();
