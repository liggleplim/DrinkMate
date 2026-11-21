/* DrinkMate visual layer: sleek builder UI (pickers, grouped modifiers).
   Owned by Claude. app.js stays the single owner of drink state: this file only READS
   window.DrinkMate state and drives app.js's own (hidden) controls by clicking them. */
(function () {
  "use strict";
  var DM = window.DrinkMate;
  var stage = document.querySelector(".cup-stage");
  if (!DM || !stage) { return; }

  var $ = function (s) { return document.querySelector(s); };
  var chain = null, visual = null, loading = false, mount = null, lastSig = "";
  var openGroups = {}, baseOpen = false, browseCat = null, prevAmt = {}, milkView = null, presets = null, presetsLoading = false, presetCat = null, surpriseDF = false, pricePill = null, pricePop = null;
  var LEVELS = ["light", "regular", "extra"];
  var GROUPS = [
    ["shot", "Espresso"], ["syrup", "Syrups"], ["sauce", "Sauces"], ["foam", "Cold foams"],
    ["drizzle", "Drizzles"], ["topping", "Toppings"], ["other", "Powders & mix-ins"]
  ];
  var CHEVRON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  var TEMP_ICON = {
    hot: '<path d="M8 19c0-3.2 3-3.2 3-6.4S8 9.4 8 6.2M14 19c0-3.2 3-3.2 3-6.4s-3-3.2-3-6.4"/>',
    iced: '<rect x="5" y="5" width="14" height="14" rx="4"/><path d="M8.5 9h3"/>',
    blended: '<path d="M12 4a8 8 0 1 0 8 8"/><path d="M12 8.2a3.8 3.8 0 1 0 3.8 3.8"/>'
  };

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) { continue; }
        if (k === "class") { e.className = v; }
        else if (k === "style") { e.style.cssText = v; }
        else if (k.slice(0, 2) === "on") { e.addEventListener(k.slice(2), v); }
        else { e.setAttribute(k, v === true ? "" : v); }
      }
    }
    (kids || []).forEach(function (c) {
      if (c == null) { return; }
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function icon(inner, size) {
    var s = document.createElement("span");
    s.className = "ico";
    s.innerHTML = '<svg viewBox="0 0 24 24" width="' + (size || 24) + '" height="' + (size || 24) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
    return s;
  }
  function chev() { var s = document.createElement("span"); s.className = "chev"; s.innerHTML = CHEVRON; return s; }
  var LEAF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19c3-5 6-8 10-10"/></svg>';
  function leaf() { var s = document.createElement("span"); s.className = "leaf"; s.title = "Dairy-free"; s.setAttribute("role", "img"); s.setAttribute("aria-label", "Dairy-free"); s.innerHTML = LEAF; return s; }
  // Milks with isDairyFree = null (unknown) show in both views rather than being guessed.
  function milkInView(m, view) { return m.isDairyFree === null || m.isDairyFree === undefined || (view === "nondairy") === m.isDairyFree; }
  function col(kind, id) {
    var v = visual && visual[kind] && visual[kind][id];
    return (v && v.colorHex) || "#c9a67a";
  }
  function find(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }

  // ---- drive app.js's own controls ----
  function modList() { return $("#modifiers-list"); }
  function clickIn(idx, sel, n) {
    var row = modList() && modList().children[idx];
    var b = row && row.querySelectorAll(sel)[n];
    if (b && !b.disabled) { b.click(); }
  }
  function plusDisabled(idx) {
    var row = modList() && modList().children[idx];
    var b = row && row.querySelectorAll(".step-btn")[1];
    return !b || b.disabled;
  }
  function setSelect(id, value) {
    var s = $(id);
    if (!s) { return; }
    s.value = value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- sections ----
  function baseSection(state) {
    var base = find(chain.bases, state.baseId) || {};
    var cat = find(chain.categories, base.categoryId) || {};
    var curCat = browseCat || base.categoryId;
    var head = h("button", { type: "button", class: "pick-head", "aria-expanded": baseOpen ? "true" : "false", onclick: function () {
      baseOpen = !baseOpen; browseCat = null; build(true);
    } }, [
      h("span", { class: "swatch big", style: "--c:" + col("bases", state.baseId) }),
      h("span", { class: "pick-text" }, [h("span", { class: "pick-title" }, [base.name || "Choose a drink"]), h("span", { class: "pick-sub" }, [cat.name || ""])]),
      chev()
    ]);
    var body = null;
    if (baseOpen) {
      var tabs = h("div", { class: "cat-row" }, chain.categories.map(function (c) {
        var has = chain.bases.some(function (b) { return b.categoryId === c.id; });
        if (!has) { return null; }
        return h("button", { type: "button", class: "cat-chip" + (c.id === curCat ? " on" : ""), onclick: function () { browseCat = c.id; build(true); } }, [c.name]);
      }));
      var grid = h("div", { class: "base-grid" }, chain.bases.filter(function (b) { return b.categoryId === curCat; }).map(function (b) {
        return h("button", { type: "button", class: "base-card" + (b.id === state.baseId ? " on" : ""), style: "--c:" + col("bases", b.id), onclick: function () {
          baseOpen = false; browseCat = null; setSelect("#base-select", b.id);
        } }, [h("span", { class: "swatch", style: "--c:" + col("bases", b.id) }), h("span", { class: "base-name" }, [b.name]), b.isDairyFree === true ? leaf() : null]);
      }));
      body = h("div", { class: "pick-body" }, [tabs, grid]);
    }
    return h("section", { class: "ui-section" + (baseOpen ? " open" : "") }, [head, body]);
  }

  function tempSizeSection() {
    var tempBtns = [].slice.call(document.querySelectorAll("#temp-buttons .pill-btn"));
    var sizeBtns = [].slice.call(document.querySelectorAll("#size-buttons .pill-btn"));
    var temps = h("div", { class: "seg" }, tempBtns.map(function (b) {
      var key = b.textContent.trim().toLowerCase();
      return h("button", { type: "button", class: "seg-btn" + (b.classList.contains("active") ? " on" : ""), "aria-pressed": b.classList.contains("active") ? "true" : "false", onclick: function () { b.click(); } },
        [icon(TEMP_ICON[key] || TEMP_ICON.hot, 24), h("span", null, [b.textContent.trim()])]);
    }));
    var n = Math.max(1, chain.sizes.length - 1);
    var sizes = h("div", { class: "size-row" }, sizeBtns.map(function (b) {
      var txt = b.textContent.trim(), m = txt.match(/^(.*?)\s*\((.*)\)$/);
      var name = m ? m[1] : txt, oz = m ? m[2] : "";
      var idx = 0;
      chain.sizes.forEach(function (s, i) { if (s.name === name) { idx = i; } });
      var sc = 0.5 + 0.5 * (idx / n);
      var cup = document.createElement("span");
      cup.className = "ico cup-ico";
      cup.innerHTML = '<svg viewBox="0 0 40 44" width="34" height="38" aria-hidden="true"><g transform="translate(20 41) scale(' + sc.toFixed(2) + ') translate(-20 -41)"><path d="M7 8h26l-3.2 31H10.2z" fill="currentColor" opacity=".14" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></g></svg>';
      return h("button", { type: "button", class: "size-btn" + (b.classList.contains("active") ? " on" : ""), "aria-pressed": b.classList.contains("active") ? "true" : "false", "aria-label": txt, onclick: function () { b.click(); } },
        [cup, h("span", { class: "size-name" }, [name]), h("span", { class: "size-oz" }, [oz])]);
    }));
    var kids = [temps, sizes];
    var note = $("#unknown-defaults-notice");
    if (note && !note.hidden) { kids.push(h("div", { class: "notice notice-warn" }, [note.textContent.trim()])); }
    return h("section", { class: "ui-section" }, kids);
  }

  function milkSection(state) {
    var cur = state.milkId || "";
    var curDef = cur ? find(chain.milks, cur) : null;
    var view = milkView || (curDef && curDef.isDairyFree === true ? "nondairy" : "dairy");
    var list = chain.milks.filter(function (m) { return milkInView(m, view); });
    var items = [{ id: "", name: "No milk", c: null }].concat(list.map(function (m) { return { id: m.id, name: m.name, c: col("milks", m.id) }; }));
    function sw(key, label) {
      return h("button", { type: "button", class: "seg-mini" + (view === key ? " on" : ""), "aria-pressed": view === key ? "true" : "false", onclick: function () { milkView = key; build(true); } }, [key === "nondairy" ? leaf() : null, label]);
    }
    return h("section", { class: "ui-section" }, [
      h("div", { class: "milk-head" }, [h("div", { class: "ui-label nomargin" }, ["Milk"]), h("div", { class: "seg-mini-wrap" }, [sw("dairy", "Dairy"), sw("nondairy", "Non-dairy")])]),
      h("div", { class: "milk-row" }, items.map(function (it) {
        return h("button", { type: "button", class: "milk-chip" + (it.id === cur ? " on" : ""), "aria-pressed": it.id === cur ? "true" : "false", onclick: function () { milkView = null; setSelect("#milk-select", it.id); } },
          [h("span", { class: "swatch" + (it.c ? "" : " none"), style: it.c ? "--c:" + it.c : "" }), h("span", null, [it.name])]);
      }))
    ]);
  }

  function amountOf(m) { return m ? (m.count != null ? m.count : LEVELS.indexOf(m.level) + 1) : 0; }

  function chip(entry, selMod) {
    var m = entry.m, i = entry.i, on = !!selMod, amt = amountOf(selMod);
    var pulse = prevAmt[m.id] !== undefined && prevAmt[m.id] !== amt;
    prevAmt[m.id] = amt;
    var shortName = m.name.replace(/\s+(Syrup|Sauce|Drizzle|Topping|Cold Foam)$/i, "");
    var c = col("modifiers", m.id);
    var main = h("button", { type: "button", class: "chip-main", "aria-label": (on ? m.name : "Add " + m.name), title: m.name, onclick: function () {
      if (on) { return; }
      if (m.selectionMode === "count") { clickIn(i, ".step-btn", 1); } else { clickIn(i, ".pill-btn", 2); }
    } }, [h("span", { class: "swatch", style: "--c:" + c }), h("span", { class: "chip-name" }, [shortName]), m.isDairyFree === true ? leaf() : null]);
    var kids = [main];
    if (on && m.selectionMode === "count") {
      var maxed = plusDisabled(i);
      var dots = [];
      for (var d = 0; d < Math.min(amt, 8); d++) { dots.push(h("i", null)); }
      kids.push(h("div", { class: "chip-ctl" }, [
        h("button", { type: "button", class: "ctl-btn", "aria-label": "Less " + m.name, onclick: function () { clickIn(i, ".step-btn", 0); } }, ["−"]),
        h("span", { class: "meter" }, [h("span", { class: "dots" }, dots), h("b", null, [String(amt)])]),
        h("button", { type: "button", class: "ctl-btn", "aria-label": "More " + m.name, disabled: maxed, onclick: function () { clickIn(i, ".step-btn", 1); } }, ["+"])
      ]));
    } else if (on) {
      var bars = LEVELS.map(function (lv, k) {
        return h("button", { type: "button", class: "lvl" + (k < amt ? " fill" : ""), "aria-label": lv + " " + m.name, "aria-pressed": (k + 1 === amt) ? "true" : "false", title: lv, onclick: function () { clickIn(i, ".pill-btn", k + 1); } }, [h("i", { style: "height:" + (9 + k * 7) + "px" })]);
      });
      kids.push(h("div", { class: "chip-ctl" }, [
        h("span", { class: "lvl-row" }, bars),
        h("button", { type: "button", class: "ctl-btn clear", "aria-label": "Remove " + m.name, onclick: function () { clickIn(i, ".pill-btn", 0); } }, ["×"])
      ]));
    }
    return h("div", { class: "chip" + (on ? " on" : "") + (pulse ? " pulse" : ""), style: "--c:" + c }, kids);
  }

  function customizeSection(state) {
    var sel = {};
    (state.modifiers || []).forEach(function (m) { sel[m.modifierId] = m; });
    var wrap = h("section", { class: "ui-section flush" }, [h("div", { class: "ui-label pad" }, ["Customize"])]);
    GROUPS.forEach(function (g) {
      var items = [];
      chain.modifiers.forEach(function (m, i) { if (m.type === g[0]) { items.push({ m: m, i: i }); } });
      if (!items.length) { return; }
      var chosen = items.filter(function (x) { return sel[x.m.id]; });
      var sec = h("div", { class: "grp" + (openGroups[g[0]] ? " open" : "") });
      var head = h("button", { type: "button", class: "grp-head", "aria-expanded": openGroups[g[0]] ? "true" : "false", onclick: function () {
        openGroups[g[0]] = !openGroups[g[0]];
        sec.classList.toggle("open", openGroups[g[0]]);
        head.setAttribute("aria-expanded", openGroups[g[0]] ? "true" : "false");
      } }, [
        h("span", { class: "grp-title" }, [g[1]]),
        h("span", { class: "grp-dots" }, chosen.slice(0, 6).map(function (x) { return h("i", { style: "background:" + col("modifiers", x.m.id) }); })),
        chosen.length ? h("span", { class: "grp-badge" }, [String(chosen.length)]) : null,
        chev()
      ]);
      var grid = h("div", { class: "chip-grid" }, items.map(function (x) { return chip(x, sel[x.m.id]); }));
      sec.appendChild(head);
      sec.appendChild(h("div", { class: "grp-body" }, [h("div", { class: "grp-inner" }, [grid])]));
      wrap.appendChild(sec);
    });
    return wrap;
  }

  // ---- order phrase ----
  function clean(n) { return n.replace(/[®™]/g, "").replace(/\s+Blended Beverage$/i, "").replace(/\s{2,}/g, " ").trim(); }
  function plural(n, u) { return n + " " + u + (n === 1 ? "" : "s"); }
  function orderPhrase(state) {
    var base = find(chain.bases, state.baseId);
    if (!base) { return ""; }
    var size = find(chain.sizes, state.sizeId);
    var temp = state.temperature && state.temperature !== "hot" ? state.temperature : "";
    var phrase = [size ? size.name : "", temp, clean(base.name)].filter(Boolean).join(" ");
    var milk = state.milkId ? find(chain.milks, state.milkId) : null;
    var defMilk = base.defaultRecipe ? base.defaultRecipe.milkId : null;
    if (milk) { phrase += " with " + clean(milk.name).toLowerCase(); }
    else if (defMilk) { phrase += " with no milk"; }
    var order = ["shot", "syrup", "sauce", "other", "foam", "drizzle", "topping"];
    var mods = (state.modifiers || []).map(function (m, k) { return { sel: m, def: find(chain.modifiers, m.modifierId), k: k }; })
      .filter(function (x) { return x.def; })
      .sort(function (a, b) { var d = order.indexOf(a.def.type) - order.indexOf(b.def.type); return d || a.k - b.k; });
    var parts = mods.map(function (x) {
      var d = x.def, name = clean(d.name).toLowerCase();
      if (x.sel.count != null) {
        var c = x.sel.count;
        if (d.type === "shot" || d.unit === "shot") { return plural(c, "shot"); }
        if (d.unit === "pump" || d.unit === "scoop") { return plural(c, d.unit) + " of " + name; }
        return c + " " + name;
      }
      return (x.sel.level && x.sel.level !== "regular" ? x.sel.level + " " : "") + name;
    });
    return phrase + (parts.length ? ", " + parts.join(", ") : "");
  }

  // ---- barista card (full-screen) ----
  function recipeLines(state) {
    var base = find(chain.bases, state.baseId), size = find(chain.sizes, state.sizeId);
    var milk = state.milkId ? find(chain.milks, state.milkId) : null;
    var lines = [
      { k: "Size", v: size ? size.name : "", c: null },
      { k: "Temp", v: state.temperature || "", c: null },
      { k: "Drink", v: base ? clean(base.name) : "", c: col("bases", state.baseId) },
      { k: "Milk", v: milk ? clean(milk.name) : "No milk", c: milk ? col("milks", milk.id) : null }
    ];
    (state.modifiers || []).forEach(function (m) {
      var d = find(chain.modifiers, m.modifierId);
      if (!d) { return; }
      var v = m.count != null ? String(m.count) + (d.unit === "pump" || d.unit === "scoop" || d.unit === "shot" ? " " + d.unit + (m.count === 1 ? "" : "s") : "") : (m.level.charAt(0).toUpperCase() + m.level.slice(1));
      lines.push({ k: clean(d.name), v: v, c: col("modifiers", d.id) });
    });
    return lines;
  }

  function openBarista() {
    var state = DM.getCurrentState();
    if (!state || !chain) { return; }
    var text = orderPhrase(state);
    var cupSvg = document.querySelector("#cup-root svg");
    var overlay = h("div", { class: "barista", role: "dialog", "aria-modal": "true", "aria-label": "Barista order card" });
    function close() {
      document.body.classList.remove("no-scroll");
      document.removeEventListener("keydown", onKey);
      if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
    }
    function onKey(e) { if (e.key === "Escape") { close(); } }
    var rows = recipeLines(state).map(function (l) {
      return h("li", { class: "bl-row" }, [(l.c || l.k === "Milk") ? h("span", { class: "swatch" + (l.c ? "" : " none"), style: l.c ? "--c:" + l.c : "" }) : h("span", { class: "swatch-gap" }), h("span", { class: "bl-k" }, [l.k]), h("b", { class: "bl-v" }, [l.v])]);
    });
    var cupBox = h("div", { class: "bl-cup" });
    if (cupSvg) { cupBox.appendChild(cupSvg.cloneNode(true)); }
    overlay.appendChild(h("div", { class: "bl-sheet" }, [
      h("div", { class: "bl-top" }, [h("div", { class: "ui-label nomargin" }, ["Show your barista"]), h("button", { type: "button", class: "bl-close", "aria-label": "Close", onclick: close }, ["×"])]),
      cupBox,
      h("p", { class: "bl-say" }, ["\u201C" + text + "\u201D"]),
      h("ul", { class: "bl-list" }, rows)
    ]));
    document.body.appendChild(overlay);
    document.body.classList.add("no-scroll");
    document.addEventListener("keydown", onKey);
  }

  function orderSection(state) {
    var text = orderPhrase(state);
    var copy = h("button", { type: "button", class: "copy-btn", onclick: function () {
      var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, done); return; }
      var ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (e) { /* ignore */ }
      document.body.removeChild(ta); done();
    } }, ["Copy"]);
    return h("section", { class: "ui-section order" }, [
      h("div", { class: "ui-label" }, ["Say this to order"]),
      h("p", { class: "order-phrase" }, ["\u201C" + text + "\u201D"]),
      h("div", { class: "order-actions" }, [copy, h("button", { type: "button", class: "copy-btn solid", onclick: openBarista }, ["Show barista"])])
    ]);
  }

  function syncName(state) {
    var input = $("#drink-name");
    var text = orderPhrase(state);
    if (input && text && input.value !== text) {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ---- presets + Surprise Me (helpers come from app.js; feature-detected) ----
  var PRESET_CATS = { "crowd-favorite": "Crowd favorites", "classic-combo": "Classics", "secret-menu": "Secret menu" };
  var DICE = '<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>';

  function ensurePresets() {
    if (presets || presetsLoading || typeof DM.getPresets !== "function") { return; }
    presetsLoading = true;
    var done = function (list) { presets = Array.isArray(list) ? list : []; presetsLoading = false; build(true); };
    try { Promise.resolve(DM.getPresets()).then(done, function () { done([]); }); } catch (e) { done([]); }
  }

  function presetsSection() {
    var hasSurprise = typeof DM.surpriseMe === "function";
    var list = presets || [];
    if (!hasSurprise && !list.length) { return null; }
    var kids = [];
    if (hasSurprise) {
      kids.push(h("div", { class: "surprise-row" }, [
        h("button", { type: "button", class: "surprise-btn", onclick: function () { try { DM.surpriseMe({ dairyFreeOnly: surpriseDF }); } catch (e) { /* ignore */ } } }, [icon(DICE, 22), h("span", null, ["Surprise me"])]),
        h("button", { type: "button", class: "seg-mini surprise-df" + (surpriseDF ? " on" : ""), "aria-pressed": surpriseDF ? "true" : "false", onclick: function () { surpriseDF = !surpriseDF; build(true); } }, [leaf(), "Dairy-free"])
      ]));
    }
    if (list.length) {
      var cats = [];
      list.forEach(function (p) { if (cats.indexOf(p.category) < 0) { cats.push(p.category); } });
      var cur = presetCat && cats.indexOf(presetCat) >= 0 ? presetCat : cats[0];
      kids.push(h("div", { class: "ui-label", style: "margin-top:14px" }, ["Start from a favorite"]));
      kids.push(h("div", { class: "cat-row" }, cats.map(function (c) {
        return h("button", { type: "button", class: "cat-chip" + (c === cur ? " on" : ""), onclick: function () { presetCat = c; build(true); } }, [PRESET_CATS[c] || c]);
      })));
      kids.push(h("div", { class: "preset-row" }, list.filter(function (p) { return p.category === cur; }).map(function (p) {
        var ds = p.drinkState || {}, dots = [];
        function add(kind, id) { var v = visual && visual[kind] && visual[kind][id]; if (v && v.colorHex) { dots.push(h("i", { style: "background:" + v.colorHex })); } }
        add("bases", ds.baseId); if (ds.milkId) { add("milks", ds.milkId); }
        (ds.modifiers || []).slice(0, 5).forEach(function (m) { add("modifiers", m.modifierId); });
        return h("button", { type: "button", class: "preset-card", onclick: function () { try { DM.loadPreset(p.id); } catch (e) { /* ignore */ } } }, [
          h("span", { class: "preset-dots" }, dots),
          h("span", { class: "preset-name" }, [p.name]),
          h("span", { class: "preset-tag" }, [p.tagline || ""]),
          p.category === "secret-menu" && p.verified === false ? h("span", { class: "preset-unofficial" }, ["Unofficial"]) : null
        ]);
      })));
    }
    return h("section", { class: "ui-section" }, kids);
  }

  // ---- price + nutrition ----
  function itemName(id) {
    var lists = [chain.bases, chain.milks, chain.modifiers];
    for (var i = 0; i < lists.length; i++) { var f = find(lists[i] || [], id); if (f) { return clean(f.name); } }
    return id;
  }
  function money(n, cur) { return (cur === "USD" || !cur ? "$" : "") + Number(n).toFixed(2); }
  function safe(fn, a, b) { try { return typeof fn === "function" ? fn(a, b) : null; } catch (e) { return null; } }

  function updatePrice(state) {
    if (!stage) { return; }
    if (!pricePill) {
      pricePill = h("button", { type: "button", class: "price-pill", hidden: true, "aria-expanded": "false", onclick: function () {
        var open = pricePop.hidden; pricePop.hidden = !open; pricePill.setAttribute("aria-expanded", open ? "true" : "false");
      } });
      pricePop = h("div", { class: "price-pop", hidden: true });
      stage.appendChild(pricePill); stage.appendChild(pricePop);
      document.addEventListener("click", function (e) {
        if (!pricePop.hidden && !pricePop.contains(e.target) && e.target !== pricePill) { pricePop.hidden = true; pricePill.setAttribute("aria-expanded", "false"); }
      });
    }
    var r = safe(DM.estimatePrice, chain, state);
    if (!r) { pricePill.hidden = true; pricePop.hidden = true; return; }
    pricePill.hidden = false;
    pricePill.textContent = r.total == null ? "Price unknown" : "~" + money(r.total, r.currency) + " est.";
    while (pricePop.firstChild) { pricePop.removeChild(pricePop.firstChild); }
    var rows = [];
    if (r.basePrice != null) { rows.push(["Base drink", money(r.basePrice, r.currency)]); }
    (r.upcharges || []).forEach(function (u) { rows.push([u.label, "+" + money(u.amount, r.currency)]); });
    rows.forEach(function (row) { pricePop.appendChild(h("div", { class: "pp-row" }, [h("span", null, [row[0]]), h("b", null, [row[1]])])); });
    if (r.missingItems && r.missingItems.length) { pricePop.appendChild(h("p", { class: "pp-note" }, ["No price data for: " + r.missingItems.map(itemName).join(", ")])); }
    pricePop.appendChild(h("p", { class: "pp-note" }, ["Estimate only. Prices vary by store."]));
  }

  function nutritionSection(state) {
    var r = safe(DM.estimateNutrition, chain, state);
    if (!r) { return null; }
    function val(v, unit) { return v == null ? "\u2013" : String(Math.round(v)) + (unit || ""); }
    var caf = r.caffeineMg == null ? 0 : Math.min(1, r.caffeineMg / 400);
    function tile(label, v, unit) { return h("div", { class: "nut-tile" }, [h("b", null, [val(v, unit)]), h("span", null, [label])]); }
    var kids = [
      h("div", { class: "nut-head" }, [h("div", { class: "ui-label nomargin" }, ["Nutrition"]), h("span", { class: "nut-flag" + (r.isIncomplete ? " warn" : "") }, [r.isIncomplete ? "incomplete est." : (r.isEstimate === false ? "official" : "est.")])]),
      h("div", { class: "caf" }, [
        h("div", { class: "caf-top" }, [h("span", null, ["Caffeine"]), h("b", null, [val(r.caffeineMg, " mg")])]),
        h("div", { class: "caf-bar", role: "img", "aria-label": "Caffeine " + val(r.caffeineMg, " mg") + " of 400 mg daily guideline" }, [h("i", { style: "width:" + Math.round(caf * 100) + "%" })]),
        h("div", { class: "caf-ref" }, ["400 mg/day adult guideline"])
      ]),
      h("div", { class: "nut-grid" }, [tile("Calories", r.calories), tile("Sugar", r.sugarGrams, " g"), tile("Fat", r.fatGrams, " g"), tile("Protein", r.proteinGrams, " g")])
    ];
    if (r.missingItems && r.missingItems.length) { kids.push(h("p", { class: "nut-note" }, ["Missing data for: " + r.missingItems.map(itemName).join(", ")])); }
    if (r.basisNote) { kids.push(h("p", { class: "nut-note" }, [r.basisNote])); }
    return h("section", { class: "ui-section" }, kids);
  }

  // ---- mount + render ----
  function ensureMount() {
    if (mount) { return true; }
    var builder = $("#screen-builder");
    if (!builder) { return false; }
    mount = h("div", { class: "ui-builder", id: "ui-builder" });
    stage.parentNode.insertBefore(mount, stage.nextSibling);
    ["#base-select", "#milk-select", "#modifiers-list"].forEach(function (s) {
      var card = $(s) && $(s).closest(".card");
      if (card) { card.classList.add("legacy"); }
    });
    var nameLabel = document.querySelector('label[for="drink-name"]'), nameInput = $("#drink-name"), saveBtn = $("#save-btn");
    if (nameLabel) { nameLabel.classList.add("legacy"); }
    if (nameInput) { nameInput.classList.add("legacy"); }
    if (saveBtn) { saveBtn.textContent = "Save this order"; }
    var chainSel = $("#chain-select");
    if (chainSel && chainSel.options.length <= 1) {
      var cc = chainSel.closest(".card");
      if (cc) { cc.classList.add("legacy"); }
    }
    document.documentElement.classList.add("ui-enhanced");
    return true;
  }

  function build(force) {
    var state = DM.getCurrentState();
    if (!chain || !state || loading || !ensureMount()) { return; }
    var note = $("#unknown-defaults-notice");
    var sig = JSON.stringify([state.chainId, state.baseId, state.temperature, state.sizeId, state.milkId, state.modifiers, note && !note.hidden, baseOpen, browseCat, milkView, presets && presets.length, presetCat, surpriseDF]);
    if (!force && sig === lastSig) { return; }
    lastSig = sig;
    var keepY = window.scrollY;
    mount.style.minHeight = mount.offsetHeight + "px"; // hold page height so the scroll position cannot clamp
    var keep = {};
    [".milk-row", ".cat-row"].forEach(function (s) { var e = mount.querySelector(s); if (e) { keep[s] = e.scrollLeft; } });
    var frag = document.createDocumentFragment();
    ensurePresets();
    [presetsSection(), baseSection(state), tempSizeSection(), milkSection(state), customizeSection(state), nutritionSection(state), orderSection(state)].forEach(function (n) { if (n) { frag.appendChild(n); } });
    while (mount.firstChild) { mount.removeChild(mount.firstChild); }
    mount.appendChild(frag);
    Object.keys(keep).forEach(function (s) { var e = mount.querySelector(s); if (e) { e.scrollLeft = keep[s]; } });
    if (window.scrollY !== keepY) { window.scrollTo(0, keepY); }
    mount.style.minHeight = "";
    syncName(state);
    updatePrice(state);
    var on = mount.querySelector(".milk-chip.on");
    if (on && keep[".milk-row"] === undefined && on.scrollIntoView) { on.parentNode.scrollLeft = Math.max(0, on.offsetLeft - 40); }
  }

  function loadChain(c) {
    chain = c; visual = null; loading = true; prevAmt = {}; lastSig = "";
    var id = c && c.meta && c.meta.id;
    var done = function () { loading = false; build(true); };
    if (!id) { done(); return; }
    fetch("data/visual/" + id + ".visual.json")
      .then(function (r) { if (!r.ok) { throw new Error(r.status); } return r.json(); })
      .then(function (j) { visual = j; })
      .catch(function () { visual = null; })
      .then(done);
  }


  // ---- saved list: color dots + readable titles ----
  var savedList = $("#saved-list");
  function decorateSaved() {
    if (!savedList || !visual || !chain) { return; }
    var drinks = DM.getSavedDrinks();
    [].forEach.call(savedList.querySelectorAll(".saved-card"), function (card, i) {
      var d = drinks[i];
      if (!d || card.querySelector(".saved-dots") || d.chainId !== (chain.meta && chain.meta.id)) { return; }
      var dots = [];
      function add(kind, id) { var v = visual[kind] && visual[kind][id]; if (v && v.colorHex) { dots.push(h("i", { style: "background:" + v.colorHex })); } }
      add("bases", d.baseId);
      if (d.milkId) { add("milks", d.milkId); }
      (d.modifiers || []).slice(0, 8).forEach(function (m) { add("modifiers", m.modifierId); });
      card.insertBefore(h("div", { class: "saved-dots" }, dots), card.querySelector(".saved-actions"));
    });
  }
  if (savedList && window.MutationObserver) {
    new MutationObserver(function () { decorateSaved(); }).observe(savedList, { childList: true });
  }

  document.addEventListener("drinkmate:chainloaded", function (e) { loadChain(e.detail); });
  document.addEventListener("drinkmate:statechange", function () { build(false); });
  if (DM.getCurrentChain && DM.getCurrentChain()) { loadChain(DM.getCurrentChain()); }
})();
