/* Capybara Pigeon — client */
(() => {
  'use strict';

  // =====================================================================
  // Config
  // =====================================================================
  const CORNELL = [-76.4835, 42.4478];
  const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  const SLIDER_START_HOUR = 17; // 5:00 PM; slider value = minutes after this
  const BUCKET_MIN = 30;
  const STAY_MIN = 45; // planned time at each stop
  const WALK_MPS = 1.4;
  const WALK_DETOUR = 1.3;
  const SIM_PING = [-76.4850, 42.4465]; // just outside Willard Straight Hall
  const SIM_WALK_FROM = [-76.4852, 42.4428]; // walking up from Collegetown
  const CLUSTER_M = 170; // events closer than this share a busy-ness glow
  const TEN_DOLLARS = 10;

  const HUBS = [
    { id: 'north', name: 'North Campus', sub: 'RPCC / Appel', coords: [-76.4785, 42.4558] },
    { id: 'central', name: 'Central Campus', sub: 'Willard Straight / Ho Plaza', coords: [-76.4853, 42.4467] },
    { id: 'arts', name: 'Arts Quad', sub: 'Goldwin Smith', coords: [-76.4846, 42.4486] },
    { id: 'engineering', name: 'Engineering Quad', sub: 'Duffield', coords: [-76.4826, 42.4446] },
    { id: 'west', name: 'West Campus', sub: 'Bethe / Rose', coords: [-76.4912, 42.4470] },
    { id: 'collegetown', name: 'Collegetown', sub: 'Dryden / College Ave', coords: [-76.4852, 42.4418] },
  ];
  const hubById = Object.fromEntries(HUBS.map((h) => [h.id, h]));
  const hubPlace = (id) => ({ name: id === 'north' ? 'Current Location · North Campus' : hubById[id].name, coords: hubById[id].coords, hubId: id });

  const CATEGORY_COLORS = {
    'A Cappella': '#b48ead',
    Music: '#6c9bd2',
    Food: '#f2b544',
    Party: '#e88aa6',
    Social: '#e07a5f',
    Outdoors: '#8fb996',
    Film: '#7fb3c8',
    Arts: '#c8a2d6',
    Tech: '#9bbf5a',
  };
  const DEFAULT_COLOR = '#c49a6c';

  // =====================================================================
  // State
  // =====================================================================
  const state = {
    tab: 'explore',
    events: [],
    byId: new Map(),
    markers: new Map(), // eventId -> { wrap, dot, num, visible }
    balance: null,
    balanceSource: null,
    timeMs: 0,
    playing: false,
    chain: new Set(),
    paid: new Map(), // eventId -> { transferId, amount }
    paying: new Set(),
    route: null, // { coords, times } for the pigeon playback marker
    lastRoute: null,
    lastPitStopId: null,
    night: null,
    from: hubPlace('north'),
    to: null,
    pickTarget: null,
    budget: 'ten', // 'free' | 'ten' | 'max'
    detours: [],
    me: null, // { coords, at } real position from the phone app or the browser
    heading: null, // degrees clockwise from north, once a compass reading arrives
    lastAddError: '', // why the last addToChain() said no (reported back to text replies)
  };
  let simulating = false;
  let buying = false;
  const demo = { running: false, cancelled: false, skip: null };

  // =====================================================================
  // DOM
  // =====================================================================
  const $ = (id) => document.getElementById(id);
  const el = {
    wallet: $('wallet'),
    balance: $('balance'),
    balanceDot: $('balanceDot'),
    judgeDemo: $('judgeDemo'),
    alertsBtn: $('alertsBtn'),
    alertsPop: $('alertsPop'),
    alertsToggle: $('alertsToggle'),
    alertsWhere: $('alertsWhere'),
    alertsVia: $('alertsVia'),
    alertKinds: $('alertKinds'),
    alertStyle: $('alertStyle'),
    alertStyleExtra: $('alertStyleExtra'),
    numberChange: $('numberChange'),
    numberForm: $('numberForm'),
    numberInput: $('numberInput'),
    joinStep: $('joinStep'),
    joinLink: $('joinLink'),
    numberHint: $('numberHint'),
    pickHint: $('pickHint'),
    pickHintText: $('pickHintText'),
    pickCancel: $('pickCancel'),
    demoCaption: $('demoCaption'),
    demoStep: $('demoStep'),
    demoTitle: $('demoTitle'),
    demoSub: $('demoSub'),
    demoBar: $('demoBar'),
    demoNext: $('demoNext'),
    demoStop: $('demoStop'),
    coach: $('coach'),
    coachClose: $('coachClose'),
    dock: $('dock'),
    locate: $('locate'),
    eventCard: $('eventCard'),
    timebar: $('timebar'),
    play: $('play'),
    readout: $('readout'),
    liveCount: $('liveCount'),
    slider: $('slider'),
    density: $('density'),
    trackFill: $('trackFill'),
    playhead: $('playhead'),
    planPanel: $('planPanel'),
    tonightPanel: $('tonightPanel'),
    fromSelect: $('fromSelect'),
    toSelect: $('toSelect'),
    swap: $('swap'),
    tripSummary: $('tripSummary'),
    tripBody: $('tripBody'),
    detourBlock: $('detourBlock'),
    detourDots: $('detourDots'),
    detourSummary: $('detourSummary'),
    detours: $('detours'),
    budgetMax: $('budgetMax'),
    pitstop: $('pitstop'),
    planHero: $('planHero'),
    interestChips: $('interestChips'),
    interestExtra: $('interestExtra'),
    curate: $('curate'),
    night: $('night'),
    tonightBadge: $('tonightBadge'),
    confetti: $('confetti'),
    imessage: $('imessage'),
    imMeta: $('imMeta'),
    imThread: $('imThread'),
    imAgent: $('imAgent'),
    imDelivery: $('imDelivery'),
    imAdd: $('imAdd'),
    imClose: $('imClose'),
    toast: $('toast'),
  };

  // =====================================================================
  // Helpers
  // =====================================================================
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtMoney = (n) => `$${Number(n).toFixed(2)}`;
  const fmtWhole = (n) => `$${Math.floor(Number(n))}`;
  const fmtPrice = (n) => (n === 0 ? 'Free' : `$${n}`);
  const fmtMin = (m) => (Math.abs(m) >= 60 ? `${Math.floor(m / 60)}h ${Math.abs(m) % 60}m` : `${m} min`);
  const colorFor = (cat) => CATEGORY_COLORS[cat] || DEFAULT_COLOR;
  const startOf = (e) => Date.parse(e.startTime);
  const endOf = (e) => Date.parse(e.endTime);
  const isActiveAt = (e, t) => startOf(e) <= t && t <= endOf(e);
  const canAfford = (e) => state.balance == null || state.paid.has(e.id) || e.price <= state.balance;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shortPlace = (p) => p.name.replace(/^Current Location · /, '');
  const icon = (id, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${id}" /></svg>`;
  const PIGEON_SVG = icon('pigeon');
  const isPhone = () => window.innerWidth <= 760;

  function metersBetween([lng1, lat1], [lng2, lat2]) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(a));
  }
  const walkMin = (a, b) => (metersBetween(a, b) * WALK_DETOUR) / WALK_MPS / 60;

  // Reject if a promise takes longer than ms (the demo's latency guard).
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);
  }
  const offline = () => navigator.onLine === false;

  const nightStart = (() => {
    const d = new Date();
    d.setHours(SLIDER_START_HOUR, 0, 0, 0);
    return d.getTime();
  })();
  const sliderToMs = (v) => nightStart + Number(v) * 60000;
  const msToSlider = (ms) => Math.max(0, Math.min(Number(el.slider.max), Math.round((ms - nightStart) / 60000 / 5) * 5));

  // Inside the phone app (Expo shell) the page can talk to native code: it receives the
  // phone's GPS and can ask for a little haptic buzz. In a plain browser this is a no-op.
  const native = window.ReactNativeWebView || null;
  if (native) {
    // App feel: no pinch or double-tap page zoom (the map handles its own gestures).
    document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
    document.body.classList.add('in-app');
  }
  function tellNative(message) {
    try {
      native?.postMessage(JSON.stringify(message));
    } catch {
      // not in the phone app
    }
  }

  let toastTimer;
  function toast(msg, kind = '') {
    el.toast.hidden = true;
    void el.toast.offsetWidth;
    el.toast.textContent = msg;
    el.toast.className = `toast ${kind}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 3200);
    if (kind === 'pay') tellNative({ type: 'haptic', kind: 'success' });
    else if (kind === 'error') tellNative({ type: 'haptic', kind: 'warning' });
  }

  async function api(path, { body, method } = {}) {
    const init = body
      ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: method || 'GET' };
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
    return data;
  }

  function setLoading(btn, on) {
    btn.disabled = on;
    btn.classList.toggle('loading', on);
  }

  // =====================================================================
  // Tabs
  // =====================================================================
  function setTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    document.body.dataset.tab = tab;
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    for (const p of [el.planPanel, el.tonightPanel]) {
      const active = p.dataset.panel === tab;
      p.inert = !active;
      p.setAttribute('aria-hidden', String(!active));
    }
    popup.remove();
    toggleAlerts(false);
    setSheetPeek(false);
    if (tab !== 'explore') dismissCoach();
    if (tab !== 'tonight' && state.pickTarget) stopPicking();
    if (tab === 'tonight' && state.lastRoute) fitRoute(state.lastRoute);
  }
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
  el.planPanel.inert = true;
  el.tonightPanel.inert = true;

  // Friendly shortcuts inside panels ("Plan it for me", "Browse the map").
  document.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-goto]');
    if (go) setTab(go.dataset.goto);
  });

  // Phones: the panel is a bottom sheet that can tuck down to a peek so the map stays visible.
  const PEEK_H = 148; // keep in sync with --peek-h
  const sheetPeeked = () => document.body.classList.contains('sheet-peek');
  function setSheetPeek(on) {
    document.body.classList.toggle('sheet-peek', on);
    // Pulling a sheet back up covers the map, so put away any event card riding above it.
    if (!on && isPhone() && state.tab !== 'explore') closeCard();
  }
  for (const panel of [el.planPanel, el.tonightPanel]) {
    const handle = panel.querySelector('.sheet-handle');
    let startY = null;
    handle.addEventListener('click', () => setSheetPeek(!sheetPeeked()));
    handle.addEventListener('touchstart', (ev) => (startY = ev.touches[0].clientY), { passive: true });
    handle.addEventListener('touchend', (ev) => {
      if (startY == null) return;
      const dy = ev.changedTouches[0].clientY - startY;
      startY = null;
      if (Math.abs(dy) < 24) return; // a tap: the click handler toggles
      ev.preventDefault();
      setSheetPeek(dy > 0);
    });
    // Tapping the peeking sheet's content brings it back up.
    panel.querySelector('.panel-scroll').addEventListener('click', () => {
      if (isPhone() && sheetPeeked()) setSheetPeek(false);
    });
  }

  // Map padding that keeps fitted content clear of whatever overlays the map right now.
  function overlayPadding() {
    const pad = { top: 28, bottom: 28, left: 28, right: 28 };
    if (state.tab === 'explore') pad.bottom += el.dock.offsetHeight + 12;
    else {
      const panel = state.tab === 'tonight' ? el.tonightPanel : el.planPanel;
      // Phones fit to the map you see with the sheet tucked down; fitting to the sliver
      // above an open sheet would zoom all the way out.
      if (!isPhone()) pad.left += panel.offsetWidth + 12;
      else pad.bottom += PEEK_H;
    }
    return pad;
  }

  // =====================================================================
  // Map
  // =====================================================================
  const map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: CORNELL,
    zoom: 15.1,
    pitch: 30,
    attributionControl: { compact: true },
  });
  // Layers only need the style, not the first rendered frame ('load'), which never
  // comes while the tab is in the background.
  const styleReady = new Promise((resolve) => map.once('style.load', resolve));

  // Event details live in the spotlight card (see "Event spotlight" below), not a map
  // popup; this keeps the many "close whatever event is open" call sites reading the same.
  const popup = { remove: () => closeCard() };
  const youMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'you-marker', innerHTML: PIGEON_SVG }) });
  const fromMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'ep from' }) });
  const toMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'ep to' }) });
  let stopMarkers = [];

  function addLayers() {
    // Busy-ness: soft glows under clusters of live events.
    map.addSource('atmo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const size = ['+', 30, ['*', 15, ['min', ['get', 'count'], 7]]];
    const byZoom = (scale) => ['interpolate', ['exponential', 2], ['zoom'], 13, ['*', 0.25 * scale, size], 15, ['*', scale, size], 17.5, ['*', 5.6 * scale, size]];
    const color = ['step', ['get', 'count'], '#bcd9b9', 2, '#8fb996', 3, '#f2c97d', 5, '#f0a77a', 7, '#e8837a'];
    map.addLayer({ id: 'atmo-halo', type: 'circle', source: 'atmo', paint: { 'circle-radius': byZoom(1), 'circle-color': color, 'circle-blur': 1, 'circle-opacity': ['*', ['get', 'alpha'], 0.35], 'circle-pitch-alignment': 'map' } });

    map.addSource('constellation', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'constellation-line', type: 'line', source: 'constellation', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#8b5a2b', 'line-width': 3, 'line-dasharray': [0.1, 2], 'line-opacity': 0.85 } });

    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 11 } });
    map.addLayer({ id: 'route-core', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7a9f81', 'line-width': 6 } });
  }

  // Greedy proximity clustering of the visible events.
  function atmosphereData(events) {
    const clusters = [];
    for (const e of events) {
      let c = clusters.find((k) => metersBetween(k.center, e.coordinates) < CLUSTER_M);
      if (!c) clusters.push((c = { center: [...e.coordinates], n: 0 }));
      c.n++;
      c.center = [c.center[0] + (e.coordinates[0] - c.center[0]) / c.n, c.center[1] + (e.coordinates[1] - c.center[1]) / c.n];
    }
    return {
      type: 'FeatureCollection',
      features: clusters
        .filter((c) => c.n >= 2) // keep the map open: only real hot spots glow
        .map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c.center }, properties: { count: c.n, alpha: c.n >= 3 ? 1 : 0.55 } })),
    };
  }

  // Event blobs: squishy little characters as HTML markers (CSS does the bobbing).
  function createBlobs() {
    for (const e of state.events) {
      const wrap = document.createElement('div');
      wrap.className = 'blob-wrap off';
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `blob${e.sponsorBoost ? ' sponsor' : ''}`;
      dot.style.setProperty('--accent', colorFor(e.category));
      dot.style.setProperty('--d', `${(-Math.random() * 2).toFixed(2)}s`);
      dot.setAttribute('aria-label', `${e.title}, ${fmtPrice(e.price)}${e.sponsorBoost ? ', sponsored' : ''}`);
      dot.innerHTML =
        '<span class="blob-shadow"></span>' +
        `<span class="blob-bob"><span class="blob-body"></span>${e.sponsorBoost ? '<span class="blob-crown">👑</span>' : ''}<span class="dot-num" hidden></span></span>` +
        `<span class="dot-label">${escapeHtml(e.title)}</span>`;
      dot.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (state.pickTarget) return setEndpoint(state.pickTarget, { name: e.venue, coords: e.coordinates });
        showCard(e.id, { center: true });
      });
      wrap.appendChild(dot);
      new maplibregl.Marker({ element: wrap }).setLngLat(e.coordinates).addTo(map);
      state.markers.set(e.id, { wrap, dot, num: dot.querySelector('.dot-num'), visible: false });
    }
  }

  function pop(m) {
    clearTimeout(m.popTimer);
    m.dot.classList.remove('pop');
    void m.dot.offsetWidth;
    m.dot.classList.add('pop');
    m.popTimer = setTimeout(() => m.dot.classList.remove('pop'), 650);
  }

  function spotlight(ids) {
    for (const id of ids) {
      const m = state.markers.get(id);
      if (!m) continue;
      m.dot.classList.remove('spot');
      void m.dot.offsetWidth;
      m.dot.classList.add('spot');
    }
  }

  function applyEventFilter() {
    const t = state.timeMs;
    const chosen = state.night ? state.night.eventIds : [];
    const lit = [];
    for (const e of state.events) {
      const active = isActiveAt(e, t);
      if (active) lit.push(e);
      const m = state.markers.get(e.id);
      if (!m) continue;
      const rank = chosen.indexOf(e.id);
      const visible = active || rank >= 0 || state.chain.has(e.id);
      m.wrap.classList.toggle('off', !visible);
      m.dot.classList.toggle('chosen', rank >= 0);
      m.dot.classList.toggle('upcoming', rank >= 0 && !active);
      m.dot.classList.toggle('unaffordable', !canAfford(e));
      m.num.hidden = rank < 0;
      m.num.textContent = rank >= 0 ? rank + 1 : '';
      m.dot.tabIndex = visible ? 0 : -1;
      if (visible && !m.visible) pop(m);
      m.visible = visible;
    }
    el.liveCount.textContent = lit.length;
    map.getSource('atmo')?.setData(atmosphereData(lit));
    syncCard();
  }

  // =====================================================================
  // Explore: time scrubber
  // =====================================================================
  const BUCKETS = Math.ceil(Number(el.slider.max) / BUCKET_MIN);

  function renderDensity() {
    const counts = Array.from({ length: BUCKETS }, (_, i) => {
      const b0 = nightStart + i * BUCKET_MIN * 60000;
      const b1 = b0 + BUCKET_MIN * 60000;
      return state.events.filter((e) => startOf(e) < b1 && endOf(e) > b0).length;
    });
    const max = Math.max(1, ...counts);
    el.density.innerHTML = counts
      .map((c, i) => `<span class="density-bar${c > 1 && c === max ? ' peak' : ''}" style="height:${Math.max(10, (c / max) * 100)}%" title="${fmtTime(nightStart + i * BUCKET_MIN * 60000)} · ${c} events"></span>`)
      .join('');
    highlightBucket();
  }

  function highlightBucket() {
    const active = Math.min(BUCKETS - 1, Math.floor(Number(el.slider.value) / BUCKET_MIN));
    [...el.density.children].forEach((bar, i) => {
      bar.classList.toggle('active', i === active);
      bar.classList.toggle('past', i < active);
    });
  }

  function setTime(value) {
    el.slider.value = value;
    state.timeMs = sliderToMs(value);
    const pct = (value / Number(el.slider.max)) * 100;
    el.readout.textContent = fmtTime(state.timeMs);
    el.slider.setAttribute('aria-valuetext', fmtTime(state.timeMs));
    el.trackFill.style.width = `${pct}%`;
    el.playhead.style.left = `${pct}%`;
    applyEventFilter();
    highlightBucket();
    updateYouOnRoute();
    scheduleCheckIn(); // the night moved on: with alerts on, the pigeon takes another look
  }

  // Timer-based so it still lands in a background tab.
  function glideTo(value, ms = 1400) {
    return new Promise((resolve) => {
      const from = Number(el.slider.value);
      const t0 = Date.now();
      const id = setInterval(() => {
        const f = Math.min(1, (Date.now() - t0) / ms);
        setTime(Math.round((from + (value - from) * (1 - (1 - f) ** 3)) / 5) * 5);
        if (f >= 1) {
          clearInterval(id);
          setTime(value);
          resolve();
        }
      }, 40);
    });
  }

  el.slider.addEventListener('input', () => {
    stopPlaying();
    dismissCoach();
    setTime(Number(el.slider.value));
    scheduleDetours(400);
  });

  let playTimer = null;
  function stopPlaying() {
    state.playing = false;
    clearInterval(playTimer);
    el.play.classList.remove('playing');
    el.play.setAttribute('aria-label', 'Play through the night');
  }
  el.play.addEventListener('click', () => {
    if (state.playing) return stopPlaying();
    if (Number(el.slider.value) >= Number(el.slider.max)) setTime(0);
    state.playing = true;
    el.play.classList.add('playing');
    el.play.setAttribute('aria-label', 'Pause');
    playTimer = setInterval(() => {
      const next = Number(el.slider.value) + 5;
      if (next > Number(el.slider.max)) return stopPlaying();
      setTime(next);
    }, 120);
  });

  // =====================================================================
  // Event spotlight: hovering a blob shows just its title; clicking it opens a big card.
  // Swipe the card (or use its arrows) to hop between events.
  // =====================================================================
  const PEEK_REACH_MIN = 140; // how close (px) a blob must be to the middle of the open map...
  const PEEK_REACH_MAX = 260; // ...scaled to the open map's size, within these bounds
  const focus = { id: null, peekId: null, moveTimer: 0, lastH: 0, statusKey: '' };
  // Phones and tablets have no hover, so they get a stand-in for it (see followMap).
  const noHover = () => window.matchMedia('(hover: none)').matches || (navigator.maxTouchPoints > 0 && isPhone());

  const visibleEvents = () => state.events.filter((e) => state.markers.get(e.id)?.visible);
  // West to east, so swiping moves across the map in order.
  const cardOrder = () => visibleEvents().sort((a, b) => a.coordinates[0] - b.coordinates[0] || a.id.localeCompare(b.id));

  // What will cover the map once the card is up (at its usual height), so a clicked blob
  // can be glided to the middle of what's left.
  function cardPadding() {
    const cardH = (el.eventCard.hidden ? focus.lastH : el.eventCard.offsetHeight) || 230;
    const pad = { top: 20, bottom: 30 + cardH, left: 20, right: 20 };
    if (state.tab === 'explore') pad.bottom += el.timebar.offsetHeight + 12;
    else if (!isPhone()) pad.left += (state.tab === 'tonight' ? el.tonightPanel : el.planPanel).offsetWidth + 12;
    else pad.bottom += PEEK_H;
    return pad;
  }

  // The middle of the part of the map you can actually see, and how far from it a blob
  // can be and still count as "what you're looking at" (about half the open map).
  function mapMiddle() {
    const box = map.getContainer().getBoundingClientRect();
    const pad = overlayPadding();
    const openW = box.width - pad.left - pad.right;
    const openH = Math.max(140, box.height - pad.top - pad.bottom);
    return { x: pad.left + openW / 2, y: pad.top + openH / 2, reach: Math.max(PEEK_REACH_MIN, Math.min(PEEK_REACH_MAX, Math.min(openW, openH) * 0.5)) };
  }

  function nearestToMiddle() {
    const mid = mapMiddle();
    let best = null;
    for (const e of visibleEvents()) {
      const p = map.project(e.coordinates);
      const d = Math.hypot(p.x - mid.x, p.y - mid.y);
      if (d > mid.reach) continue;
      // The blob already showing its title keeps it unless another is clearly closer.
      const score = e.id === focus.peekId ? d - 26 : d;
      if (!best || score < best.score) best = { e, score };
    }
    return best?.e || null;
  }

  const statusKeyFor = (e) => (isActiveAt(e, state.timeMs) ? 'now' : startOf(e) > state.timeMs ? 'soon' : 'done');

  function renderCard({ animate = '' } = {}) {
    const e = state.byId.get(focus.id);
    if (!e) return closeCard();
    const key = statusKeyFor(e);
    focus.statusKey = key;
    const status =
      key === 'now'
        ? `<span class="tag now">On now · until ${fmtTime(endOf(e))}</span>`
        : key === 'soon'
          ? `<span class="tag soon">Starts ${fmtTime(startOf(e))}</span>`
          : '<span class="tag">Wrapped up</span>';
    const priceClass = !canAfford(e) ? 'over' : e.price === 0 ? 'free' : '';
    const walk = state.from ? ` · ${Math.max(1, Math.round(walkMin(state.from.coords, e.coordinates)))} min walk` : '';
    const order = cardOrder();
    const at = order.findIndex((o) => o.id === e.id);
    const pager =
      order.length > 1
        ? `<div class="ec-pager">
            <button data-card="prev" aria-label="Previous event">${icon('chevron')}</button>
            <span>${at + 1} of ${order.length}</span>
            <button data-card="next" aria-label="Next event">${icon('chevron')}</button>
          </div>`
        : '';
    const card = el.eventCard;
    card.style.setProperty('--accent', colorFor(e.category));
    card.innerHTML = `
      <div class="ec-head">
        <span class="ec-blob" aria-hidden="true"><span class="blob-bob"><span class="blob-body"></span>${e.sponsorBoost ? '<span class="blob-crown">👑</span>' : ''}</span></span>
        <div>
          <div class="tags">
            <span class="tag" style="color:${colorFor(e.category)}"><i></i>${escapeHtml(e.category)}</span>
            <span class="tag price ${priceClass}">${fmtPrice(e.price)}</span>
            ${e.sponsorBoost ? '<span class="tag sponsor">Sponsored</span>' : ''}
          </div>
          <h3 class="ec-title">${escapeHtml(e.title)}</h3>
        </div>
        <button class="x-btn" data-card="close" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="ec-facts">${status}<span><b>${fmtTime(startOf(e))} – ${fmtTime(endOf(e))}</b>${e.venue ? ` · ${escapeHtml(e.venue)}` : ''}${walk}</span></div>
      <p class="ec-desc" data-card="more" title="Tap to read more">${escapeHtml(e.description || '')}</p>
      <div class="ec-actions">${addButtonHtml(e)}<button class="btn btn-white btn-sm" data-go="${escapeHtml(e.id)}">Walk here</button></div>
      ${pager}`;
    if (card.hidden) {
      card.hidden = false; // plays the pop-in
      document.body.classList.add('ec-open');
    } else if (animate) {
      card.style.setProperty('--dir', animate === 'prev' ? -1 : 1);
      card.classList.remove('swap');
      void card.offsetWidth;
      card.classList.add('swap');
    }
    focus.lastH = card.offsetHeight;
  }

  /** Open an event's card. `center` also glides the map so its blob is mid-screen. */
  function showCard(id, { center = false, animate = 'next' } = {}) {
    const e = state.byId.get(id);
    if (!e) return;
    if (focus.id && focus.id !== id) state.markers.get(focus.id)?.wrap.classList.remove('focus');
    const changed = focus.id !== id;
    focus.id = id;
    state.markers.get(id)?.wrap.classList.add('focus');
    dismissCoach();
    // On a phone with a sheet open, tuck the sheet down so the card and map have room.
    if (center && isPhone() && state.tab !== 'explore') setSheetPeek(true);
    renderCard({ animate: changed ? animate : '' });
    if (center) map.easeTo({ center: e.coordinates, padding: cardPadding(), duration: 550 });
  }

  function closeCard() {
    if (focus.id) state.markers.get(focus.id)?.wrap.classList.remove('focus');
    focus.id = null;
    el.eventCard.hidden = true;
    el.eventCard.classList.remove('swap');
    document.body.classList.remove('ec-open');
  }

  function stepCard(dir) {
    const order = cardOrder();
    if (order.length < 2) return;
    const at = order.findIndex((e) => e.id === focus.id);
    const next = order[(at + dir + order.length) % order.length];
    showCard(next.id, { center: true, animate: dir < 0 ? 'prev' : 'next' });
  }

  // Keep the card honest as the night or the wallet changes.
  function syncCard() {
    if (focus.peekId && !state.markers.get(focus.peekId)?.visible) setPeek(null);
    if (!focus.id) return;
    const e = state.byId.get(focus.id);
    if (!state.markers.get(focus.id)?.visible) return closeCard();
    if (statusKeyFor(e) !== focus.statusKey) renderCard();
  }

  // With a mouse, hovering a blob shows its title (plain CSS). Touch screens can't
  // hover, so there the blob nearest the middle of the map shows its title as you move
  // the map around. Either way the card only opens when the blob is clicked or tapped.
  function setPeek(id) {
    if (focus.peekId === id) return;
    if (focus.peekId) state.markers.get(focus.peekId)?.wrap.classList.remove('peek');
    focus.peekId = id;
    if (id) state.markers.get(id)?.wrap.classList.add('peek');
  }
  function followMap() {
    if (!noHover() || state.pickTarget || demo.running || simulating) return setPeek(null);
    setPeek(nearestToMiddle()?.id || null);
  }
  // Only real drags and zooms count, never the app's own camera moves.
  map.on('move', (ev) => {
    if (!ev.originalEvent || focus.moveTimer) return;
    focus.moveTimer = setTimeout(() => {
      focus.moveTimer = 0;
      followMap();
    }, 90);
  });

  el.eventCard.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-card]')?.dataset.card;
    if (action === 'close') closeCard();
    else if (action === 'prev') stepCard(-1);
    else if (action === 'next') stepCard(1);
    else if (action === 'more') {
      ev.target.closest('.ec-desc').classList.toggle('open');
      focus.lastH = el.eventCard.offsetHeight;
    }
  });

  // Swipe the card sideways to hop to the next event, or down to put it away.
  let cardTouch = null;
  el.eventCard.addEventListener('touchstart', (ev) => (cardTouch = { x: ev.touches[0].clientX, y: ev.touches[0].clientY }), { passive: true });
  el.eventCard.addEventListener('touchend', (ev) => {
    if (!cardTouch) return;
    const dx = ev.changedTouches[0].clientX - cardTouch.x;
    const dy = ev.changedTouches[0].clientY - cardTouch.y;
    cardTouch = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) stepCard(dx < 0 ? 1 : -1);
    else if (dy > 60 && dy > Math.abs(dx) * 1.5) closeCard();
  });
  document.addEventListener('keydown', (ev) => {
    if (el.eventCard.hidden || ev.target.closest('input, select, textarea, .maplibregl-map')) return;
    if (ev.key === 'ArrowLeft') stepCard(-1);
    else if (ev.key === 'ArrowRight') stepCard(1);
    else if (ev.key === 'Escape') closeCard();
  });

  // One clear main action per event; "Walk here" stays a quiet second option.
  function addButtonHtml(e) {
    if (state.chain.has(e.id)) {
      const paid = state.paid.get(e.id);
      return `<button class="btn btn-white btn-sm" disabled>✓ On tonight's list${paid ? ` · paid ${fmtWhole(paid.amount)}` : ''}</button>`;
    }
    if (state.paying.has(e.id)) return '<button class="btn btn-matcha btn-sm" disabled>Paying…</button>';
    if (!canAfford(e)) return `<button class="btn btn-white btn-sm" disabled>A bit over your ${fmtMoney(state.balance)}</button>`;
    return `<button class="btn btn-matcha btn-sm" data-add="${escapeHtml(e.id)}">Add to tonight${e.price > 0 ? ` · $${e.price}` : ''}</button>`;
  }

  // Redraw the open card after something it shows has changed (added, paid, balance).
  function refreshPopup() {
    if (focus.id) renderCard();
  }

  document.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-add]');
    if (add) return addToChain(add.dataset.add);
    const go = ev.target.closest('[data-go]');
    if (go) {
      const e = state.byId.get(go.dataset.go);
      popup.remove();
      setEndpoint('to', { name: e.venue, coords: e.coordinates });
      setTab('tonight');
    }
  });

  // =====================================================================
  // Balance
  // =====================================================================
  let balanceAnim = 0;
  function setBalance(next, source) {
    const prev = state.balance;
    state.balance = next;
    if (source) {
      const live = source === 'nessie';
      state.balanceSource = source;
      el.balanceDot.className = `wallet-dot ${live ? 'live' : 'demo'}`;
      el.wallet.title = live ? 'Your Capital One balance (live via Nessie)' : 'Demo balance (Capital One Nessie is offline)';
    }
    cancelAnimationFrame(balanceAnim);
    if (prev == null || prev === next) {
      el.balance.textContent = fmtMoney(next);
    } else {
      el.balance.classList.remove('debit', 'credit');
      void el.balance.offsetWidth;
      el.balance.classList.add(next < prev ? 'debit' : 'credit');
      const t0 = performance.now();
      const step = (now) => {
        const f = Math.min(1, (now - t0) / 600);
        el.balance.textContent = fmtMoney(prev + (next - prev) * (1 - (1 - f) ** 3));
        if (f < 1) balanceAnim = requestAnimationFrame(step);
      };
      balanceAnim = requestAnimationFrame(step);
      setTimeout(() => {
        if (state.balance === next) el.balance.textContent = fmtMoney(next);
      }, 650);
    }
    el.budgetMax.textContent = `Up to ${fmtWhole(next)}`;
    applyEventFilter();
    refreshPopup();
    scheduleDetours(300);
  }

  async function loadBalance() {
    try {
      const data = await withTimeout(api('/api/radar/affordable'), 6000);
      setBalance(data.balance, data.balanceSource);
    } catch {
      setBalance(18, 'fallback');
    }
  }

  // =====================================================================
  // Tonight's stops + Nessie payments
  // =====================================================================
  const chainEvents = () => [...state.chain].map((id) => state.byId.get(id)).sort((a, b) => startOf(a) - startOf(b));
  const paidToast = (amount, venue) => toast(`Paid ${fmtMoney(amount)} at ${venue} · via Capital One`, 'pay');

  /**
   * Add an event, paying its cover through Nessie first. With `timeoutMs`, a slow or
   * failed payment is recorded locally so the demo never stalls.
   */
  async function addToChain(id, { timeoutMs, quiet = false } = {}) {
    const e = state.byId.get(id);
    if (!e || state.chain.has(id) || state.paying.has(id)) return false;

    // Don't add (or charge for) a stop that would be over before you could get there.
    const lineup = [...chainEvents(), e].sort((a, b) => startOf(a) - startOf(b));
    if (missedLocally(lineup).includes(id)) {
      state.lastAddError = 'it would be over before you get there';
      toast(`${e.title} would be over before you get there`, 'error');
      return false;
    }

    if (e.price > 0) {
      if (!canAfford(e)) {
        state.lastAddError = `the ${fmtPrice(e.price)} cover is more than your ${fmtMoney(state.balance)}`;
        toast(`${fmtPrice(e.price)} at ${e.venue} is a bit over your ${fmtMoney(state.balance)}`, 'error');
        return false;
      }
      state.paying.add(id);
      refreshPopup();
      try {
        const request = api('/api/radar/pay', { body: { eventId: id } });
        const r = timeoutMs ? await withTimeout(request, timeoutMs) : await request;
        state.paid.set(id, { transferId: r.transfer._id, amount: r.amount });
        state.chain.add(id);
        paidToast(r.amount, r.venue);
        setBalance(r.balance, r.balanceSource);
      } catch (err) {
        if (!timeoutMs) {
          state.lastAddError = "the payment didn't go through";
          toast(`That payment didn't go through · ${err.message}`, 'error');
          return false;
        }
        state.paid.set(id, { transferId: `local_${Date.now()}`, amount: e.price });
        state.chain.add(id);
        paidToast(e.price, e.venue);
        setBalance(state.balance - e.price);
      } finally {
        state.paying.delete(id);
        refreshPopup();
      }
    } else {
      state.chain.add(id);
      if (!quiet) toast(`Added to tonight: ${e.title}`);
    }

    renderTonight();
    refreshPopup();
    applyEventFilter();
    scheduleRoute();
    return true;
  }

  async function removeFromChain(id, { reroute = true } = {}) {
    const e = state.byId.get(id);
    if (!state.chain.delete(id)) return;
    renderTonight();
    refreshPopup();
    applyEventFilter();
    if (reroute) scheduleRoute();
    const paid = state.paid.get(id);
    if (!paid) return;
    state.paid.delete(id);
    if (paid.transferId.startsWith('local_')) return setBalance(state.balance + paid.amount);
    try {
      const r = await api(`/api/radar/pay/${encodeURIComponent(paid.transferId)}`, { method: 'DELETE' });
      toast(`Refunded ${fmtMoney(paid.amount)} from ${e.venue}`, 'pay');
      setBalance(r.balance, r.balanceSource);
    } catch (err) {
      toast(`Couldn't refund that one · ${err.message}`, 'error');
    }
  }

  // =====================================================================
  // Tonight tab: one summary + one trail for the walk and every stop
  // =====================================================================
  const trip = { status: 'idle', error: '', dropped: [] }; // status: 'idle' | 'loading' | 'ready' | 'error'

  // Which of these stops (in start order) would be over before you could walk there?
  // Straight-line estimate, for when there's no routed walk to ask.
  function missedLocally(events) {
    if (!state.from || !events.length) return [];
    let clock = departureFor(events);
    let prev = state.from.coords;
    const missed = [];
    for (const e of events) {
      const arrive = clock + walkMin(prev, e.coordinates) * 60000;
      if (arrive >= endOf(e)) {
        missed.push(e.id);
        continue;
      }
      clock = Math.min(endOf(e), Math.max(arrive, startOf(e)) + STAY_MIN * 60000);
      prev = e.coordinates;
    }
    return missed;
  }

  // Stops that end before you'd get there come off tonight's list (paid ones are refunded).
  // Returns true if anything was dropped.
  function dropMissedStops(ids) {
    const gone = ids.filter((id) => state.chain.has(id)).map((id) => state.byId.get(id));
    if (!gone.length) return false;
    for (const e of gone) removeFromChain(e.id, { reroute: false });
    trip.dropped = gone.map((e) => e.title);
    toast(gone.length === 1 ? `Took ${gone[0].title} off tonight · it ends before you'd get there` : `Took ${gone.length} stops off tonight · they end before you'd get there`);
    renderTonight();
    scheduleDetours();
    return true;
  }

  function droppedNoteHtml() {
    const names = trip.dropped.map((t) => `<b>${escapeHtml(t)}</b>`);
    if (!names.length) return '';
    const what = names.length === 1 ? `${names[0]} came off tonight: it ends` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} came off tonight: they end`;
    return `<div class="trip-note info">${what} before you'd get there.</div>`;
  }

  const priceHtml = (e) => {
    const paid = state.paid.get(e.id);
    return paid ? `<span class="paid">Paid ${fmtMoney(paid.amount)}</span>` : fmtPrice(e.price);
  };
  const removeBtnHtml = (e) =>
    `<button class="x-btn" data-remove="${escapeHtml(e.id)}" aria-label="Remove ${escapeHtml(e.title)}${state.paid.has(e.id) ? ' and refund it' : ''}">${icon('close')}</button>`;
  // No walk row when the next place is the same spot (e.g. the night ends at the last stop).
  const walkRowHtml = (leg) =>
    leg && (leg.durationMin > 0 || leg.distanceM >= 50) ? `<li class="trail-walk">${icon('paw')}${leg.durationMin} min walk · ${(leg.distanceM / 1000).toFixed(1)} km</li>` : '';

  // The route is only shown once it covers exactly the stops on tonight's list.
  function routeIsCurrent(result) {
    const ids = result.geojson.features.filter((f) => f.properties?.kind === 'event').map((f) => f.properties.eventId);
    return ids.length === state.chain.size && ids.every((id) => state.chain.has(id));
  }

  function tripSummaryHtml(result) {
    const s = result.summary;
    const stops = state.chain.size;
    const facts = [`${(s.totalDistanceM / 1000).toFixed(1)} km`];
    if (stops) facts.push(`${stops} stop${stops === 1 ? '' : 's'}`);
    if (result.routingSource === 'estimate') facts.push('estimated');
    return `
      <span class="sum-icon">${icon('paw')}</span>
      <div><div class="sum-big">${fmtMin(s.totalTransitMin)} walk</div><div class="sum-sub">${facts.join(' · ')}</div></div>
      <div class="sum-arrive"><span>Arrive</span><strong>${fmtTime(Date.parse(s.arrival))}</strong></div>`;
  }

  // Full trail: leave -> walk -> stop -> walk -> arrive.
  function trailHtml(result) {
    const s = result.summary;
    const nodes = result.geojson.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties);
    const note = result.feasible
      ? ''
      : `<div class="trip-note">${result.violations.map((v) => escapeHtml(v.message.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, fmtTime(Date.parse(s.arrival))))).join('<br>')}</div>`;
    const rows = nodes
      .map((p) => {
        if (p.kind === 'origin') {
          return `<li class="trail-row"><span class="trail-node from"></span><div><div class="trail-title">${escapeHtml(shortPlace(state.from))}</div><div class="trail-sub">Leave <b>${fmtTime(Date.parse(p.departure))}</b></div></div></li>`;
        }
        if (p.kind === 'destination') {
          return `${walkRowHtml(p.legFromPrevious)}<li class="trail-row"><span class="trail-node to"></span><div><div class="trail-title">${escapeHtml(shortPlace(state.to))}</div><div class="trail-sub">Arrive <b>${fmtTime(Date.parse(p.eta))}</b></div></div></li>`;
        }
        const e = state.byId.get(p.eventId);
        // Lead with when you're actually at the event (arrival, or its start if you're early).
        const attendFrom = p.attendStart ? Date.parse(p.attendStart) : Date.parse(p.eta) + (p.waitMin || 0) * 60000;
        const when = p.missed ? '<span class="late">Ends before you get there</span>' : `<b>${fmtTime(attendFrom)}</b> · stay ${fmtMin(p.dwellMin)}`;
        const wait = !p.missed && p.waitMin >= 5 ? ` · ${fmtMin(p.waitMin)} wait` : '';
        return `${walkRowHtml(p.legFromPrevious)}<li class="trail-row">
          <span class="trail-node ${p.missed ? 'missed' : ''}" style="--accent:${colorFor(e.category)}">${p.order}</span>
          <div><div class="trail-title">${escapeHtml(p.title)}</div><div class="trail-sub">${when} · ${priceHtml(e)}${wait}</div></div>
          ${removeBtnHtml(e)}
        </li>`;
      })
      .join('');
    return `${note}<div class="card trail-card"><ol class="trail">${rows}</ol></div>`;
  }

  // Just the stops, for when there's no walk to show yet.
  function stopsHtml(events) {
    const rows = events
      .map(
        (e, i) => `<li class="trail-row">
          <span class="trail-node" style="--accent:${colorFor(e.category)}">${i + 1}</span>
          <div><div class="trail-title">${escapeHtml(e.title)}</div><div class="trail-sub"><b>${fmtTime(startOf(e))}</b> – ${fmtTime(endOf(e))} · ${priceHtml(e)}</div></div>
          ${removeBtnHtml(e)}
        </li>`,
      )
      .join('');
    return `<div class="card trail-card"><ol class="trail">${rows}</ol></div>`;
  }

  const EMPTY_TONIGHT = `
    <div class="hello">
      ${icon('capy', 'empty-capy')}
      <div class="bubble">
        <strong>Nothing planned yet!</strong>
        <p>Pick where you're headed above, tap a blob on the map, or let me plan the whole night for you.</p>
        <div class="empty-actions">
          <button class="btn btn-matcha btn-sm" data-goto="plan">Plan it for me</button>
          <button class="btn btn-white btn-sm" data-goto="explore">Browse the map</button>
        </div>
      </div>
    </div>`;

  function renderTonight() {
    const events = chainEvents();
    el.tonightBadge.hidden = !events.length;
    el.tonightBadge.textContent = events.length;

    const result = trip.status === 'ready' && state.lastRoute && routeIsCurrent(state.lastRoute) ? state.lastRoute : null;
    const sum = el.tripSummary;
    sum.hidden = !(state.from && state.to) || trip.status === 'idle';
    if (result) {
      sum.className = 'trip-summary';
      sum.innerHTML = tripSummaryHtml(result);
    } else if (trip.status === 'error') {
      sum.className = 'trip-summary error';
      sum.textContent = `Couldn't plan that walk: ${trip.error}`;
    } else {
      sum.className = 'trip-summary loading';
      sum.innerHTML = `<span class="sum-icon walking">${icon('paw')}</span>Finding the coziest path…`;
    }

    const dropped = droppedNoteHtml();
    if (result) el.tripBody.innerHTML = dropped + trailHtml(result);
    else if (events.length) {
      const nudge = state.to
        ? ''
        : '<div class="nudge"><span>Where does the night end? Pick a destination above.</span><button class="btn btn-white btn-xs" data-end-last>End at my last stop</button></div>';
      el.tripBody.innerHTML = dropped + stopsHtml(events) + nudge;
    } else el.tripBody.innerHTML = dropped + (state.to ? '' : EMPTY_TONIGHT);
  }

  el.tripBody.addEventListener('click', (ev) => {
    const remove = ev.target.closest('[data-remove]');
    if (remove) return removeFromChain(remove.dataset.remove);
    if (ev.target.closest('[data-end-last]')) {
      const last = chainEvents().pop();
      if (last) setEndpoint('to', { name: last.venue, coords: last.coordinates });
    }
  });

  // =====================================================================
  // Tonight tab: From / To
  // =====================================================================
  function fillSelect(select, field) {
    const place = state[field];
    const opts = [];
    if (field === 'to') opts.push(`<option value="">${place ? 'No destination' : 'Where to?'}</option>`);
    else if (!place) opts.push('<option value="">Where from?</option>');
    // With a real position on campus, "My location" is where you actually are; without
    // one it stands in for North Campus.
    const live = field === 'from' && Boolean(liveSpot());
    if (live) opts.push('<option value="__me">My location</option>');
    for (const h of HUBS) {
      // Short names so the closed dropdown never truncates; landmarks show as a hover hint.
      const label = field === 'from' && h.id === 'north' && !live ? 'My location' : h.name;
      opts.push(`<option value="${h.id}" title="${escapeHtml(h.sub)}">${label}</option>`);
    }
    const usingLive = Boolean(place?.live && live);
    if (place && !place.hubId && !usingLive) opts.push(`<option value="__custom">${escapeHtml(place.name)}</option>`);
    opts.push('<option value="__map">Pick a spot on the map…</option>');
    select.innerHTML = opts.join('');
    select.value = place ? (usingLive ? '__me' : place.hubId || '__custom') : '';
    select.classList.toggle('empty', !place);
  }

  function renderRouteFields() {
    fillSelect(el.fromSelect, 'from');
    fillSelect(el.toSelect, 'to');
    // When the start is your live position, the moving blue dot marks it; the green start
    // pin only hops every so often and would sit on top of the dot, hiding its movement.
    if (state.from && !(state.from.live && liveSpot())) fromMarker.setLngLat(state.from.coords).addTo(map);
    else fromMarker.remove();
    if (state.to) toMarker.setLngLat(state.to.coords).addTo(map);
    else toMarker.remove();
    renderTonight();
  }

  function setEndpoint(field, place) {
    state[field] = place;
    if (state.pickTarget) {
      if (field === 'from' && !state.to) startPicking('to');
      else stopPicking();
    }
    renderRouteFields();
    scheduleRoute({ fit: true });
  }

  for (const [select, field] of [[el.fromSelect, 'from'], [el.toSelect, 'to']]) {
    select.addEventListener('change', () => {
      const v = select.value;
      if (v === '__map') {
        renderRouteFields(); // put the old value back while picking
        return startPicking(field);
      }
      if (v === '__custom') return;
      if (v === '__me') return setEndpoint(field, { name: 'My location', coords: liveSpot(), live: true });
      if (!v) return setEndpoint(field, null);
      setEndpoint(field, hubPlace(v));
    });
  }

  el.swap.addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    renderRouteFields();
    scheduleRoute({ fit: true });
  });

  function nearestHubName(coords) {
    const best = HUBS.map((h) => ({ h, d: metersBetween(h.coords, coords) })).sort((a, b) => a.d - b.d)[0];
    return best.d < 350 ? `Pin near ${best.h.name}` : 'Dropped pin';
  }

  function startPicking(field) {
    state.pickTarget = field;
    document.body.classList.add('picking');
    el.pickHintText.textContent = field === 'from' ? 'Tap the map to set your start' : 'Tap the map to set your destination';
    el.pickHint.hidden = false;
    popup.remove();
  }
  function stopPicking() {
    state.pickTarget = null;
    document.body.classList.remove('picking');
    el.pickHint.hidden = true;
  }
  el.pickCancel.addEventListener('click', stopPicking);
  map.on('click', (ev) => {
    if (!state.pickTarget || ev.originalEvent?.target?.closest?.('.blob')) return;
    const coords = [ev.lngLat.lng, ev.lngLat.lat];
    setEndpoint(state.pickTarget, { name: nearestHubName(coords), coords });
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.pickTarget) stopPicking();
  });

  // =====================================================================
  // Routing
  // =====================================================================
  let routeSeq = 0;
  let routeTimer = 0;
  let pendingFit = false;

  function scheduleRoute({ fit = false } = {}) {
    trip.dropped = []; // a fresh change: the last "came off tonight" note has been seen
    scheduleDetours();
    pendingFit = pendingFit || fit;
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      const f = pendingFit;
      pendingFit = false;
      computeRoute({ fit: f });
    }, 120);
  }

  // Leave "now" (the slider time), or later if that's enough to reach the first stop as it starts.
  // If "now" is already too late for the first stop, the slider is just browsing later in the
  // night, so plan from the first stop rather than counting it as missed.
  function departureFor(events) {
    if (!events.length || !state.from) return state.timeMs;
    const walkMs = walkMin(state.from.coords, events[0].coordinates) * 60000;
    const forFirstStop = startOf(events[0]) - walkMs - 5 * 60000;
    return state.timeMs + walkMs < endOf(events[0]) ? Math.max(state.timeMs, forFirstStop) : forFirstStop;
  }

  function routeBody() {
    const events = chainEvents();
    return {
      startPoint: state.from.coords,
      endPoint: state.to.coords,
      departureTime: new Date(departureFor(events)).toISOString(),
      maxEndTime: new Date(nightStart + 10.5 * 3600000).toISOString(), // 3:30 AM: the walk itself sets the arrival
      eventIds: events.map((e) => e.id),
      maxDwellMinutes: STAY_MIN,
    };
  }

  /** Fetch + draw the walk From -> path -> To. With `timeoutMs`, falls back to a local estimate. */
  async function computeRoute({ fit = false, timeoutMs } = {}) {
    if (!state.from || !state.to) {
      ++routeSeq; // drop any walk still being fetched
      clearRoute();
      trip.status = 'idle';
      dropMissedStops(missedLocally(chainEvents())); // no routed walk yet, so estimate
      renderTonight();
      return null;
    }
    const seq = ++routeSeq;
    trip.status = 'loading';
    renderTonight();
    const body = routeBody();
    let result;
    try {
      if (timeoutMs && offline()) throw new Error('offline');
      const request = api('/api/route/timechain', { body });
      result = timeoutMs ? await withTimeout(request, timeoutMs) : await request;
    } catch (err) {
      if (!timeoutMs) {
        if (seq === routeSeq) {
          trip.status = 'error';
          trip.error = err.message;
          renderTonight();
        }
        return null;
      }
      result = localRoute(body);
    }
    if (seq !== routeSeq) return null;
    // Stops this walk can't reach in time come off the list, then the walk is planned again without them.
    const missed = result.geojson.features.filter((f) => f.properties?.kind === 'event' && f.properties.missed).map((f) => f.properties.eventId);
    if (dropMissedStops(missed)) return computeRoute({ fit, timeoutMs });
    drawRoute(result, { fit });
    trip.status = 'ready';
    renderTonight();
    return result;
  }

  // Straight-line walking estimate in the same shape as /api/route/timechain.
  function localRoute(body) {
    const events = body.eventIds.map((id) => state.byId.get(id));
    const points = [body.startPoint, ...events.map((e) => e.coordinates), body.endPoint];
    let clock = Date.parse(body.departureTime);
    const coords = [points[0]];
    const times = [clock];
    const nodes = [{ kind: 'origin', order: 0, departure: new Date(clock).toISOString() }];
    let walkTotal = 0;
    let distTotal = 0;
    for (let i = 1; i < points.length; i++) {
      const dist = metersBetween(points[i - 1], points[i]) * WALK_DETOUR;
      const dur = (dist / WALK_MPS) * 1000;
      clock += dur;
      walkTotal += dur;
      distTotal += dist;
      coords.push(points[i]);
      times.push(clock);
      const leg = { durationMin: Math.round(dur / 60000), distanceM: Math.round(dist) };
      const e = events[i - 1];
      if (!e) {
        nodes.push({ kind: 'destination', order: i, eta: new Date(clock).toISOString(), legFromPrevious: leg });
        break;
      }
      const arrive = clock;
      const enjoy = Math.max(arrive, startOf(e));
      const leave = Math.min(endOf(e), enjoy + STAY_MIN * 60000);
      nodes.push({ kind: 'event', order: i, eventId: e.id, title: e.title, eta: new Date(arrive).toISOString(), departure: new Date(leave).toISOString(), waitMin: Math.round((enjoy - arrive) / 60000), dwellMin: Math.round((leave - enjoy) / 60000), legFromPrevious: leg, ...(arrive >= endOf(e) ? { missed: true } : {}) });
      clock = Math.max(clock, leave);
      coords.push(points[i]);
      times.push(clock);
    }
    return {
      feasible: true,
      violations: [],
      routingSource: 'estimate',
      summary: { departure: body.departureTime, arrival: new Date(clock).toISOString(), totalTransitMin: Math.round(walkTotal / 60000), totalDistanceM: Math.round(distTotal), slackMin: 0 },
      geojson: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { coordTimes: times.map((t) => new Date(t).toISOString()) } },
          ...nodes.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: i === 0 ? points[0] : p.kind === 'destination' ? points[points.length - 1] : state.byId.get(p.eventId).coordinates }, properties: p })),
        ],
      },
    };
  }

  function clearRoute() {
    map.getSource('route')?.setData({ type: 'FeatureCollection', features: [] });
    stopMarkers.forEach((m) => m.remove());
    stopMarkers = [];
    state.route = null;
    state.lastRoute = null;
    youMarker.remove();
  }

  function fitRoute(result) {
    const c = result.geojson.features.find((f) => f.geometry.type === 'LineString').geometry.coordinates;
    const bounds = c.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
    map.fitBounds(bounds, { padding: overlayPadding(), duration: 700, maxZoom: 16.4 });
  }

  function drawRoute(result, { fit = false } = {}) {
    const line = result.geojson.features.find((f) => f.geometry.type === 'LineString');
    const nodes = result.geojson.features.filter((f) => f.geometry.type === 'Point' && f.properties.kind === 'event');
    map.getSource('route')?.setData({ type: 'FeatureCollection', features: [line] });
    stopMarkers.forEach((m) => m.remove());
    stopMarkers = nodes.map((n) => {
      const div = document.createElement('div');
      div.className = `stop-marker ${n.properties.missed ? 'missed' : ''}`;
      div.textContent = String(n.properties.order);
      return new maplibregl.Marker({ element: div, offset: [0, -22] }).setLngLat(n.geometry.coordinates).addTo(map);
    });
    state.route = { coords: line.geometry.coordinates, times: line.properties.coordTimes.map(Date.parse) };
    state.lastRoute = result;
    updateYouOnRoute();
    if (fit) fitRoute(result);
  }

  function updateYouOnRoute() {
    const r = state.route;
    if (!r || simulating) return;
    const t = state.timeMs;
    if (t < r.times[0] || t > r.times[r.times.length - 1]) return youMarker.remove();
    let i = r.times.findIndex((x) => x > t);
    if (i <= 0) i = r.times.length - 1;
    const [t0, t1] = [r.times[i - 1], r.times[i]];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    const [a, b] = [r.coords[i - 1], r.coords[i]];
    youMarker.setLngLat([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]).addTo(map);
  }

  // =====================================================================
  // Fun stops on your way (budget: Free / Under $10 / Up to balance)
  // =====================================================================
  let detourSeq = 0;
  let detourTimer = 0;

  function budgetDollars() {
    const bal = state.balance ?? 0;
    if (state.budget === 'free') return 0;
    if (state.budget === 'ten') return Math.min(TEN_DOLLARS, bal);
    return bal;
  }

  for (const seg of document.querySelectorAll('[data-budget]')) {
    seg.addEventListener('click', () => {
      state.budget = seg.dataset.budget;
      for (const s of document.querySelectorAll('[data-budget]')) s.setAttribute('aria-checked', String(s === seg));
      scheduleDetours(0);
    });
  }

  function scheduleDetours(delay = 250) {
    clearTimeout(detourTimer);
    const on = Boolean(state.from && state.to);
    el.detourBlock.hidden = !on;
    if (!on) {
      state.detours = [];
      return;
    }
    detourTimer = setTimeout(fetchDetours, delay);
  }

  function detourHeadline(text, detours = []) {
    el.detourSummary.textContent = text;
    el.detourDots.innerHTML = detours.map((d) => `<i style="--accent:${colorFor(d.event.category)}"></i>`).join('');
  }

  async function fetchDetours() {
    if (!state.from || !state.to || state.balance == null) return;
    const seq = ++detourSeq;
    if (!el.detours.querySelector('.detour:not(.skeleton)')) {
      el.detours.innerHTML = '<div class="detour skeleton"></div>'.repeat(2);
      detourHeadline('Sniffing out stops on your way…');
    }
    const dollars = budgetDollars();
    try {
      const r = await withTimeout(
        api('/api/route/detours', {
          body: {
            start: state.from.coords,
            end: state.to.coords,
            departureTime: new Date(state.timeMs).toISOString(),
            currentBalance: dollars, // absolute budget: 100% of this amount
            budgetPercent: 100,
            excludeIds: [...state.chain],
          },
        }),
        9000,
      );
      if (seq !== detourSeq) return;
      state.detours = r.detours;
      renderDetours(r, dollars);
    } catch (err) {
      if (seq !== detourSeq) return;
      state.detours = [];
      detourHeadline('Fun stops on your way');
      el.detours.innerHTML = `<div class="detour-empty">Couldn't check for stops just now. Try again in a moment.</div>`;
    }
  }

  function renderDetours(r, dollars) {
    const n = r.detours.length;
    if (!n) {
      detourHeadline('No stops on your way right now');
      el.detours.innerHTML = `<div class="detour-empty">Nothing ${dollars === 0 ? 'free ' : ''}lines up with this walk at ${fmtTime(state.timeMs)}. Try another time or budget.</div>`;
      return;
    }
    detourHeadline(`${n} fun stop${n === 1 ? '' : 's'} on your way`, r.detours);
    el.detours.innerHTML = r.detours
      .map((d) => {
        const e = d.event;
        const mins = d.extraDetourMins;
        return `<article class="detour" role="listitem" style="--accent:${colorFor(e.category)}">
          <div>
            <div class="detour-name"><i aria-hidden="true"></i>${escapeHtml(e.title)}</div>
            <div class="detour-facts">
              <span class="chip time">${icon('paw')}+${mins} min walk</span>
              <span class="chip ${e.price === 0 ? 'free' : ''}">${fmtPrice(e.price)}</span>
            </div>
            <div class="detour-when">Get there ${fmtTime(Date.parse(d.estimatedArrival))} · ${escapeHtml(e.venue)}</div>
          </div>
          <button class="btn btn-matcha btn-sm" data-detour="${escapeHtml(e.id)}" aria-label="Add ${escapeHtml(e.title)} to tonight">Add</button>
        </article>`;
      })
      .join('');
  }

  el.detours.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-detour]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    const ok = await addToChain(btn.dataset.detour);
    if (ok) scheduleRoute({ fit: true });
    else {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  });

  // =====================================================================
  // Plan tab: Gemini plans a three-stop night
  // =====================================================================
  el.interestChips.addEventListener('click', (ev) => {
    const pick = ev.target.closest('.pick');
    if (pick) pick.setAttribute('aria-pressed', String(pick.getAttribute('aria-pressed') !== 'true'));
  });
  // Tapped chips plus anything typed in "Anything else?".
  const getInterests = () => [
    ...[...el.interestChips.querySelectorAll('.pick[aria-pressed="true"]')].map((p) => p.dataset.value),
    ...el.interestExtra.value.split(',').map((s) => s.trim()).filter(Boolean),
  ];

  // A little burst of blobs to celebrate (booking a night).
  function celebrate(anchor) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const box = anchor?.getBoundingClientRect();
    const x = box ? box.left + box.width / 2 : window.innerWidth / 2;
    const y = box ? box.top + box.height / 2 : window.innerHeight / 2;
    const colors = Object.values(CATEGORY_COLORS);
    const bits = Array.from({ length: 22 }, (_, i) => {
      const angle = (i / 22) * Math.PI * 2 + Math.random() * 0.4;
      const reach = 70 + Math.random() * 110;
      const bit = document.createElement('i');
      bit.style.cssText = `--x:${x}px;--y:${y}px;--c:${colors[i % colors.length]};--s:${8 + Math.round(Math.random() * 6)}px;--dx:${Math.round(Math.cos(angle) * reach)}px;--dy:${Math.round(Math.sin(angle) * reach + 50)}px;--r:${Math.round(Math.random() * 360)}deg`;
      return bit;
    });
    el.confetti.append(...bits);
    setTimeout(() => bits.forEach((b) => b.remove()), 1300);
    tellNative({ type: 'haptic', kind: 'success' });
  }

  let constellationTimer = 0;
  function drawConstellation(coords) {
    clearInterval(constellationTimer);
    const src = map.getSource('constellation');
    if (!src || coords.length < 2) return;
    const steps = 24;
    const segments = coords.length - 1;
    let i = 0;
    constellationTimer = setInterval(() => {
      i++;
      const f = Math.min(1, i / steps) * segments;
      const seg = Math.min(segments - 1, Math.floor(f));
      const local = f - seg;
      const [a, b] = [coords[seg], coords[seg + 1]];
      src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...coords.slice(0, seg + 1), [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local]] }, properties: {} });
      if (i >= steps) clearInterval(constellationTimer);
    }, 25);
  }

  // Same rules as the server's planner, for an instant offline night.
  function localNight(ids) {
    const events = ids.map((id) => state.byId.get(id)).sort((a, b) => startOf(a) - startOf(b));
    let clock = null;
    let prev = state.from?.coords;
    const schedule = events.map((e) => {
      const w = prev ? walkMin(prev, e.coordinates) : 0;
      const arrive = clock == null ? startOf(e) : clock + w * 60000;
      const enjoy = Math.max(arrive, startOf(e));
      const leave = Math.min(endOf(e), enjoy + STAY_MIN * 60000);
      clock = leave;
      prev = e.coordinates;
      return { eventId: e.id, walkMin: Math.round(w), arrive: new Date(arrive).toISOString(), enjoyFrom: new Date(enjoy).toISOString(), leave: new Date(leave).toISOString() };
    });
    const total = events.reduce((s, e) => s + e.price, 0);
    return {
      success: true,
      source: 'fallback',
      title: `The $${total} Sunset-to-Midnight Board Game Crawl`,
      pitch: 'A cappella under the arch, boba and board games in Klarman, then 2 AM pizza with the hackers.',
      eventIds: events.map((e) => e.id),
      events,
      schedule,
      totalCost: total,
      budget: state.balance ?? 18,
    };
  }
  const DEMO_NIGHT = ['evt_002', 'evt_011', 'evt_036']; // Arch Sing (free) · Klarman ($5) · Duffield pizza (free)

  async function curateNight({ mustInclude, budget, keepTime = false, timeoutMs } = {}) {
    if (el.curate.disabled) return null;
    stopPlaying();
    popup.remove();
    setLoading(el.curate, true);
    const interests = getInterests();
    let r;
    try {
      if (timeoutMs && offline()) throw new Error('offline');
      const request = api('/api/radar/constellation', {
        body: { balance: budget ?? state.balance ?? undefined, location: state.from?.coords, interests, mustInclude },
      });
      r = timeoutMs ? await withTimeout(request, timeoutMs) : await request;
    } catch (err) {
      if (!timeoutMs) {
        toast(`Couldn't plan a night just now · ${err.message}`, 'error');
        return null;
      } else r = localNight(DEMO_NIGHT);
    } finally {
      setLoading(el.curate, false);
    }

    clearInterval(constellationTimer);
    map.getSource('constellation')?.setData({ type: 'FeatureCollection', features: [] });
    state.night = r;
    if (!keepTime) setTime(msToSlider(Date.parse(r.schedule[0].enjoyFrom)));
    else applyEventFilter();
    spotlight(r.eventIds);
    setTimeout(() => drawConstellation(r.events.map((e) => e.coordinates)), 200);
    const bounds = r.events.reduce((b, e) => b.extend(e.coordinates), new maplibregl.LngLatBounds(r.events[0].coordinates, r.events[0].coordinates));
    map.fitBounds(bounds, { padding: overlayPadding(), duration: 800, maxZoom: 16.2 });
    renderNight();
    toast(`${r.source === 'gemini' ? 'Gemini' : 'Capybara Pigeon'} planned "${r.title}"`);
    return r;
  }

  function renderNight() {
    const n = state.night;
    el.night.hidden = !n;
    el.planHero.hidden = Boolean(n);
    if (!n) {
      el.night.innerHTML = '';
      return;
    }
    const booked = n.events.every((e) => state.chain.has(e.id));
    const paidTotal = n.events.reduce((sum, e) => sum + (state.paid.get(e.id)?.amount || 0), 0);
    const rows = n.events
      .map((e, i) => {
        const s = n.schedule[i];
        const done = state.chain.has(e.id);
        return `${i > 0 ? `<li class="night-walk">${icon('paw')}${s.walkMin} min walk</li>` : ''}<li class="night-stop ${done ? 'paid' : ''}">
          <span class="n" style="--accent:${colorFor(e.category)}">${done ? '✓' : i + 1}</span>
          <div><div class="night-stop-title">${escapeHtml(e.title)}</div><div class="night-stop-meta">${fmtTime(Date.parse(s.enjoyFrom))} · ${escapeHtml(e.venue)}</div></div>
          <span class="price ${e.price === 0 ? 'free' : ''}">${fmtPrice(e.price)}</span>
        </li>`;
      })
      .join('');
    const chip = n.source === 'gemini' ? `<span class="chip gemini" title="${escapeHtml(n.model)}">✦ Picked by Gemini</span>` : '<span class="chip warn">Picked instantly</span>';
    const main = buying
      ? '<button class="btn btn-matcha btn-lg" disabled><span class="btn-label">Paying with Capital One…</span></button>'
      : booked
        ? '<button class="btn btn-matcha btn-lg" data-night="route">See my night</button>'
        : `<button class="btn btn-matcha btn-lg" data-night="buy">${n.totalCost > 0 ? `Book it · ${fmtMoney(n.totalCost)}` : "Lock it in · it's free"}</button>`;
    const bookedHtml = booked
      ? `<div class="night-booked">${icon('capy-happy')}<div><strong>You're all set!</strong>${paidTotal ? `Paid ${fmtMoney(paidTotal)} via Capital One.` : 'Every stop is free tonight.'}</div></div>`
      : '';
    el.night.innerHTML = `
      <div class="card night-card">
        <div class="tags">${chip}<span class="chip">${n.events.length} stops</span></div>
        <h3 class="night-title">${escapeHtml(n.title)}</h3>
        ${n.pitch ? `<p class="night-pitch">${escapeHtml(n.pitch)}</p>` : ''}
        <ol class="night-stops">${rows}</ol>
        <div class="night-total"><span class="label">Total</span><strong>${fmtMoney(n.totalCost)}</strong><small>of your ${fmtMoney(n.budget)}</small></div>
        ${bookedHtml}
        ${main}
        <div class="night-actions">
          <button class="btn btn-ghost btn-sm" data-night="recurate">Try another</button>
          <button class="btn btn-ghost btn-sm" data-night="clear">Start over</button>
        </div>
      </div>`;
  }

  /** Book every stop. Returns true once the whole night is on tonight's list. */
  async function buyNight({ timeoutMs } = {}) {
    const n = state.night;
    if (!n || buying) return false;
    buying = true;
    renderNight();
    let spent = 0;
    try {
      for (const e of n.events) {
        if (state.chain.has(e.id)) continue;
        const ok = await addToChain(e.id, { timeoutMs, quiet: true });
        if (!ok) return false;
        spent += state.paid.get(e.id)?.amount || 0;
        renderNight();
        await sleep(300);
      }
      if (!spent) toast("Locked in · tonight's all free", 'pay');
    } finally {
      buying = false;
      renderNight();
    }
    celebrate(el.night.querySelector('.night-booked'));
    return true;
  }

  // Walk the night: if there's no destination yet, end at the last stop.
  async function showNightRoute({ timeoutMs } = {}) {
    const n = state.night;
    if (n && !state.to) {
      const last = n.events[n.events.length - 1];
      state.to = { name: last.venue, coords: last.coordinates };
      renderRouteFields();
      scheduleDetours();
    }
    setTab('tonight');
    clearTimeout(routeTimer);
    pendingFit = false;
    await computeRoute({ fit: true, timeoutMs });
  }

  function clearNight() {
    clearInterval(constellationTimer);
    state.night = null;
    map.getSource('constellation')?.setData({ type: 'FeatureCollection', features: [] });
    renderNight();
    applyEventFilter();
  }

  el.curate.addEventListener('click', () => curateNight());
  el.night.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-night]')?.dataset.night;
    if (action === 'buy') {
      // Booked by hand: give the celebration a beat, then show the walk.
      buyNight().then(async (ok) => {
        if (!ok) return;
        await sleep(1100);
        if (state.tab === 'plan' && !demo.running) showNightRoute();
      });
    } else if (action === 'route') showNightRoute();
    else if (action === 'recurate') curateNight();
    else if (action === 'clear') clearNight();
  });

  // =====================================================================
  // Pigeon alerts (Gemini + Photon iMessage)
  // =====================================================================
  // Tells the server which open app is which. Kept across reloads so a number you've
  // confirmed stays yours without confirming it again.
  const CLIENT_ID = (() => {
    const fresh = `app-${Math.random().toString(36).slice(2, 12)}`;
    try {
      const saved = localStorage.getItem('capybara-pigeon:client');
      if (saved) return saved;
      localStorage.setItem('capybara-pigeon:client', fresh);
    } catch {
      // storage blocked: a new id each visit
    }
    return fresh;
  })();
  // Kinds of event (categories) the pigeon never texts about. Everything starts switched
  // on; the choice is kept on this device across reloads.
  const MUTED_KEY = 'capybara-pigeon:muted';
  const muted = new Set(
    (() => {
      try {
        const saved = JSON.parse(localStorage.getItem(MUTED_KEY));
        return Array.isArray(saved) ? saved.filter((c) => typeof c === 'string') : [];
      } catch {
        return []; // storage blocked or unreadable: text about everything
      }
    })(),
  );
  const CAMPUS_RADIUS_M = 2500; // a real position only counts when it's actually near campus
  const pigeon = { live: false, to: null, enabled: false, lastCheck: null, checkTimer: 0, checking: false, tookLive: false, lastReroute: 0 };
  // The blue dot. It turns with the map, so its cone keeps pointing the way you're facing.
  const meMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'me-marker', innerHTML: '<span class="me-cone"></span>' }), rotationAlignment: 'map' });

  // Where "you" are for alerts and walks: your real position when it's fresh and on
  // campus, otherwise a stand-in spot just outside Willard Straight.
  function liveSpot() {
    const me = state.me;
    return me && metersBetween(me.coords, CORNELL) <= CAMPUS_RADIUS_M && Date.now() - me.at < 3 * 60000 ? me.coords : null;
  }
  const alertSpot = () => liveSpot() || SIM_PING;

  /** A real position arrived (from the phone app's GPS, or the browser when allowed). */
  function setMyLocation({ lng, lat } = {}) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const coords = [lng, lat];
    const moved = state.me ? metersBetween(state.me.coords, coords) : Infinity;
    state.me = { coords, at: Date.now() };
    renderAlerts();
    if (!liveSpot()) return meMarker.remove();
    meMarker.setLngLat(coords).addTo(map);

    // "My location" in the From box follows you: adopted once in place of the North Campus
    // stand-in, then nudged along as you walk (re-planning the walk at most every 20s).
    const adopt = !pigeon.tookLive && state.from?.hubId === 'north' && !demo.running;
    if (adopt || (state.from?.live && moved >= 25 && Date.now() - pigeon.lastReroute > 20000)) {
      pigeon.tookLive = true;
      pigeon.lastReroute = Date.now();
      state.from = { name: 'My location', coords, live: true };
      renderRouteFields();
      scheduleRoute();
    } else if (moved === Infinity) renderRouteFields(); // first fix: offer "My location" in the list
    if (moved >= 40) scheduleCheckIn(1500);
    keepFollowing();
  }
  /** Which way you're facing, in degrees clockwise from north (the phone's compass). */
  function setMyHeading(degrees) {
    if (!Number.isFinite(degrees)) return;
    const heading = ((degrees % 360) + 360) % 360;
    const turned = state.heading == null ? 360 : Math.abs(((heading - state.heading + 540) % 360) - 180);
    state.heading = heading;
    meMarker.setRotation(heading);
    meMarker.getElement().classList.add('has-heading');
    if (follow.mode === 'heading' && turned >= 2) keepFollowing();
  }

  // ---- Find me ----
  // 'off': the map stays where you put it. 'center': it stays centered on you as you move.
  // 'heading': it also turns so the way you're facing is up. Dragging the map lets go.
  const follow = { mode: 'off' };
  function keepFollowing({ arrive = false } = {}) {
    const spot = liveSpot();
    if (follow.mode === 'off' || !spot) return;
    const camera = { center: spot, padding: overlayPadding(), duration: arrive ? 700 : 350, easing: (t) => t };
    if (arrive) camera.zoom = Math.max(map.getZoom(), 16.6);
    if (follow.mode === 'heading' && state.heading != null) camera.bearing = state.heading;
    map.easeTo(camera);
  }
  function setFollow(mode) {
    const was = follow.mode;
    follow.mode = mode;
    el.locate.dataset.mode = mode;
    el.locate.setAttribute('aria-label', mode === 'off' ? 'Center the map on me' : mode === 'center' ? 'Following you. Tap to turn the map the way you face' : 'Turning with you. Tap to stop following');
    if (mode === 'off') {
      if (was === 'heading') map.easeTo({ bearing: 0, duration: 500 }); // north back on top
      return;
    }
    keepFollowing({ arrive: was === 'off' });
  }
  el.locate.addEventListener('click', () => {
    watchBrowserLocation();
    if (!liveSpot()) {
      return toast(state.me ? "You're off campus, so there's no live spot to center on" : "Can't see your location yet. Check that location is allowed", 'error');
    }
    if (follow.mode === 'off') {
      setFollow('center');
      toast('Following you');
    } else if (follow.mode === 'center' && state.heading != null) {
      setFollow('heading');
      toast('Turning the map the way you face');
    } else {
      if (follow.mode === 'center') toast('No compass on this device, so the map stays north-up');
      setFollow('off');
    }
  });
  // Moving the map yourself lets go of following (the app's own camera moves don't).
  map.on('dragstart', (ev) => {
    if (ev.originalEvent && follow.mode !== 'off') setFollow('off');
  });
  window.CapybaraPigeon = { setLocation: setMyLocation, setHeading: setMyHeading };

  // Browsers only share a position on secure pages, and only after the user opts in to alerts.
  let geoWatch = null;
  function watchBrowserLocation() {
    if (native || geoWatch != null || !navigator.geolocation || !window.isSecureContext) return;
    // A phone browser's compass, where it offers one (the phone app sends its own).
    window.addEventListener('deviceorientationabsolute', (ev) => ev.alpha != null && setMyHeading(360 - ev.alpha));
    window.addEventListener('deviceorientation', (ev) => ev.webkitCompassHeading != null && setMyHeading(ev.webkitCompassHeading));
    geoWatch = navigator.geolocation.watchPosition(
      (p) => setMyLocation({ lng: p.coords.longitude, lat: p.coords.latitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
  }

  function animateWalk(from, to, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      youMarker.setLngLat(from).addTo(map);
      map.easeTo({ center: to, zoom: 16.2, duration: ms, padding: overlayPadding() });
      const id = setInterval(() => {
        const f = Math.min(1, (Date.now() - t0) / ms);
        const e = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
        youMarker.setLngLat([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]);
        if (f >= 1) {
          clearInterval(id);
          resolve();
        }
      }, 30);
    });
  }

  function deliveryLabel(d) {
    if (!d) return 'Not sent';
    if (d.delivered && d.mocked) return 'Sent · demo mode';
    if (d.delivered) return `Texted ${d.to} · via Photon`;
    return "Text didn't send";
  }

  // The pigeon button in the top bar explains alerts before sending one.
  function toggleAlerts(open = el.alertsPop.hidden) {
    el.alertsPop.hidden = !open;
    el.alertsBtn.setAttribute('aria-expanded', String(open));
  }
  el.alertsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleAlerts();
  });
  document.addEventListener('click', (ev) => {
    if (!el.alertsPop.hidden && !ev.target.closest('#alertsPop')) toggleAlerts(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') toggleAlerts(false);
  });

  // The banner mirrors the text conversation: the pigeon's bubbles on the left, your
  // replies in blue on the right. `text == null` draws the typing dots.
  function bubble(text, who = 'pigeon') {
    const p = document.createElement('p');
    p.className = `im-bubble${who === 'me' ? ' me' : ''}${text == null ? ' typing' : ''}`;
    if (text == null) p.innerHTML = '<span></span><span></span><span></span>';
    else p.textContent = text;
    el.imThread.append(p);
    el.imThread.scrollTop = el.imThread.scrollHeight;
  }
  const stopTyping = () => el.imThread.querySelector('.typing')?.remove();

  /** Show a pigeon text. `append` adds it to the conversation instead of starting over. */
  function showIMessage({ body, typing = false, agent = '', agentClass = '', delivery = '', deliveryClass = '', addId = null, append = false }) {
    el.imessage.hidden = false;
    el.imMeta.textContent = typing ? 'Gemini is looking around…' : `iMessage · ${fmtTime(state.timeMs)}`;
    if (append) stopTyping();
    else el.imThread.replaceChildren();
    bubble(typing ? null : body);
    el.imAgent.textContent = agent;
    el.imAgent.className = `chip ${agentClass}`;
    el.imDelivery.textContent = delivery;
    el.imDelivery.className = `chip ${deliveryClass}`;
    state.lastPitStopId = addId;
    const e = addId && state.byId.get(addId);
    el.imAdd.hidden = !e || state.chain.has(addId);
    if (e) el.imAdd.textContent = `Add to tonight${e.price > 0 ? ` · $${e.price}` : ''}`;
  }

  // Instant local pick + copy when the agent is slow or offline (same rules as the server).
  function localPitStop() {
    const t = state.timeMs;
    const pick = state.events
      .filter((e) => !state.chain.has(e.id) && (demo.running || !muted.has(e.category)) && canAfford(e) && startOf(e) >= t && startOf(e) <= t + 30 * 60000 && metersBetween(SIM_PING, e.coordinates) <= 500)
      .sort((a, b) => metersBetween(SIM_PING, a.coordinates) - metersBetween(SIM_PING, b.coordinates))[0];
    if (!pick) return null;
    const mins = Math.max(1, Math.round(walkMin(SIM_PING, pick.coordinates)));
    const cover = pick.price === 0 ? "and it's free" : `with a $${pick.price} cover your Nessie balance can handle`;
    return { pick, message: `Coo! ${pick.title} starts at ${fmtTime(startOf(pick))}, a ${mins}-min waddle away ${cover}. Want me to add it to tonight?` };
  }

  // What the pigeon needs to know to look for a pit stop: where you are, what time it is
  // in the app, what you like, and what's already on tonight's list.
  function pitStopBody(location, extra = {}) {
    const destinationEta = state.route ? state.route.times[state.route.times.length - 1] : state.timeMs + 60 * 60000;
    return {
      clientId: CLIENT_ID,
      location,
      destinationEta: new Date(Math.max(destinationEta, state.timeMs + 15 * 60000)).toISOString(),
      interests: getInterests(),
      currentTime: new Date(state.timeMs).toISOString(),
      excludeIds: [...state.chain],
      // The guided demo plays the same for everyone, whatever this device switched off or picked.
      excludeCategories: demo.running ? [] : [...muted],
      textStyle: demo.running ? [] : getTextStyle(),
      ...extra,
    };
  }

  function showPitStop(result, { append = false } = {}) {
    const viaGemini = result.agent?.source === 'gemini';
    showIMessage({
      body: result.message,
      agent: viaGemini ? '✦ Picked by Gemini' : 'Instant pick',
      agentClass: viaGemini ? 'gemini' : 'warn',
      delivery: deliveryLabel(result.delivery),
      deliveryClass: result.delivery?.delivered ? 'ok' : 'warn',
      addId: result.pitStop.id,
      append,
    });
    spotlight([result.pitStop.id]);
  }

  /** "Send me one now": look around right away and text the best pit stop. */
  async function runPitStop({ timeoutMs } = {}) {
    if (simulating) return;
    stopPlaying();
    simulating = true;
    el.pitstop.disabled = true;
    el.alertsBtn.classList.add('busy');
    popup.remove();
    // The guided demo always uses the stand-in spot so it plays the same everywhere.
    const spot = (!timeoutMs && liveSpot()) || SIM_PING;
    try {
      showIMessage({ typing: true });
      let result;
      const walk =
        spot === SIM_PING
          ? animateWalk(SIM_WALK_FROM, SIM_PING, 1500)
          : Promise.resolve(map.easeTo({ center: spot, zoom: 16.2, duration: 800, padding: overlayPadding() }));
      try {
        if (timeoutMs && offline()) throw new Error('offline');
        const request = api('/api/radar/pitstop', {
          body: pitStopBody(spot, { geminiBudgetMs: timeoutMs ? Math.max(1500, timeoutMs - 5000) : undefined }),
        });
        [result] = await Promise.all([timeoutMs ? withTimeout(request, timeoutMs) : request, walk]);
      } catch (err) {
        await walk;
        if (!timeoutMs) throw err;
        const local = localPitStop();
        result = local
          ? { pitStop: local.pick, message: local.message, agent: { source: 'fallback' }, delivery: { delivered: true, mocked: true } }
          : { pitStop: null, filter: { candidates: 0 } };
      }

      if (!result.pitStop) {
        const soon = `in the 30 min after ${fmtTime(state.timeMs)}`;
        showIMessage({
          body: result.filter?.candidates
            ? 'Nothing nearby is worth the detour right now. Keep waddling!'
            : result.filter?.muted
              ? `Nothing in your budget starts nearby ${soon}, apart from kinds of events you switched off.`
              : `Nothing in your budget starts nearby ${soon}.`,
          agent: result.agent?.source === 'gemini' ? '✦ Checked by Gemini' : 'Quick check',
          agentClass: result.agent?.source === 'gemini' ? 'gemini' : '',
        });
        return;
      }
      showPitStop(result);
    } catch (err) {
      showIMessage({ body: `The pigeon got lost: ${err.message}`, agent: 'Oops', agentClass: 'warn' });
    } finally {
      simulating = false;
      el.pitstop.disabled = false;
      el.alertsBtn.classList.remove('busy');
      updateYouOnRoute();
    }
  }

  el.pitstop.addEventListener('click', () => {
    toggleAlerts(false);
    setTab('explore');
    runPitStop();
  });
  el.imAdd.addEventListener('click', async () => {
    if (!state.lastPitStopId) return;
    el.imAdd.disabled = true;
    const ok = await addToChain(state.lastPitStopId);
    el.imAdd.disabled = false;
    if (ok) el.imAdd.hidden = true;
  });
  el.imClose.addEventListener('click', () => (el.imessage.hidden = true));

  // ---- Automatic alerts: on/off, check-ins, and the live conversation ----
  function renderAlerts() {
    el.alertsToggle.checked = pigeon.enabled;
    el.alertsBtn.classList.toggle('on', pigeon.enabled);
    el.alertsWhere.textContent = liveSpot() ? 'Following your live location' : state.me ? "You're off campus: using a spot by Willard Straight" : 'Using a spot by Willard Straight';
    el.alertsVia.textContent = !pigeon.live ? 'Demo mode: texts show here, none are sent' : pigeon.to ? `Texts go to ${pigeon.to} via Photon iMessage` : 'Add your number to get texts';
    el.numberChange.textContent = pigeon.own ? 'Change number' : 'Use my number';
  }

  function applyAlertStatus(status) {
    const wasOn = pigeon.enabled;
    pigeon.live = Boolean(status.live);
    pigeon.to = status.to || null;
    pigeon.own = Boolean(status.own);
    pigeon.enabled = Boolean(status.enabled);
    renderAlerts();
    if (!pigeon.enabled) clearTimeout(pigeon.checkTimer);
    else if (!wasOn) {
      // Just switched on (here, in another open app, or by texting RESUME): look right away.
      pigeon.lastCheck = null;
      scheduleCheckIn(600);
    }
  }

  el.alertsToggle.addEventListener('change', async () => {
    const want = el.alertsToggle.checked;
    try {
      applyAlertStatus(await api('/api/photon/alerts', { body: { enabled: want, clientId: CLIENT_ID } }));
      if (!want) return toast('Alerts off · the pigeon will stay quiet');
      toast(pigeon.live ? `Alerts on · I'll text ${pigeon.to}` : 'Alerts on · demo mode, no real texts');
      watchBrowserLocation();
    } catch (err) {
      el.alertsToggle.checked = !want;
      toast(`Couldn't change alerts · ${err.message}`, 'error');
    }
  });

  // ---- What the pigeon texts about ----
  // Switched-off kinds are left out of automatic alerts, "Send me one now" and NEARBY replies.
  function renderAlertKinds() {
    for (const pick of el.alertKinds.querySelectorAll('.pick')) pick.setAttribute('aria-pressed', String(!muted.has(pick.dataset.value)));
  }
  el.alertKinds.addEventListener('click', (ev) => {
    const pick = ev.target.closest('.pick');
    if (!pick) return;
    const kind = pick.dataset.value;
    const turningOff = !muted.has(kind);
    if (turningOff && el.alertKinds.querySelectorAll('.pick[aria-pressed="true"]').length === 1) {
      return toast('Keep at least one, or switch alerts off instead');
    }
    if (turningOff) muted.add(kind);
    else muted.delete(kind);
    try {
      localStorage.setItem(MUTED_KEY, JSON.stringify([...muted]));
    } catch {
      // storage blocked: the choice lasts for this visit
    }
    renderAlertKinds();
    if (!turningOff) {
      // Something just switched back on might be starting nearby: look again.
      pigeon.lastCheck = null;
      scheduleCheckIn(1500);
    }
  });
  renderAlertKinds();

  // ---- How the pigeon's texts sound ----
  // Like the Plan tab's interests: tapped chips plus anything typed, handed to Gemini when it
  // writes a text. Kept on this device across reloads.
  const STYLE_KEY = 'capybara-pigeon:text-style';
  function getTextStyle() {
    return [
      ...[...el.alertStyle.querySelectorAll('.pick[aria-pressed="true"]')].map((p) => p.dataset.value),
      ...el.alertStyleExtra.value.split(',').map((s) => s.trim()).filter(Boolean),
    ];
  }
  function saveTextStyle() {
    const picks = [...el.alertStyle.querySelectorAll('.pick[aria-pressed="true"]')].map((p) => p.dataset.value);
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify({ picks, extra: el.alertStyleExtra.value }));
    } catch {
      // storage blocked: the style lasts for this visit
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY)) || {};
    const picks = Array.isArray(saved.picks) ? saved.picks : [];
    for (const pick of el.alertStyle.querySelectorAll('.pick')) pick.setAttribute('aria-pressed', String(picks.includes(pick.dataset.value)));
    if (typeof saved.extra === 'string') el.alertStyleExtra.value = saved.extra.slice(0, 120);
  } catch {
    // storage blocked or unreadable: the pigeon's usual voice
  }
  el.alertStyle.addEventListener('click', (ev) => {
    const pick = ev.target.closest('.pick');
    if (!pick) return;
    pick.setAttribute('aria-pressed', String(pick.getAttribute('aria-pressed') !== 'true'));
    saveTextStyle();
  });
  el.alertStyleExtra.addEventListener('input', saveTextStyle);

  // ---- Using your own number ----
  // Type your number, then text a ready-made JOIN message to the pigeon from that phone.
  // Photon's line can only text people who have texted it first, and it proves the number is yours.
  let demoJoinText = '';
  function numberStep(step, hint = '') {
    el.numberForm.hidden = step !== 'number';
    el.joinStep.hidden = step !== 'join';
    el.numberHint.hidden = !hint;
    el.numberHint.innerHTML = hint;
  }
  el.numberChange.addEventListener('click', () => {
    if (!el.numberForm.hidden || !el.joinStep.hidden) return numberStep('');
    numberStep('number');
    el.numberInput.focus();
  });
  el.numberForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const next = el.numberForm.querySelector('button');
    next.disabled = true;
    try {
      const r = await api('/api/photon/number', { body: { clientId: CLIENT_ID, phone: el.numberInput.value } });
      demoJoinText = r.demo ? r.joinText : '';
      if (r.joinUrl) el.joinLink.href = r.joinUrl;
      else el.joinLink.removeAttribute('href');
      el.joinLink.textContent = r.demo ? 'Pretend to send it' : 'Open Messages and send';
      numberStep(
        'join',
        r.demo
          ? `Demo mode: nothing is really texted. Tap below to pretend you sent <b>${escapeHtml(r.joinText)}</b>.`
          : `Last step: from the phone ending ${escapeHtml(r.to.slice(-4))}, send the pigeon <b>${escapeHtml(r.joinText)}</b>. The button fills it in for you. This page updates as soon as it arrives.`,
      );
    } catch (err) {
      numberStep('number', escapeHtml(err.message));
    } finally {
      next.disabled = false;
    }
  });
  el.joinLink.addEventListener('click', (ev) => {
    if (demoJoinText) {
      ev.preventDefault();
      api('/api/photon/mock-reply', { body: { clientId: CLIENT_ID, text: demoJoinText } }).catch(() => {});
    } else if (native && el.joinLink.href) {
      ev.preventDefault(); // the phone app opens Messages itself
      tellNative({ type: 'open', url: el.joinLink.href });
    }
  });
  // The pigeon got your JOIN text: this app's texts go to your number from now on.
  function joined(status) {
    applyAlertStatus(status);
    el.numberInput.value = '';
    demoJoinText = '';
    numberStep('');
    toast(pigeon.to ? `You're in · your pigeon texts ${pigeon.to}` : "You're in");
  }

  // With alerts on, tell the server where "you" are whenever that meaningfully changes:
  // you moved, or the night moved on. The server decides whether a text is worth sending.
  function scheduleCheckIn(delay = 2000) {
    clearTimeout(pigeon.checkTimer);
    if (pigeon.enabled) pigeon.checkTimer = setTimeout(checkIn, delay);
  }

  async function checkIn() {
    if (!pigeon.enabled || pigeon.checking || simulating || demo.running || !state.events.length) return;
    const spot = alertSpot();
    const last = pigeon.lastCheck;
    if (last && metersBetween(last.spot, spot) < 40 && Math.abs(state.timeMs - last.timeMs) < 10 * 60000) return;
    pigeon.checking = true;
    try {
      const result = await api('/api/photon/checkin', { body: pitStopBody(spot) });
      if (result.skipped === 'cooldown' || result.skipped === 'busy') return scheduleCheckIn(30000); // texted a moment ago: look again soon
      pigeon.lastCheck = { spot, timeMs: state.timeMs };
      if (result.pitStop) showPitStop(result);
    } catch (err) {
      console.warn('[alerts] check-in failed:', err.message);
    } finally {
      pigeon.checking = false;
    }
  }

  // A YES texted back to the pigeon lands here: add the stop (paying if needed) and tell
  // the server how it went, so the pigeon's answer on the phone is true.
  async function addFromReply({ id, eventId }) {
    state.lastAddError = state.byId.has(eventId) ? '' : "that event isn't on tonight's map";
    const ok = state.chain.has(eventId) || (await addToChain(eventId));
    api('/api/photon/ack', { body: { id, ok, reason: ok ? '' : state.lastAddError } }).catch(() => {});
    if (ok && state.lastPitStopId === eventId) el.imAdd.hidden = true;
  }

  function connectStream() {
    if (!window.EventSource) return;
    const stream = new EventSource(`/api/photon/stream?client=${CLIENT_ID}`);
    const on = (type, handle) =>
      stream.addEventListener(type, (ev) => {
        try {
          handle(JSON.parse(ev.data));
        } catch (err) {
          console.warn(`[alerts] couldn't handle "${type}":`, err);
        }
      });
    const openThread = () => {
      el.imessage.hidden = false;
      el.imMeta.textContent = `iMessage · ${fmtTime(Date.now())}`;
    };
    on('hello', applyAlertStatus);
    on('alerts', applyAlertStatus);
    on('joined', joined);
    on('add', addFromReply);
    on('said', ({ text }) => {
      openThread();
      stopTyping();
      bubble(text, 'me');
      bubble(null);
    });
    on('answer', ({ text }) => {
      stopTyping();
      if (!text) return;
      openThread();
      bubble(text);
    });
    on('alert', (result) => showPitStop(result, { append: true }));
  }

  // =====================================================================
  // ⚡ Judge demo
  // =====================================================================
  const DEMO_STEPS = [
    {
      title: 'Plan a walk',
      sub: 'Tonight tab: North Campus (RPCC) to Collegetown. The path and arrival time update the moment either end changes.',
      hold: 6000,
      run: async () => {
        setTab('tonight');
        setEndpoint('from', hubPlace('north'));
        setEndpoint('to', hubPlace('collegetown'));
        clearTimeout(routeTimer);
        pendingFit = false;
        await computeRoute({ fit: true, timeoutMs: 4000 });
      },
    },
    {
      title: '8:00 PM · peak O-Week',
      sub: 'Explore tab: scrub the night. Every bouncy blob is a real event; warm glows show where campus is busiest.',
      hold: 6000,
      run: async () => {
        setTab('explore');
        await glideTo(180, 1500);
        map.easeTo({ center: [-76.4835, 42.4478], zoom: 15.4, duration: 1200, padding: overlayPadding() });
      },
    },
    {
      title: 'Gemini plans your night',
      sub: 'Plan tab: Gemini picks 3 stops that fit your Capital One balance and leave time to walk between them.',
      hold: 7000,
      run: () => {
        setTab('plan');
        return curateNight({ mustInclude: ['evt_011'], budget: 5, keepTime: true, timeoutMs: 4500 });
      },
    },
    {
      title: '1-tap Capital One checkout',
      sub: 'Nessie pays the $5 cover straight to the organizer. Watch the wallet in the top bar.',
      hold: 5500,
      run: () => buyNight({ timeoutMs: 3500 }),
    },
    {
      title: 'Photon texts your phone',
      sub: 'Walking past Willard Straight, the pigeon spots something starting nearby and sends a real iMessage through Photon.',
      hold: 7000,
      run: () => {
        setTab('explore');
        return runPitStop({ timeoutMs: 9500 });
      },
    },
    {
      title: 'Walk your night',
      sub: 'Tonight tab: one cozy walking route through every stop, with real pedestrian times.',
      hold: 7000,
      run: async () => {
        el.imessage.hidden = true;
        await showNightRoute({ timeoutMs: 5000 });
      },
    },
  ];

  function demoCaption(i, step) {
    el.demoStep.textContent = `${i + 1} / ${DEMO_STEPS.length}`;
    el.demoTitle.textContent = step.title;
    el.demoSub.textContent = step.sub;
    el.demoBar.style.width = `${((i + 1) / DEMO_STEPS.length) * 100}%`;
  }

  function hold(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      demo.skip = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  async function resetForDemo() {
    stopPlaying();
    stopPicking();
    popup.remove();
    dismissCoach();
    el.imessage.hidden = true;
    clearNight();
    ++routeSeq;
    clearRoute();
    trip.status = 'idle';
    trip.dropped = [];
    state.chain.clear();
    state.paid.clear();
    state.detours = [];
    renderTonight();
    setTab('explore');
    try {
      if (offline()) throw new Error('offline');
      const r = await withTimeout(api('/api/demo/reset', { body: {} }), 3000);
      setBalance(r.balance, r.balanceSource);
    } catch {
      setBalance(18, state.balanceSource || 'fallback');
    }
  }

  async function runJudgeDemo() {
    if (demo.running) return stopDemo();
    demo.running = true;
    demo.cancelled = false;
    document.body.classList.add('demo-on');
    el.judgeDemo.querySelector('.demo-text').textContent = 'Stop';
    el.demoCaption.hidden = false;
    demoCaption(0, { title: 'Getting ready…', sub: 'Resetting the demo account to $18.00' });
    el.demoBar.style.width = '0%';
    try {
      await resetForDemo();
      for (let i = 0; i < DEMO_STEPS.length; i++) {
        if (demo.cancelled) return;
        const step = DEMO_STEPS[i];
        demoCaption(i, step);
        try {
          await step.run();
        } catch (err) {
          console.warn('[demo] step failed, continuing:', err);
        }
        if (demo.cancelled) return;
        await hold(step.hold);
      }
      el.demoStep.textContent = '✓';
      el.demoTitle.textContent = 'That’s Capybara Pigeon 🦫🐦';
      el.demoSub.textContent = 'Planned by Gemini, paid with Capital One Nessie, texted over Photon iMessage, walked together.';
      await hold(5000);
    } finally {
      finishDemo();
    }
  }

  function stopDemo() {
    demo.cancelled = true;
    demo.skip?.();
    finishDemo();
  }

  function finishDemo() {
    demo.running = false;
    document.body.classList.remove('demo-on');
    el.judgeDemo.querySelector('.demo-text').textContent = 'Demo';
    el.demoCaption.hidden = true;
  }

  el.judgeDemo.addEventListener('click', runJudgeDemo);
  el.demoNext.addEventListener('click', () => demo.skip?.());
  el.demoStop.addEventListener('click', stopDemo);

  // =====================================================================
  // First-visit hello
  // =====================================================================
  const COACH_KEY = 'capybara-pigeon:said-hi';
  function showCoach() {
    try {
      if (localStorage.getItem(COACH_KEY)) return;
    } catch {
      // storage blocked: just say hi every time
    }
    el.coach.hidden = false;
  }
  function dismissCoach() {
    if (el.coach.hidden) return;
    el.coach.hidden = true;
    try {
      localStorage.setItem(COACH_KEY, '1');
    } catch {
      // nothing to remember it with
    }
  }
  el.coachClose.addEventListener('click', dismissCoach);

  // =====================================================================
  // Boot
  // =====================================================================
  async function boot() {
    renderRouteFields();
    let events;
    try {
      events = await withTimeout(api('/api/events'), 8000);
    } catch (err) {
      toast(`Failed to load events: ${err.message}`, 'error');
      return;
    }
    state.events = events;
    state.byId = new Map(events.map((e) => [e.id, e]));
    renderDensity();
    createBlobs();
    setTime(Number(el.slider.value));
    loadBalance();
    showCoach();
    renderAlerts();
    connectStream();
    tellNative({ type: 'ready' }); // the phone app can start sending its location

    await styleReady;
    addLayers();
    applyEventFilter();
  }

  boot();
})();
