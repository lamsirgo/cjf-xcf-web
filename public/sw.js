/**
 * 极简 Service Worker：离线骨架 + 构建资源 stale-while-revalidate。
 * 不拦截 /api、/files 等接口请求，避免破坏登录与上传。
 * 升级时修改 SW_VERSION 即可使旧缓存失效。
 */
var SW_VERSION = 'v1';
var PRECACHE = 'precache-' + SW_VERSION;
var RUNTIME = 'runtime-' + SW_VERSION;
var CORE_ASSETS = ['/', '/offline.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then(function (cache) {
        return cache.addAll(CORE_ASSETS).catch(function () {});
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k !== PRECACHE && k !== RUNTIME;
            })
            .map(function (k) {
              return caches.delete(k);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先，离线时回退到缓存骨架，再回退离线页
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (resp) {
          var copy = resp.clone();
          caches.open(RUNTIME).then(function (cache) {
            cache.put('/', copy);
          });
          return resp;
        })
        .catch(function () {
          return caches.match('/').then(function (cached) {
            return cached || caches.match('/offline.html');
          });
        })
    );
    return;
  }

  // 构建产物（hashed assets）：stale-while-revalidate，使应用壳离线可用
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        var network = fetch(req)
          .then(function (resp) {
            if (resp && resp.status === 200) {
              var copy = resp.clone();
              caches.open(RUNTIME).then(function (cache) {
                cache.put(req, copy);
              });
            }
            return resp;
          })
          .catch(function () {
            return cached;
          });
        return cached || network;
      })
    );
  }
});
