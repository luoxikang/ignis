// Tenant layer: per-request identity anchoring for multi-user, single-process mode.
//
// Added downstream (fork of Nystik-gh/ignis, upstream AGPL-3.0-or-later; this file
// keeps that license). Design: AZ-DSK-F-013 — identity comes from the reverse-proxy
// gate's HMAC-signed session cookie (shared SESSION_SECRET). Every request is
// anchored to the tenant's own vault; a missing/foreign identity is refused and
// never defaulted (no cross-tenant fallback). Vault lifecycle (create/rename/
// remove) is admin-only: one directory under VAULT_ROOT = one tenant, provisioned
// by the host-side SOP.

const crypto = require("crypto");
const url = require("url");
const config = require("./config");
// Q1 (AZ-DSK-F-014): ob-browser plugin token (HMAC w/ SESSION_SECRET) as alternative WS identity
// for the WP reverse-dial (no gate cookie). Kept out of the kernel (packages/*) — tenant.js is the fork layer.
const obToken = require("./plugins/ob-browser/ob-token");

const COOKIE_NAME = process.env.TENANT_COOKIE_NAME || "azv2ob_session";
const SECRET = process.env.SESSION_SECRET || "";
const SOURCE_URL =
  process.env.TENANT_SOURCE_URL || "https://github.com/luoxikang/ignis";

// The tenant id doubles as a directory name under VAULT_ROOT — keep it strict.
const SUB_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function parseCookies(header) {
  return Object.fromEntries(
    (header || "")
      .split(";")
      .map((p) => {
        const i = p.indexOf("=");
        return i > 0
          ? [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())]
          : [];
      })
      .filter((e) => e[0]),
  );
}

// Mirrors the gate's signing exactly: base64url(JSON payload) + "." + hex(HMAC-SHA256),
// payload = { sub, exp } with exp in milliseconds (strictly compared, as the gate does).
function verifySessionToken(token) {
  if (!token || !SECRET) {
    return null;
  }

  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }

  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(
    crypto.createHmac("sha256", SECRET).update(token.slice(0, dot)).digest("hex"),
  );

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const d = JSON.parse(Buffer.from(token.slice(0, dot), "base64url").toString());
    return d && typeof d.sub === "string" && d.exp > Date.now() ? d.sub : null;
  } catch {
    return null;
  }
}

function resolveTenant(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const sub = verifySessionToken(token);
  return sub && SUB_PATTERN.test(sub) ? sub : null;
}

function refuse(res) {
  return res.status(403).json({ error: "Forbidden" });
}

function destroyForbidden(socket) {
  if (socket && socket.writable) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
  }
}

