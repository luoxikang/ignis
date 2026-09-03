// ob-token.js — stateless (user, vault) bearer token signed with SESSION_SECRET.
// Shared by the ob-browser plugin (relay) AND tenant.js (WS upgrade identity), so a WP service can
// present a plugin-issued token on the ignis /ws upgrade and be anchored to its own vault (Q1 RFC).
const crypto = require("crypto");
const SECRET = process.env.SESSION_SECRET || "";
const TTL = 12 * 3600e3; // session-length (research/06: up to 12h)

function mint(user, vault) {
  const p = Buffer.from(JSON.stringify({ user, vault, exp: Date.now() + TTL })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(p).digest("hex");
  return p + "." + sig;
}

function verify(t) {
  if (!t || !SECRET) return null;
  const i = t.lastIndexOf(".");
  if (i <= 0) return null;
  const a = Buffer.from(t.slice(i + 1));
  const b = Buffer.from(crypto.createHmac("sha256", SECRET).update(t.slice(0, i)).digest("hex"));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(t.slice(0, i), "base64url").toString());
    if (d.user && d.exp > Date.now()) return d; // { user, vault, exp }
  } catch {}
  return null;
}

module.exports = { mint, verify };
