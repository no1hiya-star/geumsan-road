// ===== 설정 =====
const KAKAO_KEY = '2e312668c20f308bb346d95aba4d13ec';
const DATA_FILES = [
  './chungnam_2m.geojson',
  './chungnam_3m_1.geojson',
  './chungnam_3m_2.geojson',
  './chungnam_4m.geojson'
];
const AHEAD_DIST = 120;   // 전방 감시 거리 (m)
const ON_ROAD_DIST = 20;  // 현재 도로 위 판단 거리 (m)
const CONE_DEG = 30;      // 진행방향 좌우 각도 (도)
const STEP_M = 15;        // 선분 분할 간격 (m)
const CELL = 0.0006;      // 격자 크기 (도, 약 60m)
const DRAW_MAX_LEVEL = 6; // 카카오맵 레벨이 이 값 이하일 때만 도로선 표시

let map = null;
let satelliteOn = false;
let windyOpen = false;
let windyLayer = 'wind';

const VEHICLES = [
  { short: '카프차',   width: 1.73,  length: 4.905, height: 2.42 },
  { short: '소형펌프', width: 2.1,   length: 6.675, height: 2.65 },
  { short: '중형',     width: 2.44,  length: 7.795, height: 3.1 },
  { short: '대형급',   width: 2.495, length: 8.44,  height: 3.55 }
];

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

let followOn = true, voiceOn = true, gpsOn = true;
let watchId = null, lastPos = null, prevPos = null, curHeading = null;
let gpsOverlay = null, gpsCircle = null, infoWin = null;
let items = [];
let grid = new Map();
let lastSpokenKey = '';
let lastSpokenTime = 0;

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
  banner.className = cls || '';
  banner.innerHTML = title + (sub ? `<small>${sub}</small>` : '');
}

// ===== 카카오맵 SDK 불러오기 =====
if (!KAKAO_KEY || KAKAO_KEY.indexOf('여기에') === 0) {
  setBanner('danger', 'JavaScript 키를 넣어 주세요', 'app.js 맨 위 KAKAO_KEY 값을 확인하세요');
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

  kakao.maps.event.addListener(map, 'idle', () => {
    updateVisible();
    if (windyOpen && !lastPos) syncWindyToMap();
  });
  kakao.maps.event.addListener(map, 'dragstart', () => {
    followOn = false;
    document.getElementById('followBtn').classList.remove('on');
    document.getElementById('followBtn').textContent = '화면 고정 OFF';
  });

  setBanner('', '지도 준비됨', '충남 도로 데이터를 불러오는 중...');
  if (location.protocol.startsWith('http')) {
    loadGeoJsonFiles(DATA_FILES);
  } else {
    setBanner('warn', '웹 서버(GitHub Pages)에서 열어주세요', '로컬 파일 직접 실행 시 데이터 로드가 제한됩니다');
  }
}

// ===== 위성지도 전환 =====
function toggleMapType() {
  if (!map) return;
  satelliteOn = !satelliteOn;
  const btn = document.getElementById('mapTypeBtn');
  if (satelliteOn) {
    map.setMapTypeId(kakao.maps.MapTypeId.HYBRID);
    btn.classList.add('on');
    btn.textContent = '일반지도';
  } else {
    map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
    btn.classList.remove('on');
    btn.textContent = '위성지도';
  }
}

// ===== 윈디 패널 =====
function toggleWindyPanel() {
  windyOpen = !windyOpen;
  const panel = document.getElementById('windyPanel');
  const btn = document.getElementById('windyBtn');
  panel.classList.toggle('open', windyOpen);
  btn.classList.toggle('on', windyOpen);
  if (windyOpen) {
    syncWindyToMap();
  }
}

