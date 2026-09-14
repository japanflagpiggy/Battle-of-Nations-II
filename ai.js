/* ============================================================================
   ai.js
   Per-turn AI behaviour for every non-player, non-colony nation.
   Military aggression is deliberately constrained: an AI nation will only
   ever consider declaring war on a country that is a current land neighbor
   or a coastal/sea-reachable neighbor (World.effectiveNeighbors). That
   neighbor set expands automatically after a conquest, since a newly-won
   colony's own borders become part of the conqueror's frontier.
   ============================================================================ */

const AI = {

  runTurn() {
    const nations = World.playableNations().filter(n => n.id !== World.playerId);
    const colonies = World.allNations().filter(n => n.isColony);

    colonies.forEach(n => this.colonyTick(n));
    nations.forEach(n => this.economyTick(n));
    nations.forEach(n => this.diplomacyTick(n));
    nations.forEach(n => this.militaryTick(n));
    nations.forEach(n => this.focusTick(n));

    this.resolveFinishedWars();
  },

  /* A colony can't act on its own — it only generates income, which flows
     entirely to whichever nation conquered it. */
  colonyTick(nation) {
    const income = nation.incomePerTurn();
    const owner = World.get(nation.colonizerId);
    if (owner) {
      owner.treasury += income;
    } else {
      nation.treasury += income;
    }
    if (nation.stability < 40) nation.stability = Math.min(40, nation.stability + 0.1);
  },

  economyTick(nation) {
    const incomeFactor = 0.9 + (nation.ideology.economy / 100) * 0.2; // markets make more
    nation.treasury += nation.incomePerTurn() * incomeFactor;
    // small stability drift back toward 50 (unrest settles, but slowly)
    if (nation.stability < 50) nation.stability = Math.min(50, nation.stability + 0.15);
    if (nation.stability > 50) nation.stability = Math.max(50, nation.stability - 0.05);
    nation.politicalPower += nation.politicalPowerPerTurn * governmentPowerFactor(nation);
    driftIdeology(nation);

    // occasional autonomous economic decisions
    if (Math.random() < 0.03 && nation.treasury > nation.gdp * 0.02) {
      nation.taxRate = Math.max(0.1, Math.min(0.45, nation.taxRate + (Math.random() < 0.5 ? -0.02 : 0.02)));
    }
  },

  diplomacyTick(nation) {
    const neighbors = Array.from(World.effectiveNeighbors(nation.id));
    if (neighbors.length === 0) return;

    // Improve relations with a random neighbor now and then (favouring
    // those with a broadly compatible ideology)
    if (Math.random() < 0.15) {
      const weighted = neighbors.slice().sort((a, b) =>
        ideologyDistance(nation.ideology, World.get(a)?.ideology || { economy: 50, authority: 50, culture: 50 })
        -
        ideologyDistance(nation.ideology, World.get(b)?.ideology || { economy: 50, authority: 50, culture: 50 }));
      const targetId = weighted[Math.floor(Math.random() * Math.min(3, weighted.length))];
      if (Diplomacy.canImproveRelations(nation.id, targetId)) {
        Diplomacy.improveRelations(nation.id, targetId);
      }
    }

    // AI nations form alliances with one another, but ask the player first.
    neighbors.forEach(targetId => {
      if (Math.random() >= 0.005 || !Diplomacy.canAlly(nation.id, targetId)) return;
      if (targetId === World.playerId) {
        nation.pendingAllianceOffers.add(targetId);
        nation.allianceCooldowns[targetId] = World.time + 7200;
        if (typeof showAllianceProposal === 'function') showAllianceProposal(nation.id);
      } else {
        Diplomacy.requestAlliance(nation.id, targetId);
      }
    });

    // Fund allies who are struggling
    nation.allies.forEach(allyId => {
      const ally = World.get(allyId);
      if (ally && ally.treasury < ally.gdp * 0.02 && Math.random() < 0.2) {
        const amount = Math.min(nation.treasury * 0.05, 200);
        Diplomacy.sendFunds(nation.id, allyId, amount);
      }
    });
  },

  militaryTick(nation) {
    if (nation.atWarWith.size > 0) return; // focus on the war you're already in
    if (Math.random() > nation.aggressiveness * 0.05) return; // aggressiveness gates war frequency (Reduced from 0.12)

    const candidates = Array.from(World.effectiveNeighbors(nation.id)).filter(targetId => {
      if (!Diplomacy.canDeclareWar(nation.id, targetId)) return false;
      const target = World.get(targetId);
      if (!target) return false;
      // Don't pick fights with allies of your own allies casually
      if (nation.isAlliedWith(targetId)) return false;
      // Don't attack friends
      if (nation.relationWith(targetId) > 0) return false;
      return true;
    });
    if (candidates.length === 0) return;

    // Prefer targets this nation can plausibly beat
    const myStrength = nation.effectiveMilitaryStrength();
    const scored = candidates.map(id => {
      const target = World.get(id);
      const theirStrength = target.effectiveMilitaryStrength();
      let favorability = myStrength / Math.max(1, theirStrength);
      // ideological rivalry makes war more tempting against distant regimes
      const dist = ideologyDistance(nation.ideology, target.ideology);
      favorability += (dist / 300) * 1.2;
      return { id, favorability };
    }).sort((a, b) => b.favorability - a.favorability);

    const best = scored[0];
    // Only actually go through with it if reasonably favorable, or nation is very aggressive
    if (best.favorability >= 1.5 || (best.favorability >= 1.1 && nation.aggressiveness > 0.5)) {
      if (Diplomacy.declareWar(nation.id, best.id)) {
        // AI declaring on the player is a Player-vs-AI war too — hand it
        // to the Simulator Mode battle instead of the abstract resolver.
        if (best.id === World.playerId && typeof PlayerBattle !== 'undefined') {
          PlayerBattle.launch(nation.id, best.id);
        }
      }
    }
  },

  focusTick(nation) {
    if (nation.isColony) return;
    if (!nation.activeFocus) {
      if (nation.id === World.playerId) return;
      const next = pickNextFocus(nation);
      if (next) {
        beginFocus(nation, next);
      }
      return;
    }
    nation.activeFocus.msRemaining -= TICK_MS;
    if (nation.activeFocus.msRemaining <= 0) {
      nation.completedFocuses.add(nation.activeFocus.id);
      const branch = existingFocusBranch(nation.activeFocus.id);
      applyFocusIdeology(nation, branch);
      nation.activeFocus = null;
    }
  },

  resolveFinishedWars() {
    World.wars.forEach((war, key) => {
      // Player-vs-AI wars are settled by the Simulator Mode battle
      // (battle-sim.js), not by elapsed time — never resolve them here,
      // and never resolve the same war twice.
      if (war.isPlayerWar) return;
      if (World.time - war.startTime >= WAR_DURATION_MS) {
        const result = resolveWar(key, war);
        if (result && typeof onWarResolved === 'function') {
          onWarResolved(result);
        }
      }
    });
  }
};

