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

  // ---- servir ficheiro do R2 (PÚBLICO — o cliente descarrega a entrega sem login;
  //      segurança = a chave do objeto é longa e aleatória, tal como o código da página) ----
  if (seg[0] === "r2" && method === "GET") {
    if (!env.ASTERIS_R2) return json({ error: "R2 não ligado" }, 501);
    const key = seg.slice(1).map(decodeURIComponent).join("/");
    const obj = await env.ASTERIS_R2.get(key);
    if (!obj) return json({ error: "não existe" }, 404);
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set("cache-control", "public, max-age=31536000, immutable");
    h.set("access-control-allow-origin", "*");
    const dl = url.searchParams.get("dl");
    if (dl) h.set("content-disposition", `attachment; filename="${dl.replace(/[^a-z0-9.\-_ ]/gi, "_")}"`);
    return new Response(obj.body, { headers: h });
  }

  // ---- página de acesso a uma pasta (PÚBLICA, obscura — o link partilhável da biblioteca) ----
  if (seg[0] === "media" && seg[1] === "view" && method === "GET") {
    const folder = (url.searchParams.get("f") || "").replace(/[^a-z0-9/_-]/gi, "");
    const cloud = url.searchParams.get("c") === "cloudinary" ? "cloudinary" : "r2";
    if (!folder) return new Response("pasta em falta", { status: 400 });
    const isVidU = (s) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(s || "");
    let files = [];
    try {
      if (cloud === "r2" && env.ASTERIS_R2) {
        let cursor;
        do {
          const r = await env.ASTERIS_R2.list({ cursor, prefix: folder + "/", limit: 1000 });
          for (const o of r.objects) files.push({ url: "/api/r2/" + o.key.split("/").map(encodeURIComponent).join("/"), name: o.key.split("/").pop(), bytes: o.size || 0 });
          cursor = r.truncated ? r.cursor : null;
        } while (cursor);
      } else if (cloud === "cloudinary" && env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET) {
        const auth = btoa(`${env.CLOUDINARY_KEY}:${env.CLOUDINARY_SECRET}`);
        for (const rt of ["image", "video"]) {
          const cr = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/resources/${rt}?max_results=500`, { headers: { authorization: `Basic ${auth}` } });
          if (!cr.ok) continue;
          const cj = await cr.json();
          for (const res of (cj.resources || [])) {
            if ((res.asset_folder || res.folder || "") === folder) files.push({ url: res.secure_url, name: (res.public_id.split("/").pop()) + "." + res.format, bytes: res.bytes || 0 });
          }
        }
      }
    } catch (e) { /* ignore */ }
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const title = folder.split("/").pop();
    const grid = files.map((f, i) => {
      const v = isVidU(f.url);
      return `<figure><a href="${esc(f.url)}${f.url.startsWith("/api/r2/") ? "?dl=" + encodeURIComponent(f.name) : ""}" download="${esc(f.name)}">${v
        ? `<video src="${esc(f.url)}" muted preload="metadata"></video>`
        : `<img src="${esc(f.url)}" loading="lazy" alt="">`}<figcaption>${esc(f.name)}</figcaption></a></figure>`;
    }).join("");
    const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} — Asteris</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0B0B0A;color:#F0EAE0;font-family:system-ui,sans-serif;padding:28px clamp(16px,5vw,52px)}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:22px}h1{font-size:20px;font-weight:600}.n{color:#8a857b;font-size:12px}
.dl{margin-left:auto;background:#C9A166;color:#0B0B0A;border:0;padding:11px 20px;border-radius:5px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.04em}
.dl:disabled{opacity:.6}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
figure{background:#151412;border:1px solid #2a2724;border-radius:8px;overflow:hidden}
figure a{color:inherit;text-decoration:none;display:block}
figure img,figure video{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#000}
figcaption{font-size:10px;color:#8a857b;padding:7px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{color:#8a857b;padding:40px;text-align:center}</style></head>
<body><header><h1>${esc(title)}</h1><span class="n">${files.length} ficheiro${files.length === 1 ? "" : "s"}</span>
${files.length ? '<button class="dl" id="dl">Descarregar tudo (.zip)</button>' : ""}</header>
${files.length ? `<div class="g">${grid}</div>` : '<div class="empty">Pasta vazia ou nuvem não ligada.</div>'}
<script>
var FILES=${JSON.stringify(files.map(f => ({ url: f.url, name: f.name })))};
var b=document.getElementById("dl");
if(b) b.onclick=function(){
  b.disabled=true;b.textContent="A preparar…";
  var s=document.createElement("script");
  s.src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  s.onload=function(){
    var zip=new JSZip(),done=0;
    Promise.all(FILES.map(function(f){
      return fetch(f.url).then(function(r){return r.blob();}).then(function(bl){
        zip.file(f.name,bl);done++;b.textContent="A preparar… "+done+"/"+FILES.length;
      }).catch(function(){});
    })).then(function(){
      b.textContent="A comprimir…";
      return zip.generateAsync({type:"blob"});
    }).then(function(blob){
      var u=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=u;a.download=${JSON.stringify(title)}+".zip";a.click();
      setTimeout(function(){URL.revokeObjectURL(u);},4000);
      b.disabled=false;b.textContent="Descarregar tudo (.zip)";
    });
  };
  s.onerror=function(){b.disabled=false;b.textContent="Falhou — tenta ficheiro a ficheiro";};
  document.head.appendChild(s);
};
</script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  const authed = await checkToken(SECRET, getCookie(request, COOKIE));
  if (seg[0] === "me") return json({ ok: authed });
  if (!authed) return json({ error: "Sessão inválida" }, 401);

  // ---- painel de estado / quotas ----
  if (seg[0] === "stats" && method === "GET") {
    const idx = await loadIndex(env);
    const now = Date.now();
    const byType = {};
    const expired = [];
    const soon = [];
    for (const e of idx) {
      byType[e.type || "?"] = (byType[e.type || "?"] || 0) + 1;
      if (e.expira) {
        const t = new Date(e.expira + "T23:59:59").getTime();
        if (t < now) expired.push({ code: e.code, expira: e.expira });
        else if (t - now < 14 * 86400000) soon.push({ code: e.code, expira: e.expira, dias: Math.round((t - now) / 86400000) });
      }
    }
    soon.sort((a, b) => a.dias - b.dias);

    let kvKeys = 0;
    try {
      let cursor, done = false;
      while (!done) {
        const r = await env.ASTERIS_KV.list({ cursor, limit: 1000 });
        kvKeys += r.keys.length;
        cursor = r.cursor; done = r.list_complete;
      }
    } catch { kvKeys = idx.length + 1; }

    const r2 = { bound: !!env.ASTERIS_R2, objects: null, bytes: null, truncated: false };
    if (env.ASTERIS_R2) {
      try {
        let cursor, bytes = 0, count = 0, trunc = false, n = 0;
        do {
          const o = await env.ASTERIS_R2.list({ cursor, limit: 1000 });
          count += o.objects.length;
          bytes += o.objects.reduce((s, x) => s + (x.size || 0), 0);
          cursor = o.truncated ? o.cursor : null;
          trunc = o.truncated; n++;
        } while (cursor && n < 20);
        r2.objects = count; r2.bytes = bytes; r2.truncated = trunc;
      } catch (e) { r2.error = String(e); }
    }

    const cloudinary = { configured: !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET) };
    if (cloudinary.configured) {
      try {
        const auth = btoa(`${env.CLOUDINARY_KEY}:${env.CLOUDINARY_SECRET}`);
        const cr = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/usage`, { headers: { authorization: `Basic ${auth}` } });
        if (cr.ok) {
          const cj = await cr.json();
          cloudinary.plan = cj.plan;
          cloudinary.credits = cj.credits || null;         // { usage, limit, used_percent }
          cloudinary.storageBytes = cj.storage && cj.storage.usage != null ? cj.storage.usage : null;
          cloudinary.bandwidthBytes = cj.bandwidth && cj.bandwidth.usage != null ? cj.bandwidth.usage : null;
          cloudinary.resources = cj.resources != null ? cj.resources : null;
        } else {
          cloudinary.error = "usage " + cr.status;
        }
      } catch (e) { cloudinary.error = String(e).slice(0, 120); }
    }

    return json({
      generated: new Date().toISOString(),
      pages: { total: idx.length, kvKeys, byType, expired, soon },
      r2,
      cloudinary,
      limits: {
        kv: { storageMB: 1024, readsDia: 100000, escritasDia: 1000, apagarDia: 1000 },
        r2: { storageGB: 10, classAmes: 1000000, classBmes: 10000000 },
        pagesBuildsMes: 500,
        cloudinaryCreditosMes: 25
      }
    });
  }

  // ---- biblioteca de media: pastas + ficheiros das duas nuvens ----
  if (seg[0] === "media" && !seg[1] && method === "GET") {
    const isVidExt = (s) => /\.(mp4|webm|mov|m4v)$/i.test(s || "");
    const out = { r2: { bound: !!env.ASTERIS_R2, folders: [] }, cloudinary: { configured: !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET), folders: [] } };

    if (env.ASTERIS_R2) {
      try {
        const map = {};
        let cursor;
        do {
          const r = await env.ASTERIS_R2.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            const parts = o.key.split("/");
            const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(raiz)";
            const f = map[folder] || (map[folder] = { name: folder, cloud: "r2", count: 0, bytes: 0, files: [] });
            f.count++; f.bytes += o.size || 0;
            f.files.push({ url: "/api/r2/" + o.key.split("/").map(encodeURIComponent).join("/"), tipo: isVidExt(o.key) ? "video" : "foto", bytes: o.size || 0 });
          }
          cursor = r.truncated ? r.cursor : null;
        } while (cursor);
        out.r2.folders = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { out.r2.error = String(e).slice(0, 120); }
    }

    if (out.cloudinary.configured) {
      try {
        const auth = btoa(`${env.CLOUDINARY_KEY}:${env.CLOUDINARY_SECRET}`);
        const map = {};
        for (const rt of ["image", "video"]) {
          const cr = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/resources/${rt}?max_results=500`, { headers: { authorization: `Basic ${auth}` } });
          if (!cr.ok) { out.cloudinary.error = rt + " " + cr.status; continue; }
          const cj = await cr.json();
          for (const res of (cj.resources || [])) {
            const folder = res.asset_folder || res.folder || "(raiz)";
            const f = map[folder] || (map[folder] = { name: folder, cloud: "cloudinary", count: 0, bytes: 0, files: [] });
            f.count++; f.bytes += res.bytes || 0;
            f.files.push({ url: res.secure_url, tipo: rt === "video" ? "video" : "foto", bytes: res.bytes || 0 });
          }
        }
        out.cloudinary.folders = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { out.cloudinary.error = String(e).slice(0, 120); }
    }
    return json(out);
  }

  // ---- apagar uma pasta inteira do R2 ----
  if (seg[0] === "media" && seg[1] === "r2-folder" && method === "DELETE") {
    if (!env.ASTERIS_R2) return json({ error: "R2 não ligado" }, 501);
    const prefix = decodeURIComponent(seg.slice(2).join("/"));
    if (!prefix || prefix === "(raiz)") return json({ error: "pasta inválida" }, 400);
    let cursor, n = 0;
    do {
      const r = await env.ASTERIS_R2.list({ cursor, prefix: prefix + "/", limit: 1000 });
      for (const o of r.objects) { await env.ASTERIS_R2.delete(o.key); n++; }
      cursor = r.truncated ? r.cursor : null;
    } while (cursor);
    return json({ ok: true, apagados: n });
  }

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
        anon: body.anon === true,
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

  // ---- upload de ficheiro ----
  // dest="r2" (entregas)  |  dest="cloudinary" (portfólio, seleção)  |  sem dest = o que estiver ligado
  if (seg[0] === "upload" && method === "POST") {
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    if (!file || typeof file === "string") return json({ error: "sem ficheiro" }, 400);
    const folder = (form.get("folder") || "media").toString().replace(/[^a-z0-9/_-]/gi, "").replace(/^\/+|\/+$/g, "");
    const dest = (form.get("dest") || "").toString().toLowerCase();

    const cloudOK = !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET);
    const useR2 = dest === "r2" || (!dest && env.ASTERIS_R2);
    const useCloud = dest === "cloudinary" || (!dest && !env.ASTERIS_R2 && cloudOK);

    if (useR2) {
      if (!env.ASTERIS_R2) return json({ error: "R2 ainda não está ligado" }, 501);
      const orig = (file.name || "ficheiro").replace(/[^a-z0-9.\-_]/gi, "-");
      const ext = (orig.match(/\.[a-z0-9]{2,5}$/i) || [""])[0].toLowerCase();
      const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
      const key = `${folder}/${Date.now().toString(36)}-${rand}${ext}`;
      await env.ASTERIS_R2.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
      const base = env.R2_PUBLIC_BASE || "";
      return json({ ok: true, via: "r2", key, url: base ? `${base.replace(/\/+$/, "")}/${key}` : `/api/r2/${key}` });
    }

    if (useCloud) {
      if (!cloudOK) return json({ error: "Cloudinary ainda não está ligado" }, 501);
      const ts = Math.floor(Date.now() / 1000);
      const params = { folder, timestamp: ts };
      const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
      const hb = await crypto.subtle.digest("SHA-1", enc.encode(toSign + env.CLOUDINARY_SECRET));
      const sig = [...new Uint8Array(hb)].map(b => b.toString(16).padStart(2, "0")).join("");
      const up = new FormData();
      up.append("file", file);
      up.append("api_key", env.CLOUDINARY_KEY);
      up.append("timestamp", String(ts));
      up.append("folder", folder);
      up.append("signature", sig);
      const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/auto/upload`, { method: "POST", body: up });
      const j = await r.json();
      if (j.secure_url) return json({ ok: true, via: "cloudinary", url: j.secure_url });
      return json({ error: j.error ? j.error.message : "upload falhou" }, 502);
    }

    return json({ error: "Nenhum armazenamento ligado. Cola o URL de cada ficheiro." }, 501);
  }

  return json({ error: "rota desconhecida" }, 404);
}
