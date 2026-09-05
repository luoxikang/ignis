// cdp-client.js — client-side CDP frame/input relay over the ignis WS channel.
// Protocol (KH-4, F-003): base64-jpeg frames + metadata + input_mouse/keyboard + maxFps/ack pacing.
// Wire: channel "ob-browser"; client -> server types: start/stop/input; server -> client types: frame/status.
// Auth: a short-lived token bound to (user, vault) minted via the server plugin route (gate injects x-forwarded-user).

const CHANNEL = "ob-browser";

function vaultId() {
  // Ignis binds each tab to a vault id; the loader keeps it on window.__currentVaultId.
  return window.__currentVaultId || "";
}

class CdpClient {
  constructor() {
    this._token = null;
    this._session = null;
    this._chan = null;
    this._statusHandler = null;
    this._frameHandler = null;
  }

  get ws() {
    return window.__ignis && window.__ignis.ws;
  }

  // Mint a short-lived session token bound to (user, vault) via the server plugin route.
  async ensureSession() {
    const vault = vaultId();
    if (!vault) throw new Error("ob-browser: no vault id");
    const url = "/api/ext/ob-browser/session?vault=" + encodeURIComponent(vault);
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("ob-browser: session token " + res.status);
    const body = await res.json();
    this._token = body.token;
    return { token: this._token, ttl: body.ttl };
  }

  // Subscribe to the channel once (idempotent). Registers frame + status handlers.
  _ensureChannel() {
    if (this._chan) return this._chan;
    this._chan = this.ws.channel(CHANNEL);
    this._chan.subscribe("frame", (msg) => {
      if (this._frameHandler) this._frameHandler(msg);
    });
    this._chan.subscribe("status", (msg) => {
      if (this._statusHandler) this._statusHandler(msg);
    });
    return this._chan;
  }

  onFrame(h) { this._frameHandler = h; }
  onStatus(h) { this._statusHandler = h; }

  // HTTP polling fallback for frames: WS delivery of large frames is unreliable over
  // some tunneled client paths; a small authenticated HTTP GET works everywhere.
  // The server plugin keeps the latest frame per vault (GET /frame, tenant-anchored).
  startPolling(intervalMs) {
    if (this._pollTimer) return;
    const tick = async () => {
      try {
        const res = await fetch("/api/ext/ob-browser/frame?vault=" + encodeURIComponent(vaultId()), { credentials: "same-origin" });
        if (res.status === 200 && this._frameHandler) {
          const j = await res.json();
          this._frameHandler(j);
        }
      } catch (e) { /* transient network error: next tick retries */ }
    };
    tick();
    this._pollTimer = setInterval(tick, intervalMs || 500);
  }

  stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  // Wait until the ignis WS is connected (onOpen can fire before it is), so subscribe + start
  // are not dropped. This fixes the "onOpen stuck / client not initialized" race on reload.
  _ensureReady() {
    return new Promise((resolve) => {
      let tries = 0;
      const chk = () => {
        if (window.__ignis && window.__ignis.ws && window.__ignis.ws.isOpen()) return resolve();
        if (++tries > 50) return resolve();  // give up after ~10s, still attempt
        setTimeout(chk, 200);
      };
      chk();
    });
  }

  // Open(er) the browser for a session target; the WP session service is told to launch Chrome.
  async open(url) {
    await this._ensureReady();
    await this.ensureSession();
    this._ensureChannel();
    this._chan.send("start", { token: this._token, url: url || "" });
  }

  async close() {
    if (!this._chan) return;
    this._chan.send("stop", { token: this._token });
  }

  // Input injection. normalized coords are in device width/height space (KH-4 mapping).
  sendInput(type, data) {
    if (!this._chan) return;
    this._chan.send("input", { token: this._token, type, data });
  }

  navigate(url) {
    if (!this._chan) return;
    this._chan.send("navigate", { token: this._token, url });
  }

  goBack() { if (this._chan) this._chan.send("history", { token: this._token, op: "back" }); }
  goForward() { if (this._chan) this._chan.send("history", { token: this._token, op: "forward" }); }
}

module.exports = { CdpClient, CHANNEL };