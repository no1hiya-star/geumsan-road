// ===== 설정 =====
const KAKAO_KEY = '2e312668c20f308bb346d95aba4d13ec';   // 카카오디벨로퍼스 > 플랫폼 키 > JavaScript 키
const AHEAD_DIST = 120;   // 전방 감시 거리 (m)
const ON_ROAD_DIST = 20;  // 이 거리 안이면 "현재 그 도로 위"로 판단 (m)
const CONE_DEG = 30;      // 진행방향 좌우 각도 (도)
const STEP_M = 10;        // 선을 쪼개는 간격 (m)
const CELL = 0.0006;      // 격자 크기 (도, 약 60m)
const DRAW_MAX_LEVEL = 6; // 카카오맵 레벨이 이 값 이하일 때만 도로선을 그림 (숫자가 작을수록 확대)

let map = null;
// 소방차 제원 (단위 m). 같은 묶음은 가장 큰 값 기준. height는 높이 데이터가 생기면 사용
const VEHICLES = [
  { short: '카프차',   width: 1.73,  length: 4.905, height: 2.42 },
  { short: '소형펌프', width: 2.1,   length: 6.675, height: 2.65 },
  { short: '중형',     width: 2.44,  length: 7.795, height: 3.1 },
  { short: '대형급',   width: 2.495, length: 8.44,  height: 3.55 }
];
// 도로 폭 단계: 위험 2m 이하 / 경계 3m 이하 / 관심 4m 이하
const TIERS = {
  danger:  { rank: 0, name: '위험', range: '2m 이하', mark: '⚠ ' },
  warn:    { rank: 1, name: '경계', range: '3m 이하', mark: '⚠ ' },
  caution: { rank: 2, name: '관심', range: '4m 이하', mark: '' }
};
function tierOf(bt) {
  if (bt <= 2) return 'danger';
  if (bt <= 3) return 'warn';
  return 'caution';
}
let followOn = true, voiceOn = true;
let watchId = null, lastPos = null, prevPos = null, curHeading = null;
let gpsOverlay = null, gpsCircle = null, infoWin = null;
let items = [];            // 지도에 그릴 도로선 (보이는 범위만 실제로 그림)
let grid = new Map();

function readBT(p) {
  const raw = p ? p.ROAD_BT : null;
  if (raw === null || raw === undefined || String(raw).trim() === '') return NaN;
  return Number(raw);
}

function getLines(geom) {
  if (!geom || !geom.coordinates) return [];
  return geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
}

// ===== 배너/알림 =====
const banner = document.getElementById('banner');
function setBanner(cls, title, sub) {
  banner.className = cls;
  banner.innerHTML = title + (sub ? `<small>${sub}</small>` : '');
}

// ===== 카카오맵 SDK 불러오기 =====
if (!KAKAO_KEY || KAKAO_KEY.indexOf('여기에') === 0) {
  setBanner('danger', 'JavaScript 키를 넣어 주세요', '코드 맨 위 KAKAO_KEY 값을 바꾸세요');
} else {
  const s = document.createElement('script');
  s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?appkey=' + encodeURIComponent(KAKAO_KEY) + '&autoload=false&libraries=services';
  s.onload = () => kakao.maps.load(initMap);
  s.onerror = () => setBanner('danger', '카카오맵을 불러오지 못했어요', '키·도메인 등록·카카오맵 사용 설정(ON)을 확인하세요');
  document.head.appendChild(s);
}

function initMap() {
  map = new kakao.maps.Map(document.getElementById('map'), {
    center: new kakao.maps.LatLng(36.107, 127.488), level: 4
  });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
  infoWin = new kakao.maps.InfoWindow({ removable: true, zIndex: 20 });
  kakao.maps.event.addListener(map, 'idle', updateVisible);
  kakao.maps.event.addListener(map, 'dragstart', () => {
    followOn = false; document.getElementById('followBtn').classList.remove('on');
  });
  setBanner('', '지도 준비됨', '도로 데이터를 불러오는 중...');
  if (location.protocol.startsWith('http')) {
    fetch('./geumsan.geojson').then(r => r.ok ? r.json() : null).then(d => { if (d) loadData(d); }).catch(() => {});
  }
}

