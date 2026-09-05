// browser-view.js — Obsidian ItemView holding the native-feel cloud browser shell + CDP canvas.
// Native shell: address bar, back/forward, reload, status bar, loading state. Each Tab is a native leaf.
// Kernel: the canvas renders base64-jpeg frames from the WP session service via the ignis WS channel.
const { ItemView } = require("obsidian");
const { CdpClient } = require("./cdp-client");

const VIEW_TYPE_BROWSER = "ignis-ob-browser";

// Windows virtual key codes for non-printable keys (CDP dispatchKeyEvent needs them
// for the page to recognize navigation/scroll keys; charCodeAt is wrong for these).
const VK_MAP = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Space: 32, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46, Insert: 45,
};

// Normalize a user-typed URL: add https:// if the scheme is missing (address bar sends bare
// domains like "www.baidu.com" -> page.goto throws "Cannot navigate to invalid URL").
function normalizeUrl(raw) {
  const u = (raw || "").trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  // skip about:, data:, javascript:, file:, chrome-extension: and other schemes
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return "https://" + u;
}
class ObBrowserView extends ItemView {
  constructor(leaf) {
    super(leaf);
    this.navigationEl = null;
    this.addressEl = null;
    this.canvasEl = null;
    this.statusEl = null;
    this.client = new CdpClient();
    this._loadedMedia = { width: 0, height: 0, pageScaleFactor: 1 };
  }

  getViewType() { return VIEW_TYPE_BROWSER; }
  getDisplayText() { return "Ob Browser"; }
  getIcon() { return "globe"; }

  async onOpen() {
    this._buildShell();
    this._buildCanvas();

    this.client.onFrame((msg) => this._onFrame(msg));
    this.client.onStatus((msg) => this._onStatus(msg));

    // Kick off a session with the current address (or the MVP default: 视频号助手 QR page).
    // Empty address previously meant start url="" -> sidecar never navigated -> blank canvas.
    const initial = (this.addressEl && this.addressEl.value) || "https://channels.weixin.qq.com";
    if (!this.addressEl.value) this.addressEl.value = initial;
    this.client.open(initial).catch((e) => this._setStatus("init: " + e.message));
    // Frames via HTTP polling (works over any path; WS large frames are unreliable
    // on some tunneled client networks). WS remains for input (small messages).
    this.client.startPolling(500);

    // Defer to next microtask so channel subs are registered server-side after WS open.
    setTimeout(() => {
      if (initial) this.client.navigate(initial);
    }, 0);
  }

  async onClose() {
    this.client.stopPolling();
    try { this.client.close(); } catch {}
    this._loadedMedia = { width: 0, height: 0, pageScaleFactor: 1 };
  }

