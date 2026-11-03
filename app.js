/* Globe Trotter — a minimal visited-places map.
   Three levels of detail share one projection: countries (always loaded),
   admin-1 regions and cities are fetched the first time you open them. */

const STORAGE_KEY = 'globe-trotter/v1';

const VIEWS = {
  countries: { label: 'Countries visited', noun: 'country', placeholder: 'Search a country…' },
  regions: { label: 'Regions visited', noun: 'region', placeholder: 'Search a state, province or region…' },
  cities: { label: 'Cities visited', noun: 'city', placeholder: 'Search a city…' }
};

/* City density per zoom level: how many of the most-populous cities to draw. */
const CITY_STEPS = [
  { k: 1.6, n: 150 },
  { k: 3, n: 450 },
  { k: 6, n: 1200 },
  { k: 12, n: 3000 },
  { k: Infinity, n: Infinity }
];

const state = {
  view: 'countries',
  panelOpen: true,
  visited: { countries: new Set(), regions: new Set(), cities: new Set() },
  bucket: { countries: [], regions: [], cities: [] }
};

/* Per-view registry: { items: [{id,name,sub,search}], byId: Map, nodes: Map, loaded } */
const layers = {
  countries: { items: [], byId: new Map(), nodes: new Map(), loaded: false },
  regions: { items: [], byId: new Map(), nodes: new Map(), loaded: false },
  cities: { items: [], byId: new Map(), nodes: new Map(), loaded: false }
};

const el = {
  panel: document.getElementById('panel'),
  panelToggle: document.getElementById('panel-toggle'),
  segmented: document.querySelector('.segmented'),
  worldLabel: document.getElementById('world-label'),
  worldCount: document.getElementById('world-count'),
  worldTotal: document.getElementById('world-total'),
  worldBar: document.getElementById('world-bar'),
  bucketPill: document.getElementById('bucket-pill'),
  bucketBar: document.getElementById('bucket-bar'),
  bucketSub: document.getElementById('bucket-sub'),
  bucketList: document.getElementById('bucket-list'),
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  stage: document.getElementById('stage'),
  tooltip: document.getElementById('tooltip'),
  loading: document.getElementById('loading'),
  fileImport: document.getElementById('file-import')
};

const svg = d3.select('#map');
const gWorld = d3.select('#world');
const gLayer = {
  countries: d3.select('#layer-countries'),
  regions: d3.select('#layer-regions'),
  cities: d3.select('#layer-cities')
};

const projection = d3.geoNaturalEarth1();
const path = d3.geoPath(projection);
let size = { width: 0, height: 0 };
let transform = d3.zoomIdentity;
let cityLimit = null;

const zoom = d3.zoom()
  .scaleExtent([1, 60])
  .on('start', () => svg.classed('dragging', true))
  .on('end', () => { svg.classed('dragging', false); syncCityScale(true); })
  .on('zoom', (event) => {
    transform = event.transform;
    gWorld.attr('transform', transform);
    syncCityScale(false);
  });

/* ---------------------------------------------------------------- storage */

function load() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    raw = null;
  }
  if (!raw) return;
  try {
    applySnapshot(raw);
  } catch {
    /* stored data is malformed — start fresh rather than fail to boot */
  }
}

function idList(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
    throw new TypeError('Expected a list of ids');
  }
  return value;
}

// Validates the whole snapshot before touching state, so a bad file can't
// leave some views replaced and others not.
function applySnapshot(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Expected an object');
  const next = { visited: {}, bucket: {} };
  for (const view of Object.keys(VIEWS)) {
    next.visited[view] = new Set(idList(raw.visited?.[view]));
    next.bucket[view] = Array.from(new Set(idList(raw.bucket?.[view])));
  }
  Object.assign(state.visited, next.visited);
  Object.assign(state.bucket, next.bucket);
  if (Object.hasOwn(VIEWS, raw.view)) state.view = raw.view;
  if (typeof raw.panelOpen === 'boolean') state.panelOpen = raw.panelOpen;
}

