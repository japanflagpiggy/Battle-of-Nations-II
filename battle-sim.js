/* ============================================================================
   battle-sim.js
   Territorial battle engine for Player-vs-AI wars, reusing the grid/frontline/
   naval-combat math from the standalone Simulator Mode tool (app.js). That
   file is untouched — this is an adapted port of its battle logic, wired to
   this game's own D3/SVG map and Nation/World data instead of Leaflet and
   app.js's own GeoJSON layer.

   Portable as-is from app.js: everything below works in raw lng/lat degree
   space and never touched Leaflet in the first place (grid build, frontline
   marching-squares extraction, naval pathfinding). Only the renderer differs
   — it draws into the existing #zoom-root SVG group via App.projection
   instead of a Leaflet canvas layer, so battles pan/zoom with the real map.

   Not ported: Simulator Mode's AI campaign naming and war-news dispatch
   (`rollCampaignName` / `requestNews` in app.js) — both call a websim-only
   completion API with no equivalent here. Skipped entirely per design
   decision; battles are named generically ("Germany vs Poland") and there's
   no news feed.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   Pure geometry helpers (ported verbatim from app.js — no Leaflet coupling)
   --------------------------------------------------------------------------- */
const BattleMath = {
  clamp(v, min, max) { return Math.max(min, Math.min(max, v)); },
  lerp(a, b, t) { return a + (b - a) * t; },
  dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
};

const BattleChaikin = {
  simplify(points, minSpacing) {
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (BattleMath.dist(out[out.length - 1], points[i]) >= minSpacing) out.push(points[i]);
    }
    return out.length >= 2 ? out : points.slice();
  },
  limitPoints(points, maxPoints) {
    if (points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    return out;
  },
  smooth(points, iterations, closed) {
    let pts = points;
    for (let it = 0; it < iterations; it++) {
      const next = [];
      const n = pts.length;
      const last = closed ? n : n - 1;
      if (!closed) next.push(pts[0]);
      for (let i = 0; i < last; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % n];
        next.push({ x: BattleMath.lerp(p0.x, p1.x, 0.25), y: BattleMath.lerp(p0.y, p1.y, 0.25) });
        next.push({ x: BattleMath.lerp(p0.x, p1.x, 0.75), y: BattleMath.lerp(p0.y, p1.y, 0.75) });
      }
      if (!closed) next.push(pts[n - 1]);
      pts = next;
    }
    return pts;
  }
};

function battlePointInPolygon(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y || 1e-12) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function battlePolygonCentroidAndArea(ring) {
  let area = 0, cx = 0, cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p0 = ring[i], p1 = ring[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    area += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-12) {
    let sx = 0, sy = 0; ring.forEach(p => { sx += p.x; sy += p.y; });
    return { x: sx / n, y: sy / n, area: 0 };
  }
  cx /= (6 * area); cy /= (6 * area);
  return { x: cx, y: cy, area: Math.abs(area) };
}

function battleRingArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

function battleRingBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ring.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  });
  return { minX, minY, maxX, maxY };
}

// GeoJSON geometry -> engine-native [{x:lng,y:lat}] rings, one per outer
// polygon component (mainland + every island kept separate).
function extractPolygonComponents(geometry) {
  let rings = [];
  if (geometry.type === 'Polygon') rings = [geometry.coordinates[0]];
  else if (geometry.type === 'MultiPolygon') rings = geometry.coordinates.map(poly => poly[0]);
  else return [];
  return rings
    .map(r => r.map(([lng, lat]) => ({ x: lng, y: lat })))
    .filter(r => r.length >= 4 && battleRingArea(r) >= 1e-6);
}

// Keeps every real component of a country (mainland + islands), dropping
// only unlabeled islet specks relative to the largest component.
function selectCountryRings(ownRings) {
  if (!ownRings || !ownRings.length) return [];
  const sized = ownRings.map(r => {
    const c = battlePolygonCentroidAndArea(r);
    return { ring: r, area: Math.abs(c.area) };
  }).sort((a, b) => b.area - a.area);
  const biggest = sized[0].area || 1;
  return sized.filter(o => o.area >= biggest / 2000).map(o => o.ring);
}

function pointInAnyRing(p, rings) {
  for (let i = 0; i < rings.length; i++) {
    if (battlePointInPolygon(p, rings[i])) return true;
  }
  return false;
}

function largestRingCentroid(rings) {
  let best = null, bestArea = -1;
  rings.forEach(r => {
    const c = battlePolygonCentroidAndArea(r);
    if (c.area > bestArea) { bestArea = c.area; best = { x: c.x, y: c.y }; }
  });
  return best;
}

/* ---------------------------------------------------------------------------
   Nation -> rings, cached per nation (their borders don't change mid-game
   except through conquest, and a battle never runs during that anyway)
   --------------------------------------------------------------------------- */
const BattleRingCache = new Map(); // nationId -> rings

function ringsForNation(nation) {
  if (BattleRingCache.has(nation.id)) return BattleRingCache.get(nation.id);
  const full = extractPolygonComponents(nation.feature.geometry).map(r => BattleChaikin.limitPoints(r, 300));
  const rings = selectCountryRings(full);
  BattleRingCache.set(nation.id, rings);
  return rings;
}

function buildSideRings(nations) {
  const out = [];
  nations.forEach(n => ringsForNation(n).forEach(r => out.push(r)));
  return out;
}

/* ---------------------------------------------------------------------------
   Land battle grid + tick (ported near-verbatim from app.js's buildSimGrid /
   simTick — pure lng/lat grid math, no rendering)
   --------------------------------------------------------------------------- */
function buildSimGrid(attackerRings, victimRings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  attackerRings.concat(victimRings).forEach(ring => ring.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }));
  const pad = Math.max(maxX - minX, maxY - minY) * 0.04 || 0.5;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const ringBBoxOf = rings => {
    let lo = Infinity, hi = -Infinity, pt0 = Infinity, pt1 = -Infinity;
    rings.forEach(r => r.forEach(p => { if (p.x < lo) lo = p.x; if (p.x > hi) hi = p.x; if (p.y < pt0) pt0 = p.y; if (p.y > pt1) pt1 = p.y; }));
    return { w: hi - lo, h: pt1 - pt0 };
  };
  const aBB = ringBBoxOf(attackerRings), bBB = ringBBoxOf(victimRings);
  const minDimA = Math.max(0.0001, Math.min(aBB.w, aBB.h));
  const minDimB = Math.max(0.0001, Math.min(bBB.w, bBB.h));
  const smallMinDim = Math.min(minDimA, minDimB);
  const minCellForCap = span / 260;
  const cell = Math.max(Math.min(span / 90, smallMinDim / 18), minCellForCap);
  const cols = Math.max(10, Math.min(260, Math.round((maxX - minX) / cell) + 1));
  const rows = Math.max(10, Math.min(260, Math.round((maxY - minY) / cell) + 1));
  const dx = (maxX - minX) / (cols - 1);
  const dy = (maxY - minY) / (rows - 1);

  const nodeOwner = new Int8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: minX + i * dx, y: minY + j * dy };
      let owner = -1;
      if (pointInAnyRing(p, attackerRings)) owner = 0;
      else if (pointInAnyRing(p, victimRings)) owner = 1;
      nodeOwner[j * cols + i] = owner;
    }
  }
  return { cols, rows, minX, minY, dx, dy, nodeOwner };
}

