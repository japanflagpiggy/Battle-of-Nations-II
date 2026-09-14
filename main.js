/* ============================================================================
   main.js
   Rendering, UI wiring and the game loop. Depends on nations.js and ai.js
   (loaded before this file — see index.html).
   ============================================================================ */

/* ---------------------------------------------------------------------------
   Political Focus Tree definition (read by both the UI here and ai.js)
   --------------------------------------------------------------------------- */
const FocusTree = [
  {
    name: 'Economic',
    branch: 'economy',
    nodes: [
      { id: 'eco_markets', name: 'Open Markets', desc: '+15% national income.', days: 5, cost: 18 },
      { id: 'eco_trade', name: 'Trade Agreements', desc: '+12% national income; stacks with Open Markets.', days: 6, cost: 24 },
      { id: 'eco_industry', name: 'Industrial Expansion', desc: '+20% national income.', days: 8, cost: 32 }
    ]
  },
  {
    name: 'Military',
    branch: 'military',
    nodes: [
      { id: 'mil_conscription', name: 'Conscription Reform', desc: '+12% military strength.', days: 5, cost: 18 },
      { id: 'mil_industry', name: 'Militarize Industry', desc: '+15% military strength.', days: 7, cost: 26 },
      { id: 'mil_doctrine', name: 'New Doctrine', desc: '+18% military strength.', days: 9, cost: 34 }
    ]
  },
  {
    name: 'Diplomatic',
    branch: 'diplomatic',
    nodes: [
      { id: 'dip_envoys', name: 'Foreign Envoys', desc: 'Improve Relations gains more per use.', days: 5, cost: 16 },
      { id: 'dip_treaties', name: 'Standing Treaties', desc: 'Shorter truces after peace.', days: 6, cost: 22 },
      { id: 'dip_leadership', name: 'Regional Leadership', desc: 'Lower relation threshold required to Ally.', days: 8, cost: 30 }
    ]
  }
];

/* ---------------------------------------------------------------------------
   App-level state (not persisted world state — that's in World)
   --------------------------------------------------------------------------- */
const App = {
  svg: null,
  mapGroup: null,
  arrowGroup: null,
  projection: null,
  path: null,
  zoomBehavior: null,
  currentTransform: null,
  selectedNationId: null,   // nation currently shown in the diplomacy panel
  hoverNationId: null,
  tickTimer: null,
  showNameplates: true,
  showMinorNameplates: false,
  showMapDecorations: true,
  featureById: new Map(),
  centroidById: new Map(),
  areaById: new Map()
};

const TICK_MS = 1200; // real-time ms per game turn at 1x speed

let loadedAdjacency = null; // cached adjacency.json data for save/load

const GameAudio = {
  click: new Audio('./click.wav'),
  focus: new Audio('./focusclick.wav'),
  alliance: new Audio('./alliance.wav'),
  notification: new Audio('./notification.wav'),
  
  waralert: new Audio('./waralert.wav')
};

const BackgroundMusic = {
  menu: document.getElementById('main-menu-music'),
  game: document.getElementById('game-music'),
  tracks: [
    './Music/Industrial Revolution.mp3',
    './Music/Crusade.mp3',
    './Music/Evil March 4.mp3',
    './Music/Chase.mp3'
  ],
  trackIndex: 0,
  unlocked: false,

  play(audio) {
    if (!this.unlocked) return;
    audio.play().catch(() => {});
  },

  stop(audio) {
    audio.pause();
    audio.currentTime = 0;
  },

  startMenu() {
    this.stop(this.game);
    this.menu.loop = true;
    this.play(this.menu);
  },

  startGame() {
    this.stop(this.menu);
    this.trackIndex = 0;
    this.game.src = this.tracks[this.trackIndex];
    this.game.loop = false;
    this.play(this.game);
  },

  advanceGameTrack() {
    this.trackIndex = (this.trackIndex + 1) % this.tracks.length;
    this.game.src = this.tracks[this.trackIndex];
    this.play(this.game);
  }
};

BackgroundMusic.game.addEventListener('ended', () => BackgroundMusic.advanceGameTrack());

Object.values(GameAudio).forEach(audio => {
  audio.preload = 'auto';
  audio.volume = 0.7;
});

function playSound(name) {
  const audio = GameAudio[name];
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => {});
}

document.addEventListener('click', (event) => {
  if (event.target.closest('button, input, .country-row, .focus-node, .country-path')) {
    BackgroundMusic.unlocked = true;
    if (document.getElementById('game-root').classList.contains('hidden')) {
      BackgroundMusic.startMenu();
    }
  }
  if (event.target.closest('button, input, .country-row, .focus-node, .country-path')) {
    playSound('click');
  }
}, true);

/* ---------------------------------------------------------------------------
   Fix polygon winding order.
   The source GeoJSON's rings are wound backwards for most countries (a common
   artifact of shapefile->GeoJSON conversion tools). D3's spherical clipping
   requires exterior rings to be clockwise (in raw lon/lat coordinates) and
   holes counter-clockwise; when that's reversed, D3 renders the complement
   of the country (almost the whole globe) instead of the country itself.
   --------------------------------------------------------------------------- */
function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

function rewindPolygonRings(rings) {
  rings.forEach((ring, i) => {
    const area = ringSignedArea(ring);
    const isHole = i > 0;
    if ((!isHole && area > 0) || (isHole && area < 0)) ring.reverse();
  });
}

function rewindGeometry(geom) {
  if (!geom) return;
  if (geom.type === 'Polygon') rewindPolygonRings(geom.coordinates);
  else if (geom.type === 'MultiPolygon') geom.coordinates.forEach(rewindPolygonRings);
}

function rewindGeoJSON(featureCollection) {
  featureCollection.features.forEach(f => rewindGeometry(f.geometry));
  return featureCollection;
}

/* ---------------------------------------------------------------------------
   Boot sequence
   --------------------------------------------------------------------------- */
window.addEventListener('DOMContentLoaded', init);

async function init() {
  wireMenuHandlers();
  wireModalCloseHandlers();
  wireAllianceHandlers();
  wireSettingsHandlers();
  wireTabHandlers();
  wireHudHandlers();
  wireDipTooltip();

  try {
    const [geoResp, adjResp] = await Promise.all([
      fetch('./ne_10m_admin_0_countries.geojson'),
      fetch('./adjacency.json')
    ]);
    const geoData = await geoResp.json();
    const adjData = await adjResp.json();

    loadedAdjacency = adjData;

    rewindGeoJSON(geoData); // fix reversed polygon winding from the source file

    buildNationsFromGeoJSON(geoData);
    loadAdjacency(adjData);
    assignDistinctColors(World.allNations());

    setupProjection(geoData);
    renderMenuBackdropMap(geoData);
  } catch (err) {
    console.error('Failed to load world data. Serve this folder over HTTP (not file://) so fetch() can load the map files.', err);
    const menu = document.getElementById('menu-backdrop-map');
    menu.innerHTML = '<div class="load-error">Could not load map data. Make sure ne_10m_admin_0_countries.geojson and adjacency.json sit next to index.html, and that the page is served over http(s):// rather than opened directly as a file.</div>';
  }
}

/* ---------------------------------------------------------------------------
   Projection / geometry helpers
   --------------------------------------------------------------------------- */
function setupProjection(geoData) {
  const width = 1600, height = 900;
  App.projection = d3.geoNaturalEarth1().fitSize([width, height], geoData);
  App.path = d3.geoPath(App.projection);

  geoData.features.forEach(f => {
    App.featureById.set(f.properties.ID, f);
    const centroid = App.path.centroid(f);
    App.centroidById.set(f.properties.ID, centroid);
    const bounds = App.path.bounds(f);
    const area = Math.abs((bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]));
    App.areaById.set(f.properties.ID, area);
  });
}

function renderMenuBackdropMap(geoData) {
  const container = document.getElementById('menu-backdrop-map');
  const width = 1600, height = 900;
  const svg = d3.select(container).append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid slice');

  svg.append('g').selectAll('path')
    .data(geoData.features)
    .join('path')
    .attr('d', App.path)
    .attr('class', 'backdrop-country');
}

/* ---------------------------------------------------------------------------
   Main menu wiring
   --------------------------------------------------------------------------- */
function wireMenuHandlers() {
  document.getElementById('btn-play').addEventListener('click', openSelectModal);
  document.getElementById('btn-how-to-play').addEventListener('click', () => showModal('howto-modal'));
  document.getElementById('btn-settings').addEventListener('click', () => showModal('settings-modal'));
  document.getElementById('btn-return-menu').addEventListener('click', () => {
    hideModal('settings-modal');
  });

  initMenuQuotes();
}

