/* Lifecycle Ledger — service worker
   ทำให้แอปเปิดได้แบบออฟไลน์ และอัปเดตเวอร์ชันใหม่อย่างปลอดภัย
   กลยุทธ์: cache-first สำหรับไฟล์แอป (ไฟล์คงที่ ไม่เปลี่ยนบ่อย)
            + อัปเดตเบื้องหลัง (stale-while-revalidate) เพื่อให้ได้เวอร์ชันใหม่รอบถัดไป */

var CACHE = "lifecycle-ledger-v1";

var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // เพิ่มทีละไฟล์ เพื่อไม่ให้ไฟล์เดียวพังแล้วการติดตั้งล้มทั้งหมด
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
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var req = event.request;

  // จัดการเฉพาะ GET ของโดเมนตัวเอง
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // การเปิดหน้าเว็บ: ลอง network ก่อน (ได้เวอร์ชันใหม่) ถ้าออฟไลน์ค่อยใช้ cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (hit) {
          return hit || caches.match("./");
        });
      })
    );
    return;
  }

  // ไฟล์อื่น: cache-first + ดึงเวอร์ชันใหม่มาเก็บไว้เบื้องหลัง
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