function spawnUnits(grid, side) {
  const cells = [];
  for (let j = 0; j < grid.rows; j++) for (let i = 0; i < grid.cols; i++) {
    if (grid.nodeOwner[j * grid.cols + i] !== side) continue;
    const neighbors = [
      i > 0 ? grid.nodeOwner[j * grid.cols + i - 1] : -1,
      i < grid.cols - 1 ? grid.nodeOwner[j * grid.cols + i + 1] : -1,
      j > 0 ? grid.nodeOwner[(j - 1) * grid.cols + i] : -1,
      j < grid.rows - 1 ? grid.nodeOwner[(j + 1) * grid.cols + i] : -1
    ];
    if (neighbors.includes(1 - side)) cells.push({ i, j });
  }
  if (!cells.length) return [];
  const count = Math.min(cells.length, 18, Math.max(4, Math.round(cells.length / 25)));
  const units = [];
  for (let k = 0; k < count; k++) {
    const c = cells.splice(Math.floor(Math.random() * cells.length), 1)[0];
    units.push({ side, i: c.i, j: c.j, troops: 20 + Math.floor(Math.random() * 180) });
  }
  return units;
}

function repositionUnits(sim) {
  const { cols, rows, nodeOwner } = sim.grid;
  const neighbors = (i, j) => [
    { i: i - 1, j }, { i: i + 1, j }, { i, j: j - 1 }, { i, j: j + 1 }
  ].filter(p => p.i >= 0 && p.i < cols && p.j >= 0 && p.j < rows);

  sim.units.forEach(u => {
    const enemy = 1 - u.side;
    const adjacent = neighbors(u.i, u.j);
    const enemyCell = adjacent.find(p => nodeOwner[p.j * cols + p.i] === enemy);

    if (enemyCell && Math.random() < 0.65) {
      const enemyIndex = enemyCell.j * cols + enemyCell.i;
      nodeOwner[enemyIndex] = u.side;
      u.i = enemyCell.i;
      u.j = enemyCell.j;
      sim.recentCaptures.push({ i: u.i, j: u.j, owner: u.side, t: performance.now() });
      if (sim.recentCaptures.length > 400) sim.recentCaptures.shift();
      return;
    }

    const ownFront = adjacent.filter(p => {
      const cellOwner = nodeOwner[p.j * cols + p.i];
      return cellOwner === u.side && neighbors(p.i, p.j).some(n => nodeOwner[n.j * cols + n.i] === enemy);
    });
    if (ownFront.length && Math.random() < 0.8) {
      const next = ownFront[Math.floor(Math.random() * ownFront.length)];
      u.i = next.i;
      u.j = next.j;
    }
  });
}

function simTick(sim) {
  const grid = sim.grid;
  if (!grid) return;
  const { cols, rows, nodeOwner } = grid;

  sim.attackerStrength = BattleMath.clamp(sim.attackerStrength + (Math.random() - 0.5) * 6, 20, 80);
  sim.victimStrength = 100 - sim.attackerStrength;
  sim.navalEdge = BattleMath.clamp((sim.navalEdge || 0) * 0.994, -45, 45);

  const contested = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i, o = nodeOwner[idx];
      if (o !== 0 && o !== 1) continue;
      if ((i > 0 && nodeOwner[idx - 1] !== -1 && nodeOwner[idx - 1] !== o) ||
          (i < cols - 1 && nodeOwner[idx + 1] !== -1 && nodeOwner[idx + 1] !== o) ||
          (j > 0 && nodeOwner[idx - cols] !== -1 && nodeOwner[idx - cols] !== o) ||
          (j < rows - 1 && nodeOwner[idx + cols] !== -1 && nodeOwner[idx + cols] !== o)) {
        contested.push(idx);
      }
    }
  }

  if (!contested.length) {
    let c0 = 0, c1 = 0;
    for (let k = 0; k < nodeOwner.length; k++) {
      if (nodeOwner[k] === 0) c0++; else if (nodeOwner[k] === 1) c1++;
    }
    if (c0 === 0 || c1 === 0) sim.finished = true;
    return;
  }

  const effAtt = BattleMath.clamp(sim.attackerStrength + sim.navalEdge, 10, 90);
  const pAttacker = effAtt / 100;
  const captureBudget = Math.max(1, Math.round(contested.length * 0.10));
  let done = 0, guard = 0;
  while (done < captureBudget && guard < contested.length * 6) {
    guard++;
    const idx = contested[Math.floor(Math.random() * contested.length)];
    const cur = nodeOwner[idx];
    if (cur !== 0 && cur !== 1) continue;
    const newOwner = Math.random() < pAttacker ? 0 : 1;
    if (newOwner === cur) continue;
    nodeOwner[idx] = newOwner;
    sim.recentCaptures.push({ i: idx % cols, j: Math.floor(idx / cols), owner: newOwner, t: performance.now() });
    if (sim.recentCaptures.length > 400) sim.recentCaptures.shift();
    done++;
  }

  // Flood-fill each connected same-owner component; one fully surrounded
  // by the opposing side (never touching the grid edge) flips wholesale.
  const visited = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (nodeOwner[idx] === -1 || visited[idx]) continue;
      const owner = nodeOwner[idx];
      const component = [];
      let isSurrounded = true;
      const queue = [idx]; visited[idx] = 1; let head = 0;
      while (head < queue.length) {
        const current = queue[head++];
        component.push(current);
        const cx = current % cols, cy = Math.floor(current / cols);
        const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) { isSurrounded = false; continue; }
          const neighbor = nx + ny * cols;
          const neighborOwner = nodeOwner[neighbor];
          if (neighborOwner === -1) { isSurrounded = false; }
          else if (neighborOwner === owner) {
            if (!visited[neighbor]) { visited[neighbor] = 1; queue.push(neighbor); }
          } else if (neighborOwner !== (1 - owner)) { isSurrounded = false; }
        }
      }
      if (isSurrounded) {
        const newOwner = 1 - owner;
        for (const captured of component) {
          nodeOwner[captured] = newOwner;
          sim.recentCaptures.push({ i: captured % cols, j: Math.floor(captured / cols), owner: newOwner, t: performance.now() });
        }
      }
    }
  }

  const now = performance.now();
  sim.recentCaptures = sim.recentCaptures.filter(c => now - c.t < 2200);
}