/* ---------------------------------------------------------------------------
   Rotating statesman quotes on the main menu
   --------------------------------------------------------------------------- */
const MenuQuotes = [
  { text: 'Mr. Gorbachev, tear down this wall!', author: 'Ronald Reagan' },
  { text: 'Ich bin ein Berliner.', author: 'John F. Kennedy' },
  { text: 'Ask not what your country can do for you — ask what you can do for your country.', author: 'John F. Kennedy' },
  { text: 'In preparing for battle I have always found that plans are useless, but planning is indispensable.', author: 'Dwight D. Eisenhower' },
  { text: 'Never, never, never give up.', author: 'Winston Churchill' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'Yes we can.', author: 'Barack Obama' },
  { text: 'Standing in the middle of the road is very dangerous; you get knocked down by the traffic from both sides.', author: 'Margaret Thatcher' },
  { text: 'The only thing we have to fear is fear itself.', author: 'Franklin D. Roosevelt' },
  { text: 'Patriotism is when love of your own people comes first; nationalism, when hatred for people other than your own comes first.', author: 'Charles de Gaulle' },
  { text: 'There is nothing wrong with America that cannot be cured by what is right with America.', author: 'Bill Clinton' },
  { text: 'When the circumstances change, we change our policy.', author: 'Angela Merkel' },
  { text: 'We are now faced with the fact, my friends, that tomorrow is today.', author: 'Martin Luther King Jr.' },
  { text: 'Diplomacy is the art of telling people to go to hell in such a way that they ask for directions.', author: 'Winston Churchill' }
];

const MENU_QUOTE_INTERVAL_MS = 5000;
const MENU_QUOTE_TRANSITION_MS = 560;

function initMenuQuotes() {
  const box = document.getElementById('menu-quote');
  const textEl = document.getElementById('menu-quote-text');
  const authorEl = document.getElementById('menu-quote-author');
  if (!box || !textEl) return;

  let index = Math.floor(Math.random() * MenuQuotes.length);

  const show = (i) => {
    const q = MenuQuotes[i % MenuQuotes.length];
    textEl.textContent = q.text;
    authorEl.textContent = '— ' + q.author;
  };

  const fadeIn = (i) => {
    box.classList.remove('swap-out');
    show(i);
    box.classList.remove('swap-in');
    // force reflow so the entrance animation restarts cleanly
    void box.offsetWidth;
    box.classList.add('swap-in');
  };

  // single self-scheduling timer — never overlaps, one swap per 5s
  const tick = () => {
    box.classList.add('swap-out');
    setTimeout(() => {
      index = (index + 1) % MenuQuotes.length;
      fadeIn(index);
    }, MENU_QUOTE_TRANSITION_MS);
    setTimeout(tick, MENU_QUOTE_INTERVAL_MS);
  };

  queueMicrotask(() => fadeIn(index));
  setTimeout(tick, MENU_QUOTE_INTERVAL_MS);
}

function wireModalCloseHandlers() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => hideModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideModal(overlay.id);
    });
  });
}

function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

let allianceOfferNationId = null;

function showAllianceProposal(nationId) {
  const nation = World.get(nationId);
  const player = World.get(World.playerId);
  if (!nation || !player || player.isAtWarWith(nationId) || player.isAlliedWith(nationId)) return;
  allianceOfferNationId = nationId;
  document.getElementById('alliance-offer-title').textContent = `${nation.name} Proposes an Alliance`;
  document.getElementById('alliance-offer-text').textContent = `${nation.name} wants to stand with you in future wars.`;
  document.getElementById('alliance-offer-details').textContent =
    `${nation.name} military: ${Math.round(nation.effectiveMilitaryStrength())} | Your relations: ${player.relationWith(nationId)}`;
  showModal('alliance-modal');
}

function wireAllianceHandlers() {
  document.getElementById('btn-accept-alliance').addEventListener('click', () => {
    if (!allianceOfferNationId) return;
    const nation = World.get(allianceOfferNationId);
    const result = Diplomacy.acceptAllianceOffer(allianceOfferNationId, World.playerId);
    hideModal('alliance-modal');
    if (result.accepted) {
      playSound('alliance');
      logEvent(`Accepted an alliance with ${nation.name}.`, true);
      if (App.selectedNationId === allianceOfferNationId) renderDiplomacyPanel(allianceOfferNationId);
    } else {
      logEvent(`${nation.name} declined the alliance.`, true);
    }
    allianceOfferNationId = null;
  });
  document.getElementById('btn-decline-alliance').addEventListener('click', () => {
    if (allianceOfferNationId) {
      Diplomacy.declineAllianceOffer(allianceOfferNationId, World.playerId);
      logEvent(`Declined an alliance with ${World.get(allianceOfferNationId).name}.`);
    }
    allianceOfferNationId = null;
    hideModal('alliance-modal');
  });
}

/* ---------------------------------------------------------------------------
   Country select modal
   --------------------------------------------------------------------------- */
let selectedForStart = null;

function openSelectModal() {
  selectedForStart = null;
  document.getElementById('btn-start-game').disabled = true;
  document.getElementById('select-info-pane').innerHTML =
    '<div class="select-info-placeholder">Select a nation from the list to preview it here.</div>';
  renderCountryList('');
  showModal('select-modal');
  document.getElementById('country-search').value = '';
  document.getElementById('country-search').focus();
}

function renderCountryList(filterText) {
  const listEl = document.getElementById('country-list');
  listEl.innerHTML = '';
  const filter = filterText.trim().toLowerCase();

  const nations = World.allNations()
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .filter(n => n.displayName.toLowerCase().includes(filter));

  nations.forEach(n => {
    const row = document.createElement('div');
    row.className = 'country-row';
    row.dataset.id = n.id;
    row.innerHTML = `
      <img class="country-row-flag" src="${flagSrc(n)}" alt="" loading="lazy">
      <span class="country-row-name">${n.displayName}</span>
    `;
    row.addEventListener('click', () => selectCountryForStart(n.id));
    listEl.appendChild(row);
  });
}

function selectCountryForStart(id) {
  selectedForStart = id;
  document.querySelectorAll('.country-row').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  const n = World.get(id);
  const pane = document.getElementById('select-info-pane');
  pane.innerHTML = `
    <img class="select-info-flag" src="${flagSrc(n)}" alt="">
    <h3>${n.displayName}</h3>
    <div class="select-info-stats">
      <div><span>Continent</span><strong>${n.continent}</strong></div>
      <div><span>Population</span><strong>${formatNumber(n.population)}</strong></div>
      <div><span>GDP</span><strong>$${formatNumber(n.gdp)}M</strong></div>
      <div><span>Treasury</span><strong>$${formatNumber(Math.round(n.treasury))}M</strong></div>
      <div><span>Stability</span><strong>${Math.round(n.stability)}%</strong></div>
      <div><span>Military Strength</span><strong>${Math.round(n.militaryStrength)}</strong></div>
    </div>
  `;
  document.getElementById('btn-start-game').disabled = false;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'country-search') renderCountryList(e.target.value);
});

document.addEventListener('click', (e) => {
  if (e.target.id === 'btn-start-game' && selectedForStart) {
    startGame(selectedForStart);
  }
});

/* ---------------------------------------------------------------------------
   Starting the game
   --------------------------------------------------------------------------- */
function startGame(playerId) {
  World.playerId = playerId;
  World.time = 0;
  World.running = true;
  BackgroundMusic.unlocked = true;
  BackgroundMusic.startGame();

  hideModal('select-modal');
  document.getElementById('main-menu').classList.add('hidden');
  document.getElementById('game-root').classList.remove('hidden');

  buildMainMap();
  flyToNation(playerId, 5, 2600);
  updateHud();
  renderDecisionsPanel();
  renderEconomyPanel();
  renderFocusPanel();
  renderGovernmentPanel();
  startTicking();
}

/* Animated camera: smoothly pans and zooms the map onto a nation. */
function flyToNation(nationId, scale = 5, duration = 2400) {
  if (!App.svg || !App.zoomBehavior || !nationId) return;
  const feature = App.featureById.get(nationId);
  if (!feature) return;
  const c = App.path.centroid(feature);
  if (!c || isNaN(c[0]) || isNaN(c[1])) return;
  const W = 1600, H = 900;
  const k = Math.max(1.5, Math.min(10, scale));
  const t = d3.zoomIdentity.translate(W / 2 - k * c[0], H / 2 - k * c[1]).scale(k);
  App.svg.transition().duration(duration).call(App.zoomBehavior.transform, t);
}

/* ---------------------------------------------------------------------------
   Main map rendering
   --------------------------------------------------------------------------- */