// ===== 도로 데이터 =====
function styleOf(bt) {
  if (isNaN(bt)) return { color: '#7c3aed', weight: 3, style: 'shortdash' };
  const t = tierOf(bt);
  if (t === 'danger') return { color: '#e11d48', weight: 5, style: 'solid' };
  if (t === 'warn')   return { color: '#eab308', weight: 4.5, style: 'solid' };
  return { color: '#16a34a', weight: 4, style: 'solid' };
}

function loadData(data) {
  items.forEach(it => { if (it.pl) it.pl.setMap(null); });
  items = [];
  const feats = data.features || [];
  feats.forEach(f => {
    const p = f.properties || {}, bt = readBT(p);
    if (!isNaN(bt) && bt > 4) return;  // 넓은 도로는 카카오맵 배경에 이미 보이므로 안 그림
    getLines(f.geometry).forEach(line => {
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      line.forEach(([x, y]) => {
        if (y < minLat) minLat = y; if (y > maxLat) maxLat = y;
        if (x < minLng) minLng = x; if (x > maxLng) maxLng = x;
      });
      items.push({ line, bt, rn: p.RN, rbp: p.RBP_CN, bbox: [minLat, minLng, maxLat, maxLng], pl: null, shown: false });
    });
  });
  buildGrid(feats);
  setBanner('', '도로 데이터 불러옴', `도로 ${feats.length.toLocaleString()}개`);
  updateVisible();
}

// 지도에 보이는 범위의 도로선만 실제로 그림 (폰에서 느려지는 것 방지)
function updateVisible() {
  if (!map || items.length === 0) return;
  const level = map.getLevel();
  const draw = level <= DRAW_MAX_LEVEL;
  const b = map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast();
  const padLat = (ne.getLat() - sw.getLat()) * 0.2, padLng = (ne.getLng() - sw.getLng()) * 0.2;
  const s = sw.getLat() - padLat, n = ne.getLat() + padLat, w = sw.getLng() - padLng, e = ne.getLng() + padLng;
  items.forEach(it => {
    const [a1, b1, a2, b2] = it.bbox;
    const inView = draw && !(a2 < s || a1 > n || b2 < w || b1 > e);
    if (inView && !it.shown) {
      if (!it.pl) {
        const st = styleOf(it.bt);
        it.pl = new kakao.maps.Polyline({
          path: it.line.map(([x, y]) => new kakao.maps.LatLng(y, x)),
          strokeWeight: st.weight, strokeColor: st.color, strokeOpacity: 0.95, strokeStyle: st.style
        });
        kakao.maps.event.addListener(it.pl, 'click', ev => {
          infoWin.setContent(`<div style="padding:6px 8px;font-size:12px;">` +
            `<b>${it.rn || '도로명 없음'}</b><br>도로폭: <b>${isNaN(it.bt) ? '정보 없음' : it.bt + ' m'}</b><br>${it.rbp || ''}</div>`);
          infoWin.setPosition(ev.latLng);
          infoWin.open(map);
        });
      }
      it.pl.setMap(map); it.shown = true;
    } else if (!inView && it.shown) {
      it.pl.setMap(null); it.shown = false;
    }
  });
}

// ===== 거리/방향 계산 =====
const R = 6371000, toRad = x => x * Math.PI / 180;
function dist(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(lat1, lng1, lat2, lng2) {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// ===== 검색용 격자 (폭 4m 이하 도로, 10m 간격 점) =====
function buildGrid(features) {
  grid = new Map();
  features.forEach(f => {
    const p = f.properties || {}, bt = readBT(p);
    if (isNaN(bt) || bt > 4) return;
    getLines(f.geometry).forEach(line => {
      for (let i = 0; i < line.length - 1; i++) {
        const [x1, y1] = line[i], [x2, y2] = line[i + 1];
        const steps = Math.max(1, Math.ceil(dist(y1, x1, y2, x2) / STEP_M));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          addPt(y1 + (y2 - y1) * t, x1 + (x2 - x1) * t, bt, p.RN || '이름 없음');
        }
      }
    });
  });
}
function addPt(lat, lng, bt, rn) {
  const key = Math.floor(lat / CELL) + '_' + Math.floor(lng / CELL);
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push({ lat, lng, bt, rn });
}
function nearbyPts(lat, lng, radiusM) {
  const r = Math.ceil((radiusM / 111000) / CELL) + 1;
  const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
  const out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const arr = grid.get((cy + dy) + '_' + (cx + dx));
    if (arr) for (const p of arr) out.push(p);
  }
  return out;
}

