import { FoaPlayer, decodePcm, parseWavHeader } from './player.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key) { try { return localStorage.getItem(`icd.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`icd.${key}`, value); } catch { /* private mode */ } },
  remove(key) { try { localStorage.removeItem(`icd.${key}`); } catch { /* private mode */ } },
};

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const player = new FoaPlayer();

const state = {
  bridge: null, // { url, token }
  remote: '',
  mode: null, // 'annotate' | 'browse'
  items: [], // every recording: { path, name, size, note, row, id }
  current: null, // item of the open recording
  note: null, // { mtime, body, meta } as last loaded/saved
  loadSeq: 0,
  overview: null, // level (dB) of the W channel at evenly spaced points
  metadata: new Map(), // dataset-relative path → metadata sheet row
  sheet: [], // every metadata row, with or without a recording
  user: '', // SSH login name, the default annotator
  annotations: new Map(), // annotator → Set of recording names they have notes for
  photoUrl: null,
  history: [], // recordings visited before the current one, for Prev in random order
};

const OVERVIEW_POINTS = 480;
const OVERVIEW_PROBE_SECONDS = 0.03;

// ---------------------------------------------------------------- utilities

function toast(message, ms = 3500) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function formatTime(s) {
  if (!Number.isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

// ------------------------------------------------------------ bridge client

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body, signal, raw = false, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(state.bridge.url + path, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${state.bridge.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: `Can't reach the helper at ${state.bridge.url}. Is sftp_bridge.py still running?` });
  }
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* not JSON */ }
    throw new ApiError(res.status, payload);
  }
  return raw ? res : res.json();
}