function buildMainMap() {
  const container = document.getElementById('map-container');
  const width = container.clientWidth || 1600;
  const height = container.clientHeight || 900;

  App.svg = d3.select('#map-svg')
    .attr('viewBox', '0 0 1600 900')
    .attr('preserveAspectRatio', 'xMidYMid meet');

  App.svg.selectAll('*').remove();

  const mapDefs = App.svg.append('defs').attr('id', 'map-decor-defs');
  buildMapDecorDefs(mapDefs);

  const root = App.svg.append('g').attr('id', 'zoom-root');

  root.append('rect')
    .attr('class', 'map-decor map-ocean-bg')
    .attr('x', -400).attr('y', -400).attr('width', 2400).attr('height', 1700)
    .attr('fill', 'url(#ocean-gradient)');

  root.append('rect')
    .attr('class', 'map-decor map-ocean-grain')
    .attr('x', -400).attr('y', -400).attr('width', 2400).attr('height', 1700)
    .attr('fill', 'url(#grain-pattern)')
    .style('mix-blend-mode', 'overlay')
    .style('pointer-events', 'none');

  App.mapGroup = root.append('g').attr('id', 'country-layer');
  App.labelGroup = root.append('g').attr('id', 'label-layer');
  App.arrowGroup = root.append('g').attr('id', 'arrow-layer');

  const features = Array.from(App.featureById.values());

  App.mapGroup.selectAll('path')
    .data(features, f => f.properties.ID)
    .join('path')
    .attr('class', 'country-path')
    .attr('d', App.path)
    .attr('fill', f => World.get(f.properties.ID).color)
    .attr('data-id', f => f.properties.ID)
    .on('click', (event, f) => onCountryClicked(f.properties.ID))
    .on('mouseenter', (event, f) => onCountryHover(f.properties.ID, true))
    .on('mouseleave', (event, f) => onCountryHover(f.properties.ID, false));

  renderNameplates();
  syncTerritoryStyles();

  App.zoomBehavior = d3.zoom()
    .scaleExtent([1, 10])
    .on('zoom', (event) => {
      App.currentTransform = event.transform;
      root.attr('transform', event.transform);
      document.documentElement.style.setProperty('--map-zoom', event.transform.k);
      updateLabelScale(event.transform.k);
      if (typeof Simulator !== 'undefined' && Simulator.active) Simulator._draw();
    });

  App.svg.call(App.zoomBehavior);
  applyMapDecorationState();
  buildClouds(root);
}

/* ---------------------------------------------------------------------------
   Map-space clouds — clouds.png instances rendered inside #zoom-root (so
   they pan/zoom with the map, moving across the map rather than the screen)
   and drifted horizontally by a light rAF loop.
   --------------------------------------------------------------------------- */
const CLOUD_IMG = './clouds.png';
const CLOUD_RATIO_HW = 4491 / 8000; // source texture aspect
const CLOUD_X_RANGE = [-400, 2000];
const CLOUD_Y_RANGE = [-160, 1000];

let _clouds = [];
let _cloudRaf = null;

function randIn([lo, hi]) { return lo + Math.random() * (hi - lo); }

function buildClouds(root) {
  stopCloudAnim();
  _clouds = [];
  root.selectAll('g#cloud-layer').remove();

  const spec = [
    { w: 540, y: 0.18, speed: 24, op: 0.16 },
    { w: 360, y: 0.40, speed: 32, op: 0.13 },
    { w: 660, y: 0.62, speed: 17, op: 0.15 },
    { w: 430, y: 0.80, speed: 28, op: 0.12 },
    { w: 580, y: 0.30, speed: 21, op: 0.14 },
    { w: 470, y: 0.90, speed: 26, op: 0.11 }
  ];

  const layer = root.append('g').attr('id', 'cloud-layer').attr('class', 'cloud-layer');
  const [minY, maxY] = CLOUD_Y_RANGE;

  spec.forEach((s, idx) => {
    const h = Math.round(s.w * CLOUD_RATIO_HW);
    const el = layer.append('image')
      .attr('class', 'cloud-map')
      .attr('href', CLOUD_IMG)
      .attr('width', s.w)
      .attr('height', h)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('opacity', s.op * (0.7 + Math.random() * 0.6));
    _clouds.push({
      el,
      w: s.w,
      h,
      y: minY + s.y * (maxY - minY),
      speed: s.speed * (0.75 + Math.random() * 0.5),
      x: randIn([CLOUD_X_RANGE[0] - s.w, CLOUD_X_RANGE[1]])
    });
    _clouds[idx].el.attr('transform', `translate(${_clouds[idx].x.toFixed(1)} ${_clouds[idx].y})`);
  });

  startCloudAnim();
}

function startCloudAnim() {
  stopCloudAnim();
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const c of _clouds) {
      c.x += c.speed * dt;
      if (c.x > CLOUD_X_RANGE[1] + c.w) c.x = CLOUD_X_RANGE[0] - c.w;
      c.el.attr('transform', `translate(${c.x.toFixed(1)} ${c.y})`);
    }
    _cloudRaf = requestAnimationFrame(step);
  };
  _cloudRaf = requestAnimationFrame(step);
}

function stopCloudAnim() {
  if (_cloudRaf) { cancelAnimationFrame(_cloudRaf); _cloudRaf = null; }
}

function buildMapDecorDefs(defs) {
  // Ocean gradient beneath the landmasses
  const ocean = defs.append('radialGradient')
    .attr('id', 'ocean-gradient').attr('cx', '50%').attr('cy', '38%').attr('r', '75%');
  ocean.append('stop').attr('offset', '0%').attr('stop-color', '#17466d');
  ocean.append('stop').attr('offset', '55%').attr('stop-color', '#0c2f50');
  ocean.append('stop').attr('offset', '100%').attr('stop-color', '#061a31');

  // Fine noise/grain, tiled as a pattern
  const grainFilter = defs.append('filter').attr('id', 'grain-filter');
  grainFilter.append('feTurbulence')
    .attr('type', 'fractalNoise').attr('baseFrequency', '0.9').attr('numOctaves', '2')
    .attr('stitchTiles', 'stitch').attr('result', 'noise');
  grainFilter.append('feColorMatrix')
    .attr('in', 'noise').attr('type', 'matrix')
    .attr('values', '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0');

  defs.append('pattern')
    .attr('id', 'grain-pattern').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 2400).attr('height', 1700)
    .append('rect').attr('width', 2400).attr('height', 1700).attr('filter', 'url(#grain-filter)');

  // Edge vignette, fixed to the viewport (sits outside zoom-root)
  const vignette = defs.append('radialGradient')
    .attr('id', 'vignette-gradient').attr('cx', '50%').attr('cy', '48%').attr('r', '75%');
  vignette.append('stop').attr('offset', '60%').attr('stop-color', '#000000').attr('stop-opacity', 0);
  vignette.append('stop').attr('offset', '100%').attr('stop-color', '#000000').attr('stop-opacity', 0.55);

  // Subtle relief "shader" — bevels landmasses using their own silhouette as a bump map
  const land = defs.append('filter')
    .attr('id', 'land-shading').attr('x', '-20%').attr('y', '-20%').attr('width', '140%').attr('height', '140%');
  land.append('feGaussianBlur').attr('in', 'SourceAlpha').attr('stdDeviation', '1.1').attr('result', 'blur');
  const spec = land.append('feSpecularLighting')
    .attr('in', 'blur').attr('surfaceScale', '2').attr('specularConstant', '0.55')
    .attr('specularExponent', '12').attr('lighting-color', '#dbe9f5').attr('result', 'spec');
  spec.append('feDistantLight').attr('azimuth', '225').attr('elevation', '58');
  land.append('feComposite')
    .attr('in', 'spec').attr('in2', 'SourceAlpha').attr('operator', 'in').attr('result', 'specClipped');
  land.append('feComposite')
    .attr('in', 'SourceGraphic').attr('in2', 'specClipped')
    .attr('operator', 'arithmetic').attr('k1', '0').attr('k2', '1').attr('k3', '1').attr('k4', '0');
}

function applyMapDecorationState() {
  if (!App.svg) return;
  App.svg.selectAll('.map-decor').style('display', App.showMapDecorations ? null : 'none');
  if (App.mapGroup) App.mapGroup.attr('filter', App.showMapDecorations ? 'url(#land-shading)' : null);
}

