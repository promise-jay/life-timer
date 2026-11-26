'use strict';

/* ------------------------------------------------------------------ *
 * 时间记录员 · 手机版（离线优先 PWA）
 *
 * 数据模型：
 *   project: { id, name, emoji, color, updatedAt, deleted? }
 *   session: { id, projectId, start, end|null, updatedAt, deleted? }
 *
 * 本机 IndexedDB 是唯一数据源，断网/飞行模式完全可用。
 * GitHub 私有 Gist 只是「可选」的多设备同步中转，不配置也一切正常。
 * ------------------------------------------------------------------ */

const PALETTE = [
  '#5B8DEF', '#F2994A', '#EB5757', '#27AE60', '#9B51E0',
  '#2D9CDB', '#F2C94C', '#56CCF2', '#FF7AA2', '#4ECDC4',
];
const CACHE_KEY = 'lifetimer.state.v1';
const SETTINGS_KEY = 'lifetimer.settings.v1';
const DB_NAME = 'lifetimer';
const DB_STORE = 'kv';
const GIST_FILE = 'lifetimer.json';
const GH_API = 'https://api.github.com';

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEK_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

let state = { projects: [], sessions: [] };
let view = 'day';
let selected = startOfDay(new Date());
let syncing = false;
let tickCount = 0;
let lastHintKey = '';

/* ---------------------------- 基础工具 ---------------------------- */

const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, '0');
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function isToday(d) {
  return sameDay(d, new Date());
}
function fmtHM(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}
function fmtDur(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.round(ms / 1000)}秒`;
  if (mins < 60) return `${mins}分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}小时${m}分` : `${h}小时`;
}
function fmtDurShort(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${Math.max(mins, ms > 0 ? 1 : 0)}分`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}时${m}分` : `${h}小时`;
}
function fmtHours(ms) {
  const h = ms / 3600000;
  if (h >= 10) return `${Math.round(h)}h`;
  return `${Math.round(h * 10) / 10}h`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sum(list, fn) {
  let t = 0;
  for (const x of list) t += fn(x);
  return t;
}

function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------------------- 数据层 ---------------------------- */

function normalize(raw) {
  const out = { projects: [], sessions: [] };
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.projects)) {
    out.projects = raw.projects.filter((p) => p && typeof p.id === 'string');
  }
  if (Array.isArray(raw.sessions)) {
    out.sessions = raw.sessions.filter(
      (s) => s && typeof s.id === 'string' && typeof s.projectId === 'string' && Number.isFinite(Number(s.start)),
    );
  }
  return out;
}

function mergeStates(a, b) {
  const merged = { projects: [], sessions: [] };
  for (const key of ['projects', 'sessions']) {
    const byId = new Map();
    for (const rec of [...(a?.[key] || []), ...(b?.[key] || [])]) {
      if (!rec || typeof rec.id !== 'string') continue;
      const cur = byId.get(rec.id);
      if (!cur || (Number(rec.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) byId.set(rec.id, rec);
    }
    merged[key] = [...byId.values()];
  }
  return merged;
}

/** 数据里如果出现多条「进行中」，只保留最新的一条，其余按切换点结束 */
function reconcileActive() {
  const actives = state.sessions
    .filter((s) => !s.deleted && s.end == null)
    .sort((a, b) => Number(b.start) - Number(a.start));
  if (actives.length <= 1) return false;
  const now = Date.now();
  const newest = Number(actives[0].start);
  for (const s of actives.slice(1)) {
    s.end = Math.min(now, Math.max(Number(s.start) + 60000, newest));
    s.updatedAt = now;
  }
  return true;
}

/* ---------------------------- 本地存储 ---------------------------- */

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 不可用'));
  });
  return dbPromise;
}

function idbGet(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbSet(key, value) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function seedDefaults() {
  const now = Date.now();
  const base = [
    ['学习', '📚', '#5B8DEF'],
    ['工作', '💻', '#F2994A'],
    ['游戏', '🎮', '#EB5757'],
    ['阅读', '📖', '#9B51E0'],
    ['运动', '🏃', '#27AE60'],
    ['休息', '☕', '#2D9CDB'],
  ];
  state.projects = base.map(([name, emoji, color], i) => ({
    id: `p-default-${i}`,
    name,
    emoji,
    color,
    createdAt: now,
    updatedAt: now,
  }));
  state.sessions = [];
}

async function loadLocal() {
  let data = null;
  try {
    data = await idbGet('state');
  } catch { /* 退回 localStorage */ }
  if (!data) {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch { /* ignore */ }
  }
  if (data) state = normalize(data);
  if (!state.projects.length) seedDefaults();
}

async function saveLocal() {
  const payload = { projects: state.projects, sessions: state.sessions, savedAt: Date.now() };
  // 先同步写一份到 localStorage，保证即使马上被杀进程也不丢
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch { /* ignore */ }
  try {
    await idbSet('state', payload);
  } catch { /* ignore */ }
}

/* ---------------------------- 同步（GitHub 私有 Gist） ---------------------------- */

let settings = { token: '', gistId: '', lastSyncAt: 0 };
let syncTimer = null;

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch { /* ignore */ }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

function syncConfigured() {
  return !!(settings.token && settings.gistId);
}

async function ghFetch(path, options = {}) {
  const res = await fetch(GH_API + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${settings.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch { /* ignore */ }
    const err = new Error(`${res.status}${detail ? ' · ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function createGist() {
  const body = JSON.stringify({
    description: '时间记录员数据（自动生成，请勿删除）',
    public: false,
    files: { [GIST_FILE]: { content: JSON.stringify({ projects: [], sessions: [] }) } },
  });
  const data = await ghFetch('/gists', { method: 'POST', body });
  settings.gistId = data.id;
  saveSettings();
  return data.id;
}