/* ---------------------------------------------------------------------------
   Frontline / territory contour extraction (marching squares — ported
   verbatim; pure grid math)
   --------------------------------------------------------------------------- */
const MS_CASES = [
  [], [['L', 'B']], [['B', 'R']], [['L', 'R']],
  [['R', 'T']], [['L', 'B'], ['R', 'T']], [['B', 'T']], [['L', 'T']],
  [['T', 'L']], [['B', 'T']], [['B', 'R'], ['T', 'L']], [['R', 'T']],
  [['L', 'R']], [['B', 'R']], [['L', 'B']], []
];

function marchingSquaresSegments(cols, rows, valueAt, nodeX, nodeY) {
  const segments = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = valueAt(i, j), b = valueAt(i + 1, j), c = valueAt(i + 1, j + 1), d = valueAt(i, j + 1);
      if (a == null || b == null || c == null || d == null) continue;
      const cases = MS_CASES[a + b * 2 + c * 4 + d * 8];
      if (!cases || !cases.length) continue;
      const x0 = nodeX(i), x1 = nodeX(i + 1), y0 = nodeY(j), y1 = nodeY(j + 1);
      const mid = {
        B: { x: (x0 + x1) / 2, y: y0 }, T: { x: (x0 + x1) / 2, y: y1 },
        L: { x: x0, y: (y0 + y1) / 2 }, R: { x: x1, y: (y0 + y1) / 2 }
      };
      cases.forEach(pair => segments.push([mid[pair[0]], mid[pair[1]]]));
    }
  }
  return segments;
}

function traceContours(segments) {
  const key = p => Math.round(p.x * 1e6) + '_' + Math.round(p.y * 1e6);
  const segList = segments.map(s => ({ p0: s[0], p1: s[1], used: false }));
  const idx = new Map();
  const push = (k, entry) => { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(entry); };
  segList.forEach(s => { push(key(s.p0), { seg: s, end: 0 }); push(key(s.p1), { seg: s, end: 1 }); });

  const walk = (startSeg, fromEnd) => {
    startSeg.used = true;
    const path = fromEnd === 0 ? [startSeg.p0, startSeg.p1] : [startSeg.p1, startSeg.p0];
    let cur = path[path.length - 1];
    let guard = 0;
    while (guard++ < segList.length + 5) {
      const cands = idx.get(key(cur)) || [];
      const next = cands.find(c => !c.seg.used);
      if (!next) break;
      next.seg.used = true;
      cur = next.end === 0 ? next.seg.p1 : next.seg.p0;
      path.push(cur);
    }
    return path;
  };

  const paths = [];
  for (const [, arr] of idx) {
    if (arr.length === 1 && !arr[0].seg.used) paths.push(walk(arr[0].seg, arr[0].end));
  }
  for (const s of segList) {
    if (!s.used) paths.push(walk(s, 0));
  }
  return paths.filter(p => p.length >= 3);
}

function smoothBlobPath(points, grid) {
  const spacing = Math.max(grid.dx, grid.dy);
  let pts = BattleChaikin.limitPoints(points, 260);
  pts = BattleChaikin.simplify(pts, spacing * 0.5);
  pts = BattleChaikin.smooth(pts, 2, true);
  return pts;
}
function smoothFrontlinePath(points, grid) {
  const spacing = Math.max(grid.dx, grid.dy);
  let pts = BattleChaikin.limitPoints(points, 260);
  pts = BattleChaikin.simplify(pts, spacing * 0.4);
  pts = BattleChaikin.smooth(pts, 2, false);
  return pts;
}

function extractOwnerContours(sim, owner) {
  const grid = sim.grid;
  const nodeX = i => grid.minX + i * grid.dx, nodeY = j => grid.minY + j * grid.dy;
  const val = (i, j) => grid.nodeOwner[j * grid.cols + i] === owner ? 1 : 0;
  const segs = marchingSquaresSegments(grid.cols, grid.rows, val, nodeX, nodeY);
  return traceContours(segs).map(p => smoothBlobPath(p, grid));
}

function extractFrontline(sim) {
  const grid = sim.grid;
  const nodeX = i => grid.minX + i * grid.dx, nodeY = j => grid.minY + j * grid.dy;
  const val = (i, j) => { const o = grid.nodeOwner[j * grid.cols + i]; return (o === 0 || o === 1) ? o : null; };
  const segs = marchingSquaresSegments(grid.cols, grid.rows, val, nodeX, nodeY);
  return traceContours(segs).map(p => smoothFrontlinePath(p, grid));
}

/* ---------------------------------------------------------------------------
   Naval theater (ported near-verbatim). The one adaptation: app.js found
   nearby third-party coastlines via Leaflet layer bounds (`entry.layer.
   getBounds()`); here we use the same cached lng/lat rings as everything
   else, via World's own nations instead of a Leaflet-specific layer list.
   --------------------------------------------------------------------------- */
function nearbyCountryRings(bbox, excludeIds) {
  const rings = [];
  World.allNations().forEach(n => {
    if (excludeIds.has(n.id)) return;
    ringsForNation(n).forEach(ring => {
      const bb = battleRingBBox(ring);
      if (bb.maxX < bbox.minX || bb.minX > bbox.maxX || bb.maxY < bbox.minY || bb.minY > bbox.maxY) return;
      rings.push(ring);
    });
  });
  return rings;
}

function buildNavalGrid(aRings, vRings, excludeIds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  aRings.concat(vRings).forEach(ring => ring.forEach(p => {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }));
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = span * 0.4;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const gridSpan = Math.max(maxX - minX, maxY - minY);
  const cell = gridSpan / 72;
  const cols = Math.max(10, Math.min(72, Math.round((maxX - minX) / cell) + 1));
  const rows = Math.max(10, Math.min(72, Math.round((maxY - minY) / cell) + 1));
  const dx = (maxX - minX) / (cols - 1), dy = (maxY - minY) / (rows - 1);

  const otherRings = nearbyCountryRings({ minX, minY, maxX, maxY }, excludeIds);
  const cellSide = new Int8Array(cols * rows); // -1 sea, 0 attacker, 1 victim, 2 other land
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = { x: minX + i * dx, y: minY + j * dy };
      let side = -1;
      if (pointInAnyRing(p, aRings)) side = 0;
      else if (pointInAnyRing(p, vRings)) side = 1;
      else if (pointInAnyRing(p, otherRings)) side = 2;
      cellSide[j * cols + i] = side;
    }
  }
  return { cols, rows, minX, minY, dx, dy, cellSide };
}