function renderNameplates() {
  const features = Array.from(App.featureById.values());
  App.labelGroup.selectAll('g.nameplate')
    .data(features, f => f.properties.ID)
    .join('g')
    .attr('class', 'nameplate')
    .attr('data-id', f => f.properties.ID)
    .attr('transform', f => {
      const c = f.properties.ADMIN === 'France'
        ? App.projection([2.2, 46.5])
        : App.centroidById.get(f.properties.ID);
      return `translate(${c[0]},${c[1]})`;
    })
    .each(function(f) {
      const g = d3.select(this);
      g.selectAll('*').remove();
      const n = World.get(f.properties.ID);

      const text = g.append('text')
        .attr('class', 'nameplate-text')
        .attr('x', 14)
        .attr('y', 0)
        .attr('dominant-baseline', 'middle')
        .text(n.displayName);

      const bbox = text.node().getBBox();
      const padding = { x: 6, y: 3 };

      g.insert('rect', 'text')
        .attr('class', 'nameplate-bg')
        .attr('x', -22 - padding.x)
        .attr('y', bbox.y - padding.y)
        .attr('width', bbox.width + 36 + padding.x * 2)
        .attr('height', Math.max(16, bbox.height) + padding.y * 2)
        .attr('rx', 3);

      g.append('image')
        .attr('class', 'nameplate-flag')
        .attr('href', flagSrc(n))
          .attr('x', -18).attr('y', -6).attr('width', 14).attr('height', 10)
          .attr('preserveAspectRatio', 'xMidYMid meet');
    });

  updateLabelScale(1);
}

function updateLabelScale(k) {
  const majorThreshold = 900;
  App.labelGroup.selectAll('g.nameplate').each(function(f) {
    const id = f.properties.ID;
    const area = App.areaById.get(id) * k * k;
    const isPlayer = id === World.playerId;
    const isSelected = id === App.selectedNationId;
    const visible = App.showNameplates && (
      isPlayer || isSelected ||
      area > majorThreshold ||
      (App.showMinorNameplates && area > 40)
    );
    d3.select(this)
      .style('display', visible ? null : 'none')
      .attr('transform', () => {
        const c = f.properties.ADMIN === 'France'
          ? App.projection([2.2, 46.5])
          : App.centroidById.get(id);
        return `translate(${c[0]},${c[1]}) scale(${1 / k})`;
      });
  });
}

function onCountryHover(id, entering) {
  App.hoverNationId = entering ? id : null;
  const tooltip = document.getElementById('map-tooltip');
  if (!entering) { tooltip.classList.add('hidden'); return; }
  const n = World.get(id);
  tooltip.innerHTML = `<strong>${n.displayName}</strong>${n.isColony && !n.isUnifiedTerritory ? ' <span class="tooltip-colony">(colony)</span>' : ''}`;
  tooltip.classList.remove('hidden');
}

document.getElementById('map-container').addEventListener('mousemove', (e) => {
  const tooltip = document.getElementById('map-tooltip');
  if (tooltip.classList.contains('hidden')) return;
  const rect = e.currentTarget.getBoundingClientRect();
  tooltip.style.left = (e.clientX - rect.left + 16) + 'px';
  tooltip.style.top = (e.clientY - rect.top + 8) + 'px';
});

function refreshMapColors() {
  App.mapGroup.selectAll('path.country-path')
    .attr('fill', f => World.get(f.properties.ID).color);
  App.labelGroup.selectAll('g.nameplate').each(function(f) {
    const nation = World.get(f.properties.ID);
    d3.select(this).select('text.nameplate-text').text(nation.displayName);
    d3.select(this).select('image.nameplate-flag')
      .attr('href', flagSrc(nation));
  });
  syncTerritoryStyles();
}

function syncTerritoryStyles() {
  if (!App.mapGroup || !World.playerId) return;
  const player = World.get(World.playerId);
  if (!player) return;

  App.mapGroup.selectAll('path.country-path')
    .classed('player-territory', f => f.properties.ID === World.playerId)
    .classed('allied-territory', f => player.isAlliedWith(f.properties.ID))
    .classed('enemy-territory', f => player.isAtWarWith(f.properties.ID))
    .classed('occupied-territory', f => {
      const nation = World.get(f.properties.ID);
      return nation?.isColony === true && !nation.isUnifiedTerritory;
    });
}

/* ---------------------------------------------------------------------------
   Country click -> diplomacy / detail panel
   --------------------------------------------------------------------------- */
function onCountryClicked(id) {
  App.selectedNationId = id;
  App.mapGroup.selectAll('path.country-path').classed('selected', f => f.properties.ID === id);
  syncTerritoryStyles();
  updateLabelScale(App.currentTransform ? App.currentTransform.k : 1);

  const diplomacyBtn = document.getElementById('top-nav-diplomacy');
  diplomacyBtn.disabled = false;
  renderDiplomacyPanel(id);
  openPanelModal('panel-diplomacy');
}

function renderDiplomacyPanel(id) {
  document.getElementById('dip-tooltip')?.classList.add('hidden');
  const container = document.getElementById('diplomacy-content');
  const n = World.get(id);
  const player = World.get(World.playerId);
  const isSelf = id === World.playerId;

  let html = `
    <div class="dip-header">
      <img class="dip-flag" src="${flagSrc(n)}" alt="">
      <div>
        <h3>${n.displayName}${n.isColony && !n.isUnifiedTerritory ? ' <span class="tag-colony">Colony</span>' : ''}</h3>
        <div class="dip-sub"><span class="dip-region-pill">${n.continent}</span>${n.subregion ? `<span class="dip-region-pill">${n.subregion}</span>` : ''}</div>
      </div>
    </div>
    <div class="dip-stats">
      <div><span>Population</span><strong>${formatNumber(n.population)}</strong></div>
      <div><span>Treasury</span><strong>$${formatNumber(Math.round(n.treasury))}M</strong></div>
      <div><span>Stability</span><strong>${Math.round(n.stability)}%</strong></div>
      <div><span>Military Strength</span><strong>${Math.round(n.effectiveMilitaryStrength())}</strong></div>
  `;
  if (n.isColony) {
    const colonizer = World.get(n.colonizerId);
    html += `<div><span>Colonizer</span><strong>${colonizer ? colonizer.name : 'Unknown'}</strong></div>`;
  }
  if (!isSelf) {
    html += `<div><span>Relations with You</span><strong>${player.relationWith(id)}</strong></div>`;
  }
  html += `</div>`;

  if (!isSelf) {
    const atWar = player.isAtWarWith(id);
    const inTruce = player.isInTruceWith(id, World.turn);
    const allied = player.isAlliedWith(id);

    html += `<div class="dip-actions">`;
    html += diplomacyButton('Declare War', 'action-war', Diplomacy.canDeclareWar(World.playerId, id) && !inTruce,
      declareWarDisabledReason(id, atWar, inTruce));
    html += diplomacyButton('Request Peace', 'action-peace', Diplomacy.canRequestPeace(World.playerId, id), atWar ? '' : 'Not at war');
    html += diplomacyButton('Send Economic Funds', 'action-funds', Diplomacy.canSendFunds(World.playerId, id) && !atWar, atWar ? 'At war' : '');
    html += diplomacyButton('Improve Relations', 'action-relations', Diplomacy.canImproveRelations(World.playerId, id) && !atWar, atWar ? 'At war' : '');
    const allianceReady = Diplomacy.canAlly(World.playerId, id) && !atWar;
    const allianceCooldown = player.allianceCooldowns[id] || 0;
    html += diplomacyButton(allied ? 'Allied' : 'Ally', 'action-ally', allianceReady,
      atWar ? 'At war' : (allied ? 'Already allied' : allianceCooldown > World.time ? 'Diplomats need time before another request' : ''));
    html += `</div>`;
  } else {
    html += `<div class="dip-note">This is your nation.</div>`;
  }

  container.innerHTML = html;

  if (!isSelf) {
    container.querySelector('[data-action="action-war"]')?.addEventListener('click', () => {
      if (Diplomacy.declareWar(World.playerId, id)) {
        syncAllWarArrows();
        playSound('waralert');
        logEvent(`You declared war on ${n.name}.`);
        renderDiplomacyPanel(id);
        if (typeof PlayerBattle !== 'undefined') PlayerBattle.launch(World.playerId, id);
      }
    });
    container.querySelector('[data-action="action-peace"]')?.addEventListener('click', () => {
      if (Diplomacy.requestPeace(World.playerId, id)) {
        syncAllWarArrows();
        logEvent(`Peace reached with ${n.name}.`, true);
        renderDiplomacyPanel(id);
      }
    });
    container.querySelector('[data-action="action-funds"]')?.addEventListener('click', () => {
      const amount = Math.round(player.treasury * 0.1);
      if (Diplomacy.sendFunds(World.playerId, id, amount)) {
        logEvent(`Sent $${formatNumber(amount)}M to ${n.name}.`, true);
        renderDiplomacyPanel(id);
        updateHud();
      }
    });
    container.querySelector('[data-action="action-relations"]')?.addEventListener('click', () => {
      if (Diplomacy.improveRelations(World.playerId, id)) {
        logEvent(`Improved relations with ${n.name}.`, true);
        renderDiplomacyPanel(id);
      }
    });
    container.querySelector('[data-action="action-ally"]')?.addEventListener('click', () => {
      const result = Diplomacy.requestAlliance(World.playerId, id);
      if (result.accepted) {
        playSound('alliance');
        logEvent(`Formed an alliance with ${n.name}.`, true);
        renderDiplomacyPanel(id);
      } else {
        logEvent(result.reason || `${n.name} declined the alliance.`, true);
        renderDiplomacyPanel(id);
      }
    });
  }
}

