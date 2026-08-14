// ---- Firebase (家族間のリアルタイム共有・オフライン永続化) ----

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBGDeRfj2BrSV4i1VpHxVaZ0rNHS6LxB8w',
  authDomain: 'disneyparkscheduler.firebaseapp.com',
  projectId: 'disneyparkscheduler',
  storageBucket: 'disneyparkscheduler.firebasestorage.app',
  messagingSenderId: '397626063842',
  appId: '1:397626063842:web:038a598d7674098ba617bb'
};

const fbApp = initializeApp(firebaseConfig);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true
});

// 「合言葉」代わりのルームコード。同じコード(=同じURL)を開いた人同士でデータを共有する。
const ROOM_KEY = 'tdl-schedule:room';

export function getOrCreateRoomCode() {
  const url = new URL(location.href);
  let room = url.searchParams.get('room') || localStorage.getItem(ROOM_KEY);
  if (!room) room = Math.random().toString(36).slice(2, 8);
  localStorage.setItem(ROOM_KEY, room);
  url.searchParams.set('room', room);
  history.replaceState(null, '', url);
  return room;
}

export const roomCode = getOrCreateRoomCode();

function dayDocRef() {
  return doc(db, 'rooms', roomCode, 'days', `${state.park}_${state.date}`);
}

function durationsDocRef() {
  return doc(db, 'rooms', roomCode, 'meta', 'durations');
}

// ---- 定数 ----

// 当日のパーク情報ページは /daily/calendar/YYYYMMDD/ の形式で日付を指定できる。
// レストラン/アトラクション一覧ページの日付指定URLは未確認のため、ひとまず日付なしの固定URL。
function officialLinks(park, dateStr) {
  const ymd = dateStr.replace(/-/g, '');
  return {
    calendar: `https://www.tokyodisneyresort.jp/${park}/daily/calendar/${ymd}`,
    restaurant: `https://www.tokyodisneyresort.jp/${park}/restaurant/list.html`,
    attraction: `https://www.tokyodisneyresort.jp/${park}/attraction.html`
  };
}

const AREA_LIST = [
  'ワールドバザール', 'アドベンチャーランド', 'ウエスタンランド', 'クリッターカントリー',
  'ファンタジーランド', 'トゥーンタウン', 'トゥモローランド',
  'メディテレーニアンハーバー', 'アメリカンウォーターフロント', 'ポートディスカバリー',
  'ロストリバーデルタ', 'アラビアンコースト', 'マーメイドラグーン', 'ミステリアスアイランド',
  'ファンタジースプリングス', 'パーク内', 'パーク外'
];

// 長い/具体的なものを先に判定する
const STATUS_LIST = [
  '終日運営・公演中止', '一時運営中止', '案内終了',
  'ディズニー・モバイルオーダー注文受付中', '運営中'
];

const TAG_LIST = [
  'ディズニー・プレミアアクセス対象', 'エントリー受付対象', '予約が必須', 'ショーレストラン',
  'プライオリティ・シーティング対応', 'ディズニー・モバイルオーダー対象',
  '40周年記念プライオリティパス対象', 'シングルライダー対象', '事前予約制'
];

const TYPE_LABEL = {
  parkhours: '開園時間', show: 'ショー', greeting: 'グリーティング',
  attraction: 'アトラクション', restaurant: 'レストラン', custom: '自由入力'
};

// ---- ユーティリティ ----

function genId() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function normalizeTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return t;
  return m[1].padStart(2, '0') + ':' + m[2];
}

// ---- パース処理 ----