/** 新设备上先找找账号里是不是已经有一份记录，避免建出两套数据 */
async function findExistingGist() {
  for (let page = 1; page <= 5; page++) {
    const list = await ghFetch(`/gists?per_page=100&page=${page}`);
    if (!Array.isArray(list) || !list.length) break;
    const hit = list.find((g) => g && g.files && Object.prototype.hasOwnProperty.call(g.files, GIST_FILE));
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

async function resolveGistId() {
  if (settings.gistId) return settings.gistId;
  try {
    const found = await findExistingGist();
    if (found) {
      settings.gistId = found;
      saveSettings();
      return found;
    }
  } catch { /* 列表拿不到就直接新建 */ }
  return createGist();
}

async function readRemote() {
  const data = await ghFetch(`/gists/${settings.gistId}`);
  const file = data && data.files && data.files[GIST_FILE];
  if (!file) return { projects: [], sessions: [] };
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const raw = await fetch(file.raw_url, { cache: 'no-store' });
    content = await raw.text();
  }
  return normalize(JSON.parse(content || '{}'));
}

async function writeRemote(payload) {
  const body = JSON.stringify({
    files: { [GIST_FILE]: { content: JSON.stringify(payload) } },
  });
  await ghFetch(`/gists/${settings.gistId}`, { method: 'PATCH', body });
}

function stableKey(s) {
  const projects = [...(s.projects || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const sessions = [...(s.sessions || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify({ projects, sessions });
}

async function syncNow(opts = {}) {
  if (!syncConfigured()) {
    if (opts.manual) openDialog($('#syncDialog'));
    return;
  }
  if (syncing) return;
  syncing = true;
  setSyncState('syncing');
  renderSyncStatus();
  try {
    const remote = await readRemote();
    const merged = mergeStates(state, remote);
    state = merged;
    const fixed = reconcileActive();
    const needPush = stableKey(merged) !== stableKey(remote) || fixed;
    if (needPush) await writeRemote({ projects: state.projects, sessions: state.sessions });
    await saveLocal();
    settings.lastSyncAt = Date.now();
    saveSettings();
    setSyncState('ok');
    renderAll();
    renderSyncStatus();
    if (opts.manual) toast(needPush ? '已同步（含本机新记录）' : '已同步，没有新内容');
  } catch (err) {
    setSyncState('error', err);
    renderSyncStatus();
    if (opts.manual) toast('同步失败：' + err.message, 3600);
  } finally {
    syncing = false;
  }
}

function scheduleSync(delay = 20000) {
  if (!syncConfigured()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

function setSyncState(kind, err) {
  const dot = $('#netDot');
  dot.classList.toggle('live', kind === 'ok');
  dot.classList.toggle('off', kind === 'error');
  dot.classList.toggle('busy', kind === 'syncing');
  dot.title =
    kind === 'ok'
      ? '已与 GitHub 同步'
      : kind === 'error'
        ? `同步失败：${err ? err.message : ''}`
        : kind === 'syncing'
          ? '正在同步…'
          : syncConfigured()
            ? '已开启同步'
            : '只保存在这台手机上（未开启同步）';
}

function commit(mutate) {
  mutate();
  saveLocal();
  renderAll();
  scheduleSync(15000);
}

/* ---------------------------- 派生数据 ---------------------------- */

function projectMap() {
  const map = new Map();
  for (const p of state.projects) if (!p.deleted) map.set(p.id, p);
  return map;
}

function projectInfo(id) {
  const p = projectMap().get(id);
  if (p) return { name: p.name, emoji: p.emoji || '⏱', color: p.color || PALETTE[0] };
  return { name: '已删除项目', emoji: '❔', color: '#4b5262' };
}

function activeSession() {
  return state.sessions.find((s) => !s.deleted && s.end == null) || null;
}

/** 某天（本地时区）里的记录，已裁剪到当天范围 */
function sessionsOnDay(dayStart) {
  const dayEnd = +addDays(dayStart, 1);
  const a0 = +dayStart;
  const out = [];
  for (const s of state.sessions) {
    if (s.deleted) continue;
    const start = Number(s.start);
    const end = s.end == null ? Date.now() : Number(s.end);
    const a = Math.max(start, a0);
    const b = Math.min(end, dayEnd);
    if (b - a <= 0) continue;
    out.push({ ...s, _start: a, _end: b, _ms: b - a });
  }
  out.sort((x, y) => x._start - y._start);
  return out;
}

function totalsOf(list) {
  const map = new Map();
  for (const s of list) map.set(s.projectId, (map.get(s.projectId) || 0) + s._ms);
  return map;
}

/** 把一天切成 24 个小时桶，每桶内按时间顺序保存片段 */
function hourBuckets(list) {
  const buckets = Array.from({ length: 24 }, () => []);
  for (const s of list) {
    let t = s._start;
    while (t < s._end) {
      const h = new Date(t).getHours();
      const hourEnd = new Date(t);
      hourEnd.setMinutes(0, 0, 0);
      hourEnd.setHours(h + 1);
      const segEnd = Math.min(s._end, +hourEnd);
      buckets[h].push({ projectId: s.projectId, ms: segEnd - t, start: t });
      t = segEnd;
    }
  }
  return buckets;
}

function weekDays(d) {
  const s = startOfDay(d);
  const offset = (s.getDay() + 6) % 7; // 周一为一周之始
  const mon = addDays(s, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
}

/* ---------------------------- 渲染 ---------------------------- */

function renderAll() {
  renderDateLabel();
  renderNow();
  renderProjects();
  renderSummary();
  renderLog();
  if ($('#manualDialog').open) syncManualOptions();
}

function renderDateLabel() {
  const el = $('#dateLabel');
  let text;
  if (isToday(selected)) text = '今天';
  else if (sameDay(selected, addDays(new Date(), -1))) text = '昨天';
  else text = `${selected.getMonth() + 1}月${selected.getDate()}日`;
  el.textContent = text;

  const nextBtn = $('#nextDay');
  const atToday = isToday(selected);
  nextBtn.disabled = atToday;
  nextBtn.style.opacity = atToday ? '0.25' : '1';
}

function renderNow() {
  const card = $('#nowCard');
  const active = activeSession();
  if (!active) {
    card.innerHTML = `<div class="idle-card">
      <span style="font-size:20px">⏳</span>
      <span>还没在计时 · 点下面的项目就开始，<b>切换项目会自动结算上一段</b></span>
    </div>
    <div class="hint" id="nowTotal" style="margin:8px 4px 0">${todayTrackedText()}</div>`;
    return;
  }
  const info = projectInfo(active.projectId);
  const elapsed = Date.now() - Number(active.start);
  const longRun = elapsed > 12 * 3600000;
  card.innerHTML = `
    <div class="now-inner">
      <div class="now-top"><span class="pulse"></span>正在记录</div>
      <div class="now-project">
        <span class="now-emoji">${escapeHtml(info.emoji)}</span>
        <span>${escapeHtml(info.name)}</span>
      </div>
      <div class="now-timer" id="nowTimer">${fmtClock(elapsed)}</div>
      <div class="now-actions">
        <button class="btn-stop" data-act="stop">结束计时</button>
      </div>
      <div class="hint" id="nowTotal">${
        longRun ? '⚠️ 已经记了 ' + fmtDur(elapsed) + '，是不是忘记结束了？' : todayTrackedText()
      }</div>
    </div>`;
}

function todayTrackedText() {
  const list = sessionsOnDay(startOfDay(new Date()));
  if (!list.length) return '今天还没有记录';
  const total = sum(list, (s) => s._ms);
  const top = [...totalsOf(list).entries()].sort((a, b) => b[1] - a[1])[0];
  const topInfo = projectInfo(top[0]);
  return `今天已记录 ${fmtDur(total)} · ${topInfo.name}最多`;
}

function renderProjects() {
  const grid = $('#projectGrid');
  const active = activeSession();
  const projects = [...projectMap().values()];
  grid.innerHTML = projects
    .map((p) => {
      const running = active && active.projectId === p.id;
      return `<button class="proj ${running ? 'active' : ''}" data-act="start" data-project="${escapeHtml(p.id)}">
        ${running ? '<span class="tick"></span>' : ''}
        <span class="emoji">${escapeHtml(p.emoji || '⏱')}</span>
        <span class="name">${escapeHtml(p.name)}</span>
        ${running ? '<span class="running-flag">记录中</span>' : ''}
        <span class="bar" style="color:${p.color || PALETTE[0]}"></span>
      </button>`;
    })
    .join('');
}

function renderSummary() {
  const isWeek = view === 'week';
  const days = isWeek ? weekDays(selected) : [selected];
  const perDay = days.map((d) => sessionsOnDay(d));
  const all = perDay.flat();
  const total = sum(all, (s) => s._ms);
  const hintKey = view + ':' + days.map((d) => d.toDateString()).join(',');
  const resetHint = hintKey !== lastHintKey;

  $('#summaryTitle').textContent = isWeek
    ? (weekDays(new Date()).some((d) => sameDay(d, selected)) ? '本周汇总' : '那一周汇总')
    : isToday(selected)
      ? '今日汇总'
      : `${selected.getMonth() + 1}月${selected.getDate()}日汇总`;

  const totals = totalsOf(all);
  const slices = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, ms]) => ({ ...projectInfo(id), id, ms }));

  // 大标题
  const totalEl = $('#dayTotal');
  totalEl.className = 'card-title big';
  totalEl.textContent = total ? `共 ${fmtDur(total)}` : '还没有记录';
  const prevSub = totalEl.nextElementSibling;
  if (prevSub && prevSub.classList.contains('card-sub')) prevSub.remove();

  drawPie($('#pieCanvas'), slices, total);

  const legend = $('#pieLegend');
  if (!slices.length) {
    legend.innerHTML = `<div class="empty">${isWeek ? '这一周' : '这一天'}还没有记录，去上面点一个项目开始吧</div>`;
  } else {
    legend.innerHTML = slices
      .map((s) => {
        const pct = total ? Math.round((s.ms / total) * 100) : 0;
        return `<div class="legend-row">
          <span class="legend-dot" style="background:${s.color}"></span>
          <span class="legend-name">${escapeHtml(s.emoji)} ${escapeHtml(s.name)}</span>
          <span class="legend-val">${fmtDur(s.ms)}</span>
          <span class="legend-pct">${pct}%</span>
        </div>`;
      })
      .join('');
  }

  if (isWeek) drawWeekBars(perDay, days, resetHint);
  else drawDayBars(perDay[0], resetHint);
  lastHintKey = hintKey;
}

/* ---------------------------- 图表 ---------------------------- */

function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(120, canvas.clientWidth || 300);
  const h = Math.max(80, canvas.clientHeight || 160);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawPie(canvas, slices, total) {
  const { ctx, w, h } = fitCanvas(canvas);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 4;
  const ir = r * 0.63;

  if (!total) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r + ir) / 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = r - ir;
    ctx.stroke();
    return;
  }

  const gap = slices.length > 1 ? 0.02 : 0;
  let angle = -Math.PI / 2;
  for (const s of slices) {
    const span = (s.ms / total) * Math.PI * 2;
    const a0 = angle + gap / 2;
    const a1 = angle + span - gap / 2;
    if (a1 > a0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a1);
      ctx.arc(cx, cy, ir, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    angle += span;
  }
}

function drawGridAndBars(canvas, columns, opts) {
  const { ctx, w, h } = fitCanvas(canvas);
  const padL = 30, padR = 8, padT = 10;
  const padB = opts.padB || 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const maxMs = Math.max(opts.maxMs, 1);

  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  for (const t of opts.ticks) {
    const y = padT + plotH - (t.v / maxMs) * plotH;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, Math.round(y) + 0.5);
    ctx.lineTo(w - padR, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#6b7488';
    ctx.fillText(t.label, padL - 6, y);
  }

  const colW = plotW / columns.length;
  const barW = Math.max(3, Math.min(colW * 0.64, 22));
  const layout = [];

  columns.forEach((col, i) => {
    const x0 = padL + i * colW;
    const bx = x0 + (colW - barW) / 2;
    const totalH = Math.min(plotH, (col.totalMs / maxMs) * plotH);
    const baseY = padT + plotH;

    if (totalH > 0.5) {
      ctx.save();
      roundRectPath(ctx, bx, baseY - totalH, barW, totalH, Math.min(4, barW / 2, totalH / 2));
      ctx.clip();
      let y = baseY;
      for (const seg of col.segments) {
        const segH = (seg.ms / maxMs) * plotH;
        if (segH <= 0.2) continue;
        ctx.fillStyle = seg.color;
        ctx.fillRect(bx, y - segH, barW, segH + 0.5);
        y -= segH;
      }
      ctx.restore();
    } else if (col.hint) {
      // 空柱子给一个浅浅的底，方便点击
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      roundRectPath(ctx, bx, baseY - 3, barW, 3, 1.5);
      ctx.fill();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    if (col.label) {
      ctx.fillStyle = '#6b7488';
      ctx.font = '10px -apple-system, system-ui, sans-serif';
      ctx.fillText(col.label, x0 + colW / 2, baseY + 5);
    }
    if (col.sub) {
      ctx.fillStyle = '#4d5566';
      ctx.font = '9px -apple-system, system-ui, sans-serif';
      ctx.fillText(col.sub, x0 + colW / 2, baseY + 16);
    }

    layout.push({ x0, x1: x0 + colW, col, index: i });
  });

  canvas._layout = layout;
  canvas._kind = opts.kind;
}

function drawDayBars(list, resetHint) {
  const buckets = hourBuckets(list);
  const columns = buckets.map((segs, hour) => ({
    label: hour % 3 === 0 && hour > 0 ? `${hour}` : '',
    hint: true,
    hour,
    totalMs: sum(segs, (s) => s.ms),
    segments: segs.map((s) => ({ ms: s.ms, color: projectInfo(s.projectId).color })),
  }));
  drawGridAndBars($('#barCanvas'), columns, {
    maxMs: 3600000,
    kind: 'day',
    ticks: [
      { v: 3600000, label: '60分' },
      { v: 1800000, label: '30分' },
      { v: 0, label: '0' },
    ],
  });
  $('#barTitle').textContent = '一天的时间分布';
  if (resetHint) $('#barHint').textContent = '每根柱子是一个小时里的记录 · 点柱子看明细';
}

function drawWeekBars(perDay, days, resetHint) {
  const dayTotals = perDay.map((list) => sum(list, (s) => s._ms));
  const maxDay = Math.max(...dayTotals, 1);
  const step = 3600000;
  const maxMs = Math.max(step, Math.ceil(maxDay / step) * step);
  const columns = perDay.map((list, i) => {
    const d = days[i];
    const segs = list
      .slice()
      .sort((a, b) => a._start - b._start)
      .map((s) => ({ ms: s._ms, color: projectInfo(s.projectId).color }));
    return {
      label: WEEK_SHORT[d.getDay()],
      sub: `${d.getMonth() + 1}/${d.getDate()}`,
      totalMs: dayTotals[i],
      segments: segs,
      dayIndex: i,
    };
  });
  drawGridAndBars($('#barCanvas'), columns, {
    maxMs,
    kind: 'week',
    padB: 30,
    ticks: [
      { v: maxMs, label: fmtHours(maxMs) },
      { v: maxMs / 2, label: fmtHours(maxMs / 2) },
      { v: 0, label: '0' },
    ],
  });
  $('#barTitle').textContent = '每天的时间分布';
  if (resetHint) $('#barHint').textContent = '每天的记录堆叠在一起 · 点柱子跳到那一天';
}

/* ---------------------------- 明细列表 ---------------------------- */

function renderLog() {
  const list = sessionsOnDay(selected);
  const el = $('#logList');
  if (!list.length) {
    el.innerHTML = `<div class="card empty">这一天还没有记录</div>`;
    return;
  }
  el.innerHTML = list
    .slice()
    .reverse()
    .map((s) => {
      const info = projectInfo(s.projectId);
      const running = s.end == null;
      const endLabel = running ? '进行中' : fmtHM(s._end);
      return `<div class="log-item ${running ? 'running' : ''}">
        <span class="dot" style="background:${info.color}"></span>
        <span class="info">
          <span class="row1">
            <span class="pname">${escapeHtml(info.emoji)} ${escapeHtml(info.name)}</span>
            <span class="range">${fmtHM(s._start)} – ${endLabel}</span>
          </span>
        </span>
        <span class="dur">${running ? fmtClock(Date.now() - s._start) : fmtDur(s._ms)}</span>
        <button class="del" data-act="del" data-id="${escapeHtml(s.id)}" aria-label="删除">✕</button>
      </div>`;
    })
    .join('');
}

/* ---------------------------- 交互动作 ---------------------------- */

function startProject(projectId) {
  const now = Date.now();
  const active = activeSession();
  if (active && active.projectId === projectId) {
    toast('这个项目正在记录中');
    return;
  }
  selected = startOfDay(new Date());
  commit(() => {
    if (active) {
      active.end = now;
      active.updatedAt = now;
    }
    state.sessions.push({ id: uid(), projectId, start: now, end: null, updatedAt: now });
  });
  const info = projectInfo(projectId);
  toast(`开始记录「${info.name}」`);
}

function stopActive() {
  const active = activeSession();
  if (!active) return;
  const now = Date.now();
  const name = projectInfo(active.projectId).name;
  const dur = now - Number(active.start);
  commit(() => {
    active.end = now;
    active.updatedAt = now;
  });
  toast(`「${name}」记了 ${fmtDur(dur)}`);
}

function deleteSession(id) {
  const target = state.sessions.find((s) => s.id === id);
  if (!target) return;
  commit(() => {
    target.deleted = true;
    target.updatedAt = Date.now();
  });
  toast('已删除这段记录');
}

function openDialog(d) {
  if (typeof d.showModal === 'function') d.showModal();
  else d.setAttribute('open', '');
}
function closeDialog(d) {
  if (typeof d.close === 'function') d.close();
  else d.removeAttribute('open');
}

function manualOptionsHtml() {
  return [...projectMap().values()]
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.emoji || '')} ${escapeHtml(p.name)}</option>`)
    .join('');
}

function syncManualOptions() {
  const sel = $('#manualProject');
  if (!sel) return;
  const html = manualOptionsHtml();
  if (sel.innerHTML === html) return;
  const prev = sel.value;
  sel.innerHTML = html;
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function fillManualForm() {
  syncManualOptions();
  const now = new Date();
  const endT = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  const startT = pad2(Math.max(0, now.getHours() - 1)) + ':' + pad2(now.getMinutes());
  $('#manualEnd').value = endT;
  $('#manualStart').value = startT;
}

/* ---------------------------- 事件绑定 ---------------------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'start') startProject(el.dataset.project);
  else if (act === 'stop') stopActive();
  else if (act === 'del') deleteSession(el.dataset.id);
});

$('#prevDay').addEventListener('click', () => {
  selected = addDays(selected, -1);
  renderAll();
});
$('#nextDay').addEventListener('click', () => {
  if (!isToday(selected)) {
    selected = addDays(selected, 1);
    renderAll();
  }
});
$('#dateLabel').addEventListener('click', () => {
  selected = startOfDay(new Date());
  renderAll();
  toast('回到今天');
});

$('#viewSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  view = btn.dataset.view;
  [...$('#viewSeg').children].forEach((b) => b.classList.toggle('on', b === btn));
  renderSummary();
});

$('#addProjectBtn').addEventListener('click', () => {
  $('#projectName').value = '';
  $('#projectEmoji').value = '';
  openDialog($('#projectDialog'));
  setTimeout(() => $('#projectName').focus(), 60);
});
$('#projectCancel').addEventListener('click', () => closeDialog($('#projectDialog')));
$('#projectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#projectName').value.trim();
  if (!name) {
    toast('给项目起个名字');
    return;
  }
  const emoji = $('#projectEmoji').value.trim() || '⏱';
  const used = new Set([...projectMap().values()].map((p) => p.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[projectMap().size % PALETTE.length];
  commit(() => {
    const now = Date.now();
    state.projects.push({ id: uid(), name, emoji, color, createdAt: now, updatedAt: now });
  });
  closeDialog($('#projectDialog'));
  toast(`已添加「${name}」`);
});

$('#addManualBtn').addEventListener('click', () => {
  fillManualForm();
  openDialog($('#manualDialog'));
});
$('#manualCancel').addEventListener('click', () => closeDialog($('#manualDialog')));
$('#manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const projectId = $('#manualProject').value;
  const startVal = $('#manualStart').value;
  const endVal = $('#manualEnd').value;
  if (!projectId || !startVal || !endVal) {
    toast('把项目和时间填完整');
    return;
  }
  const [sh, sm] = startVal.split(':').map(Number);
  const [eh, em] = endVal.split(':').map(Number);
  const base = startOfDay(selected);
  const start = new Date(base);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(base);
  end.setHours(eh, em, 0, 0);
  if (+end <= +start) end.setDate(end.getDate() + 1);
  commit(() => {
    const now = Date.now();
    state.sessions.push({
      id: uid(),
      projectId,
      start: +start,
      end: +end,
      updatedAt: now,
      note: '补录',
    });
  });
  closeDialog($('#manualDialog'));
  toast(`补录 ${fmtDur(+end - +start)}`);
});

$('#menuBtn').addEventListener('click', () => {
  renderSyncStatus();
  openDialog($('#menuDialog'));
});
$('#menuClose').addEventListener('click', () => closeDialog($('#menuDialog')));

/* ---------- 同步设置 ---------- */

function renderSyncStatus() {
  const label = $('#syncStateText');
  if (label) {
    if (!settings.token) {
      label.textContent = '未开启';
      label.classList.remove('on');
    } else if (!settings.gistId) {
      label.textContent = '待创建';
      label.classList.remove('on');
    } else {
      label.textContent = settings.lastSyncAt ? fmtHM(settings.lastSyncAt) : '已配置';
      label.classList.add('on');
    }
  }
  const hint = $('#lastSyncHint');
  if (hint) {
    hint.textContent = syncConfigured()
      ? `与 GitHub 私有 Gist 同步中 · 上次：${
          settings.lastSyncAt ? new Date(settings.lastSyncAt).toLocaleString() : '还没同步过'
        }`
      : '数据只存在这台手机上（已申请持久化存储）。记得偶尔导出一份备份。';
  }
}

$('#syncSettingsBtn').addEventListener('click', () => {
  $('#tokenInput').value = settings.token;
  $('#gistInput').value = settings.gistId;
  $('#syncDialogHint').textContent = '';
  closeDialog($('#menuDialog'));
  openDialog($('#syncDialog'));
});

$('#syncCancel').addEventListener('click', () => closeDialog($('#syncDialog')));

$('#syncSave').addEventListener('click', async () => {
  const token = $('#tokenInput').value.trim();
  const gist = $('#gistInput').value.trim();
  if (!token) {
    $('#syncDialogHint').textContent = '访问令牌不能为空。只需要勾选 gist 权限。';
    return;
  }
  settings.token = token;
  settings.gistId = gist;
  saveSettings();
  const btn = $('#syncSave');
  btn.disabled = true;
  btn.textContent = '连接中…';
  $('#syncDialogHint').textContent = '正在连接 GitHub…';
  try {
    await resolveGistId();
    await syncNow({ manual: true });
    closeDialog($('#syncDialog'));
    toast('同步已开启');
  } catch (err) {
    $('#syncDialogHint').textContent =
      '连接失败：' + err.message + '（令牌是否勾了 gist 权限？是否已经过期？）';
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并同步';
    renderSyncStatus();
    renderAll();
  }
});

$('#syncClear').addEventListener('click', () => {
  settings = { ...settings, token: '', gistId: '', lastSyncAt: 0 };
  saveSettings();
  $('#tokenInput').value = '';
  $('#gistInput').value = '';
  renderSyncStatus();
  closeDialog($('#syncDialog'));
  toast('已关闭同步，数据仍在本机');
});

$('#syncNowBtn').addEventListener('click', async () => {
  closeDialog($('#menuDialog'));
  if (!syncConfigured()) {
    openDialog($('#syncDialog'));
    return;
  }
  await syncNow({ manual: true });
});

/* ---------- 安装到桌面 ---------- */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $('#installBtn');
  if (btn) btn.hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) {
    toast('用浏览器菜单里的「添加到主屏幕」也可以');
    return;
  }
  deferredPrompt.prompt();
  try {
    const choice = await deferredPrompt.userChoice;
    toast(choice.outcome === 'accepted' ? '已添加到桌面' : '已取消');
  } catch { /* ignore */ }
  deferredPrompt = null;
  $('#installBtn').hidden = true;
});

/* ---------- 清空记录 ---------- */

$('#clearBtn').addEventListener('click', () => {
  const count = state.sessions.filter((s) => !s.deleted).length;
  if (!count) {
    toast('本来就没有记录');
    return;
  }
  if (!confirm(`要清空这 ${count} 条记录吗？\n项目会保留，记录删掉后无法恢复。`)) return;
  if (!confirm('再确认一次：删除后无法恢复，建议先导出备份。')) return;
  commit(() => {
    const now = Date.now();
    for (const s of state.sessions) {
      if (!s.deleted) {
        s.deleted = true;
        s.updatedAt = now;
      }
    }
  });
  toast(`已清空 ${count} 条记录`);
});

$('#exportBtn').addEventListener('click', () => {
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `时间记录-${startOfDay(new Date()).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('备份已导出');
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const incoming = normalize(parsed);
    if (!incoming.projects.length && !incoming.sessions.length) throw new Error('空文件');
    state = mergeStates(state, incoming);
    await saveLocal();
    renderAll();
    scheduleSync(5000);
    toast(`已导入 ${incoming.sessions.length} 条记录`);
    closeDialog($('#menuDialog'));
  } catch (err) {
    toast('导入失败：文件格式不对');
  } finally {
    e.target.value = '';
  }
});

// 图表点击
$('#barCanvas').addEventListener('click', (e) => {
  const canvas = $('#barCanvas');
  const layout = canvas._layout;
  if (!layout) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const hit = layout.find((c) => x >= c.x0 && x <= c.x1);
  if (!hit) return;
  if (canvas._kind === 'day') {
    const list = sessionsOnDay(selected);
    const segs = hourBuckets(list)[hit.col.hour] || [];
    if (!segs.length) {
      $('#barHint').textContent = `${pad2(hit.col.hour)}:00–${pad2(hit.col.hour + 1)}:00 没有记录`;
      return;
    }
    const parts = new Map();
    for (const s of segs) parts.set(s.projectId, (parts.get(s.projectId) || 0) + s.ms);
    const text = [...parts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, ms]) => `${projectInfo(id).name} ${fmtDurShort(ms)}`)
      .join(' · ');
    $('#barHint').textContent = `${pad2(hit.col.hour)}:00–${pad2((hit.col.hour + 1) % 24)}:00  ${text}`;
  } else {
    const days = weekDays(selected);
    selected = days[hit.index];
    view = 'day';
    [...$('#viewSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.view === 'day'));
    renderAll();
    toast(`${selected.getMonth() + 1}月${selected.getDate()}日 ${WEEK_NAMES[selected.getDay()]}`);
  }
});

// 每秒刷新计时
setInterval(() => {
  const active = activeSession();
  if (!active) return;
  tickCount += 1;
  const timerEl = $('#nowTimer');
  if (timerEl) timerEl.textContent = fmtClock(Date.now() - Number(active.start));
  if (tickCount % 10 === 0) {
    const totalEl = $('#nowTotal');
    if (totalEl) {
      const longRun = Date.now() - Number(active.start) > 12 * 3600000;
      totalEl.textContent = longRun
        ? `⚠️ 已经记了 ${fmtDur(Date.now() - Number(active.start))}，是不是忘记结束了？`
        : todayTrackedText();
    }
    renderSummary();
    renderLog();
  }
}, 1000);

// 定期与 Gist 合并一次（没配置同步时什么都不做）
setInterval(() => {
  if (!document.hidden && syncConfigured()) syncNow();
}, 5 * 60 * 1000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderDateLabel();
    if (syncConfigured()) syncNow();
  }
});
window.addEventListener('online', () => {
  if (syncConfigured()) syncNow();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderSummary(), 160);
});

/* ---------------------------- 启动 ---------------------------- */

async function boot() {
  loadSettings();
  await loadLocal();
  if (reconcileActive()) await saveLocal();
  renderAll();
  renderSyncStatus();
  setSyncState(syncConfigured() ? 'idle' : 'none');

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  if (syncConfigured()) syncNow();

  setInterval(() => {
    const el = $('#nowTotal');
    if (el && !activeSession()) el.textContent = todayTrackedText();
  }, 60000);
}

boot();

// 从后台恢复时把计时刷新一下
window.addEventListener('pageshow', () => {
  if (activeSession()) renderAll();
});

/* ---------------------------- 离线缓存 ---------------------------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* 离线缓存装不上也不影响正常使用 */
    });
  });
}
