/* ============================================================================
   nations.js
   Nation data model, world-state container, color assignment and the
   pure data-layer rules for relations, alliances, wars and colonization.
   No DOM/SVG code lives here — that belongs to main.js.
   ============================================================================ */

const WAR_DURATION_MS = 28800;      // how long a war runs (ms of simulated time) before it's resolved
const TRUCE_DURATION_MS = 21600;    // cooldown after peace before war can be re-declared (ms)
const ALLY_RELATION_THRESHOLD = 50;

/* ---------------------------------------------------------------------------
   Nation class
   --------------------------------------------------------------------------- */
class Nation {
  constructor(id, feature) {
    const p = feature.properties;

    this.id = id;
    this.name = p.ADMIN || p.NAME;
    this.iso2 = (p.ISO_A2 || '').toLowerCase();
    this.flagIso2 = this.iso2;
    this.flagPath = `${this.iso2}.png`;
    this.displayName = this.name;
    this.continent = p.CONTINENT || 'Unknown';
    this.subregion = p.SUBREGION || '';
    this.feature = feature;

    // --- economic / demographic base stats, derived from real-world figures ---
    this.population = Math.max(50000, p.POP_EST || 1000000);
    this.gdp = Math.max(50, p.GDP_MD || 500); // millions USD

    this.treasury = Math.round(this.gdp * (0.08 + Math.random() * 0.05));
    this.taxRate = 0.25; // fraction of GDP collected as income per turn (scaled down)
    this.stability = 55 + Math.round(Math.random() * 20); // 0-100
    this.manpower = Math.round(this.population / 4500) + 10;
    this.manpowerUsed = 0;

    // military strength is an abstracted composite score.
    // The random multiplier used to span 8-14 (a ±37% swing) on top of an
    // already log-compressed size factor, so a small country could easily
    // out-roll a much larger one purely from RNG (e.g. Norway "stronger"
    // than Russia). Tighter spread keeps some variance without letting it
    // override real economic/population size.
    const sizeFactor = Math.log10(this.gdp + this.population / 1000 + 10);
    this.militaryStrength = Math.round(sizeFactor * (10 + Math.random() * 2));
    this.baseMilitaryStrength = this.militaryStrength;

    // political power / national focus tree
    this.politicalPower = 0;
    this.politicalPowerPerTurn = 1 + Math.random() * 0.5;
    this.completedFocuses = new Set();
    this.activeFocus = null;   // { id, msRemaining, daysTotal, cost }

    // ideology model — three spectra, each 0..100:
    //   economy   : 0 = socialist/planned  ... 100 = free-market/capitalist
    //   authority : 0 = authoritarian      ... 100 = democratic/liberal
    //   culture   : 0 = nationalist        ... 100 = internationalist
    this.ideology = {
      economy: 25 + Math.floor(Math.random() * 55),
      authority: 25 + Math.floor(Math.random() * 60),
      culture: 20 + Math.floor(Math.random() * 60)
    };

    // relations: map of otherNationId -> integer -100..100
    this.relations = {};

    // diplomacy / war state
    this.allies = new Set();
    this.allianceCooldowns = {}; // other nation id -> next allowed request time
    this.pendingAllianceOffers = new Set();
    this.atWarWith = new Set();
    this.truceUntil = {}; // otherId -> turn number
    this.aggressiveness = 0.05 + Math.random() * 0.3; // AI trait, 0..~0.35 (Heavily reduced)

    // colonial status
    this.isColony = false;
    this.isUnifiedTerritory = false;
    this.colonizerId = null;
    this.colonies = new Set();

    // visual
    this.color = null; // assigned by assignDistinctColors()
    this.originalColor = null;

    // decisions cooldowns
    this.decisionCooldowns = {};
    this.formedFormables = new Set();
  }

  get isAlive() {
    return true; // nations are never removed, only reduced to colony status
  }

  relationWith(otherId) {
    return this.relations[otherId] || 0;
  }

  adjustRelation(otherId, delta) {
    const cur = this.relationWith(otherId);
    const next = Math.max(-100, Math.min(100, cur + delta));
    this.relations[otherId] = next;
    return next;
  }