// Mounts the HTTP middleware. Call before the API routes are mounted (index.js).
function setupTenant(app) {
  if (!config.tenantMode) {
    return;
  }

  if (!SECRET) {
    console.error("[tenant] SESSION_SECRET missing — refusing to start");
    process.exit(1);
  }

  console.log("[tenant] Tenant mode enabled (source: " + SOURCE_URL + ")");

  // Identity gate: everything below /assets requires a valid signed session cookie.
  // Unauthenticated requests are refused here (the front gate normally 302s first).
  app.use((req, res, next) => {
    const sub = resolveTenant(req);

    if (!sub) {
      return refuse(res);
    }

    req._tenantSub = sub;
    // Authenticated API responses must never enter browser heuristic caches — a
    // cached response from a different deployment era would leak cross-tenant names.
    res.set("Cache-Control", "no-store");
    next();
  });

  // Vault lifecycle is admin-only in tenant mode (one directory = one tenant).
  app.use("/api/vault", (req, res, next) => {
    if (
      req.path === "/create" ||
      req.path === "/rename" ||
      (req.method === "DELETE" && req.path === "/remove")
    ) {
      return refuse(res);
    }

    next();
  });

  // Server-wide surfaces, closed: the CORS proxy has no tenant data path, plugin
  // routes and settings writes are process-global (settings GET stays read-only).
  app.use("/api/proxy", (req, res) => refuse(res));
  // Q1 (AZ-DSK-F-014): allow ob-browser plugin ext routes (identity gated above); refuse other /api/ext.
  app.use("/api/ext", (req, res, next) => {
    if (req.path === "/ob-browser" || req.path.startsWith("/ob-browser/")) {
      req.query.vault = req._tenantSub;
      req.body.vault = req._tenantSub;
      return next();
    }
    return refuse(res);
  });
  app.use("/api/plugins", (req, res, next) => {
    if (req.method === "GET") {
      return res.json([]);
    }

    return refuse(res);
  });
  app.use("/api/settings", (req, res, next) => {
    if (req.method !== "GET") {
      return refuse(res);
    }

    next();
  });

  // Inbound anchoring: force the tenant's own vault id on every addressed route.
  // An explicitly foreign vault id is refused (403) — refusal beats silent rewriting;
  // an absent one is written in, which removes the upstream defaultVaultId fallback
  // (the first directory under VAULT_ROOT can never be reached by omission).
  for (const mount of ["/api/fs", "/api/bootstrap", "/api/vault", "/api/plugins"]) {
    app.use(mount, (req, res, next) => {
      const requested =
        (req.query && req.query.vault) || (req.body && req.body.vault);

      if (requested && requested !== req._tenantSub) {
        return refuse(res);
      }

      if (req.query) {
        req.query.vault = req._tenantSub;
      }

      if (req.body && typeof req.body === "object") {
        req.body.vault = req._tenantSub;
      }

      next();
    });
  }

  // /vault-files/<vault-id>/...: the vault id is the first path segment and the
  // upstream mounts this static handler without any vault validation — verify it.
  app.use("/vault-files", (req, res, next) => {
    const parts = req.path.split("/").filter(Boolean);

    if (parts.length === 0 || parts[0] !== req._tenantSub) {
      return refuse(res);
    }

    next();
  });

  // Outbound: vault lists are process-wide upstream (every directory under
  // VAULT_ROOT, with absolute host paths). Filter to the tenant's own entries and
  // strip the vault root so host paths never leave the process.
  const stripVaultRoot = (p) =>
    typeof p === "string" && p.startsWith(config.vaultRoot + "/")
      ? p.slice(config.vaultRoot.length + 1)
      : p;

  for (const mount of ["/api/fs", "/api/bootstrap", "/api/vault"]) {
    app.use(mount, (req, res, next) => {
      const sub = req._tenantSub;
      const origJson = res.json.bind(res);

      res.json = function (body) {
        // The route handler may pass a SHARED cached object (bootstrap keeps a
        // process-wide entry.response and hands it by reference in non-demo mode).
        // Filter a deep clone — never mutate the cached original in place.
        if (body === null || body === undefined) {
          return origJson(body);
        }

        let view;

        try {
          view = JSON.parse(JSON.stringify(body));
        } catch {
          return origJson(body);
        }

        if (Array.isArray(view)) {
          // /api/vault/list shape: [{ id, name, path }, ...]
          return origJson(
            view
              .filter((e) => e && e.id === sub)
              .map((e) => ({ ...e, path: stripVaultRoot(e.path) })),
          );
        }

        if (view && typeof view === "object") {
          if (Array.isArray(view.vaultList)) {
            view.vaultList = view.vaultList
              .filter((v) => v && v.id === sub)
              .map((v) => ({ ...v, path: stripVaultRoot(v.path) }));
          }

          if (typeof view.path === "string") {
            view.path = stripVaultRoot(view.path);
          }

          if (view.vault && typeof view.vault === "object") {
            if (typeof view.vault.path === "string") {
              view.vault.path = stripVaultRoot(view.vault.path);
            }
          }
        }

        return origJson(view);
      };

      next();
    });
  }

  console.log("[tenant] HTTP middleware mounted");
}

// WebSocket-level anchoring. Called after setupWebSocket (index.js).
// Differences vs demo (demo-ws.js): we verify the gate's signed cookie instead of a
// random session, we write the tenant's own vault id when absent, and ANY foreign
// vault id is refused — not just already-prefixed ones.
function wireTenantWebSocket(server) {
  if (!config.tenantMode) {
    return;
  }

  const allowedOrigins = config.tenantAllowedOrigins;
  const origEmit = server.emit.bind(server);

  server.emit = function (event, req, ...rest) {
    if (event === "upgrade") {
      const socket = rest[0];
      let sub = resolveTenant(req);
      let tokenVault = null;

      // Q1 (AZ-DSK-F-014): WP reverse-dial carries no gate cookie. Accept a plugin-issued
      // ob-browser token (?ob_token=) as the WS identity; anchor to token.user + token.vault.
      if (!sub) {
        const u0 = new url.URL(req.url, "http://localhost");
        const t = u0.searchParams.get("ob_token");
        const info = t && obToken.verify(t);
        if (info) { sub = info.user; tokenVault = info.vault; }
      }

      if (!sub) {
        destroyForbidden(socket);
        return;
      }

      const u = new url.URL(req.url, "http://localhost");
      const requested = u.searchParams.get("vault");

      if (tokenVault) {
        u.searchParams.set("vault", tokenVault);
        req.url = u.pathname + u.search;
      } else if (!requested) {
        u.searchParams.set("vault", sub);
        req.url = u.pathname + u.search;
      } else if (requested !== sub) {
        destroyForbidden(socket);
        return;
      }

      if (allowedOrigins.length > 0 && req.headers.origin) {
        const origin = req.headers.origin;

        if (!allowedOrigins.includes(origin)) {
          // Token-authenticated WS has no browser Origin (server-side dial) — allow it (Q1);
          // cookie-authenticated WS keeps the origin check.
          if (!tokenVault) {
            destroyForbidden(socket);
            return;
          }
        }
      }
    }

    return origEmit(event, req, ...rest);
  };

  console.log("[tenant] WebSocket anchoring wired");
}

module.exports = { setupTenant, wireTenantWebSocket, verifySessionToken, resolveTenant };
