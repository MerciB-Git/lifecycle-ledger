/* คลังความรู้ — service worker
   - แคชไฟล์แอปให้เปิดได้แบบออฟไลน์ (cache-first + อัปเดตเบื้องหลัง)
   - รับเนื้อหาที่ "แชร์" มาจากแอปอื่น (Web Share Target) แล้วส่งต่อให้หน้าแอป */

var CACHE = "knowledge-vault-v2";

var ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./vendor/anthropic-sdk.mjs",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

/* ---------- ที่พักของที่ถูกแชร์เข้ามา (แยกฐานข้อมูลจากของแอป) ---------- */
function openShareDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open("kv-share-inbox", 1);
    req.onupgradeneeded = function () { req.result.createObjectStore("inbox", { keyPath: "id" }); };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function stashShare(entry) {
  return openShareDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction("inbox", "readwrite");
      tx.objectStore("inbox").put(entry);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function handleShare(request) {
  return request.formData().then(function (form) {
    var files = form.getAll("files").filter(function (f) { return f && typeof f !== "string" && f.size > 0; });
    var entry = {
      id: "share-" + Date.now(),
      title: form.get("title") || "",
      text: form.get("text") || "",
      url: form.get("url") || "",
      files: files.map(function (f) { return { name: f.name, type: f.type, blob: f }; })
    };
    return stashShare(entry);
  }).catch(function () { return null; }).then(function () {
    return Response.redirect("./?share=1", 303);
  });
}

/* ---------- lifecycle ---------- */
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: "reload" })).catch(function () { return null; });
      }));
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf("knowledge-vault-") === 0 && k !== CACHE ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // รับของที่แชร์เข้ามา
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== "GET") return;

  // เปิดหน้าแอป: network ก่อน ออฟไลน์ค่อยใช้แคช
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (hit) { return hit || caches.match("./"); });
      })
    );
    return;
  }

  // ไฟล์อื่น: cache-first + ดึงเวอร์ชันใหม่เก็บไว้เบื้องหลัง
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
