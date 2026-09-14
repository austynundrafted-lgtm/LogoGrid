/////////////////////////////////////////////////////////////////
//
// LogoGrid — refine engine
//
// Finds near-misses in a logo's construction (stroke weights that
// almost match, radii a hair apart, edges a fraction of a degree off
// 45°, shapes that are almost mirror images) and builds a corrected
// version by moving anchor points. Pure functions, no DOM.
//
/////////////////////////////////////////////////////////////////

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geometry.js"));
  else root.LogoGridRefine = factory(root.LogoGridGeometry);
})(typeof self !== "undefined" ? self : this, function (G) {
  "use strict";

  // Everything is measured with the artwork scaled to the detection size
  // (longest side 600 units), so tolerances mean the same for any SVG.
  var SIZE = G.DETECTION_SIZE;

  var MIN_MOVE = 0.2; // smallest correction worth suggesting
  var MIN_EDGE = 10; // shortest edge that takes part in suggestions
  var STANDARD_ANGLE = 15; // angles snap to multiples of this…
  var ANGLE_SNAP = 1.5; // …when they're within this many degrees
  var ANGLE_LINK = 1.5; // edges this close in angle are meant to be parallel
  var ANGLE_SPAN = 2.5;
  var WEIGHT_LINK = 1.06; // weights within 6% of each other are meant to match
  var WEIGHT_SPAN = 1.1;
  var RADIUS_LINK = 1.05;
  var RADIUS_SPAN = 1.08;
  var ALIGN_LINK = 4; // separate edges this close to one line are meant to share it
  var ALIGN_SPAN = 6;
  var MIN_WEIGHT = 1.5;
  var MAX_WEIGHT = 400; // two thirds of the logo: anything wider is a background, not a stroke
  var CONCENTRIC = 0.04; // centers within this fraction of the radius are meant to coincide
  var CENTER_LINK = 3;
  var TANGENT_DEGREES = 4;
  var SYMMETRY_MATCH = 12; // a point's mirror image must land this close to a partner
  var SYMMETRY_COVERAGE = 0.8; // share of points that must have partners
  var SYMMETRY_TYPICAL = 1; // median mismatch of a genuinely symmetric logo
  var SOLVE_ITERATIONS = 120;
  var MOVED = 1e-5;

  var KIND_ORDER = ["weight", "radius", "angle", "align", "gap", "concentric", "centers", "symmetry"];

  // ===============================================================
  // Vector helpers
  // ===============================================================

  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function mul(a, k) { return [a[0] * k, a[1] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function rad(deg) { return (deg * Math.PI) / 180; }
  function deg(r) { return (r * 180) / Math.PI; }
  function dirOf(angle) { return [Math.cos(rad(angle)), Math.sin(rad(angle))]; }
  function normalOf(angle) { return [-Math.sin(rad(angle)), Math.cos(rad(angle))]; }
  function fold(angle) { return ((angle % 180) + 180) % 180; }
  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function lineAngleDiff(a, b) {
    var d = Math.abs(fold(a) - fold(b));
    return Math.min(d, 180 - d);
  }
  function weightedMean(items, value, weight) {
    var sw = 0, sv = 0;
    items.forEach(function (it) { var w = weight(it); sw += w; sv += w * value(it); });
    return sv / (sw || 1);
  }
  // The value most of the weight already agrees on, so the odd one out moves
  // to match the rest (and an even split meets in the middle).
  function weightedMedian(items, value, weight) {
    var list = items.map(function (it) { return [value(it), weight(it)]; }).sort(function (a, b) { return a[0] - b[0]; });
    var total = list.reduce(function (s, v) { return s + v[1]; }, 0);
    var acc = 0;
    for (var i = 0; i < list.length; i++) {
      acc += list[i][1];
      if (Math.abs(acc - total / 2) < 1e-9 * total && i + 1 < list.length) return (list[i][0] + list[i + 1][0]) / 2;
      if (acc > total / 2) return list[i][0];
    }
    return list[list.length - 1][0];
  }
  function midpointOf(bz) { return G.cubicPoint(bz[0], bz[1], bz[2], bz[3], 0.5); }

  // Groups sorted numbers: neighbors within `link` join, and a group never
  // spans more than `span`. `ratio` compares by ratio instead of difference.
  function clusterSorted(items, value, link, span, ratio) {
    var groups = [], group = [];
    items.forEach(function (it) {
      if (group.length) {
        var prev = value(group[group.length - 1]), first = value(group[0]), v = value(it);
        var near = ratio ? v <= prev * link : v - prev <= link;
        var within = ratio ? v <= first * span : v - first <= span;
        if (!(near && within)) { groups.push(group); group = []; }
      }
      group.push(it);
    });
    if (group.length) groups.push(group);
    return groups;
  }

  // Targets for variables that start at `start`: every equation row
  // ({ terms: [[var, coef]], value }) holds exactly when they can all hold
  // together, and nothing moves further than needed. A faint pull toward the
  // current values keeps the system solvable; re-centering that pull on each
  // pass removes its bias.
  function solveTargets(start, rows) {
    var x = start.slice();
    for (var pass = 0; pass < 4; pass++) {
      var all = rows.map(function (r) { return { terms: r.terms, value: r.value, weight: 1 }; });
      x.forEach(function (v, i) { all.push({ terms: [[i, 1]], value: v, weight: 1e-3 }); });
      x = leastSquares(x.length, all);
    }
    return x;
  }

  // Small dense least-squares solve: rows of { terms: [[var, coef]], value, weight }.
  function leastSquares(count, rows) {
    var A = [], b = [];
    for (var i = 0; i < count; i++) { A.push(new Array(count).fill(0)); b.push(0); }
    rows.forEach(function (row) {
      var w = row.weight * row.weight;
      row.terms.forEach(function (ti) {
        row.terms.forEach(function (tj) { A[ti[0]][tj[0]] += w * ti[1] * tj[1]; });
        b[ti[0]] += w * ti[1] * row.value;
      });
    });
    for (var c = 0; c < count; c++) {
      var pivot = c;
      for (var r = c + 1; r < count; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
      var tmp = A[c]; A[c] = A[pivot]; A[pivot] = tmp;
      var tb = b[c]; b[c] = b[pivot]; b[pivot] = tb;
      if (Math.abs(A[c][c]) < 1e-15) continue;
      for (var r2 = c + 1; r2 < count; r2++) {
        var k = A[r2][c] / A[c][c];
        if (!k) continue;
        for (var c2 = c; c2 < count; c2++) A[r2][c2] -= k * A[c][c2];
        b[r2] -= k * b[c];
      }
    }
    var x = new Array(count).fill(0);
    for (var i2 = count - 1; i2 >= 0; i2--) {
      var sum = b[i2];
      for (var j = i2 + 1; j < count; j++) sum -= A[i2][j] * x[j];
      x[i2] = Math.abs(A[i2][i2]) < 1e-15 ? 0 : sum / A[i2][i2];
    }
    return x;
  }

  function copyPaths(paths, k) {
    return paths.map(function (sp) {
      return {
        id: sp.id,
        closed: sp.closed,
        nodes: sp.nodes.map(function (n) {
          return { anchor: mul(n.anchor, k), left: mul(n.left, k), right: mul(n.right, k) };
        }),
      };
    });
  }

  // ===============================================================
  // Fill test (is a point inside the painted artwork?)
  // ===============================================================

  function flatten(sp) {
    var pts = [];
    var n = sp.nodes.length;
    if (!n) return pts;
    pts.push(sp.nodes[0].anchor);
    var count = sp.closed ? n : n - 1;
    for (var j = 0; j < count; j++) {
      var p = sp.nodes[j], q = sp.nodes[(j + 1) % n];
      for (var t = 1; t <= 8; t++) pts.push(G.cubicPoint(p.anchor, p.right, q.left, q.anchor, t / 8));
    }
    return pts;
  }

  function winding(pt, poly) {
    var wn = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var side = (b[0] - a[0]) * (pt[1] - a[1]) - (pt[0] - a[0]) * (b[1] - a[1]);
      if (a[1] <= pt[1]) { if (b[1] > pt[1] && side > 0) wn++; }
      else if (b[1] <= pt[1] && side < 0) wn--;
    }
    return wn;
  }

  function fillTester(paths, fillRules) {
    var elements = {};
    paths.forEach(function (sp) {
      var el = String(sp.id).split("_")[0];
      (elements[el] = elements[el] || []).push(flatten(sp));
    });
    var keys = Object.keys(elements);
    return function (pt) {
      return keys.some(function (el) {
        var wn = 0;
        elements[el].forEach(function (poly) { wn += winding(pt, poly); });
        var rule = fillRules && fillRules[Number(el)];
        return rule === "evenodd" ? Math.abs(wn) % 2 === 1 : wn !== 0;
      });
    };
  }

  // ===============================================================
  // Model: the logo's edges and circles, with the nodes that draw them
  // ===============================================================

  function buildModel(paths, fillRules) {
    var bounds = G.getPathsBounds(paths);
    if (!bounds || !(Math.max(bounds.w, bounds.h) > 0)) return null;
    var scale = SIZE / Math.max(bounds.w, bounds.h);
    var scaled = copyPaths(paths, scale);
    var art = G.getPathsBounds(scaled);
    var pad = SIZE * 0.1;
    var result = G.analyze(scaled, { x: art.x - pad, y: art.y - pad, w: art.w + pad * 2, h: art.h + pad * 2 }, art);
    var trace = result.trace;

    var edges = trace.straight.map(function (e, k) {
      var fit = G.fitEdge(e.points);
      return {
        k: k,
        path: e.path,
        nodes: e.nodes,
        points: e.points,
        length: e.length,
        angle: fold(deg(Math.atan2(fit.dir[1], fit.dir[0]))),
        centroid: fit.point,
        eligible: e.length >= MIN_EDGE,
      };
    });

    var edgesAtNode = {};
    edges.forEach(function (e) {
      [0, e.nodes.length - 1].forEach(function (i) {
        var key = e.path + ":" + e.nodes[i];
        (edgesAtNode[key] = edgesAtNode[key] || []).push(e);
      });
    });

    var circles = [];
    var byGroup = {};
    trace.curves.forEach(function (c) {
      if (c.status !== "circle" && c.status !== "small") return;
      var fit = c.status === "circle" ? result.circles[c.circle] : c.fit;
      var key = c.status === "circle" ? "g" + c.circle : "s" + circles.length;
      var entity = byGroup[key];
      if (!entity) {
        entity = byGroup[key] = { k: circles.length, arcs: [], center: [fit.cx, fit.cy], r: fit.r, length: 0, sweep: 0 };
        circles.push(entity);
      }
      var center = [fit.cx, fit.cy];
      var signs = c.beziers.map(function (bz) {
        var a0 = Math.atan2(bz[0][1] - center[1], bz[0][0] - center[0]);
        var m = midpointOf(bz);
        var am = Math.atan2(m[1] - center[1], m[0] - center[0]);
        var a1 = Math.atan2(bz[3][1] - center[1], bz[3][0] - center[0]);
        return wrapPi(am - a0) + wrapPi(a1 - am);
      });
      var sweep = signs.reduce(function (s, v) { return s + v; }, 0);
      entity.arcs.push({
        path: c.path,
        nodes: c.nodes,
        beziers: c.beziers,
        signs: signs.map(Math.sign),
        start: Math.atan2(c.beziers[0][0][1] - center[1], c.beziers[0][0][0] - center[0]),
        sweep: sweep,
      });
      entity.length += c.length;
      entity.sweep += Math.abs(deg(sweep));
    });

    // Corners: an arc joining two straight edges it's tangent to. Its center
    // follows from those edges, so it stays tangent when they move. Between
    // two parallel edges it's a cap, whose radius is set by their distance.
    circles.forEach(function (c) {
      if (c.arcs.length !== 1) return;
      var arc = c.arcs[0];
      var first = arc.nodes[0], last = arc.nodes[arc.nodes.length - 1];
      if (first === last) return;
      function tangentEdge(nodeIndex, anchor) {
        var radial = sub(anchor, c.center);
        var tangentAngle = deg(Math.atan2(radial[0], -radial[1]));
        var list = edgesAtNode[arc.path + ":" + nodeIndex] || [];
        for (var i = 0; i < list.length; i++) {
          if (lineAngleDiff(list[i].angle, tangentAngle) <= TANGENT_DEGREES) return list[i];
        }
        return null;
      }
      var bzs = arc.beziers;
      var e1 = tangentEdge(first, bzs[0][0]);
      var e2 = tangentEdge(last, bzs[bzs.length - 1][3]);
      if (!e1 || !e2 || e1 === e2) return;
      var diff = lineAngleDiff(e1.angle, e2.angle);
      if (diff < 3) c.cap = { start: e1, end: e2 };
      else if (diff > 5) c.fillet = { start: e1, end: e2 };
    });

    var nodeCount = 0;
    scaled.forEach(function (sp) { nodeCount += sp.nodes.length; });

    return {
      scale: scale,
      paths: scaled,
      bounds: art,
      edges: edges,
      circles: circles,
      filled: fillTester(scaled, fillRules),
      nodeCount: nodeCount,
    };
  }

  function edgeSpan(edge, d) {
    var lo = Infinity, hi = -Infinity;
    edge.points.forEach(function (p) { var t = dot(p, d); lo = Math.min(lo, t); hi = Math.max(hi, t); });
    return [lo, hi];
  }

  function covers(circle, angle) {
    return circle.arcs.some(function (arc) {
      if (Math.abs(arc.sweep) >= 2 * Math.PI - 1e-3) return true;
      var delta = arc.sweep > 0 ? angle - arc.start : arc.start - angle;
      delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return delta <= Math.abs(arc.sweep);
    });
  }

  // ===============================================================
  // Finding suggestions
  // ===============================================================

  function suggest(model) {
    var suggestions = [];
    var checked = { weights: 0, gaps: 0, radii: 0, angles: 0, symmetry: [] };

    // ---- Angles: nearly parallel edges, and edges just off a standard angle

    var eligible = model.edges.filter(function (e) { return e.eligible; });
    var families = [];
    if (eligible.length) {
      var sorted = eligible.slice().sort(function (a, b) { return a.angle - b.angle; });
      // Start after the widest gap so a family near 0°/180° isn't split.
      var startAt = 0, widest = -1;
      for (var i = 0; i < sorted.length; i++) {
        var next = i + 1 < sorted.length ? sorted[i + 1].angle : sorted[0].angle + 180;
        if (next - sorted[i].angle > widest) { widest = next - sorted[i].angle; startAt = (i + 1) % sorted.length; }
      }
      var base = sorted[startAt].angle;
      var ordered = sorted.slice(startAt).concat(sorted.slice(0, startAt));
      ordered.forEach(function (e) { e.unwrapped = e.angle < base ? e.angle + 180 : e.angle; });
      families = clusterSorted(ordered, function (e) { return e.unwrapped; }, ANGLE_LINK, ANGLE_SPAN);
    }

    families.forEach(function (family, f) {
      var mean = weightedMean(family, function (e) { return e.unwrapped; }, function (e) { return e.length; });
      var standard = Math.round(mean / STANDARD_ANGLE) * STANDARD_ANGLE;
      var target = Math.abs(mean - standard) <= ANGLE_SNAP ? standard : mean;
      family.angle = target;
      family.index = f;
      family.forEach(function (e) { e.family = family; });
      checked.angles += family.length;

      var n = normalOf(target);
      var moves = family.map(function (e) {
        var c = e.centroid;
        return Math.max.apply(null, e.points.map(function (p) { return Math.abs(dot(sub(p, c), n)); }));
      });
      var worst = Math.max.apply(null, moves);
      if (worst < MIN_MOVE) return;
      var movers = family.filter(function (e, i) { return moves[i] >= MIN_MOVE / 2; });
      var shown = fold(180 - fold(target));
      var title;
      if (shown === 0) title = "Level " + plural(movers.length, "edge") + " to horizontal";
      else if (shown === 90) title = "Make " + plural(movers.length, "edge") + " exactly vertical";
      else if (target === standard) title = "Set " + plural(movers.length, "edge") + " to exactly " + shown + "°";
      else title = "Make " + plural(family.length, "edge") + " parallel";
      var now = unique(movers.map(function (e) { return fmtAngle(fold(180 - e.angle)); }));
      suggestions.push({
        kind: "angle",
        title: title,
        detail: (target === standard ? "Now " : "At " + fmtAngle(shown) + " · now ") + now.join(", "),
        count: movers.length,
        maxMove: worst,
        data: { edges: family.map(function (e) { return e.k; }), angle: target },
        marks: family.map(function (e, i) {
          return { type: "polyline", points: e.points, role: moves[i] >= MIN_MOVE / 2 ? "issue" : "ok" };
        }).concat(movers.map(function (e) {
          var d = dirOf(target), reach = Math.max(e.length * 0.75, 40);
          return { type: "line", a: sub(e.centroid, mul(d, reach)), b: add(e.centroid, mul(d, reach)), role: "target" };
        })),
      });
    });

    // ---- Stroke weights, gaps and alignment between parallel edges

    var weights = [], gaps = [], alignPairs = [];
    families.forEach(function (family) {
      if (family.length < 2) return;
      var d = dirOf(family.angle), n = normalOf(family.angle);
      var info = family.map(function (e) {
        var span = edgeSpan(e, d);
        return { edge: e, offset: dot(e.centroid, n), lo: span[0], hi: span[1] };
      }).sort(function (a, b) { return a.offset - b.offset; });

      for (var i = 0; i < info.length; i++) {
        for (var j = i + 1; j < info.length; j++) {
          var A = info[i], B = info[j];
          var w = B.offset - A.offset;
          var lo = Math.max(A.lo, B.lo), hi = Math.min(A.hi, B.hi);
          var overlap = hi - lo;
          var shorter = Math.min(A.hi - A.lo, B.hi - B.lo);
          if (overlap < 0) {
            if (w >= MIN_MOVE && w <= ALIGN_LINK) alignPairs.push([A, B]);
            continue;
          }
          // A stroke (or gap) runs at least as far as it is wide; across its
          // length is just the shape's size.
          if (overlap < 0.5 * shorter || overlap < w || w < MIN_WEIGHT || w > MAX_WEIGHT) continue;
          var between = info.some(function (C, k) {
            if (k === i || k === j || C.offset <= A.offset + 0.05 * w || C.offset >= B.offset - 0.05 * w) return false;
            return Math.min(C.hi, hi) - Math.max(C.lo, lo) > 0.1 * overlap;
          });
          if (between) continue;
          var inside = true, outside = true, beyond = true;
          var eps = Math.min(1, 0.2 * w);
          [0.25, 0.5, 0.75].forEach(function (ft) {
            var t = lo + ft * overlap;
            [0.2, 0.5, 0.8].forEach(function (fo) {
              var filled = model.filled(add(mul(d, t), mul(n, A.offset + fo * w)));
              if (filled) outside = false; else inside = false;
            });
            if (!model.filled(add(mul(d, t), mul(n, A.offset - eps))) || !model.filled(add(mul(d, t), mul(n, B.offset + eps)))) beyond = false;
          });
          var t0 = lo + overlap / 2;
          var item = {
            kind: "stem",
            value: w,
            weight: overlap,
            edges: [A.edge, B.edge],
            family: family,
            dimension: [add(mul(d, t0), mul(n, A.offset)), add(mul(d, t0), mul(n, B.offset))],
          };
          if (inside) weights.push(item);
          else if (outside && beyond) gaps.push(item);
        }
      }
    });

    // Rings: the band between two concentric circles.
    var plain = model.circles.filter(function (c) { return !c.fillet && !c.cap; });
    for (var a = 0; a < plain.length; a++) {
      for (var b = a + 1; b < plain.length; b++) {
        var inner = plain[a].r < plain[b].r ? plain[a] : plain[b];
        var outer = inner === plain[a] ? plain[b] : plain[a];
        var width = outer.r - inner.r;
        if (width < MIN_WEIGHT || width > MAX_WEIGHT) continue;
        if (dist(inner.center, outer.center) > Math.max(CONCENTRIC * inner.r, 1.5)) continue;
        var center = add(mul(inner.center, 0.5), mul(outer.center, 0.5));
        var angles = [];
        for (var s = 0; s < 36; s++) {
          var ang = (s / 36) * 2 * Math.PI;
          if (covers(inner, ang) && covers(outer, ang)) angles.push(ang);
        }
        if (angles.length < 2) continue;
        var ringInside = true, ringOutside = true, ringBeyond = true;
        angles.forEach(function (ang) {
          var u = [Math.cos(ang), Math.sin(ang)];
          [0.2, 0.5, 0.8].forEach(function (fo) {
            if (model.filled(add(center, mul(u, inner.r + fo * width)))) ringOutside = false; else ringInside = false;
          });
          var eps = Math.min(1, 0.2 * width);
          if (!model.filled(add(center, mul(u, inner.r - eps))) || !model.filled(add(center, mul(u, outer.r + eps)))) ringBeyond = false;
        });
        var mid = angles[Math.floor(angles.length / 2)];
        var um = [Math.cos(mid), Math.sin(mid)];
        var ring = {
          kind: "ring",
          value: width,
          weight: (angles.length / 36) * 2 * Math.PI * (inner.r + width / 2),
          circles: [inner, outer],
          dimension: [add(center, mul(um, inner.r)), add(center, mul(um, outer.r))],
        };
        if (ringInside) weights.push(ring);
        else if (ringOutside && ringBeyond) gaps.push(ring);
      }
    }

    checked.weights = weights.length;
    checked.gaps = gaps.length;

    function spacingSuggestions(items, kind) {
      items.sort(function (x, y) { return x.value - y.value; });
      clusterSorted(items, function (it) { return it.value; }, WEIGHT_LINK, WEIGHT_SPAN, true).forEach(function (group) {
        if (group.length < 2) return;
        var target = weightedMedian(group, function (it) { return it.value; }, function (it) { return it.weight; });
        var worst = Math.max.apply(null, group.map(function (it) { return Math.abs(it.value - target); }));
        if (worst < MIN_MOVE) return;
        var marks = [];
        group.forEach(function (it) {
          var role = Math.abs(it.value - target) >= MIN_MOVE / 2 ? "issue" : "ok";
          if (it.edges) it.edges.forEach(function (e) { marks.push({ type: "polyline", points: e.points, role: role }); });
          else it.circles.forEach(function (c) { c.arcs.forEach(function (arc) { arc.beziers.forEach(function (bz) { marks.push({ type: "bezier", bz: bz, role: role }); }); }); });
          marks.push({ type: "dimension", a: it.dimension[0], b: it.dimension[1], role: role, value: it.value });
        });
        var movers = group.filter(function (it) { return Math.abs(it.value - target) >= MIN_MOVE / 2; });
        suggestions.push({
          kind: kind,
          title: kind === "weight" ? "Match " + plural(group.length, "stroke weight") : "Even out " + plural(group.length, "gap"),
          detail: "Set to {" + target + "} · now " + unique(group.map(function (it) { return "{" + it.value + "}"; })).join(", "),
          count: movers.length,
          maxMove: worst / 2,
          data: {
            target: target,
            items: group.map(function (it) {
              return it.edges
                ? { type: "edges", a: it.edges[0].k, b: it.edges[1].k, angle: it.family.angle }
                : { type: "ring", inner: it.circles[0].k, outer: it.circles[1].k };
            }),
          },
          marks: marks,
        });
      });
    }
    spacingSuggestions(weights, "weight");
    spacingSuggestions(gaps, "gap");

    // Alignment: separate edges that sit almost on one line.
    var parent = {};
    function findRoot(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
    alignPairs.forEach(function (pair) {
      [pair[0], pair[1]].forEach(function (it) { if (parent[it.edge.k] == null) parent[it.edge.k] = it.edge.k; });
      parent[findRoot(pair[0].edge.k)] = findRoot(pair[1].edge.k);
    });
    var alignGroups = {};
    var infoByEdge = {};
    alignPairs.forEach(function (pair) {
      [pair[0], pair[1]].forEach(function (it) {
        infoByEdge[it.edge.k] = it;
        var root = findRoot(it.edge.k);
        alignGroups[root] = alignGroups[root] || {};
        alignGroups[root][it.edge.k] = it;
      });
    });
    Object.keys(alignGroups).forEach(function (root) {
      var group = Object.keys(alignGroups[root]).map(function (k) { return alignGroups[root][k]; });
      var offsets = group.map(function (it) { return it.offset; });
      if (Math.max.apply(null, offsets) - Math.min.apply(null, offsets) > ALIGN_SPAN) return;
      // Edges that overlap along the line are a stroke or gap, not an alignment.
      for (var x = 0; x < group.length; x++) {
        for (var y = x + 1; y < group.length; y++) {
          if (Math.min(group[x].hi, group[y].hi) - Math.max(group[x].lo, group[y].lo) >= 0) return;
        }
      }
      var family = group[0].edge.family;
      var target = weightedMedian(group, function (it) { return it.offset; }, function (it) { return it.edge.length; });
      var worst = Math.max.apply(null, group.map(function (it) { return Math.abs(it.offset - target); }));
      if (worst < MIN_MOVE) return;
      var d = dirOf(family.angle), n = normalOf(family.angle);
      var lo = Math.min.apply(null, group.map(function (it) { return it.lo; }));
      var hi = Math.max.apply(null, group.map(function (it) { return it.hi; }));
      var shown = fold(180 - fold(family.angle));
      var spread = Math.max.apply(null, offsets) - Math.min.apply(null, offsets);
      suggestions.push({
        kind: "align",
        title: "Align " + plural(group.length, "edge"),
        detail: (shown === 0 ? "On one horizontal line" : shown === 90 ? "On one vertical line" : "On one line") + " · now up to {" + spread + "} apart",
        count: group.filter(function (it) { return Math.abs(it.offset - target) >= MIN_MOVE / 2; }).length,
        maxMove: worst,
        data: { edges: group.map(function (it) { return it.edge.k; }), offset: target },
        marks: group.map(function (it) {
          return { type: "polyline", points: it.edge.points, role: Math.abs(it.offset - target) >= MIN_MOVE / 2 ? "issue" : "ok" };
        }).concat([{ type: "line", a: add(mul(d, lo - 20), mul(n, target)), b: add(mul(d, hi + 20), mul(n, target)), role: "target" }]),
      });
    });

    // ---- Radii

    var radial = model.circles.filter(function (c) { return !c.cap && c.r >= 2; }).sort(function (x, y) { return x.r - y.r; });
    checked.radii = radial.length;
    var radiusGroups = [];
    radial.forEach(function (c) {
      var group = radiusGroups[radiusGroups.length - 1];
      var fits = group && c.r <= group[group.length - 1].r * RADIUS_LINK && c.r <= group[0].r * RADIUS_SPAN &&
        !group.some(function (o) { return dist(o.center, c.center) < 0.5 * Math.min(o.r, c.r); });
      if (fits) group.push(c);
      else radiusGroups.push([c]);
    });
    radiusGroups.forEach(function (group) {
      if (group.length < 2) return;
      var target = weightedMedian(group, function (c) { return c.r; }, function (c) { return c.length; });
      var worst = Math.max.apply(null, group.map(function (c) { return Math.abs(c.r - target); }));
      if (worst < MIN_MOVE) return;
      var corners = group.every(function (c) { return c.fillet; });
      var marks = [];
      group.forEach(function (c) {
        var role = Math.abs(c.r - target) >= MIN_MOVE / 2 ? "issue" : "ok";
        c.arcs.forEach(function (arc) { arc.beziers.forEach(function (bz) { marks.push({ type: "bezier", bz: bz, role: role }); }); });
        marks.push({ type: "circle", c: c.center, r: target, role: "target" });
      });
      suggestions.push({
        kind: "radius",
        title: "Match " + plural(group.length, corners ? "corner radius" : "curve radius", corners ? "corner radii" : "curve radii"),
        detail: "Set to {" + target + "} · now " + unique(group.map(function (c) { return "{" + c.r + "}"; })).join(", "),
        count: group.filter(function (c) { return Math.abs(c.r - target) >= MIN_MOVE / 2; }).length,
        maxMove: worst,
        data: { circles: group.map(function (c) { return c.k; }), r: target },
        marks: marks,
      });
    });

    // ---- Concentric circles and lined-up centers

    var round = model.circles.filter(function (c) { return !c.fillet && c.sweep >= 90; });
    var cparent = round.map(function (c, i) { return i; });
    function croot(x) { while (cparent[x] !== x) x = cparent[x] = cparent[cparent[x]]; return x; }
    for (var ci = 0; ci < round.length; ci++) {
      for (var cj = ci + 1; cj < round.length; cj++) {
        var cd = dist(round[ci].center, round[cj].center);
        if (cd <= Math.max(CONCENTRIC * Math.min(round[ci].r, round[cj].r), 1.5) && Math.abs(round[ci].r - round[cj].r) >= MIN_WEIGHT) {
          cparent[croot(ci)] = croot(cj);
        }
      }
    }
    var concentricGroups = {};
    round.forEach(function (c, i) { (concentricGroups[croot(i)] = concentricGroups[croot(i)] || []).push(c); });
    Object.keys(concentricGroups).forEach(function (key) {
      var group = concentricGroups[key];
      if (group.length < 2) return;
      var target = [
        weightedMedian(group, function (c) { return c.center[0]; }, function (c) { return c.length; }),
        weightedMedian(group, function (c) { return c.center[1]; }, function (c) { return c.length; }),
      ];
      var worst = Math.max.apply(null, group.map(function (c) { return dist(c.center, target); }));
      if (worst < MIN_MOVE) return;
      var marks = [];
      group.forEach(function (c) {
        marks.push({ type: "circle", c: c.center, r: c.r, role: "issue" });
        marks.push({ type: "dot", p: c.center, role: "issue" });
      });
      marks.push({ type: "dot", p: target, role: "target" });
      var spread = 0;
      group.forEach(function (x) { group.forEach(function (y) { spread = Math.max(spread, dist(x.center, y.center)); }); });
      suggestions.push({
        kind: "concentric",
        title: "Center " + plural(group.length, "circle") + " on one point",
        detail: "Their centers are {" + spread + "} apart",
        count: group.length,
        maxMove: worst,
        data: { circles: group.map(function (c) { return c.k; }), center: target },
        marks: marks,
      });
    });

    // Round shapes, one per set of concentric circles (their centers are the concentric check's job).
    var dots = model.circles.filter(function (c) {
      return !c.fillet && !c.cap && c.sweep >= 300 && !model.circles.some(function (o) {
        return o !== c && o.r > c.r && o.sweep >= 300 && dist(o.center, c.center) < 0.5 * c.r;
      });
    });
    [0, 1].forEach(function (axis) {
      var list = dots.slice().sort(function (x, y) { return x.center[axis] - y.center[axis]; });
      clusterSorted(list, function (c) { return c.center[axis]; }, CENTER_LINK, CENTER_LINK * 1.5).forEach(function (group) {
        if (group.length < 2) return;
        var target = weightedMedian(group, function (c) { return c.center[axis]; }, function (c) { return c.length; });
        var worst = Math.max.apply(null, group.map(function (c) { return Math.abs(c.center[axis] - target); }));
        if (worst < MIN_MOVE) return;
        // Circles already sharing a center are the concentric check's job.
        var distinct = group.some(function (x) { return group.some(function (y) { return dist(x.center, y.center) > Math.max(x.r, y.r); }); });
        if (!distinct) return;
        var ext = group.map(function (c) { return c.center[1 - axis]; });
        var lo = Math.min.apply(null, ext) - 30, hi = Math.max.apply(null, ext) + 30;
        var a = [0, 0], b = [0, 0];
        a[axis] = b[axis] = target; a[1 - axis] = lo; b[1 - axis] = hi;
        var spread = group[group.length - 1].center[axis] - group[0].center[axis];
        suggestions.push({
          kind: "centers",
          title: "Line up " + plural(group.length, "circle center"),
          detail: (axis === 0 ? "On one vertical line" : "On one horizontal line") + " · now {" + spread + "} apart",
          count: group.length,
          maxMove: worst,
          data: { circles: group.map(function (c) { return c.k; }), axis: axis, value: target },
          marks: group.map(function (c) { return { type: "circle", c: c.center, r: c.r, role: "issue" }; })
            .concat(group.map(function (c) { return { type: "dot", p: c.center, role: "issue" }; }))
            .concat([{ type: "line", a: a, b: b, role: "target" }]),
        });
      });
    });

    // ---- Symmetry

    symmetrySuggestions(model, suggestions, checked);

    suggestions.sort(function (x, y) {
      return KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || y.maxMove - x.maxMove;
    });
    suggestions.forEach(function (sg, i) { sg.id = sg.kind + "-" + i; });
    return { suggestions: suggestions, checked: checked };
  }

  // Mirror symmetry across a vertical or horizontal axis, for the whole logo
  // and for single shapes. Points are grouped by position (paths that share a
  // vertex move together) and paired with the point their mirror image lands
  // on, when the neighbors on both sides mirror too.
  function symmetrySuggestions(model, suggestions, checked) {
    if (model.nodeCount > 4000) return;
    var groups = [];
    var byKey = {};
    model.paths.forEach(function (sp, pi) {
      sp.nodes.forEach(function (nd, ni) {
        var key = Math.round(nd.anchor[0] * 20) + "," + Math.round(nd.anchor[1] * 20);
        var g = byKey[key];
        if (!g) { g = byKey[key] = { p: nd.anchor, refs: [], neighbors: [] }; groups.push(g); }
        g.refs.push([pi, ni]);
        var n = sp.nodes.length;
        if (sp.closed || ni > 0) g.neighbors.push(sp.nodes[(ni - 1 + n) % n].anchor);
        if (sp.closed || ni < n - 1) g.neighbors.push(sp.nodes[(ni + 1) % n].anchor);
      });
    });

    function attempt(members, axis, label, element) {
      if (members.length < 4) return null;
      var lo = Infinity, hi = -Infinity;
      members.forEach(function (g) { lo = Math.min(lo, g.p[axis]); hi = Math.max(hi, g.p[axis]); });
      var position = (lo + hi) / 2;
      var pairs = [];
      function mirror(p) { var q = p.slice(); q[axis] = 2 * position - p[axis]; return q; }
      function nearest(p, exclude) {
        var best = null, bestD = Infinity;
        members.forEach(function (g) {
          if (g === exclude) return;
          var dd = dist(g.p, p);
          if (dd < bestD) { bestD = dd; best = g; }
        });
        return { g: best, d: bestD };
      }
      // The axis runs through the middle of the extremes, so a correction keeps
      // the logo's outer bounds.
      (function () {
        var used = new Set();
        members.forEach(function (g) {
          if (used.has(g)) return;
          var hit = nearest(mirror(g.p));
          if (!hit.g || hit.d > SYMMETRY_MATCH || used.has(hit.g)) return;
          if (nearest(mirror(hit.g.p)).g !== g) return;
          // Neighbors must mirror as well, or it's a coincidence.
          var ok = g.neighbors.every(function (nb) {
            return hit.g.neighbors.some(function (mb) { return dist(mirror(nb), mb) <= SYMMETRY_MATCH * 1.5; });
          });
          if (!ok) return;
          used.add(g); used.add(hit.g);
          pairs.push([g, hit.g, hit.d]);
        });
      })();
      if (!pairs.length) return null;
      var matched = 0;
      pairs.forEach(function (pr) { matched += pr[0] === pr[1] ? 1 : 2; });
      if (matched < SYMMETRY_COVERAGE * members.length) return null;
      var errors = pairs.map(function (pr) { return dist(mirror(pr[0].p), pr[1].p); }).sort(function (x, y) { return x - y; });
      if (errors[Math.floor(errors.length / 2)] > SYMMETRY_TYPICAL) return null;
      var moves = pairs.map(function (pr) { return dist(mirror(pr[0].p), pr[1].p) / (pr[0] === pr[1] ? 1 : 2); });
      var worst = Math.max.apply(null, moves);
      checked.symmetry.push(label);
      if (worst < MIN_MOVE) return { covered: true };

      var marks = [];
      var b = model.bounds;
      var a1 = [0, 0], a2 = [0, 0];
      a1[axis] = a2[axis] = position;
      a1[1 - axis] = (axis === 0 ? b.y : b.x) - 30;
      a2[1 - axis] = (axis === 0 ? b.y + b.h : b.x + b.w) + 30;
      marks.push({ type: "line", a: a1, b: a2, role: "target" });
      var off = 0;
      pairs.forEach(function (pr, i) {
        if (moves[i] < MIN_MOVE / 2) return;
        off++;
        var t0;
        if (pr[0] === pr[1]) { t0 = pr[0].p.slice(); t0[axis] = position; }
        else t0 = mul(add(pr[0].p, mirror(pr[1].p)), 0.5);
        marks.push({ type: "arrow", a: pr[0].p, b: t0, role: "issue" });
        if (pr[0] !== pr[1]) marks.push({ type: "arrow", a: pr[1].p, b: mirror(t0), role: "issue" });
      });
      var orientation = axis === 0 ? "vertical" : "horizontal";
      var unmatched = members.length - matched;
      return {
        kind: "symmetry",
        title: element == null ? "Mirror across the " + orientation + " axis" : "Make a shape symmetrical (" + orientation + " axis)",
        detail: plural(off, "point") + " off their mirror image by up to {" + worst * 2 + "}" + (unmatched ? " · " + plural(unmatched, "point") + " without a partner stay put" : ""),
        count: off,
        maxMove: worst,
        data: {
          axis: axis,
          position: position,
          pairs: pairs.map(function (pr) { return [pr[0].refs, pr[1].refs]; }),
        },
        marks: marks,
      };
    }

    var covered = false;
    [0, 1].forEach(function (axis) {
      var s = attempt(groups, axis, axis === 0 ? "vertical" : "horizontal");
      if (s) covered = true;
      if (s && s.kind) suggestions.push(s);
    });
    if (covered) return;

    // No overall symmetry: check each shape on its own.
    var byElement = {};
    groups.forEach(function (g) {
      var el = String(model.paths[g.refs[0][0]].id).split("_")[0];
      (byElement[el] = byElement[el] || []).push(g);
    });
    // Circles and rings are symmetric by nature; an off-center one is the concentric check's job.
    var onRound = {};
    model.circles.forEach(function (c) {
      if (c.sweep < 300) return;
      c.arcs.forEach(function (arc) { arc.nodes.forEach(function (i) { onRound[arc.path + ":" + i] = true; }); });
    });
    var found = [];
    Object.keys(byElement).forEach(function (el) {
      if (byElement[el].length < 6) return;
      if (byElement[el].every(function (g) { return g.refs.every(function (ref) { return onRound[ref[0] + ":" + ref[1]]; }); })) return;
      [0, 1].forEach(function (axis) {
        var s = attempt(byElement[el], axis, "shape " + el + (axis === 0 ? " vertical" : " horizontal"), el);
        if (s && s.kind) found.push(s);
      });
    });
    found.sort(function (x, y) { return y.maxMove - x.maxMove; });
    found.slice(0, 6).forEach(function (s) { suggestions.push(s); });
  }

  // ===============================================================
  // Solving: move nodes until every accepted suggestion holds
  //
  // Accepted suggestions become fixed targets (a line for each edge, a
  // radius and maybe a center for each circle, mirror pairs). Neighbors
  // that get pushed keep their own line or circle, so a widened stem
  // doesn't tilt the edges around it or break a rounded corner's tangency.
  // Targets are enforced by repeated projection.
  // ===============================================================

  function solve(model, suggestions) {
    var paths = copyPaths(model.paths, 1);
    var original = model.paths;
    var edges = model.edges, circles = model.circles;

    // Desired lines: angle and offset along the normal.
    var edgeAngle = {}, governedEdge = {};
    var circleR = {}, circleCenter = {}, governedCircle = {};
    var mirrors = [];

    suggestions.forEach(function (sg) {
      if (sg.kind === "angle") {
        sg.data.edges.forEach(function (k) { edgeAngle[k] = sg.data.angle; governedEdge[k] = true; });
      }
    });
    function angleOf(e) {
      if (edgeAngle[e.k] != null) return edgeAngle[e.k];
      return e.family ? e.unwrapped : e.angle;
    }

    // Offsets: least squares over stroke, gap and alignment targets.
    var offsetVar = {}, offsetList = [];
    function ov(k) {
      if (offsetVar[k] == null) { offsetVar[k] = offsetList.length; offsetList.push(k); }
      return offsetVar[k];
    }
    var offsetRows = [];
    var radiusVar = {}, radiusList = [];
    function rv(k) {
      if (radiusVar[k] == null) { radiusVar[k] = radiusList.length; radiusList.push(k); }
      return radiusVar[k];
    }
    var radiusRows = [];
    var centerVar = {}, centerList = [];
    function cv(k) {
      if (centerVar[k] == null) { centerVar[k] = centerList.length; centerList.push(k); }
      return centerVar[k];
    }
    var centerRows = [[], []];

    function offsetOf(e) { return dot(e.centroid, normalOf(angleOf(e))); }

    suggestions.forEach(function (sg) {
      var data = sg.data;
      if (sg.kind === "weight" || sg.kind === "gap") {
        data.items.forEach(function (it) {
          if (it.type === "edges") {
            var A = edges[it.a], B = edges[it.b];
            var sign = offsetOf(B) - offsetOf(A) >= 0 ? 1 : -1;
            offsetRows.push({ terms: [[ov(A.k), -1], [ov(B.k), 1]], value: sign * data.target });
          } else {
            radiusRows.push({ terms: [[rv(it.inner), -1], [rv(it.outer), 1]], value: data.target });
          }
        });
      } else if (sg.kind === "align") {
        data.edges.forEach(function (k) { offsetRows.push({ terms: [[ov(k), 1]], value: data.offset }); });
      } else if (sg.kind === "radius") {
        data.circles.forEach(function (k) { radiusRows.push({ terms: [[rv(k), 1]], value: data.r }); });
      } else if (sg.kind === "concentric") {
        data.circles.forEach(function (k) {
          [0, 1].forEach(function (axis) { centerRows[axis].push({ terms: [[cv(k), 1]], value: data.center[axis] }); });
        });
      } else if (sg.kind === "centers") {
        data.circles.forEach(function (k) { centerRows[data.axis].push({ terms: [[cv(k), 1]], value: data.value }); });
      } else if (sg.kind === "symmetry") {
        mirrors.push(data);
      }
    });

    var offsets = solveTargets(offsetList.map(function (k) { return offsetOf(edges[k]); }), offsetRows);
    var edgeOffset = {};
    offsetList.forEach(function (k, i) { edgeOffset[k] = offsets[i]; governedEdge[k] = true; });

    var radii = solveTargets(radiusList.map(function (k) { return circles[k].r; }), radiusRows);
    radiusList.forEach(function (k, i) { circleR[k] = radii[i]; governedCircle[k] = true; });

    var centerAxes = [0, 1].map(function (axis) {
      return solveTargets(centerList.map(function (k) { return circles[k].center[axis]; }), centerRows[axis]);
    });
    centerList.forEach(function (k, i) { circleCenter[k] = [centerAxes[0][i], centerAxes[1][i]]; governedCircle[k] = true; });

    function lineOf(e) {
      var angle = angleOf(e);
      var n = normalOf(angle);
      return { n: n, d: dirOf(angle), offset: edgeOffset[e.k] != null ? edgeOffset[e.k] : dot(e.centroid, n) };
    }

    // Which nodes each edge and circle touches, to wake neighbors when pushed.
    var touching = {};
    function touch(key, item) { (touching[key] = touching[key] || []).push(item); }
    edges.forEach(function (e) { e.nodes.forEach(function (i) { touch(e.path + ":" + i, { edge: e }); }); });
    circles.forEach(function (c) { c.arcs.forEach(function (arc) { arc.nodes.forEach(function (i) { touch(arc.path + ":" + i, { circle: c }); }); }); });

    var awakeEdges = {}, awakeCircles = {};
    var pushed = {};
    var changed = 0;

    function moveAnchor(path, index, target, wake) {
      var nd = paths[path].nodes[index];
      var delta = sub(target, nd.anchor);
      var size = Math.abs(delta[0]) + Math.abs(delta[1]);
      if (size < 1e-12) return;
      nd.anchor = target;
      nd.left = add(nd.left, delta);
      nd.right = add(nd.right, delta);
      changed = Math.max(changed, size);
      if (wake && size > MOVED) pushed[path + ":" + index] = true;
    }
    function setHandle(path, index, side, value) {
      var nd = paths[path].nodes[index];
      changed = Math.max(changed, Math.abs(nd[side][0] - value[0]) + Math.abs(nd[side][1] - value[1]));
      nd[side] = value;
    }

    function projectEdge(e, line, wake) {
      e.nodes.forEach(function (i) {
        var p = paths[e.path].nodes[i].anchor;
        moveAnchor(e.path, i, sub(p, mul(line.n, dot(p, line.n) - line.offset)), wake);
      });
    }

    function currentPoints(c) {
      var pts = [];
      c.arcs.forEach(function (arc) {
        var nodes = paths[arc.path].nodes;
        for (var i = 0; i + 1 < arc.nodes.length; i++) {
          var p = nodes[arc.nodes[i]], q = nodes[arc.nodes[i + 1]];
          if (i === 0) pts.push(p.anchor);
          pts.push(G.cubicPoint(p.anchor, p.right, q.left, q.anchor, 0.5));
          pts.push(q.anchor);
        }
      });
      return pts;
    }

    function intersectOffsets(l1, s1, l2, s2, R) {
      var det = l1.n[0] * l2.n[1] - l1.n[1] * l2.n[0];
      if (Math.abs(det) < Math.sin(rad(5))) return null;
      var b1 = l1.offset + s1 * R, b2 = l2.offset + s2 * R;
      return [(b1 * l2.n[1] - l1.n[1] * b2) / det, (l1.n[0] * b2 - b1 * l2.n[0]) / det];
    }

    // Places a circle's arcs exactly on (center, R) and redraws their handles
    // as true circular arcs.
    function projectCircle(c, R, center, wake) {
      var arc0 = c.arcs[0];
      var slide = !!center; // an explicit new center; corners and caps place themselves
      if (!center && (c.fillet || c.cap)) {
        var l1 = lineOf(c.fillet ? c.fillet.start : c.cap.start);
        var l2 = lineOf(c.fillet ? c.fillet.end : c.cap.end);
        var s1 = Math.sign(dot(c.center, l1.n) - l1.offset) || 1;
        var s2 = Math.sign(dot(c.center, l2.n) - l2.offset) || 1;
        if (c.fillet) {
          center = intersectOffsets(l1, s1, l2, s2, R);
        } else {
          // Cap: centered between its two parallel edges, radius set by their distance.
          var off2 = l2.offset * dot(l2.n, l1.n); // the far edge's offset along this edge's normal
          R = Math.abs(off2 - l1.offset) / 2;
          var nodes0 = paths[arc0.path].nodes;
          var ends = add(nodes0[arc0.nodes[0]].anchor, nodes0[arc0.nodes[arc0.nodes.length - 1]].anchor);
          center = add(mul(l1.n, (l1.offset + off2) / 2), mul(l1.d, dot(ends, l1.d) / 2));
        }
        if (center) {
          var first = arc0.nodes[0], last = arc0.nodes[arc0.nodes.length - 1];
          moveAnchor(arc0.path, first, sub(center, mul(l1.n, dot(center, l1.n) - l1.offset)), wake);
          moveAnchor(arc0.path, last, sub(center, mul(l2.n, dot(center, l2.n) - l2.offset)), wake);
        }
      }
      if (!center) {
        var fit = G.fitCircle(currentPoints(c));
        if (!fit) return;
        center = fit.center;
        if (R == null) R = fit.radius;
      } else if (slide) {
        // Moving to a new center: slide the whole circle first, so its anchors
        // keep their angles (a circle's points stay at 0°, 90°, 180°, 270°).
        var now = G.fitCircle(currentPoints(c));
        if (now && dist(now.center, center) > 1e-9) {
          var shift = sub(center, now.center);
          var seen = {};
          c.arcs.forEach(function (arc) {
            arc.nodes.forEach(function (i) {
              var key = arc.path + ":" + i;
              if (seen[key]) return;
              seen[key] = true;
              moveAnchor(arc.path, i, add(paths[arc.path].nodes[i].anchor, shift), wake);
            });
          });
        }
      }
      c.arcs.forEach(function (arc) {
        var nodes = paths[arc.path].nodes;
        arc.nodes.forEach(function (i) {
          var p = nodes[i].anchor;
          var len = dist(p, center);
          if (len < 1e-9) return;
          moveAnchor(arc.path, i, add(center, mul(sub(p, center), R / len)), wake);
        });
        for (var s = 0; s + 1 < arc.nodes.length; s++) {
          var a = nodes[arc.nodes[s]].anchor, b = nodes[arc.nodes[s + 1]].anchor;
          var ta = Math.atan2(a[1] - center[1], a[0] - center[0]);
          var tb = Math.atan2(b[1] - center[1], b[0] - center[0]);
          var sweep = tb - ta;
          if (arc.signs[s] > 0) { while (sweep <= 0) sweep += 2 * Math.PI; while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI; }
          else { while (sweep >= 0) sweep -= 2 * Math.PI; while (sweep < -2 * Math.PI) sweep += 2 * Math.PI; }
          var k = (4 / 3) * Math.tan(sweep / 4) * R;
          setHandle(arc.path, arc.nodes[s], "right", add(a, mul([-Math.sin(ta), Math.cos(ta)], k)));
          setHandle(arc.path, arc.nodes[s + 1], "left", sub(b, mul([-Math.sin(tb), Math.cos(tb)], k)));
        }
      });
    }

    function projectMirror(m) {
      var axis = m.axis, position = m.position;
      function mirror(p) { var q = p.slice(); q[axis] = 2 * position - p[axis]; return q; }
      function mirrorVector(v) { var q = v.slice(); q[axis] = -v[axis]; return q; }
      m.pairs.forEach(function (pr) {
        var P = pr[0], Q = pr[1];
        var np = paths[P[0][0]].nodes[P[0][1]], nq = paths[Q[0][0]].nodes[Q[0][1]];
        var same = P === Q || (P.length === Q.length && P[0][0] === Q[0][0] && P[0][1] === Q[0][1]);
        var target = same ? np.anchor.slice() : mul(add(np.anchor, mirror(nq.anchor)), 0.5);
        if (same) target[axis] = position;
        // Handles: pair each handle with the partner's handle it mirrors best.
        var handles = null;
        if (P.length === 1 && Q.length === 1) {
          var pl = sub(np.left, np.anchor), pr2 = sub(np.right, np.anchor);
          var ql = mirrorVector(sub(nq.left, nq.anchor)), qr = mirrorVector(sub(nq.right, nq.anchor));
          var crossed = dist(pl, qr) + dist(pr2, ql), straight = dist(pl, ql) + dist(pr2, qr);
          if (Math.min(crossed, straight) <= SYMMETRY_MATCH) {
            handles = crossed <= straight
              ? { left: mul(add(pl, qr), 0.5), right: mul(add(pr2, ql), 0.5), crossed: true }
              : { left: mul(add(pl, ql), 0.5), right: mul(add(pr2, qr), 0.5), crossed: false };
          }
        }
        P.forEach(function (ref) { moveAnchor(ref[0], ref[1], target.slice(), true); });
        if (!same) Q.forEach(function (ref) { moveAnchor(ref[0], ref[1], mirror(target), true); });
        if (handles) {
          setHandle(P[0][0], P[0][1], "left", add(target, handles.left));
          setHandle(P[0][0], P[0][1], "right", add(target, handles.right));
          if (!same) {
            var mt = mirror(target);
            setHandle(Q[0][0], Q[0][1], handles.crossed ? "right" : "left", add(mt, mirrorVector(handles.left)));
            setHandle(Q[0][0], Q[0][1], handles.crossed ? "left" : "right", add(mt, mirrorVector(handles.right)));
          }
        }
      });
    }

    var governedEdges = edges.filter(function (e) { return governedEdge[e.k]; });
    var governedCircles = circles.filter(function (c) { return governedCircle[c.k]; });

    // Shape targets settle first; mirroring then averages each point with its
    // partner's mirror image, which keeps straight edges straight and parallel
    // edges parallel. A few rounds let neighbors settle around the mirrored result.
    var rounds = mirrors.length ? 4 : 1;
    for (var round = 0; round < rounds; round++) {
      for (var iter = 0; iter < SOLVE_ITERATIONS; iter++) {
        changed = 0;
        Object.keys(pushed).forEach(function (key) {
          (touching[key] || []).forEach(function (t) {
            if (t.edge && !governedEdge[t.edge.k]) awakeEdges[t.edge.k] = t.edge;
            if (t.circle && !governedCircle[t.circle.k]) awakeCircles[t.circle.k] = t.circle;
          });
        });
        var woke = Object.keys(pushed).length;
        pushed = {};

        Object.keys(awakeEdges).forEach(function (k) { projectEdge(awakeEdges[k], lineOf(awakeEdges[k]), false); });
        Object.keys(awakeCircles).forEach(function (k) {
          var c = awakeCircles[k];
          projectCircle(c, c.fillet ? c.r : null, null, !!(c.fillet || c.cap));
        });
        governedEdges.forEach(function (e) { projectEdge(e, lineOf(e), true); });
        governedCircles.forEach(function (c) { projectCircle(c, circleR[c.k] != null ? circleR[c.k] : c.r, circleCenter[c.k] || null, true); });

        if (iter > 2 && changed < 1e-9 && !woke) break;
      }
      mirrors.forEach(projectMirror);
    }

    var moved = [];
    paths.forEach(function (sp, pi) {
      sp.nodes.forEach(function (nd, ni) {
        if (dist(nd.anchor, original[pi].nodes[ni].anchor) > MIN_MOVE / 4) moved.push([original[pi].nodes[ni].anchor, nd.anchor]);
      });
    });
    return { paths: paths, moved: moved };
  }

  // ===============================================================
  // Public API (artwork units in and out)
  // ===============================================================

  function unscalePoint(p, s) { return [p[0] / s, p[1] / s]; }

  function unscaleMark(m, s) {
    var out = { type: m.type, role: m.role };
    if (m.points) out.points = m.points.map(function (p) { return unscalePoint(p, s); });
    if (m.bz) out.bz = m.bz.map(function (p) { return unscalePoint(p, s); });
    if (m.a) out.a = unscalePoint(m.a, s);
    if (m.b) out.b = unscalePoint(m.b, s);
    if (m.p) out.p = unscalePoint(m.p, s);
    if (m.c) { out.cx = m.c[0] / s; out.cy = m.c[1] / s; out.r = m.r / s; }
    if (m.value != null) out.value = m.value / s;
    return out;
  }

  // paths: [{ id, closed, nodes }] as imported. fillRules: per element, "nonzero" | "evenodd".
  // Returns { suggestions, checked, refine(ids) }. Lengths in suggestion text are
  // in artwork units.
  function inspect(paths, fillRules) {
    var model = buildModel(paths, fillRules);
    if (!model) return { suggestions: [], checked: { weights: 0, gaps: 0, radii: 0, angles: 0, symmetry: [] }, refine: function () { return { paths: paths, moved: [] }; } };
    var s = model.scale;
    var found = suggest(model);
    var byId = {};
    var suggestions = found.suggestions.map(function (sg) {
      byId[sg.id] = sg;
      return {
        id: sg.id,
        kind: sg.kind,
        title: sg.title,
        detail: sg.detail.replace(/\{([-\d.e+]+)\}/g, function (_, v) { return formatLength(Number(v) / s); }),
        count: sg.count,
        maxMove: sg.maxMove / s,
        marks: sg.marks.map(function (m) { return unscaleMark(m, s); }),
      };
    });
    return {
      suggestions: suggestions,
      checked: found.checked,
      refine: function (ids) {
        var chosen = ids.map(function (id) { return byId[id]; }).filter(Boolean);
        var solved = solve(model, chosen);
        // Round away float noise from the solve; points nothing moved come back untouched.
        function out(p, before, input) {
          if (p[0] === before[0] && p[1] === before[1]) return input.slice();
          return [Math.round((p[0] / s) * 1e6) / 1e6, Math.round((p[1] / s) * 1e6) / 1e6];
        }
        return {
          paths: solved.paths.map(function (sp, pi) {
            return {
              id: sp.id,
              closed: sp.closed,
              nodes: sp.nodes.map(function (n, ni) {
                var before = model.paths[pi].nodes[ni], input = paths[pi].nodes[ni];
                return { anchor: out(n.anchor, before.anchor, input.anchor), left: out(n.left, before.left, input.left), right: out(n.right, before.right, input.right) };
              }),
            };
          }),
          moved: solved.moved.map(function (mv) { return [unscalePoint(mv[0], s), unscalePoint(mv[1], s)]; }),
        };
      },
    };
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }
  function unique(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
  function formatLength(v) {
    var digits = v >= 100 ? 1 : v >= 1 ? 2 : 3;
    return String(Number(v.toFixed(digits)));
  }
  function fmtAngle(a) { return Math.round(a * 10) / 10 + "°"; }

  return { inspect: inspect, MIN_MOVE: MIN_MOVE };
});