function diplomacyButton(label, action, enabled, disabledReason) {
  if (enabled) return `<button class="dip-btn" data-action="${action}">${label}</button>`;
  // Not using native `disabled` — disabled form controls don't reliably
  // fire hover events across browsers, and we need the tooltip to follow
  // the cursor. The button is inert anyway: every Diplomacy.* action
  // safety-checks itself, so a stray click here is a harmless no-op.
  const tip = disabledReason ? ` data-tooltip="${disabledReason.replace(/"/g, '&quot;')}"` : '';
  return `<button class="dip-btn dip-btn-disabled" data-action="${action}" aria-disabled="true" style="opacity:0.45;cursor:not-allowed;filter:grayscale(60%);"${tip}>${label}</button>`;
}

/* Reason shown on Declare War when geography (not war/truce state) blocks it. */
function declareWarDisabledReason(targetId, atWar, inTruce) {
  if (inTruce) return 'Truce in effect';
  if (atWar) return 'Already at war';
  const reason = Diplomacy.warReachabilityReason(World.playerId, targetId);
  if (reason === 'attacker-landlocked') return "Your a Landlocked Country! try to Declare war on your neigbor that has a coast!";
  if (reason === 'defender-landlocked') return 'This country is Landlocked! must be bordering this country!';
  if (reason === 'too-far') return 'This nation is too far away - you must share a border or a coastline connection.';
  return '';
}

/* Cursor-following tooltip for disabled diplomacy buttons. Fixed-position
   so it works regardless of where the panel sits on screen. */
function wireDipTooltip() {
  const content = document.getElementById('diplomacy-content');
  const tooltip = document.getElementById('dip-tooltip');
  if (!content || !tooltip) return;
  tooltip.style.position = 'fixed';
  tooltip.style.zIndex = '10000';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.transform = 'translate(-50%, -100%)'; // anchor by its bottom-center

  const positionTooltip = (e) => {
    tooltip.style.left = e.clientX + 'px';
    tooltip.style.top = (e.clientY - 12) + 'px'; // sits above the cursor
  };

  content.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el) return;
    tooltip.textContent = el.dataset.tooltip;
    positionTooltip(e);
    tooltip.classList.remove('hidden');
  });
  content.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (!el || el.contains(e.relatedTarget)) return;
    tooltip.classList.add('hidden');
  });
  content.addEventListener('mousemove', (e) => {
    if (tooltip.classList.contains('hidden')) return;
    positionTooltip(e);
  });
}

/* ---------------------------------------------------------------------------
   War arrows
   --------------------------------------------------------------------------- */
function warArrowId(a, b) { return `arrow-${World.warKey(a, b)}`; }

function addWarArrow(attackerId, defenderId) {
  const from = App.centroidById.get(attackerId);
  const to = App.centroidById.get(defenderId);
  if (!from || !to) return;

  ensureArrowMarker();

  const id = warArrowId(attackerId, defenderId);
  if (document.getElementById(id)) return;

  const mid = midpointWithCurve(from, to);
  const d = `M${from[0]},${from[1]} Q${mid[0]},${mid[1]} ${to[0]},${to[1]}`;

  App.arrowGroup.append('path')
    .attr('id', id)
    .attr('class', 'war-arrow')
    .attr('d', d)
    .attr('marker-end', 'url(#arrowhead)');
}

function removeWarArrow(a, b) {
  const id = warArrowId(a, b);
  const el = document.getElementById(id);
  if (el) el.remove();
}

function midpointWithCurve(from, to) {
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  const curve = Math.min(80, dist * 0.25);
  return [mx - dy / (dist || 1) * curve, my + dx / (dist || 1) * curve];
}

function ensureArrowMarker() {
  if (document.getElementById('arrowhead')) return;
  const defs = App.svg.append('defs');
  defs.append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 0 10 10')
    .attr('refX', 8).attr('refY', 5)
    .attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto-start-reverse')
    .append('path')
    .attr('d', 'M0,0 L10,5 L0,10 Z')
    .attr('fill', 'var(--war-red)');
}

function syncAllWarArrows() {
  App.arrowGroup.selectAll('*').remove();
  document.getElementById('arrowhead')?.remove();
  const atWarIds = new Set();
  World.wars.forEach(war => {
    addWarArrow(war.attacker, war.defender);
    atWarIds.add(war.attacker);
    atWarIds.add(war.defender);
  });
  App.mapGroup.selectAll('path.country-path').classed('at-war', f => atWarIds.has(f.properties.ID));
  syncTerritoryStyles();
}

/* ---------------------------------------------------------------------------
   Decisions panel
   --------------------------------------------------------------------------- */
const DECISIONS = [
  { id: 'raise_taxes', name: 'Raise Emergency Taxes', desc: 'Immediate treasury boost at the cost of public support.',
    cooldown: 10, apply: n => { n.treasury += n.gdp * 0.04; n.stability -= 6; shiftIdeology(n, { economy: -3, authority: -3 }); } },
  { id: 'national_celebration', name: 'National Celebration', desc: 'Boosts morale and stability at some cost to the treasury.',
    cooldown: 10, apply: n => { n.stability = Math.min(100, n.stability + 8); n.treasury -= n.gdp * 0.01; shiftIdeology(n, { authority: 2 }); } },
  { id: 'mobilize_reserves', name: 'Mobilize Reserves', desc: 'Temporarily strengthens the military, unsettling the population.',
    cooldown: 14, apply: n => { n.militaryStrength = Math.round(n.militaryStrength * 1.12); n.stability -= 5; shiftIdeology(n, { authority: -3, culture: -2 }); } },
  { id: 'conscription_reform', name: 'Conscription Reform', desc: 'Expands the available manpower pool.',
    cooldown: 16, apply: n => { n.manpower = Math.round(n.manpower * 1.15); shiftIdeology(n, { culture: -3 }); } }
];

const FORMABLES = [
  {
    id: 'soviet_union', name: 'Soviet Union', founder: 'RUS',
    members: ['RUS', 'ARM', 'AZE', 'BLR', 'EST', 'GEO', 'KAZ', 'KGZ', 'LVA', 'LTU', 'MDA', 'TJK', 'TKM', 'UKR', 'UZB'],
    flag: 'formables/SovietUnion.svg', desc: 'The Great Plan to Unite the Russian Federation and its former Soviet republics under one banner.'
  },
  {
    id: 'benelux', name: 'Benelux', founder: 'NLD', members: ['NLD', 'BEL', 'LUX'],
    flag: 'formables/Benelux.svg', desc: 'Unify the Economic and Political Union of Belgium, the Netherlands, and Luxembourg.'
  },
  {
    id: 'japanese_empire', name: 'Japanese Empire', founder: 'JPN', members: ['JPN', 'PRK', 'KOR','TW'],
    flag: 'formables/JapaneseEmpire.svg', desc: 'Bring Japan and both Koreas under one imperial banner.'
  },
  {
    id: 'yugoslavia', name: 'Yugoslavia', founder: 'SRB', members: ['SRB', 'HRV', 'BIH', 'MNE', 'MKD', 'SVN', 'KOS'],
    flag: 'formables/Yugoslavia.svg', desc: 'Reunite the South Slavic nations into Yugoslavia.'
  },
  {
    id: 'maphilindo', name: 'Maphilindo', founder: 'PHL', members: ['PHL', 'IDN', 'MYS'],
    flag: 'formables/Maphilindo.png', desc: 'Unite the Philippines, Indonesia, and Malaysia.'
  },
  {
    id: 'korean_empire', name: 'Korean Empire', founder: 'PRK', members: ['PRK', 'KOR'],
    flag: 'formables/KoreanEmpire.svg', desc: 'Unify North Korea and South Korea into one empire.'
  }
];

function flagSrc(nation) {
  return `./flags/${nation.flagPath || `${nation.flagIso2}.png`}`;
}