function snapshot() {
  return {
    v: 1,
    view: state.view,
    panelOpen: state.panelOpen,
    visited: {
      countries: [...state.visited.countries],
      regions: [...state.visited.regions],
      cities: [...state.visited.cities]
    },
    bucket: { ...state.bucket }
  };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
  } catch {
    /* storage full or blocked — the map still works for this session */
  }
}

/* ------------------------------------------------------------------- data */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

function busy(on, text = 'Loading map…') {
  el.loading.hidden = !on;
  el.loading.lastChild.textContent = text;
}

async function loadCountries() {
  const topo = await fetchJSON('data/countries.topo.json');
  const features = topojson.feature(topo, topo.objects.countries).features;
  const layer = layers.countries;

  for (const f of features) {
    const p = f.properties;
    const id = p.iso && p.iso !== '-99' ? p.iso : `X${slug(p.name)}`;
    const item = { id, name: p.name, sub: p.continent, feature: f };
    item.search = norm(`${item.name} ${p.label || ''} ${p.iso2 || ''} ${id}`);
    layer.items.push(item);
    layer.byId.set(id, item);
  }
  layer.items.sort((a, b) => a.name.localeCompare(b.name));

  gLayer.countries.selectAll('path')
    .data(layer.items, (d) => d.id)
    .join('path')
    .attr('class', 'country')
    .attr('d', (d) => path(d.feature))
    .each(function (d) { layer.nodes.set(d.id, this); })
    .on('click', (event, d) => onPick(event, 'countries', d))
    .on('contextmenu', (event, d) => onContext(event, 'countries', d))
    .on('pointerenter', (event, d) => showTip(event, 'countries', d))
    .on('pointermove', moveTip)
    .on('pointerleave', hideTip);

  layer.loaded = true;
}

async function loadRegions() {
  const topo = await fetchJSON('data/regions.topo.json');
  const features = topojson.feature(topo, topo.objects.regions).features;
  const layer = layers.regions;

  for (const f of features) {
    const p = f.properties;
    const item = { id: p.code, name: p.region || p.iso2 || p.code, sub: p.country, feature: f };
    item.search = norm(`${item.name} ${item.sub} ${p.iso2 || ''}`);
    layer.items.push(item);
    layer.byId.set(item.id, item);
  }
  layer.items.sort((a, b) => a.name.localeCompare(b.name));

  gLayer.regions.selectAll('path')
    .data(layer.items, (d) => d.id)
    .join('path')
    .attr('class', 'region')
    .attr('d', (d) => path(d.feature))
    .each(function (d) { layer.nodes.set(d.id, this); })
    .on('click', (event, d) => onPick(event, 'regions', d))
    .on('contextmenu', (event, d) => onContext(event, 'regions', d))
    .on('pointerenter', (event, d) => showTip(event, 'regions', d))
    .on('pointermove', moveTip)
    .on('pointerleave', hideTip);

  layer.loaded = true;
}

async function loadCities() {
  const raw = await fetchJSON('data/cities.json');
  const idx = Object.fromEntries(raw.fields.map((f, i) => [f, i]));
  const layer = layers.cities;

  raw.rows.forEach((row, rank) => {
    const item = {
      id: row[idx.id],
      name: row[idx.name],
      sub: [row[idx.region], row[idx.country]].filter(Boolean).join(', '),
      lon: row[idx.lon],
      lat: row[idx.lat],
      pop: row[idx.pop],
      rank // rows arrive sorted by population, so the index is the density rank
    };
    item.search = norm(`${item.name} ${item.sub}`);
    layer.items.push(item);
    layer.byId.set(item.id, item);
  });

  gLayer.cities.selectAll('circle')
    .data(layer.items, (d) => d.id)
    .join('circle')
    .attr('class', 'city')
    .attr('r', 3)
    .each(function (d) { layer.nodes.set(d.id, this); })
    .on('click', (event, d) => onPick(event, 'cities', d))
    .on('contextmenu', (event, d) => onContext(event, 'cities', d))
    .on('pointerenter', (event, d) => showTip(event, 'cities', d))
    .on('pointermove', moveTip)
    .on('pointerleave', hideTip);

  layer.loaded = true;
  placeCities();
  syncCityScale(true);
}

