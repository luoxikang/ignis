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

  router.get("/status", (req, res) => {
    res.json({ ok: true, sessions: plugin._relay ? plugin._relay.sessions.size : 0 });
  });

  router.post("/session/close", (req, res) => {
    const vault = req.body && req.body.vault;
    if (vault && plugin._relay) plugin._relay.sessions.delete(vault);
    res.json({ ok: true });
  });
};