function beginFocus(nation, node) {
  if (!nation || !node || nation.activeFocus || nation.completedFocuses.has(node.id)) return false;
  if (nation.politicalPower < node.cost) return false;
  nation.politicalPower -= node.cost;
  nation.activeFocus = {
    id: node.id,
    msRemaining: node.days * TICK_MS,
    daysTotal: node.days,
    cost: node.cost
  };
  return true;
}

/* Simple heuristic focus picker: AI leans toward whichever branch best
   matches its current weak point, with some randomness. */
function existingFocusBranch(nodeId) {
  const branch = FocusTree.find(b => b.nodes.some(n => n.id === nodeId));
  return branch?.branch;
}

/* Completing a whole-idea branch shifts the nation's ideology accordingly. */
function applyFocusIdeology(nation, branch) {
  if (!branch) return;
  if (branch === 'economy') shiftIdeology(nation, { economy: 4, authority: 1 });
  else if (branch === 'military') shiftIdeology(nation, { authority: -4, culture: -2 });
  else if (branch === 'diplomatic') shiftIdeology(nation, { culture: 4, authority: 2 });
}

function pickNextFocus(nation) {
  const tree = FocusTree; // defined in main.js
  const available = [];
  tree.forEach(branch => {
    branch.nodes.forEach((node, idx) => {
      if (nation.completedFocuses.has(node.id)) return;
      const prereq = idx === 0 || nation.completedFocuses.has(branch.nodes[idx - 1].id);
      if (prereq) available.push(node);
    });
  });
  if (available.length === 0) return null;

  // weight toward economic focuses if treasury is low, military if weaker than average, else random
  let weighted = available;
  if (nation.treasury < nation.gdp * 0.03) {
    weighted = available.filter(n => n.branch === 'economy');
  } else if (nation.aggressiveness > 0.5) {
    weighted = available.filter(n => n.branch === 'military');
  }
  if (weighted.length === 0) weighted = available;
  return weighted[Math.floor(Math.random() * weighted.length)];
}