  isAlliedWith(otherId) {
    return this.allies.has(otherId);
  }

  isAtWarWith(otherId) {
    return this.atWarWith.has(otherId);
  }

  isInTruceWith(otherId, currentTime) {
    const until = this.truceUntil[otherId];
    return typeof until === 'number' && currentTime < until;
  }

  effectiveMilitaryStrength() {
    let mult = 1;
    if (this.completedFocuses.has('mil_industry')) mult += 0.15;
    if (this.completedFocuses.has('mil_conscription')) mult += 0.12;
    if (this.completedFocuses.has('mil_doctrine')) mult += 0.18;
    if (this.isColony) mult *= 0.4; // colonies can't field real armies
    const stabilityMod = 0.6 + (this.stability / 100) * 0.5;
    return this.militaryStrength * mult * stabilityMod;
  }

  incomePerTurn() {
    let mult = 1;
    if (this.completedFocuses.has('eco_markets')) mult += 0.15;
    if (this.completedFocuses.has('eco_trade')) mult += 0.12;
    if (this.completedFocuses.has('eco_industry')) mult += 0.2;
    let income = (this.gdp * this.taxRate * 0.01) * mult;
    if (this.isColony) income *= 0.35; // colonies produce less on their own
    return income;
  }
}

/* ---------------------------------------------------------------------------
   World state container
   --------------------------------------------------------------------------- */
const World = {
  nations: new Map(),     // id -> Nation
  playerId: null,
  time: 0,                // elapsed simulated time, in ms
  landAdjacency: {},      // id -> Set(id)   (mutable copy, expands on conquest)
  seaAdjacency: {},       // id -> Set(id)
  wars: new Map(),        // warKey "A|B" -> { attacker, defender, startTime, arrowEl }
  running: false,
  speed: 1,               // ticks per real second multiplier

  // True while a Player-vs-AI war is being fought out in Simulator Mode
  // (see battle-sim.js). While set, that specific war is untouchable by
  // the normal elapsed-time war resolver, and the player can't declare or
  // end another war until the battle concludes.
  playerBattleLock: false,

  reset() {
    this.nations.clear();
    this.playerId = null;
    this.time = 0;
    this.landAdjacency = {};
    this.seaAdjacency = {};
    this.wars.clear();
    this.running = false;
    this.playerBattleLock = false;
  },

  // True if this pair is off-limits to normal diplomacy right now because
  // the player is watching a Simulator Mode battle involving one of them.
  isPlayerBattleLocked(a, b) {
    return this.playerBattleLock && (a === this.playerId || b === this.playerId);
  },

  get(id) {
    return this.nations.get(id);
  },

  allNations() {
    return Array.from(this.nations.values());
  },

  playableNations() {
    return this.allNations().filter(n => !n.isColony);
  },

  /* Combined adjacency for a nation: its own land+sea neighbors, PLUS every
     land+sea neighbor of every colony it owns. This is how the frontier
     expands after a conquest (e.g. France -> Algeria -> Mauritania). */
  effectiveNeighbors(id) {
    const nation = this.get(id);
    if (!nation) return new Set();
    const out = new Set();
    const addAllFor = (ownerId) => {
      (this.landAdjacency[ownerId] || new Set()).forEach(x => out.add(x));
      (this.seaAdjacency[ownerId] || new Set()).forEach(x => out.add(x));
    };
    addAllFor(id);
    nation.colonies.forEach(addAllFor);
    out.delete(id);
    nation.colonies.forEach(c => out.delete(c));
    return out;
  },

  /* Land-only version of effectiveNeighbors — a landlocked target can only
     ever be invaded across a shared land border, never by sea. */
  effectiveLandNeighbors(id) {
    const nation = this.get(id);
    if (!nation) return new Set();
    const out = new Set();
    const addLandFor = (ownerId) => (this.landAdjacency[ownerId] || new Set()).forEach(x => out.add(x));
    addLandFor(id);
    nation.colonies.forEach(addLandFor);
    out.delete(id);
    nation.colonies.forEach(c => out.delete(c));
    return out;
  },

  /* True if this nation can project power across water at all — either it
     has its own coastline, or it has conquered a colony that does. A
     landlocked nation gains sea reach the moment it colonizes a coastal
     neighbor. */
  hasCoastalAccess(id) {
    const nation = this.get(id);
    if (!nation) return false;
    if (!LANDLOCKED_IDS.has(id)) return true;
    return Array.from(nation.colonies).some(cid => !LANDLOCKED_IDS.has(cid));
  },

  warKey(a, b) {
    return [a, b].sort().join('|');
  }
};