function formableProgress(formable, nation) {
  const controlled = formable.members.filter(id => {
    const member = World.get(id);
    return member && (id === nation.id || member.colonizerId === nation.id);
  }).length;
  return { controlled, total: formable.members.length, percent: Math.round(controlled / formable.members.length * 100) };
}

function canFormable(formable, nation) {
  return nation && nation.id === formable.founder &&
    !nation.formedFormables.has(formable.id) && formableProgress(formable, nation).percent === 100;
}

function formCountry(formable, nation) {
  if (!canFormable(formable, nation)) return false;
  formable.members.forEach(id => {
    const member = World.get(id);
    if (!member) return;
    if (member.colonizerId && member.colonizerId !== nation.id) {
      World.get(member.colonizerId)?.colonies.delete(id);
    }
    member.isColony = id !== nation.id;
    member.isUnifiedTerritory = id !== nation.id;
    member.colonizerId = id === nation.id ? null : nation.id;
    member.color = nation.color;
    member.flagPath = formable.flag;
    member.displayName = formable.name;
    if (id !== nation.id) nation.colonies.add(id);
  });
  nation.displayName = formable.name;
  nation.flagPath = formable.flag;
  nation.formedFormables.add(formable.id);
  return true;
}

function renderDecisionsPanel() {
  const list = document.getElementById('decisions-list');
  list.innerHTML = '';
  const player = World.get(World.playerId);

  DECISIONS.forEach(dec => {
    const cd = player.decisionCooldowns[dec.id] || 0;
    const ready = cd <= World.time;
    const row = document.createElement('div');
    row.className = 'decision-card';
    row.innerHTML = `
      <div class="decision-card-main">
        <h4>${dec.name}</h4>
        <p>${dec.desc}</p>
      </div>
      <button class="dip-btn" ${ready ? '' : 'disabled'}>${ready ? 'Enact' : `Ready in ${Math.ceil((cd - World.time) / 1000)}s`}</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      dec.apply(player);
      player.decisionCooldowns[dec.id] = World.time + dec.cooldown * TICK_MS;
      logEvent(`Enacted: ${dec.name}.`, true);
      renderDecisionsPanel();
      updateHud();
    });
    list.appendChild(row);
  });

  const formablesSection = document.createElement('section');
  formablesSection.className = 'formables-section';
  formablesSection.innerHTML = '<h3>Formables</h3><div class="formables-list"></div>';
  const formablesList = formablesSection.querySelector('.formables-list');
  FORMABLES.filter(formable => formable.founder === player.id).forEach(formable => {
    const progress = formableProgress(formable, player);
    const formed = player.formedFormables.has(formable.id);
    const annexes = formable.members
      .filter(id => id !== formable.founder)
      .map(id => World.get(id)?.name || id)
      .join(', ');
    const card = document.createElement('article');
    card.className = `formable-card${formed ? ' formed' : ''}`;
    card.innerHTML = `
      <div class="formable-heading">
        <img src="./flags/${formable.flag}" alt="">
        <div><h4>${formable.name}</h4><p>${formable.desc}</p></div>
      </div>
      <div class="formable-annexes"><strong>Annexes:</strong> ${annexes}</div>
      <div class="formable-progress-row"><span>Territory</span><strong>${progress.controlled}/${progress.total}</strong></div>
      <div class="formable-progress"><span style="width: ${progress.percent}%"></span></div>
      <button class="dip-btn formable-button" ${formed || progress.percent < 100 ? 'disabled' : ''}>${formed ? 'Formed' : progress.percent === 100 ? `Form ${formable.name}` : 'Control all required territory'}</button>
    `;
    card.querySelector('button').addEventListener('click', () => {
      if (!formCountry(formable, player)) return;
      playSound('alliance');
      logEvent(`${formable.name} has been formed. Its required territories are unified.`, true);
      refreshMapColors();
      updateHud();
      renderDecisionsPanel();
      if (App.selectedNationId) renderDiplomacyPanel(App.selectedNationId);
    });
    formablesList.appendChild(card);
  });
  list.appendChild(formablesSection);
}

/* ---------------------------------------------------------------------------
   Economy panel
   --------------------------------------------------------------------------- */
function renderEconomyPanel() {
  const player = World.get(World.playerId);
  const grid = document.getElementById('economy-grid');
  grid.innerHTML = `
    <div><span>GDP</span><strong>$${formatNumber(player.gdp)}M</strong></div>
    <div><span>Treasury</span><strong>$${formatNumber(Math.round(player.treasury))}M</strong></div>
    <div><span>Income / Turn</span><strong>$${player.incomePerTurn().toFixed(1)}M</strong></div>
    <div><span>Manpower</span><strong>${formatNumber(player.manpower)}</strong></div>
  `;
  const taxInput = document.getElementById('tax-rate');
  taxInput.value = Math.round(player.taxRate * 100);
  document.getElementById('tax-rate-label').textContent = Math.round(player.taxRate * 100) + '%';
}

document.getElementById('tax-rate').addEventListener('input', (e) => {
  const player = World.get(World.playerId);
  if (!player) return;
  player.taxRate = Number(e.target.value) / 100;
  document.getElementById('tax-rate-label').textContent = e.target.value + '%';
});

/* ---------------------------------------------------------------------------
   Political Focus Tree panel
   --------------------------------------------------------------------------- */
function renderFocusPanel() {
  const player = World.get(World.playerId);
  const container = document.getElementById('focus-tree');
  container.innerHTML = '';

  FocusTree.forEach(branch => {
    const col = document.createElement('div');
    col.className = 'focus-branch';
    col.innerHTML = `<h4>${branch.name}</h4>`;

    branch.nodes.forEach((node, idx) => {
      const done = player.completedFocuses.has(node.id);
      const prereqMet = idx === 0 || player.completedFocuses.has(branch.nodes[idx - 1].id);
      const isActive = player.activeFocus && player.activeFocus.id === node.id;
      const locked = !prereqMet && !done;
      const canStart = !done && !locked && !player.activeFocus && player.politicalPower >= node.cost;

      const nodeEl = document.createElement('div');
      nodeEl.className = 'focus-node' +
        (done ? ' completed' : '') +
        (isActive ? ' active' : '') +
        (locked ? ' locked' : '');
      nodeEl.innerHTML = `
        <div class="focus-node-name">${node.name}</div>
        <div class="focus-node-desc">${node.desc}</div>
        <div class="focus-node-meta">${done ? 'Completed' : isActive ? `In progress, ${Math.ceil(player.activeFocus.msRemaining / TICK_MS)} days left` : `${node.cost} political power, ${node.days} days to complete`}</div>
      `;
      if (canStart) {
        nodeEl.addEventListener('click', () => {
          if (beginFocus(player, node)) {
            playSound('focus');
            renderFocusPanel();
          }
        });
      }
      col.appendChild(nodeEl);
    });
    container.appendChild(col);
  });
}

/* ---------------------------------------------------------------------------
   Government panel
   --------------------------------------------------------------------------- */
const GOV_ACTION_COST = 25;
const GOV_ACTION_PUSH = 10;

const governmentActions = [
  { id: 'propaganda', name: 'Government Propaganda',
    desc: 'Steer public opinion toward the ruling party.', push: 'ruler' },
  { id: 'amnesty', name: 'Grant Amnesty',
    desc: 'Soften the regime into a more open, democratic character.', push: 'democratic' },
  { id: 'purge', name: 'Purge the Opposition',
    desc: 'Consolidate power into a more authoritarian character.', push: 'authoritarian' },
  { id: 'land_reform', name: 'Land & Industry Reform',
    desc: 'Move the economy toward a more socialist character.', push: 'socialist' },
  { id: 'privatize', name: 'Privatize', 
    desc: 'Move the economy toward a more free-market character.', push: 'capitalist' }
];

function renderGovernmentPanel() {
  const container = document.getElementById('government-content');
  const player = World.get(World.playerId);
  container.innerHTML = '';

  const ruler = rulingParty(player);
  const form = governmentForm(player);
  const parties = partySupport(player);

  const header = document.createElement('div');
  header.className = 'gov-header';
  header.style.setProperty('--gov-accent', ruler.party.color);
  header.innerHTML = `
    <div class="gov-form">${form}</div>
    <div class="gov-ruling"><span class="gov-party-dot" style="background:${ruler.party.color}"></span>
      Ruling Party: <strong>${ruler.party.name}</strong>
      <em>${ruler.percent}% support</em></div>
    <div class="gov-hint">Public approval steers stability; political power flows faster in authoritarian regimes.</div>
  `;

  // ideology meters
  const meters = document.createElement('div');
  meters.className = 'gov-meters';
  const meterDefs = [
    { key: 'economy', label: 'Economy', low: 'Socialist', high: 'Market' },
    { key: 'authority', label: 'Authority', low: 'Authoritarian', high: 'Democratic' },
    { key: 'culture', label: 'Culture', low: 'Nationalist', high: 'Internationalist' }
  ];
  meterDefs.forEach(m => {
    const val = player.ideology[m.key];
    meters.innerHTML += `
      <div class="gov-meter">
        <div class="gov-meter-labels"><span>${m.low}</span><strong>${m.label}</strong><span>${m.high}</span></div>
        <div class="gov-meter-bar">
          <span class="gov-meter-hi"></span><span class="gov-meter-fill" style="left:${val}%"></span>
        </div>
        <div class="gov-meter-value">${origAxisName(m.key)} ${val} / 100</div>
      </div>`;
  });

  // party landscape + pie chart
  const partyHeader = document.createElement('h3');
  partyHeader.textContent = 'Party Landscape';
  const landscape = document.createElement('div');
  landscape.className = 'gov-landscape';
  const pie = document.createElement('div');
  pie.className = 'gov-pie';
  pie.innerHTML = buildPartyPie(parties, ruler);
  const partiesEl = document.createElement('div');
  partiesEl.className = 'gov-parties';
  parties.forEach(({ party, percent }) => {
    const card = document.createElement('div');
    card.className = 'gov-party' + (party.id === ruler.party.id ? ' ruler' : '');
    card.innerHTML = `
      <div class="gov-party-row">
        <span class="gov-party-dot" style="background:${party.color}"></span>
        <span class="gov-party-name">${party.name}</span>
        <strong class="gov-party-pct">${percent}%</strong>
      </div>
      <div class="gov-party-bar"><span style="width:${percent}%;background:${party.color}"></span></div>`;
    card.appendChild(buildPartyBoostBtn(party, player));
    partiesEl.appendChild(card);
  });
  landscape.append(pie, partiesEl);

  // government actions
  const actionsHeader = document.createElement('h3');
  actionsHeader.textContent = 'Government Actions';
  const actionsEl = document.createElement('div');
  actionsEl.className = 'gov-actions';
  governmentActions.forEach(action => {
    const btn = document.createElement('button');
    btn.className = 'dip-btn gov-action-btn';
    btn.innerHTML = `<strong>${action.name}</strong><span>${action.desc}</span><em>${GOV_ACTION_COST} political power</em>`;
    btn.disabled = player.politicalPower < GOV_ACTION_COST;
    btn.addEventListener('click', () => {
      if (player.politicalPower < GOV_ACTION_COST) return;
      player.politicalPower -= GOV_ACTION_COST;
      playSound('focus');
      applyGovernmentAction(player, action);
      logEvent(`${action.name} enacted. The nation's politics shift.`, true);
      renderGovernmentPanel();
      updateHud();
    });
    actionsEl.appendChild(btn);
  });

  container.append(header, meters, partyHeader, landscape, actionsHeader, actionsEl);
}

