// routes.js — mounted under /api/ext/ob-browser/ (gate 前置验 OIDC + 注入 x-forwarded-user on HTTP).
module.exports = (router, plugin, auth) => {
  const { mintToken } = auth;

  // Mint a short-lived token binding (user, vault). gate injects x-forwarded-user on HTTP,
  // so req.headers["x-forwarded-user"] is the authenticated identity. WS identity rides this token.
  router.get("/session", (req, res) => {
    const user = req.headers["x-forwarded-user"] || req.query.user || "anonymous";
    const vault = req.query.vault;
    if (!vault) return res.status(400).json({ error: "vault required" });
    const token = mintToken(user, vault);
    plugin._ctx.log("ob-browser: minted token for " + user + " vault=" + vault);
    res.json({ token, ttl: 5 * 60e3, vault, user });
  });

  // Latest-frame poll endpoint. tenant.js anchors req.query.vault to the caller's own
  // vault, so a caller only ever polls its own session's frame. no-store: always fresh.
  router.get("/frame", (req, res) => {
    const vault = req.query.vault;
    const frame = plugin.latestFrameFor ? plugin.latestFrameFor(vault) : null;
    res.set("Cache-Control", "no-store");
    if (!frame) return res.status(204).end();
    res.json(frame);
  });

  router.get("/status", (req, res) => {
    res.json({ ok: true, sessions: plugin._relay ? plugin._relay.sessions.size : 0 });
  });

  router.post("/session/close", (req, res) => {
    const vault = req.body && req.body.vault;
    if (vault && plugin._relay) plugin._relay.sessions.delete(vault);
    res.json({ ok: true });
  });
};