function setWindyLayer(layer) {
  windyLayer = layer;
  ['wind', 'rain', 'radar'].forEach(k => {
    const el = document.getElementById('wLayer' + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.classList.toggle('on', k === layer);
  });
  if (windyOpen) syncWindyToMap();
}

function syncWindyToMap() {
  const frame = document.getElementById('windyFrame');
  if (!frame) return;
  let lat = 36.107, lng = 127.488;
  if (lastPos) {
    lat = lastPos.lat;
    lng = lastPos.lng;
  } else if (map) {
    const c = map.getCenter();
    lat = c.getLat();
    lng = c.getLng();
  }
  const zoom = 11;
  const url = `https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=m/s&zoom=${zoom}&overlay=${encodeURIComponent(windyLayer)}&product=ecmwf&level=surface&lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}&detailLat=${lat.toFixed(4)}&detailLon=${lng.toFixed(4)}&marker=true`;
  frame.src = url;
}

// ===== 다중 GeoJSON 로딩 =====
async function loadGeoJsonFiles(files) {
  try {
    const mergedFeatures = [];
    for (let i = 0; i < files.length; i++) {
      setBanner('', '도로 데이터 불러오는 중...', `파일 (${i + 1}/${files.length}) 읽는 중`);
      const res = await fetch(files[i]);
      if (!res.ok) throw new Error(`${files[i]} (HTTP ${res.status})`);
      const d = await res.json();
      if (d && Array.isArray(d.features)) {
        mergedFeatures.push(...d.features);
      }
    }
    if (mergedFeatures.length === 0) {
      setBanner('danger', '도로 데이터 없음', '불러온 GeoJSON 피처가 없어요');
      return;
    }
    setBanner('', '도로 데이터 분석 중...', `총 ${mergedFeatures.length.toLocaleString()}개 구간 정리 중`);
    loadData({ type: 'FeatureCollection', features: mergedFeatures });
  } catch (err) {
    console.error('GeoJSON load error:', err);
    setBanner('danger', '도로 데이터를 못 불러왔어요', err.message || '파일명과 GitHub 업로드 여부를 확인해 주세요');
  }
}

// ===== 도로 데이터 및 공간 인덱스 =====
function styleOf(bt) {
  if (isNaN(bt)) return { color: '#7c3aed', weight: 3, style: 'shortdash' };
  const t = tierOf(bt);
  if (t === 'danger') return { color: '#e11d48', weight: 5, style: 'solid' };
  if (t === 'warn')   return { color: '#eab308', weight: 4.5, style: 'solid' };
  return { color: '#16a34a', weight: 4, style: 'solid' };
}

function vehiclePassSummary(bt) {
  if (isNaN(bt)) return '폭 정보 없음';
  const passable = VEHICLES.filter(v => v.width <= bt).map(v => v.short);
  if (passable.length === 0) return '전 차종 진입 불가 (도보·수관 연장 검토)';
  return '통과 가능: ' + passable.join(', ');
}

function loadData(data) {
  items.forEach(it => { if (it.pl) it.pl.setMap(null); });
  items = [];
  grid = new Map();

  const feats = data.features || [];
  feats.forEach(f => {
    const p = f.properties || {}, bt = readBT(p);
    if (!isNaN(bt) && bt > 4) return;
    getLines(f.geometry).forEach(line => {
      if (!line || line.length < 2) return;
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      const path = [];
      for (let i = 0; i < line.length; i++) {
        const lng = line[i][0], lat = line[i][1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        path.push(new kakao.maps.LatLng(lat, lng));
      }
      const item = {
        rn: p.RN || '도로명 미상',
        rbp: p.RBP_CN || '',
        bt: bt,
        tier: isNaN(bt) ? 'caution' : tierOf(bt),
        minLat, maxLat, minLng, maxLng,
        path: path,
        pl: null
      };
      items.push(item);
      indexLineToGrid(line, item);
    });
  });

  updateVisible();
  setBanner('', '충남 좁은길 안내 준비 완료', `총 ${items.length.toLocaleString()}개 도로 구간 로드됨`);
  if (gpsOn) startGPS();
}

function cellKey(lat, lng) {
  return Math.floor(lat / CELL) + '_' + Math.floor(lng / CELL);
}

function addSampleToGrid(lat, lng, item) {
  const k = cellKey(lat, lng);
  let arr = grid.get(k);
  if (!arr) { arr = []; grid.set(k, arr); }
  arr.push({ lat, lng, item });
}

function indexLineToGrid(line, item) {
  for (let i = 0; i < line.length - 1; i++) {
    const lng1 = line[i][0], lat1 = line[i][1];
    const lng2 = line[i + 1][0], lat2 = line[i + 1][1];
    const dist = haversine(lat1, lng1, lat2, lng2);
    const steps = Math.max(1, Math.ceil(dist / STEP_M));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      addSampleToGrid(lat1 + (lat2 - lat1) * t, lng1 + (lng2 - lng1) * t, item);
    }
  }
}

function updateVisible() {
  if (!map) return;
  const level = map.getLevel();
  if (level > DRAW_MAX_LEVEL) {
    items.forEach(it => { if (it.pl) { it.pl.setMap(null); it.pl = null; } });
    return;
  }
  const b = map.getBounds();
  const sw = b.getSouthWest(), ne = b.getNorthEast();
  const sLat = sw.getLat(), sLng = sw.getLng();
  const nLat = ne.getLat(), nLng = ne.getLng();

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const inView = !(it.maxLat < sLat || it.minLat > nLat || it.maxLng < sLng || it.minLng > nLng);
    if (inView) {
      if (!it.pl) {
        const st = styleOf(it.bt);
        const pl = new kakao.maps.Polyline({
          path: it.path,
          strokeWeight: st.weight,
          strokeColor: st.color,
          strokeOpacity: 0.9,
          strokeStyle: st.style
        });
        kakao.maps.event.addListener(pl, 'click', (mouseEvent) => {
          const tInfo = TIERS[it.tier];
          const btText = isNaN(it.bt) ? '미기재' : it.bt.toFixed(1) + 'm';
          const content = `<div style="padding:10px 12px;font-size:13px;line-height:1.5;min-width:200px;">
            <strong>${tInfo.mark}${it.rn}</strong> (${tInfo.name} · 폭 ${btText})<br/>
            <span style="color:#475569;">기점: ${it.rbp || '-'}</span><br/>
            <span style="color:#0f172a;font-weight:700;">${vehiclePassSummary(it.bt)}</span>
          </div>`;
          infoWin.setContent(content);
          infoWin.setPosition(mouseEvent.latLng);
          infoWin.open(map);
        });
        pl.setMap(map);
        it.pl = pl;
      }
    } else if (it.pl) {
      it.pl.setMap(null);
      it.pl = null;
    }
  }
}

