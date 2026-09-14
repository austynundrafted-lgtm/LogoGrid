// LogoGrid — SVG importer
// Turns SVG markup into bezier subpaths (for detection) and a sanitized copy
// of the original artwork (for the "Original" logo style).
(function () {
  "use strict";
  var G = window.LogoGridGeometry;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var XLINK_NS = "http://www.w3.org/1999/xlink";

  var SKIP = new Set([
    "defs", "clipPath", "mask", "pattern", "marker", "symbol", "linearGradient",
    "radialGradient", "filter", "style", "script", "title", "desc", "metadata",
    "text", "image", "foreignObject",
  ]);
  var CONTAINERS = new Set(["g", "a", "switch"]);

  function num(el, name, fallback) {
    var v = parseFloat(el.getAttribute(name));
    return isFinite(v) ? v : fallback || 0;
  }

  function points(el) {
    var nums = (el.getAttribute("points") || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    var out = [];
    for (var i = 0; i + 1 < nums.length; i += 2) out.push(nums[i] + " " + nums[i + 1]);
    return out;
  }

  function shapeToPathData(el) {
    switch (el.localName) {
      case "path":
        return el.getAttribute("d") || "";
      case "rect": {
        var x = num(el, "x"), y = num(el, "y"), w = num(el, "width"), h = num(el, "height");
        if (w <= 0 || h <= 0) return "";
        var rx = el.hasAttribute("rx") ? num(el, "rx") : num(el, "ry");
        var ry = el.hasAttribute("ry") ? num(el, "ry") : rx;
        rx = Math.min(Math.max(rx, 0), w / 2);
        ry = Math.min(Math.max(ry, 0), h / 2);
        if (!rx || !ry) return "M" + x + " " + y + "H" + (x + w) + "V" + (y + h) + "H" + x + "Z";
        return (
          "M" + (x + rx) + " " + y + "H" + (x + w - rx) +
          "A" + rx + " " + ry + " 0 0 1 " + (x + w) + " " + (y + ry) + "V" + (y + h - ry) +
          "A" + rx + " " + ry + " 0 0 1 " + (x + w - rx) + " " + (y + h) + "H" + (x + rx) +
          "A" + rx + " " + ry + " 0 0 1 " + x + " " + (y + h - ry) + "V" + (y + ry) +
          "A" + rx + " " + ry + " 0 0 1 " + (x + rx) + " " + y + "Z"
        );
      }
      case "circle":
      case "ellipse": {
        var cx = num(el, "cx"), cy = num(el, "cy");
        var erx = el.localName === "circle" ? num(el, "r") : num(el, "rx");
        var ery = el.localName === "circle" ? erx : num(el, "ry");
        if (erx <= 0 || ery <= 0) return "";
        var arc = "A" + erx + " " + ery + " 0 0 1 ";
        return (
          "M" + (cx + erx) + " " + cy + arc + cx + " " + (cy + ery) + arc + (cx - erx) + " " + cy +
          arc + cx + " " + (cy - ery) + arc + (cx + erx) + " " + cy + "Z"
        );
      }
      case "line":
        return "M" + num(el, "x1") + " " + num(el, "y1") + "L" + num(el, "x2") + " " + num(el, "y2");
      case "polyline":
      case "polygon": {
        var pts = points(el);
        if (pts.length < 2) return "";
        return "M" + pts.join("L") + (el.localName === "polygon" ? "Z" : "");
      }
    }
    return null;
  }

  // Imported artwork is rendered inside the app, so strip anything that can
  // run code or reach out: scripts, event handlers, javascript: links, and
  // external references.
  function sanitize(root) {
    root.querySelectorAll("script, foreignObject, iframe").forEach(function (el) {
      el.remove();
    });
    var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
    all.forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var value = attr.value.trim().toLowerCase();
        if (name.indexOf("on") === 0) el.removeAttribute(attr.name);
        else if (
          (name === "href" || name === "xlink:href" || name === "src") &&
          value.charAt(0) !== "#" && value.indexOf("data:image/") !== 0
        ) {
          el.removeAttribute(attr.name);
        }
      });
    });
    root.querySelectorAll("style").forEach(function (style) {
      style.textContent = style.textContent.replace(/@import[^;]*;?/gi, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none");
    });
  }

  function parseViewBox(root) {
    var parts = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
    }
    var w = parseFloat(root.getAttribute("width"));
    var h = parseFloat(root.getAttribute("height"));
    if (w > 0 && h > 0 && !/%/.test(root.getAttribute("width") + root.getAttribute("height"))) {
      return { x: 0, y: 0, w: w, h: h };
    }
    return null;
  }

  // Maps a viewBox into a viewport the way SVG does, honoring preserveAspectRatio
  // (default "xMidYMid meet": uniform scale, centered).
  function viewBoxTransform(vb, x, y, w, h, preserve) {
    var parts = (preserve || "").trim().split(/\s+/);
    var align = parts[0] || "xMidYMid";
    var sx = w / vb.w, sy = h / vb.h;
    if (align !== "none") {
      var scale = parts[1] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = sy = scale;
    }
    var tx = x - vb.x * sx, ty = y - vb.y * sy;
    if (align !== "none") {
      var extraW = w - vb.w * sx, extraH = h - vb.h * sy;
      if (/xMid/.test(align)) tx += extraW / 2;
      else if (/xMax/.test(align)) tx += extraW;
      if (/YMid/.test(align)) ty += extraH / 2;
      else if (/YMax/.test(align)) ty += extraH;
    }
    return [sx, 0, 0, sy, tx, ty];
  }

  function isTransparentColor(value) {
    return !value || value === "none" || value === "transparent" || /^rgba\(.*,\s*0\)$/.test(value);
  }

  // What the shape actually paints, from its computed style.
  function paintOf(style, opacity) {
    var fill = !isTransparentColor(style.fill) && parseFloat(style.fillOpacity) !== 0;
    var stroke =
      !isTransparentColor(style.stroke) && parseFloat(style.strokeOpacity) !== 0 && parseFloat(style.strokeWidth) !== 0;
    return { fill: fill && opacity > 0, stroke: stroke && opacity > 0 };
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function importSVG(text, name) {
    var xml = new DOMParser().parseFromString(text, "image/svg+xml");
    var root = xml.documentElement;
    if (!root || xml.getElementsByTagName("parsererror").length || root.localName !== "svg") {
      throw new Error("That file isn't a valid SVG.");
    }
    sanitize(root);

    // Attach off-screen so computed styles (including <style> classes) resolve.
    var host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;pointer-events:none";
    var live = document.importNode(root, true);
    host.appendChild(live);
    document.body.appendChild(host);

    var paths = [];
    var elements = [];
    var skipped = { text: 0, image: 0, invisible: 0, strokeOnly: 0, clipped: 0 };

    // `useSize` carries a <use> element's width/height down to the <symbol> it instantiates.
    function walk(el, matrix, depth, viaUse, opacity, useSize) {
      if (depth > 50 || el.namespaceURI !== SVG_NS) return;
      var tag = el.localName;
      if (tag === "text") skipped.text++;
      if (tag === "image") skipped.image++;
      if (SKIP.has(tag) && !(tag === "symbol" && viaUse)) return;
      var style = window.getComputedStyle(el);
      if (style.display === "none") return;
      opacity *= parseFloat(style.opacity);
      if (isNaN(opacity)) opacity = 1;
      var m = G.multiplyMatrix(matrix, G.parseTransform(el.getAttribute("transform")));

      var viewportBox = null;
      if (tag === "svg" && el !== live) {
        var w = parseFloat(el.getAttribute("width")), h = parseFloat(el.getAttribute("height"));
        viewportBox = { x: num(el, "x"), y: num(el, "y"), w: w, h: h };
      } else if (tag === "symbol" && useSize) {
        viewportBox = useSize;
      }
      if (viewportBox) {
        var vb = parseViewBox(el);
        var t = [1, 0, 0, 1, viewportBox.x, viewportBox.y];
        if (vb && viewportBox.w > 0 && viewportBox.h > 0) {
          t = viewBoxTransform(vb, viewportBox.x, viewportBox.y, viewportBox.w, viewportBox.h, el.getAttribute("preserveAspectRatio"));
        }
        m = G.multiplyMatrix(m, t);
      }

      if (tag === "svg" || tag === "symbol" || CONTAINERS.has(tag)) {
        for (var c = el.firstElementChild; c; c = c.nextElementSibling) walk(c, m, depth + 1, false, opacity, null);
        return;
      }

      if (tag === "use") {
        var ref = el.getAttribute("href") || el.getAttributeNS(XLINK_NS, "href") || "";
        if (ref.charAt(0) !== "#") return;
        var target = live.querySelector("#" + CSS.escape(ref.slice(1)));
        if (!target || target === el || target.contains(el)) return;
        var size = null;
        if (target.localName === "symbol") {
          var uw = parseFloat(el.getAttribute("width")), uh = parseFloat(el.getAttribute("height"));
          var symbolBox = parseViewBox(target);
          size = { x: 0, y: 0, w: uw > 0 ? uw : symbolBox ? symbolBox.w : 0, h: uh > 0 ? uh : symbolBox ? symbolBox.h : 0 };
        }
        walk(target, G.multiplyMatrix(m, [1, 0, 0, 1, num(el, "x"), num(el, "y")]), depth + 1, true, opacity, size);
        return;
      }

      var d = shapeToPathData(el);
      if (!d || style.visibility === "hidden") return;
      // Shapes that paint nothing (like the invisible artboard rectangle some
      // exporters add) would otherwise produce guidelines nobody can see.
      var paint = paintOf(style, opacity);
      if (!paint.fill && !paint.stroke) {
        skipped.invisible++;
        return;
      }
      if (!paint.fill) skipped.strokeOnly++;
      if (style.clipPath && style.clipPath !== "none") skipped.clipped++;
      var subs = G.parsePathData(d).map(function (sp) {
        return G.transformSubpath(sp, m);
      });
      if (!subs.length) return;
      var index = elements.length;
      subs.forEach(function (sp, j) {
        paths.push({ id: subs.length > 1 ? index + "_compound_" + j : String(index), closed: sp.closed, nodes: sp.nodes });
      });
      elements.push({
        d: subs.map(G.subpathToPathData).join(""),
        fillRule: style.fillRule === "evenodd" ? "evenodd" : "nonzero",
        // Flat paint, for drawing reshaped copies (refined logos) in their own colors.
        // Gradients and patterns have no flat color, so they fall back to the logo color.
        fill: paint.fill && !/^url/.test(style.fill) ? style.fill : paint.fill ? null : "none",
        fillOpacity: (parseFloat(style.fillOpacity) || 1) * opacity,
        stroke: paint.stroke && !/^url/.test(style.stroke) ? style.stroke : null,
        strokeWidth: (parseFloat(style.strokeWidth) || 0) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])),
      });
    }

    try {
      walk(live, G.IDENTITY, 0, false, 1, null);
    } finally {
      host.remove();
    }

    if (!paths.length) {
      throw new Error(
        skipped.text
          ? "This SVG only has live text. Convert the text to outlines first (Illustrator: Type › Create Outlines)."
          : "No visible vector shapes found in this SVG."
      );
    }

    // Things the grid can't see, so the user knows why something is missing.
    var notes = [];
    if (skipped.text) notes.push(plural(skipped.text, "text element", "text elements") + " ignored — convert text to outlines");
    if (skipped.image) notes.push(plural(skipped.image, "embedded image", "embedded images") + " ignored");
    if (skipped.strokeOnly) notes.push(plural(skipped.strokeOnly, "stroked shape follows", "stroked shapes follow") + " the stroke's center line — outline strokes for edge-accurate grids");
    if (skipped.clipped) notes.push(plural(skipped.clipped, "clipped shape is", "clipped shapes are") + " analyzed in full");

    var artBounds = G.getPathsBounds(paths);
    var artboard = parseViewBox(root) || artBounds;

    // Prepared copy of the original artwork, nested at artboard coordinates.
    var nested = root.cloneNode(true);
    ["x", "y", "width", "height", "viewBox", "preserveAspectRatio", "style"].forEach(function (a) {
      nested.removeAttribute(a);
    });
    nested.setAttribute("x", artboard.x);
    nested.setAttribute("y", artboard.y);
    nested.setAttribute("width", artboard.w);
    nested.setAttribute("height", artboard.h);
    nested.setAttribute("viewBox", [artboard.x, artboard.y, artboard.w, artboard.h].join(" "));
    nested.setAttribute("overflow", "visible");

    return {
      name: name || "Untitled.svg",
      source: text,
      originalMarkup: new XMLSerializer().serializeToString(nested),
      paths: paths,
      elements: elements,
      artboard: artboard,
      artBounds: artBounds,
      notes: notes,
      invisibleSkipped: skipped.invisible,
    };
  }

  window.LogoGridImporter = { importSVG: importSVG };
})();