function findCoastalPorts(navalGrid, side, maxPorts) {
  const { cols, rows, cellSide, minX, minY, dx, dy } = navalGrid;
  const isCoastalSea = idx => {
    if (cellSide[idx] !== -1) return false;
    const i = idx % cols, j = Math.floor(idx / cols);
    const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
    return nb.some(([ni, nj]) => ni >= 0 && ni < cols && nj >= 0 && nj < rows && cellSide[nj * cols + ni] === side);
  };
  const visited = new Uint8Array(cols * rows);
  const clusters = [];
  for (let idx = 0; idx < cols * rows; idx++) {
    if (visited[idx] || !isCoastalSea(idx)) continue;
    const queue = [idx]; visited[idx] = 1; const comp = [idx]; let head = 0;
    while (head < queue.length) {
      const cur = queue[head++], cx = cur % cols, cy = Math.floor(cur / cols);
      [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]].forEach(([nx, ny]) => {
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return;
        const nIdx = ny * cols + nx;
        if (visited[nIdx] || !isCoastalSea(nIdx)) return;
        visited[nIdx] = 1; queue.push(nIdx); comp.push(nIdx);
      });
    }
    clusters.push(comp);
  }
  clusters.sort((a, b) => b.length - a.length);
  return clusters.slice(0, maxPorts).map(comp => {
    let sx = 0, sy = 0;
    comp.forEach(idx => { sx += minX + (idx % cols) * dx; sy += minY + Math.floor(idx / cols) * dy; });
    const cx = sx / comp.length, cy = sy / comp.length;
    let bestIdx = comp[0], bestD = Infinity;
    comp.forEach(idx => {
      const x = minX + (idx % cols) * dx, y = minY + Math.floor(idx / cols) * dy;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bestD) { bestD = d; bestIdx = idx; }
    });
    const i = bestIdx % cols, j = Math.floor(bestIdx / cols);
    return { i, j, x: minX + i * dx, y: minY + j * dy };
  });
}

function seaAStar(navalGrid, start, goal) {
  const { cols, rows, cellSide, dx, dy } = navalGrid;
  const passable = idx => cellSide[idx] === -1;
  const startIdx = start.j * cols + start.i, goalIdx = goal.j * cols + goal.i;
  if (!passable(startIdx) || !passable(goalIdx)) return null;
  const cellSize = Math.max(dx, dy);
  const h = (i, j) => Math.hypot(i - goal.i, j - goal.j) * cellSize;
  const n = cols * rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const fScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  gScore[startIdx] = 0; fScore[startIdx] = h(start.i, start.j);
  const open = new Set([startIdx]);
  let guard = 0;
  while (open.size && guard++ < 14000) {
    let cur = -1, bestF = Infinity;
    for (const idx of open) { if (fScore[idx] < bestF) { bestF = fScore[idx]; cur = idx; } }
    if (cur === goalIdx) break;
    open.delete(cur);
    const cx = cur % cols, cy = Math.floor(cur / cols);
    const neighbors = [[cx - 1, cy, 1], [cx + 1, cy, 1], [cx, cy - 1, 1], [cx, cy + 1, 1],
      [cx - 1, cy - 1, 1.414], [cx + 1, cy - 1, 1.414], [cx - 1, cy + 1, 1.414], [cx + 1, cy + 1, 1.414]];
    for (const [nx, ny, cost] of neighbors) {
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const nIdx = ny * cols + nx;
      if (!passable(nIdx)) continue;
      const tentative = gScore[cur] + cost * cellSize;
      if (tentative < gScore[nIdx]) {
        came[nIdx] = cur; gScore[nIdx] = tentative; fScore[nIdx] = tentative + h(nx, ny);
        open.add(nIdx);
      }
    }
  }
  if (startIdx !== goalIdx && came[goalIdx] === -1) return null;
  const path = [goalIdx]; let cur = goalIdx;
  while (cur !== startIdx) { cur = came[cur]; if (cur === -1) return null; path.push(cur); }
  path.reverse();
  return path.map(idx => ({ x: navalGrid.minX + (idx % cols) * dx, y: navalGrid.minY + Math.floor(idx / cols) * dy }));
}

function smoothSeaRoute(points) {
  let pts = BattleChaikin.limitPoints(points, 160);
  pts = BattleChaikin.smooth(pts, 2, false);
  return pts;
}

function buildNavalTheater(aRings, vRings, excludeIds) {
  const grid = buildNavalGrid(aRings, vRings, excludeIds);
  const aPorts = findCoastalPorts(grid, 0, 2);
  const vPorts = findCoastalPorts(grid, 1, 2);
  if (!aPorts.length || !vPorts.length) return null;
  const dist = (ap, vp) => Math.hypot(ap.x - vp.x, ap.y - vp.y);
  let near = null, nearD = Infinity, far = null, farD = -1;
  aPorts.forEach(ap => vPorts.forEach(vp => {
    const d = dist(ap, vp);
    if (d < nearD) { nearD = d; near = { ap, vp }; }
    if (d > farD) { farD = d; far = { ap, vp }; }
  }));
  const routes = [];
  const nearRaw = seaAStar(grid, near.ap, near.vp);
  if (!nearRaw) return null;
  routes.push({ route: smoothSeaRoute(nearRaw), a: near.ap, v: near.vp, flank: false });
  const farRaw = far && (far.ap !== near.ap || far.vp !== near.vp) ? seaAStar(grid, far.ap, far.vp) : null;
  if (farRaw) {
    const a = farRaw[0], b = farRaw[farRaw.length - 1];
    const na = nearRaw[0], nb = nearRaw[nearRaw.length - 1];
    const sameEnds = (a.x === na.x && a.y === na.y) || (a.x === nb.x && a.y === nb.y) ||
      (b.x === na.x && b.y === na.y) || (b.x === nb.x && b.y === nb.y);
    const cell = Math.max(grid.dx, grid.dy);
    if (!sameEnds || farRaw.length * cell > nearRaw.length * cell * 1.3) {
      routes.push({ route: smoothSeaRoute(farRaw), a: far.ap, v: far.vp, flank: true });
    }
  }
  return {
    grid, ports: { 0: aPorts, 1: vPorts }, routes,
    flank: routes.length > 1,
    combatRoute: routes[0].route, transportRoutes: routes,
    combatFleets: [], transportFleets: [], battles: [],
    transportCooldown: 5
  };
}