// ===== 음성 안내 / 보조 경고음 / 진동 =====
let audioCtx = null, lastAlertKey = '', lastAlertTime = 0;

function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.05;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}

function beep(freq, ms) {
  try {
    if (!audioCtx) return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.value = 0.12;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + ms / 1000);
  } catch (e) {}
}

function alertUser(key, level, msg) {
  const now = Date.now();
  if (key === lastAlertKey && now - lastAlertTime < 15000) return;
  lastAlertKey = key; lastAlertTime = now;

  if (level === 'danger') {
    if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
    beep(1000, 200);
    speak(msg || '위험 구역입니다.');
  } else if (level === 'warn') {
    beep(700, 150);
    speak(msg || '경계 구역입니다.');
  } else if (level === 'caution') {
    speak(msg || '관심 구역입니다.');
  }
}

// ===== 위치 추적 =====
function onPosition(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;
  let heading = pos.coords.heading;
  if ((heading === null || isNaN(heading)) && prevPos && dist(prevPos[0], prevPos[1], lat, lng) > 5) {
    heading = bearing(prevPos[0], prevPos[1], lat, lng);
  }
  if (prevPos === null || dist(prevPos[0], prevPos[1], lat, lng) > 5) prevPos = [lat, lng];
  if (heading !== null && heading !== undefined && !isNaN(heading)) curHeading = heading;
  lastPos = [lat, lng];

  if (map) {
    const ll = new kakao.maps.LatLng(lat, lng);
    if (!gpsOverlay) {
      gpsOverlay = new kakao.maps.CustomOverlay({
        position: ll, xAnchor: 0.5, yAnchor: 0.5, zIndex: 10,
        content: '<div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>'
      });
      gpsOverlay.setMap(map);
      gpsCircle = new kakao.maps.Circle({
        map, center: ll, radius: accuracy, strokeWeight: 1, strokeColor: '#2563eb',
        strokeOpacity: 0.8, fillColor: '#2563eb', fillOpacity: 0.1
      });
      map.setCenter(ll); map.setLevel(3);
    } else {
      gpsOverlay.setPosition(ll);
      gpsCircle.setPosition(ll); gpsCircle.setRadius(accuracy);
    }
    if (followOn) map.panTo(ll);
  }
  checkAhead(lat, lng, accuracy, speed);
}

function checkAhead(lat, lng, accuracy, speed) {
  if (grid.size === 0) { setBanner('', '도로 데이터 없음', '잠시 후 다시 시도해 주세요'); return; }
  const moving = speed !== null && speed !== undefined && speed > 1.5 && curHeading !== null;
  const pts = nearbyPts(lat, lng, AHEAD_DIST);

  // 지금 있는 도로 (가장 가까운 점)
  let nearest = null, nd = Infinity;
  pts.forEach(p => { const d = dist(lat, lng, p.lat, p.lng); if (d < nd) { nd = d; nearest = p; } });

  // 전방의 좁은 도로: 가장 심한 단계 우선, 같으면 가까운 쪽
  let ahead = null, ad = Infinity, aRank = 99;
  pts.forEach(p => {
    const d = dist(lat, lng, p.lat, p.lng);
    if (d > AHEAD_DIST) return;
    if (moving && d > 15 && angDiff(bearing(lat, lng, p.lat, p.lng), curHeading) > CONE_DEG) return;
    const rank = TIERS[tierOf(p.bt)].rank;
    if (rank < aRank || (rank === aRank && d < ad)) { ahead = p; ad = d; aRank = rank; }
  });

  const accNote = accuracy > 30 ? ` · GPS 오차 ${Math.round(accuracy)}m` : '';

  if (nearest && nd <= ON_ROAD_DIST) {
    const k = tierOf(nearest.bt), t = TIERS[k];
    setBanner(k, `${t.mark}${t.name} 구간 · ${t.range}`, `${nearest.rn}${accNote}`);
    alertUser('on_' + nearest.rn + k, k, `${t.name} 구역입니다.`);
  } else if (ahead) {
    const k = tierOf(ahead.bt), t = TIERS[k];
    const distRound = Math.max(10, Math.round(ad / 10) * 10);
    setBanner(k, `전방 ${Math.round(ad)}m · ${t.name} 구간 (${t.range})`, `${ahead.rn}${accNote}`);
    alertUser('ahead_' + ahead.rn + k, k, `전방 ${distRound}미터, ${t.name} 구역입니다.`);
  } else {
    setBanner('ok', `전방 ${AHEAD_DIST}m 내 4m 이하 좁은 도로 없음`, accNote.replace(' · ', ''));
  }
}

