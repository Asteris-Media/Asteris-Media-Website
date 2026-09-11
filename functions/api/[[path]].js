// API do admin do portal Asteris.
// Env necessárias (Pages > Settings > Environment variables / bindings):
//   ASTERIS_KV        -> KV namespace binding
//   ADMIN_PW          -> password de entrada (Text/Secret). O utilizador desta password chama-se "Admin".
//   ADMIN_USERS       -> (opcional) várias contas: "Brener:senha1,Gustavo:senha2"  (nome:senha, separados por vírgula)
//   SESSION_SECRET    -> string aleatória p/ assinar a sessão (secret)
//   CLOUDINARY_CLOUD  -> ex. bv9q81il            (opcional, p/ upload)
//   CLOUDINARY_KEY    -> api key da Cloudinary   (opcional)
//   CLOUDINARY_SECRET -> api secret da Cloudinary (opcional, secret)
//   FFMPEGLAB_API_KEY -> chave de API do FFmpegLab (opcional, secret; Settings > API Keys > Create new
//                         API key na conta deles). A partir dela pedimos as credenciais S3 temporárias
//                         em GET /files/s3config — não há chave S3 fixa para configurar à mão.
//   FFMPEGLAB_PUBLIC_BASE -> opcional: se o bucket servir ficheiros por um domínio público direto,
//                            poupa o proxy (ex. https://cdn.ffmpeglab.com/<bucket>)

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
async function makeToken(secret, user, days) {
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 24 * (days || 14), u: user || "Admin" })));
  return payload + "." + (await hmac(secret, payload));
}
async function checkToken(secret, token) {
  if (!token || token.indexOf(".") < 0) return { ok: false };
  const [payload, sig] = token.split(".");
  if ((await hmac(secret, payload)) !== sig) return { ok: false };
  try {
    const p = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (p.exp > Date.now()) return { ok: true, user: p.u || "Admin" };
  } catch {}
  return { ok: false };
}
// ============================ S3 (FFmpegLab / qualquer S3-compatível) ============================
// Assinatura AWS SigV4 feita à mão (sem SDK) — o runtime das Pages Functions não tem npm/bundler aqui.
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256Hex(strOrBuf) { return hex(await crypto.subtle.digest("SHA-256", typeof strOrBuf === "string" ? enc.encode(strOrBuf) : strOrBuf)); }
async function s3Hmac(keyBuf, msg) {
  const key = await crypto.subtle.importKey("raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}
// as credenciais S3 do FFmpegLab são temporárias (STS) — pedimos com a nossa API key sempre
// que precisamos, e guardamos por uns minutos em memória do isolate para não pedir de mais.
let _s3ConfCache = null, _s3ConfCacheAt = 0;
async function s3Conf(env) {
  if (!env.FFMPEGLAB_API_KEY) return null;
  if (_s3ConfCache && (Date.now() - _s3ConfCacheAt) < 4 * 60 * 1000) return _s3ConfCache;
  try {
    const r = await fetch("https://api.ffmpeglab.com/files/s3config", { headers: { authorization: "Bearer " + env.FFMPEGLAB_API_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j.endpoint || !j.bucketId || !j.credentials || !j.credentials.accessKeyId) return null;
    const conf = {
      endpoint: String(j.endpoint).replace(/\/+$/, ""),
      bucket: j.bucketId,
      accessKey: j.credentials.accessKeyId,
      secretKey: j.credentials.secretAccessKey,
      sessionToken: j.credentials.sessionToken || "",
      region: j.region || "auto",
      userId: j.userId || ""
    };
    _s3ConfCache = conf; _s3ConfCacheAt = Date.now();
    return conf;
  } catch (e) { return null; }
}
// o bucket é partilhado entre todos os clientes do FFmpegLab — as credenciais só autorizam o
// prefixo do próprio utilizador (userId), por isso toda chave real leva esse prefixo à frente;
// o resto do código continua a falar em chaves "limpas" (sem o prefixo).
function s3FullKey(conf, key) {
  const p = conf.userId ? String(conf.userId).replace(/^\/+|\/+$/g, "") + "/" : "";
  return p + String(key || "").replace(/^\/+/, "");
}
function s3StripPrefix(conf, fullKey) {
  const p = conf.userId ? String(conf.userId).replace(/^\/+|\/+$/g, "") + "/" : "";
  return p && fullKey.indexOf(p) === 0 ? fullKey.slice(p.length) : fullKey;
}
// devolve { url, headers } prontos para fetch(). `query` já vem ordenada e codificada (ver s3Query).
// `payloadHash` = hash SHA-256 hex do corpo, ou "UNSIGNED-PAYLOAD" para streams grandes (upload).
async function s3Sign(conf, method, key, { query = "", payloadHash = "UNSIGNED-PAYLOAD", extraHeaders = {} } = {}) {
  const u = new URL(conf.endpoint);
  const fullKey = key ? s3FullKey(conf, key) : "";
  const canonicalUri = "/" + conf.bucket + (fullKey ? "/" + fullKey.split("/").map(encodeURIComponent).join("/") : "");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const headersObj = Object.assign({ host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash },
    conf.sessionToken ? { "x-amz-security-token": conf.sessionToken } : {}, extraHeaders);
  const entries = Object.keys(headersObj).map(k => [k.toLowerCase(), String(headersObj[k]).trim().replace(/\s+/g, " ")]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const canonicalHeaders = entries.map(([k, v]) => k + ":" + v + "\n").join("");
  const signedHeaders = entries.map(([k]) => k).join(";");
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${conf.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  let k = enc.encode("AWS4" + conf.secretKey);
  for (const part of [dateStamp, conf.region, "s3", "aws4_request"]) k = await s3Hmac(k, part);
  const signature = hex(await s3Hmac(k, stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${conf.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const fetchHeaders = {};
  for (const [k2, v2] of Object.entries(headersObj)) fetchHeaders[k2] = v2;
  fetchHeaders.authorization = authorization;
  return { url: conf.endpoint + canonicalUri + (query ? "?" + query : ""), headers: fetchHeaders };
}
function s3Query(params) {
  return Object.keys(params).sort().map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
}
// URL pré-assinada (SigV4 por query string) — o browser envia os bytes DIRETO ao bucket,
// sem passar pela Function. É o único jeito de não bater no limite de tamanho de pedido
// das Pages Functions em ficheiros grandes.
async function s3PresignUrl(conf, method, key, expiresSeconds) {
  const u = new URL(conf.endpoint);
  const fullKey = s3FullKey(conf, key);
  const canonicalUri = "/" + conf.bucket + "/" + fullKey.split("/").map(encodeURIComponent).join("/");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${conf.region}/s3/aws4_request`;
  const queryObj = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${conf.accessKey}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds || 900),
    "X-Amz-SignedHeaders": "host"
  };
  if (conf.sessionToken) queryObj["X-Amz-Security-Token"] = conf.sessionToken;
  const query = s3Query(queryObj);
  const canonicalRequest = [method, canonicalUri, query, "host:" + u.host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  let k = enc.encode("AWS4" + conf.secretKey);
  for (const part of [dateStamp, conf.region, "s3", "aws4_request"]) k = await s3Hmac(k, part);
  const signature = hex(await s3Hmac(k, stringToSign));
  return conf.endpoint + canonicalUri + "?" + query + "&X-Amz-Signature=" + signature;
}
async function s3Put(conf, key, stream, contentType) {
  const { url, headers } = await s3Sign(conf, "PUT", key, { extraHeaders: contentType ? { "content-type": contentType } : {} });
  const r = await fetch(url, { method: "PUT", headers, body: stream });
  if (!r.ok) throw new Error("s3 put " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  return true;
}
async function s3Delete(conf, key) {
  const { url, headers } = await s3Sign(conf, "DELETE", key, { payloadHash: await sha256Hex("") });
  const r = await fetch(url, { method: "DELETE", headers });
  return r.ok || r.status === 204 || r.status === 404;
}
async function s3Get(conf, key) {
  const { url, headers } = await s3Sign(conf, "GET", key, { payloadHash: await sha256Hex("") });
  return fetch(url, { headers });
}
// lista todos os objetos com um prefixo (pagina com continuation-token); parse simples de XML (S3 devolve XML plano)
async function s3List(conf, prefix) {
  const out = [];
  let token = "";
  const fullPrefix = s3FullKey(conf, prefix || "");
  do {
    const params = { "list-type": "2", "max-keys": "1000", prefix: fullPrefix };
    if (token) params["continuation-token"] = token;
    const { url, headers } = await s3Sign(conf, "GET", "", { query: s3Query(params), payloadHash: await sha256Hex("") });
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error("s3 list " + r.status);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1];
      const rawKey = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [, ""])[1];
      const size = +(block.match(/<Size>([\s\S]*?)<\/Size>/) || [, "0"])[1];
      const key = s3StripPrefix(conf, rawKey);
      if (key) out.push({ key, size });
    }
    const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    token = trunc ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [, ""])[1] : "";
  } while (token);
  return out;
}

// devolve o nome do utilizador se a password bater, senão null
// ADMIN_USERS aceita "Nome:senha" ou "Nome:email:senha" (separados por vírgula)
function parseUsers(env) {
  const list = [];
  if (env.ADMIN_PW) list.push({ name: "Admin", email: "", pw: env.ADMIN_PW });
  for (const pair of String(env.ADMIN_USERS || "").split(",")) {
    const parts = pair.split(":").map(s => s.trim());
    if (parts.length >= 3) list.push({ name: parts[0] || "Admin", email: parts[1].toLowerCase(), pw: parts.slice(2).join(":") });
    else if (parts.length === 2 && parts[1]) list.push({ name: parts[0] || "Admin", email: "", pw: parts[1] });
  }
  return list;
}
// devolve o nome se a senha bater; se vier email, tem de corresponder (a menos que a conta não tenha email definido)
function userForLogin(env, email, pw) {
  if (!pw) return null;
  email = String(email || "").trim().toLowerCase();
  for (const u of parseUsers(env)) {
    if (u.pw && pw === u.pw && (!u.email || !email || u.email === email)) return u.name;
  }
  return null;
}
function userForPw(env, pw) { return userForLogin(env, "", pw); }
// registo de atividade (KV "activitylog", array topo=mais recente, máx 400)
async function logAction(env, user, action, extra) {
  try {
    const raw = await env.ASTERIS_KV.get("activitylog");
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ t: new Date().toISOString(), u: user || "?", a: action, ...(extra || {}) });
    await env.ASTERIS_KV.put("activitylog", JSON.stringify(arr.slice(0, 400)));
  } catch {}
}
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
const COOKIE = "as_sess";
function setCookie(token, days) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * (days || 14)}`;
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
    const body = await request.json().catch(() => ({}));
    const user = userForLogin(env, body.email, body.pw);
    if (!user) return json({ error: "Email ou password errados" }, 401);
    const days = body.remember ? 60 : 14;
    const token = await makeToken(SECRET, user, days);
    await logAction(env, user, "entrou");
    return json({ ok: true, user }, 200, { "set-cookie": setCookie(token, days) });
  }
  if (seg[0] === "logout") {
    const t = await checkToken(SECRET, getCookie(request, COOKIE));
    if (t.ok) await logAction(env, t.user, "saiu");
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

  // ---- diagnóstico simples da ligação ao FFmpegLab (não expõe segredos, só se está a funcionar) ----
  if (seg[0] === "ffmpeglab-check" && method === "GET") {
    if (!env.FFMPEGLAB_API_KEY) return json({ hasKey: false, ok: false, motivo: "FFMPEGLAB_API_KEY não está definida" });
    try {
      const r = await fetch("https://api.ffmpeglab.com/files/s3config", { headers: { authorization: "Bearer " + env.FFMPEGLAB_API_KEY } });
      if (!r.ok) return json({ hasKey: true, ok: false, motivo: "s3config respondeu " + r.status });
      const j = await r.json().catch(() => null);
      if (!j || !j.endpoint || !j.bucketId || !j.credentials || !j.credentials.accessKeyId) return json({ hasKey: true, ok: false, motivo: "resposta do s3config não tem o formato esperado" });
      const conf = await s3Conf(env);
      let listOk = false, listMotivo = "";
      try { await s3List(conf, ""); listOk = true; } catch (e) { listMotivo = String(e).slice(0, 200); }
      const testKey = "_diag/probe-" + Date.now() + ".txt";
      let putOk = false, putMotivo = "", getOk = false, getMotivo = "", delOk = false, delMotivo = "";
      try { await s3Put(conf, testKey, "ok", "text/plain"); putOk = true; } catch (e) { putMotivo = String(e).slice(0, 200); }
      if (putOk) {
        try { const gr = await s3Get(conf, testKey); getOk = gr.ok; if (!gr.ok) getMotivo = "status " + gr.status; } catch (e) { getMotivo = String(e).slice(0, 200); }
        try { delOk = await s3Delete(conf, testKey); if (!delOk) delMotivo = "delete devolveu falso"; } catch (e) { delMotivo = String(e).slice(0, 200); }
      }
      return json({
        hasKey: true, ok: true, bucket: j.bucketId, region: j.region || "auto",
        hasSessionToken: !!j.credentials.sessionToken, hasUserId: !!j.userId,
        listOk, listMotivo, putOk, putMotivo, getOk, getMotivo, delOk, delMotivo
      });
    } catch (e) { return json({ hasKey: true, ok: false, motivo: String(e).slice(0, 200) }); }
  }

  // ---- servir ficheiro do FFmpegLab (S3) — mesma lógica do R2 acima ----
  if (seg[0] === "ffmpeglab" && method === "GET") {
    const conf = await s3Conf(env);
    if (!conf) return json({ error: "FFmpegLab não ligado" }, 501);
    const key = seg.slice(1).map(decodeURIComponent).join("/");
    if (env.FFMPEGLAB_PUBLIC_BASE) return Response.redirect(env.FFMPEGLAB_PUBLIC_BASE.replace(/\/+$/, "") + "/" + key.split("/").map(encodeURIComponent).join("/"), 302);
    const r = await s3Get(conf, key);
    if (!r.ok) return json({ error: "não existe" }, 404);
    const h = new Headers(r.headers);
    h.set("cache-control", "public, max-age=31536000, immutable");
    h.set("access-control-allow-origin", "*");
    const dl = url.searchParams.get("dl");
    if (dl) h.set("content-disposition", `attachment; filename="${dl.replace(/[^a-z0-9.\-_ ]/gi, "_")}"`);
    return new Response(r.body, { headers: h });
  }

  // ---- página de acesso a uma pasta (PÚBLICA, obscura — o link partilhável da biblioteca) ----
  if (seg[0] === "media" && seg[1] === "view" && method === "GET") {
    const folder = (url.searchParams.get("f") || "").replace(/[^a-z0-9/_-]/gi, "");
    const cloudParam = url.searchParams.get("c");
    const cloud = cloudParam === "cloudinary" ? "cloudinary" : cloudParam === "ffmpeglab" ? "ffmpeglab" : "r2";
    if (!folder) return new Response("pasta em falta", { status: 400 });
    const isVidU = (s) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(s || "");
    let files = [];
    let diag = "";
    try {
      if (cloud === "r2") {
        if (!env.ASTERIS_R2) diag = "R2 não ligado.";
        else {
          let cursor;
          do {
            const r = await env.ASTERIS_R2.list({ cursor, prefix: folder + "/", limit: 1000 });
            for (const o of r.objects) files.push({ url: "/api/r2/" + o.key.split("/").map(encodeURIComponent).join("/"), name: o.key.split("/").pop(), bytes: o.size || 0 });
            cursor = r.truncated ? r.cursor : null;
          } while (cursor);
          if (!files.length) diag = `Sem ficheiros com o prefixo "${folder}/" no R2.`;
        }
      } else if (cloud === "ffmpeglab") {
        const conf = await s3Conf(env);
        if (!conf) diag = "FFmpegLab não ligado.";
        else {
          const objs = await s3List(conf, folder + "/");
          for (const o of objs) files.push({ url: "/api/ffmpeglab/" + o.key.split("/").map(encodeURIComponent).join("/"), name: o.key.split("/").pop(), bytes: o.size || 0 });
          if (!files.length) diag = `Sem ficheiros com o prefixo "${folder}/" no FFmpegLab.`;
        }
      } else {
        if (!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET)) diag = "Cloudinary não ligado.";
        else {
          const auth = btoa(`${env.CLOUDINARY_KEY}:${env.CLOUDINARY_SECRET}`);
          const seen = new Set();
          const add = (res) => {
            if (!res || seen.has(res.public_id)) return;
            seen.add(res.public_id);
            files.push({ url: res.secure_url, name: (res.public_id.split("/").pop()) + (res.format ? "." + res.format : ""), bytes: res.bytes || 0 });
          };
          // 1) pastas dinâmicas
          const bf = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/resources/by_asset_folder?asset_folder=${encodeURIComponent(folder)}&max_results=500`, { headers: { authorization: `Basic ${auth}` } });
          if (bf.ok) { const j = await bf.json(); (j.resources || []).forEach(add); }
          else diag = "by_asset_folder " + bf.status;
          // 2) pastas legadas (prefixo do public_id)
          if (!files.length) {
            for (const rt of ["image", "video"]) {
              const cr = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/resources/${rt}?prefix=${encodeURIComponent(folder)}/&type=upload&max_results=500`, { headers: { authorization: `Basic ${auth}` } });
              if (cr.ok) { const cj = await cr.json(); (cj.resources || []).forEach(add); }
            }
          }
          if (!files.length && !diag) diag = `Nada em "${folder}" no Cloudinary.`;
        }
      }
    } catch (e) { diag = "erro: " + String(e).slice(0, 140); }
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
${files.length ? `<div class="g">${grid}</div>` : `<div class="empty">${esc(diag || "Pasta vazia.")}</div>`}
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

  const session = await checkToken(SECRET, getCookie(request, COOKIE));
  const authed = session.ok;
  const ME = session.user || "?";
  if (seg[0] === "me") return json({ ok: authed, user: session.user || null });
  if (!authed) return json({ error: "Sessão inválida" }, 401);

  // ---- registo de atividade ----
  if (seg[0] === "log" && method === "GET") {
    const raw = await env.ASTERIS_KV.get("activitylog");
    return json({ log: raw ? JSON.parse(raw) : [] });
  }
  if (seg[0] === "log" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (b.action) await logAction(env, ME, String(b.action).slice(0, 200), b.detail ? { detail: String(b.detail).slice(0, 200) } : null);
    return json({ ok: true });
  }

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

    const ffConf = await s3Conf(env);
    const ffmpeglab = { bound: !!ffConf, objects: null, bytes: null };
    if (ffConf) {
      try {
        const objs = await s3List(ffConf, "");
        ffmpeglab.objects = objs.length;
        ffmpeglab.bytes = objs.reduce((s, x) => s + (x.size || 0), 0);
      } catch (e) { ffmpeglab.error = String(e).slice(0, 120); }
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
      ffmpeglab,
      cloudinary,
      limits: {
        kv: { storageMB: 1024, readsDia: 100000, escritasDia: 1000, apagarDia: 1000 },
        r2: { storageGB: 10, classAmes: 1000000, classBmes: 10000000 },
        ffmpeglab: { storageGB: +env.FFMPEGLAB_QUOTA_GB || 50 },
        pagesBuildsMes: 500,
        cloudinaryCreditosMes: 25
      }
    });
  }

  // ---- tags das pastas da biblioteca (KV) ----
  if (seg[0] === "media" && seg[1] === "tag" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    if (!b.folder) return json({ error: "pasta em falta" }, 400);
    const raw = await env.ASTERIS_KV.get("mediatags");
    const tags = raw ? JSON.parse(raw) : {};
    if (b.tag) tags[b.folder] = b.tag; else delete tags[b.folder];
    await env.ASTERIS_KV.put("mediatags", JSON.stringify(tags));
    await logAction(env, ME, b.tag ? "marcou pasta como " + b.tag : "tirou a tag da pasta", { detail: b.folder });
    return json({ ok: true });
  }

  // ---- biblioteca de media: pastas + ficheiros das duas nuvens ----
  if (seg[0] === "media" && !seg[1] && method === "GET") {
    const isVidExt = (s) => /\.(mp4|webm|mov|m4v)$/i.test(s || "");
    const tagsRaw = await env.ASTERIS_KV.get("mediatags");
    const TAGS = tagsRaw ? JSON.parse(tagsRaw) : {};
    const tagOf = (name) => TAGS[name] || (/entrega/i.test(name) ? "entrega" : /selec/i.test(name) ? "selecao" : /portf/i.test(name) ? "portfolio" : "");
    const ffConfMedia = await s3Conf(env);
    const out = { r2: { bound: !!env.ASTERIS_R2, folders: [] }, cloudinary: { configured: !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET), folders: [] }, ffmpeglab: { configured: !!ffConfMedia, folders: [] } };

    if (out.ffmpeglab.configured) {
      try {
        const conf = ffConfMedia;
        const objs = await s3List(conf, "");
        const map = {};
        for (const o of objs) {
          const parts = o.key.split("/");
          const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(raiz)";
          const f = map[folder] || (map[folder] = { name: folder, cloud: "ffmpeglab", tag: tagOf(folder), count: 0, bytes: 0, files: [] });
          f.count++; f.bytes += o.size || 0;
          f.files.push({ url: "/api/ffmpeglab/" + o.key.split("/").map(encodeURIComponent).join("/"), key: o.key, tipo: isVidExt(o.key) ? "video" : "foto", bytes: o.size || 0 });
        }
        out.ffmpeglab.folders = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { out.ffmpeglab.error = String(e).slice(0, 120); }
    }

    if (env.ASTERIS_R2) {
      try {
        const map = {};
        let cursor;
        do {
          const r = await env.ASTERIS_R2.list({ cursor, limit: 1000 });
          for (const o of r.objects) {
            const parts = o.key.split("/");
            const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(raiz)";
            const f = map[folder] || (map[folder] = { name: folder, cloud: "r2", tag: tagOf(folder), count: 0, bytes: 0, files: [] });
            f.count++; f.bytes += o.size || 0;
            f.files.push({ url: "/api/r2/" + o.key.split("/").map(encodeURIComponent).join("/"), key: o.key, tipo: isVidExt(o.key) ? "video" : "foto", bytes: o.size || 0 });
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
            const f = map[folder] || (map[folder] = { name: folder, cloud: "cloudinary", tag: tagOf(folder), count: 0, bytes: 0, files: [] });
            f.count++; f.bytes += res.bytes || 0;
            f.files.push({ url: res.secure_url, publicId: res.public_id, resourceType: rt, tipo: rt === "video" ? "video" : "foto", bytes: res.bytes || 0 });
          }
        }
        out.cloudinary.folders = Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
      } catch (e) { out.cloudinary.error = String(e).slice(0, 120); }
    }
    return json(out);
  }

  // ---- apagar ficheiro(s) da biblioteca ----  body: { cloud, keys:[...], publicIds:[{publicId,resourceType}] }
  if (seg[0] === "media" && seg[1] === "files" && method === "DELETE") {
    const b = await request.json().catch(() => ({}));
    let n = 0, erros = [];
    const ffConfDel = b.cloud === "ffmpeglab" ? await s3Conf(env) : null;
    if (b.cloud === "r2" && env.ASTERIS_R2) {
      for (const k of (b.keys || [])) { try { await env.ASTERIS_R2.delete(k); n++; } catch (e) { erros.push(k); } }
    } else if (b.cloud === "ffmpeglab" && ffConfDel) {
      const conf = ffConfDel;
      for (const k of (b.keys || [])) { try { await s3Delete(conf, k); n++; } catch (e) { erros.push(k); } }
    } else if (b.cloud === "cloudinary" && env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET) {
      const auth = btoa(`${env.CLOUDINARY_KEY}:${env.CLOUDINARY_SECRET}`);
      const byRt = {};
      for (const it of (b.publicIds || [])) { (byRt[it.resourceType || "image"] = byRt[it.resourceType || "image"] || []).push(it.publicId); }
      for (const rt of Object.keys(byRt)) {
        const params = new URLSearchParams();
        byRt[rt].forEach(id => params.append("public_ids[]", id));
        const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/resources/${rt}/upload?${params.toString()}`, { method: "DELETE", headers: { authorization: `Basic ${auth}` } });
        if (r.ok) { const j = await r.json(); n += Object.keys(j.deleted || {}).length; }
        else erros.push(rt + " " + r.status);
      }
    } else {
      return json({ error: "nuvem não ligada" }, 501);
    }
    await logAction(env, ME, "apagou " + n + " ficheiro(s) da biblioteca (" + (b.cloud || "?") + ")");
    return json({ ok: true, apagados: n, erros });
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
    await logAction(env, ME, "apagou a pasta \"" + prefix + "\" do R2 (" + n + " ficheiros)");
    return json({ ok: true, apagados: n });
  }

  // ---- apagar uma pasta inteira do FFmpegLab (S3) ----
  if (seg[0] === "media" && seg[1] === "ffmpeglab-folder" && method === "DELETE") {
    const conf = await s3Conf(env);
    if (!conf) return json({ error: "FFmpegLab não ligado" }, 501);
    const prefix = decodeURIComponent(seg.slice(2).join("/"));
    if (!prefix || prefix === "(raiz)") return json({ error: "pasta inválida" }, 400);
    const objs = await s3List(conf, prefix + "/");
    let n = 0;
    for (const o of objs) { if (await s3Delete(conf, o.key)) n++; }
    await logAction(env, ME, "apagou a pasta \"" + prefix + "\" do FFmpegLab (" + n + " ficheiros)");
    return json({ ok: true, apagados: n });
  }

  // ---- renomear uma pasta ----  body: { cloud, from, to, items:[{publicId,resourceType}] }
  if (seg[0] === "media" && seg[1] === "rename-folder" && (method === "POST" || method === "PUT")) {
    const b = await request.json().catch(() => ({}));
    const from = String(b.from || "").replace(/^\/+|\/+$/g, "");
    const to = String(b.to || "").replace(/^\/+|\/+$/g, "").replace(/\.\.+/g, "").replace(/[<>:"|?*\x00-\x1f]+/g, "").trim();
    if (!from || !to || from === to) return json({ error: "nome inválido" }, 400);
    let n = 0;
    if (b.cloud === "r2") {
      if (!env.ASTERIS_R2) return json({ error: "R2 não ligado" }, 501);
      let cursor;
      do {
        const r = await env.ASTERIS_R2.list({ cursor, prefix: from + "/", limit: 1000 });
        for (const o of r.objects) {
          const nk = to + o.key.slice(from.length);
          const obj = await env.ASTERIS_R2.get(o.key);
          if (!obj) continue;
          await env.ASTERIS_R2.put(nk, obj.body, { httpMetadata: obj.httpMetadata });
          await env.ASTERIS_R2.delete(o.key);
          n++;
        }
        cursor = r.truncated ? r.cursor : null;
      } while (cursor);
    } else if (b.cloud === "cloudinary" && env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET) {
      for (const it of (b.items || [])) {
        const rt = it.resourceType || "image";
        const oldId = it.publicId;
        const baseName = oldId.indexOf("/") >= 0 ? oldId.slice(oldId.lastIndexOf("/") + 1) : oldId;
        const newId = to + "/" + baseName;
        const ts = Math.floor(Date.now() / 1000);
        const signParams = { from_public_id: oldId, timestamp: ts, to_public_id: newId };
        const toSign = Object.keys(signParams).sort().map(k => `${k}=${signParams[k]}`).join("&");
        const hb = await crypto.subtle.digest("SHA-1", enc.encode(toSign + env.CLOUDINARY_SECRET));
        const sig = [...new Uint8Array(hb)].map(x => x.toString(16).padStart(2, "0")).join("");
        const body = new URLSearchParams({ from_public_id: oldId, to_public_id: newId, timestamp: String(ts), api_key: env.CLOUDINARY_KEY, signature: sig });
        const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/${rt}/rename`, { method: "POST", body });
        if (r.ok) n++;
      }
    } else {
      return json({ error: "nuvem não ligada" }, 501);
    }
    try {
      const raw = await env.ASTERIS_KV.get("mediatags");
      const tags = raw ? JSON.parse(raw) : {};
      if (tags[from] != null) { tags[to] = tags[from]; delete tags[from]; await env.ASTERIS_KV.put("mediatags", JSON.stringify(tags)); }
    } catch (e) {}
    await logAction(env, ME, "renomeou a pasta \"" + from + "\" para \"" + to + "\" (" + n + " ficheiros)");
    return json({ ok: true, movidos: n });
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
      const logMsg = typeof body._log === "string" ? body._log.slice(0, 180) : null;
      delete body._log;
      const jaExistia = !!(await env.ASTERIS_KV.get(key));
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
      await logAction(env, ME,
        logMsg || ((jaExistia ? "editou" : "criou") + " a página " + code + (body.cliente ? " · " + body.cliente : "")),
        { code });
      return json({ ok: true, code });
    }
    if (method === "DELETE") {
      await env.ASTERIS_KV.delete(key);
      await saveIndex(env, (await loadIndex(env)).filter(x => x.code !== code));
      await logAction(env, ME, "apagou a página " + code, { code });
      return json({ ok: true });
    }
    return json({ error: "método" }, 405);
  }

  // ---- coleções genéricas (clientes, tarefas, contratos, agenda, notas, prospeccao) ----
  // Cada registo pode ter scope:"privado" + owner (nome). GET só devolve partilhados + os privados de ME.
  // GET  /api/col/<nome>            -> { items:[...] }
  // PUT  /api/col/<nome>/<id>       -> upsert
  // DELETE /api/col/<nome>/<id>     -> apaga
  if (seg[0] === "col") {
    const COLS = ["clientes", "tarefas", "contratos", "agenda", "notas", "prospeccao", "workspaces", "pagamentos", "despesas"];
    const name = (seg[1] || "").toLowerCase();
    if (!COLS.includes(name)) return json({ error: "coleção desconhecida" }, 404);
    const kvKey = "col:" + name;
    const readAll = async () => { const raw = await env.ASTERIS_KV.get(kvKey); return raw ? JSON.parse(raw) : []; };
    const canSee = (x) => x.scope !== "privado" || x.owner === ME;

    if (!seg[2]) {
      if (method === "GET") return json({ items: (await readAll()).filter(canSee) });
      return json({ error: "método" }, 405);
    }
    const id = seg[2].replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id) return json({ error: "id inválido" }, 400);

    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object") return json({ error: "json inválido" }, 400);
      const logMsg = typeof body._log === "string" ? body._log.slice(0, 180) : null;
      delete body._log;
      const list = await readAll();
      const i = list.findIndex(x => x.id === id);
      const prev = i >= 0 ? list[i] : null;
      if (prev && prev.scope === "privado" && prev.owner && prev.owner !== ME) return json({ error: "sem acesso" }, 403);
      const now = new Date().toISOString();
      const rec = { ...(prev || {}), ...body, id, atualizado: now };
      if (rec.scope === "privado") rec.owner = (prev && prev.owner) || ME;
      else { rec.scope = "partilhado"; delete rec.owner; }
      if (i >= 0) list[i] = rec; else { rec.criado = now; list.unshift(rec); }
      await env.ASTERIS_KV.put(kvKey, JSON.stringify(list.slice(0, 500)));
      await logAction(env, ME, logMsg || ((i >= 0 ? "editou" : "criou") + " " + name.replace(/s$/, "") + " " + id));
      return json({ ok: true, item: rec });
    }
    if (method === "DELETE") {
      const list = await readAll();
      const prev = list.find(x => x.id === id);
      if (prev && prev.scope === "privado" && prev.owner && prev.owner !== ME) return json({ error: "sem acesso" }, 403);
      await env.ASTERIS_KV.put(kvKey, JSON.stringify(list.filter(x => x.id !== id)));
      await logAction(env, ME, "apagou " + name.replace(/s$/, "") + " " + id);
      return json({ ok: true });
    }
    return json({ error: "método" }, 405);
  }

  // ---- upload de ficheiro ----
  // dest="r2" (entregas)  |  dest="cloudinary" (portfólio, seleção)  |  sem dest = o que estiver ligado
  // ---- configurações gerais (hoje só o teto mensal de despesas) ----
  // GET /api/config  -> { tetoDespesas }
  // PUT /api/config  -> body faz merge no que já estava guardado
  if (seg[0] === "config" && method === "GET") {
    const raw = await env.ASTERIS_KV.get("config:geral");
    return json(raw ? JSON.parse(raw) : {});
  }
  if (seg[0] === "config" && method === "PUT") {
    const b = await request.json().catch(() => ({}));
    const raw = await env.ASTERIS_KV.get("config:geral");
    const cfg = Object.assign({}, raw ? JSON.parse(raw) : {}, b);
    await env.ASTERIS_KV.put("config:geral", JSON.stringify(cfg));
    return json({ ok: true, config: cfg });
  }

  // ---- limpeza automática: marca uma pasta (R2 ou FFmpegLab) para apagar sozinha ao fim de X dias ----
  // GET  /api/limpezas          -> lista o que está agendado
  // POST /api/limpezas          -> { folder, cloud, dias }  agenda/atualiza
  // DELETE /api/limpezas/<id>   -> cancela o agendamento (sem apagar o ficheiro)
  // POST /api/limpezas/run      -> varre e apaga o que já venceu (chamado pelo próprio admin, sem cron externo)
  if (seg[0] === "limpezas" && !seg[1] && method === "GET") {
    const raw = await env.ASTERIS_KV.get("col:limpezas");
    return json({ items: raw ? JSON.parse(raw) : [] });
  }
  if (seg[0] === "limpezas" && !seg[1] && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const folder = String(b.folder || "").replace(/^\/+|\/+$/g, "");
    const cloud = b.cloud === "ffmpeglab" ? "ffmpeglab" : "r2";
    const dias = Math.max(1, Math.min(365, parseInt(b.dias, 10) || 30));
    if (!folder) return json({ error: "pasta em falta" }, 400);
    const raw = await env.ASTERIS_KV.get("col:limpezas");
    const list = raw ? JSON.parse(raw) : [];
    const apagarEm = new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
    const i = list.findIndex(x => x.folder === folder && x.cloud === cloud);
    const rec = { id: (i >= 0 ? list[i].id : (folder + ":" + cloud)), folder, cloud, dias, apagarEm, criadoEm: (i >= 0 ? list[i].criadoEm : new Date().toISOString()) };
    if (i >= 0) list[i] = rec; else list.push(rec);
    await env.ASTERIS_KV.put("col:limpezas", JSON.stringify(list));
    await logAction(env, ME, "agendou apagar \"" + folder + "\" em " + dias + " dias (" + apagarEm + ")");
    return json({ ok: true, item: rec });
  }
  if (seg[0] === "limpezas" && seg[1] && method === "DELETE") {
    const raw = await env.ASTERIS_KV.get("col:limpezas");
    const list = (raw ? JSON.parse(raw) : []).filter(x => x.id !== seg[1]);
    await env.ASTERIS_KV.put("col:limpezas", JSON.stringify(list));
    return json({ ok: true });
  }
  if (seg[0] === "limpezas" && seg[1] === "run" && method === "POST") {
    const raw = await env.ASTERIS_KV.get("col:limpezas");
    const list = raw ? JSON.parse(raw) : [];
    const today = new Date().toISOString().slice(0, 10);
    const vencidas = list.filter(x => x.apagarEm <= today);
    const restantes = list.filter(x => x.apagarEm > today);
    const apagadas = [];
    for (const it of vencidas) {
      try {
        let n = 0;
        if (it.cloud === "r2" && env.ASTERIS_R2) {
          let cursor;
          do {
            const r = await env.ASTERIS_R2.list({ cursor, prefix: it.folder + "/", limit: 1000 });
            for (const o of r.objects) { await env.ASTERIS_R2.delete(o.key); n++; }
            cursor = r.truncated ? r.cursor : null;
          } while (cursor);
        } else if (it.cloud === "ffmpeglab") {
          const conf = await s3Conf(env);
          if (!conf) { restantes.push(it); continue; }
          const objs = await s3List(conf, it.folder + "/");
          for (const o of objs) { if (await s3Delete(conf, o.key)) n++; }
        }
        apagadas.push({ folder: it.folder, cloud: it.cloud, ficheiros: n });
      } catch (e) { restantes.push(it); }
    }
    await env.ASTERIS_KV.put("col:limpezas", JSON.stringify(restantes));
    if (apagadas.length) await logAction(env, ME, "limpeza automática apagou " + apagadas.length + " pasta(s) vencida(s)", { detail: apagadas.map(a => a.folder).join(", ") });
    return json({ ok: true, apagadas, restantes: restantes.length });
  }

  // ---- pede uma URL de envio direto (o browser envia os bytes ao bucket sem passar por aqui) ----
  // POST /api/upload-url  body: { folder, filename }  ->  { url, key, getUrl }
  // Precisa que o bucket do FFmpegLab aceite CORS de origem do admin (Settings > CORS no painel deles);
  // sem isso o browser bloqueia o PUT mesmo com a assinatura certa.
  if (seg[0] === "upload-url" && method === "POST") {
    const conf = await s3Conf(env);
    if (!conf) return json({ error: "FFmpegLab ainda não está ligado" }, 501);
    const b = await request.json().catch(() => ({}));
    const folder = String(b.folder || "media").replace(/[^a-z0-9/_-]/gi, "").replace(/^\/+|\/+$/g, "");
    const orig = (b.filename || "ficheiro").replace(/[^a-z0-9.\-_]/gi, "-");
    const ext = (orig.match(/\.[a-z0-9]{2,5}$/i) || [""])[0].toLowerCase();
    const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(x => x.toString(16).padStart(2, "0")).join("");
    const key = `${folder}/${Date.now().toString(36)}-${rand}${ext}`;
    // 15 min para começar o envio; depois de começado o pedido, o resto do envio não depende disto —
    // as credenciais do FFmpegLab são temporárias e não sabemos a validade real delas, então fica conservador.
    const uploadUrl = await s3PresignUrl(conf, "PUT", key, 900);
    const base = env.FFMPEGLAB_PUBLIC_BASE || "";
    const getUrl = base ? `${base.replace(/\/+$/, "")}/${key}` : `/api/ffmpeglab/${key}`;
    return json({ ok: true, url: uploadUrl, key, getUrl });
  }

  if (seg[0] === "upload" && method === "POST") {
    const form = await request.formData().catch(() => null);
    const file = form && form.get("file");
    if (!file || typeof file === "string") return json({ error: "sem ficheiro" }, 400);
    const folder = (form.get("folder") || "media").toString().replace(/[^a-z0-9/_-]/gi, "").replace(/^\/+|\/+$/g, "");
    const dest = (form.get("dest") || "").toString().toLowerCase();

    const cloudOK = !!(env.CLOUDINARY_CLOUD && env.CLOUDINARY_KEY && env.CLOUDINARY_SECRET);
    const useFFmpeglab = dest === "ffmpeglab";
    const s3conf = useFFmpeglab ? await s3Conf(env) : null;
    const useR2 = dest === "r2" || (!dest && env.ASTERIS_R2);
    const useCloud = dest === "cloudinary" || (!dest && !env.ASTERIS_R2 && cloudOK);

    if (useFFmpeglab) {
      if (!s3conf) return json({ error: "FFmpegLab ainda não está ligado" }, 501);
      const orig = (file.name || "ficheiro").replace(/[^a-z0-9.\-_]/gi, "-");
      const ext = (orig.match(/\.[a-z0-9]{2,5}$/i) || [""])[0].toLowerCase();
      const rand = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, "0")).join("");
      const key = `${folder}/${Date.now().toString(36)}-${rand}${ext}`;
      try { await s3Put(s3conf, key, file.stream(), file.type || "application/octet-stream"); }
      catch (e) { return json({ error: "upload para o FFmpegLab falhou: " + String(e).slice(0, 200) }, 502); }
      const base = env.FFMPEGLAB_PUBLIC_BASE || "";
      return json({ ok: true, via: "ffmpeglab", key, url: base ? `${base.replace(/\/+$/, "")}/${key}` : `/api/ffmpeglab/${key}` });
    }

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