/* ---------------------------------------------------------------------------
   Building nations from the GeoJSON feature collection
   --------------------------------------------------------------------------- */
function buildNationsFromGeoJSON(featureCollection) {
  const nations = [];
  featureCollection.features.forEach(feature => {
    const id = feature.properties.ID;
    if (!id) return;
    const nation = new Nation(id, feature);
    World.nations.set(id, nation);
    nations.push(nation);
  });
  return nations;
}

// Nations with no coastline at all. adjacency.json's "sea" map has stray
// entries for several of these (an artifact of how it was generated) that
// let AI nations treat a landlocked country as reachable across open water
// (e.g. Romania "sea-adjacent" to landlocked Belarus). Stripped on load so
// effectiveNeighbors() only ever reflects real geography.
const LANDLOCKED_IDS = new Set([
  'AFG','ARM','AND','AUT','AZE','BDI','BFA','BTN','BLR','BOL','BWA','CAF',
  'CHE','CZE','ETH','HUN','KAZ','KGZ','LAO','LIE','LSO','LUX','MKD','MLI',
  'MDA','MNG','MWI','NER','NPL','PRY','RWA','SRB','SSD','SVK','SMR','SWZ',
  'TCD','TJK','TKM','UGA','UZB','VAT','ZMB','ZWE'
]);

function loadAdjacency(adjacencyData) {
  World.landAdjacency = {};
  World.seaAdjacency = {};
  Object.keys(adjacencyData.land || {}).forEach(id => {
    World.landAdjacency[id] = new Set(adjacencyData.land[id]);
  });
  Object.keys(adjacencyData.sea || {}).forEach(id => {
    if (LANDLOCKED_IDS.has(id)) return; // drop bogus sea entries for landlocked nations
    const cleaned = adjacencyData.sea[id].filter(otherId => !LANDLOCKED_IDS.has(otherId));
    World.seaAdjacency[id] = new Set(cleaned);
  });
}

