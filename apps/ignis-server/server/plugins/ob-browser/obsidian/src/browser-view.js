// browser-view.js — Obsidian ItemView holding the native-feel cloud browser shell + CDP canvas.
// Native shell: address bar, back/forward, reload, status bar, loading state. Each Tab is a native leaf.
// Kernel: the canvas renders base64-jpeg frames from the WP session service via the ignis WS channel.
const { ItemView } = require("obsidian");
const { CdpClient } = require("./cdp-client");

const VIEW_TYPE_BROWSER = "ignis-ob-browser";

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

    // Kick off a session with the current address (or default blank).
    const initial = (this.addressEl && this.addressEl.value) || "";
    this.client.open(initial).catch((e) => this._setStatus("init: " + e.message));

    // Defer to next microtask so channel subs are registered server-side after WS open.
    setTimeout(() => {
      if (initial) this.client.navigate(initial);
    }, 0);
  }

  async onClose() {
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
    reload.onclick = () => { const u = this.addressEl.value; this.client.navigate(u); };

    this.addressEl = this.navigationEl.createEl("input", {
      type: "text", cls: "ob-browser-address", placeholder: "https://channels.weixin.qq.com",
    });
    this.addressEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const u = this.addressEl.value.trim();
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
    const frame = msg.data || msg.frame;
    if (!frame || !frame.data) return;
    const meta = frame.metadata || {};
    this._loadedMedia = {
      width: meta.deviceWidth || 0,
      height: meta.deviceHeight || 0,
      pageScaleFactor: meta.pageScaleFactor || 1,
    };
    const img = new Image();
    img.onload = () => {
      const ctx = this.canvasEl.getContext("2d");
      ctx.drawImage(img, 0, 0, this.canvasEl.width, this.canvasEl.height);
    };
    img.src = "data:image/jpeg;base64," + frame.data;
    this._setStatus("live " + img.width + "x" + img.height);
  }

  _onStatus(msg) {
    if (msg && msg.text) this._setStatus(msg.text);
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
      send("keyboard", { type: "keyDown", key: ev.key, code: ev.code, modifiers: (ev.ctrlKey?1:0)|(ev.shiftKey?2:0)|(ev.altKey?4:0) });
    });
    this.canvasEl.addEventListener("keyup", (ev) => {
      send("keyboard", { type: "keyUp", key: ev.key, code: ev.code, modifiers: (ev.ctrlKey?1:0)|(ev.shiftKey?2:0)|(ev.altKey?4:0) });
    });
  }
}

module.exports = { ObBrowserView, VIEW_TYPE_BROWSER };