function pointAlongRoute(route, t) {
  if (!route.length) return { x: 0, y: 0 };
  if (route.length === 1) return route[0];
  const segLens = []; let total = 0;
  for (let i = 1; i < route.length; i++) { const d = BattleMath.dist(route[i - 1], route[i]); segLens.push(d); total += d; }
  let target = BattleMath.clamp(t, 0, 1) * total;
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] || i === segLens.length - 1) {
      const f = segLens[i] > 0 ? BattleMath.clamp(target / segLens[i], 0, 1) : 0;
      const a = route[i], b = route[i + 1];
      return { x: BattleMath.lerp(a.x, b.x, f), y: BattleMath.lerp(a.y, b.y, f) };
    }
    target -= segLens[i];
  }
  return route[route.length - 1];
}

function recordNavalBattle(sim, x, y, landing) {
  sim.naval.battles.push({ x, y, t: performance.now(), landing: !!landing });
  if (sim.naval.battles.length > 60) sim.naval.battles.shift();
}
function spawnCombatFleet(sim, side) {
  sim.naval.combatFleets.push({ side, kind: 'combat', progress: 0, dir: 1, strength: 55 + Math.random() * 35, ships: 2 + Math.floor(Math.random() * 4), x: 0, y: 0 });
}
function spawnTransportFleet(sim, side, routeIdx) {
  const routes = sim.naval.transportRoutes;
  sim.naval.transportFleets.push({
    side, kind: 'transport', progress: 0, capacity: 120, troops: 25 + Math.floor(Math.random() * 75), health: 100,
    routeIdx: (typeof routeIdx === 'number') ? routeIdx : (routes.length ? Math.floor(Math.random() * routes.length) : 0),
    x: 0, y: 0
  });
}
function tickNavalMovement(sim) {
  const nav = sim.naval; if (!nav) return;
  const speed = 0.05;
  nav.combatFleets.forEach(f => {
    f.progress += speed * f.dir;
    if (f.progress > 0.55) { f.progress = 0.55; f.dir = -1; }
    if (f.progress < 0) { f.progress = 0; f.dir = 1; }
    const t = f.side === 0 ? f.progress : 1 - f.progress;
    const p = pointAlongRoute(nav.combatRoute, t);
    f.x = p.x; f.y = p.y;
  });
  nav.transportFleets.forEach(tr => {
    const r = (nav.transportRoutes[tr.routeIdx] || nav.transportRoutes[0]).route;
    tr.progress = Math.min(1, tr.progress + speed * 0.75);
    const t = tr.side === 0 ? tr.progress : 1 - tr.progress;
    const p = pointAlongRoute(r, t);
    tr.x = p.x; tr.y = p.y;
  });
}
function tickNavalSpawns(sim) {
  const nav = sim.naval; if (!nav) return;
  [0, 1].forEach(side => {
    if (!nav.combatFleets.some(f => f.side === side) && Math.random() < 0.5) spawnCombatFleet(sim, side);
  });
  nav.transportCooldown--;
  if (nav.transportCooldown <= 0) {
    nav.transportCooldown = 6 + Math.floor(Math.random() * 4);
    const side = Math.random() < 0.5 ? 0 : 1;
    const ofSide = nav.transportFleets.filter(t => t.side === side);
    if (ofSide.length < 2) {
      const routes = nav.transportRoutes;
      const flankIdx = routes.findIndex(r => r.flank);
      const routeIdx = (flankIdx >= 0 && ofSide.length === 0) ? flankIdx : Math.floor(Math.random() * routes.length);
      spawnTransportFleet(sim, side, routeIdx);
    }
  }
}
function tickNavalCombat(sim) {
  const nav = sim.naval; if (!nav) return;
  const range = Math.max(nav.grid.dx, nav.grid.dy) * 4.5;
  const combats0 = nav.combatFleets.filter(f => f.side === 0);
  const combats1 = nav.combatFleets.filter(f => f.side === 1);
  combats0.forEach(a => combats1.forEach(b => {
    if (Math.hypot(a.x - b.x, a.y - b.y) > range) return;
    a.strength -= 3 + Math.random() * 5;
    b.strength -= 3 + Math.random() * 5;
    recordNavalBattle(sim, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }));
  nav.combatFleets.forEach(cf => {
    const targets = nav.transportFleets.filter(t => t.side !== cf.side);
    targets.forEach(t => {
      if (Math.hypot(cf.x - t.x, cf.y - t.y) > range) return;
      if (Math.random() < 0.5) {
        t.health -= 10 + Math.random() * 12;
        recordNavalBattle(sim, (cf.x + t.x) / 2, (cf.y + t.y) / 2);
      }
    });
  });
  const deadCombat = nav.combatFleets.filter(f => f.strength <= 0);
  const sunkTransports = nav.transportFleets.filter(t => t.health <= 0);
  deadCombat.forEach(f => { sim.navalEdge += (f.side === 0 ? -8 : 8); });
  sunkTransports.forEach(t => { sim.navalEdge += (t.side === 0 ? -12 : 12); });
  sim.navalEdge = BattleMath.clamp(sim.navalEdge, -45, 45);
  nav.combatFleets = nav.combatFleets.filter(f => f.strength > 0);
  nav.transportFleets = nav.transportFleets.filter(t => t.health > 0);
}
function disembarkTransport(sim, tr) {
  const grid = sim.grid;
  const destSide = tr.side === 0 ? 1 : 0;
  let best = null, bestD = Infinity;
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      if (grid.nodeOwner[j * grid.cols + i] !== destSide) continue;
      const x = grid.minX + i * grid.dx, y = grid.minY + j * grid.dy;
      const d = Math.hypot(x - tr.x, y - tr.y);
      if (d < bestD) { bestD = d; best = { i, j }; }
    }
  }
  if (!best) return;
  const cells = [[best.i, best.j], [best.i + 1, best.j], [best.i, best.j + 1]];
  for (const [ci, cj] of cells) {
    if (ci < 0 || ci >= grid.cols || cj < 0 || cj >= grid.rows) continue;
    const idx = cj * grid.cols + ci;
    if (grid.nodeOwner[idx] === destSide) {
      grid.nodeOwner[idx] = tr.side;
      sim.recentCaptures.push({ i: ci, j: cj, owner: tr.side, t: performance.now() });
    }
  }
  sim.units.push({ side: tr.side, i: best.i, j: best.j, troops: Math.max(200, tr.troops * 2) });
  sim.navalEdge = BattleMath.clamp(sim.navalEdge + (tr.side === 0 ? 6 : -6), -45, 45);
  recordNavalBattle(sim, tr.x, tr.y, true);
}
function tickNavalTransports(sim) {
  const nav = sim.naval; if (!nav) return;
  nav.transportFleets = nav.transportFleets.filter(tr => {
    if (tr.progress < 1) return true;
    disembarkTransport(sim, tr);
    return false;
  });
}