async function ensureLoaded(view) {
  if (layers[view].loaded) return;
  busy(true, view === 'regions' ? 'Loading regions…' : 'Loading cities…');
  try {
    if (view === 'regions') await loadRegions();
    if (view === 'cities') await loadCities();
  } finally {
    busy(false);
  }
}

/* ---------------------------------------------------------------- geometry */

function resize() {
  const rect = el.stage.getBoundingClientRect();
  size = { width: Math.max(320, rect.width), height: Math.max(240, rect.height) };
  svg.attr('viewBox', `0 0 ${size.width} ${size.height}`);
  projection.fitExtent([[10, 10], [size.width - 10, size.height - 10]], { type: 'Sphere' });
  zoom.translateExtent([[0, 0], [size.width, size.height]]);

  for (const view of ['countries', 'regions']) {
    if (layers[view].loaded) {
      gLayer[view].selectAll('path').attr('d', (d) => path(d.feature));
    }
  }
  if (layers.cities.loaded) placeCities();
}

function placeCities() {
  gLayer.cities.selectAll('circle')
    .attr('cx', (d) => (d.xy = projection([d.lon, d.lat]))[0])
    .attr('cy', (d) => d.xy[1]);
}

/* Cities keep a constant on-screen size, and thin out when zoomed away. */
function syncCityScale(settled) {
  if (!layers.cities.loaded) return;
  const k = transform.k;
  gLayer.cities.style('--city-r', 3 / k);
  if (!settled) return;

  gLayer.cities.selectAll('circle').attr('r', 3 / k);
  const limit = CITY_STEPS.find((s) => k < s.k).n;
  if (limit === cityLimit) return;
  cityLimit = limit;
  refreshCityVisibility();
}

function refreshCityVisibility() {
  for (const item of layers.cities.items) {
    const node = layers.cities.nodes.get(item.id);
    if (!node) continue;
    const keep = item.rank < cityLimit ||
      state.visited.cities.has(item.id) ||
      state.bucket.cities.includes(item.id);
    node.style.display = keep ? '' : 'none';
  }
}

function focusOn(view, item) {
  const stageSize = Math.min(size.width, size.height);
  let k;
  let cx;
  let cy;

  if (view === 'cities') {
    [cx, cy] = item.xy || projection([item.lon, item.lat]);
    k = 12;
  } else {
    const [[x0, y0], [x1, y1]] = path.bounds(item.feature);
    cx = (x0 + x1) / 2;
    cy = (y0 + y1) / 2;
    k = Math.min(30, 0.7 * stageSize / Math.max(x1 - x0, y1 - y0, 1));
  }

  k = Math.max(1, Math.min(60, k));
  svg.transition().duration(600).call(
    zoom.transform,
    d3.zoomIdentity.translate(size.width / 2, size.height / 2).scale(k).translate(-cx, -cy)
  );
}

/* ------------------------------------------------------------ interactions */

function onPick(event, view, item) {
  event.preventDefault();
  if (event.altKey) toggleBucket(view, item.id);
  else toggleVisited(view, item.id);
}

function onContext(event, view, item) {
  event.preventDefault();
  toggleBucket(view, item.id);
}

function toggleVisited(view, id) {
  const set = state.visited[view];
  if (set.has(id)) set.delete(id);
  else set.add(id);
  paint(view, id);
  if (view === 'cities') refreshCityVisibility();
  render();
  save();
}

function toggleBucket(view, id) {
  const list = state.bucket[view];
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
  else list.push(id);
  paint(view, id);
  if (view === 'cities') refreshCityVisibility();
  render();
  save();
}

function paint(view, id) {
  const node = layers[view].nodes.get(id);
  if (!node) return;
  node.classList.toggle('visited', state.visited[view].has(id));
  node.classList.toggle('wish', state.bucket[view].includes(id));
}

