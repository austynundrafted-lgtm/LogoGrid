// LogoGrid — application UI
(function () {
  "use strict";

  var G = window.LogoGridGeometry;
  var Importer = window.LogoGridImporter;
  var Refine = window.LogoGridRefine;
  var BOOT = window.__LOGOGRID_BOOT__ || {};
  var nativeBridge =
    window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native;

  function post(cmd, payload) {
    if (!nativeBridge) return false;
    var msg = Object.assign({ cmd: cmd }, payload || {});
    nativeBridge.postMessage(msg);
    return true;
  }

  // ===============================================================
  // Settings, presets, persistence
  // ===============================================================

  var PRESETS = {
    Signal: {
      layers: {
        logo: { mode: "solid", color: "#DADADF", opacity: 100, width: 1.5 },
        guidelines: { color: "#FF5A1F", width: 1.25, opacity: 85, dashed: false },
        arcs: { color: "#FF5A1F", width: 1.25, opacity: 85, dashed: false },
        points: { shape: "square", size: 10, fill: "#FFFFFF", stroke: "#FF5A1F", width: 1.5 },
        handles: { color: "#1D1D1F", width: 1, opacity: 60 },
      },
      canvas: { background: "#FFFFFF", transparent: false },
    },
    Classic: {
      layers: {
        logo: { mode: "original", color: "#000000", opacity: 100, width: 1.5 },
        guidelines: { color: "#000000", width: 1, opacity: 100, dashed: false },
        arcs: { color: "#000000", width: 1, opacity: 100, dashed: false },
        points: { shape: "square", size: 12, fill: "#FFFFFF", stroke: "#000000", width: 1 },
        handles: { color: "#000000", width: 1, opacity: 100 },
      },
      canvas: { background: "#FFFFFF", transparent: false },
    },
    Blueprint: {
      layers: {
        logo: { mode: "solid", color: "#FFFFFF", opacity: 16, width: 1.5 },
        guidelines: { color: "#BFD6FF", width: 1, opacity: 70, dashed: false },
        arcs: { color: "#BFD6FF", width: 1, opacity: 70, dashed: true },
        points: { shape: "square", size: 9, fill: "#0B3D91", stroke: "#FFFFFF", width: 1.25 },
        handles: { color: "#FFFFFF", width: 1, opacity: 70 },
      },
      canvas: { background: "#0B3D91", transparent: false },
    },
    Midnight: {
      layers: {
        logo: { mode: "solid", color: "#3A3A40", opacity: 100, width: 1.5 },
        guidelines: { color: "#8E8E93", width: 1, opacity: 100, dashed: false },
        arcs: { color: "#8E8E93", width: 1, opacity: 100, dashed: false },
        points: { shape: "circle", size: 9, fill: "#111113", stroke: "#FF5A1F", width: 1.5 },
        handles: { color: "#FF5A1F", width: 1, opacity: 80 },
      },
      canvas: { background: "#111113", transparent: false },
    },
  };

  var DEFAULT_SETTINGS = mergeDeep(
    {
      layers: {
        logo: { visible: true },
        guidelines: { visible: true },
        arcs: { visible: true },
        points: { visible: true },
        handles: { visible: false },
      },
      canvas: { source: "artboard", padding: 10 },
      detection: {
        minSegmentLength: G.DEFAULT_OPTIONS.minSegmentLength,
        lineAngleTolerance: G.DEFAULT_OPTIONS.lineAngleTolerance,
        lineMergeDistance: G.DEFAULT_OPTIONS.lineMergeDistance,
        minArcLength: G.DEFAULT_OPTIONS.minArcLength,
        minRadius: G.DEFAULT_OPTIONS.minRadius,
        circleMergeTolerance: G.DEFAULT_OPTIONS.circleMergeTolerance * 100,
        circleFitTolerance: G.DEFAULT_OPTIONS.circleFitTolerance * 100,
      },
      pngScale: 2,
    },
    PRESETS.Signal
  );

  var SAMPLE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
    '<path fill="#111" fill-rule="evenodd" d="M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z' +
    'M120 200A80 80 0 1 0 280 200A80 80 0 1 0 120 200Z"/>' +
    '<polygon fill="#111" points="250,40 310,40 150,360 90,360"/>' +
    '<circle fill="#FF5A1F" cx="306" cy="306" r="30"/>' +
    "</svg>";

  function isObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }
  function mergeDeep(target, source) {
    var out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
    Object.keys(source || {}).forEach(function (k) {
      out[k] = isObject(source[k]) && isObject(target[k]) ? mergeDeep(target[k], source[k]) : source[k];
    });
    return out;
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }
  function getPath(obj, path) {
    return path.split(".").reduce(function (o, k) { return o && o[k]; }, obj);
  }
  function setPath(obj, path, value) {
    var keys = path.split(".");
    var last = keys.pop();
    keys.reduce(function (o, k) { return (o[k] = o[k] || {}); }, obj)[last] = value;
  }

  function loadPrefs() {
    if (BOOT.prefs) return BOOT.prefs;
    try {
      return JSON.parse(localStorage.getItem("logogrid.prefs") || "null");
    } catch (e) {
      return null;
    }
  }

  var prefs = loadPrefs() || {};
  var state = {
    settings: mergeDeep(clone(DEFAULT_SETTINGS), prefs.settings || {}),
    customPresets: isObject(prefs.customPresets) ? prefs.customPresets : {},
    doc: null,
    result: null,
    canvas: null,
    zoom: 1,
    hover: null, // id of the setting being explained on the canvas
    // Refine results for the open logo: { inspection, accepted, view, doc, result, moved, previews }
    refine: null,
  };
  var S = state.settings;

  // Settings saved by older versions. Version 2 measures Circle fit against the
  // arc's size (not its radius) with a 2% default, so older values reset.
  var SETTINGS_VERSION = 2;
  if (prefs.settings && (prefs.settings.version || 1) < 2) {
    S.detection.circleFitTolerance = DEFAULT_SETTINGS.detection.circleFitTolerance;
  }
  S.version = SETTINGS_VERSION;

  var saveTimer = null;
  function savePrefs() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var data = { settings: S, customPresets: state.customPresets };
      if (state.doc && state.doc.source.length < 1500000) {
        data.lastFile = { name: state.doc.name, source: state.doc.source };
      }
      var json = JSON.stringify(data);
      if (!post("prefs", { json: json })) {
        try { localStorage.setItem("logogrid.prefs", json); } catch (e) { /* storage unavailable */ }
      }
    }, 400);
  }

  // ===============================================================
  // DOM helpers and controls
  // ===============================================================

  var $ = function (id) { return document.getElementById(id); };

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  var syncers = []; // refresh control values from settings (after presets)
  var conditionals = []; // { el, when }

  function onChange(kind) {
    if (kind === "detect") analyze();
    render();
    updateLayerRows();
    updateConditionals();
    savePrefs();
  }

  function withCondition(el, when) {
    if (when) conditionals.push({ el: el, when: when });
    return el;
  }
  function updateConditionals() {
    conditionals.forEach(function (c) { c.el.hidden = !c.when(); });
  }

  function rangeControl(label, path, min, max, step, format, kind, when) {
    var value = h("span", { class: "value" });
    var input = h("input", { type: "range", min: min, max: max, step: step, "aria-label": label });
    function paint() {
      value.textContent = format(Number(input.value));
      input.style.setProperty("--fill", ((input.value - min) / (max - min)) * 100 + "%");
    }
    input.addEventListener("input", function () {
      setPath(S, path, Number(input.value));
      paint();
      scheduleChange(kind);
    });
    syncers.push(function () { input.value = getPath(S, path); paint(); });
    return withCondition(h("div", { class: "control" }, [h("label", { text: label }), input, value]), when);
  }

  function colorControl(label, path, when) {
    var picker = h("input", { type: "color", "aria-label": label });
    var hex = h("input", { type: "text", class: "hex", maxlength: 7, spellcheck: "false", "aria-label": label + " hex" });
    function apply(v) {
      setPath(S, path, v.toUpperCase());
      scheduleChange("style");
    }
    picker.addEventListener("input", function () { hex.value = picker.value.toUpperCase(); apply(picker.value); });
    hex.addEventListener("change", function () {
      var v = hex.value.trim();
      if (!/^#/.test(v)) v = "#" + v;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      if (/^#[0-9a-f]{6}$/i.test(v)) { picker.value = v; apply(v); }
      hex.value = getPath(S, path);
    });
    syncers.push(function () { var v = getPath(S, path); picker.value = v.toLowerCase(); hex.value = v; });
    return withCondition(
      h("div", { class: "control control-wide" }, [h("label", { text: label }), h("div", { class: "color-field" }, [picker, hex])]),
      when
    );
  }

  function segmentedControl(label, path, options, kind, when) {
    var buttons = options.map(function (o) {
      return h("button", {
        type: "button",
        text: o[1],
        onclick: function () {
          setPath(S, path, o[0]);
          sync();
          onChange(kind);
        },
      });
    });
    function sync() {
      buttons.forEach(function (b, i) { b.classList.toggle("active", options[i][0] === getPath(S, path)); });
    }
    syncers.push(sync);
    return withCondition(
      h("div", { class: "control control-wide" }, [h("label", { text: label }), h("div", { class: "segmented" }, buttons)]),
      when
    );
  }

  function switchControl(label, path, kind, when) {
    var input = h("input", { type: "checkbox", class: "layer-toggle mini-switch", "aria-label": label });
    input.addEventListener("change", function () {
      setPath(S, path, input.checked);
      onChange(kind);
    });
    syncers.push(function () { input.checked = !!getPath(S, path); });
    return withCondition(
      h("div", { class: "control control-wide" }, [h("label", { text: label }), h("div", { class: "switch-row" }, [h("span"), input])]),
      when
    );
  }

  var pendingKind = null;
  function scheduleChange(kind) {
    if (pendingKind === "detect") kind = "detect";
    if (pendingKind) { pendingKind = kind; return; }
    pendingKind = kind;
    requestAnimationFrame(function () {
      var k = pendingKind;
      pendingKind = null;
      onChange(k);
    });
  }

  var px = function (v) { return v + " px"; };
  var pct = function (v) { return Math.round(v) + "%"; };

  var LAYERS = [
    {
      key: "logo", label: "Logo",
      swatch: function (l) { return l.mode === "original" ? null : l.color; },
      controls: function (p) {
        return [
          segmentedControl("Style", p + "mode", [["original", "Original"], ["solid", "Solid"], ["outline", "Outline"]], "style"),
          colorControl("Color", p + "color", function () { return S.layers.logo.mode !== "original"; }),
          rangeControl("Outline", p + "width", 0.25, 8, 0.25, px, "style", function () { return S.layers.logo.mode === "outline"; }),
          rangeControl("Opacity", p + "opacity", 0, 100, 1, pct, "style"),
        ];
      },
    },
    {
      key: "guidelines", label: "Guidelines", count: "lines",
      swatch: function (l) { return l.color; },
      controls: function (p) {
        return [
          colorControl("Color", p + "color"),
          rangeControl("Stroke", p + "width", 0.25, 8, 0.25, px, "style"),
          rangeControl("Opacity", p + "opacity", 0, 100, 1, pct, "style"),
          switchControl("Dashed", p + "dashed", "style"),
        ];
      },
    },
    {
      key: "arcs", label: "Arcs", count: "circles",
      swatch: function (l) { return l.color; },
      controls: function (p) {
        return [
          colorControl("Color", p + "color"),
          rangeControl("Stroke", p + "width", 0.25, 8, 0.25, px, "style"),
          rangeControl("Opacity", p + "opacity", 0, 100, 1, pct, "style"),
          switchControl("Dashed", p + "dashed", "style"),
        ];
      },
    },
    {
      key: "points", label: "Anchor points", count: "points",
      swatch: function (l) { return l.stroke; },
      controls: function (p) {
        return [
          segmentedControl("Shape", p + "shape", [["square", "Square"], ["circle", "Circle"]], "style"),
          rangeControl("Size", p + "size", 2, 40, 1, px, "style"),
          colorControl("Fill", p + "fill"),
          colorControl("Stroke", p + "stroke"),
          rangeControl("Stroke width", p + "width", 0, 6, 0.25, px, "style"),
        ];
      },
    },
    {
      key: "handles", label: "Bézier handles", count: "handles",
      swatch: function (l) { return l.color; },
      controls: function (p) {
        return [
          colorControl("Color", p + "color"),
          rangeControl("Stroke", p + "width", 0.25, 6, 0.25, px, "style"),
          rangeControl("Opacity", p + "opacity", 0, 100, 1, pct, "style"),
        ];
      },
    },
  ];

  var layerRows = {};

  function buildLayers() {
    var container = $("layers");
    LAYERS.forEach(function (def) {
      var toggle = h("input", { type: "checkbox", class: "layer-toggle", "aria-label": "Show " + def.label });
      toggle.addEventListener("change", function () {
        S.layers[def.key].visible = toggle.checked;
        onChange("style");
      });
      syncers.push(function () { toggle.checked = S.layers[def.key].visible; });

      var swatch = h("span", { class: "layer-swatch" });
      var count = h("span", { class: "layer-count" });
      var expand = h("button", { class: "layer-expand", type: "button", "aria-label": "Edit " + def.label + " style" });
      expand.innerHTML = '<svg viewBox="0 0 10 10"><path d="M3 1.5L6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var name = h("span", { class: "layer-name", text: def.label });
      var body = h("div", { class: "layer-body" }, def.controls("layers." + def.key + "."));
      var head = h("div", { class: "layer-head" }, [toggle, name, count, swatch, expand]);
      var row = h("div", { class: "layer" }, [head, body]);
      attachHover(head, "layer." + def.key);

      function toggleOpen() { row.classList.toggle("open"); }
      expand.addEventListener("click", toggleOpen);
      name.addEventListener("click", toggleOpen);

      layerRows[def.key] = { row: row, swatch: swatch, count: count, def: def };
      container.appendChild(row);
    });
  }

  function updateLayerRows() {
    Object.keys(layerRows).forEach(function (key) {
      var r = layerRows[key];
      var layer = S.layers[key];
      r.row.classList.toggle("off", !layer.visible);
      var color = r.def.swatch(layer);
      r.swatch.style.background = color || "conic-gradient(#111 0 25%, #FF5A1F 0 50%, #111 0 75%, #FF5A1F 0)";
      var result = showingRefined() ? state.refine.result : state.result;
      r.count.textContent = r.def.count && result ? result[r.def.count].length : "";
    });
  }

  function buildCanvasControls() {
    var el = $("canvasControls");
    el.appendChild(attachHover(segmentedControl("Bounds", "canvas.source", [["artboard", "Artboard"], ["artwork", "Artwork"]], "detect"), "canvas.source"));
    el.appendChild(attachHover(rangeControl("Padding", "canvas.padding", 0, 60, 1, pct, "detect"), "canvas.padding"));
    el.appendChild(switchControl("Transparent", "canvas.transparent", "style"));
    el.appendChild(colorControl("Background", "canvas.background", function () { return !S.canvas.transparent; }));
  }

  function buildDetectionControls() {
    var el = $("detectionControls");
    var units = function (v) { return v + ""; };
    el.appendChild(attachHover(rangeControl("Min line", "detection.minSegmentLength", 0, 80, 1, units, "detect"), "detection.minSegmentLength"));
    el.appendChild(attachHover(rangeControl("Angle merge", "detection.lineAngleTolerance", 0, 10, 0.5, function (v) { return v + "°"; }, "detect"), "detection.lineAngleTolerance"));
    el.appendChild(attachHover(rangeControl("Line merge", "detection.lineMergeDistance", 0, 30, 0.5, units, "detect"), "detection.lineMergeDistance"));
    el.appendChild(attachHover(rangeControl("Min arc", "detection.minArcLength", 0, 80, 1, units, "detect"), "detection.minArcLength"));
    el.appendChild(attachHover(rangeControl("Min radius", "detection.minRadius", 1, 80, 1, units, "detect"), "detection.minRadius"));
    el.appendChild(attachHover(rangeControl("Circle fit", "detection.circleFitTolerance", 0.1, 5, 0.1, function (v) { return v + "%"; }, "detect"), "detection.circleFitTolerance"));
    el.appendChild(attachHover(rangeControl("Circle merge", "detection.circleMergeTolerance", 0, 20, 0.5, function (v) { return v + "%"; }, "detect"), "detection.circleMergeTolerance"));
    $("resetDetection").addEventListener("click", function () {
      S.detection = clone(DEFAULT_SETTINGS.detection);
      syncAll();
      onChange("detect");
    });
  }

  function syncAll() {
    syncers.forEach(function (fn) { fn(); });
    updateConditionals();
    updateLayerRows();
    $("pngScale").value = String(S.pngScale);
  }

  // Presets

  function styleSnapshot() {
    var layers = {};
    Object.keys(S.layers).forEach(function (k) {
      layers[k] = Object.assign({}, S.layers[k]);
      delete layers[k].visible;
    });
    return { layers: layers, canvas: { background: S.canvas.background, transparent: S.canvas.transparent } };
  }

  function applyPreset(preset) {
    var merged = mergeDeep(S, preset);
    Object.keys(merged).forEach(function (k) { S[k] = merged[k]; });
    syncAll();
    onChange("style");
  }

  function buildPresets() {
    var el = $("presets");
    el.textContent = "";
    function chip(name, preset, removable) {
      var dot = h("span", { class: "chip-dot" });
      dot.style.background = preset.canvas.transparent ? "transparent" : preset.canvas.background;
      dot.style.setProperty("--line", preset.layers.guidelines.color);
      var c = h("button", { class: "chip", type: "button", title: "Apply " + name }, [dot, h("span", { text: name })]);
      c.addEventListener("click", function () { applyPreset(preset); toast("Applied " + name); });
      if (removable) {
        var x = h("span", { class: "chip-remove", role: "button", "aria-label": "Delete " + name, text: "×" });
        x.addEventListener("click", function (e) {
          e.stopPropagation();
          delete state.customPresets[name];
          buildPresets();
          savePrefs();
        });
        c.appendChild(x);
      }
      el.appendChild(c);
    }
    Object.keys(PRESETS).forEach(function (n) { chip(n, PRESETS[n], false); });
    Object.keys(state.customPresets).forEach(function (n) { chip(n, state.customPresets[n], true); });
    var add = h("button", { class: "chip chip-add", type: "button", text: "+ Save current" });
    add.addEventListener("click", function () {
      $("savePresetForm").hidden = false;
      $("presetName").value = "";
      $("presetName").focus();
    });
    el.appendChild(add);
  }

  $("savePresetForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var name = $("presetName").value.trim();
    if (!name) return;
    state.customPresets[name] = styleSnapshot();
    $("savePresetForm").hidden = true;
    buildPresets();
    savePrefs();
    toast("Saved preset “" + name + "”");
  });
  $("cancelPreset").addEventListener("click", function () { $("savePresetForm").hidden = true; });

  // ===============================================================
  // Analysis and rendering
  // ===============================================================

  function computeCanvas() {
    var doc = state.doc;
    var base = S.canvas.source === "artwork" ? doc.artBounds : doc.artboard;
    var size = Math.max(base.w, base.h) || 100;
    var w = base.w || size, h2 = base.h || size;
    var pad = (size * S.canvas.padding) / 100;
    return { x: base.x - (w - base.w) / 2 - pad, y: base.y - (h2 - base.h) / 2 - pad, w: w + pad * 2, h: h2 + pad * 2 };
  }

  function analyze() {
    if (!state.doc) return;
    state.canvas = computeCanvas();
    var d = S.detection;
    var options = {
      minSegmentLength: d.minSegmentLength,
      lineAngleTolerance: d.lineAngleTolerance,
      lineMergeDistance: d.lineMergeDistance,
      minArcLength: d.minArcLength,
      minRadius: d.minRadius,
      circleMergeTolerance: d.circleMergeTolerance / 100,
      circleFitTolerance: d.circleFitTolerance / 100,
    };
    state.result = G.analyze(state.doc.paths, state.canvas, state.doc.artBounds, options);
    // The refined logo is measured against the original's bounds, so the canvas doesn't shift.
    if (state.refine && state.refine.doc) {
      state.refine.result = G.analyze(state.refine.doc.paths, state.canvas, state.doc.artBounds, options);
    }
  }

  // Compare and Refined show (and export) the refined logo.
  function showingRefined() {
    return !!(state.refine && state.refine.doc && state.refine.view !== "original");
  }

  function f(n) {
    return String(Math.round(n * 1000) / 1000);
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  // One builder for preview and export, so what you see is what you save.
  // Preview-only options (used while hovering a setting):
  //   dim     { Logo: 0.5, Guidelines: 0.15, ... } opacity multipliers per group
  //   show    group id to draw even if its layer is switched off
  //   overlay extra SVG markup drawn on top
  function buildSVG(options) {
    var opts = options || {};
    var refined = showingRefined() && !opts.original;
    var doc = refined ? state.refine.doc : state.doc;
    var r = refined ? state.refine.result : state.result;
    var cv = state.canvas, L = S.layers;
    function shown(layer, id) { return layer.visible || opts.show === id; }
    function opacity(id, value) {
      var dim = opts.dim && opts.dim[id] != null ? opts.dim[id] : 1;
      return f((value / 100) * dim);
    }
    // Style sizes are "pixels on a canvas whose longest side is 1000px".
    var u = Math.max(cv.w, cv.h) / 1000;
    var out = [];
    out.push(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'viewBox="' + [f(cv.x), f(cv.y), f(cv.w), f(cv.h)].join(" ") + '" ' +
      'width="' + f(cv.w / u) + '" height="' + f(cv.h / u) + '">'
    );
    if (!S.canvas.transparent) {
      out.push('<rect id="Background" x="' + f(cv.x) + '" y="' + f(cv.y) + '" width="' + f(cv.w) + '" height="' + f(cv.h) + '" fill="' + S.canvas.background + '"/>');
    }

    if (shown(L.logo, "Logo")) {
      var op = opacity("Logo", L.logo.opacity);
      if (L.logo.mode === "original" && doc.originalMarkup) {
        out.push('<g id="Logo" opacity="' + op + '">' + doc.originalMarkup + "</g>");
      } else if (L.logo.mode === "original") {
        // A reshaped logo has no original markup; draw each shape in its own paint.
        out.push('<g id="Logo" opacity="' + op + '">');
        doc.elements.forEach(function (el) {
          var fill = el.fill == null ? L.logo.color : el.fill;
          out.push(
            '<path d="' + el.d + '" fill="' + escapeAttr(fill) + '"' +
            (el.fillRule === "evenodd" ? ' fill-rule="evenodd"' : "") +
            (el.fillOpacity < 1 ? ' fill-opacity="' + f(el.fillOpacity) + '"' : "") +
            (el.stroke ? ' stroke="' + escapeAttr(el.stroke) + '" stroke-width="' + f(el.strokeWidth) + '"' : "") + "/>"
          );
        });
        out.push("</g>");
      } else {
        var outline = L.logo.mode === "outline";
        out.push(
          '<g id="Logo" opacity="' + op + '" ' +
          (outline
            ? 'fill="none" stroke="' + L.logo.color + '" stroke-width="' + f(L.logo.width * u) + '" stroke-linejoin="round">'
            : 'fill="' + L.logo.color + '">')
        );
        doc.elements.forEach(function (el) {
          out.push('<path d="' + el.d + '"' + (el.fillRule === "evenodd" && !outline ? ' fill-rule="evenodd"' : "") + "/>");
        });
        out.push("</g>");
      }
    }

    function strokeGroup(id, layer) {
      return (
        '<g id="' + id + '" fill="none" stroke="' + layer.color + '" stroke-width="' + f(layer.width * u) + '" opacity="' + opacity(id, layer.opacity) + '"' +
        (layer.dashed ? ' stroke-dasharray="' + f(6 * u) + " " + f(4 * u) + '"' : "") + ">"
      );
    }

    if (shown(L.arcs, "Arcs") && r.circles.length) {
      out.push(strokeGroup("Arcs", L.arcs));
      r.circles.forEach(function (c) {
        out.push('<circle cx="' + f(c.cx) + '" cy="' + f(c.cy) + '" r="' + f(c.r) + '"/>');
      });
      out.push("</g>");
    }

    if (shown(L.guidelines, "Guidelines") && r.lines.length) {
      out.push(strokeGroup("Guidelines", L.guidelines));
      r.lines.forEach(function (l) {
        out.push('<line x1="' + f(l[0][0]) + '" y1="' + f(l[0][1]) + '" x2="' + f(l[1][0]) + '" y2="' + f(l[1][1]) + '"/>');
      });
      out.push("</g>");
    }

    if (shown(L.handles, "Handles") && r.handles.length) {
      var hl = L.handles;
      var dot = f(Math.max(2, hl.width * 2) * u);
      out.push('<g id="Handles" stroke="' + hl.color + '" stroke-width="' + f(hl.width * u) + '" fill="' + hl.color + '" opacity="' + opacity("Handles", hl.opacity) + '">');
      r.handles.forEach(function (hd) {
        out.push('<line x1="' + f(hd[0][0]) + '" y1="' + f(hd[0][1]) + '" x2="' + f(hd[1][0]) + '" y2="' + f(hd[1][1]) + '"/>');
        out.push('<circle cx="' + f(hd[1][0]) + '" cy="' + f(hd[1][1]) + '" r="' + dot + '" stroke="none"/>');
      });
      out.push("</g>");
    }

    if (shown(L.points, "Points") && r.points.length) {
      var pt = L.points;
      var size = pt.size * u, half = size / 2;
      out.push(
        '<g id="Points" fill="' + pt.fill + '" stroke="' + pt.stroke + '" stroke-width="' + f(pt.width * u) + '"' +
        ' opacity="' + opacity("Points", 100) + '"' + (pt.width === 0 ? ' stroke-opacity="0"' : "") + ">"
      );
      r.points.forEach(function (p) {
        out.push(
          pt.shape === "circle"
            ? '<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(half) + '"/>'
            : '<rect x="' + f(p[0] - half) + '" y="' + f(p[1] - half) + '" width="' + f(size) + '" height="' + f(size) + '"/>'
        );
      });
      out.push("</g>");
    }

    if (opts.overlay) out.push(opts.overlay);
    out.push("</svg>");
    return out.join("");
  }

  // ===============================================================
  // Hover explanations
  //
  // Hovering (or dragging) a setting dims the normal output and highlights
  // exactly what that setting decides, using the engine's decision trace.
  // ===============================================================

  var MARK = { keep: "#0A84FF", drop: "#FF2D55", near: "#FFA500" };
  var GROUPS = ["Logo", "Arcs", "Guidelines", "Handles", "Points"];

  function attachHover(el, id) {
    var inside = false, pressing = false;
    el.classList.add("hoverable");
    el.addEventListener("pointerenter", function () { inside = true; setHover(id); });
    el.addEventListener("pointerleave", function () { inside = false; if (!pressing) clearHover(id); });
    el.addEventListener("pointerdown", function () {
      pressing = true;
      window.addEventListener("pointerup", function up() {
        window.removeEventListener("pointerup", up);
        pressing = false;
        if (!inside) clearHover(id);
      });
    });
    el.addEventListener("focusin", function () { setHover(id); });
    el.addEventListener("focusout", function () { if (!inside) clearHover(id); });
    return el;
  }

  function setHover(id) {
    if (state.hover === id) return;
    state.hover = id;
    if (state.doc) render();
  }
  function clearHover(id) {
    if (state.hover !== id) return;
    state.hover = null;
    if (state.doc) render();
  }

  // Collects highlight shapes. Sizes are in screen pixels; each shape gets a
  // halo in the background's contrast color so it reads on any preset.
  function Marks(pxToUnits, halo) {
    var under = [], over = [], rings = [], labels = [];
    function paint(color, width, dashed) {
      return ' fill="none" stroke="' + color + '" stroke-width="' + f(width * pxToUnits) + '" stroke-linecap="round"' +
        (dashed ? ' stroke-dasharray="' + f(6 * pxToUnits) + " " + f(5 * pxToUnits) + '"' : "");
    }
    function add(shape, color, o) {
      o = o || {};
      var width = o.width || 2.5;
      under.push("<" + shape + paint(halo, width + 3) + ' stroke-opacity="0.9"/>');
      over.push("<" + shape + paint(color, width, o.dashed) + "/>");
    }
    return {
      line: function (a, b, color, o) {
        add('line x1="' + f(a[0]) + '" y1="' + f(a[1]) + '" x2="' + f(b[0]) + '" y2="' + f(b[1]) + '"', color, o);
      },
      polyline: function (pts, color, o) {
        add('polyline points="' + pts.map(function (p) { return f(p[0]) + "," + f(p[1]); }).join(" ") + '" stroke-linejoin="round"', color, o);
      },
      bezier: function (bz, color, o) {
        add('path d="M' + f(bz[0][0]) + " " + f(bz[0][1]) + "C" + [bz[1], bz[2], bz[3]].map(function (p) { return f(p[0]) + " " + f(p[1]); }).join(" ") + '"', color, o);
      },
      circle: function (c, color, o) {
        add('circle cx="' + f(c.cx) + '" cy="' + f(c.cy) + '" r="' + f(c.r) + '"', color, o);
      },
      // A screen-sized ring that makes tiny items findable.
      ring: function (p, color) {
        var overlaps = rings.some(function (q) { return Math.hypot(p[0] - q[0], p[1] - q[1]) < 8 * pxToUnits; });
        if (overlaps) return;
        rings.push(p);
        add('circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(11 * pxToUnits) + '"', color, { width: 1.5 });
      },
      rect: function (r, color, o) {
        add('rect x="' + f(r.x) + '" y="' + f(r.y) + '" width="' + f(r.w) + '" height="' + f(r.h) + '"', color, o);
      },
      path: function (d, color, o) {
        add('path d="' + d + '" stroke-linejoin="round"', color, o);
      },
      // A small screen-sized cross, for centers.
      cross: function (p, color) {
        var s = 6 * pxToUnits;
        add('path d="M' + f(p[0] - s) + " " + f(p[1]) + "H" + f(p[0] + s) + "M" + f(p[0]) + " " + f(p[1] - s) + "V" + f(p[1] + s) + '"', color, { width: 1.5 });
      },
      // Where a point is, and a line to where it should be.
      arrow: function (a, b, color) {
        this.ring(a, color);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 2 * pxToUnits) add('line x1="' + f(a[0]) + '" y1="' + f(a[1]) + '" x2="' + f(b[0]) + '" y2="' + f(b[1]) + '"', color, { width: 2 });
      },
      // A measurement between two points, with ticks at the ends and its value.
      dimension: function (a, b, color, text) {
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        var nx = (-(b[1] - a[1]) / len) * 5 * pxToUnits, ny = ((b[0] - a[0]) / len) * 5 * pxToUnits;
        add('path d="M' + f(a[0]) + " " + f(a[1]) + "L" + f(b[0]) + " " + f(b[1]) +
          "M" + f(a[0] - nx) + " " + f(a[1] - ny) + "L" + f(a[0] + nx) + " " + f(a[1] + ny) +
          "M" + f(b[0] - nx) + " " + f(b[1] - ny) + "L" + f(b[0] + nx) + " " + f(b[1] + ny) + '"', color, { width: 1.5 });
        if (text) {
          labels.push(
            '<text x="' + f((a[0] + b[0]) / 2) + '" y="' + f((a[1] + b[1]) / 2) + '" font-size="' + f(11 * pxToUnits) + '"' +
            ' font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-weight="600" text-anchor="middle" dominant-baseline="middle"' +
            ' fill="' + color + '" stroke="' + halo + '" stroke-width="' + f(3 * pxToUnits) + '" paint-order="stroke">' + text + "</text>"
          );
        }
      },
      toString: function () {
        return '<g id="Highlight" pointer-events="none">' + under.join("") + over.join("") + labels.join("") + "</g>";
      },
    };
  }

  function haloColor() {
    if (S.canvas.transparent) return "#FFFFFF";
    var hex = S.canvas.background.replace("#", "");
    var rgb = [0, 2, 4].map(function (i) { return parseInt(hex.substr(i, 2), 16) / 255; });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 0.5 ? "#FFFFFF" : "#000000";
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function roundUp(v, step) { return Math.ceil(v / step - 1e-9) * step; }
  function nextAbove(v, step) { return Math.floor(v / step + 1e-9) * step + step; }

  function drawArc(m, arc, color, o) {
    arc.beziers.forEach(function (bz) { m.bezier(bz, color, o); });
  }
  function arcMiddle(arc) {
    var bz = arc.beziers[Math.floor(arc.beziers.length / 2)];
    var t = 0.5, mt = 0.5;
    return [
      mt * mt * mt * bz[0][0] + 3 * mt * mt * t * bz[1][0] + 3 * mt * t * t * bz[2][0] + t * t * t * bz[3][0],
      mt * mt * mt * bz[0][1] + 3 * mt * mt * t * bz[1][1] + 3 * mt * t * t * bz[2][1] + t * t * t * bz[3][1],
    ];
  }
  function edgeMiddle(edge) {
    return [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2];
  }

  var DETECTION_DIM = { Logo: 0.55, Arcs: 0.15, Guidelines: 0.15, Handles: 0.15, Points: 0.15 };

  // Each entry returns { title, text, legend: [[color, label, dashed]], hint, dim, show, draw(marks) }.
  var EXPLAIN = {
    "detection.minSegmentLength": function (t) {
      var min = S.detection.minSegmentLength;
      var used = t.straight.filter(function (e) { return e.status === "line" || e.status === "merged"; });
      var short = t.straight.filter(function (e) { return e.status === "short"; });
      var hint = "";
      if (short.length) {
        var longestShort = Math.max.apply(null, short.map(function (e) { return e.length; }));
        hint = "Lower to " + Math.floor(longestShort) + " to give the longest skipped edge a guideline.";
      } else if (used.length) {
        var shortestUsed = Math.min.apply(null, used.map(function (e) { return e.length; }));
        if (nextAbove(shortestUsed, 1) <= 80) hint = "Raise to " + nextAbove(shortestUsed, 1) + " to drop the shortest edge.";
      }
      return {
        title: "Min line",
        text: "Straight edges shorter than " + min + " units don't get a guideline. Pieces that continue the same edge count together.",
        legend: [[MARK.keep, plural(used.length, "edge") + " make guidelines"], [MARK.drop, plural(short.length, "edge") + " too short"]],
        hint: hint,
        draw: function (m) {
          used.forEach(function (e) { m.polyline(e.points, MARK.keep, { width: 4 }); });
          short.forEach(function (e) {
            m.polyline(e.points, MARK.drop, { width: 4 });
            m.ring(edgeMiddle(e), MARK.drop);
          });
        },
      };
    },

    "detection.lineAngleTolerance": function (t, r) {
      var tol = S.detection.lineAngleTolerance, dist = S.detection.lineMergeDistance;
      var merged = t.mergedLines.filter(function (e) { return e.angle > 0.01; });
      var near = t.linePairs.filter(function (p) { return p.distance < dist && p.angle > tol && p.angle <= 10; });
      var next = near.length ? Math.min.apply(null, near.map(function (p) { return roundUp(p.angle, 0.5); })) : null;
      return {
        title: "Angle merge",
        text: "Guidelines less than " + tol + "° apart (and within " + dist + " units) are combined into one.",
        legend: [
          merged.length && [MARK.keep, "kept guideline"],
          merged.length && [MARK.drop, plural(merged.length, "near-parallel line") + " merged", true],
          near.length && [MARK.near, plural(near.length, "pair") + " would merge if raised", true],
        ],
        hint: next != null ? "Raise to " + next + "° for the next merge." : merged.length ? "" : "No nearly-parallel guidelines here, so this setting has no effect on this logo.",
        draw: function (m) {
          merged.forEach(function (e) { m.line(r.lines[e.into][0], r.lines[e.into][1], MARK.keep); m.line(e.line[0], e.line[1], MARK.drop, { dashed: true }); });
          near.forEach(function (p) { [p.i, p.j].forEach(function (k) { m.line(r.lines[k][0], r.lines[k][1], MARK.near, { dashed: true }); }); });
        },
      };
    },

    "detection.lineMergeDistance": function (t, r) {
      var tol = S.detection.lineAngleTolerance, dist = S.detection.lineMergeDistance;
      var merged = t.mergedLines.filter(function (e) { return e.distance > 0.01; });
      var near = t.linePairs.filter(function (p) { return p.angle <= tol && p.distance >= dist && p.distance <= 30; });
      var next = near.length ? Math.min.apply(null, near.map(function (p) { return nextAbove(p.distance, 0.5); })) : null;
      return {
        title: "Line merge",
        text: "Parallel guidelines closer than " + dist + " units are combined into one.",
        legend: [
          merged.length && [MARK.keep, "kept guideline"],
          merged.length && [MARK.drop, plural(merged.length, "close line") + " merged", true],
          near.length && [MARK.near, plural(near.length, "pair") + " would merge if raised", true],
        ],
        hint: next != null ? "Raise to " + next + " for the next merge." : merged.length ? "" : "No close parallel guidelines here, so this setting has no effect on this logo.",
        draw: function (m) {
          merged.forEach(function (e) { m.line(r.lines[e.into][0], r.lines[e.into][1], MARK.keep); m.line(e.line[0], e.line[1], MARK.drop, { dashed: true }); });
          near.forEach(function (p) { [p.i, p.j].forEach(function (k) { m.line(r.lines[k][0], r.lines[k][1], MARK.near, { dashed: true }); }); });
        },
      };
    },

    "detection.minArcLength": function (t) {
      var min = S.detection.minArcLength;
      var checked = t.curves.filter(function (c) { return c.status !== "short"; });
      var short = t.curves.filter(function (c) { return c.status === "short"; });
      var hint = "";
      if (short.length) {
        hint = "Lower to " + Math.floor(Math.max.apply(null, short.map(function (c) { return c.length; }))) + " to check the longest skipped curve.";
      } else if (!t.curves.length) {
        hint = "This logo has no curves, so this setting has no effect.";
      }
      return {
        title: "Min arc",
        text: "Curves shorter than " + min + " units are skipped when looking for circles. Smooth pieces of the same arc count together.",
        legend: [[MARK.keep, plural(checked.length, "curve") + " checked"], [MARK.drop, plural(short.length, "curve") + " too short"]],
        hint: hint,
        draw: function (m) {
          checked.forEach(function (c) { drawArc(m, c, MARK.keep, { width: 4 }); });
          short.forEach(function (c) {
            drawArc(m, c, MARK.drop, { width: 4 });
            m.ring(arcMiddle(c), MARK.drop);
          });
        },
      };
    },

    "detection.circleFitTolerance": function (t) {
      var tol = S.detection.circleFitTolerance;
      var accepted = t.curves.filter(function (c) { return c.status === "circle" || c.status === "small"; });
      var near = t.curves.filter(function (c) { return c.reason === "fit" && c.deviation * 100 <= 5; });
      var loosest = accepted.reduce(function (worst, c) { return !worst || c.deviation > worst.deviation ? c : worst; }, null);
      var next = near.length ? Math.min.apply(null, near.map(function (c) { return nextAbove(c.deviation * 100, 0.1); })) : null;
      var hint = "";
      if (next != null) hint = "Raise to " + Math.round(next * 10) / 10 + "% to accept the closest one.";
      else if (loosest) hint = "The loosest fit (orange) strays " + (Math.round(loosest.deviation * 1000) / 10) + "%. Lower below that to drop it.";
      return {
        title: "Circle fit",
        text: "A curve is read as part of a circle when it strays less than " + tol + "% of the arc's size from that circle.",
        legend: [
          [MARK.keep, plural(accepted.length, "curve") + " read as circles"],
          near.length && [MARK.near, plural(near.length, "curve") + " close to circular", true],
        ],
        hint: hint,
        draw: function (m) {
          accepted.forEach(function (c) { drawArc(m, c, c === loosest && next == null ? MARK.near : MARK.keep, { width: 4 }); });
          near.forEach(function (c) { drawArc(m, c, MARK.near, { width: 4, dashed: true }); });
        },
      };
    },

    "detection.circleMergeTolerance": function (t, r) {
      var tol = S.detection.circleMergeTolerance;
      var arcs = t.curves.filter(function (c) { return c.status === "circle"; });
      var near = t.circlePairs.filter(function (p) { return p.tolerance * 100 >= tol && p.tolerance * 100 <= 20; });
      var next = near.length ? Math.min.apply(null, near.map(function (p) { return nextAbove(p.tolerance * 100, 0.5); })) : null;
      return {
        title: "Circle merge",
        text: "Separate arcs that describe the same circle, within " + tol + "% of its radius, become one circle.",
        legend: [
          [MARK.keep, plural(arcs.length, "arc") + " → " + plural(r.circles.length, "circle")],
          near.length && [MARK.near, plural(near.length, "pair") + " of circles would merge if raised", true],
        ],
        hint: next != null
          ? "Raise to " + next + "% to merge the closest pair."
          : r.circles.length > 1 ? "No circles are close enough to merge, even at 20%." : "",
        draw: function (m) {
          r.circles.forEach(function (c) { m.circle(c, MARK.keep, { width: 1.5 }); });
          arcs.forEach(function (c) { drawArc(m, c, MARK.keep, { width: 5 }); });
          near.forEach(function (p) { m.circle(r.circles[p.i], MARK.near, { dashed: true }); m.circle(r.circles[p.j], MARK.near, { dashed: true }); });
        },
      };
    },

    "canvas.source": function () {
      var doc = state.doc;
      return {
        title: "Bounds",
        text: "Guidelines run to the edges of this box, plus padding. Artboard uses the SVG's own canvas; Artwork hugs the shapes.",
        legend: [[MARK.keep, "SVG artboard", S.canvas.source !== "artboard"], [MARK.near, "Artwork bounds", S.canvas.source !== "artwork"]],
        dim: { Arcs: 0.35, Guidelines: 0.35, Handles: 0.35, Points: 0.35 },
        draw: function (m) {
          m.rect(doc.artboard, MARK.keep, { dashed: S.canvas.source !== "artboard" });
          m.rect(doc.artBounds, MARK.near, { dashed: S.canvas.source !== "artwork" });
        },
      };
    },

    "canvas.padding": function () {
      var base = S.canvas.source === "artwork" ? state.doc.artBounds : state.doc.artboard;
      return {
        title: "Padding",
        text: "Extra space around the bounds, as a percentage of the longest side. Guidelines extend into it.",
        legend: [[MARK.keep, "Bounds before padding", true]],
        dim: { Arcs: 0.35, Guidelines: 0.35, Handles: 0.35, Points: 0.35 },
        draw: function (m) { m.rect(base, MARK.keep, { dashed: true }); },
      };
    },
  };

  var LAYER_TEXT = {
    logo: ["Logo", "Your artwork. Show it in its original colors, as a solid fill, or as an outline.", "Logo"],
    guidelines: ["Guidelines", "Every straight edge, extended across the canvas.", "Guidelines"],
    arcs: ["Arcs", "Full circles found from the curved edges.", "Arcs"],
    points: ["Anchor points", "Every anchor point in the artwork.", "Points"],
    handles: ["Bézier handles", "The control handles that shape each curve.", "Handles"],
  };

  function explainHover() {
    var id = state.hover;
    if (!state.result) return null;
    if (!id) return explainRefinedView();
    var info;
    if (id.indexOf("refine.") === 0) {
      info = explainSuggestion(id.slice(7));
      if (!info) return null;
    } else if (id.indexOf("layer.") === 0) {
      var key = id.slice(6), text = LAYER_TEXT[key];
      var dim = {};
      GROUPS.forEach(function (g) { dim[g] = g === text[2] ? 1 : 0.12; });
      info = {
        title: text[0],
        text: text[1],
        hint: S.layers[key].visible ? "" : "Hidden right now. Switch it on to include it in exports.",
        dim: dim,
        show: text[2],
      };
    } else if (EXPLAIN[id]) {
      info = EXPLAIN[id](state.result.trace, state.result);
    } else {
      return null;
    }
    var marks = Marks(1 / displayScale(), haloColor());
    if (info.draw) info.draw(marks);
    info.svg = { dim: info.dim || DETECTION_DIM, show: info.show, overlay: info.draw ? String(marks) : "", original: info.original };
    return info;
  }

  // ===============================================================
  // Refine
  //
  // "Find improvements" lists near-misses (weights, radii, angles,
  // alignment, symmetry). Checked ones are applied to a refined copy of
  // the logo, which Compare and Refined show and export.
  // ===============================================================

  function formatLength(v) {
    var digits = v >= 100 ? 1 : v >= 1 ? 2 : 3;
    return String(Number(v.toFixed(digits)));
  }

  function findSuggestion(id) {
    var rf = state.refine;
    if (!rf) return null;
    for (var i = 0; i < rf.inspection.suggestions.length; i++) {
      if (rf.inspection.suggestions[i].id === id) return rf.inspection.suggestions[i];
    }
    return null;
  }

  // The shapes this one fix reshapes, drawn over the original while hovering it.
  function previewOf(sg) {
    var rf = state.refine;
    if (rf.previews[sg.id] == null) {
      var fixed = docFromPaths(rf.inspection.refine([sg.id]).paths);
      rf.previews[sg.id] = fixed.elements.filter(function (el, i) { return el.d !== state.doc.elements[i].d; })
        .map(function (el) { return el.d; }).join("");
    }
    return rf.previews[sg.id];
  }

  function explainSuggestion(id) {
    var sg = findSuggestion(id);
    if (!sg) return null;
    var color = { issue: MARK.near, target: MARK.keep, ok: MARK.keep };
    return {
      title: sg.title,
      text: sg.detail,
      legend: [
        [MARK.near, "Off now"],
        [MARK.keep, "Exact", true],
        [MARK.keep, "Your logo with this fix"],
      ],
      hint: state.refine.accepted[id] ? "Included in the refined logo. Uncheck to leave it as drawn." : "Not included. Check it to add it to the refined logo.",
      original: true,
      draw: function (m) {
        var preview = previewOf(sg);
        if (preview) m.path(preview, MARK.keep, { width: 1.25 });
        sg.marks.forEach(function (mk) {
          var c = color[mk.role];
          var target = mk.role === "target";
          if (mk.type === "polyline") m.polyline(mk.points, c, { width: 4 });
          else if (mk.type === "bezier") m.bezier(mk.bz, c, { width: 4 });
          else if (mk.type === "line") m.line(mk.a, mk.b, c, { dashed: target, width: 1.5 });
          else if (mk.type === "circle") m.circle(mk, c, { dashed: target, width: 1.5 });
          else if (mk.type === "dot") m.cross(mk.p, c);
          else if (mk.type === "arrow") m.arrow(mk.a, mk.b, c);
          else if (mk.type === "dimension") m.dimension(mk.a, mk.b, c, formatLength(mk.value));
        });
      },
    };
  }

  function explainRefinedView() {
    if (!showingRefined()) return null;
    var rf = state.refine;
    var info = {
      title: rf.view === "compare" ? "Comparing with your original" : "Refined logo",
      text: rf.view === "compare"
        ? "Your logo with " + plural(rf.applied, "improvement") + " applied. The dashed outline is the original; rings mark points that moved."
        : "Your logo with " + plural(rf.applied, "improvement") + " applied. Exports use this version.",
      legend: rf.view === "compare" ? [[MARK.drop, "Original outline", true], [MARK.drop, plural(rf.moved.length, "point") + " moved"]] : [],
      hint: "Hover a suggestion to see what it changes.",
      dim: {},
    };
    if (rf.view === "compare") {
      info.draw = function (m) {
        m.path(state.doc.elements.map(function (el) { return el.d; }).join(""), MARK.drop, { width: 1, dashed: true });
        rf.moved.slice(0, 300).forEach(function (mv) { m.ring(mv[1], MARK.drop); });
      };
    }
    var marks = Marks(1 / displayScale(), haloColor());
    if (info.draw) info.draw(marks);
    info.svg = { dim: info.dim, overlay: info.draw ? String(marks) : "" };
    return info;
  }

  function docFromPaths(paths) {
    var doc = state.doc;
    var d = doc.elements.map(function () { return ""; });
    paths.forEach(function (sp) { d[Number(String(sp.id).split("_")[0])] += G.subpathToPathData(sp); });
    return {
      name: doc.name,
      paths: paths,
      elements: doc.elements.map(function (el, i) { return Object.assign({}, el, { d: d[i] }); }),
      artboard: doc.artboard,
      artBounds: doc.artBounds,
      originalMarkup: null,
    };
  }

  function findImprovements() {
    if (!state.doc) return;
    var inspection = Refine.inspect(state.doc.paths, state.doc.elements.map(function (el) { return el.fillRule; }));
    var accepted = {};
    inspection.suggestions.forEach(function (sg) { accepted[sg.id] = true; });
    state.refine = {
      inspection: inspection,
      accepted: accepted,
      view: inspection.suggestions.length ? "compare" : "original",
      previews: {},
    };
    state.hover = null;
    applyRefinements();
    renderRefinePanel();
    if (inspection.suggestions.length) toast("Found " + plural(inspection.suggestions.length, "improvement") + " · comparing with your original");
  }

  function applyRefinements() {
    var rf = state.refine;
    var ids = rf.inspection.suggestions.filter(function (sg) { return rf.accepted[sg.id]; }).map(function (sg) { return sg.id; });
    rf.applied = ids.length;
    if (ids.length) {
      var solved = rf.inspection.refine(ids);
      rf.doc = docFromPaths(solved.paths);
      rf.moved = solved.moved;
    } else {
      rf.doc = rf.result = null;
      rf.moved = [];
    }
    analyze();
    render();
    updateLayerRows();
  }

  function setView(view) {
    if (!state.refine) return;
    state.refine.view = view;
    analyze();
    render();
    updateLayerRows();
  }

  function clearRefine() {
    state.refine = null;
    state.hover = null;
    analyze();
    render();
    updateLayerRows();
    renderRefinePanel();
  }

  function renderRefinePanel() {
    var rf = state.refine;
    $("refineIntro").hidden = !!rf;
    $("refineResults").hidden = !rf;
    $("refineRun").disabled = !state.doc;
    var list = $("refineList");
    list.textContent = "";
    if (!rf) return;
    var suggestions = rf.inspection.suggestions;
    var summary = $("refineSummary");
    summary.classList.toggle("perfect", !suggestions.length);
    summary.textContent = "";
    if (!suggestions.length) {
      var c = rf.inspection.checked;
      var parts = [];
      if (c.weights) parts.push(plural(c.weights, "stroke weight"));
      if (c.radii) parts.push(plural(c.radii, "radius", "radii"));
      if (c.angles) parts.push(plural(c.angles, "edge angle"));
      summary.appendChild(h("b", { text: "Nothing to refine" }));
      summary.appendChild(document.createTextNode(
        (parts.length ? "Checked " + parts.join(", ") + ": everything that should match does." : "No near-misses found.") +
        (c.symmetry.some(function (s) { return s === "vertical" || s === "horizontal"; }) ? " Mirror symmetry is exact." : "")
      ));
      $("refineAll").hidden = $("refineNone").hidden = true;
      return;
    }
    $("refineAll").hidden = $("refineNone").hidden = false;
    renderRefineSummary();
    suggestions.forEach(function (sg) {
      var box = h("input", { type: "checkbox", "aria-label": sg.title });
      box.checked = !!rf.accepted[sg.id];
      box.addEventListener("change", function () {
        rf.accepted[sg.id] = box.checked;
        if (box.checked && rf.view === "original") rf.view = "compare";
        card.classList.toggle("off", !box.checked);
        applyRefinements();
        renderRefineSummary();
      });
      var card = h("label", { class: "suggestion" + (box.checked ? "" : " off") }, [
        box,
        h("span", {}, [h("div", { class: "suggestion-title", text: sg.title }), h("div", { class: "suggestion-detail", text: sg.detail })]),
      ]);
      attachHover(card, "refine." + sg.id);
      list.appendChild(card);
    });
  }

  function renderRefineSummary() {
    var rf = state.refine;
    var suggestions = rf.inspection.suggestions;
    if (!suggestions.length) return;
    var biggest = Math.max.apply(null, suggestions.map(function (sg) { return sg.maxMove; }));
    $("refineSummary").innerHTML =
      "<b>" + plural(suggestions.length, "improvement") + "</b> · " + rf.applied + " applied · largest moves a point " + formatLength(biggest);
  }

  function renderViewToggle() {
    var rf = state.refine;
    var el = $("viewToggle");
    el.hidden = !(rf && rf.inspection.suggestions.length);
    if (el.hidden) return;
    Array.prototype.forEach.call(el.querySelectorAll("button"), function (b) {
      var view = b.getAttribute("data-view");
      b.classList.toggle("active", (rf.doc ? rf.view : "original") === view);
      b.disabled = view !== "original" && !rf.doc;
    });
  }

  $("refineRun").addEventListener("click", findImprovements);
  $("refineClear").addEventListener("click", clearRefine);
  $("refineAll").addEventListener("click", function () {
    state.refine.inspection.suggestions.forEach(function (sg) { state.refine.accepted[sg.id] = true; });
    if (state.refine.view === "original") state.refine.view = "compare";
    applyRefinements();
    renderRefinePanel();
  });
  $("refineNone").addEventListener("click", function () {
    state.refine.accepted = {};
    applyRefinements();
    renderRefinePanel();
  });
  Array.prototype.forEach.call($("viewToggle").querySelectorAll("button"), function (b) {
    b.addEventListener("click", function () { setView(b.getAttribute("data-view")); });
  });

  function renderExplanation(info) {
    $("explain").classList.toggle("idle", !info);
    if (!info) {
      info = {
        title: "Hover a setting",
        text: "Point at any layer, canvas or detection setting to highlight what it affects on your logo.",
      };
    }
    $("explainTitle").textContent = info.title;
    $("explainText").textContent = info.text;
    var legend = $("explainLegend");
    legend.textContent = "";
    (info.legend || []).filter(Boolean).forEach(function (item) {
      var swatch = h("i", { class: "legend-swatch" + (item[2] ? " dashed" : "") });
      swatch.style.setProperty("--c", item[0]);
      legend.appendChild(h("span", { class: "legend-item" }, [swatch, h("span", { text: item[1] })]));
    });
    legend.hidden = !legend.childNodes.length;
    $("explainHint").textContent = info.hint || "";
    $("explainHint").hidden = !info.hint;
  }

  var canvasEl = $("canvas");
  var shadow = canvasEl.attachShadow({ mode: "open" });

  function render() {
    if (!state.doc) {
      shadow.innerHTML = "";
      canvasEl.hidden = true;
      $("empty").hidden = false;
      $("stats").textContent = "";
      return;
    }
    canvasEl.hidden = false;
    $("empty").hidden = true;
    var explanation = explainHover();
    // Shadow DOM keeps the logo's own <style> rules from leaking into the app UI.
    shadow.innerHTML = "<style>:host{display:block}svg{display:block}</style>" + buildSVG(explanation && explanation.svg);
    applyZoom();
    renderStats();
    renderViewToggle();
    renderExplanation(explanation);
  }

  function renderStats() {
    var r = showingRefined() ? state.refine.result : state.result;
    var el = $("stats");
    el.textContent = "";
    [[r.lines.length, "guidelines"], [r.circles.length, "arcs"], [r.points.length, "points"]].forEach(function (s) {
      var pill = h("span", { class: "stat" });
      pill.innerHTML = "<b>" + s[0] + "</b> " + s[1];
      el.appendChild(pill);
    });
  }

  // Zoom

  var viewport = $("viewport");

  // Screen pixels per artwork unit at the current zoom.
  function displayScale() {
    var cv = state.canvas;
    // Viewport padding (gutter on the sides and bottom) plus 16px breathing room around the canvas.
    var availW = Math.max(50, viewport.clientWidth - 64);
    var availH = Math.max(50, viewport.clientHeight - 48);
    return Math.min(availW / cv.w, availH / cv.h) * state.zoom;
  }

  function applyZoom() {
    var svg = shadow.querySelector("svg");
    if (!svg || !state.canvas) return;
    var cv = state.canvas;
    var scale = displayScale();
    svg.style.width = cv.w * scale + "px";
    svg.style.height = cv.h * scale + "px";
    $("zoomFit").textContent = state.zoom === 1 ? "Fit" : Math.round(state.zoom * 100) + "%";
  }

  function setZoom(z) {
    state.zoom = Math.min(8, Math.max(0.25, z));
    if (Math.abs(state.zoom - 1) < 0.01) state.zoom = 1;
    if (state.hover || showingRefined()) render(); // highlight strokes are sized in screen pixels
    else applyZoom();
  }

  $("zoomIn").addEventListener("click", function () { setZoom(state.zoom * 1.25); });
  $("zoomOut").addEventListener("click", function () { setZoom(state.zoom / 1.25); });
  $("zoomFit").addEventListener("click", function () { setZoom(1); });
  viewport.addEventListener("wheel", function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
  new ResizeObserver(applyZoom).observe(viewport);

  // Classic scrollbars take width from the sidebar; expose it so sections can
  // keep their right edge aligned with the rest of the sidebar.
  var sidebarScroll = document.querySelector(".sidebar .scroll");
  function syncScrollbarWidth() {
    var width = Math.min(sidebarScroll.offsetWidth - sidebarScroll.clientWidth, 16);
    document.documentElement.style.setProperty("--scrollbar-width", width + "px");
  }
  var scrollbarObserver = new ResizeObserver(syncScrollbarWidth);
  scrollbarObserver.observe(sidebarScroll);
  sidebarScroll.querySelectorAll(".section").forEach(function (el) { scrollbarObserver.observe(el); });
  // Sections opening or closing change whether the sidebar scrolls at all.
  sidebarScroll.addEventListener("toggle", syncScrollbarWidth, true);
  sidebarScroll.addEventListener("click", function () { setTimeout(syncScrollbarWidth, 0); });

  // ===============================================================
  // Files
  // ===============================================================

  function loadSVG(text, name, quiet) {
    try {
      state.doc = Importer.importSVG(text, name);
    } catch (e) {
      toast(e.message, true);
      return false;
    }
    state.zoom = 1;
    state.refine = null;
    state.hover = null;
    analyze();
    render();
    updateLayerRows();
    renderRefinePanel();
    var ab = state.doc.artboard;
    $("fileName").textContent = state.doc.name;
    $("fileDims").textContent = f(ab.w) + " × " + f(ab.h) + " · " + state.doc.elements.length + " shape" + (state.doc.elements.length === 1 ? "" : "s");
    var notes = state.doc.notes || [];
    $("fileNotes").textContent = "";
    notes.forEach(function (note) { $("fileNotes").appendChild(h("li", { text: note })); });
    $("fileNotes").hidden = !notes.length;
    document.querySelectorAll(".export .btn").forEach(function (b) { b.disabled = false; });
    post("title", { title: state.doc.name });
    if (!quiet) savePrefs();
    return true;
  }

  function openFile() {
    if (post("open")) return;
    var input = h("input", { type: "file", accept: ".svg,image/svg+xml" });
    input.addEventListener("change", function () {
      if (input.files[0]) readFile(input.files[0]);
    });
    input.click();
  }

  function readFile(file) {
    if (!/\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
      toast("LogoGrid opens SVG files. In Illustrator, use File › Export › Export As… › SVG.", true);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { loadSVG(String(reader.result), file.name); };
    reader.readAsText(file);
  }

  $("openBtn").addEventListener("click", openFile);

  var dragDepth = 0;
  window.addEventListener("dragenter", function (e) {
    e.preventDefault();
    dragDepth++;
    $("dropOverlay").hidden = false;
  });
  window.addEventListener("dragleave", function () {
    if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").hidden = true; }
  });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    var file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  document.addEventListener("paste", function (e) {
    if (e.target.closest && e.target.closest("input")) return;
    var text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (text && /<svg[\s>]/i.test(text)) {
      e.preventDefault();
      loadSVG(text, "Pasted SVG.svg");
    }
  });

  // ===============================================================
  // Export
  // ===============================================================

  function baseName() {
    return state.doc.name.replace(/\.svg$/i, "") + (showingRefined() ? "-refined" : "") + "-grid";
  }

  function download(name, blob) {
    var a = h("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportSVG() {
    if (!state.doc) return;
    var svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + buildSVG();
    var name = baseName() + ".svg";
    if (!post("save", { name: name, ext: "svg", encoding: "utf8", data: svg })) {
      download(name, new Blob([svg], { type: "image/svg+xml" }));
    }
  }

  function exportPNG() {
    if (!state.doc) return;
    var scale = Number(S.pngScale) || 2;
    var cv = state.canvas;
    var u = Math.max(cv.w, cv.h) / 1000;
    var width = Math.round((cv.w / u) * scale), height = Math.round((cv.h / u) * scale);
    var img = new Image();
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      c.getContext("2d").drawImage(img, 0, 0, width, height);
      var name = baseName() + (scale === 1 ? "" : "@" + scale + "x") + ".png";
      var dataUrl;
      try {
        dataUrl = c.toDataURL("image/png");
      } catch (e) {
        toast("PNG export failed: " + e.message, true);
        return;
      }
      if (!post("save", { name: name, ext: "png", encoding: "base64", data: dataUrl.split(",")[1] })) {
        c.toBlob(function (blob) { download(name, blob); }, "image/png");
      }
    };
    img.onerror = function () { toast("PNG export failed to render this artwork.", true); };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(buildSVG());
  }

  function copySVG() {
    if (!state.doc) return;
    var svg = buildSVG();
    if (post("copy", { text: svg })) return;
    navigator.clipboard.writeText(svg).then(
      function () { toast("SVG copied to clipboard"); },
      function () { toast("Couldn't access the clipboard", true); }
    );
  }

  $("exportSvg").addEventListener("click", exportSVG);
  $("exportPng").addEventListener("click", exportPNG);
  $("copySvg").addEventListener("click", copySVG);
  $("pngScale").addEventListener("change", function () {
    S.pngScale = Number($("pngScale").value);
    savePrefs();
  });

  // ===============================================================
  // Misc
  // ===============================================================

  var toastTimer = null;
  function toast(message, isError) {
    var el = $("toast");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, isError ? 4500 : 2200);
  }

  // ===============================================================
  // Updates (native app only; the shell checks GitHub Releases)
  // ===============================================================

  var offeredUpdate = null;

  function formatSize(bytes) {
    return bytes >= 1e6 ? (Math.round(bytes / 1e5) / 10) + " MB" : Math.max(1, Math.round(bytes / 1e3)) + " KB";
  }

  function setUpdateButtons(enabled, canInstall) {
    $("updateInstall").hidden = !canInstall;
    ["updateInstall", "updateLater", "updateSkip"].forEach(function (id) { $(id).disabled = !enabled; });
  }

  function updateStatus(info) {
    var card = $("updateCard");
    var message = $("updateMessage");
    switch (info.state) {
      case "available":
        offeredUpdate = info;
        $("updateTitle").textContent = "Update available";
        $("updateSub").textContent =
          "LogoGrid " + info.version + " · you have " + info.currentVersion + (info.size ? " · " + formatSize(info.size) : "");
        // Release notes are Markdown; show them as plain lines.
        $("updateNotes").textContent = (info.notes || "").replace(/^#+\s*/gm, "").replace(/^\s*[-*]\s+/gm, "• ").replace(/\*\*|`/g, "");
        message.textContent = info.blockedReason || "";
        message.hidden = !info.blockedReason;
        setUpdateButtons(true, !info.blockedReason);
        card.hidden = false;
        break;
      case "installing":
        $("updateTitle").textContent = "Installing LogoGrid " + info.version + "…";
        message.hidden = true;
        setUpdateButtons(false, true);
        card.hidden = false;
        break;
      case "relaunching":
        $("updateTitle").textContent = "Relaunching…";
        break;
      case "current":
        toast("LogoGrid " + info.version + " is up to date");
        break;
      case "error":
        if (!card.hidden && offeredUpdate) {
          $("updateTitle").textContent = "Update available";
          message.textContent = info.message;
          message.hidden = false;
          setUpdateButtons(true, true);
        } else {
          toast(info.message, true);
        }
        break;
    }
  }

  $("updateInstall").addEventListener("click", function () { post("installUpdate"); });
  $("updateLater").addEventListener("click", function () { $("updateCard").hidden = true; });
  $("updateSkip").addEventListener("click", function () {
    if (offeredUpdate) post("skipUpdate", { version: offeredUpdate.version });
    $("updateCard").hidden = true;
  });
  $("aboutCheckUpdates").hidden = !nativeBridge;
  $("aboutCheckUpdates").addEventListener("click", function () {
    $("about").close();
    post("checkUpdates");
  });

  function showAbout() {
    $("aboutVersion").textContent = "Version " + (BOOT.version || "dev");
    $("about").showModal();
  }
  $("aboutBtn").addEventListener("click", showAbout);

  if (!nativeBridge) {
    // Shortcuts the native menu provides when running as the Mac app.
    document.addEventListener("keydown", function (e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      var k = e.key.toLowerCase();
      if (k === "o") { e.preventDefault(); openFile(); }
      else if (k === "e" && e.shiftKey) { e.preventDefault(); exportPNG(); }
      else if (k === "e") { e.preventDefault(); exportSVG(); }
    });
  }

  window.LogoGrid = {
    loadSVG: function (text, name) { return loadSVG(text, name); },
    openFile: openFile,
    exportSVG: exportSVG,
    exportPNG: exportPNG,
    copySVG: copySVG,
    showAbout: showAbout,
    toast: toast,
    updateStatus: updateStatus,
    zoomIn: function () { setZoom(state.zoom * 1.25); },
    zoomOut: function () { setZoom(state.zoom / 1.25); },
    zoomFit: function () { setZoom(1); },
    findImprovements: findImprovements,
    setView: function (view) {
      if (!state.refine) findImprovements();
      if (state.refine && (view === "original" || state.refine.doc)) setView(view);
    },
  };

  // ===============================================================
  // Start
  // ===============================================================

  buildLayers();
  buildCanvasControls();
  buildDetectionControls();
  buildPresets();
  renderRefinePanel();
  syncAll();
  syncScrollbarWidth();
  document.querySelectorAll(".export .btn").forEach(function (b) { b.disabled = true; });

  var last = prefs.lastFile;
  if (!(last && last.source && loadSVG(last.source, last.name, true))) {
    loadSVG(SAMPLE_SVG, "Sample mark.svg", true);
  }
  render();
  post("ready");
})();