/* ---------------------------------------------------------------------------
   Simulator — the battle engine + state machine. Mirrors app.js's
   Simulator.start()/tick() shape, adapted to take World nation IDs and to
   render into this game's own D3/SVG map.
   --------------------------------------------------------------------------- */
const Simulator = {
  active: false, finished: false,
  grid: null,
  sideAIds: [], sideBIds: [],
  attackerName: null, victimName: null,
  attackerStrength: 50, victimStrength: 50,
  attackerCentroid: null, victimCentroid: null,
  attackerArmy: 0, victimArmy: 0,
  attackerBlobs: [], victimBlobs: [], frontline: [],
  clipRings: [],
  units: [], recentCaptures: [],
  showUnits: true,
  naval: null, navalEdge: 0,
  timer: null,
  _group: null,
  _ticks: 0,
  _winnerSide: null,
  _onTick: null,
  _onFinish: null,

  // Player-vs-AI battles are always exactly one nation per side today, but
  // this takes arrays (of World nation IDs) so a future alliance war could
  // put several nations on either side, same as app.js's Simulator did with
  // country names.
  start(aIds, bIds, opts = {}) {
    this.stop(true);
    const aNations = aIds.map(id => World.get(id)).filter(Boolean);
    const bNations = bIds.map(id => World.get(id)).filter(Boolean);
    if (!aNations.length || !bNations.length) return false;

    // A conquered colony fights for its conqueror: its land renders as the
    // conqueror's on the battle grid, and its (much weaker, per isColony's
    // 0.4x multiplier) military and manpower add to the conqueror's side.
    // Kept separate from aNations/bNations so names/centroids above still
    // read as just the fighting nations, not their colonies.
    const withColonies = (nations) => {
      const out = new Map();
      nations.forEach(n => {
        out.set(n.id, n);
        n.colonies.forEach(cid => {
          const colony = World.get(cid);
          if (colony) out.set(cid, colony);
        });
      });
      return Array.from(out.values());
    };
    const aTerritory = withColonies(aNations);
    const bTerritory = withColonies(bNations);

    const aRings = buildSideRings(aTerritory);
    const bRings = buildSideRings(bTerritory);
    if (!aRings.length || !bRings.length) return false;

    this.grid = buildSimGrid(aRings, bRings);
    this.sideAIds = aIds.slice(); this.sideBIds = bIds.slice();
    this.attackerName = aNations.map(n => n.name).join(', ');
    this.victimName = bNations.map(n => n.name).join(', ');
    this.attackerCentroid = largestRingCentroid(aRings);
    this.victimCentroid = largestRingCentroid(bRings);
    this.clipRings = aRings.concat(bRings);
    this.naval = buildNavalTheater(aRings, bRings, new Set([
      ...aTerritory.map(n => n.id), ...bTerritory.map(n => n.id)
    ]));

    // Initial strength split and army sizes come from the actual game
    // stats (military strength / manpower), not blind randomness — this
    // never mutates the nations' own stored stats, only reads them once.
    const aStr = aTerritory.reduce((s, n) => s + n.effectiveMilitaryStrength(), 0);
    const bStr = bTerritory.reduce((s, n) => s + n.effectiveMilitaryStrength(), 0);
    const ratio = aStr / Math.max(1, aStr + bStr);
    this.attackerStrength = BattleMath.clamp(ratio * 100, 15, 85);
    this.victimStrength = 100 - this.attackerStrength;
    this.navalEdge = 0;
    const armyFromStats = n => Math.round(Math.max(10, n.manpower) * (6 + Math.random() * 4));
    this.attackerArmy = aTerritory.reduce((s, n) => s + armyFromStats(n), 0);
    this.victimArmy = bTerritory.reduce((s, n) => s + armyFromStats(n), 0);
    this.lastArmyTick = performance.now();

    this.recentCaptures = [];
    this.units = spawnUnits(this.grid, 0).concat(spawnUnits(this.grid, 1));
    this.active = true; this.finished = false;
    this._ticks = 0; this._winnerSide = null;
    this._onTick = opts.onTick || null;
    this._onFinish = opts.onFinish || null;

    this._recompute();
    this._ensureLayer();
    this._draw();
    this.timer = setInterval(() => this.tick(), 650);
    return true;
  },

  tick() {
    if (!this.active || this.finished) return;
    this._ticks++;
    simTick(this);
    if (this.showUnits) repositionUnits(this);
    if (this.naval) {
      tickNavalSpawns(this); tickNavalMovement(this); tickNavalCombat(this); tickNavalTransports(this);
      const now = performance.now();
      this.naval.battles = this.naval.battles.filter(b => now - b.t < 2400);
    }
    this._recompute();

    if (this.attackerArmy > 0 || this.victimArmy > 0) {
      const now = performance.now();
      const due = Math.floor((now - (this.lastArmyTick || now)) / 400);
      this.lastArmyTick = now;
      if (due > 0) {
        if (this.attackerArmy > 0) this.attackerArmy = Math.max(0, this.attackerArmy - due * 50);
        if (this.victimArmy > 0) this.victimArmy = Math.max(0, this.victimArmy - due * 50);
      }
    }

    if (!this.finished) {
      const { pa, pv } = this._territoryControl();
      if (pa === 100) {
        this.finished = true;
        this._winnerSide = 0; // Attacker wins
      } else if (pv === 100) {
        this.finished = true;
        this._winnerSide = 1; // Victim wins
      } else if (this._ticks > 160) {
    // Safety valve: two very large, evenly matched countries can grind on
    // indefinitely without either side ever hitting zero territory. Force
    // a decision by territorial control once a generous tick cap is hit,
    // so a Player-vs-AI war can never hang the game.
        this.finished = true;
      this._winnerSide = pa >= 50 ? 0 : 1;
    }
    }

    if (this._onTick) this._onTick(this);
    this._draw();

    if (this.finished) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this._onFinish) this._onFinish(this);
    }
  },

  _territoryControl() {
    if (!this.grid) return { pa: 50, pv: 50 };
    let a = 0, b = 0;
    const owner = this.grid.nodeOwner;
    for (let k = 0; k < owner.length; k++) { if (owner[k] === 0) a++; else if (owner[k] === 1) b++; }
    const total = a + b;
    const pa = total ? Math.round(a / total * 100) : 50;
    return { pa, pv: 100 - pa };
  },

  _recompute() {
    if (!this.grid) return;
    this.attackerBlobs = extractOwnerContours(this, 0);
    this.victimBlobs = extractOwnerContours(this, 1);
    this.frontline = extractFrontline(this);
  },

  /* Builds the focus-mask path: a rect covering the whole map with
     evenodd holes punched over the combatant territories, so the rest of
     the world dims while the battling nations stay lit. Projected through
     App.projection, so it sits inside #zoom-root and pans/zooms for free. */
  _maskPath() {
    const proj = p => App.projection([p.x, p.y]);
    let d = 'M-400,-400L2000,-400L2000,1300L-400,1300Z';
    this.clipRings.forEach(ring => {
      if (!ring || !ring.length) return;
      d += 'M' + proj(ring[0])[0] + ',' + proj(ring[0])[1];
      for (let k = 1; k < ring.length; k++) {
        const s = proj(ring[k]);
        d += 'L' + s[0] + ',' + s[1];
      }
      d += 'Z';
    });
    return d;
  },

  stop(teardown) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (teardown) {
      this.active = false; this.finished = false; this.grid = null;
      this.attackerBlobs = []; this.victimBlobs = []; this.frontline = [];
      this.units = []; this.recentCaptures = [];
      this.sideAIds = []; this.sideBIds = [];
      this.clipRings = []; this.naval = null;
      this._winnerSide = null; this._ticks = 0;
      this._onTick = null; this._onFinish = null;
      if (this._group) { this._group.remove(); this._group = null; }
    }
  },

  /* ---- rendering: draws into the existing world map's #zoom-root group,
     via App.projection, so the battle pans/zooms with the real map instead
     of needing its own viewport. ---- */
  _ensureLayer() {
    if (this._group) return;
    this._group = d3.select('#zoom-root').append('g').attr('id', 'battle-sim-layer');
    // Focus mask: a full-map dim layer with a hole punched over the two
    // combatants' territories (see buildBattleMaskPath). Must be the first
    // child so the coloured territory blobs render on top of it.
    this._group.append('path')
      .attr('class', 'battle-dimmer')
      .attr('fill-rule', 'evenodd')
      .attr('d', this._maskPath());
  },

  _draw() {
    if (!this._group || !this.active || !this.grid) return;
    const g = this._group;
    const proj = p => App.projection([p.x, p.y]);
    const pathFor = pts => {
      let d = '';
      pts.forEach((p, i) => { const s = proj(p); d += (i === 0 ? 'M' : 'L') + s[0] + ',' + s[1]; });
      return d;
    };

    g.selectAll('path.battle-blob-a').data(this.attackerBlobs).join('path')
      .attr('class', 'battle-blob-a').attr('d', pathFor).attr('fill-rule', 'evenodd');
    g.selectAll('path.battle-blob-v').data(this.victimBlobs).join('path')
      .attr('class', 'battle-blob-v').attr('d', pathFor).attr('fill-rule', 'evenodd');
    g.selectAll('path.battle-frontline').data(this.frontline).join('path')
      .attr('class', 'battle-frontline').attr('d', pathFor).attr('fill', 'none');

    const routes = this.naval ? (this.naval.routes || []) : [];
    g.selectAll('path.battle-naval-route').data(routes).join('path')
      .attr('class', d => 'battle-naval-route' + (d.flank ? ' flank' : ''))
      .attr('d', d => pathFor(d.route)).attr('fill', 'none');

    const fleets = this.naval ? this.naval.combatFleets.concat(this.naval.transportFleets) : [];
    const fleetSel = g.selectAll('g.battle-fleet').data(fleets).join(enter => {
      const eg = enter.append('g').attr('class', 'battle-fleet');
      eg.append('image').attr('class', 'battle-fleet-flag');
      return eg;
    });
    fleetSel.attr('class', d => 'battle-fleet side-' + d.side + (d.kind === 'transport' ? ' transport' : ''))
      .attr('transform', d => {
        const s = proj(d);
        const zoom = App.currentTransform ? App.currentTransform.k : 1;
        return `translate(${s[0]},${s[1]}) scale(${1 / zoom})`;
      });
    fleetSel.select('image.battle-fleet-flag')
      .attr('href', d => {
        const ids = d.side === 0 ? this.sideAIds : this.sideBIds;
        const nation = World.get(ids[0]);
        return nation ? flagSrc(nation) : '';
      })
      .attr('xlink:href', function() { return d3.select(this).attr('href'); })
      .attr('x', -12).attr('y', -8).attr('width', 24).attr('height', 16)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    const now = performance.now();
    const battles = this.naval ? this.naval.battles.filter(b => now - b.t < 2400) : [];
    g.selectAll('circle.battle-flash').data(battles).join('circle')
      .attr('class', d => 'battle-flash' + (d.landing ? ' landing' : ''))
      .attr('cx', d => proj(d)[0]).attr('cy', d => proj(d)[1]).attr('r', 5)
      .style('opacity', d => Math.max(0, 1 - (now - d.t) / 2400));

    const grid = this.grid;

    if (this.showUnits) {
      const liveUnits = this.units.filter(u => grid.nodeOwner[u.j * grid.cols + u.i] === u.side);
      const sel = g.selectAll('g.battle-unit').data(liveUnits).join(enter => {
        const eg = enter.append('g').attr('class', 'battle-unit');
        eg.append('image').attr('class', 'battle-unit-flag');
        eg.append('text').attr('class', 'battle-unit-label').attr('y', 22).attr('text-anchor', 'middle');
        return eg;
      });
      sel.attr('class', d => 'battle-unit side-' + d.side)
        .attr('transform', d => {
          const s = proj({ x: grid.minX + d.i * grid.dx, y: grid.minY + d.j * grid.dy });
          const zoom = App.currentTransform ? App.currentTransform.k : 1;
          return `translate(${s[0]},${s[1]}) scale(${1 / zoom})`;
        });
      sel.select('image.battle-unit-flag')
        .attr('href', d => {
          const ids = d.side === 0 ? this.sideAIds : this.sideBIds;
          const nation = World.get(ids[0]);
          return nation ? flagSrc(nation) : '';
        })
        .attr('xlink:href', function() { return d3.select(this).attr('href'); })
        .attr('x', -14).attr('y', -10).attr('width', 28).attr('height', 20)
        .attr('preserveAspectRatio', 'xMidYMid meet');
      sel.select('text.battle-unit-label').text(d => d.troops);
    } else {
      g.selectAll('g.battle-unit').remove();
    }
  }
};

