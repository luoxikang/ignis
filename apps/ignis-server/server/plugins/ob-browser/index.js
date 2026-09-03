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
    this._relay = { channel, sessions: new Map() };

    // Relay inbound WS messages: verify token, then fan out to the vault's subscribed peers.
    channel.on("frame", (msg) => this._relayToVault(msg, "frame"));
    channel.on("status", (msg) => this._relayToVault(msg, "status"));
    channel.on("start", (msg) => this._relayToVault(msg, "start"));
    channel.on("stop", (msg) => this._relayToVault(msg, "stop"));
    channel.on("input", (msg) => this._relayToVault(msg, "input"));
    channel.on("navigate", (msg) => this._relayToVault(msg, "navigate"));
    channel.on("history", (msg) => this._relayToVault(msg, "history"));

    const { mountRoutes } = require("./routes");
    mountRoutes(ctx.router, this, { mintToken, verifyToken });
  },

  // Verify the token bound to (user, vault), then broadcast a typed frame to that vault's channel
  // subscribers. Peers filter by type (client: frame/status; WP: start/stop/input/navigate/history),
  // so a single channel carries both directions without a kernel change.
  _relayToVault(msg, type) {
    const data = msg.data || {};
    const info = verifyToken(data.token);
    if (!info) return;
    const session = data.session || info.vault;
    this._relay.channel.broadcastToVault(info.vault, { type, session, data: data.payload ?? data });
  },

  async shutdown() {
    if (this._relay) this._relay.sessions.clear();
    this._ctx = null;
  },
};