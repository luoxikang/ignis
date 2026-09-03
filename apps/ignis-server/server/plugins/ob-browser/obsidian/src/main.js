// main.js — Ignis virtual plugin entry for Ob Browser.
// Runs in the browser (virtual-plugin-loader evals it). No disk install, no kernel change.
const { Plugin } = require("obsidian");
const { ObBrowserView, VIEW_TYPE_BROWSER } = require("./browser-view");

class ObBrowserPlugin extends Plugin {
  async onload() {
    if (!window.__ignis) {
      console.log("[ignis-ob-browser] Not in Ignis - plugin is a no-op.");
      return;
    }

    this.registerView(VIEW_TYPE_BROWSER, (leaf) => new ObBrowserView(leaf));

    this.addRibbonIcon("globe", "Open browser", () => {
      this.openBrowser();
    });

    this.addCommand({
      id: "open-browser",
      name: "Open embedded browser",
      callback: () => this.openBrowser(),
    });
  }

  async openBrowser() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_BROWSER)[0];
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_BROWSER, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

module.exports = ObBrowserPlugin;
