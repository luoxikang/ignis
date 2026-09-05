// ob-browser — ignis server plugin: relay CDP screencast frames/input between a per-user
// Coder WP browser session service and the Obsidian virtual-plugin canvas, over the ignis WS channel.
// Peripheral (server/plugins/, Docker volume-injected). No kernel (packages/*) change (R6).
//
// Protocol (KH-4, F-003): base64-jpeg frames + metadata; input_mouse/keyboard; maxFps/ack pacing.
// Wire: single ignis WS channel "ob-browser". Direction is disambiguated by the client's type filter:
//   - Obsidian client subscribes to the channel, handles only  frame / status.
//   - WP session service (peer) subscribes to the channel, handles only  start/stop/input/navigate/history.
//   So the server can broadcast both directions to the vault; each side ignores the other's types.
//
// Auth: gate injects x-forwarded-user on HTTP; the /session route mints a short-lived token binding
// (user, vault). WS messages carry the token; the server verifies before relaying. Note the gate's WS
// tunnel (gate.js upgrade) forwards the browser's cookie but NOT x-forwarded-user, so WS identity is
// carried by this token, never trusted from headers.
//
// ⚠️ Q1 open design point (research/01, to be nailed down in T8 联调): the WP session service is in a
// per-user rootless Coder sidecar; HOW it reaches this ignis WS (reverse dial via 10.0.2.2, tunnel,
// per-session token hand-off) is NOT yet verified. The relay below assumes both sides are WS clients on
// the vault's "ob-browser" channel; the WP-side transport is the T8 hard gate.
const path = require("path");
const obToken = require("./ob-token");

const mintToken = obToken.mint;
const verifyToken = obToken.verify;

// Client-handled types (routed to the Obsidian canvas). Server relays these from the WP peer.
const HANDLED = {
  frame: true,   // WP -> client
  status: true,  // WP -> client
};