/** Pull `bridge` and `token` out of a link the helper printed. */
function parseConnectLink(text) {
  const hash = text.includes('#') ? text.slice(text.indexOf('#') + 1) : text;
  const params = new URLSearchParams(hash);
  const url = params.get('bridge');
  const token = params.get('token');
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function connect(bridge) {
  state.bridge = bridge;
  const info = await api('/api/info');
  store.set('bridge', JSON.stringify(bridge));
  state.remote = info.remote;
  state.user = info.user || '';
  $('annotator').value = store.get(`annotator:${state.user}`) || state.user;
  $('remote').textContent = info.remote;
  $('remote').title = `Connected through ${bridge.url}`;
  $('disconnect').hidden = false;
  showModeChooser();
  await refreshData();
}

/** Re-read the metadata sheet, recordings and annotations from the drive. */
async function refreshData() {
  $('mode-status').textContent = 'Loading the metadata sheet and recordings from the drive…';
  try {
    await loadMetadata();
    await loadItems();
  } catch (err) {
    $('mode-status').textContent = `Couldn’t list the recordings: ${err.message}`;
    return false;
  }
  const recordings = state.items.filter((i) => !i.missing);
  const missing = state.items.length - recordings.length;
  const annotated = recordings.filter((i) => i.annotators.length).length;
  $('mode-status').textContent = [
    state.metadataError,
    `${recordings.length} recordings`,
    missing && `${missing} sheet entries without audio`,
    `${annotated} annotated by ${state.annotations.size} annotator${state.annotations.size === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');
  return true;
}

function showConnect(message = '') {
  $('work-view').hidden = true;
  $('mode-view').hidden = true;
  $('connect-view').hidden = false;
  $('disconnect').hidden = true;
  $('switch-mode').hidden = true;
  $('remote').textContent = '';
  $('connect-error').textContent = message;
  delete document.body.dataset.mode;
}

function showModeChooser() {
  state.mode = null;
  delete document.body.dataset.mode;
  $('connect-view').hidden = true;
  $('work-view').hidden = true;
  $('switch-mode').hidden = true;
  $('mode-view').hidden = false;
}

async function chooseMode(mode) {
  // Always work from the current sheet on the drive.
  for (const card of document.querySelectorAll('.mode-card')) card.disabled = true;
  const ok = await refreshData();
  for (const card of document.querySelectorAll('.mode-card')) card.disabled = false;
  if (!ok || !state.items.length) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('switch-mode').textContent = mode === 'annotate' ? 'Annotate mode' : 'Browse mode';
  $('switch-mode').hidden = false;
  $('mode-view').hidden = true;
  $('work-view').hidden = false;
  $('filter').value = '';
  $('filter').placeholder = mode === 'annotate' ? 'Find by ID' : 'Filter by ID, name or place';
  $('note').readOnly = mode !== 'annotate';
  $('note').placeholder = mode === 'annotate' ? 'What do you hear? Sources, events, timestamps, quality issues…' : 'No notes yet.';
  closeFile();
  renderFiles();
}

/** Leave the open recording (after saving or confirming unsaved notes). */
function closeFile() {
  state.loadSeq++;
  state.abort?.abort();
  player.unload();
  state.current = null;
  state.note = null;
  state.overview = null;
  state.history = [];
  $('file-view').hidden = true;
  $('empty').hidden = false;
}

function connectErrorMessage(err) {
  if (err.status === 401) return 'That session key is no longer valid. Use the link from the most recent run of the helper.';
  if (err.status === 403) return 'The helper refused this page. Start it with --site pointing at this page’s address.';
  return err.message;
}

// ---------------------------------------------------------------- metadata

/** RFC 4180 CSV → array of objects keyed by the header row. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

async function loadMetadata() {
  state.metadata = new Map();
  state.sheet = [];
  state.metadataError = '';
  try {
    const res = await api('/api/metadata', { raw: true });
    state.sheet = parseCsv(await res.text()).filter((row) => row['Database ID']);
    for (const row of state.sheet) if (row.File) state.metadata.set(row.File, row);
  } catch (err) {
    state.metadataError = err.status === 404
      ? 'No icd-metadata.csv in the dataset folder, so recordings have no IDs or metadata'
      : `Couldn’t load the metadata sheet: ${err.message}`;
  }
}

const META_FIELDS = [
  ['Sheet ID', (r) => r['Database ID']],
  ['Recorded', (r) => [r.Date, r['Local Time']].filter(Boolean).join(' ')],
  ['Place', (r) => [r.Location, r.City, r.Country].filter(Boolean).join(' · ')],
  ['Microphone', (r) => r['Microphone ID']],
  ['Interior sources', (r) => r['Interior sound sources']],
  ['Exterior sources', (r) => r['Exterior sound sources']],
  ['Description', (r) => r.Description],
  ['Recordist notes', (r) => r.Notes],
];

function renderMetadata(row) {
  const card = $('meta');
  card.hidden = !row;
  if (!row) return;
  const list = $('meta-list');
  list.replaceChildren();
  for (const [label, get] of META_FIELDS) {
    const value = get(row);
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  const flags = $('meta-flags');
  flags.replaceChildren();
  for (const [label, key] of [['Copyright', 'Copyright issues'], ['Privacy', 'Privacy issues']]) {
    const value = (row[key] || '').toLowerCase();
    if (!value) continue;
    const chip = document.createElement('span');
    chip.className = `chip ${value.startsWith('y') ? 'warn' : ''}`;
    chip.textContent = `${label}: ${row[key]}`;
    flags.append(chip);
  }
  const detail = row['Copyright/Privacy Issue Duration'];
  if (detail) {
    const span = document.createElement('span');
    span.className = 'chip-detail';
    span.textContent = detail;
    flags.append(span);
  }
}

const metaText = (row) => (row ? [row.Location, row.City, row.Country, row.Date, row.Description].join(' ').toLowerCase() : '');

// --------------------------------------------------------------- recordings

/** Every audio file in the dataset folder and its sub-folders, joined to the
 *  sheet, plus sheet rows with no audio on the drive (`missing`, browse only). */
async function loadItems() {
  const root = await api('/api/list?dir=');
  const listings = [root, ...(await Promise.all(
    root.entries.filter((e) => e.type === 'dir').map((e) => api(`/api/list?dir=${encodeURIComponent(e.name)}`)),
  ))];
  const items = listings.flatMap((l) => l.entries
    .filter((e) => e.type === 'audio')
    .map((e) => {
      const path = joinPath(l.dir, e.name);
      const row = state.metadata.get(path) || null;
      return { ...e, path, row, id: row ? Number(row['Database ID']) : null };
    }));
  const linked = new Set(items.map((i) => i.row));
  for (const row of state.sheet) {
    if (!linked.has(row)) items.push({ path: null, name: '', row, id: Number(row['Database ID']), missing: true });
  }
  items.sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity) || (a.path || '').localeCompare(b.path || ''));
  let unlisted = 0;
  for (const item of items) item.label = item.id != null ? `#${item.id}` : `Unlisted ${++unlisted}`;
  state.items = items;
  await loadAnnotations();
}

/** Which annotators have a note for which recording (annotations/<annotator>/<name>.md). */
async function loadAnnotations() {
  const { annotators } = await api('/api/annotations');
  state.annotations = new Map(Object.entries(annotators).map(([name, stems]) => [name, new Set(stems)]));
  for (const item of state.items) {
    const stem = item.missing ? null : audioStem(item.name);
    item.annotators = stem ? [...state.annotations].filter(([, stems]) => stems.has(stem)).map(([name]) => name) : [];
  }
}

/** 'clip.WAV' → 'clip', and 'clip.wav.WAV' → 'clip' (Microphone 3); matches the helper. */
function audioStem(name) {
  const stem = name.replace(/\.[^.]*$/, '');
  return stem.toLowerCase().endsWith('.wav') ? stem.slice(0, -4) : stem;
}

/** Annotate mode: has the current annotator written about it? Browse: has anyone? */
function hasNote(item) {
  if (state.mode === 'annotate') return item.annotators.includes(annotatorName({ quiet: true }));
  return item.annotators.length > 0;
}

/** What a recording is called in the current mode: never its name when annotating. */
function itemTitle(item) {
  if (state.mode === 'annotate') return item.id != null ? `Recording #${item.id}` : item.label;
  return item.row ? `#${item.id} · ${item.row.Location}` : item.name;
}

function visibleItems() {
  const q = $('filter').value.trim().toLowerCase().replace(/^#/, '');
  const pool = state.mode === 'annotate' ? state.items.filter((i) => !i.missing) : state.items;
  if (!q) return pool;
  if (state.mode === 'annotate') return pool.filter((i) => String(i.id ?? i.label.toLowerCase()).startsWith(q));
  return pool.filter((i) => String(i.id).startsWith(q) || i.name.toLowerCase().includes(q) || metaText(i.row).includes(q));
}

function renderFiles() {
  const list = $('files');
  list.replaceChildren();
  const items = visibleItems();
  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const dot = document.createElement('span');
    const noted = hasNote(item);
    dot.className = `dot${noted ? ' done' : ''}${item.missing ? ' none' : ''}`;
    dot.title = item.missing ? 'No audio on the drive'
      : state.mode === 'browse' ? (noted ? `Notes by ${item.annotators.join(', ')}` : 'No notes yet')
      : noted ? 'You have a note' : 'No note from you yet';
    const lines = document.createElement('span');
    lines.className = 'lines';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = itemTitle(item);
    lines.append(name);
    if (state.mode === 'browse') {
      const sub = document.createElement('span');
      sub.className = 'sub';
      const r = item.row;
      sub.textContent = r
        ? [[r.City, r.Country].filter(Boolean).join(', '), r.Date, r['Microphone ID'], item.missing && 'no audio'].filter(Boolean).join(' · ')
        : item.path;
      lines.append(sub);
      li.title = item.path || 'Listed in the metadata sheet, but no audio on the drive';
      li.classList.toggle('missing', !!item.missing);
    }
    li.append(dot, lines);
    const active = state.current === item;
    li.classList.toggle('active', active);
    li.setAttribute('aria-selected', active);
    li.onclick = () => openFile(item);
    list.append(li);
  }
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'placeholder';
    li.textContent = $('filter').value ? 'No matching recordings' : 'No recordings found';
    list.append(li);
  }
  const recordings = state.items.filter((i) => !i.missing);
  const done = recordings.filter(hasNote).length;
  $('progress').textContent = recordings.length ? `${done}/${recordings.length} ${state.mode === 'annotate' ? 'done' : 'annotated'}` : '';
}

function neighbour(step) {
  const items = visibleItems();
  if (!items.length) return null;
  const i = items.indexOf(state.current);
  if (i === -1) return items[0];
  return items[i + step] || null;
}

const randomOrder = () => state.mode === 'annotate' && $('shuffle').checked;

/** A random other recording, preferring ones this annotator hasn't done yet. */
function randomItem() {
  const pool = visibleItems().filter((i) => !i.missing && i !== state.current);
  const todo = pool.filter((i) => !hasNote(i));
  const from = todo.length ? todo : pool;
  return from.length ? from[Math.floor(Math.random() * from.length)] : null;
}

function goNext() {
  if (!randomOrder()) {
    const next = neighbour(1);
    if (next) openFile(next);
    else toast('That was the last recording.');
    return;
  }
  const next = randomItem();
  if (!next) return toast('No other recordings to pick from.');
  if (hasNote(next)) toast('You’ve annotated every recording, so this one may repeat.');
  openFile(next);
}

function goPrev() {
  if (!randomOrder()) {
    const prev = neighbour(-1);
    if (prev) openFile(prev);
    return;
  }
  const prev = state.history.at(-1);
  if (prev) openFile(prev, { back: true });
}

// --------------------------------------------------------------- open file

async function openFile(item, { back = false } = {}) {
  const { path } = item;
  if (state.current === item) return;
  if (!(await settleUnsaved())) return;
  if (back) state.history.pop();
  else if (state.current) state.history.push(state.current);

  const seq = ++state.loadSeq;
  state.abort?.abort();
  state.abort = new AbortController();
  const { signal } = state.abort;

  const browsing = state.mode === 'browse';
  state.current = item;
  state.note = null;
  state.overview = null;
  player.unload();
  $('empty').hidden = true;
  $('file-view').hidden = false;
  $('file-name').textContent = itemTitle(item);
  renderMetadata(browsing ? item.row : null);
  // Sheet entry without a recording: metadata only.
  $('no-audio').hidden = !item.missing;
  $('player-box').hidden = !!item.missing;
  $('notes-box').hidden = !!item.missing;
  $('photo-wrap').hidden = true;
  if (item.missing) {
    $('file-meta').textContent = 'Listed in the metadata sheet · no audio on the drive';
    renderFiles();
    updateNav();
    return;
  }
  $('file-meta').textContent = browsing ? `${item.name} · ${formatSize(item.size)}` : '';
  if (browsing) loadPhoto(item, seq, signal);
  $('play').disabled = true;
  $('note').value = '';
  $('note').disabled = true;
  setNoteStatus('Loading note…');
  renderFiles();
  updateNav();

  const notePromise = (browsing ? loadAllNotes(item, seq, signal) : loadMyNote(item, seq, signal))
    .catch((err) => {
      if (seq !== state.loadSeq || err.name === 'AbortError') return;
      setNoteStatus(`Couldn’t load notes: ${err.message}`, 'error');
    });

  try {
    $('load-status').textContent = 'Reading header…';
    const info = await readWavInfo(path, item.size, signal);
    if (seq !== state.loadSeq) return;
    await player.open({ info, read: (offset, length, sig) => readRange(path, offset, length, sig) });
    if (seq !== state.loadSeq) return;
    $('load-status').textContent = '';
    $('play').disabled = false;
    const format = info.channels === 4 ? 'FOA' : `${info.channels} ch – not FOA, playing as is`;
    $('file-meta').textContent = browsing
      ? [item.name, formatSize(item.size), formatTime(info.duration), `${info.sampleRate / 1000} kHz · ${info.bits}-bit`, format].join(' · ')
      : formatTime(info.duration);
    if (browsing) loadOverview(path, info, seq, signal);
  } catch (err) {
    if (seq !== state.loadSeq || err.name === 'AbortError') return;
    $('load-status').textContent = `Couldn’t open audio: ${err.message}`;
  }
  await notePromise;
}

async function readRange(path, offset, length, signal) {
  const res = await api(`/api/audio?path=${encodeURIComponent(path)}`, {
    signal,
    raw: true,
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== length) throw new Error(`Short read (${bytes.length} of ${length} bytes)`);
  return bytes;
}

async function readWavInfo(path, size, signal) {
  let want = 64 * 1024;
  for (;;) {
    const bytes = await readRange(path, 0, Math.min(want, size), signal);
    const info = parseWavHeader(bytes, size);
    if (!info.needBytes) return info;
    if (want >= size || want >= 8 << 20) throw new Error('No audio data found in WAV header');
    want = info.needBytes;
  }
}

/** Sample short stretches across the file for a level overview, drawn as it arrives. */
async function loadOverview(path, info, seq, signal) {
  const probeFrames = Math.max(1, Math.round(OVERVIEW_PROBE_SECONDS * info.sampleRate));
  const points = Math.min(OVERVIEW_POINTS, Math.max(1, Math.floor(info.frames / probeFrames)));
  const overview = new Float32Array(points).fill(NaN);
  state.overview = overview;
  const probeBytes = probeFrames * info.blockAlign;
  const at = (i) => info.dataOffset + Math.floor((i * (info.frames - probeFrames)) / Math.max(1, points - 1)) * info.blockAlign;
  // Coarse to fine: every 8th point first, so the shape appears quickly.
  const order = [8, 4, 2, 1].flatMap((step, k, steps) =>
    Array.from({ length: points }, (_, i) => i).filter((i) => i % step === 0 && (k === 0 || i % steps[k - 1] !== 0)));
  try {
    for (let b = 0; b < order.length; b += 120) {
      const batch = order.slice(b, b + 120);
      const res = await api(`/api/readv?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        body: { ranges: batch.map((i) => [at(i), probeBytes]) },
        signal,
        raw: true,
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (seq !== state.loadSeq) return;
      batch.forEach((i, k) => {
        const [w] = decodePcm(bytes.subarray(k * probeBytes, (k + 1) * probeBytes), info, probeFrames);
        let sum = 0;
        for (const v of w) sum += v * v;
        overview[i] = 10 * Math.log10(sum / w.length + 1e-12);
      });
    }
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Overview failed:', err);
  }
}

async function loadPhoto(item, seq, signal) {
  if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
  state.photoUrl = null;
  $('photo-wrap').hidden = true;
  $('photo').removeAttribute('src');
  try {
    const res = await api(`/api/photo?path=${encodeURIComponent(item.path)}`, { raw: true, signal });
    const blob = await res.blob();
    if (seq !== state.loadSeq) return;
    state.photoUrl = URL.createObjectURL(blob);
    $('photo').src = state.photoUrl;
    $('photo-wrap').hidden = false;
    $('meta').hidden = false;
  } catch (err) {
    if (err.name !== 'AbortError' && err.status !== 404) console.warn('Photo failed:', err);
  }
}

function updateNav() {
  const random = randomOrder();
  $('prev').disabled = random ? !state.history.length : !neighbour(-1);
  $('next').disabled = random ? !visibleItems().some((i) => !i.missing && i !== state.current) : !neighbour(1);
  $('prev').title = random ? 'Back to the recording you had before' : 'Previous recording';
  $('next').title = random ? 'A random recording you haven’t annotated yet' : 'Next recording';
}

// ------------------------------------------------------------------- notes

/** Notes are markdown with a small YAML front-matter header. */
function parseNote(text) {
  const meta = {};
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2].trim();
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { /* keep raw */ } }
      meta[kv[1]] = value;
    }
    body = text.slice(m[0].length);
  }
  return { meta, body: body.replace(/^\s*\n/, '').replace(/\s+$/, '') };
}

/** Annotate mode: the current annotator's own note for this recording. */
async function loadMyNote(item, seq, signal) {
  const annotator = annotatorName({ quiet: true });
  if (!annotator) {
    state.note = { mtime: null, body: '', meta: {}, exists: false };
    $('note').value = '';
    $('note').disabled = false;
    return setNoteStatus('Enter your annotator name (top right) to load and save notes', 'dirty');
  }
  const note = await api(`/api/note?path=${encodeURIComponent(item.path)}&annotator=${encodeURIComponent(annotator)}`, { signal });
  if (seq === state.loadSeq) applyLoadedNote(note);
}

/** Browse mode: every annotator's note, read-only. */
async function loadAllNotes(item, seq, signal) {
  const list = $('notes-list');
  list.replaceChildren();
  const { notes } = await api(`/api/notes?path=${encodeURIComponent(item.path)}`, { signal });
  if (seq !== state.loadSeq) return;
  setNoteStatus(notes.length ? `${notes.length} annotator${notes.length === 1 ? '' : 's'}` : 'No notes yet');
  for (const note of notes) {
    const { meta, body } = parseNote(note.text);
    const entry = document.createElement('article');
    entry.className = 'annotation';
    const head = document.createElement('header');
    const who = document.createElement('strong');
    who.textContent = note.annotator;
    const when = document.createElement('span');
    when.textContent = meta.updated ? new Date(meta.updated).toLocaleString() : '';
    head.append(who, when);
    const text = document.createElement('p');
    text.textContent = body || '(empty note)';
    entry.append(head, text);
    list.append(entry);
  }
}

function buildNote(item, annotator, body) {
  const header = [
    '---',
    `audio: ${JSON.stringify(item.path)}`,
    ...(item.id != null ? [`id: ${item.id}`] : []),
    `annotator: ${JSON.stringify(annotator)}`,
    `updated: ${new Date().toISOString()}`,
    '---',
  ].join('\n');
  const trimmed = body.replace(/\s+$/, '');
  return `${header}\n\n${trimmed}${trimmed ? '\n' : ''}`;
}

function applyLoadedNote(note) {
  const parsed = note.exists ? parseNote(note.text) : { meta: {}, body: '' };
  state.note = { mtime: note.mtime, body: parsed.body, meta: parsed.meta, exists: note.exists };
  $('note').value = parsed.body;
  $('note').disabled = false;
  describeSavedNote();
}

function describeSavedNote() {
  const { exists, meta } = state.note;
  if (!exists) return setNoteStatus('No note yet');
  const name = meta.annotator || meta.labeller;
  const who = name ? `by ${name}` : '';
  const when = meta.updated ? new Date(meta.updated).toLocaleString() : '';
  setNoteStatus(['Saved', who, when && `· ${when}`].filter(Boolean).join(' '), 'saved');
}

function setNoteStatus(text, kind = '') {
  const el = $('note-status');
  el.textContent = text;
  el.className = `note-status ${kind}`;
}

function isDirty() {
  return !!state.note && $('note').value.replace(/\s+$/, '') !== state.note.body;
}

const ANNOTATOR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The annotator name, which is also their folder under annotations/. */
function annotatorName({ quiet = false } = {}) {
  const input = $('annotator');
  const name = input.value.trim();
  const ok = ANNOTATOR_RE.test(name);
  input.classList.toggle('missing', !ok);
  if (!ok && !quiet) {
    input.focus();
    toast(name
      ? 'Annotator names can use letters, digits, ".", "_" and "-" (it becomes a folder name).'
      : 'Enter your annotator name (top right) before saving.');
  }
  return ok ? name : '';
}

async function saveNote({ force = false } = {}) {
  if (!state.current || !state.note || state.mode !== 'annotate') return false;
  if (!force && !isDirty() && state.note.exists) return true;
  const annotator = annotatorName();
  if (!annotator) return false;

  const item = state.current;
  const { path } = item;
  const body = $('note').value;
  const text = buildNote(item, annotator, body);
  setNoteStatus('Saving…');
  $('save').disabled = true;
  try {
    const res = await api(`/api/note?path=${encodeURIComponent(path)}&annotator=${encodeURIComponent(annotator)}`, {
      method: 'PUT',
      body: { text, base_mtime: state.note.mtime },
    });
    if (state.current?.path !== path) return true;
    state.note = { mtime: res.mtime, body: body.replace(/\s+$/, ''), meta: parseNote(text).meta, exists: true };
    describeSavedNote();
    if (!item.annotators.includes(annotator)) item.annotators.push(annotator);
    if (!state.annotations.has(annotator)) state.annotations.set(annotator, new Set());
    state.annotations.get(annotator).add(audioStem(item.name));
    renderFiles();
    return true;
  } catch (err) {
    if (err.status === 409) return resolveConflict(err.body, body);
    setNoteStatus(`Not saved: ${err.message}`, 'error');
    toast(`Note not saved: ${err.message}`);
    return false;
  } finally {
    $('save').disabled = false;
  }
}

/** This note was saved elsewhere (another tab or computer) after it was opened. Never lose either text. */
async function resolveConflict(theirs, mine) {
  const parsed = parseNote(theirs.text);
  const overwrite = confirm(
    'Your note for this recording was changed from another window or computer after you opened it.\n\n' +
    'OK: replace it with the text here.\n' +
    'Cancel: keep the saved version, with the text here added below it for you to merge.',
  );
  state.note = { mtime: theirs.mtime, body: parsed.body, meta: parsed.meta, exists: true };
  if (overwrite) return saveNote({ force: true });
  $('note').value = `${parsed.body}\n\n---\n${mine.trim()}\n`;
  setNoteStatus('Merged with the saved version. Review, then save.', 'dirty');
  return false;
}

/** Before leaving a file: save if possible, otherwise ask. */
async function settleUnsaved() {
  if (!isDirty()) return true;
  if (annotatorName({ quiet: true }) && (await saveNote())) return true;
  return confirm('This note has unsaved changes. Discard them?');
}

async function saveAndNext() {
  if (!(await saveNote({ force: !state.note?.exists }))) return;
  goNext();
}

// ---------------------------------------------------------------- waveform

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawWave() {
  const canvas = $('wave');
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);
  if (state.mode === 'annotate') return drawProgressBar(ctx, w, h);
  const overview = state.overview;
  if (!overview || !player.duration) return;
  // Level envelope of W, scaled to the recording's own range.
  let lo = Infinity, hi = -Infinity;
  for (const v of overview) if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const floor = Math.max(lo, hi - 50) - 3;
  const range = Math.max(6, hi - floor);
  const progress = player.currentTime / player.duration;
  const mid = h / 2;
  const colours = [css('--wave'), css('--wave-played')];
  const n = overview.length;
  for (let x = 0; x < w; x++) {
    // Nearest loaded point, so the coarse first pass already fills the width.
    const i = Math.min(n - 1, Math.round((x / w) * (n - 1)));
    let v = overview[i];
    for (let d = 1; Number.isNaN(v) && d < 8; d++) {
      if (i - d >= 0 && !Number.isNaN(overview[i - d])) v = overview[i - d];
      else if (i + d < n && !Number.isNaN(overview[i + d])) v = overview[i + d];
    }
    if (Number.isNaN(v)) continue;
    const amp = Math.max(0.02, Math.min(1, (v - floor) / range)) * mid * 0.94;
    ctx.fillStyle = colours[x / w < progress ? 1 : 0];
    ctx.fillRect(x, mid - amp, 1, 2 * amp);
  }
  ctx.fillStyle = css('--text');
  ctx.fillRect(Math.round(progress * w), 0, Math.max(1, window.devicePixelRatio || 1), h);
}

/** Annotate mode: a plain progress bar, nothing about the content. */
function drawProgressBar(ctx, w, h) {
  const dpr = window.devicePixelRatio || 1;
  const track = 6 * dpr;
  const y = (h - track) / 2;
  const progress = player.duration ? player.currentTime / player.duration : 0;
  ctx.fillStyle = css('--line');
  roundRect(ctx, 0, y, w, track, track / 2);
  ctx.fillStyle = css('--accent');
  if (progress > 0) roundRect(ctx, 0, y, Math.max(track, progress * w), track, track / 2);
  if (player.duration) {
    ctx.beginPath();
    ctx.arc(Math.min(w - 7 * dpr, Math.max(7 * dpr, progress * w)), h / 2, 7 * dpr, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

// ------------------------------------------------------------------- dial

const view = { yaw: 0, pitch: 0, doa: null };

function setView(yaw, pitch = view.pitch) {
  yaw = ((yaw + 540) % 360) - 180;
  view.yaw = Math.round(yaw);
  view.pitch = Math.round(pitch);
  $('yaw').value = view.yaw;
  $('pitch').value = view.pitch;
  $('yaw-out').textContent = `${view.yaw}°`;
  $('pitch-out').textContent = `${view.pitch}°`;
  player.setRotation(view.yaw, view.pitch);
}

function drawDial() {
  const canvas = $('dial');
  const dpr = fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 18 * dpr;
  const pos = (azDeg, radius) => [cx - radius * Math.sin(azDeg * Math.PI / 180), cy - radius * Math.cos(azDeg * Math.PI / 180)];
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = css('--line');
  ctx.lineWidth = 1.5 * dpr;
  for (const f of [1, 0.5]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * f, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.fillStyle = css('--muted');
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [label, az] of [['Front', 0], ['L', 90], ['Back', 180], ['R', -90]]) {
    const [x, y] = pos(az, r + 10 * dpr);
    ctx.fillText(label, x, y);
  }

  // Listening direction (head) as a wedge.
  const spread = 28;
  const [ax, ay] = pos(view.yaw - spread, r * 0.9);
  const [bx, by] = pos(view.yaw + spread, r * 0.9);
  ctx.fillStyle = css('--accent-soft');
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(ax, ay);
  ctx.arc(cx, cy, r * 0.9, Math.atan2(ay - cy, ax - cx), Math.atan2(by - cy, bx - cx), true);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 2 * dpr;
  const [hx, hy] = pos(view.yaw, r * 0.9);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = css('--accent');
  ctx.beginPath();
  ctx.arc(cx, cy, 5 * dpr, 0, 2 * Math.PI);
  ctx.fill();

  // Direction of arrival of the sound energy.
  const d = view.doa;
  if (d && d.levelDb > -70) {
    const radial = r * Math.cos(d.elevation * Math.PI / 180);
    const [x, y] = pos(d.azimuth, radial);
    ctx.globalAlpha = 0.25 + 0.75 * d.directness;
    ctx.fillStyle = css('--warn');
    ctx.beginPath();
    ctx.arc(x, y, (5 + 6 * d.directness) * dpr, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function dialToYaw(event) {
  const rect = $('dial').getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  return Math.atan2(-dx, -dy) * 180 / Math.PI;
}

// ------------------------------------------------------------- animation

let lastDoaText = '';
function frame() {
  if (!$('file-view').hidden) {
    $('time').textContent = `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
    const buffering = player.buffering ? 'Buffering…' : '';
    if (state.current && player.info && $('load-status').textContent !== buffering) $('load-status').textContent = buffering;
    drawWave();
    if (state.mode === 'browse') {
      view.doa = player.readDirection();
      drawDial();
    }
    const d = view.doa;
    const text = d && d.levelDb > -70
      ? `Sound from az ${Math.round(d.azimuth)}°, el ${Math.round(d.elevation)}° · ${Math.round(d.directness * 100)}% direct`
      : '';
    if (text !== lastDoaText) { $('doa').textContent = text; lastDoaText = text; }
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ wiring

function wire() {
  for (const id of ['mod-key', 'mod-key2']) $(id).textContent = isMac ? '⌘' : 'Ctrl';

  const annotator = $('annotator');
  annotator.addEventListener('input', () => annotator.classList.remove('missing'));
  // Notes are per annotator, so a new name shows that annotator's progress and note.
  annotator.addEventListener('change', () => {
    const name = annotatorName();
    if (!name) return;
    store.set(`annotator:${state.user}`, name);
    renderFiles();
    if (state.mode === 'annotate' && state.current && !state.current.missing && !isDirty()) {
      loadMyNote(state.current, state.loadSeq).catch((err) => setNoteStatus(`Couldn’t load note: ${err.message}`, 'error'));
    }
  });

  $('connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const bridge = parseConnectLink($('connect-url').value.trim());
    if (!bridge) {
      $('connect-error').textContent = 'That doesn’t look like the link the helper printed (it contains #bridge=…&token=…).';
      return;
    }
    $('connect-error').textContent = 'Connecting…';
    try {
      await connect(bridge);
    } catch (err) {
      showConnect(connectErrorMessage(err));
    }
  });

  $('disconnect').addEventListener('click', async () => {
    if (!(await settleUnsaved())) return;
    store.remove('bridge');
    closeFile();
    showConnect();
  });

  for (const card of document.querySelectorAll('.mode-card')) {
    card.addEventListener('click', () => chooseMode(card.dataset.mode));
  }
  $('switch-mode').addEventListener('click', async () => {
    if (!(await settleUnsaved())) return;
    closeFile();
    showModeChooser();
  });

  $('photo-wrap').addEventListener('click', () => {
    $('lightbox-img').src = $('photo').src;
    $('lightbox').hidden = false;
  });
  $('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

  $('filter').addEventListener('input', () => { renderFiles(); updateNav(); });
  $('prev').addEventListener('click', goPrev);
  $('next').addEventListener('click', goNext);
  $('shuffle').checked = store.get('shuffle') === '1';
  $('shuffle').addEventListener('change', (e) => {
    store.set('shuffle', e.target.checked ? '1' : '0');
    updateNav();
  });

  $('play').addEventListener('click', () => player.toggle());
  player.addEventListener('change', () => {
    $('play-icon').setAttribute('d', player.playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
    $('play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  });
  player.addEventListener('error', (e) => toast(`Playback stopped: ${e.detail.message}`));
  $('loop').addEventListener('change', (e) => player.setLoop(e.target.checked));
  for (const radio of document.querySelectorAll('input[name="render"]')) {
    radio.addEventListener('change', (e) => player.setMode(e.target.value));
  }
  $('gain').addEventListener('input', (e) => {
    const db = Number(e.target.value);
    $('gain-out').textContent = `${db > 0 ? '+' : ''}${db} dB`;
    player.setGainDb(db);
  });

  $('wave').addEventListener('pointerdown', (e) => {
    if (!player.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * player.duration);
  });

  $('yaw').addEventListener('input', (e) => setView(Number(e.target.value)));
  $('pitch').addEventListener('input', (e) => setView(view.yaw, Number(e.target.value)));
  $('reset-view').addEventListener('click', () => setView(0, 0));
  const dial = $('dial');
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    setView(dialToYaw(e));
  });
  dial.addEventListener('pointermove', (e) => {
    if (dial.hasPointerCapture(e.pointerId)) setView(dialToYaw(e));
  });

  $('note').addEventListener('input', () => {
    if (isDirty()) setNoteStatus('Unsaved changes', 'dirty');
    else if (state.note) describeSavedNote();
  });
  $('save').addEventListener('click', () => saveNote({ force: true }));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('lightbox').hidden = true;
    if ($('work-view').hidden || !state.current) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNote({ force: true });
      return;
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      saveAndNext();
      return;
    }
    const typing = e.target.closest('input[type="text"], input[type="search"], textarea');
    if (typing || mod || e.altKey) return;
    if (e.key === ' ') {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.matches('input[type="range"]')) return;
      e.preventDefault();
      player.seek(player.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });
}

async function start() {
  wire();
  requestAnimationFrame(frame);

  // A fresh link from the helper wins over whatever was stored.
  let bridge = parseConnectLink(location.hash);
  if (bridge) {
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { bridge = JSON.parse(store.get('bridge')); } catch { bridge = null; }
  }
  if (!bridge) return showConnect();
  try {
    await connect(bridge);
  } catch (err) {
    showConnect(connectErrorMessage(err));
  }
}

start();