/* Donut chart of party support share, centered on the ruling party. */
function buildPartyPie(parties, ruler) {
  const cx = 70, cy = 70, ro = 62, ri = 44;
  let a0 = -Math.PI / 2;
  let segments = '';
  parties.forEach(({ party, percent }) => {
    const sweep = (percent / 100) * Math.PI * 2;
    const a1 = a0 + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const ox0 = cx + ro * Math.cos(a0), oy0 = cy + ro * Math.sin(a0);
    const ox1 = cx + ro * Math.cos(a1), oy1 = cy + ro * Math.sin(a1);
    const ix1 = cx + ri * Math.cos(a1), iy1 = cy + ri * Math.sin(a1);
    const ix0 = cx + ri * Math.cos(a0), iy0 = cy + ri * Math.sin(a0);
    segments += `<path d="M${ox0.toFixed(2)},${oy0.toFixed(2)} A${ro},${ro} 0 ${large} 1 ${ox1.toFixed(2)},${oy1.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${ri},${ri} 0 ${large} 0 ${ix0.toFixed(2)},${iy0.toFixed(2)} Z" fill="${party.color}"></path>`;
    a0 = a1;
  });
  return `<svg viewBox="0 0 140 140" role="img" aria-label="Party support share">
    ${segments}
    <text x="70" y="67" text-anchor="middle" fill="${ruler.party.color}" style="font:700 13px 'IBM Plex Sans',sans-serif">${ruler.party.short}</text>
    <text x="70" y="81" text-anchor="middle" fill="#A8B2C4" style="font:400 11px 'IBM Plex Sans',sans-serif">${ruler.percent}%</text>
  </svg>`;
}

function applyGovernmentAction(nation, action) {
  const amount = GOV_ACTION_PUSH;
  if (action.push === 'ruler') {
    pushPartyBalance(nation, rulingParty(nation).party.id, amount * 1.6);
  } else if (action.push === 'democratic') {
    shiftIdeology(nation, { authority: amount });
  } else if (action.push === 'authoritarian') {
    shiftIdeology(nation, { authority: -amount });
  } else if (action.push === 'socialist') {
    shiftIdeology(nation, { economy: -amount, authority: -2 });
  } else if (action.push === 'capitalist') {
    shiftIdeology(nation, { economy: amount, authority: 2 });
  }
}

function buildPartyBoostBtn(party, player) {
  const wrapper = document.createElement('div');
  wrapper.className = 'gov-boost-row';
  const btn = document.createElement('button');
  btn.className = 'dip-btn gov-boost-btn';
  btn.textContent = 'Promote';
  btn.title = `Spend ${GOV_ACTION_COST} political power pushing the nation toward the ${party.name}.`;
  btn.disabled = player.politicalPower < GOV_ACTION_COST;
  btn.addEventListener('click', () => {
    if (player.politicalPower < GOV_ACTION_COST) return;
    player.politicalPower -= GOV_ACTION_COST;
    pushPartyBalance(player, party.id, GOV_ACTION_PUSH);
    playSound('focus');
    renderGovernmentPanel();
    updateHud();
  });
  wrapper.appendChild(btn);
  return wrapper;
}

function origAxisName(key) {
  return key[0].toUpperCase() + key.slice(1);
}

/* ---------------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------------- */
function wireTabHandlers() {
  document.querySelectorAll('.top-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      openPanelModal(btn.dataset.panel);
    });
  });

  document.getElementById('close-panel-modal').addEventListener('click', closePanelModal);
  document.getElementById('panel-modal').addEventListener('click', (event) => {
    if (event.target.id === 'panel-modal') closePanelModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanelModal();
  });
}

function openPanelModal(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const button = document.querySelector(`.top-nav-btn[data-panel="${panelId}"]`);
  if (button?.disabled) return;
  const modal = document.getElementById('panel-modal');
  clearTimeout(modal.closeTimer);
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === panelId));
  document.getElementById('panel-modal-title').textContent = button?.textContent || 'Panel';
  modal.classList.remove('hidden', 'closing');
}

function closePanelModal() {
  const modal = document.getElementById('panel-modal');
  if (modal.classList.contains('hidden') || modal.classList.contains('closing')) return;
  modal.classList.add('closing');
  modal.closeTimer = setTimeout(() => modal.classList.add('hidden'), 180);
}

/* ---------------------------------------------------------------------------
   Settings
   --------------------------------------------------------------------------- */
function wireSettingsHandlers() {
  document.getElementById('setting-speed').addEventListener('input', (e) => {
    World.speed = Number(e.target.value);
    document.getElementById('setting-speed-label').textContent = World.speed.toFixed(1) + 'x';
    restartTicking();
  });
  document.getElementById('setting-nameplates').addEventListener('change', (e) => {
    App.showNameplates = e.target.checked;
    updateLabelScale(App.currentTransform ? App.currentTransform.k : 1);
  });
  document.getElementById('setting-minor-nameplates').addEventListener('change', (e) => {
    App.showMinorNameplates = e.target.checked;
    updateLabelScale(App.currentTransform ? App.currentTransform.k : 1);
  });
  document.getElementById('setting-decorations').addEventListener('change', (e) => {
    App.showMapDecorations = e.target.checked;
    applyMapDecorationState();
  });
  wireSaveHandlers();
}

/* ---------------------------------------------------------------------------
   Save / load — export the whole live world as a base64 payload inside a
   .json file (top-right "Export" button in the game HUD), and import it
   back from Settings > Save (drag & drop or file picker). A recognised
   save is decoded, the entire world is reconstructed, and the game resumes
   automatically.
   --------------------------------------------------------------------------- */
function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64DecodeUnicode(str) {
  try { return decodeURIComponent(escape(atob(str))); }
  catch { return atob(str); }
}

