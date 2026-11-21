/* DrinkMate Phase 1 — plain vanilla JS, no build step, zero runtime AI.
   Data layer, locked drink state contract (schemaVersion 1.0.0), and DOM
   events are exposed for Claude's visual layer. */

(function () {
  "use strict";

  const SCHEMA_VERSION = "1.0.0";
  const STORAGE_KEY = "drinkmate.savedDrinks.v1";

  let chainIndex = [];
  let currentChain = null;
  let currentState = null;
  let hasUnknownDefaults = false;

  // --- Visual-Layer Event Emitters ---

  function emitChainLoaded() {
    document.dispatchEvent(
      new CustomEvent("drinkmate:chainloaded", { detail: currentChain })
    );
  }

  function emitStateChange() {
    document.dispatchEvent(
      new CustomEvent("drinkmate:statechange", { detail: currentState })
    );
  }

  // --- Data & Storage Layer (reusable by visual layer) ---

  async function loadIndex() {
    const res = await fetch("data/index.json");
    if (!res.ok) throw new Error("Could not load data/index.json");
    const data = await res.json();
    chainIndex = Array.isArray(data) ? data : (data.chains || []);
    return chainIndex;
  }

  async function loadChain(chainId) {
    const res = await fetch("data/chains/" + encodeURIComponent(chainId) + ".json");
    if (!res.ok) throw new Error("Could not load chain file for " + chainId);
    currentChain = await res.json();
    emitChainLoaded();
    return currentChain;
  }

  function getSavedDrinks() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function writeSavedDrinks(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "drink-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  function getValidSizesForBaseAndTemp(chain, base, temp) {
    const sizeMap = new Map(chain.sizes.map((s) => [s.id, s]));
    return base.availableSizes
      .map((sid) => sizeMap.get(sid))
      .filter((s) => s && s.supportedTemperatures.includes(temp));
  }

  function getVolumeOz(size, temp) {
    if (size.volumeOzByTemperature && size.volumeOzByTemperature[temp] != null) {
      return size.volumeOzByTemperature[temp];
    }
    return size.volumeOz;
  }

  /**
   * Builds a locked v1.0.0 drink state from a base's defaultRecipe.
   * modifiers[] is ALWAYS the FULL final recipe as totals (never deltas).
   * Missing/null defaults are never guessed; unknownDefaults flag is returned.
   */
  function buildStateFromBase(chain, baseId, requestedTemp, requestedSizeId) {
    const base = chain.bases.find((b) => b.id === baseId) || chain.bases[0];
    const temp = base.supportedTemperatures.includes(requestedTemp)
      ? requestedTemp
      : base.supportedTemperatures[0];

    const validSizes = getValidSizesForBaseAndTemp(chain, base, temp);
    const defaultSize =
      validSizes.find((s) => s.id === requestedSizeId) ||
      validSizes.find((s) => s.id === "grande") ||
      validSizes[0];
    const sizeId = defaultSize.id;

    const mods = [];
    let unknown = false;
    const modDefMap = new Map(chain.modifiers.map((m) => [m.id, m]));

    // 1. Espresso shots from defaultRecipe.shotsByTemperature -> stored as espresso-shot total
    const shotCount =
      base.defaultRecipe &&
      base.defaultRecipe.shotsByTemperature &&
      base.defaultRecipe.shotsByTemperature[temp]
        ? base.defaultRecipe.shotsByTemperature[temp][sizeId]
        : null;

    if (shotCount === null || shotCount === undefined) {
      unknown = true;
    } else if (shotCount > 0 && modDefMap.has("espresso-shot")) {
      mods.push({ modifierId: "espresso-shot", count: shotCount, level: null });
    }

    // 2. Default recipe modifiers
    const recipeMods = (base.defaultRecipe && base.defaultRecipe.modifiers) || [];
    for (const rm of recipeMods) {
      const def = modDefMap.get(rm.modifierId);
      if (!def) continue;
      if (def.selectionMode === "count") {
        const c =
          rm.countByTemperatureAndSize &&
          rm.countByTemperatureAndSize[temp]
            ? rm.countByTemperatureAndSize[temp][sizeId]
            : null;
        if (c === null || c === undefined) {
          unknown = true;
        } else if (c > 0) {
          mods.push({ modifierId: rm.modifierId, count: c, level: null });
        }
      } else if (def.selectionMode === "level" && rm.defaultLevel) {
        mods.push({ modifierId: rm.modifierId, count: null, level: rm.defaultLevel });
      }
    }

    const now = new Date().toISOString();
    const state = {
      id: generateId(),
      name: "",
      chainId: chain.meta.id,
      baseId: base.id,
      sizeId: sizeId,
      temperature: temp,
      milkId: base.defaultRecipe ? base.defaultRecipe.milkId : null,
      modifiers: mods,
      options: null,
      notes: null,
      createdAt: now,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    };

    return { state, unknownDefaults: unknown };
  }

  function saveDrink(state) {
    const drinks = getSavedDrinks();
    const now = new Date().toISOString();
    const record = Object.assign({}, state, {
      name: state.name.trim(),
      notes: state.notes && state.notes.trim() ? state.notes.trim() : null,
      updatedAt: now,
      schemaVersion: SCHEMA_VERSION,
    });
    const idx = drinks.findIndex((d) => d.id === record.id);
    if (idx >= 0) {
      record.createdAt = drinks[idx].createdAt || record.createdAt;
      drinks[idx] = record;
    } else {
      record.createdAt = now;
      drinks.unshift(record);
    }
    writeSavedDrinks(drinks);
    return record;
  }

  function deleteDrink(id) {
    const drinks = getSavedDrinks().filter((d) => d.id !== id);
    writeSavedDrinks(drinks);
    return drinks;
  }

  // --- UI Rendering ---

  const els = {
    loadError: document.getElementById("load-error"),
    tabBtns: document.querySelectorAll(".tab-btn"),
    screenBuilder: document.getElementById("screen-builder"),
    screenSaved: document.getElementById("screen-saved"),
    savedCount: document.getElementById("saved-count"),
    chainSelect: document.getElementById("chain-select"),
    baseSelect: document.getElementById("base-select"),
    tempButtons: document.getElementById("temp-buttons"),
    sizeButtons: document.getElementById("size-buttons"),
    unknownNotice: document.getElementById("unknown-defaults-notice"),
    milkSelect: document.getElementById("milk-select"),
    modifiersList: document.getElementById("modifiers-list"),
    drinkNotes: document.getElementById("drink-notes"),
    drinkName: document.getElementById("drink-name"),
    saveBtn: document.getElementById("save-btn"),
    resetBtn: document.getElementById("reset-btn"),
    saveFeedback: document.getElementById("save-feedback"),
    savedList: document.getElementById("saved-list"),
  };

  function switchTab(tabName) {
    els.tabBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    els.screenBuilder.hidden = tabName !== "builder";
    els.screenSaved.hidden = tabName !== "saved";
    if (tabName === "saved") renderSavedList();
  }

  function updateSavedCount() {
    els.savedCount.textContent = String(getSavedDrinks().length);
  }

  function renderChainOptions() {
    els.chainSelect.innerHTML = "";
    for (const c of chainIndex) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      els.chainSelect.appendChild(opt);
    }
    if (currentChain) els.chainSelect.value = currentChain.meta.id;
  }

  function renderBaseOptions() {
    els.baseSelect.innerHTML = "";
    for (const cat of currentChain.categories) {
      const group = document.createElement("optgroup");
      group.label = cat.name;
      const bases = currentChain.bases.filter((b) => b.categoryId === cat.id);
      for (const b of bases) {
        const opt = document.createElement("option");
        opt.value = b.id;
        opt.textContent = b.name;
        group.appendChild(opt);
      }
      if (group.children.length > 0) els.baseSelect.appendChild(group);
    }
    els.baseSelect.value = currentState.baseId;
  }

  function renderTempAndSizeButtons() {
    const base = currentChain.bases.find((b) => b.id === currentState.baseId);
    els.tempButtons.innerHTML = "";
    for (const t of base.supportedTemperatures) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn" + (currentState.temperature === t ? " active" : "");
      btn.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      btn.addEventListener("click", () => {
        const rebuilt = buildStateFromBase(currentChain, currentState.baseId, t, currentState.sizeId);
        rebuilt.state.id = currentState.id;
        rebuilt.state.name = currentState.name;
        rebuilt.state.notes = currentState.notes;
        currentState = rebuilt.state;
        hasUnknownDefaults = rebuilt.unknownDefaults;
        renderBuilder();
      });
      els.tempButtons.appendChild(btn);
    }

    const validSizes = getValidSizesForBaseAndTemp(currentChain, base, currentState.temperature);
    els.sizeButtons.innerHTML = "";
    for (const sz of validSizes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn" + (currentState.sizeId === sz.id ? " active" : "");
      const oz = getVolumeOz(sz, currentState.temperature);
      btn.textContent = oz != null ? sz.name + " (" + oz + " oz)" : sz.name;
      btn.addEventListener("click", () => {
        const rebuilt = buildStateFromBase(currentChain, currentState.baseId, currentState.temperature, sz.id);
        rebuilt.state.id = currentState.id;
        rebuilt.state.name = currentState.name;
        rebuilt.state.notes = currentState.notes;
        currentState = rebuilt.state;
        hasUnknownDefaults = rebuilt.unknownDefaults;
        renderBuilder();
      });
      els.sizeButtons.appendChild(btn);
    }
  }

  function renderMilkOptions() {
    els.milkSelect.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "No milk";
    els.milkSelect.appendChild(noneOpt);

    for (const m of currentChain.milks) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      els.milkSelect.appendChild(opt);
    }
    els.milkSelect.value = currentState.milkId === null ? "" : currentState.milkId;
  }

  function setCountModifier(modId, newCount) {
    currentState.modifiers = currentState.modifiers.filter((m) => m.modifierId !== modId);
    if (newCount > 0) {
      currentState.modifiers.push({ modifierId: modId, count: newCount, level: null });
    }
    renderModifiers();
    emitStateChange();
  }

  function setLevelModifier(modId, newLevel) {
    currentState.modifiers = currentState.modifiers.filter((m) => m.modifierId !== modId);
    if (newLevel) {
      currentState.modifiers.push({ modifierId: modId, count: null, level: newLevel });
    }
    renderModifiers();
    emitStateChange();
  }

  function renderModifiers() {
    els.modifiersList.innerHTML = "";
    const selectedMap = new Map(currentState.modifiers.map((m) => [m.modifierId, m]));

    for (const mod of currentChain.modifiers) {
      const row = document.createElement("div");
      row.className = "modifier-row";

      const header = document.createElement("div");
      header.className = "modifier-header";
      const nameEl = document.createElement("span");
      nameEl.className = "modifier-name";
      nameEl.textContent = mod.name;
      const metaEl = document.createElement("span");
      metaEl.className = "modifier-meta";
      metaEl.textContent = mod.type + (mod.selectionMode === "count" ? " (" + mod.unit + "s)" : "");
      header.appendChild(nameEl);
      header.appendChild(metaEl);
      row.appendChild(header);

      const sel = selectedMap.get(mod.id);

      if (mod.selectionMode === "count") {
        const count = sel && sel.count ? sel.count : 0;
        const stepper = document.createElement("div");
        stepper.className = "stepper";

        const minus = document.createElement("button");
        minus.type = "button";
        minus.className = "step-btn";
        minus.textContent = "−";
        minus.setAttribute("aria-label", "Decrease " + mod.name);
        minus.disabled = count <= 0;
        minus.addEventListener("click", () => setCountModifier(mod.id, Math.max(0, count - 1)));

        const val = document.createElement("span");
        val.className = "step-value";
        val.textContent = String(count);

        const plus = document.createElement("button");
        plus.type = "button";
        plus.className = "step-btn";
        plus.textContent = "+";
        plus.setAttribute("aria-label", "Increase " + mod.name);
        plus.disabled = mod.maxCount != null && count >= mod.maxCount;
        plus.addEventListener("click", () => {
          const next = count + 1;
          if (mod.maxCount == null || next <= mod.maxCount) setCountModifier(mod.id, next);
        });

        stepper.appendChild(minus);
        stepper.appendChild(val);
        stepper.appendChild(plus);
        row.appendChild(stepper);
      } else {
        const currentLevel = sel ? sel.level : null;
        const levels = [
          { val: null, label: "None" },
          { val: "light", label: "Light" },
          { val: "regular", label: "Regular" },
          { val: "extra", label: "Extra" },
        ];
        const pillRow = document.createElement("div");
        pillRow.className = "pill-row";
        for (const lv of levels) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "pill-btn" + (currentLevel === lv.val ? " active" : "");
          btn.textContent = lv.label;
          btn.addEventListener("click", () => setLevelModifier(mod.id, lv.val));
          pillRow.appendChild(btn);
        }
        row.appendChild(pillRow);
      }

      els.modifiersList.appendChild(row);
    }
  }

  function renderBuilder() {
    renderChainOptions();
    renderBaseOptions();
    renderTempAndSizeButtons();
    els.unknownNotice.hidden = !hasUnknownDefaults;
    renderMilkOptions();
    renderModifiers();
    els.drinkNotes.value = currentState.notes || "";
    els.drinkName.value = currentState.name || "";
    updateSavedCount();
    emitStateChange();
  }

  function summarizeDrink(drink) {
    const parts = [drink.temperature, drink.sizeId, drink.baseId];
    if (drink.milkId) parts.push(drink.milkId);
    else parts.push("no milk");
    if (drink.modifiers && drink.modifiers.length > 0) {
      parts.push(
        drink.modifiers
          .map((m) => (m.count != null ? m.count + "x " + m.modifierId : m.level + " " + m.modifierId))
          .join(", ")
      );
    }
    return parts.join(" · ");
  }

  function renderSavedList() {
    const drinks = getSavedDrinks();
    updateSavedCount();
    els.savedList.innerHTML = "";
    if (drinks.length === 0) {
      const p = document.createElement("p");
      p.className = "empty-state";
      p.textContent = "No saved drinks yet. Build a drink and tap Save Drink.";
      els.savedList.appendChild(p);
      return;
    }
    for (const d of drinks) {
      const card = document.createElement("div");
      card.className = "saved-card";

      const title = document.createElement("h3");
      title.className = "saved-title";
      title.textContent = d.name;

      const summary = document.createElement("p");
      summary.className = "saved-summary";
      summary.textContent = d.chainId + " · " + summarizeDrink(d);

      const actions = document.createElement("div");
      actions.className = "saved-actions";

      const loadBtn = document.createElement("button");
      loadBtn.type = "button";
      loadBtn.className = "btn-secondary";
      loadBtn.textContent = "Load";
      loadBtn.addEventListener("click", async () => {
        if (!currentChain || currentChain.meta.id !== d.chainId) {
          await loadChain(d.chainId);
        }
        currentState = JSON.parse(JSON.stringify(d));
        hasUnknownDefaults = false;
        els.saveFeedback.hidden = true;
        renderBuilder();
        switchTab("builder");
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        deleteDrink(d.id);
        renderSavedList();
      });

      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      card.appendChild(title);
      card.appendChild(summary);
      card.appendChild(actions);
      els.savedList.appendChild(card);
    }
  }

  // --- Event Wiring ---

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  els.chainSelect.addEventListener("change", async () => {
    await loadChain(els.chainSelect.value);
    const built = buildStateFromBase(currentChain, currentChain.bases[0].id, null, null);
    currentState = built.state;
    hasUnknownDefaults = built.unknownDefaults;
    els.saveFeedback.hidden = true;
    renderBuilder();
  });

  els.baseSelect.addEventListener("change", () => {
    const built = buildStateFromBase(currentChain, els.baseSelect.value, currentState.temperature, currentState.sizeId);
    currentState = built.state;
    hasUnknownDefaults = built.unknownDefaults;
    els.saveFeedback.hidden = true;
    renderBuilder();
  });

  els.milkSelect.addEventListener("change", () => {
    currentState.milkId = els.milkSelect.value === "" ? null : els.milkSelect.value;
    emitStateChange();
  });

  els.drinkNotes.addEventListener("input", () => {
    currentState.notes = els.drinkNotes.value.trim() ? els.drinkNotes.value : null;
    emitStateChange();
  });

  els.drinkName.addEventListener("input", () => {
    currentState.name = els.drinkName.value;
    emitStateChange();
  });

  els.resetBtn.addEventListener("click", () => {
    const built = buildStateFromBase(currentChain, currentState.baseId, currentState.temperature, currentState.sizeId);
    built.state.name = currentState.name;
    currentState = built.state;
    hasUnknownDefaults = built.unknownDefaults;
    els.saveFeedback.hidden = true;
    renderBuilder();
  });

  els.saveBtn.addEventListener("click", () => {
    const name = els.drinkName.value.trim();
    if (!name) {
      els.saveFeedback.className = "notice notice-warn";
      els.saveFeedback.textContent = "Give your drink a name before saving.";
      els.saveFeedback.hidden = false;
      return;
    }
    currentState.name = name;
    currentState.notes = els.drinkNotes.value.trim() ? els.drinkNotes.value.trim() : null;
    const saved = saveDrink(currentState);
    currentState = JSON.parse(JSON.stringify(saved));
    updateSavedCount();
    emitStateChange();
    els.saveFeedback.className = "notice notice-ok";
    els.saveFeedback.textContent = "Saved \"" + saved.name + "\" to this device.";
    els.saveFeedback.hidden = false;
  });

  // --- Bootstrap ---

  async function init() {
    try {
      await loadIndex();
      if (chainIndex.length === 0) throw new Error("No chains listed in data/index.json");
      await loadChain(chainIndex[0].id);
      const built = buildStateFromBase(currentChain, currentChain.bases[0].id, null, null);
      currentState = built.state;
      hasUnknownDefaults = built.unknownDefaults;
      renderBuilder();
    } catch (err) {
      els.loadError.hidden = false;
      els.loadError.textContent =
        "Could not load local menu files (" +
        err.message +
        "). Browsers block reading local JSON directly from file:// — start a local server in the project folder with: python -m http.server 8000, then open http://localhost:8000";
    }
  }


  // --- Phase 1.5 ULTRA Additive Helpers (Pricing, Nutrition, Lazy Presets, Surprise Me) ---

  const PRESET_CATEGORIES = [
    { id: "crowd-favorite", name: "Crowd Favorites" },
    { id: "classic-combo", name: "Classic Combos" },
    { id: "secret-menu", name: "Secret Menu" },
  ];

  const presetsCache = new Map(); // chainId -> Promise<Array>
  const presetsListCache = new Map(); // chainId -> Array

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function getDefaultShotsForState(base, temp, sizeId) {
    if (
      base &&
      base.defaultRecipe &&
      base.defaultRecipe.shotsByTemperature &&
      base.defaultRecipe.shotsByTemperature[temp] &&
      base.defaultRecipe.shotsByTemperature[temp][sizeId] != null
    ) {
      return base.defaultRecipe.shotsByTemperature[temp][sizeId];
    }
    return null;
  }

  function getDefaultModMapForState(base, temp, sizeId) {
    const map = new Map();
    const list = (base && base.defaultRecipe && base.defaultRecipe.modifiers) || [];
    for (const rm of list) {
      let count = null;
      if (rm.countByTemperatureAndSize && rm.countByTemperatureAndSize[temp]) {
        count = rm.countByTemperatureAndSize[temp][sizeId];
      }
      map.set(rm.modifierId, { count: count != null ? count : null, level: rm.defaultLevel || null });
    }
    return map;
  }

  function estimatePrice(chainArg, stateArg) {
    const chain = chainArg || currentChain;
    const state = stateArg || currentState;
    if (!chain || !state) {
      return { total: null, basePrice: null, upcharges: [], isEstimate: true, currency: "USD", missingItems: [] };
    }

    const base = chain.bases.find((b) => b.id === state.baseId);
    const milkMap = new Map(chain.milks.map((m) => [m.id, m]));
    const modMap = new Map(chain.modifiers.map((m) => [m.id, m]));
    const missingItems = [];
    const upcharges = [];

    let basePrice = null;
    if (base && base.basePriceBySize && base.basePriceBySize[state.sizeId] != null) {
      basePrice = round2(Number(base.basePriceBySize[state.sizeId]));
    } else if (base) {
      missingItems.push(base.id);
    }

    // Milk upcharge (only if milk changed from base default)
    const defaultMilkId = base && base.defaultRecipe ? base.defaultRecipe.milkId : null;
    if (state.milkId && state.milkId !== defaultMilkId) {
      const milk = milkMap.get(state.milkId);
      if (milk) {
        if (milk.upchargeAmount == null) {
          missingItems.push(milk.id);
        } else if (milk.upchargeAmount > 0) {
          upcharges.push({ id: milk.id, label: milk.name, amount: round2(Number(milk.upchargeAmount)) });
        }
      }
    }

    // Modifier upcharges
    const defaultShots = getDefaultShotsForState(base, state.temperature, state.sizeId);
    const defaultMods = getDefaultModMapForState(base, state.temperature, state.sizeId);
    const baseHasFlavor = Array.from(defaultMods.keys()).some((id) => {
      const m = modMap.get(id);
      return m && (m.type === "syrup" || m.type === "sauce");
    });
    let addedFlavorCharged = false;

    for (const sel of state.modifiers || []) {
      const mod = modMap.get(sel.modifierId);
      if (!mod) continue;

      if (mod.id === "espresso-shot") {
        const baseShots = defaultShots != null ? defaultShots : 0;
        const extraShots = Math.max(0, (sel.count || 0) - baseShots);
        if (extraShots > 0) {
          if (mod.upchargeAmount == null) {
            missingItems.push(mod.id);
          } else if (mod.upchargeAmount > 0) {
            upcharges.push({
              id: mod.id,
              label: extraShots === 1 ? "Extra Espresso Shot" : extraShots + " Extra Espresso Shots",
              amount: round2(extraShots * Number(mod.upchargeAmount)),
            });
          }
        }
        continue;
      }

      const isDefaultMod = defaultMods.has(mod.id);

      // Starbucks US rule (June 2025): adding/swapping syrups in an already flavored drink is free;
      // adding non-Classic syrup/sauce to an unflavored drink is one flat charge ($0.80).
      if (mod.type === "syrup" || mod.type === "sauce") {
        if (isDefaultMod || baseHasFlavor || mod.upchargeAmount === 0) continue;
        if (!addedFlavorCharged) {
          if (mod.upchargeAmount == null) {
            missingItems.push(mod.id);
          } else if (mod.upchargeAmount > 0) {
            upcharges.push({ id: mod.id, label: mod.name, amount: round2(Number(mod.upchargeAmount)) });
            addedFlavorCharged = true;
          }
        }
        continue;
      }

      if (isDefaultMod) continue;

      if (mod.upchargeAmount == null) {
        missingItems.push(mod.id);
      } else if (mod.upchargeAmount > 0) {
        if (mod.pricingModel === "per_unit" && sel.count) {
          upcharges.push({
            id: mod.id,
            label: sel.count + "x " + mod.name,
            amount: round2(sel.count * Number(mod.upchargeAmount)),
          });
        } else {
          upcharges.push({
            id: mod.id,
            label: mod.name,
            amount: round2(Number(mod.upchargeAmount)),
          });
        }
      }
    }

    const upchargeSum = upcharges.reduce((acc, u) => acc + u.amount, 0);
    const total = basePrice != null ? round2(basePrice + upchargeSum) : null;

    return {
      total,
      basePrice,
      upcharges,
      isEstimate: true,
      currency: (chain.meta && chain.meta.currency) || "USD",
      missingItems,
    };
  }

  function estimateNutrition(chainArg, stateArg) {
    const chain = chainArg || currentChain;
    const state = stateArg || currentState;
    const empty = {
      calories: null,
      sugarGrams: null,
      caffeineMg: null,
      fatGrams: null,
      proteinGrams: null,
      isEstimate: true,
      isIncomplete: true,
      missingItems: [],
      basisNote: "No active drink selected.",
    };
    if (!chain || !state) return empty;

    const base = chain.bases.find((b) => b.id === state.baseId);
    const size = chain.sizes.find((s) => s.id === state.sizeId);
    const milkMap = new Map(chain.milks.map((m) => [m.id, m]));
    const modMap = new Map(chain.modifiers.map((m) => [m.id, m]));
    const missingItems = [];
    let isIncomplete = false;
    let customized = false;

    const bn = base && base.nutrition ? base.nutrition : null;
    if (!bn) {
      if (base) missingItems.push(base.id);
      return Object.assign({}, empty, { missingItems, basisNote: "Nutrition unavailable for this base." });
    }

    const fields = ["calories", "sugarGrams", "caffeineMg", "fatGrams", "proteinGrams"];
    const totals = {};
    for (const f of fields) {
      if (bn[f] == null) {
        totals[f] = null;
        isIncomplete = true;
      } else {
        totals[f] = Number(bn[f]);
      }
    }
    if (isIncomplete && base && !missingItems.includes(base.id)) {
      missingItems.push(base.id);
    }

    // Scale relative to Grande (16 oz) when a different size is picked
    const oz = size ? getVolumeOz(size, state.temperature) : 16;
    const sizeScale = oz != null ? oz / 16 : 1;
    const defaultShots = getDefaultShotsForState(base, state.temperature, state.sizeId);
    const isEspressoBase = defaultShots != null && defaultShots > 0;

    if (state.sizeId !== "grande" && sizeScale !== 1) {
      customized = true;
      for (const f of ["calories", "sugarGrams", "fatGrams", "proteinGrams"]) {
        if (totals[f] != null) totals[f] = totals[f] * sizeScale;
      }
      if (!isEspressoBase && totals.caffeineMg != null) {
        totals.caffeineMg = totals.caffeineMg * sizeScale;
      }
    }

    // Milk swap adjustment (approx 8 oz milk in a Grande milk-based drink, scaled by size)
    const defaultMilkId = base.defaultRecipe ? base.defaultRecipe.milkId : null;
    if (state.milkId !== defaultMilkId) {
      customized = true;
      const oldMilk = defaultMilkId ? milkMap.get(defaultMilkId) : null;
      const newMilk = state.milkId ? milkMap.get(state.milkId) : null;
      const milkOzFactor = (state.temperature === "iced" ? 0.75 : 1.0) * sizeScale;
      for (const f of fields) {
        if (totals[f] == null) continue;
        const oldVal = oldMilk && oldMilk.nutrition && oldMilk.nutrition[f] != null ? Number(oldMilk.nutrition[f]) : 0;
        const newVal = newMilk && newMilk.nutrition && newMilk.nutrition[f] != null ? Number(newMilk.nutrition[f]) : 0;
        if ((oldMilk && !oldMilk.nutrition) || (newMilk && !newMilk.nutrition)) {
          isIncomplete = true;
        }
        totals[f] = Math.max(0, totals[f] + (newVal - oldVal) * milkOzFactor);
      }
    }

    // Modifier deltas vs base defaultRecipe
    const defaultMods = getDefaultModMapForState(base, state.temperature, state.sizeId);
    const selectedMap = new Map((state.modifiers || []).map((m) => [m.modifierId, m]));
    const levelMult = { light: 0.5, regular: 1.0, extra: 1.5 };

    // Espresso shot delta
    const selShotsObj = selectedMap.get("espresso-shot");
    const selShots = selShotsObj && selShotsObj.count ? selShotsObj.count : 0;
    const baseGrandeShots =
      base.defaultRecipe &&
      base.defaultRecipe.shotsByTemperature &&
      base.defaultRecipe.shotsByTemperature[state.temperature] &&
      base.defaultRecipe.shotsByTemperature[state.temperature].grande != null
        ? base.defaultRecipe.shotsByTemperature[state.temperature].grande
        : defaultShots != null
        ? defaultShots
        : 0;
    const shotDelta = selShots - baseGrandeShots;
    if (shotDelta !== 0) {
      customized = true;
      const shotDef = modMap.get("espresso-shot");
      if (shotDef && shotDef.nutrition) {
        for (const f of fields) {
          if (totals[f] != null && shotDef.nutrition[f] != null) {
            totals[f] = Math.max(0, totals[f] + shotDelta * Number(shotDef.nutrition[f]));
          }
        }
      }
    }

    // All other modifiers
    const allModIds = new Set([...defaultMods.keys(), ...selectedMap.keys()]);
    allModIds.delete("espresso-shot");
    for (const mid of allModIds) {
      const def = modMap.get(mid);
      if (!def) continue;
      const dMod = defaultMods.get(mid) || null;
      const sMod = selectedMap.get(mid) || null;

      let deltaUnits = 0;
      if (def.selectionMode === "count") {
        const dCount = dMod && dMod.count != null ? dMod.count : 0;
        const sCount = sMod && sMod.count != null ? sMod.count : 0;
        deltaUnits = sCount - dCount;
      } else {
        const dMult = dMod && dMod.level ? levelMult[dMod.level] || 1 : 0;
        const sMult = sMod && sMod.level ? levelMult[sMod.level] || 1 : 0;
        deltaUnits = sMult - dMult;
      }

      if (deltaUnits === 0) continue;
      customized = true;
      if (!def.nutrition) {
        isIncomplete = true;
        if (!missingItems.includes(mid)) missingItems.push(mid);
        continue;
      }
      for (const f of fields) {
        if (totals[f] != null && def.nutrition[f] != null) {
          totals[f] = Math.max(0, totals[f] + deltaUnits * Number(def.nutrition[f]));
        } else if (def.nutrition[f] == null) {
          isIncomplete = true;
        }
      }
    }

    for (const f of fields) {
      if (totals[f] != null) {
        totals[f] = f === "fatGrams" ? Math.round(totals[f] * 2) / 2 : Math.round(totals[f]);
      }
    }

    const basisNote = customized
      ? "Estimated from official Grande baseline (" + bn.basis + ") with size/milk/modifier adjustments."
      : "Official Starbucks Grande recipe (" + bn.basis + ").";

    return {
      calories: totals.calories,
      sugarGrams: totals.sugarGrams,
      caffeineMg: totals.caffeineMg,
      fatGrams: totals.fatGrams,
      proteinGrams: totals.proteinGrams,
      isEstimate: customized || isIncomplete,
      isIncomplete,
      missingItems,
      basisNote,
    };
  }

  function getPresets(chainIdArg) {
    const cid = chainIdArg || (currentChain && currentChain.meta && currentChain.meta.id);
    if (!cid) return Promise.resolve([]);
    if (presetsCache.has(cid)) return presetsCache.get(cid);

    const p = fetch("data/presets/" + encodeURIComponent(cid) + ".presets.json")
      .then((res) => {
        if (!res.ok) return [];
        return res.json();
      })
      .then((data) => {
        const list = data && Array.isArray(data.presets) ? data.presets : [];
        presetsListCache.set(cid, list);
        return list;
      })
      .catch(() => {
        presetsListCache.set(cid, []);
        return [];
      });

    presetsCache.set(cid, p);
    return p;
  }

  async function loadPreset(presetId) {
    if (!currentChain) return false;
    const cid = currentChain.meta.id;
    const list = presetsListCache.has(cid) ? presetsListCache.get(cid) : await getPresets(cid);
    const preset = list.find((p) => p.id === presetId);
    if (!preset || !preset.drinkState) return false;

    const st = JSON.parse(JSON.stringify(preset.drinkState));
    const base = currentChain.bases.find((b) => b.id === st.baseId);
    if (!base) return false;

    // Safely clamp temperature and sizeId if preset ever referenced an unsupported combo
    if (!base.supportedTemperatures.includes(st.temperature)) {
      st.temperature = base.supportedTemperatures[0];
    }
    const validSizes = getValidSizesForBaseAndTemp(currentChain, base, st.temperature);
    if (!validSizes.some((s) => s.id === st.sizeId)) {
      const fallback = validSizes.find((s) => s.id === "grande") || validSizes[0];
      if (fallback) st.sizeId = fallback.id;
    }

    const now = new Date().toISOString();
    st.id = generateId();
    st.createdAt = now;
    st.updatedAt = now;
    st.schemaVersion = SCHEMA_VERSION;

    currentState = st;
    hasUnknownDefaults = false;
    if (els.saveFeedback) els.saveFeedback.hidden = true;
    renderBuilder();
    return true;
  }

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function surpriseMe(options) {
    if (!currentChain || !currentChain.bases.length) return null;
    const opts = options || {};
    const dairyFreeOnly = Boolean(opts.dairyFreeOnly);
    const reqTemp = opts.temperature || null;
    const maxCaf = typeof opts.maxCaffeineMg === "number" ? opts.maxCaffeineMg : null;
    const reqCat = opts.categoryId || null;

    let candidates = currentChain.bases.slice();
    if (reqTemp) candidates = candidates.filter((b) => b.supportedTemperatures.includes(reqTemp));
    if (reqCat) candidates = candidates.filter((b) => b.categoryId === reqCat);
    if (maxCaf != null) {
      candidates = candidates.filter((b) => b.nutrition && b.nutrition.caffeineMg != null && b.nutrition.caffeineMg <= maxCaf);
    }
    if (candidates.length === 0) candidates = currentChain.bases.slice();

    const base = pickRandom(candidates);
    const temp = reqTemp && base.supportedTemperatures.includes(reqTemp)
      ? reqTemp
      : pickRandom(base.supportedTemperatures);
    const validSizes = getValidSizesForBaseAndTemp(currentChain, base, temp);
    const preferredSizes = validSizes.filter((s) => s.id === "tall" || s.id === "grande" || s.id === "venti");
    const size = pickRandom(preferredSizes.length ? preferredSizes : validSizes);

    const built = buildStateFromBase(currentChain, base.id, temp, size.id);
    const st = built.state;
    const modMap = new Map(currentChain.modifiers.map((m) => [m.id, m]));
    const dairyFreeMilks = currentChain.milks.filter((m) => m.isDairyFree === true);

    if (dairyFreeOnly) {
      if (st.milkId) {
        const curMilk = currentChain.milks.find((m) => m.id === st.milkId);
        if (!curMilk || curMilk.isDairyFree !== true) {
          st.milkId = dairyFreeMilks.length ? pickRandom(dairyFreeMilks).id : null;
        }
      }
      st.modifiers = st.modifiers.filter((sel) => {
        const def = modMap.get(sel.modifierId);
        return def && def.isDairyFree === true;
      });
    } else if (st.milkId && Math.random() < 0.35) {
      const altMilks = currentChain.milks.filter((m) => m.id !== "heavy-cream");
      if (altMilks.length) st.milkId = pickRandom(altMilks).id;
    }

    // Add 1 tasty, category-appropriate twist
    const existingIds = new Set(st.modifiers.map((m) => m.modifierId));
    const syrups = currentChain.modifiers.filter(
      (m) => m.type === "syrup" && !existingIds.has(m.id) && (!dairyFreeOnly || m.isDairyFree === true)
    );
    const foams = currentChain.modifiers.filter(
      (m) => m.type === "foam" && !existingIds.has(m.id) && (!dairyFreeOnly || m.isDairyFree === true)
    );

    if (base.categoryId !== "refresher" && syrups.length && Math.random() < 0.65) {
      const sy = pickRandom(syrups);
      st.modifiers.push({ modifierId: sy.id, count: 2, level: null });
      existingIds.add(sy.id);
    }
    if (temp === "iced" && foams.length && Math.random() < 0.45) {
      const fm = pickRandom(foams);
      st.modifiers.push({ modifierId: fm.id, count: null, level: "regular" });
      existingIds.add(fm.id);
    }

    st.name = "";
    currentState = st;
    hasUnknownDefaults = built.unknownDefaults;
    if (els.saveFeedback) els.saveFeedback.hidden = true;
    renderBuilder();
    return currentState;
  }

  // Stable public hook for Claude's visual layer
  window.DrinkMate = {
    SCHEMA_VERSION,
    STORAGE_KEY,
    PRESET_CATEGORIES,
    loadIndex,
    loadChain,
    buildStateFromBase,
    getCurrentChain: () => currentChain,
    getCurrentState: () => currentState,
    getSavedDrinks,
    saveDrink,
    deleteDrink,
    estimatePrice,
    estimateNutrition,
    getPresets,
    loadPreset,
    surpriseMe,
  };



  // Register offline service worker when hosted over HTTPS or localhost (PWA / TWA ready)
  if (
    "serviceWorker" in navigator &&
    (location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1")
  ) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  init();
})();