  _buildShell() {
    this.navigationEl = this.contentEl.createDiv({ cls: "ob-browser-navigation" });

    const back = this.navigationEl.createEl("button", { text: "←", cls: "ob-browser-nav-btn" });
    back.setAttr("aria-label", "Back");
    back.onclick = () => this.client.goBack();

    const fwd = this.navigationEl.createEl("button", { text: "→", cls: "ob-browser-nav-btn" });
    fwd.setAttr("aria-label", "Forward");
    fwd.onclick = () => this.client.goForward();

    const reload = this.navigationEl.createEl("button", { text: "⟳", cls: "ob-browser-nav-btn" });
    reload.setAttr("aria-label", "Reload");
    reload.onclick = () => {
      const u = normalizeUrl(this.addressEl.value);
      if (u) this.client.navigate(u); else this.client.reload();
    };

    this.addressEl = this.navigationEl.createEl("input", {
      type: "text", cls: "ob-browser-address", placeholder: "https://channels.weixin.qq.com",
    });
    this.addressEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const u = normalizeUrl(this.addressEl.value);
        if (u) this.client.navigate(u);
      }
    });
  }

  _buildCanvas() {
    this.canvasEl = this.contentEl.createEl("canvas", { cls: "ob-browser-canvas" });
    this.canvasEl.setAttr("tabindex", "0");
    this._wireInput();
    this.statusEl = this.contentEl.createDiv({ cls: "ob-browser-status" });
    this._setStatus("idle");
  }

  // Renders a frame. metadata: { deviceWidth, deviceHeight, pageScaleFactor, offsetTop, offsetBottom }.
  // Mapping: scale = cssWidth / deviceWidth; pageScaleFactor handles DPR for input coords.
  _onFrame(msg) {
    // Relay wraps payload as data:{token, session, frame:{...}}; also accept a bare frame.
    const frame = (msg.data && msg.data.frame) || msg.data || msg.frame;
    if (!frame || !frame.data) return;
    const meta = frame.metadata || {};
    this._loadedMedia = {
      width: meta.deviceWidth || 0,
      height: meta.deviceHeight || 0,
      pageScaleFactor: meta.pageScaleFactor || 1,
    };
    const img = new Image();
    img.onload = () => {
      // Size the canvas backing store 1:1 to the frame pixels (default is 300x150,
      // which CSS then stretches -> double blur). Draw 1:1; CSS scales for display.
      if (this.canvasEl.width !== img.naturalWidth || this.canvasEl.height !== img.naturalHeight) {
        this.canvasEl.width = img.naturalWidth || (meta.deviceWidth || 1280);
        this.canvasEl.height = img.naturalHeight || (meta.deviceHeight || 800);
      }
      const ctx = this.canvasEl.getContext("2d");
      ctx.drawImage(img, 0, 0);
    };
    img.src = "data:image/jpeg;base64," + frame.data;
    this._setStatus("live " + (meta.deviceWidth || "?") + "x" + (meta.deviceHeight || "?"));
  }

  _onStatus(msg) {
    const t = (msg && msg.data && msg.data.text) || (msg && msg.text);
    if (t) this._setStatus(t);
  }

  _setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text || "");
  }

  // Normalize browser coords to device space following KH-4 pageScaleFactor mapping.
  _toDeviceCoords(ev) {
    const rect = this.canvasEl.getBoundingClientRect();
    const scaleX = this._loadedMedia.width / rect.width || 1;
    const scaleY = this._loadedMedia.height / rect.height || 1;
    const dpr = this._loadedMedia.pageScaleFactor || 1;
    return {
      x: Math.round((ev.offsetX) * scaleX * dpr),
      y: Math.round((ev.offsetY) * scaleY * dpr),
    };
  }

  _wireInput() {
    const send = (type, data) => this.client.sendInput(type, data);
    this.canvasEl.addEventListener("mousedown", (ev) => {
      const c = this._toDeviceCoords(ev);
      send("mouse", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
    });
    this.canvasEl.addEventListener("mouseup", (ev) => {
      const c = this._toDeviceCoords(ev);
      send("mouse", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
    });
    this.canvasEl.addEventListener("mousemove", (ev) => {
      if (ev.buttons === 0) return;
      const c = this._toDeviceCoords(ev);
      send("mouse", { type: "mouseMoved", x: c.x, y: c.y, button: "left" });
    });
    this.canvasEl.addEventListener("wheel", (ev) => {
      const c = this._toDeviceCoords(ev);
      send("mouse", { type: "mouseWheel", x: c.x, y: c.y, deltaX: ev.deltaX, deltaY: ev.deltaY });
      ev.preventDefault();
    });
    this.canvasEl.addEventListener("keydown", (ev) => {
      send("keyboard", { type: "keyDown", key: ev.key, code: ev.code, vk: VK_MAP[ev.key], modifiers: (ev.ctrlKey?1:0)|(ev.shiftKey?2:0)|(ev.altKey?4:0) });
      if (["ArrowUp","ArrowDown","PageUp","PageDown"," ","Home","End"].indexOf(ev.key) >= 0) ev.preventDefault();
    });
    this.canvasEl.addEventListener("keyup", (ev) => {
      send("keyboard", { type: "keyUp", key: ev.key, code: ev.code, vk: VK_MAP[ev.key], modifiers: (ev.ctrlKey?1:0)|(ev.shiftKey?2:0)|(ev.altKey?4:0) });
    });
  }
}

module.exports = { ObBrowserView, VIEW_TYPE_BROWSER };