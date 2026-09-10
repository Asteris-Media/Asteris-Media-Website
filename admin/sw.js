/* Asteris Systems — service worker mínimo.
   Network-first para tudo (nunca serve HTML/JS desatualizado).
   Só guarda em cache como último recurso quando não há rede, para o app abrir offline. */
var CACHE = "asteris-admin-v1";
var SHELL = ["/admin/", "/admin/index.html", "/assets/logos/asteris.png"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                       // API (POST/PUT/DELETE) passa direto
  if (req.url.indexOf("/api/") !== -1) return;            // dados sempre da rede
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && req.url.indexOf(self.location.origin) === 0) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy).catch(function () {}); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (m) { return m || caches.match("/admin/index.html"); });
    })
  );
});
