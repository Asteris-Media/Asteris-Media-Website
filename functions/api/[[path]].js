// API do admin do portal Asteris.
// Env necessárias (Pages > Settings > Environment variables / bindings):
//   ASTERIS_KV        -> KV namespace binding
//   ADMIN_PW          -> password de entrada (secret)
//   SESSION_SECRET    -> string aleatória p/ assinar a sessão (secret)
//   CLOUDINARY_CLOUD  -> ex. bv9q81il            (opcional, p/ upload)
//   CLOUDINARY_KEY    -> api key da Cloudinary   (opcional)
//   CLOUDINARY_SECRET -> api secret da Cloudinary (opcional, secret)

const enc = new TextEncoder();
const CT_JSON = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CT_JSON, ...extra } });
}
function b64u(buf) {
  const b = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeToken(secret) {
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 24 * 14 })));
  return payload + "." + (await hmac(secret, payload));
}
async function checkToken(secret, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const [payload, sig] = token.split(".");
  if ((await hmac(secret, payload)) !== sig) return false;
  try {
    const p = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return p.exp > Date.now();
  } catch { return false; }
}
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
const COOKIE = "as_sess";
function setCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`;
}
function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function loadIndex(env) {
  const raw = await env.ASTERIS_KV.get("index");
  return raw ? JSON.parse(raw) : [];
}
async function saveIndex(env, list) {
  await env.ASTERIS_KV.put("index", JSON.stringify(list));
}
function upsertIndex(list, entry) {
  const i = list.findIndex(x => x.code === entry.code);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.unshift(entry);
  return list;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const seg = path ? path.split("/") : [];
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (!env.ASTERIS_KV) return json({ error: "KV não ligado" }, 500);
  const SECRET = env.SESSION_SECRET || "dev-secret-change-me";

  // ---- auth ----
  if (seg[0] === "login" && method === "POST") {
    const { pw } = await request.json().catch(() => ({}));
    if (!env.ADMIN_PW || pw !== env.ADMIN_PW) return json({ error: "Password errada" }, 401);
    const token = await makeToken(SECRET);
    return json({ ok: true }, 200, { "set-cookie": setCookie(token) });
  }
  if (seg[0] === "logout") {
    return json({ ok: true }, 200, { "set-cookie": clearCookie() });
  }

  const authed = await checkToken(SECRET, getCookie(request, COOKIE));
  if (seg[0] === "me") return json({ ok: authed });
  if (!authed) return json({ error: "Sessão inválida" }, 401);

  // ---- páginas ----
  if (seg[0] === "pages") {
    if (!seg[1]) {
      if (method === "GET") return json({ pages: await loadIndex(env) });
      return json({ error: "método" }, 405);
    }
    const code = seg[1].toUpperCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return json({ error: "código inválido" }, 400);
    const key = "page:" + code;

    if (method === "GET") {
      const val = await env.ASTERIS_KV.get(key);
      if (!val) return json({ error: "não existe" }, 404);
      return json({ code, data: JSON.parse(val) });
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "json inválido" }, 400);
      await env.ASTERIS_KV.put(key, JSON.stringify(body));
      const list = upsertIndex(await loadIndex(env), {
        code,
        type: body.type || "galeria",
        cliente: body.cliente || "",
        titulo: body.titulo || "",
        expira: body.expira || "",
        atualizado: new Date().toISOString()
      });
      await saveIndex(env, list);
      return json({ ok: true, code });
    }
    if (method === "DELETE") {
      await env.ASTERIS_KV.delete(key);
      await saveIndex(env, (await loadIndex(env)).filter(x => x.code !== code));
      return json({ ok: true });
    }
    return json({ error: "método" }, 405);
  }

  // ---- upload de ficheiro para R2 ----
  if (seg[0] === "upload" && method === "POST") {
    if (!env.ASTERIS_R2) return json({ error: "R2 não ligado" }, 501);
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    if (!file || typeof file === "string") return json({ error: "sem ficheiro" }, 400);
    const folder = (form.get("folder") || "media").toString().replace(/[^a-z0-9/_-]/gi, "").replace(/^\/+|\/+$/g, "");
    const orig = (file.name || "ficheiro").replace(/[^a-z0-9.\-_]/gi, "-");
    const ext = (orig.match(/\.[a-z0-9]{2,5}$/i) || [""])[0].toLowerCase();
    const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
    const key = `${folder}/${Date.now().toString(36)}-${rand}${ext}`;
    await env.ASTERIS_R2.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" }
    });
    const base = env.R2_PUBLIC_BASE || "";
    return json({ ok: true, key, url: base ? `${base.replace(/\/+$/, "")}/${key}` : `/api/r2/${key}` });
  }

  // ---- servir ficheiro do R2 (fallback se não houver domínio público) ----
  if (seg[0] === "r2" && method === "GET") {
    if (!env.ASTERIS_R2) return json({ error: "R2 não ligado" }, 501);
    const key = seg.slice(1).join("/");
    const obj = await env.ASTERIS_R2.get(key);
    if (!obj) return json({ error: "não existe" }, 404);
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(obj.body, { headers: h });
  }

  return json({ error: "rota desconhecida" }, 404);
}