/* ---------------------------------------------------------------------------
   PlayerBattle — orchestrates a Player-vs-AI war through the Simulator
   above: opens it automatically when such a war is declared (either
   direction), shows a small HUD over the map, and feeds the result back
   into the normal conquest mechanics via applyWarOutcome (nations.js) when
   the battle concludes. AI-vs-AI wars never touch this — they keep using
   ai.js's existing elapsed-time resolveWar().
   --------------------------------------------------------------------------- */
const PlayerBattle = {
  active: false,
  warKey: null,

  launch(attackerId, defenderId) {
    if (this.active) return false; // one battle at a time
    const warKey = World.warKey(attackerId, defenderId);
    const war = World.wars.get(warKey);
    if (!war) return false;

    this.active = true;
    this.warKey = warKey;
    World.playerBattleLock = true;

    const coalition = (nationId, opposingId) => {
      const nation = World.get(nationId);
      if (!nation) return [nationId];
      return [nationId, ...Array.from(nation.allies).filter(allyId => {
        const ally = World.get(allyId);
        return ally && allyId !== opposingId && !ally.isAtWarWith(opposingId);
      })];
    };
    const attackerSide = coalition(attackerId, defenderId);
    const defenderSide = coalition(defenderId, attackerId);

    const started = Simulator.start(attackerSide, defenderSide, {
      onTick: sim => updateBattleHud(sim),
      onFinish: sim => this._finish(sim, attackerId, defenderId)
    });

    if (!started) {
      // No usable geometry for one side (shouldn't happen with real
      // countries) — fall back to the normal resolver rather than
      // leaving the war stuck in limbo.
      this.active = false; this.warKey = null; World.playerBattleLock = false;
      return false;
    }

    showBattleHud(true);
    updateBattleHud(Simulator);
    const attacker = World.get(attackerId), defender = World.get(defenderId);
    logEvent(`${attacker.name} and ${defender.name} clash on the battlefield.`, attackerId === World.playerId || defenderId === World.playerId);
    return true;
  },

  _finish(sim, attackerId, defenderId) {
    const winnerId = sim._winnerSide === 0 ? attackerId : defenderId;
    const loserId = winnerId === attackerId ? defenderId : attackerId;
    const winner = World.get(winnerId), loser = World.get(loserId);
    const result = (winner && loser) ? applyWarOutcome(this.warKey, winner, loser) : null;

    Simulator.stop(true);
    showBattleHud(false);
    this.active = false;
    this.warKey = null;
    World.playerBattleLock = false;

    if (result && typeof onWarResolved === 'function') onWarResolved(result);
  }
};

