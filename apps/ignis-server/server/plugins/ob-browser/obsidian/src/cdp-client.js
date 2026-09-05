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

  // Subscribe to the channel once (idempotent). Registers frame + status + frame_shard handlers.
  _ensureChannel() {
    if (this._chan) return this._chan;
    this._chan = this.ws.channel(CHANNEL);
    this._chan.subscribe("frame", (msg) => {
      if (this._frameHandler) this._frameHandler(msg);
    });
    this._chan.subscribe("frame_shard", (msg) => this._onFrameShard(msg));
    this._chan.subscribe("status", (msg) => {
      if (this._statusHandler) this._statusHandler(msg);
    });
    return this._chan;
  }

  // P6: recombine frame_shard messages (server shards a large frame into <=16KB chunks) into a
  // single logical frame and hand it to the frame handler as a normal {type:"frame"} message. Each
  // shard carries {data.frame: {frame_id, chunk_index, chunk_total, metadata, chunk}}. A shard whose
  // total==1 is already the whole frame (tiny frame) — pass straight through. A frame_id resolves the
  // partial buffer; on timeout (missing shards) drop it and let HTTP polling recover. The HTTP polling
  // fallback remains the safety net for a dropped/partial shard set.
  _onFrameShard(msg) {
    const frame = (msg && msg.data && msg.data.frame) || null;
    if (!frame || !frame.chunk) return;
    const total = frame.chunk_total || 1;
    const idx = frame.chunk_index || 0;
    if (total <= 1) {
      // Single-shard frame: rebuild full and dispatch.
      if (this._frameHandler) this._frameHandler({ data: { frame: { data: frame.chunk, metadata: frame.metadata || {} } } });
      return;
    }
    const id = frame.frame_id;
    if (!this._shards) this._shards = {};
    this._shards[id] = this._shards[id] || { chunks: new Array(total), got: 0, metadata: frame.metadata || {}, timer: null };
    const buf = this._shards[id];
    if (!buf.chunks[idx]) { buf.chunks[idx] = frame.chunk; buf.got++; }
    // Arm a timeout: if the shard set is incomplete after 1s, drop it (HTTP polling recovers).
    if (!buf.timer) buf.timer = setTimeout(() => { delete this._shards[id]; }, 1000);
    if (buf.got === total) {
      clearTimeout(buf.timer);
      const data = buf.chunks.join("");
      delete this._shards[id];
      if (this._frameHandler) this._frameHandler({ data: { frame: { data: data, metadata: buf.metadata } } });
    }
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
    // Defensive: ensure a bare domain gets a scheme (sidecar page.goto rejects "www.x.com").
    const u = (url || "").trim();
    const normalized = u && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? "https://" + u : u;
    this._chan.send("navigate", { token: this._token, url: normalized });
  }

  reload() {
    if (!this._chan) return;
    this._chan.send("reload", { token: this._token });
  }

  goBack() { if (this._chan) this._chan.send("history", { token: this._token, op: "back" }); }
  goForward() { if (this._chan) this._chan.send("history", { token: this._token, op: "forward" }); }
}

module.exports = { CdpClient, CHANNEL };