// ===== GPS 및 전방 감지 =====
function startGPS() {
  if (!navigator.geolocation) {
    setBanner('danger', 'GPS 미지원 기기', '위치 서비스를 사용할 수 없습니다');
    return;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 10000
  });
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function onGpsError(err) {
  setBanner('warn', 'GPS 수신 대기 중', err.message || '위치 권한을 허용해 주세요');
}

function onPosition(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const acc = pos.coords.accuracy || 0;
  const spd = pos.coords.speed;
  const hdg = pos.coords.heading;

  if (hdg !== null && !isNaN(hdg) && (spd === null || spd > 0.8)) {
    curHeading = hdg;
  } else if (prevPos) {
    const moved = haversine(prevPos.lat, prevPos.lng, lat, lng);
    if (moved > 3) curHeading = bearing(prevPos.lat, prevPos.lng, lat, lng);
  }
  prevPos = { lat, lng };
  lastPos = { lat, lng };

  const ll = new kakao.maps.LatLng(lat, lng);
  if (!gpsOverlay) {
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 8px rgba(37,99,235,0.8);';
    gpsOverlay = new kakao.maps.CustomOverlay({ position: ll, content: el, zIndex: 25 });
    gpsOverlay.setMap(map);
  } else {
    gpsOverlay.setPosition(ll);
  }

  if (!gpsCircle) {
    gpsCircle = new kakao.maps.Circle({
      center: ll, radius: Math.min(acc, 50),
      strokeWeight: 1, strokeColor: '#2563eb', strokeOpacity: 0.4,
      fillColor: '#3b82f6', fillOpacity: 0.12
    });
    gpsCircle.setMap(map);
  } else {
    gpsCircle.setPosition(ll);
    gpsCircle.setRadius(Math.min(acc, 50));
  }

  if (followOn && map) map.panTo(ll);
  evaluateProximity(lat, lng, curHeading);
}