// 정밀 GPS가 안 잡히면(실내 등) 일반 위치로 다시 시도
function startWatch(high) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, err => {
    if (err.code === 1) {
      setBanner('danger', '위치 권한이 꺼져 있어요', '브라우저 주소창 옆 설정과 폰의 위치 설정에서 허용해 주세요');
      return;
    }
    if (high) {
      setBanner('', '정밀 GPS 대기 중...', '실내에서는 정확도가 낮아요. 일반 위치로 시도합니다');
      startWatch(false);
      return;
    }
    setBanner('danger', '위치를 못 가져왔어요', (err.code === 2 ? '이 기기에서 위치를 알 수 없음' : '시간 초과') + ' (' + err.message + ')');
  }, { enableHighAccuracy: high, maximumAge: 1000, timeout: high ? 10000 : 20000 });
}

// ===== 주소/장소 검색 =====
let destMarker = null;
const resultsEl = document.getElementById('results');

function runSearch() {
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  if (!map || !(kakao.maps && kakao.maps.services)) { alert('지도가 아직 준비되지 않았어요.'); return; }
  const St = kakao.maps.services.Status;
  const list = [];
  let pending = 2;
  const done = () => { if (--pending === 0) showResults(list); };

  new kakao.maps.services.Geocoder().addressSearch(q, (res, status) => {
    if (status === St.OK) res.slice(0, 5).forEach(r => list.push({
      name: r.address_name,
      sub: (r.road_address && r.road_address.address_name !== r.address_name) ? r.road_address.address_name : '주소',
      x: Number(r.x), y: Number(r.y)
    }));
    done();
  });
  new kakao.maps.services.Places().keywordSearch(q, (res, status) => {
    if (status === St.OK) res.slice(0, 8).forEach(r => list.push({
      name: r.place_name, sub: r.road_address_name || r.address_name, x: Number(r.x), y: Number(r.y)
    }));
    done();
  }, { location: map.getCenter(), size: 8 });
}

function showResults(list) {
  // 같은 좌표 중복 제거
  const seen = new Set();
  list = list.filter(it => { const k = it.x.toFixed(4) + ',' + it.y.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; });
  resultsEl.innerHTML = '';
  if (list.length === 0) {
    const d = document.createElement('div'); d.className = 'empty'; d.textContent = '검색 결과가 없어요';
    resultsEl.appendChild(d);
  } else {
    list.forEach(it => {
      const d = document.createElement('div'); d.className = 'item';
      d.appendChild(document.createTextNode(it.name));
      const sm = document.createElement('small'); sm.textContent = it.sub; d.appendChild(sm);
      d.onclick = () => gotoPlace(it);
      resultsEl.appendChild(d);
    });
  }
  resultsEl.style.display = 'block';
}

function gotoPlace(it) {
  const ll = new kakao.maps.LatLng(it.y, it.x);
  if (!destMarker) destMarker = new kakao.maps.Marker({ position: ll, map });
  else { destMarker.setPosition(ll); destMarker.setMap(map); }
  followOn = false; document.getElementById('followBtn').classList.remove('on');
  map.setCenter(ll); map.setLevel(3);
  const box = document.createElement('div');
  box.style.cssText = 'padding:6px 8px;font-size:12px;';
  const b = document.createElement('b'); b.textContent = it.name; box.appendChild(b);
  box.appendChild(document.createElement('br')); box.appendChild(document.createTextNode(it.sub));
  infoWin.setContent(box); infoWin.open(map, destMarker);
  resultsEl.style.display = 'none';
}