function paintAll(view) {
  const layer = layers[view];
  if (!layer.loaded) return;
  for (const item of layer.items) paint(view, item.id);
}

function showTip(event, view, item) {
  const visited = state.visited[view].has(item.id);
  const wished = state.bucket[view].includes(item.id);
  const tags = [visited && 'visited', wished && 'bucket list'].filter(Boolean).join(' · ');
  el.tooltip.innerHTML =
    `${escapeHTML(item.name)}${item.sub ? ` <em>${escapeHTML(item.sub)}</em>` : ''}` +
    (tags ? `<br><em>${tags}</em>` : '');
  el.tooltip.hidden = false;
  moveTip(event);
}

function moveTip(event) {
  const rect = el.stage.getBoundingClientRect();
  el.tooltip.style.left = `${event.clientX - rect.left}px`;
  el.tooltip.style.top = `${event.clientY - rect.top}px`;
}

function hideTip() {
  el.tooltip.hidden = true;
}

async function setView(view) {
  if (!(view in VIEWS)) return;
  state.view = view;
  hideTip();
  closeResults();

  el.segmented.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.view === view);
  });

  await ensureLoaded(view);

  gLayer.regions.attr('hidden', view === 'regions' ? null : '');
  gLayer.cities.attr('hidden', view === 'cities' ? null : '');
  gWorld.classed('sub', view !== 'countries');

  paintAll(view);
  if (view === 'cities') { syncCityScale(true); refreshCityVisibility(); }
  el.search.value = '';
  render();
  save();
}

/* -------------------------------------------------------------- rendering */

function render() {
  const view = state.view;
  const layer = layers[view];
  const visited = state.visited[view];
  const bucket = state.bucket[view];

  el.worldLabel.textContent = VIEWS[view].label;
  el.worldCount.textContent = visited.size.toLocaleString();
  el.worldTotal.textContent = layer.items.length ? ` / ${layer.items.length.toLocaleString()}` : '';
  el.worldBar.style.width = layer.items.length
    ? `${(visited.size / layer.items.length) * 100}%`
    : '0%';
  el.search.placeholder = VIEWS[view].placeholder;

  const done = bucket.filter((id) => visited.has(id)).length;
  const pct = bucket.length ? Math.round((done / bucket.length) * 100) : 0;
  el.bucketPill.textContent = `${pct}%`;
  el.bucketBar.style.width = `${pct}%`;
  el.bucketSub.textContent = bucket.length
    ? `${done} of ${bucket.length} on your list visited`
    : `Add dream destinations, then tick them off on the map.`;

  renderBucket(view);
}

function renderBucket(view) {
  const layer = layers[view];
  el.bucketList.replaceChildren(...state.bucket[view].map((id) => {
    const item = layer.byId.get(id);
    const done = state.visited[view].has(id);

    const li = document.createElement('li');
    li.className = done ? 'done' : '';

    const tick = document.createElement('button');
    tick.className = 'tick';
    tick.title = done ? 'Mark as not visited' : 'Mark as visited';
    tick.setAttribute('aria-label', tick.title);
    tick.addEventListener('click', () => toggleVisited(view, id));

    const name = document.createElement('button');
    name.className = 'name';
    name.innerHTML = `${escapeHTML(item ? item.name : id)}${item?.sub ? ` <em>${escapeHTML(item.sub)}</em>` : ''}`;
    name.title = 'Show on map';
    name.addEventListener('click', () => item && focusOn(view, item));

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = 'Remove from bucket list';
    rm.setAttribute('aria-label', rm.title);
    rm.addEventListener('click', () => toggleBucket(view, id));

    li.append(tick, name, rm);
    return li;
  }));
}

/* ----------------------------------------------------------------- search */

let cursor = -1;
let matches = [];