/* ---------------------------------------------------------------------------
   Minimal HUD — army counts, territory split, naval status. No campaign
   naming or war-news dispatch (see file header).
   --------------------------------------------------------------------------- */
function showBattleHud(on) {
  document.getElementById('battle-hud')?.classList.toggle('hidden', !on);
}

function updateBattleHud(sim) {
  const hud = document.getElementById('battle-hud');
  if (!hud || hud.classList.contains('hidden')) return;
  const fmt = n => Math.max(0, Math.round(n || 0)).toLocaleString('en-US');

  document.getElementById('battle-hud-title').textContent = `${sim.attackerName} vs ${sim.victimName}`;
  document.getElementById('battle-hud-att-name').textContent = sim.attackerName;
  document.getElementById('battle-hud-vict-name').textContent = sim.victimName;
  document.getElementById('battle-hud-att-army').textContent = fmt(sim.attackerArmy);
  document.getElementById('battle-hud-vict-army').textContent = fmt(sim.victimArmy);

  const { pa, pv } = sim._territoryControl ? sim._territoryControl() : { pa: 50, pv: 50 };
  document.getElementById('battle-hud-bar-fill').style.width = pa + '%';

  let status = `Territory: ${pa}% / ${pv}%`;
  if (sim.naval) {
    if (sim.navalEdge > 8) status += ` · ${sim.attackerName} holds the sea`;
    else if (sim.navalEdge < -8) status += ` · ${sim.victimName} holds the sea`;
    else status += ' · naval battle even';
  }
  document.getElementById('battle-hud-status').textContent = status;
}

function executeGameCommand(command) {
  const text = String(command || '').trim();
  const strengthMatch = text.match(/^\/strength\s+(\d+)$/i);
  if (strengthMatch) {
    if (!Simulator.active || Simulator.finished || !World.playerId) {
      return { ok: false, message: 'No active battle.' };
    }
    const amount = Math.min(Number(strengthMatch[1]), 1000000000);
    const playerIsAttacker = Simulator.sideAIds.includes(World.playerId);
    const playerIsDefender = Simulator.sideBIds.includes(World.playerId);
    if (!playerIsAttacker && !playerIsDefender) {
      return { ok: false, message: 'The player is not in this battle.' };
    }
    if (playerIsAttacker) Simulator.attackerArmy = amount;
    else Simulator.victimArmy = amount;
    updateBattleHud(Simulator);
    return { ok: true, message: `Strength set to ${amount.toLocaleString('en-US')}.` };
  }

  const annexMatch = text.match(/^\/annex\s+(?:\(\s*)?["']?(.+?)["']?\s*\)?$/i);
  if (annexMatch) {
    const player = World.get(World.playerId);
    const targetName = annexMatch[1].trim().replace(/^["']|["']$/g, '');
    const target = World.allNations().find(n =>
      n.id !== World.playerId && (n.name.toLowerCase() === targetName.toLowerCase() ||
        n.displayName.toLowerCase() === targetName.toLowerCase()));
    if (!player) return { ok: false, message: 'Start a game first.' };
    if (!target) return { ok: false, message: `Nation not found: ${targetName}` };
    if (target.colonizerId === player.id) return { ok: false, message: `${target.name} is already yours.` };
    const result = applyWarOutcome(World.warKey(player.id, target.id), player, target);
    if (typeof onWarResolved === 'function') onWarResolved(result);
    return { ok: true, message: `${target.name} annexed.` };
  }

  return { ok: false, message: 'Use /strength <amount> or /annex (\'Nation Name\').' };
}

window.executeGameCommand = executeGameCommand;

