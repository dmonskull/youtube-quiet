// Minimal Chrome DevTools Protocol client for the test scripts. Needs Node 22+.
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params, message.sessionId);
      }
    });
  }

  static async connect(port) {
    const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    return new CDP(ws);
  }

  on(method, listener) {
    const list = this.listeners.get(method) || [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async eval(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async open(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    if (url !== 'about:blank') await this.send('Page.navigate', { url }, sessionId);
    return { targetId, sessionId };
  }

  async poll(expression, sessionId, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await this.eval(expression, sessionId).catch(() => null);
      if (value) return value;
      await pause(100);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  close() { this.ws.close(); }
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const PORT = Number(process.env.CDP_PORT || 19444);

// The id the browser assigned to the unpacked extension, read from its
// extensions page (the service worker may be asleep, so it cannot be found
// among the targets). Opera loads command-line extensions switched off until
// developer mode is on, so both are turned on here first.
export async function extensionId(cdp, name = 'YouTube Quiet') {
  const page = await cdp.open('chrome://extensions/');
  const find = () => cdp.eval(
    `new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, resolve))
      .then(list => list.find(item => item.name === ${JSON.stringify(name)}))
      .then(item => item ? {
        id: item.id,
        state: item.state,
        problems: [...item.manifestErrors, ...item.runtimeErrors].map(e => e.message).concat(item.installWarnings || [])
      } : null)`,
    page.sessionId
  ).catch(() => null);
  try {
    const end = Date.now() + 10000;
    let found = null;
    while (!found && Date.now() < end) {
      found = await find();
      if (!found) await pause(300);
    }
    if (!found) throw new Error(`Extension "${name}" is not loaded`);
    if (found.state !== 'ENABLED') {
      await cdp.eval(`new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve))`, page.sessionId);
      await cdp.eval(`new Promise(resolve => chrome.management.setEnabled(${JSON.stringify(found.id)}, true, resolve))`, page.sessionId);
      await pause(1000);
      found = await find();
      if (!found || found.state !== 'ENABLED') throw new Error(`Extension "${name}" is ${found?.state}`);
    }
    if (found.problems.length) console.warn('extension problems:', found.problems);
    return found.id;
  } finally {
    await cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
}
