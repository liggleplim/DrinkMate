/* DrinkMate visual layer: layered illustrated cup.
   Owned by Claude. Read-only consumer of window.DrinkMate and its events.
   Never writes drink state. Colors come from data/visual/<chainId>.visual.json. */
(function () {
  "use strict";
  var DM = window.DrinkMate;
  var root = document.getElementById("cup-root");
  if (!DM || !root) { return; }

  var NS = "http://www.w3.org/2000/svg";
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Cup geometry (viewBox units)
  var LIQ_BOTTOM = 286, LIQ_TOP = 78, LIQ_H = LIQ_BOTTOM - LIQ_TOP; // 208
  var OUTER = "M50,70 L210,70 L190,278 Q188,292 174,292 L86,292 Q72,292 70,278 Z";
  var INNER = "M56,78 L204,78 L186,276 Q184,286 172,286 L88,286 Q76,286 74,276 Z";
  var LEVEL = { light: 1, regular: 2, extra: 3 };

  var chain = null, visual = null, chainId = null, loading = false;
  var prev = { baseId: null, temp: null };
  var layerEls = {};   // key -> {el, y, h}
  var sigs = {};       // group name -> signature
  var raf = 0, tweens = [];

  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    if (attrs) { for (var k in attrs) { e.setAttribute(k, attrs[k]); } }
    if (parent) { parent.appendChild(e); }
    return e;
  }
  function find(list, id) {
    if (!list) { return null; }
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }
  function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function mix(a, b, t) {
    var x = hex2rgb(a), y = hex2rgb(b), o = [];
    for (var i = 0; i < 3; i++) { o.push(Math.round(x[i] + (y[i] - x[i]) * t)); }
    return "rgb(" + o.join(",") + ")";
  }
  function rgbToHex(c) { // accepts hex or rgb(); returns hex
    if (c.charAt(0) === "#") { return c; }
    var m = c.match(/\d+/g);
    return "#" + m.map(function (n) { return ("0" + (+n).toString(16)).slice(-2); }).join("");
  }
  function innerLeft(y) { return 56 + (y - 78) * (18 / 198); }
  function innerRight(y) { return 204 - (y - 78) * (18 / 198); }

  // ---------- Static SVG skeleton ----------
  var svg = el("svg", { viewBox: "0 -50 260 350", role: "img", "aria-label": "Your drink", class: "cup-svg" });
  var defs = el("defs", null, svg);
  var clip = el("clipPath", { id: "cup-clip" }, defs);
  el("path", { d: INNER }, clip);

  var gSteam = el("g", { class: "g-steam" }, svg);
  var gCup = el("g", { class: "g-cup" }, svg);
  var gStraw = el("g", { class: "g-straw" }, gCup);
  el("path", { d: OUTER, class: "cup-back" }, gCup);
  var gClip = el("g", { "clip-path": "url(#cup-clip)" }, gCup);
  var gLiquid = el("g", { class: "g-liquid" }, gClip);
  var gBlend = el("g", { class: "g-blend" }, gCup);
  var gIce = el("g", { class: "g-ice", "clip-path": "url(#cup-clip)" }, gCup);
  el("path", { d: OUTER, class: "cup-glass" }, gCup);
  el("path", { d: "M62,90 L72,262", class: "cup-shine" }, gCup);
  var gHandle = el("g", { class: "g-handle" }, gCup);
  var gFoam = el("g", { class: "g-foam" }, gCup);
  var gWhip = el("g", { class: "g-whip" }, gCup);
  var gDrizzle = el("g", { class: "g-drizzle" }, gCup);
  var gSprinkles = el("g", { class: "g-sprinkles" }, gCup);
  var gPour = el("g", { class: "g-pour" }, gCup);
  el("ellipse", { cx: 130, cy: 296, rx: 78, ry: 6, class: "cup-shadow" }, svg).parentNode.insertBefore(
    svg.lastChild, gSteam);
  root.appendChild(svg);

  var caption = document.getElementById("cup-caption");

  // ---------- Tween helper ----------
  function ease(t) { return 1 - Math.pow(1 - t, 3); }
  function tweenTo(rec, y, h, ms, done) {
    var y0 = rec.y, h0 = rec.h;
    if (reduce || ms === 0) { rec.y = y; rec.h = h; apply(rec); if (done) { done(); } return; }
    tweens = tweens.filter(function (t) { return t.rec !== rec; });
    tweens.push({ rec: rec, y0: y0, h0: h0, y1: y, h1: h, t0: performance.now(), ms: ms, done: done });
    if (!raf) { raf = requestAnimationFrame(step); }
  }
  function apply(rec) {
    rec.el.setAttribute("y", rec.y.toFixed(2));
    rec.el.setAttribute("height", Math.max(0, rec.h).toFixed(2));
  }
  function step(now) {
    var live = [];
    tweens.forEach(function (t) {
      var p = Math.min(1, (now - t.t0) / t.ms), e = ease(p);
      t.rec.y = t.y0 + (t.y1 - t.y0) * e;
      t.rec.h = t.h0 + (t.h1 - t.h0) * e;
      apply(t.rec);
      if (p < 1) { live.push(t); } else if (t.done) { t.done(); }
    });
    tweens = live;
    raf = live.length ? requestAnimationFrame(step) : 0;
  }

  // ---------- Model ----------
  function levelNum(m) { return m.count != null ? m.count : (LEVEL[m.level] || 0); }

  function build(state) {
    var base = find(chain.bases, state.baseId);
    var milk = state.milkId ? find(chain.milks, state.milkId) : null;
    var vb = (visual && visual.bases && visual.bases[state.baseId]) || {};
    var vm = (visual && visual.milks && state.milkId && visual.milks[state.milkId]) || {};
    var out = {
      temp: state.temperature,
      baseName: base ? base.name : "",
      baseColor: vb.colorHex || "#6b4129",
      milkColor: milk ? (vm.colorHex || "#f5ebdb") : null,
      shots: 0, shotColor: "#2e1a10",
      mix: [], foam: null, whip: null, drizzle: [], toppings: []
    };
    (state.modifiers || []).forEach(function (m) {
      var def = find(chain.modifiers, m.modifierId);
      var v = (visual && visual.modifiers && visual.modifiers[m.modifierId]) || {};
      var amt = levelNum(m);
      if (!def || !(amt > 0)) { return; }
      var color = v.colorHex || "#c98a3c";
      var layer = v.cupLayer || ({ foam: "foam", drizzle: "drizzle", topping: "top" }[def.type] || "mix");
      if (m.modifierId === "espresso-shot" || def.type === "shot") {
        out.shots += amt; out.shotColor = color;
      } else if (layer === "foam") {
        if (!out.foam || amt >= out.foam.amt) { out.foam = { id: m.modifierId, amt: amt, color: color }; }
      } else if (layer === "drizzle") {
        out.drizzle.push({ id: m.modifierId, amt: amt, color: color });
      } else if (layer === "top") {
        if (m.modifierId.indexOf("whipped") === 0) { out.whip = { amt: amt, color: color }; }
        else { out.toppings.push({ id: m.modifierId, amt: amt, color: color }); }
      } else {
        out.mix.push({ id: m.modifierId, amt: amt, color: color });
      }
    });
    return out;
  }

  // ---------- Liquid layers ----------
  function renderLiquid(m) {
    var hot = m.temp === "hot", blended = m.temp === "blended";
    var total = LIQ_H * (hot ? 0.86 : 0.9);
    var foamH = m.foam ? [0, 12, 20, 30][Math.min(3, m.foam.amt)] : 0;
    var list = [];
    var used = 0;
    if (m.shots > 0) { var h = Math.min(m.shots, 4) * 9 + 6; list.push({ key: "shots", color: m.shotColor, h: h }); used += h; }
    var mixCap = 0;
    m.mix.forEach(function (x) {
      var h = Math.min(x.amt, 6) * 2 + 4;
      if (mixCap + h > 70) { h = Math.max(0, 70 - mixCap); }
      mixCap += h; used += h;
      list.push({ key: "mod:" + x.id, color: x.color, h: h });
    });
    var rest = Math.max(30, total - used - foamH);
    if (blended) {
      var bc = m.milkColor ? mix(rgbToHex(m.baseColor), rgbToHex(m.milkColor), 0.45) : m.baseColor;
      list.push({ key: "body", color: bc, h: rest });
    } else if (m.milkColor) {
      list.push({ key: "base", color: m.baseColor, h: rest * 0.42 });
      list.push({ key: "milk", color: m.milkColor, h: rest * 0.58 });
    } else {
      list.push({ key: "base", color: m.baseColor, h: rest });
    }
    if (m.foam) { list.push({ key: "foam", color: m.foam.color, h: foamH }); }

    var cursor = LIQ_BOTTOM, seen = {};
    list.forEach(function (L) {
      var y = cursor - L.h;
      seen[L.key] = true;
      var rec = layerEls[L.key];
      if (!rec) {
        var r = el("rect", { x: 40, width: 180, class: "liq" }, gLiquid);
        rec = layerEls[L.key] = { el: r, y: cursor, h: 0 };
        apply(rec);
      }
      rec.el.setAttribute("fill", L.color);
      tweenTo(rec, y, L.h, 520);
      cursor = y;
    });
    Object.keys(layerEls).forEach(function (k) {
      if (seen[k]) { return; }
      var rec = layerEls[k];
      delete layerEls[k];
      tweenTo(rec, rec.y + rec.h, 0, 320, function () { if (rec.el.parentNode) { rec.el.parentNode.removeChild(rec.el); } });
    });
    return { top: cursor, foamH: foamH };
  }

  // Rebuild a decorative group only when its signature changed
  function group(name, g, sig, fn) {
    if (sigs[name] === sig) { return; }
    sigs[name] = sig;
    while (g.firstChild) { g.removeChild(g.firstChild); }
    if (sig !== "") { fn(g); }
  }

  function renderIce(m) {
    group("ice", gIce, m.temp === "iced" ? "iced" : "", function (g) {
      var spots = [[88, 112, 20, -8], [128, 100, 22, 6], [166, 118, 20, 10], [104, 150, 22, 4], [150, 156, 21, -6], [124, 196, 20, 8], [92, 214, 18, -10], [164, 208, 19, 7]];
      spots.forEach(function (s, i) {
        var c = el("g", { class: "ice-cube", style: "animation-delay:" + (i * 0.12) + "s", transform: "translate(" + s[0] + " " + s[1] + ") rotate(" + s[3] + ")" }, g);
        var inner = el("g", { class: "ice-bob", style: "animation-delay:" + (i * 0.37) + "s" }, c);
        el("rect", { x: -s[2] / 2, y: -s[2] / 2, width: s[2], height: s[2], rx: 4, class: "ice" }, inner);
        el("path", { d: "M" + (-s[2] / 2 + 4) + "," + (-s[2] / 2 + 5) + " l5,0", class: "ice-glint" }, inner);
      });
    });
  }

  function renderBlend(m, top) {
    var on = m.temp === "blended";
    var color = on ? (layerEls.body ? layerEls.body.el.getAttribute("fill") : m.baseColor) : "";
    group("blend", gBlend, on ? "blend:" + color + ":" + Math.round(top) : "", function (g) {
      var y = top, l = innerLeft(y), r = innerRight(y);
      var d = "M" + (l - 2) + "," + (y + 2) + " ";
      var n = 6, w = (r - l + 4) / n;
      for (var i = 0; i < n; i++) {
        var x0 = l - 2 + i * w;
        d += "Q" + (x0 + w / 2) + "," + (y - 16 - (i % 2) * 6) + " " + (x0 + w) + "," + (y + 2) + " ";
      }
      d += "L" + (r + 2) + "," + (y + 12) + " L" + (l - 2) + "," + (y + 12) + " Z";
      el("path", { d: d, fill: color, class: "blend-cloud" }, g);
    });
  }

  function renderFoam(m, top) {
    var sig = m.foam ? m.foam.id + ":" + m.foam.amt + ":" + m.foam.color + ":" + Math.round(top) : "";
    group("foam", gFoam, sig, function (g) {
      var l = innerLeft(top), r = innerRight(top), n = 6, w = (r - l) / n;
      for (var i = 0; i < n; i++) {
        el("circle", { cx: l + w * (i + 0.5), cy: top + 1, r: w * 0.62, fill: m.foam.color, class: "foam-puff", style: "animation-delay:" + (i * 0.05) + "s" }, g);
      }
    });
  }

  function renderWhip(m, top) {
    var sig = m.whip ? "w:" + m.whip.amt + ":" + Math.round(top) : "";
    group("whip", gWhip, sig, function (g) {
      var s = [0, 0.6, 1, 1.3][Math.min(3, m.whip.amt)] || 1;
      var base = top - 2, w = (innerRight(top) - innerLeft(top)) * 0.9, cx = 130;
      var wrap = el("g", { class: "whip-pop" }, g);
      var tiers = [[w, 20 * s], [w * 0.74, 18 * s], [w * 0.48, 16 * s]], y = base;
      tiers.forEach(function (t) {
        el("ellipse", { cx: cx, cy: y - t[1] / 2, rx: t[0] / 2, ry: t[1] / 2 + 3, fill: m.whip.color, class: "whip-tier" }, wrap);
        y -= t[1] * 0.8;
      });
      el("path", { d: "M" + (cx - 7) + "," + (y + 2) + " Q" + cx + "," + (y - 20 * s) + " " + (cx + 7) + "," + (y + 2) + " Z", fill: m.whip.color, class: "whip-tier" }, wrap);
      wrap._topY = y - 8 * s;
    });
  }

  function surfaceY(m, top) {
    if (m.whip) { var s = [0, 0.6, 1, 1.3][Math.min(3, m.whip.amt)] || 1; return top - 38 * s; }
    return top;
  }

  function renderDrizzle(m, top) {
    var sig = m.drizzle.map(function (d) { return d.id + d.amt + d.color; }).join("|") + ":" + Math.round(surfaceY(m, top)) + (m.whip ? "w" : "");
    if (!m.drizzle.length) { sig = ""; }
    group("drizzle", gDrizzle, sig, function (g) {
      var y = m.whip ? surfaceY(m, top) + 22 : top - 2;
      m.drizzle.forEach(function (d, di) {
        var lines = Math.min(d.amt, 3);
        for (var i = 0; i < lines; i++) {
          var yy = y + i * 6 + di * 3, x0 = innerLeft(top) + 14, x1 = innerRight(top) - 14, seg = 8, p = "M" + x0 + "," + yy;
          var n = Math.floor((x1 - x0) / seg);
          for (var k = 1; k <= n; k++) { p += " L" + (x0 + k * seg) + "," + (yy + (k % 2 ? 5 : -2)); }
          el("path", { d: p, stroke: d.color, class: "drizzle-line", pathLength: 1, style: "animation-delay:" + (i * 0.12) + "s" }, g);
        }
      });
    });
  }

  function renderToppings(m, top) {
    var sig = m.toppings.map(function (t) { return t.id + t.amt; }).join("|") + ":" + Math.round(surfaceY(m, top));
    if (!m.toppings.length) { sig = ""; }
    group("sprinkles", gSprinkles, sig, function (g) {
      var y = m.whip ? surfaceY(m, top) + 26 : top - 4;
      var seed = 7;
      function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
      m.toppings.forEach(function (t) {
        var n = [0, 6, 11, 16][Math.min(3, t.amt)] || 11;
        for (var i = 0; i < n; i++) {
          var x = 130 + (rnd() - 0.5) * 100, yy = y + (rnd() - 0.2) * 18;
          el("rect", { x: x, y: yy, width: 5, height: 2.4, rx: 1.2, fill: t.color, transform: "rotate(" + Math.round(rnd() * 180) + " " + x + " " + yy + ")", class: "sprinkle", style: "animation-delay:" + (i * 0.03) + "s" }, g);
        }
      });
    });
  }

  function renderExtras(m) {
    var hot = m.temp === "hot";
    group("steam", gSteam, hot ? "steam" : "", function (g) {
      [100, 130, 160].forEach(function (x, i) {
        el("path", { d: "M" + x + ",58 q-9,-14 0,-26 q9,-12 0,-24", class: "steam-wisp", style: "animation-delay:" + (i * 0.55) + "s" }, g);
      });
    });
    group("handle", gHandle, hot ? "handle" : "", function (g) {
      el("path", { d: "M204,110 C246,104 246,190 192,200", class: "cup-handle" }, g);
    });
    group("straw", gStraw, hot ? "" : "straw", function (g) {
      el("path", { d: "M150,292 L172,-6 L184,-5 L162,292 Z", class: "straw" }, g);
      el("path", { d: "M172,-6 L184,-5 L186,-16 L174,-17 Z", class: "straw-tip" }, g);
    });
  }

  function pour(m) {
    while (gPour.firstChild) { gPour.removeChild(gPour.firstChild); }
    if (reduce) { return; }
    var s = el("rect", { x: 124, y: 20, width: 12, height: 250, rx: 6, fill: m.baseColor, class: "pour-stream" }, gPour);
    setTimeout(function () { if (s.parentNode) { s.parentNode.removeChild(s); } }, 900);
  }

  function sizeScale(state) {
    var sizes = (chain && chain.sizes) || [], idx = 0;
    for (var i = 0; i < sizes.length; i++) { if (sizes[i].id === state.sizeId) { idx = i; } }
    var n = Math.max(1, sizes.length - 1);
    return 0.8 + 0.34 * (idx / n);
  }

  function wiggle() {
    if (reduce) { return; }
    gCup.classList.remove("wiggle");
    void gCup.getBoundingClientRect();
    gCup.classList.add("wiggle");
  }

  // ---------- Update ----------
  var lastSig = "";
  function update(state) {
    if (!chain || !state || loading) { return; }
    var m = build(state);
    var changedBase = prev.baseId !== state.baseId || prev.temp !== state.temperature;
    gCup.style.transform = "scale(" + sizeScale(state).toFixed(3) + ")";
    var info = renderLiquid(m);
    renderIce(m);
    renderBlend(m, info.top - info.foamH * 0 );
    renderFoam(m, info.top);
    renderWhip(m, info.top);
    renderDrizzle(m, info.top);
    renderToppings(m, info.top);
    renderExtras(m);
    svg.setAttribute("class", "cup-svg temp-" + (m.temp || "hot"));
    if (changedBase) { pour(m); wiggle(); }
    prev.baseId = state.baseId; prev.temp = state.temperature;
    if (caption) {
      var sizeDef = find(chain.sizes, state.sizeId);
      caption.textContent = (m.baseName || "") + (sizeDef ? " · " + sizeDef.name : "") + (m.temp ? " · " + m.temp : "");
    }
    var sig = JSON.stringify(state.modifiers) + state.milkId + state.sizeId;
    if (sig !== lastSig && !changedBase) { wiggle(); }
    lastSig = sig;
  }

  function loadVisual(c) {
    chain = c; chainId = c && c.meta && c.meta.id;
    visual = null; loading = true;
    var finish = function () { loading = false; update(DM.getCurrentState()); };
    if (!chainId) { finish(); return; }
    fetch("data/visual/" + chainId + ".visual.json")
      .then(function (r) { if (!r.ok) { throw new Error(r.status); } return r.json(); })
      .then(function (j) { visual = j; })
      .catch(function () { visual = null; }) // neutral fallback colors
      .then(finish);
  }

  document.addEventListener("drinkmate:chainloaded", function (e) { loadVisual(e.detail); });
  document.addEventListener("drinkmate:statechange", function (e) { update(e.detail); });
  if (DM.getCurrentChain && DM.getCurrentChain()) { loadVisual(DM.getCurrentChain()); }
})();