function exportSaveFile() {
  const state = serializeWorldState();
  const payload = b64EncodeUnicode(JSON.stringify(state));
  const fileJson = JSON.stringify({ schema: SAVE_SCHEMA, payload });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const blob = new Blob([fileJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `battle-of-nations-save-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setSaveStatus('Save exported. A .json file was downloaded.', true);
}

function parseSaveFile(text) {
  let outer;
  try { outer = JSON.parse(text); } catch { return { error: 'This is not a valid .json file.' }; }
  if (!outer || outer.schema !== SAVE_SCHEMA || typeof outer.payload !== 'string') {
    return { error: 'This .json file is not a recognised Battle of Nations save.' };
  }
  let state;
  try { state = JSON.parse(b64DecodeUnicode(outer.payload)); }
  catch { return { error: 'The save file is corrupt or not encoded as base64.' }; }
  if (!state || state.schema !== SAVE_SCHEMA) {
    return { error: 'The save decoded, but it is missing valid game data.' };
  }
  return { state };
}

function importSaveFromText(text) {
  const result = parseSaveFile(text);
  if (result.error) { setSaveStatus(result.error, false); return; }
  askSaveLoad(result.state);
}

let _pendingSaveState = null;

function askSaveLoad(state) {
  _pendingSaveState = state;
  const savedAt = new Date(state.savedAt).toLocaleString();
  document.getElementById('confirm-save-text').textContent =
    `Load this save from ${savedAt}? This will replace the current game.`;
  showModal('confirm-save-modal');
}

function wireSaveConfirmHandlers() {
  const loadBtn = document.getElementById('btn-load-save');
  const cancelBtn = document.getElementById('btn-cancel-save');
  const closeBtn = document.getElementById('btn-close-confirm-save');
  const modal = document.getElementById('confirm-save-modal');

  const close = () => { hideModal('confirm-save-modal'); _pendingSaveState = null; };
  const doLoad = () => {
    const state = _pendingSaveState;
    close();
    if (state) startFromSave(state);
  };
  if (loadBtn) loadBtn.addEventListener('click', doLoad);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) { setSaveStatus('Import cancelled.', false); close(); } });
}

function startFromSave(state) {
  deserializeWorldState(state);
  if (loadedAdjacency) loadAdjacency(loadedAdjacency);
  BackgroundMusic.unlocked = true;
  BackgroundMusic.startGame();
  hideModal('settings-modal');
  document.getElementById('main-menu').classList.add('hidden');
  document.getElementById('game-root').classList.remove('hidden');
  buildMainMap();
  syncAllWarArrows();
  flyToNation(World.playerId, 5, 2400);
  updateHud();
  renderDecisionsPanel();
  renderEconomyPanel();
  renderFocusPanel();
  renderGovernmentPanel();
  World.running = true;
  startTicking();
  setSaveStatus(`Save loaded (${new Date(state.savedAt).toLocaleString()}). Game resumed.`, true);
  window.scrollTo(0, 0);
}

function setSaveStatus(message, ok) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('err', !ok);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 6000);
}

function wireSaveHandlers() {
  wireSaveConfirmHandlers();

  const exportBtn = document.getElementById('btn-export-save');
  if (exportBtn) exportBtn.addEventListener('click', exportSaveFile);

  const input = document.getElementById('save-file-input');
  const dropzone = document.getElementById('save-dropzone');
  const importBtn = document.getElementById('btn-import-save');
  if (importBtn) {
    importBtn.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  }

  const consumeFile = (file) => {
    if (!file) return;
    if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
      setSaveStatus('Only .json save files are accepted.', false);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => importSaveFromText(String(reader.result));
    reader.onerror = () => setSaveStatus('Could not read that file.', false);
    reader.readAsText(file);
  };

  if (input) input.addEventListener('change', () => { consumeFile(input.files[0]); input.value = ''; });

  if (dropzone) {
    ['dragenter', 'dragover'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));
    dropzone.addEventListener('drop', (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      consumeFile(file);
    });
  }
}

/* ---------------------------------------------------------------------------
   HUD
   --------------------------------------------------------------------------- */
function wireHudHandlers() {
  document.getElementById('btn-pause').addEventListener('click', () => {
    World.running = !World.running;
    document.getElementById('btn-pause').textContent = World.running ? '\u2759\u2759' : '\u25B6';
  });
}

function updateHud() {
  const player = World.get(World.playerId);
  if (!player) return;
  document.getElementById('hud-flag').innerHTML = `<img src="${flagSrc(player)}" alt="">`;
  document.getElementById('hud-name').textContent = player.name;
  document.getElementById('hud-treasury').textContent = '$' + formatNumber(Math.round(player.treasury)) + 'M';
  document.getElementById('hud-stability').textContent = Math.round(player.stability) + '%';
  document.getElementById('hud-military').textContent = Math.round(player.effectiveMilitaryStrength());
  document.getElementById('hud-pp').textContent = Math.round(player.politicalPower);
  document.getElementById('hud-turn-label').textContent = formatGameDate();
}

/* ---------------------------------------------------------------------------
   Event feed / notifications
   --------------------------------------------------------------------------- */
function logEvent(text, playerNotification = false) {
  const feed = document.getElementById('event-feed');
  const item = document.createElement('div');
  item.className = 'event-item';
  item.textContent = text;
  feed.prepend(item);
  while (feed.children.length > 6) feed.removeChild(feed.lastChild);
  setTimeout(() => item.classList.add('fading'), 6000);
  setTimeout(() => item.remove(), 7000);
  if (playerNotification) playSound('notification');
}

function onWarResolved(result) {
  const winner = World.get(result.winnerId);
  const loser = World.get(result.loserId);
  removeWarArrow(result.winnerId, result.loserId);
  refreshMapColors();
  logEvent(`${winner.name} has conquered ${loser.name}. ${loser.name} is now a colony.`);
  if (result.freed.length) {
    const names = result.freed.map(id => World.get(id)?.name).filter(Boolean).join(', ');
    if (names) logEvent(`${loser.name}'s former colonies are now free: ${names}.`);
  }
  if (App.selectedNationId === result.loserId || App.selectedNationId === result.winnerId) {
    renderDiplomacyPanel(App.selectedNationId);
  }
  if (result.loserId === World.playerId || result.winnerId === World.playerId) {
    updateHud();
  }
  if (result.loserId === World.playerId) {
    World.running = false;
    document.getElementById('btn-pause').textContent = '\u25B6';
    logEvent(`${winner.name} has conquered your nation. The simulation has been paused.`);
  }
}

/* ---------------------------------------------------------------------------
   Game loop
   --------------------------------------------------------------------------- */
function startTicking() {
  restartTicking();
}

function restartTicking() {
  if (App.tickTimer) clearInterval(App.tickTimer);
  const interval = TICK_MS / Math.max(0.25, World.speed);
  App.tickTimer = setInterval(tick, interval);
}

function tick() {
  if (!World.running) return;
  World.time += TICK_MS;

  const player = World.get(World.playerId);
  const playerFocusCount = player?.completedFocuses.size || 0;
  const playerWarsBefore = new Set(player?.atWarWith || []);
  if (player) {
    AI.economyTick(player);
    AI.focusTick(player);
  }
  AI.runTurn();

  if (player && player.completedFocuses.size > playerFocusCount) {
    playSound('notification');
  }
  if (player) {
    const playerWasPulledIntoWar = Array.from(player.atWarWith)
      .some(id => !playerWarsBefore.has(id));
    if (playerWasPulledIntoWar) playSound('waralert');
  }

  updateHud();
  if (document.getElementById('panel-economy').classList.contains('active')) renderEconomyPanel();
  if (document.getElementById('panel-focus').classList.contains('active')) renderFocusPanel();
  if (document.getElementById('panel-decisions').classList.contains('active')) renderDecisionsPanel();
  if (document.getElementById('panel-focus').classList.contains('active')) renderFocusPanel();
  if (document.getElementById('panel-government').classList.contains('active')) renderGovernmentPanel();
  if (App.selectedNationId && document.getElementById('panel-diplomacy').classList.contains('active')) {
    renderDiplomacyPanel(App.selectedNationId);
  }
  syncAllWarArrows();
}

/* ---------------------------------------------------------------------------
   Utilities
   --------------------------------------------------------------------------- */
function formatNumber(num) {
  return Math.round(num).toLocaleString('en-US');
}

function formatElapsedTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/* Game calendar date: the campaign starts 1/1/1900 and advances one game
   day per unit of World.time (~1.2 days per real second at 1x speed). */
function formatGameDate() {
  const base = Date.UTC(2026, 0, 1);
  const d = new Date(base + World.time * 86400); // World.time/1000 days -> ms
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