document.getElementById('searchBtn').onclick = runSearch;
document.getElementById('q').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

// 안내 중에는 화면이 꺼지지 않게 유지
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null) requestWakeLock();
});

function startTracking() {
  if (!navigator.geolocation) { alert('이 기기는 위치 기능을 지원하지 않아요.'); return; }
  if (watchId !== null) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  if (location.protocol === 'file:') {
    setBanner('danger', '위치 사용 불가', '파일로 직접 열면 안 돼요. localhost 또는 https 주소로 여세요');
    return;
  }
  speak('안내를 시작합니다.');
  setBanner('', '위치 확인 중...', '');
  startWatch(true);
  requestWakeLock();
  const b = document.getElementById('startBtn');
  b.textContent = '● 안내 중'; b.classList.add('on');
}

// 범례를 아래쪽 검색·버튼 영역 바로 위에, 간격을 두고 띄움 (줄이 늘어나도 자동으로 따라감)
const uiBar = document.getElementById('bar'), uiLegend = document.getElementById('legend');
function placeLegend() { uiLegend.style.bottom = (uiBar.offsetHeight + 14) + 'px'; }
placeLegend();
window.addEventListener('resize', placeLegend);
if (window.ResizeObserver) new ResizeObserver(placeLegend).observe(uiBar);

document.getElementById('startBtn').onclick = startTracking;
document.getElementById('voiceBtn').onclick = e => {
  voiceOn = !voiceOn;
  e.target.classList.toggle('on', voiceOn);
  e.target.textContent = voiceOn ? '🔊 음성' : '🔇 음소거';
  if (voiceOn) speak('음성 안내를 켭니다.');
  else if ('speechSynthesis' in window) window.speechSynthesis.cancel();
};
document.getElementById('followBtn').onclick = e => {
  followOn = !followOn;
  e.target.classList.toggle('on', followOn);
  if (followOn && lastPos && map) map.setCenter(new kakao.maps.LatLng(lastPos[0], lastPos[1]));
};

// ===== Windy 기상 지도 (내 위치 또는 지도 중심 기준) =====
function windyUrl(lat, lng, ov) {
  return 'https://embed.windy.com/embed2.html?lat=' + lat.toFixed(4) + '&lon=' + lng.toFixed(4) +
    '&zoom=10&level=surface&overlay=' + ov + '&menu=&message=&marker=true&calendar=now&pressure=&type=map' +
    '&location=coordinates&detail=&detailLat=' + lat.toFixed(4) + '&detailLon=' + lng.toFixed(4) +
    '&metricWind=default&metricTemp=default&radarRange=-1';
}
function loadWindy() {
  let lat = 36.107, lng = 127.488;
  if (lastPos) { lat = lastPos[0]; lng = lastPos[1]; }
  else if (map) { const c = map.getCenter(); lat = c.getLat(); lng = c.getLng(); }
  document.getElementById('windFrame').src = windyUrl(lat, lng, document.getElementById('windOv').value);
}
document.getElementById('windBtn').onclick = () => {
  loadWindy();
  document.getElementById('windy').style.display = 'flex';
};
document.getElementById('windClose').onclick = () => {
  document.getElementById('windy').style.display = 'none';
  document.getElementById('windFrame').src = 'about:blank';   // 닫으면 데이터 사용 중지
};
document.getElementById('windOv').onchange = loadWindy;

// 일반 지도 <-> 위성 지도(지명 포함) 전환
let satOn = false;
document.getElementById('satBtn').onclick = e => {
  if (!map) return;
  satOn = !satOn;
  map.setMapTypeId(satOn ? kakao.maps.MapTypeId.HYBRID : kakao.maps.MapTypeId.ROADMAP);
  e.target.classList.toggle('on', satOn);
  e.target.textContent = satOn ? '🗺 일반 지도' : '🛰 위성';
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
