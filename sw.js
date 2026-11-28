const CACHE = 'geumsan-v10';
const TILE_CACHE = 'geumsan-tiles-v1';   // 도로 타일을 바꿨을 때만 이 번호를 올리세요
const PRECACHE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // 도로 타일: 저장해 둔 게 있으면 그걸 바로 쓰고, 없으면 받아서 저장
  if (/\/(t_\d+_\d+|index)\.json$/.test(url.pathname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(req).then(hit => hit || fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // 그 외: 인터넷이 되면 최신 파일, 안 되면 저장해 둔 파일
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req))
  );
});