function splitBlocks(text) {
  const lines = text.split('\n').map(l => l.trim());
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(.+?)のイメージ$/);
    if (m) {
      if (current) blocks.push(current);
      current = { name: m[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function extractArea(lines) {
  for (const l of lines) {
    if (AREA_LIST.includes(l)) return l;
  }
  return '';
}

function extractStatus(joined) {
  for (const s of STATUS_LIST) {
    if (joined.includes(s)) return s;
  }
  return '';
}

function extractTags(joined) {
  return TAG_LIST.filter(t => joined.includes(t));
}

function extractWait(joined) {
  let m = joined.match(/(\d+)\s*[-–]\s*(\d+)\s*分待ち/);
  if (m) return `${m[1]}-${m[2]}分待ち`;
  m = joined.match(/(\d+)\s*分待ち/);
  if (m) return `${m[1]}分待ち`;
  if (joined.includes('待ち時間は施設でご確認ください')) return '待ち時間は施設で確認';
  return '';
}

function extractRanges(joined) {
  const re = /(\d{1,2}:\d{2})\s*[–\-—]\s*(\d{1,2}:\d{2})/g;
  const out = [];
  let m;
  while ((m = re.exec(joined))) {
    out.push({ start: normalizeTime(m[1]), end: normalizeTime(m[2]) });
  }
  return out;
}

// ショーの実施時刻は「10:00 / 12:50 / 14:55」のような複数表記と「17:00」のような単独表記が
// 混在するため、ブロック内のHH:MM表記を区切り文字に関係なくすべて拾う。
function extractAllTimes(joined) {
  const re = /\d{1,2}:\d{2}/g;
  const matches = joined.match(re) || [];
  return matches.map(normalizeTime);
}

// ショー詳細ページ（例: /tdl/show/detail/xxxx/）から読み取った実際の公演時間。
// パーク/日付をまたがず、ルーム(家族)単位でFirestoreに永続化・共有する。
let durationOverridesCache = {};

function loadDurationOverrides() {
  return durationOverridesCache;
}

function saveDurationOverrides(map) {
  durationOverridesCache = map;
  setDoc(durationsDocRef(), { overrides: map, updatedAt: serverTimestamp() })
    .catch(err => console.error('duration sync failed', err));
}

// ショー詳細ページのテキストから「パンくずの末尾（ショー名）」と「公演時間：約◯分」を
// ページ単位（パンくず行を区切りとして）で対応付けて抽出する。複数ページ分の連結貼り付けにも対応。
function parseShowDurations(text) {
  const breadcrumbRe = /^HOME[^\n]*パレード\/ショー(.+)$/gm;
  const matches = [...text.matchAll(breadcrumbRe)];
  const results = [];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const chunk = text.slice(start, end);
    const durMatch = chunk.match(/公演時間\s*[:：]\s*約?\s*(\d+)\s*分/);
    if (name && durMatch) {
      results.push({ name, minutes: parseInt(durMatch[1], 10) });
    }
  }
  return results;
}

// 詳細ページで所要時間が判明していればそれを使い、未設定のショーのみ名称から大まかに推定する。
// 終了時刻は目安として自動入力し、ユーザーが必要に応じて編集する前提。
function guessDurationMinutes(item) {
  if (!item || item.type !== 'show') return null;
  const overrides = loadDurationOverrides();
  if (typeof overrides[item.name] === 'number') return overrides[item.name];
  return item.name.includes('パレード') ? 45 : 20;
}

function isDurationKnown(item) {
  if (!item || item.type !== 'show') return false;
  const overrides = loadDurationOverrides();
  return typeof overrides[item.name] === 'number';
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = ((h * 60 + m + minutes) % (24 * 60) + 24 * 60) % (24 * 60);
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return String(nh).padStart(2, '0') + ':' + String(nm).padStart(2, '0');
}

function parseFacilityList(text, type) {
  const blocks = splitBlocks(text);
  const items = [];
  for (const b of blocks) {
    if (!b.name) continue;
    const joined = b.lines.join('\n');
    items.push({
      id: genId(), type, name: b.name,
      area: extractArea(b.lines),
      status: extractStatus(joined),
      tags: extractTags(joined),
      wait: extractWait(joined),
      ranges: extractRanges(joined),
      times: []
    });
  }
  return items;
}

function parseDailyCalendar(text) {
  const items = [];

  const hoursMatch = text.match(/開園時間\s*\n\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (hoursMatch) {
    items.push({
      id: genId(), type: 'parkhours', name: '開園時間', area: '', status: '', tags: [], wait: '',
      ranges: [{ start: normalizeTime(hoursMatch[1]), end: normalizeTime(hoursMatch[2]) }], times: []
    });
  }

  const showSection = text.match(/パレード\/ショー([\s\S]*?)(?:キャラクターグリーティング|当日の運営状況の詳細はこちら|休止情報|$)/);
  const greetSection = text.match(/キャラクターグリーティング([\s\S]*?)(?:当日の運営状況の詳細はこちら|定員に達した場合|休止情報|$)/);

  if (showSection) {
    for (const b of splitBlocks(showSection[1])) {
      if (!b.name) continue;
      const joined = b.lines.join('\n');
      items.push({
        id: genId(), type: 'show', name: b.name, area: '', status: '',
        tags: extractTags(joined), wait: '',
        ranges: [], times: extractAllTimes(joined)
      });
    }
  }
  if (greetSection) {
    for (const b of splitBlocks(greetSection[1])) {
      if (!b.name) continue;
      const joined = b.lines.join('\n');
      items.push({
        id: genId(), type: 'greeting', name: b.name, area: '', status: '',
        tags: extractTags(joined), wait: '',
        ranges: extractRanges(joined), times: []
      });
    }
  }
  return items;
}

// ---- 状態管理 ----

export const state = {
  park: 'tdl',
  date: todayStr(),
  items: [],
  schedule: [],
  activeTab: 'list',
  activeType: 'all',
  search: ''
};

// items/schedule は1つのFirestoreドキュメント(パーク×日付ごと)にまとめて保存し、
// onSnapshotでリアルタイムに家族間で同期する。Firestoreの永続キャッシュにより
// オフライン時もローカルの読み書きは即座に反映され、オンライン復帰時に自動同期される。
let unsubscribeDayDoc = null;
let unsubscribeDurations = null;

function subscribeDayDoc() {
  if (unsubscribeDayDoc) unsubscribeDayDoc();
  unsubscribeDayDoc = onSnapshot(dayDocRef(), (snap) => {
    const data = snap.data();
    state.items = (data && data.items) || [];
    state.schedule = (data && data.schedule) || [];
    renderItemList();
    renderSchedule();
    setSyncStatus(snap.metadata.fromCache ? 'offline' : 'online');
  }, (err) => {
    console.error('day doc sync failed', err);
    setSyncStatus('offline');
  });
}

function subscribeDurations() {
  if (unsubscribeDurations) unsubscribeDurations();
  unsubscribeDurations = onSnapshot(durationsDocRef(), (snap) => {
    const data = snap.data();
    durationOverridesCache = (data && data.overrides) || {};
    renderItemList();
    renderSchedule();
  }, (err) => console.error('durations sync failed', err));
}

function setSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.className = 'sync-status ' + status;
  el.textContent = status === 'online' ? '同期中' : 'オフライン(端末に保存済み)';
}

function writeDayDoc() {
  setDoc(dayDocRef(), {
    items: state.items,
    schedule: state.schedule,
    updatedAt: serverTimestamp()
  }).catch(err => console.error('day doc write failed', err));
}

function saveItems() { writeDayDoc(); }
function saveSchedule() { writeDayDoc(); }

// ---- レンダリング ----

function updateOfficialLinks() {
  const links = officialLinks(state.park, state.date);
  document.getElementById('link-calendar').href = links.calendar;
  document.getElementById('link-restaurant').href = links.restaurant;
  document.getElementById('link-attraction').href = links.attraction;
}

function formatTimeInfo(item) {
  const parts = [];
  if (item.ranges && item.ranges.length) {
    parts.push(item.ranges.map(r => `${r.start}–${r.end}`).join(' / '));
  }
  if (item.times && item.times.length) {
    parts.push(item.times.join(' / '));
  }
  if (!parts.length) parts.push('時刻情報なし');
  return parts.join(' ・ ');
}

function renderItemList() {
  const container = document.getElementById('item-list');
  const q = state.search.trim();
  const filtered = state.items.filter(it => {
    // 開園時間はスケジュールに自動反映されるため一覧には出さない
    if (it.type === 'parkhours') return false;
    if (state.activeType !== 'all' && it.type !== state.activeType) return false;
    if (q && !it.name.includes(q)) return false;
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = '<p class="empty-msg">データがありません。上の「データ取り込み」からペーストして解析してください。</p>';
    return;
  }

  container.innerHTML = '';
  for (const it of filtered) {
    const card = document.createElement('div');
    card.className = 'item-card';
    const tagHtml = it.tags.length ? `<div class="item-card-tags">${it.tags.map(t => `<span>${t}</span>`).join('')}</div>` : '';
    const durationBits = [];
    if (it.type === 'show') {
      const dur = guessDurationMinutes(it);
      durationBits.push(isDurationKnown(it) ? `所要時間: ${dur}分` : `所要時間: 約${dur}分（推定・④で設定可）`);
    }
    const metaBits = [it.area, it.status, it.wait, ...durationBits].filter(Boolean).join(' ・ ');
    card.innerHTML = `
      <div class="item-card-main">
        <div class="item-card-title"><span class="type-badge">${TYPE_LABEL[it.type] || it.type}</span>${it.name}</div>
        <div class="item-card-meta">${formatTimeInfo(it)}</div>
        ${metaBits ? `<div class="item-card-meta">${metaBits}</div>` : ''}
        ${tagHtml}
      </div>
      <button class="add-btn" data-id="${it.id}">追加</button>
    `;
    card.querySelector('.add-btn').addEventListener('click', () => openAddModal(it));
    container.appendChild(card);
  }
}

function computeOverlaps(sortedSchedule) {
  const overlapIds = new Set();
  // 開園時間は他の予定を内包する背景情報であり、重なり判定の対象にしない
  const targets = sortedSchedule.filter(s => s.type !== 'parkhours');
  for (let i = 0; i < targets.length - 1; i++) {
    const cur = targets[i];
    const next = targets[i + 1];
    if (!cur.end) continue;
    if (next.time < cur.end) {
      overlapIds.add(cur.id);
      overlapIds.add(next.id);
    }
  }
  return overlapIds;
}

export function renderSchedule() {
  const container = document.getElementById('schedule-list');
  const sorted = [...state.schedule].sort((a, b) => a.time.localeCompare(b.time));
  const overlapIds = computeOverlaps(sorted);

  if (!sorted.length) {
    container.innerHTML = '<p class="empty-msg">まだ予定がありません。一覧タブから「追加」してください。</p>';
  } else {
    container.innerHTML = '';
    for (const s of sorted) {
      const card = document.createElement('div');
      card.className = 'schedule-card' + (overlapIds.has(s.id) ? ' overlap' : '');
      card.innerHTML = `
        <div class="schedule-time">${s.time}${s.end ? '–' + s.end : ''}</div>
        <div class="item-card-main">
          <div class="item-card-title"><span class="type-badge">${TYPE_LABEL[s.type] || s.type}</span>${s.name}</div>
          ${s.note ? `<div class="item-card-meta">${s.note}</div>` : ''}
        </div>
        <div class="schedule-card-actions">
          <button class="edit-btn" data-id="${s.id}" aria-label="編集">編集</button>
          <button class="remove-btn" data-id="${s.id}" aria-label="削除">×</button>
        </div>
      `;
      card.querySelector('.edit-btn').addEventListener('click', () => openEditModal(s));
      card.querySelector('.remove-btn').addEventListener('click', () => {
        state.schedule = state.schedule.filter(x => x.id !== s.id);
        saveSchedule();
        renderSchedule();
      });
      container.appendChild(card);
    }
  }

  renderGantt(sorted);
}

// ---- タイムチャート(横向きガントチャート) ----

const GANTT_PX_PER_MIN = 3;
const GANTT_TYPE_CLASSES = ['attraction', 'show', 'restaurant', 'greeting', 'custom'];

export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function renderGantt(sortedSchedule) {
  const wrap = document.getElementById('gantt-wrap');
  const emptyMsg = document.getElementById('gantt-empty');
  const rows = sortedSchedule.filter(s => s.type !== 'parkhours' && GANTT_TYPE_CLASSES.includes(s.type));

  if (!rows.length) {
    wrap.hidden = true;
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;
  wrap.hidden = false;

  const parkhours = sortedSchedule.find(s => s.type === 'parkhours');
  let startMin = parkhours ? timeToMinutes(parkhours.time) : timeToMinutes(rows[0].time);
  let endMin = (parkhours && parkhours.end) ? timeToMinutes(parkhours.end) : startMin + 60;
  for (const r of rows) {
    const s = timeToMinutes(r.time);
    const e = timeToMinutes(r.end || r.time);
    if (s < startMin) startMin = s;
    if (e > endMin) endMin = e;
  }
  startMin = Math.max(0, startMin - 15);
  endMin = endMin + 15;
  const chartWidth = (endMin - startMin) * GANTT_PX_PER_MIN;

  const axis = document.getElementById('gantt-axis');
  axis.style.width = chartWidth + 'px';
  axis.innerHTML = '';
  const firstHour = Math.ceil(startMin / 60) * 60;
  for (let t = firstHour; t <= endMin; t += 60) {
    const x = (t - startMin) * GANTT_PX_PER_MIN;
    const tick = document.createElement('div');
    tick.className = 'gantt-tick';
    tick.style.left = x + 'px';
    axis.appendChild(tick);
    const label = document.createElement('div');
    label.className = 'gantt-tick-label';
    label.style.left = x + 'px';
    label.textContent = minutesToTime(t);
    axis.appendChild(label);
  }

  const rowsContainer = document.getElementById('gantt-rows');
  rowsContainer.innerHTML = '';
  for (const item of rows) {
    const s = timeToMinutes(item.time);
    const e = timeToMinutes(item.end || item.time);
    const durMin = Math.max(e - s, 10);
    const left = (s - startMin) * GANTT_PX_PER_MIN;
    const width = Math.max(durMin * GANTT_PX_PER_MIN, 10);

    const row = document.createElement('div');
    row.className = 'gantt-row';

    const label = document.createElement('div');
    label.className = 'gantt-row-label';
    label.innerHTML = `<span class="name">${item.name}</span><span class="time">${item.time}${item.end ? '–' + item.end : ''}</span>`;
    row.appendChild(label);

    const track = document.createElement('div');
    track.className = 'gantt-row-track';
    track.style.width = chartWidth + 'px';
    track.style.backgroundSize = (60 * GANTT_PX_PER_MIN) + 'px 100%';

    const bar = document.createElement('div');
    bar.className = 'gantt-bar type-' + item.type;
    bar.style.left = left + 'px';
    bar.style.width = width + 'px';
    bar.title = `${item.name}（${item.time}${item.end ? '–' + item.end : ''}）`;
    track.appendChild(bar);

    row.appendChild(track);
    rowsContainer.appendChild(row);
  }
}

// ---- 追加モーダル ----

let modalTarget = null;
let editingScheduleId = null;

export function openAddModal(item) {
  modalTarget = item;
  editingScheduleId = null;
  document.getElementById('modal-title').textContent = item ? 'スケジュールに追加' : '自由入力で追加';
  document.getElementById('modal-name').value = item ? item.name : '';

  const select = document.getElementById('modal-time-select');
  select.innerHTML = '';
  const options = [];
  if (item) {
    for (const r of (item.ranges || [])) options.push({ label: `${r.start}–${r.end}`, start: r.start, end: r.end });
    for (const t of (item.times || [])) {
      const dur = guessDurationMinutes(item);
      const end = dur ? addMinutes(t, dur) : '';
      options.push({ label: end ? `${t}〜${end}頃（${dur}分想定）` : t, start: t, end });
    }
  }
  if (options.length) {
    select.hidden = false;
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ start: o.start, end: o.end });
      opt.textContent = o.label;
      select.appendChild(opt);
    }
    const first = options[0];
    document.getElementById('modal-start').value = first.start;
    document.getElementById('modal-end').value = first.end;
    select.onchange = () => {
      const v = JSON.parse(select.value);
      document.getElementById('modal-start').value = v.start;
      document.getElementById('modal-end').value = v.end;
      renderOccupancyPreview();
    };
  } else {
    select.hidden = true;
    document.getElementById('modal-start').value = '';
    document.getElementById('modal-end').value = '';
  }

  document.getElementById('modal-note').value = '';
  document.getElementById('add-modal').hidden = false;
  renderOccupancyPreview();
}

// マイスケジュールに入れた予定の時刻を、リストから外さず直接変更するための編集モード。
export function openEditModal(entry) {
  modalTarget = null;
  editingScheduleId = entry.id;
  document.getElementById('modal-title').textContent = '予定を編集';
  document.getElementById('modal-name').value = entry.name;

  const select = document.getElementById('modal-time-select');
  select.hidden = true;
  select.innerHTML = '';

  document.getElementById('modal-start').value = entry.time;
  document.getElementById('modal-end').value = entry.end || '';
  document.getElementById('modal-note').value = entry.note || '';
  document.getElementById('add-modal').hidden = false;
  renderOccupancyPreview();
}

// 追加モーダル内で「今どの時間が埋まっているか」と「これから追加する時間」を重ねて見せる。
function renderOccupancyPreview() {
  const strip = document.getElementById('modal-occupancy-strip');
  const ticksEl = document.getElementById('modal-occupancy-ticks');
  const warningEl = document.getElementById('modal-conflict-warning');
  if (!strip) return;

  const existing = state.schedule.filter(s => s.type !== 'parkhours' && s.id !== editingScheduleId);
  const parkhours = state.schedule.find(s => s.type === 'parkhours');
  const previewStart = document.getElementById('modal-start').value;
  const previewEnd = document.getElementById('modal-end').value;

  let startMin = parkhours ? timeToMinutes(parkhours.time) : 9 * 60;
  let endMin = parkhours && parkhours.end ? timeToMinutes(parkhours.end) : 21 * 60;
  for (const s of existing) {
    startMin = Math.min(startMin, timeToMinutes(s.time));
    endMin = Math.max(endMin, timeToMinutes(s.end || s.time));
  }
  if (previewStart) startMin = Math.min(startMin, timeToMinutes(previewStart));
  if (previewEnd) endMin = Math.max(endMin, timeToMinutes(previewEnd));
  startMin = Math.max(0, startMin - 10);
  endMin += 10;
  const total = Math.max(endMin - startMin, 1);

  strip.innerHTML = '';
  for (const s of existing) {
    const st = timeToMinutes(s.time);
    const en = timeToMinutes(s.end || s.time);
    const seg = document.createElement('div');
    seg.className = 'occ-seg type-' + s.type;
    seg.style.left = ((st - startMin) / total) * 100 + '%';
    seg.style.width = Math.max(((en - st) / total) * 100, 1.2) + '%';
    seg.title = `${s.name}（${s.time}${s.end ? '–' + s.end : ''}）`;
    strip.appendChild(seg);
  }

  let conflict = null;
  if (previewStart) {
    const st = timeToMinutes(previewStart);
    const en = previewEnd ? timeToMinutes(previewEnd) : st + 1;
    const preview = document.createElement('div');
    preview.className = 'occ-preview';
    preview.style.left = ((st - startMin) / total) * 100 + '%';
    preview.style.width = Math.max(((en - st) / total) * 100, 1.2) + '%';
    strip.appendChild(preview);

    conflict = existing.find(s => {
      const st2 = timeToMinutes(s.time);
      const en2 = timeToMinutes(s.end || s.time);
      return st < en2 && en > st2;
    });
  }

  ticksEl.innerHTML = '';
  const firstHour = Math.ceil(startMin / 60) * 60;
  for (let t = firstHour; t <= endMin; t += 60) {
    const tick = document.createElement('span');
    tick.style.left = ((t - startMin) / total) * 100 + '%';
    tick.textContent = minutesToTime(t);
    ticksEl.appendChild(tick);
  }

  if (conflict) {
    warningEl.hidden = false;
    warningEl.textContent = `⚠ 「${conflict.name}」(${conflict.time}${conflict.end ? '–' + conflict.end : ''})と時間が重なっています`;
  } else {
    warningEl.hidden = true;
  }
}

export function closeAddModal() {
  document.getElementById('add-modal').hidden = true;
  modalTarget = null;
  editingScheduleId = null;
}

export function confirmAddModal() {
  const name = document.getElementById('modal-name').value.trim();
  const start = document.getElementById('modal-start').value;
  const end = document.getElementById('modal-end').value;
  if (!name || !start) {
    alert('名前と開始時刻を入力してください。');
    return;
  }
  const note = document.getElementById('modal-note').value.trim();

  if (editingScheduleId) {
    const idx = state.schedule.findIndex(s => s.id === editingScheduleId);
    if (idx >= 0) {
      state.schedule[idx] = { ...state.schedule[idx], name, time: start, end: end || '', note };
    }
  } else {
    state.schedule.push({
      id: genId(),
      refId: modalTarget ? modalTarget.id : null,
      type: modalTarget ? modalTarget.type : 'custom',
      name,
      time: start,
      end: end || '',
      note
    });
  }
  saveSchedule();
  renderSchedule();
  closeAddModal();
}

// ---- 解析ボタン ----

export function runParse() {
  const calText = document.getElementById('paste-calendar').value;
  const resText = document.getElementById('paste-restaurant').value;
  const attText = document.getElementById('paste-attraction').value;

  let items = [];
  if (calText.trim()) items = items.concat(parseDailyCalendar(calText));
  if (resText.trim()) items = items.concat(parseFacilityList(resText, 'restaurant'));
  if (attText.trim()) items = items.concat(parseFacilityList(attText, 'attraction'));

  state.items = items;

  const parkhours = items.find(i => i.type === 'parkhours');
  if (parkhours) upsertParkHoursInSchedule(parkhours);

  saveItems();
  renderItemList();
  renderSchedule();

  document.getElementById('parse-result').textContent =
    `解析結果: 合計 ${items.length} 件` +
    `（ショー ${items.filter(i => i.type === 'show').length} / ` +
    `グリーティング ${items.filter(i => i.type === 'greeting').length} / ` +
    `アトラクション ${items.filter(i => i.type === 'attraction').length} / ` +
    `レストラン ${items.filter(i => i.type === 'restaurant').length}）` +
    (parkhours ? ' ・ 開園時間はマイスケジュールに自動反映されました。' : '');

  if (items.length) {
    document.getElementById('import-details').open = false;
    switchTab('list');
  }
}

// 開園時間はユーザーが選んで追加するものではなく、解析結果から常にスケジュールへ反映する。
function upsertParkHoursInSchedule(parkHoursItem) {
  if (!parkHoursItem.ranges.length) return;
  const range = parkHoursItem.ranges[0];
  const idx = state.schedule.findIndex(s => s.type === 'parkhours');
  const entry = {
    id: idx >= 0 ? state.schedule[idx].id : genId(),
    refId: parkHoursItem.id,
    type: 'parkhours',
    name: parkHoursItem.name,
    time: range.start,
    end: range.end,
    note: ''
  };
  if (idx >= 0) state.schedule[idx] = entry;
  else state.schedule.push(entry);
}

// ---- ショー所要時間の保存 ----

export function runSaveDurations() {
  const text = document.getElementById('paste-duration').value;
  const found = parseShowDurations(text);
  const resultEl = document.getElementById('duration-result');

  if (!found.length) {
    resultEl.textContent = '公演時間の情報が見つかりませんでした。ショーの詳細ページ（例: tokyodisneyresort.jp/tdl/show/detail/…/）の内容を貼り付けてください。';
    return;
  }

  const overrides = { ...loadDurationOverrides() };
  for (const f of found) overrides[f.name] = f.minutes;
  saveDurationOverrides(overrides);

  resultEl.textContent =
    `${found.length}件のショーの所要時間を保存しました（${found.map(f => `${f.name}: ${f.minutes}分`).join(' / ')}）。` +
    `現在 ${Object.keys(overrides).length}件のショーで所要時間を記憶しています。`;

  renderItemList();
  renderSchedule();
}

// ---- タブ・フィルタ・パーク切り替え ----

export function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('#main-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-list').hidden = tab !== 'list';
  document.getElementById('tab-schedule').hidden = tab !== 'schedule';
}