module.exports = {
  id: "ob-browser",
  name: "Ob Browser",
  description: "Embed a per-user browser (Coder WP session service) in Obsidian via CDP canvas relay",
  version: "0.1.0",
  obsidianPlugin: path.join(__dirname, "obsidian"),
  _ctx: null,
  _relay: null,

  mintToken,
  verifyToken,

  async register(ctx) {
    this._ctx = ctx;
    ctx.log("ob-browser plugin registered");
    const channel = ctx.wss.channel("ob-browser");
    this._relay = { channel, wss: ctx.wss, sessions: new Map() };

    // Relay inbound WS messages: verify token, then fan out to the vault's subscribed peers.
    channel.on("frame", (msg) => this._relayToVault(msg, "frame"));
    channel.on("status", (msg) => this._relayToVault(msg, "status"));
    channel.on("start", (msg) => this._relayToVault(msg, "start"));
    channel.on("stop", (msg) => this._relayToVault(msg, "stop"));
    channel.on("input", (msg) => this._relayToVault(msg, "input"));
    channel.on("navigate", (msg) => this._relayToVault(msg, "navigate"));
    channel.on("history", (msg) => this._relayToVault(msg, "history"));
    // Wire-type aliases: cdp-client's channel.send spreads the payload AFTER the wire type,
    // so sendInput("mouse", {type:"mousePressed",...}) hits the wire as type:"mouse" (and
    // "keyboard" likewise) instead of "input". Accept both spellings and relay as input.
    channel.on("mouse", (msg) => this._relayInput(msg, "mouse"));
    channel.on("keyboard", (msg) => this._relayInput(msg, "keyboard"));
    // Debug/E2E control types (relay preserving type; sidecar handles reload/eval/shot)
    channel.on("reload", (msg) => this._relayToVault(msg, "reload"));
    channel.on("eval", (msg) => this._relayToVault(msg, "eval"));
    channel.on("shot", (msg) => this._relayToVault(msg, "shot"));

    const mountRoutes = require("./routes");
    mountRoutes(ctx.router, this, { mintToken, verifyToken });
  },

  // Input relay for the alias wire types ("mouse"/"keyboard"): the client's message shape is
  // {channel, type:kind, token, data:{...input fields...}} — token at TOP level, not in data.
  // Rebuild the sidecar's expected shape {token, type:kind, data:{...}} and broadcast as "input".
  _relayInput(msg, kind) {
    const data = msg.data || {};
    const info = verifyToken(msg.token || data.token);
    this._ctx.log("ob-browser relay input " + kind + ":" + (data.type || "?") + " token=" + ((msg.token || data.token) ? "y" : "n") + " user=" + (info ? info.user : "x"));
    if (!info) return;
    const payload = { token: msg.token || data.token, type: kind, data };
    this._relay.wss.broadcastToVault(info.vault, { channel: "ob-browser", type: "input", session: info.vault, data: payload });
  },

  // Verify the token bound to (user, vault), then broadcast a typed frame to that vault's channel
  // subscribers. Peers filter by type (client: frame/status; WP: start/stop/input/navigate/history),
  // so a single channel carries both directions without a kernel change.
  _relayToVault(msg, type) {
    // Browser client sends token at the top level ({type, token, url}); WP sidecar sends it in data.
    // Read both so the relay forwards either form.
    const data = msg.data || msg;
    const info = verifyToken(data.token);
    this._ctx.log(`ob-browser relay ${type} token=${data.token ? "y" : "n"} user=${info ? info.user : "x"}`);  // relay debug
    if (!info) return;
    const session = data.session || info.vault;
    const relayed = data.payload ?? data;
    delete relayed.channel; delete relayed.type;  // don't echo transport keys
    // Keep the latest frame per vault for HTTP-polling clients. For frames, do NOT broadcast the
    // raw full frame over WS: a single large WS frame may be silently truncated over a tunneled/
    // 代理 path (>32KB empirical, P6). Instead shard-broadcast (<=FRAME_CHUNK) and let the client
    // recombine; HTTP polling (GET /frame) carries the full frame as the fallback. Non-frame types
    // (status/start/stop/input/navigate/history/reload/eval/shot) are small and broadcast raw.
    if (type === "frame") {
      this._latestFrame = this._latestFrame || new Map();
      this._latestFrame.set(info.vault, { type: "frame", session, data: relayed, ts: Date.now() });
      this._broadcastFrameShards(info.vault, session, relayed);
    } else {
      this._relay.wss.broadcastToVault(info.vault, { channel: "ob-browser", type, session, data: relayed });
    }
  },

  // Shard a frame (data.frame.data is base64-jpeg) into FRAME_CHUNK-sized pieces and broadcast
  // them as an ordered sequence of {type:"frame_shard"} messages. The client recombines by frame_id.
  _broadcastFrameShards(vault, session, relayed) {
    const frame = (relayed && relayed.frame) || relayed;
    const raw = (frame && frame.data) || "";
    const CHUNK = this._FRAME_CHUNK || 16 * 1024;
    const frameId = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    if (!raw) return;
    const meta = frame.metadata || {};
    const total = Math.max(1, Math.ceil(raw.length / CHUNK));
    for (let i = 0; i < total; i++) {
      const chunk = raw.slice(i * CHUNK, (i + 1) * CHUNK);
      const shard = { frame_id: frameId, chunk_index: i, chunk_total: total, metadata: meta, chunk: chunk };
      this._relay.wss.broadcastToVault(vault, {
        channel: "ob-browser",
        type: "frame_shard",
        session,
        data: { token: relayed.token, session, frame: shard },
      });
    }
    this._ctx.log(`ob-browser frame_shard x${total} (${raw.length}B) frame=${frameId}`);
  },

  _FRAME_CHUNK: 16 * 1024,

  // HTTP polling endpoint payload: latest frame for the caller's vault (no WS needed).
  latestFrameFor(vault) {
    return this._latestFrame ? this._latestFrame.get(vault) || null : null;
  },

  async shutdown() {
    if (this._relay) this._relay.sessions.clear();
    this._ctx = null;
  },
};