/* ---------------------------------------------------------------------------
   Distinct color assignment
   Requirement: colors must be randomized and never match/resemble a country's
   assigned color. We spread hues evenly around the color wheel with random
   jitter, shuffle the assignment order, and reject any color that ends up
   perceptually close to a neighbor's or another nation's color, regenerating
   until it clears a minimum distance threshold.
   --------------------------------------------------------------------------- */
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function colorDistance(c1, c2) {
  const dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function assignDistinctColors(nations, minDistance = 55) {
  const shuffled = [...nations];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const usedRgb = [];
  const n = shuffled.length;
  const baseSlice = 360 / n;

  shuffled.forEach((nation, idx) => {
    let rgb, hex, attempts = 0;
    do {
      const hue = (idx * baseSlice + Math.random() * baseSlice * 0.9) % 360;
      const sat = 45 + Math.random() * 35;   // 45-80%
      const light = 38 + Math.random() * 22; // 38-60%
      rgb = hslToRgb(hue, sat, light);
      attempts++;
    } while (
      attempts < 40 &&
      usedRgb.some(other => colorDistance(rgb, other) < minDistance)
    );
    usedRgb.push(rgb);
    hex = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
    nation.color = hex;
    nation.originalColor = hex;
  });
}

/* ---------------------------------------------------------------------------
   Diplomacy actions (pure data mutation, called from UI or AI)
   --------------------------------------------------------------------------- */
const Diplomacy = {
  canDeclareWar(attackerId, defenderId) {
    const a = World.get(attackerId), d = World.get(defenderId);
    if (!a || !d || a === d) return false;
    if (a.isColony || d.isColony) return false;
    if (a.isAtWarWith(defenderId)) return false;
    if (a.isAlliedWith(defenderId)) return false;
    if (a.isInTruceWith(defenderId, World.time)) return false;
    if (d.colonizerId === attackerId || a.colonizerId === defenderId) return false;
    if (World.isPlayerBattleLocked(attackerId, defenderId)) return false;
    if (!World.effectiveNeighbors(attackerId).has(defenderId)) return false;
    return true;
  },

  /* Why Declare War is greyed out for geography reasons specifically (null
     if there's no geography problem). Shared by the AI's own candidate
     filtering and the player's UI, so both play by the same rule. */
  warReachabilityReason(attackerId, defenderId) {
    if (World.effectiveNeighbors(attackerId).has(defenderId)) return null;
    if (World.effectiveLandNeighbors(attackerId).has(defenderId)) return null;
    if (!World.hasCoastalAccess(attackerId)) return 'attacker-landlocked';
    if (LANDLOCKED_IDS.has(defenderId)) return 'defender-landlocked';
    return 'too-far';
  },

  declareWar(attackerId, defenderId) {
    if (!this.canDeclareWar(attackerId, defenderId)) return false;
    const a = World.get(attackerId), d = World.get(defenderId);
    a.atWarWith.add(defenderId);
    d.atWarWith.add(attackerId);
    a.allies.delete(defenderId);
    d.allies.delete(attackerId);
    a.adjustRelation(defenderId, -60);
    d.adjustRelation(attackerId, -60);
    World.wars.set(World.warKey(attackerId, defenderId), {
      attacker: attackerId,
      defender: defenderId,
      startTime: World.time,
      // Player-vs-AI wars are fought out in Simulator Mode (battle-sim.js)
      // instead of the abstract elapsed-time resolver below.
      isPlayerWar: (attackerId === World.playerId || defenderId === World.playerId)
    });
    return true;
  },

  canRequestPeace(requesterId, otherId) {
    const r = World.get(requesterId);
    if (!r || !r.isAtWarWith(otherId)) return false;
    if (World.isPlayerBattleLocked(requesterId, otherId)) return false;
    return true;
  },

  requestPeace(requesterId, otherId) {
    if (!this.canRequestPeace(requesterId, otherId)) return false;
    const r = World.get(requesterId), o = World.get(otherId);
    const key = World.warKey(requesterId, otherId);
    World.wars.delete(key);
    r.atWarWith.delete(otherId);
    o.atWarWith.delete(requesterId);
    const truceLen = TRUCE_DURATION_MS - (r.completedFocuses.has('dip_treaties') ? 7200 : 0);
    r.truceUntil[otherId] = World.time + truceLen;
    o.truceUntil[requesterId] = World.time + truceLen;
    return true;
  },

  canImproveRelations(fromId, toId) {
    const f = World.get(fromId);
    if (!f || fromId === toId) return false;
    if (f.isAtWarWith(toId)) return false;
    if (f.isColony || World.get(toId)?.isColony) return false;
    return true;
  },

  improveRelations(fromId, toId) {
    if (!this.canImproveRelations(fromId, toId)) return false;
    const f = World.get(fromId), t = World.get(toId);
    const envoyBonus = f.completedFocuses.has('dip_envoys') ? 4 : 0;
    f.adjustRelation(toId, 8 + envoyBonus + Math.round(Math.random() * 4));
    t.adjustRelation(fromId, 6 + Math.round(Math.random() * 4));
    return true;
  },

  canSendFunds(fromId, toId) {
    return this.canImproveRelations(fromId, toId);
  },

  sendFunds(fromId, toId, amount) {
    const f = World.get(fromId), t = World.get(toId);
    if (!this.canSendFunds(fromId, toId)) return false;
    amount = Math.min(amount, f.treasury);
    if (amount <= 0) return false;
    f.treasury -= amount;
    t.treasury += amount;
    f.adjustRelation(toId, 5);
    t.adjustRelation(fromId, 10);
    return true;
  },

  canAlly(fromId, toId) {
    const f = World.get(fromId), t = World.get(toId);
    if (!f || !t || fromId === toId) return false;
    if (f.isAtWarWith(toId) || f.isColony || t.isColony) return false;
    if (f.isAlliedWith(toId)) return false;
    return (f.allianceCooldowns[toId] || 0) <= World.time;
  },

  allianceScore(fromId, toId) {
    const from = World.get(fromId), to = World.get(toId);
    if (!from || !to) return -100;
    const relations = World.allNations().filter(n => n.id !== fromId && n.id !== toId);
    const averageRelations = relations.length
      ? relations.reduce((sum, n) => sum + from.relationWith(n.id), 0) / relations.length
      : 0;
    const relativeStrength = Math.min(20, Math.max(-20,
      (from.effectiveMilitaryStrength() - to.effectiveMilitaryStrength()) /
      Math.max(1, to.effectiveMilitaryStrength()) * 20));
    const trust = to.relationWith(fromId) * 0.65;
    const diplomacy = averageRelations * 0.2;
    const stability = (from.stability - 50) * 0.25;
    const warPenalty = from.atWarWith.size * 8;
    const allianceBonus = Math.min(10, from.allies.size * 2);
    const focusBonus = from.completedFocuses.has('dip_leadership') ? 8 : 0;
    // like-minded regimes are natural partners — shared ideology smooths an alliance
    const affinity = (1 - ideologyDistance(from.ideology, to.ideology) / 240) * 16;
    return trust + diplomacy + relativeStrength + stability + allianceBonus + focusBonus - warPenalty + affinity;
  },

  requestAlliance(fromId, toId) {
    if (!this.canAlly(fromId, toId)) {
      return { accepted: false, reason: 'That request is not available right now.' };
    }
    const from = World.get(fromId), to = World.get(toId);
    const score = this.allianceScore(toId, fromId);
    from.allianceCooldowns[toId] = World.time + 7200;
    if (score >= 35) {
      from.allies.add(toId);
      to.allies.add(fromId);
      return { accepted: true, score };
    }
    from.adjustRelation(toId, -4);
    return { accepted: false, score, reason: 'Their diplomats declined the alliance.' };
  },

  acceptAllianceOffer(fromId, toId) {
    const from = World.get(fromId), to = World.get(toId);
    if (!from || !to || !from.pendingAllianceOffers.has(toId) || !this.canAlly(toId, fromId)) {
      return { accepted: false, reason: 'That alliance offer is no longer available.' };
    }
    from.pendingAllianceOffers.delete(toId);
    from.allies.add(toId);
    to.allies.add(fromId);
    return { accepted: true };
  },

  formAlliance(fromId, toId) {
    return this.requestAlliance(fromId, toId).accepted;
  },

  declineAllianceOffer(fromId, toId) {
    const from = World.get(fromId), to = World.get(toId);
    if (!from || !to) return;
    from.pendingAllianceOffers.delete(toId);
    to.allianceCooldowns[fromId] = World.time + 10800;
    to.adjustRelation(fromId, -3);
  }
};

/* ---------------------------------------------------------------------------
   War resolution & colonization
   --------------------------------------------------------------------------- */
// Applies the consequences of a decided war (colony conquest, truces,
// freed colonies) given an already-determined winner/loser. Shared by the
// abstract AI-vs-AI resolver below and by battle-sim.js, which determines
// the winner from an actual fought-out Simulator Mode battle instead of a
// single strength roll.
function applyWarOutcome(warKey, winner, loser) {
  // clear war state
  winner.atWarWith.delete(loser.id);
  loser.atWarWith.delete(winner.id);
  winner.truceUntil[loser.id] = World.time + TRUCE_DURATION_MS;
  loser.truceUntil[winner.id] = World.time + TRUCE_DURATION_MS;
  World.wars.delete(warKey);

  // loser becomes a colony of the winner
  loser.isColony = true;
  loser.isUnifiedTerritory = false;
  loser.colonizerId = winner.id;
  loser.flagIso2 = winner.flagIso2;
  loser.flagPath = winner.flagPath;
  loser.displayName = winner.displayName;
  loser.color = winner.color;
  loser.militaryStrength = Math.max(1, Math.round(loser.militaryStrength * 0.3));
  loser.stability = Math.max(10, loser.stability - 25);
  winner.colonies.add(loser.id);

  // the loser's own colonies become free (independence)
  const freed = [];
  loser.colonies.forEach(colId => {
    const col = World.get(colId);
    if (col) {
      col.isColony = false;
      col.isUnifiedTerritory = false;
      col.colonizerId = null;
      col.flagIso2 = col.iso2;
      col.flagPath = `${col.iso2}.png`;
      col.displayName = col.name;
      col.color = col.originalColor; // Restore original color
      col.stability = Math.max(15, col.stability - 10);
      freed.push(colId);
    }
  });
  loser.colonies.clear();

  return { winnerId: winner.id, loserId: loser.id, freed };
}

function resolveWar(warKey, war) {
  const attacker = World.get(war.attacker);
  const defender = World.get(war.defender);
  if (!attacker || !defender) { World.wars.delete(warKey); return null; }

  const coalitionStrength = (leader, enemy) => leader.effectiveMilitaryStrength() +
    Array.from(leader.allies)
      .map(id => World.get(id))
      .filter(ally => ally && !ally.isAtWarWith(enemy.id))
      .reduce((sum, ally) => sum + ally.effectiveMilitaryStrength() * 0.65, 0);
  const attackerPower = coalitionStrength(attacker, defender);
  const defenderPower = coalitionStrength(defender, attacker) * 1.12;
  const attackerWinChance = attackerPower > 0
    ? 1 / (1 + Math.pow(defenderPower / attackerPower, 1.8))
    : 0;
  const winner = Math.random() < attackerWinChance ? attacker : defender;
  const loser = winner === attacker ? defender : attacker;

  return applyWarOutcome(warKey, winner, loser);
}

/* ---------------------------------------------------------------------------
   Government & party model (pure data layer — UI lives in main.js)
   Each nation's ideology derives an ideological party landscape: a spectrum
   of parties with ideal points, whose support rises as the nation's ideology
   drifts toward them. The party with the most support rules.
   --------------------------------------------------------------------------- */
const PartyList = [
  { id: 'communist',       name: 'Communist Party',    short: 'COM', color: '#B5432F', ideal: { economy: 15, authority: 32, culture: 50 } },
  { id: 'socialdem',       name: 'Social Democrats',   short: 'SD',  color: '#C64A5E', ideal: { economy: 42, authority: 64, culture: 55 } },
  { id: 'liberal',         name: 'Liberal Party',      short: 'LIB', color: '#5C9279', ideal: { economy: 62, authority: 78, culture: 72 } },
  { id: 'conservative',    name: 'Conservative Party', short: 'CON', color: '#8A7143', ideal: { economy: 72, authority: 44, culture: 40 } },
  { id: 'nationalfront',   name: 'National Front',     short: 'NF',  color: '#4A4E69', ideal: { economy: 54, authority: 30, culture: 16 } }
];

function ideologyDistance(a, b) {
  return Math.abs(a.economy - b.economy) + Math.abs(a.authority - b.authority) + Math.abs(a.culture - b.culture);
}

/* Each party's share of public support (0-100), derived from how close the
   nation's ideology sits to the party's ideal point. */
function partySupport(nation) {
  const raw = PartyList.map(p => ({ party: p, support: Math.exp(-ideologyDistance(nation.ideology, p.ideal) / 45) }));
  const total = raw.reduce((s, x) => s + x.support, 0) || 1;
  return raw.map(({ party, support }) => ({ party, support, percent: Math.round((support / total) * 100) }))
    .sort((a, b) => b.percent - a.percent);
}

function rulingParty(nation) {
  return partySupport(nation)[0];
}

function governmentForm(nation) {
  const { economy, authority } = nation.ideology;
  if (authority < 35) return economy < 42 ? "People's Republic" : 'Authoritarian State';
  if (authority < 60) return economy < 42 ? 'Parliamentary Republic' : 'Constitutional Republic';
  return economy < 42 ? 'Social Democracy' : 'Liberal Democracy';
}

/* Net effect of government on stability: a ruling party with broad support
   steadies the nation; an unpopular regime breeds unrest. */
function publicApproval(nation) {
  return rulingParty(nation).percent;
}

/* Political power accrues faster in unconstrained (authoritarian) regimes,
   slower in open (democratic) ones. */
function governmentPowerFactor(nation) {
  return 1.4 - (nation.ideology.authority / 100) * 0.8;
}

function shiftIdeology(nation, deltas) {
  const e = nation.ideology;
  ['economy', 'authority', 'culture'].forEach(k => {
    if (deltas[k]) e[k] = Math.max(0, Math.min(100, e[k] + deltas[k]));
  });
  return e;
}

/* Push a nation's ideology toward one party's ideal point — a government
   using its influence (propaganda, purges, reforms) to reshape the party
   landscape. */
function pushPartyBalance(nation, partyId, amount = 8) {
  const party = PartyList.find(p => p.id === partyId);
  if (!party) return false;
  const deltas = {};
  Object.keys(party.ideal).forEach(k => {
    deltas[k] = (party.ideal[k] - nation.ideology[k]) * (amount / 100);
  });
  shiftIdeology(nation, deltas);
  return true;
}

/* General, gentle drift of a nation's ideology between turns. */
function driftIdeology(nation) {
  const e = nation.ideology;
  // fiscal policy pushes the economy axis
  if (nation.taxRate > 0.3) shiftIdeology(nation, { economy: -0.08, authority: -0.05 });
  else if (nation.taxRate < 0.2) shiftIdeology(nation, { economy: 0.08, authority: 0.05 });

  // slow gravitational pull to dead centre
  ['economy', 'authority', 'culture'].forEach(k => {
    if (e[k] < 50) e[k] = Math.min(50, e[k] + 0.02);
    else e[k] = Math.max(50, e[k] - 0.02);
  });

  // stability yields toward the current ruling party's approval
  const approval = publicApproval(nation);
  nation.stability = Math.max(0, Math.min(100, nation.stability + (approval - nation.stability) * 0.0015));
}

/* ---------------------------------------------------------------------------
   Save / load — serializes the entire live world (nations, diplomacy, wars,
   ideology, domination/colony state, player identity) into a plain object.
   The UI (main.js) wraps this as base64 inside a .json file for export, and
   calls deserializeWorldState() on import.
   --------------------------------------------------------------------------- */
function serializeNation(n) {
  return {
    id: n.id, name: n.name, displayName: n.displayName,
    iso2: n.iso2, flagIso2: n.flagIso2, flagPath: n.flagPath,
    continent: n.continent, subregion: n.subregion,
    population: n.population, gdp: n.gdp,
    treasury: n.treasury, taxRate: n.taxRate, stability: n.stability,
    manpower: n.manpower, manpowerUsed: n.manpowerUsed,
    militaryStrength: n.militaryStrength, baseMilitaryStrength: n.baseMilitaryStrength,
    politicalPower: n.politicalPower, politicalPowerPerTurn: n.politicalPowerPerTurn,
    completedFocuses: Array.from(n.completedFocuses),
    activeFocus: n.activeFocus,
    ideology: { ...n.ideology },
    relations: { ...n.relations },
    allies: Array.from(n.allies),
    allianceCooldowns: { ...n.allianceCooldowns },
    pendingAllianceOffers: Array.from(n.pendingAllianceOffers),
    atWarWith: Array.from(n.atWarWith),
    truceUntil: { ...n.truceUntil },
    aggressiveness: n.aggressiveness,
    isColony: n.isColony, isUnifiedTerritory: n.isUnifiedTerritory,
    colonizerId: n.colonizerId, colonies: Array.from(n.colonies),
    color: n.color, originalColor: n.originalColor,
    decisionCooldowns: { ...n.decisionCooldowns },
    formedFormables: Array.from(n.formedFormables)
  };
}

function restoreNation(n, d) {
  n.displayName = d.displayName ?? n.name;
  n.flagIso2 = d.flagIso2 ?? n.iso2;
  n.flagPath = d.flagPath ?? `${n.iso2}.png`;
  n.population = d.population ?? n.population;
  n.gdp = d.gdp ?? n.gdp;
  n.treasury = d.treasury ?? n.treasury;
  n.taxRate = d.taxRate ?? n.taxRate;
  n.stability = d.stability ?? n.stability;
  n.manpower = d.manpower ?? n.manpower;
  n.manpowerUsed = d.manpowerUsed ?? 0;
  n.militaryStrength = d.militaryStrength ?? n.militaryStrength;
  n.baseMilitaryStrength = d.baseMilitaryStrength ?? n.baseMilitaryStrength;
  n.politicalPower = d.politicalPower ?? 0;
  n.politicalPowerPerTurn = d.politicalPowerPerTurn ?? n.politicalPowerPerTurn;
  n.completedFocuses = new Set(d.completedFocuses || []);
  n.activeFocus = d.activeFocus || null;
  n.ideology = d.ideology ? { ...d.ideology } : { economy: 50, authority: 50, culture: 50 };
  n.relations = { ...(d.relations || {}) };
  n.allies = new Set(d.allies || []);
  n.allianceCooldowns = { ...(d.allianceCooldowns || {}) };
  n.pendingAllianceOffers = new Set(d.pendingAllianceOffers || []);
  n.atWarWith = new Set(d.atWarWith || []);
  n.truceUntil = { ...(d.truceUntil || {}) };
  n.aggressiveness = d.aggressiveness ?? 0.05;
  n.isColony = !!d.isColony;
  n.isUnifiedTerritory = !!d.isUnifiedTerritory;
  n.colonizerId = d.colonizerId ?? null;
  n.colonies = new Set(d.colonies || []);
  n.color = d.color || n.color;
  n.originalColor = d.originalColor || n.originalColor;
  n.decisionCooldowns = { ...(d.decisionCooldowns || {}) };
  n.formedFormables = new Set(d.formedFormables || []);
  return n;
}

const SAVE_SCHEMA = 'BATTLE-OF-NATIONS-II-SAVE';
const SAVE_VERSION = 1;

function serializeWorldState() {
  const wars = [];
  World.wars.forEach(war => wars.push({
    attacker: war.attacker,
    defender: war.defender,
    startTime: war.startTime,
    isPlayerWar: !!war.isPlayerWar
  }));
  return {
    schema: SAVE_SCHEMA,
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    time: World.time,
    speed: World.speed,
    playerId: World.playerId,
    running: World.running,
    playerBattleLock: World.playerBattleLock,
    wars,
    nations: World.allNations().map(serializeNation)
  };
}

function deserializeWorldState(save, featuresSource) {
  World.reset();
  const feats = featuresSource && featuresSource.length ? featuresSource
    : Array.from((typeof App !== 'undefined' && App.featureById) ? App.featureById.values() : []);
  if (feats.length) {
    buildNationsFromGeoJSON({ type: 'FeatureCollection', features: feats });
  }
  (save.nations || []).forEach(d => {
    const n = World.get(d.id);
    if (n) restoreNation(n, d);
  });
  World.time = save.time || 0;
  World.speed = save.speed ?? 1;
  World.playerId = save.playerId || null;
  World.running = !!save.running;
  // An in-flight Player-vs-AI battle can't be resumed from a save, so a
  // saved war falls back to the normal elapsed-time resolver.
  World.playerBattleLock = false;
  World.wars.clear();
  (save.wars || []).forEach(war => {
    World.wars.set(World.warKey(war.attacker, war.defender), {
      attacker: war.attacker,
      defender: war.defender,
      startTime: war.startTime || 0,
      isPlayerWar: false
    });
  });
  return true;
}