export function switchPark(park) {
  state.park = park;
  document.querySelectorAll('#park-switch button').forEach(b => b.classList.toggle('active', b.dataset.park === park));
  updateOfficialLinks();
  subscribeDayDoc();
}

export function switchType(type) {
  state.activeType = type;
  document.querySelectorAll('#type-filters button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  renderItemList();
}

// ---- Web Share Target 受け取り ----

function handleSharedText() {
  const params = new URLSearchParams(location.search);
  const shared = params.get('text');
  if (!shared) return;

  let target = 'paste-calendar';
  if (shared.includes('アトラクション一覧')) target = 'paste-attraction';
  else if (shared.includes('レストラン一覧')) target = 'paste-restaurant';
  else if (shared.includes('当日のパーク情報') || shared.includes('開園時間')) target = 'paste-calendar';

  document.getElementById(target).value = shared;
  document.getElementById('import-details').open = true;
  history.replaceState(null, '', location.pathname);
}

// ---- 初期化 ----

function init() {
  document.getElementById('date-input').value = state.date;
  document.getElementById('date-input').addEventListener('change', (e) => {
    state.date = e.target.value || todayStr();
    updateOfficialLinks();
    subscribeDayDoc();
  });

  document.querySelectorAll('#park-switch button').forEach(b => {
    b.addEventListener('click', () => switchPark(b.dataset.park));
  });
  document.querySelectorAll('#main-tabs button').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  document.querySelectorAll('#type-filters button').forEach(b => {
    b.addEventListener('click', () => switchType(b.dataset.type));
  });
  document.getElementById('search-input').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderItemList();
  });

  document.getElementById('parse-btn').addEventListener('click', runParse);
  document.getElementById('save-duration-btn').addEventListener('click', runSaveDurations);
  document.getElementById('add-custom-btn').addEventListener('click', () => openAddModal(null));
  document.getElementById('modal-cancel').addEventListener('click', closeAddModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmAddModal);
  document.getElementById('modal-start').addEventListener('input', renderOccupancyPreview);
  document.getElementById('modal-end').addEventListener('input', renderOccupancyPreview);

  document.getElementById('room-code-label').textContent = `共有コード: ${roomCode}`;
  document.getElementById('share-link-btn').addEventListener('click', async () => {
    const url = location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'TDLスケジュール', url }); } catch { /* ユーザーがキャンセルした場合は何もしない */ }
    } else {
      await navigator.clipboard.writeText(url);
      alert('リンクをコピーしました。家族に送ってください。');
    }
  });

  updateOfficialLinks();
  subscribeDayDoc();
  subscribeDurations();
  handleSharedText();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