function runSearch(query) {
  const view = state.view;
  const q = norm(query.trim());
  if (q.length < 2) return closeResults();

  const layer = layers[view];
  const onList = new Set(state.bucket[view]);
  const starts = [];
  const contains = [];

  for (const item of layer.items) {
    if (onList.has(item.id)) continue;
    const at = item.search.indexOf(q);
    if (at === 0) starts.push(item);
    else if (at > 0 && contains.length < 12) contains.push(item);
    if (starts.length >= 12) break;
  }

  matches = [...starts, ...contains].slice(0, 12);
  cursor = matches.length ? 0 : -1;
  el.results.hidden = false;

  if (!matches.length) {
    el.results.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: `No ${VIEWS[view].noun} found`
    }));
    return;
  }

  el.results.replaceChildren(...matches.map((item, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${escapeHTML(item.name)}${item.sub ? ` <small>${escapeHTML(item.sub)}</small>` : ''}`;
    b.className = i === cursor ? 'is-cursor' : '';
    b.addEventListener('click', () => addFromSearch(item));
    return b;
  }));
}

function addFromSearch(item) {
  const view = state.view;
  if (!state.bucket[view].includes(item.id)) toggleBucket(view, item.id);
  el.search.value = '';
  closeResults();
  focusOn(view, item);
}

function closeResults() {
  el.results.hidden = true;
  el.results.replaceChildren();
  matches = [];
  cursor = -1;
}

function moveCursor(delta) {
  if (!matches.length) return;
  cursor = (cursor + delta + matches.length) % matches.length;
  [...el.results.children].forEach((n, i) => n.classList.toggle('is-cursor', i === cursor));
  el.results.children[cursor]?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ utils */

function norm(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function slug(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function setPanel(open) {
  state.panelOpen = open;
  el.panel.classList.toggle('collapsed', !open);
  el.panelToggle.setAttribute('aria-expanded', String(open));
  el.panelToggle.title = open ? 'Collapse panel' : 'Expand panel';
  save();
}

/* ------------------------------------------------------------------- wire */

el.panelToggle.addEventListener('click', () => setPanel(!state.panelOpen));

el.segmented.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) setView(btn.dataset.view);
});

el.search.addEventListener('input', () => runSearch(el.search.value));
el.search.addEventListener('focus', () => runSearch(el.search.value));

el.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
  else if (e.key === 'Enter' && matches[cursor]) { e.preventDefault(); addFromSearch(matches[cursor]); }
  else if (e.key === 'Escape') { el.search.value = ''; closeResults(); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search')) closeResults();
});

document.getElementById('zoom-in').addEventListener('click', () => svg.transition().duration(220).call(zoom.scaleBy, 1.6));
document.getElementById('zoom-out').addEventListener('click', () => svg.transition().duration(220).call(zoom.scaleBy, 1 / 1.6));
document.getElementById('zoom-reset').addEventListener('click', () => svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity));

document.getElementById('btn-export').addEventListener('click', () => {
  download('globe-trotter.json', JSON.stringify(snapshot(), null, 2));
});

document.getElementById('btn-import').addEventListener('click', () => el.fileImport.click());

el.fileImport.addEventListener('change', async () => {
  const file = el.fileImport.files?.[0];
  if (!file) return;
  try {
    applySnapshot(JSON.parse(await file.text()));
    for (const view of Object.keys(VIEWS)) paintAll(view);
    await setView(state.view);
  } catch {
    alert('That file could not be read as a Globe Trotter export.');
  }
  el.fileImport.value = '';
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Clear every visited place and bucket list?')) return;
  for (const view of Object.keys(VIEWS)) {
    state.visited[view] = new Set();
    state.bucket[view] = [];
    paintAll(view);
  }
  render();
  save();
});

window.addEventListener('resize', debounce(resize, 120));
new ResizeObserver(debounce(resize, 100)).observe(el.stage);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------------------------------------------- boot */

(async function start() {
  load();
  setPanel(state.panelOpen);
  svg.call(zoom);
  resize();

  busy(true, 'Loading map…');
  try {
    await loadCountries();
  } catch (err) {
    busy(false);
    el.bucketSub.textContent = 'Could not load map data. Serve this folder over http (e.g. `python3 -m http.server`).';
    console.error(err);
    return;
  }
  busy(false);

  await setView(state.view);
})();