function evaluateProximity(lat, lng, hdg) {
  const rCells = Math.ceil((AHEAD_DIST / 111000) / CELL) + 1;
  const cLat = Math.floor(lat / CELL);
  const cLng = Math.floor(lng / CELL);

  let bestOnRoad = null;
  let bestAhead = null;

  for (let dLat = -rCells; dLat <= rCells; dLat++) {
    for (let dLng = -rCells; dLng <= rCells; dLng++) {
      const arr = grid.get((cLat + dLat) + '_' + (cLng + dLng));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const pt = arr[i];
        const dist = haversine(lat, lng, pt.lat, pt.lng);
        if (dist > AHEAD_DIST) continue;
        const it = pt.item;
        const tRank = TIERS[it.tier].rank;

        if (dist <= ON_ROAD_DIST) {
          if (!bestOnRoad || tRank < TIERS[bestOnRoad.item.tier].rank || (tRank === TIERS[bestOnRoad.item.tier].rank && dist < bestOnRoad.dist)) {
            bestOnRoad = { item: it, dist };
          }
        } else if (hdg !== null && !isNaN(hdg)) {
          const brg = bearing(lat, lng, pt.lat, pt.lng);
          if (angleDiff(hdg, brg) <= CONE_DEG) {
            if (!bestAhead || tRank < TIERS[bestAhead.item.tier].rank || (tRank === TIERS[bestAhead.item.tier].rank && dist < bestAhead.dist)) {
              bestAhead = { item: it, dist };
            }
          }
        }
      }
    }
  }

  if (bestOnRoad) {
    const it = bestOnRoad.item;
    const tInfo = TIERS[it.tier];
    const btStr = isNaN(it.bt) ? '폭 미상' : `폭 ${it.bt.toFixed(1)}m`;
    setBanner(it.tier, `${tInfo.mark}현재 좁은길 주행 중 (${tInfo.name} · ${btStr})`, `${it.rn} · ${vehiclePassSummary(it.bt)}`);
    speakAlert(`on_${it.rn}_${it.tier}`, `현재 ${it.rn}, 도로폭 ${isNaN(it.bt) ? '미상' : it.bt.toFixed(1) + '미터'} ${tInfo.name} 구간입니다.`);
  } else if (bestAhead) {
    const it = bestAhead.item;
    const tInfo = TIERS[it.tier];
    const dM = Math.round(bestAhead.dist);
    const btStr = isNaN(it.bt) ? '폭 미상' : `폭 ${it.bt.toFixed(1)}m`;
    setBanner(it.tier, `${tInfo.mark}전방 ${dM}m 좁은길 (${tInfo.name} · ${btStr})`, `${it.rn} · ${vehiclePassSummary(it.bt)}`);
    speakAlert(`ahead_${it.rn}_${it.tier}`, `전방 ${dM}미터 앞, ${it.rn}, 도로폭 ${isNaN(it.bt) ? '미상' : it.bt.toFixed(1) + '미터'} ${tInfo.name} 구간입니다.`);
  } else {
    setBanner('', '주변 4m 이하 좁은길 없음', '정상 주행 중 (감시 반경 120m)');
  }
}

function speakAlert(key, text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if (key === lastSpokenKey && now - lastSpokenTime < 15000) return;
  lastSpokenKey = key;
  lastSpokenTime = now;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 1.05;
  window.speechSynthesis.speak(u);
}

// ===== 버튼 제어 =====
function toggleGPS() {
  gpsOn = !gpsOn;
  const btn = document.getElementById('gpsBtn');
  btn.classList.toggle('on', gpsOn);
  btn.textContent = gpsOn ? 'GPS 추적 ON' : 'GPS 추적 OFF';
  if (gpsOn) startGPS();
  else { stopGPS(); setBanner('', 'GPS 추적 중지됨', '버튼을 눌러 다시 시작하세요'); }
}

function toggleFollow() {
  followOn = !followOn;
  const btn = document.getElementById('followBtn');
  btn.classList.toggle('on', followOn);
  btn.textContent = followOn ? '화면 고정 ON' : '화면 고정 OFF';
  if (followOn && lastPos && map) map.panTo(new kakao.maps.LatLng(lastPos.lat, lastPos.lng));
}

function toggleVoice() {
  voiceOn = !voiceOn;
  const btn = document.getElementById('voiceBtn');
  btn.classList.toggle('on', voiceOn);
  btn.textContent = voiceOn ? '음성 안내 ON' : '음성 안내 OFF';
  if (!voiceOn && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

// ===== 거리/방위각 수학 =====
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
