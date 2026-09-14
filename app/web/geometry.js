/////////////////////////////////////////////////////////////////
//
// LogoGrid — geometry engine
//
// Detects construction guidelines, arcs, anchor points and bezier
// handles from vector artwork. Pure functions, no DOM — runs in the
// app and under Node for tests.
//
// Detection logic adapted from "Logo Grid Lines" v1.3 for Adobe
// Illustrator by Studio Gibbous (www.studiogibbous.com), released
// under a Creative Commons license.
//
/////////////////////////////////////////////////////////////////

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LogoGridGeometry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Detection runs with the artwork scaled so its longest side is this many
  // units. The original script's pixel thresholds were tuned for logos of
  // roughly this size, so normalizing keeps results consistent for any SVG
  // (a 24-unit icon and a 5000-unit poster behave the same).
  var DETECTION_SIZE = 600;

  var DEFAULT_OPTIONS = {
    minSegmentLength: 10, // shortest straight segment that produces a guideline
    lineAngleTolerance: 2, // degrees — parallel lines within this merge
    lineMergeDistance: 5, // units — parallel lines closer than this merge
    minArcLength: 15, // shortest curve chord considered for circle detection
    minRadius: 8,
    maxRadius: 1500,
    circleMergeTolerance: 0.05, // fraction of radius
    circleFitTolerance: 0.02, // how far a curve may stray from a perfect circle, as a fraction of the arc's size
  };

  var EPS = 1e-6;

  // Detection tuning, in detection units (see DETECTION_SIZE).
  var SAMPLES_PER_SEGMENT = 8; // intervals sampled along each bezier for fitting
  var FLATNESS = 0.2; // a curve bowing less than this (or 0.1% of its chord) is a straight edge
  var COLLINEAR_TOLERANCE = 0.3; // joints within this of a line continue the same edge
  var AXIS_SNAP_DEGREES = 0.15; // guidelines this close to horizontal/vertical snap to the axis
  var TANGENT_BREAK_DEGREES = 20; // a sharper turn between curves starts a new arc
  var MIN_FIT_DEVIATION = 0.25; // fit tolerance floor, so tiny circles aren't rejected for rounding
  // Pieces join into one arc, and circles merge, only if one circle still hugs
  // all of them this closely (fraction of the arc's size). Slightly imperfect
  // tracing of one circle stays within ~0.3%; tangent arcs of different radii
  // forced onto one circle miss by 0.7% or more.
  var SAME_CIRCLE_TOLERANCE = 0.004;
  var MIN_SWEEP_DEGREES = 3; // arcs flatter than this don't define a useful circle

  // ===============================================================
  // Basic math
  // ===============================================================

  function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2));
  }

  function arePointsEqual(p1, p2, tolerance) {
    tolerance = tolerance || 0.001;
    return Math.abs(p1[0] - p2[0]) < tolerance && Math.abs(p1[1] - p2[1]) < tolerance;
  }

  function node(x, y) {
    return { anchor: [x, y], left: [x, y], right: [x, y] };
  }

  // Affine matrix [a, b, c, d, e, f] — same layout as SVG's matrix().
  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
    ];
  }

  function applyMatrix(m, p) {
    return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  }

  var IDENTITY = [1, 0, 0, 1, 0, 0];

  function parseTransform(str) {
    var m = IDENTITY.slice();
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    var match;
    while ((match = re.exec(str))) {
      var args = (match[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
      var t;
      switch (match[1]) {
        case "matrix":
          if (args.length < 6) continue;
          t = args.slice(0, 6);
          break;
        case "translate":
          t = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
          break;
        case "scale":
          var sx = args.length ? args[0] : 1;
          t = [sx, 0, 0, args.length > 1 ? args[1] : sx, 0, 0];
          break;
        case "rotate":
          var a = ((args[0] || 0) * Math.PI) / 180;
          var cos = Math.cos(a), sin = Math.sin(a);
          t = [cos, sin, -sin, cos, 0, 0];
          if (args.length >= 3) {
            t = multiplyMatrix(
              multiplyMatrix([1, 0, 0, 1, args[1], args[2]], t),
              [1, 0, 0, 1, -args[1], -args[2]]
            );
          }
          break;
        case "skewX":
          t = [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
          break;
        case "skewY":
          t = [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
          break;
      }
      m = multiplyMatrix(m, t);
    }
    return m;
  }

  function transformSubpath(sp, m) {
    return {
      closed: sp.closed,
      nodes: sp.nodes.map(function (n) {
        return {
          anchor: applyMatrix(m, n.anchor),
          left: applyMatrix(m, n.left),
          right: applyMatrix(m, n.right),
        };
      }),
    };
  }

  // ===============================================================
  // SVG path data → subpaths of bezier nodes
  //
  // Each node mirrors an Illustrator PathPoint: an anchor plus incoming
  // (left) and outgoing (right) handles. A straight segment has handles
  // that sit on their anchors.
  // ===============================================================

  function arcToCubics(x1, y1, rx, ry, angle, largeArc, sweep, x2, y2) {
    if (x1 === x2 && y1 === y2) return [];
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) return null; // degenerate arc is a straight line

    var phi = (angle * Math.PI) / 180;
    var cos = Math.cos(phi), sin = Math.sin(phi);
    var dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    var x1p = cos * dx + sin * dy;
    var y1p = -sin * dx + cos * dy;

    var lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
      var sl = Math.sqrt(lambda);
      rx *= sl;
      ry *= sl;
    }
    var rx2 = rx * rx, ry2 = ry * ry;
    var num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
    var den = rx2 * y1p * y1p + ry2 * x1p * x1p;
    var coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num) / den);
    if (largeArc === sweep) coef = -coef;
    var cxp = (coef * rx * y1p) / ry;
    var cyp = (-coef * ry * x1p) / rx;
    var cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
    var cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

    function vecAngle(ux, uy, vx, vy) {
      var dot = ux * vx + uy * vy;
      var len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
      var a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
      return ux * vy - uy * vx < 0 ? -a : a;
    }

    var ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    var vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    var theta = vecAngle(1, 0, ux, uy);
    var delta = vecAngle(ux, uy, vx, vy);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    else if (sweep && delta < 0) delta += 2 * Math.PI;

    var segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
    var step = delta / segments;
    var k = (4 / 3) * Math.tan(step / 4);

    function map(px, py) {
      return [cos * rx * px - sin * ry * py + cx, sin * rx * px + cos * ry * py + cy];
    }

    var out = [];
    for (var i = 0; i < segments; i++) {
      var c1 = Math.cos(theta), s1 = Math.sin(theta);
      var c2 = Math.cos(theta + step), s2 = Math.sin(theta + step);
      out.push([map(c1 - k * s1, s1 + k * c1), map(c2 + k * s2, s2 - k * c2), map(c2, s2)]);
      theta += step;
    }
    out[out.length - 1][2] = [x2, y2];
    return out;
  }

  function parsePathData(d) {
    var subpaths = [];
    var current = null;
    var cx = 0, cy = 0; // current point
    var sx = 0, sy = 0; // subpath start
    var lastCubic = null; // second control point of previous C/S
    var lastQuad = null; // control point of previous Q/T
    var i = 0;
    var n = d.length;
    var numberRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

    function skipSeparators() {
      while (i < n) {
        var c = d.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++;
        else break;
      }
    }
    function readNumber() {
      skipSeparators();
      numberRe.lastIndex = i;
      var m = numberRe.exec(d);
      if (!m) return null;
      i = numberRe.lastIndex;
      return parseFloat(m[0]);
    }
    function readFlag() {
      skipSeparators();
      var c = d[i];
      if (c === "0" || c === "1") {
        i++;
        return c === "1";
      }
      return null;
    }
    function readNumbers(count) {
      var out = [];
      for (var k = 0; k < count; k++) {
        var v = readNumber();
        if (v === null) return null;
        out.push(v);
      }
      return out;
    }
    function ensureSubpath() {
      if (!current) {
        current = { closed: false, nodes: [node(cx, cy)] };
        subpaths.push(current);
        sx = cx;
        sy = cy;
      }
    }
    function lineTo(x, y) {
      ensureSubpath();
      current.nodes.push(node(x, y));
      cx = x;
      cy = y;
    }
    function cubicTo(x1, y1, x2, y2, x, y) {
      ensureSubpath();
      current.nodes[current.nodes.length - 1].right = [x1, y1];
      var nd = node(x, y);
      nd.left = [x2, y2];
      current.nodes.push(nd);
      cx = x;
      cy = y;
    }
    function closePath() {
      if (current) {
        current.closed = true;
        var nodes = current.nodes;
        if (nodes.length > 1) {
          var first = nodes[0], last = nodes[nodes.length - 1];
          // An explicit segment back to the start duplicates the first anchor.
          // Exporters that write relative commands accumulate rounding, so the
          // end can miss the start by a hair (0.01 in a 600-unit logo).
          var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          nodes.forEach(function (nd) {
            minX = Math.min(minX, nd.anchor[0]); maxX = Math.max(maxX, nd.anchor[0]);
            minY = Math.min(minY, nd.anchor[1]); maxY = Math.max(maxY, nd.anchor[1]);
          });
          var closeTolerance = Math.max(EPS, 5e-4 * Math.max(maxX - minX, maxY - minY));
          if (nodes.length > 2 && getDistance(first.anchor, last.anchor) < closeTolerance) {
            first.left = last.left;
            nodes.pop();
          }
        }
      }
      current = null;
      cx = sx;
      cy = sy;
    }

    var cmd = null;
    while (true) {
      skipSeparators();
      if (i >= n) break;
      var ch = d[i];
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
        cmd = ch;
        i++;
      } else if (!cmd || !/[-+.\d]/.test(ch)) {
        break; // malformed data — keep what parsed so far
      }

      var rel = cmd >= "a";
      var C = cmd.toUpperCase();
      var ox = rel ? cx : 0, oy = rel ? cy : 0;
      var a;
      var wasCubic = false, wasQuad = false;

      if (C === "Z") {
        closePath();
        cmd = null;
        lastCubic = lastQuad = null;
        continue;
      } else if (C === "M") {
        if (!(a = readNumbers(2))) break;
        current = { closed: false, nodes: [node(ox + a[0], oy + a[1])] };
        subpaths.push(current);
        cx = sx = ox + a[0];
        cy = sy = oy + a[1];
        cmd = rel ? "l" : "L";
      } else if (C === "L") {
        if (!(a = readNumbers(2))) break;
        lineTo(ox + a[0], oy + a[1]);
      } else if (C === "H") {
        if (!(a = readNumbers(1))) break;
        lineTo(ox + a[0], cy);
      } else if (C === "V") {
        if (!(a = readNumbers(1))) break;
        lineTo(cx, oy + a[0]);
      } else if (C === "C") {
        if (!(a = readNumbers(6))) break;
        cubicTo(ox + a[0], oy + a[1], ox + a[2], oy + a[3], ox + a[4], oy + a[5]);
        lastCubic = [ox + a[2], oy + a[3]];
        wasCubic = true;
      } else if (C === "S") {
        if (!(a = readNumbers(4))) break;
        var r1 = lastCubic ? [2 * cx - lastCubic[0], 2 * cy - lastCubic[1]] : [cx, cy];
        cubicTo(r1[0], r1[1], ox + a[0], oy + a[1], ox + a[2], oy + a[3]);
        lastCubic = [ox + a[0], oy + a[1]];
        wasCubic = true;
      } else if (C === "Q" || C === "T") {
        var q, end;
        if (C === "Q") {
          if (!(a = readNumbers(4))) break;
          q = [ox + a[0], oy + a[1]];
          end = [ox + a[2], oy + a[3]];
        } else {
          if (!(a = readNumbers(2))) break;
          q = lastQuad ? [2 * cx - lastQuad[0], 2 * cy - lastQuad[1]] : [cx, cy];
          end = [ox + a[0], oy + a[1]];
        }
        cubicTo(
          cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy),
          end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1]),
          end[0], end[1]
        );
        lastQuad = q;
        wasQuad = true;
      } else if (C === "A") {
        var rx = readNumber(), ry = readNumber(), rot = readNumber();
        var large = readFlag(), sweep = readFlag();
        var ex = readNumber(), ey = readNumber();
        if (ey === null || ex === null || sweep === null || large === null || rot === null) break;
        var segs = arcToCubics(cx, cy, rx, ry, rot, large, sweep, ox + ex, oy + ey);
        if (segs === null) lineTo(ox + ex, oy + ey);
        else
          for (var s = 0; s < segs.length; s++) {
            cubicTo(segs[s][0][0], segs[s][0][1], segs[s][1][0], segs[s][1][1], segs[s][2][0], segs[s][2][1]);
          }
      }

      if (!wasCubic) lastCubic = null;
      if (!wasQuad) lastQuad = null;
    }

    return subpaths.filter(function (sp) {
      return sp.nodes.length > 1 || sp.closed;
    });
  }

  function formatNumber(v) {
    return String(Math.round(v * 1000) / 1000);
  }

  function subpathToPathData(sp) {
    var nodes = sp.nodes;
    if (!nodes.length) return "";
    var f = formatNumber;
    var out = "M" + f(nodes[0].anchor[0]) + " " + f(nodes[0].anchor[1]);
    var count = sp.closed ? nodes.length : nodes.length - 1;
    for (var j = 0; j < count; j++) {
      var p = nodes[j], q = nodes[(j + 1) % nodes.length];
      if (arePointsEqual(p.right, p.anchor, EPS) && arePointsEqual(q.left, q.anchor, EPS)) {
        out += "L" + f(q.anchor[0]) + " " + f(q.anchor[1]);
      } else {
        out +=
          "C" + f(p.right[0]) + " " + f(p.right[1]) + " " + f(q.left[0]) + " " +
          f(q.left[1]) + " " + f(q.anchor[0]) + " " + f(q.anchor[1]);
      }
    }
    return sp.closed ? out + "Z" : out;
  }

  function cubicPoint(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return [
      mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1],
    ];
  }

  function forEachSegment(sp, fn) {
    var n = sp.nodes.length;
    // Open paths have no closing segment. (The original script always wrapped
    // around, which drew a bogus guideline from an open path's end to its start.)
    var count = sp.closed ? n : n - 1;
    for (var j = 0; j < count; j++) fn(sp.nodes[j], sp.nodes[(j + 1) % n], j);
  }

  function getPathsBounds(subpaths) {
    var b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    function add(p) {
      if (p[0] < b.left) b.left = p[0];
      if (p[0] > b.right) b.right = p[0];
      if (p[1] < b.top) b.top = p[1];
      if (p[1] > b.bottom) b.bottom = p[1];
    }
    subpaths.forEach(function (sp) {
      if (sp.nodes.length) add(sp.nodes[0].anchor);
      forEachSegment(sp, function (p, q) {
        for (var t = 1; t <= 8; t++) add(cubicPoint(p.anchor, p.right, q.left, q.anchor, t / 8));
      });
    });
    if (b.left === Infinity) return null;
    return { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top };
  }

  // ===============================================================
  // Line detection and comparison
  // ===============================================================

  function lineAngle(line) {
    var a = (Math.atan2(line[1][1] - line[0][1], line[1][0] - line[0][0]) * 180) / Math.PI;
    // Fold into [0, 180). The original used Math.abs(angle) % 180, which
    // treated -45° and 45° as parallel and 45° and 135° as different.
    return ((a % 180) + 180) % 180;
  }

  function areLinesParallel(line1, line2, angleTolerance) {
    var diff = Math.abs(lineAngle(line1) - lineAngle(line2));
    return diff <= angleTolerance || diff >= 180 - angleTolerance;
  }

  function pointToLineDistance(p, line) {
    var x1 = line[0][0], y1 = line[0][1], x2 = line[1][0], y2 = line[1][1];
    var len = Math.sqrt(Math.pow(y2 - y1, 2) + Math.pow(x2 - x1, 2));
    if (len < EPS) return getDistance(p, line[0]);
    return Math.abs((y2 - y1) * p[0] - (x2 - x1) * p[1] + x2 * y1 - y2 * x1) / len;
  }

  function areLinesEqual(line1, line2, opt) {
    if (
      (arePointsEqual(line1[0], line2[0], 1) && arePointsEqual(line1[1], line2[1], 1)) ||
      (arePointsEqual(line1[0], line2[1], 1) && arePointsEqual(line1[1], line2[0], 1))
    ) {
      return true;
    }
    if (areLinesParallel(line1, line2, opt.lineAngleTolerance)) {
      // Check both endpoints. The original only measured from one end, so two
      // nearly-parallel lines crossing near that end were wrongly merged.
      return (
        Math.max(pointToLineDistance(line1[0], line2), pointToLineDistance(line1[1], line2)) <
        opt.lineMergeDistance
      );
    }
    return false;
  }

  // Clip the infinite line through p→q to a rectangle (parametric clipping).
  function clipLineToRect(p, q, rect) {
    var dx = q[0] - p[0], dy = q[1] - p[1];
    var tMin = -Infinity, tMax = Infinity;
    var bounds = [
      [dx, p[0], rect.x, rect.x + rect.w],
      [dy, p[1], rect.y, rect.y + rect.h],
    ];
    for (var k = 0; k < 2; k++) {
      var dv = bounds[k][0], pv = bounds[k][1], lo = bounds[k][2], hi = bounds[k][3];
      if (Math.abs(dv) < 1e-12) {
        if (pv < lo - EPS || pv > hi + EPS) return null;
      } else {
        var t1 = (lo - pv) / dv, t2 = (hi - pv) / dv;
        if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
      }
    }
    if (!(tMax - tMin > 1e-9)) return null;
    return [
      [p[0] + tMin * dx, p[1] + tMin * dy],
      [p[0] + tMax * dx, p[1] + tMax * dy],
    ];
  }

  // ===============================================================
  // Segment shape
  // ===============================================================

  function sampleSegment(p, q) {
    var out = [];
    for (var i = 0; i <= SAMPLES_PER_SEGMENT; i++) {
      out.push(cubicPoint(p.anchor, p.right, q.left, q.anchor, i / SAMPLES_PER_SEGMENT));
    }
    return out;
  }

  // How far the curve strays from the straight line between its anchors.
  function segmentBow(p, q) {
    var a = p.anchor, b = q.anchor;
    var chordZero = getDistance(a, b) < EPS;
    var max = 0;
    for (var i = 1; i < SAMPLES_PER_SEGMENT; i++) {
      var pt = cubicPoint(a, p.right, q.left, b, i / SAMPLES_PER_SEGMENT);
      max = Math.max(max, chordZero ? getDistance(pt, a) : pointToLineDistance(pt, [a, b]));
    }
    return max;
  }

  // Curved means the drawn shape actually bends. Handles lying along the chord,
  // or a bow too small to see, still draw a straight edge.
  function isSegmentCurved(p, q) {
    return segmentBow(p, q) > Math.max(FLATNESS, 0.001 * getDistance(p.anchor, q.anchor));
  }

  // Unit tangent leaving the start / arriving at the end of a segment.
  function startTangent(p, q) {
    var a = p.anchor;
    var toward = getDistance(p.right, a) > EPS ? p.right : getDistance(q.left, a) > EPS ? q.left : q.anchor;
    return unit([toward[0] - a[0], toward[1] - a[1]]);
  }
  function endTangent(p, q) {
    var b = q.anchor;
    var from = getDistance(q.left, b) > EPS ? q.left : getDistance(p.right, b) > EPS ? p.right : p.anchor;
    return unit([b[0] - from[0], b[1] - from[1]]);
  }
  function unit(v) {
    var len = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    return len < EPS ? [0, 0] : [v[0] / len, v[1] / len];
  }
  function angleBetween(u, v) {
    var dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
    return (Math.acos(dot) * 180) / Math.PI;
  }

  function polylineLength(pts) {
    var len = 0;
    for (var i = 1; i < pts.length; i++) len += getDistance(pts[i - 1], pts[i]);
    return len;
  }

  // Segments of a subpath with their geometry, skipping zero-length straight ones.
  function describeSegments(sp) {
    var segs = [];
    forEachSegment(sp, function (p, q) {
      var curved = isSegmentCurved(p, q);
      var length = getDistance(p.anchor, q.anchor);
      if (!curved && length < EPS) return;
      segs.push({ p: p, q: q, a: p.anchor, b: q.anchor, length: length, curved: curved });
    });
    return segs;
  }

  // Walk order over a subpath's segments. On closed paths it starts right after
  // a break, so runs never wrap mid-edge; `loop` is true when a closed path has
  // no break at all (e.g. a full circle).
  function traversal(segs, closed, joinable) {
    var count = segs.length;
    var start = 0, loop = closed && count > 1;
    if (loop) {
      for (var i = 0; i < count; i++) {
        if (!joinable(segs[(i - 1 + count) % count], segs[i])) {
          start = i;
          loop = false;
          break;
        }
      }
    }
    var order = [];
    for (var k = 0; k < count; k++) order.push(segs[(start + k) % count]);
    return { order: order, loop: loop };
  }

  // ===============================================================
  // Straight edges → guidelines
  // ===============================================================

  // Weighted total-least-squares line: the direction that best follows all points.
  function fitLine(pts, weights) {
    var sw = 0, mx = 0, my = 0;
    for (var i = 0; i < pts.length; i++) {
      sw += weights[i];
      mx += weights[i] * pts[i][0];
      my += weights[i] * pts[i][1];
    }
    mx /= sw;
    my /= sw;
    var sxx = 0, sxy = 0, syy = 0;
    for (var j = 0; j < pts.length; j++) {
      var dx = pts[j][0] - mx, dy = pts[j][1] - my;
      sxx += weights[j] * dx * dx;
      sxy += weights[j] * dx * dy;
      syy += weights[j] * dy * dy;
    }
    var angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { point: [mx, my], dir: [Math.cos(angle), Math.sin(angle)] };
  }

  function edgeFit(vertices) {
    // Each vertex stands for half of each adjacent piece, so dense vertices don't skew the fit.
    var weights = vertices.map(function (v, i) {
      var before = i > 0 ? getDistance(vertices[i - 1], v) : 0;
      var after = i < vertices.length - 1 ? getDistance(v, vertices[i + 1]) : 0;
      return (before + after) / 2 || 1;
    });
    return fitLine(vertices, weights);
  }

  function maxLineDeviation(pts, fit) {
    var max = 0;
    for (var i = 0; i < pts.length; i++) {
      var dx = pts[i][0] - fit.point[0], dy = pts[i][1] - fit.point[1];
      max = Math.max(max, Math.abs(dx * fit.dir[1] - dy * fit.dir[0]));
    }
    return max;
  }

  function snapToAxis(fit) {
    var deg = (Math.atan2(fit.dir[1], fit.dir[0]) * 180) / Math.PI;
    var folded = ((deg % 90) + 90) % 90;
    if (folded < AXIS_SNAP_DEGREES || folded > 90 - AXIS_SNAP_DEGREES) {
      var horizontal = Math.abs(fit.dir[0]) >= Math.abs(fit.dir[1]);
      fit.dir = horizontal ? [1, 0] : [0, 1];
    }
    return fit;
  }

  function straightJoinable(s1, s2) {
    if (s1.curved || s2.curved) return false;
    var d1 = unit([s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]]);
    var d2 = unit([s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]]);
    return angleBetween(d1, d2) < 2 && pointToLineDistance(s2.b, [s1.a, s1.b]) < COLLINEAR_TOLERANCE;
  }

  // Groups consecutive collinear pieces into edges: [{ vertices, length }].
  function straightEdges(sp, segs) {
    var walk = traversal(segs, sp.closed, straightJoinable);
    var edges = [];
    var edge = null;
    function close() {
      if (edge) edges.push(edge);
      edge = null;
    }
    walk.order.forEach(function (seg) {
      if (seg.curved) return close();
      if (edge && straightJoinable(edge.last, seg)) {
        var vertices = edge.vertices.concat([seg.b]);
        if (maxLineDeviation(vertices, edgeFit(vertices)) <= COLLINEAR_TOLERANCE) {
          edge.vertices = vertices;
          edge.length += seg.length;
          edge.last = seg;
          return;
        }
      }
      close();
      edge = { vertices: [seg.a, seg.b], length: seg.length, last: seg };
    });
    close();
    return edges;
  }

  // ===============================================================
  // Curves → circles
  // ===============================================================

  // Least-squares circle through points: algebraic (Kåsa) estimate refined with
  // Gauss-Newton on true geometric distance. Returns null for collinear points.
  function fitCircle(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += pts[i][0]; my += pts[i][1]; }
    mx /= n;
    my /= n;
    var suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
    for (var j = 0; j < n; j++) {
      var u = pts[j][0] - mx, v = pts[j][1] - my;
      suu += u * u; suv += u * v; svv += v * v;
      suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
    }
    var det = suu * svv - suv * suv;
    if (!(Math.abs(det) > 1e-9 * (suu * svv + EPS))) return null;
    var b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
    var cx = (b1 * svv - b2 * suv) / det + mx;
    var cy = (suu * b2 - suv * b1) / det + my;
    var r = 0;
    for (var k = 0; k < n; k++) r += getDistance([cx, cy], pts[k]);
    r /= n;

    for (var iter = 0; iter < 12; iter++) {
      // Solve (JᵀJ)Δ = -Jᵀres for Δ = [dcx, dcy, dr].
      var a11 = 0, a12 = 0, a13 = 0, a22 = 0, a23 = 0, a33 = 0, g1 = 0, g2 = 0, g3 = 0;
      for (var m = 0; m < n; m++) {
        var dx = pts[m][0] - cx, dy = pts[m][1] - cy;
        var dist = Math.sqrt(dx * dx + dy * dy) || EPS;
        var j1 = -dx / dist, j2 = -dy / dist, res = dist - r;
        a11 += j1 * j1; a12 += j1 * j2; a13 -= j1; a22 += j2 * j2; a23 -= j2; a33 += 1;
        g1 += j1 * res; g2 += j2 * res; g3 -= res;
      }
      var D = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
      if (Math.abs(D) < 1e-18) break;
      var d1 = (-g1 * (a22 * a33 - a23 * a23) - a12 * (-g2 * a33 + a23 * g3) + a13 * (-g2 * a23 + a22 * g3)) / D;
      var d2 = (a11 * (-g2 * a33 + a23 * g3) + g1 * (a12 * a33 - a23 * a13) + a13 * (-a12 * g3 + g2 * a13)) / D;
      var d3 = (a11 * (-a22 * g3 + g2 * a23) - a12 * (-a12 * g3 + g2 * a13) - g1 * (a12 * a23 - a22 * a13)) / D;
      cx += d1;
      cy += d2;
      r += d3;
      if (Math.abs(d1) + Math.abs(d2) + Math.abs(d3) < 1e-9 * (r + 1)) break;
    }
    if (!(r > 0) || !isFinite(r)) return null;

    var maxDev = 0;
    for (var q = 0; q < n; q++) maxDev = Math.max(maxDev, Math.abs(getDistance([cx, cy], pts[q]) - r));
    return { center: [cx, cy], radius: r, maxDev: maxDev };
  }

  // Best circle for an arc. Dense samples judge how circular it is, but a
  // standard bezier arc is exact only at its ends and middle (in between it
  // bulges by up to 0.03%), so the final center and radius come from those
  // points when they describe the same circle.
  function preciseCircle(arc, opt) {
    var fit = arc.fit;
    if (!fitAcceptable(fit, opt, arc.length) || arc.keyPoints.length < 3) return fit;
    var exact = fitCircle(arc.keyPoints);
    if (!exact) return fit;
    var maxDev = 0;
    for (var i = 0; i < arc.points.length; i++) {
      maxDev = Math.max(maxDev, Math.abs(getDistance(exact.center, arc.points[i]) - exact.radius));
    }
    exact.maxDev = maxDev;
    // Allow for the bezier bulge itself (~0.03% of the radius) on top of the dense fit.
    return fitAcceptable(exact, opt, arc.length) && maxDev <= fit.maxDev * 2 + 0.0005 * exact.radius ? exact : fit;
  }

  function keyPointsOf(seg) {
    return [seg.a, cubicPoint(seg.p.anchor, seg.p.right, seg.q.left, seg.q.anchor, 0.5), seg.b];
  }

  // How far a curve may stray from its circle scales with the arc's own size,
  // not just the radius: a gentle arc on a huge circle must still visibly hug it.
  function arcSize(fit, length) {
    return length ? Math.min(fit.radius, length) : fit.radius;
  }

  function fitAcceptable(fit, opt, length) {
    return !!fit && fit.radius <= opt.maxRadius && fit.maxDev <= Math.max(opt.circleFitTolerance * arcSize(fit, length), MIN_FIT_DEVIATION);
  }

  function deviationFrom(circle, pts) {
    var max = 0;
    for (var i = 0; i < pts.length; i++) max = Math.max(max, Math.abs(getDistance(circle.center, pts[i]) - circle.radius));
    return max;
  }

  // True when one circle hugs every part (each with `points` and `length`)
  // closely, relative to the size of everything it spans together.
  function hugsAll(circle, parts) {
    var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var limit = Math.max(SAME_CIRCLE_TOLERANCE * arcSize(circle, total), MIN_FIT_DEVIATION);
    return parts.every(function (part) { return deviationFrom(circle, part.points) <= limit; });
  }

  // Angle swept around the center, and whether the points travel one way around it.
  function sweepAround(center, pts) {
    var total = 0, travel = 0;
    var prev = Math.atan2(pts[0][1] - center[1], pts[0][0] - center[0]);
    for (var i = 1; i < pts.length; i++) {
      var ang = Math.atan2(pts[i][1] - center[1], pts[i][0] - center[0]);
      var d = ang - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      total += d;
      travel += Math.abs(d);
      prev = ang;
    }
    return { degrees: (Math.abs(total) * 180) / Math.PI, oneWay: travel === 0 || Math.abs(total) >= 0.9 * travel };
  }

  // Measured against the whole artwork, so large construction circles that set
  // the curvature of a long swoosh are kept, while runaway fits are not.
  function isCircleWithinReasonableBounds(circle, bounds) {
    var width = bounds.right - bounds.left;
    var height = bounds.bottom - bounds.top;
    var maxDimension = Math.max(width, height);
    if (circle.radius > maxDimension * 2.5) return false;
    var center = [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2];
    return getDistance(circle.center, center) <= maxDimension * 3;
  }

  function getAnchorBounds(sp) {
    var b = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    sp.nodes.forEach(function (n) {
      var x = n.anchor[0], y = n.anchor[1];
      if (x < b.left) b.left = x;
      if (x > b.right) b.right = x;
      if (y < b.top) b.top = y;
      if (y > b.bottom) b.bottom = y;
    });
    return b;
  }

  // The smallest merge tolerance at which two circles would be combined.
  function circleMergeToleranceNeeded(c1, c2) {
    var avgRadius = (c1.radius + c2.radius) / 2;
    var needed = Math.max(getDistance(c1.center, c2.center), Math.abs(c1.radius - c2.radius)) / avgRadius;
    // Circles from different shapes merge at 30% of the tolerance.
    return c1.sourceItem && c2.sourceItem && c1.sourceItem !== c2.sourceItem ? needed / 0.3 : needed;
  }

  function areCirclesOverlapping(c1, c2, tolerance) {
    // The original also merged any circle contained inside another, which
    // deleted inner rings (the counter of an "O", concentric construction
    // circles). Only near-identical circles are merged here.
    return circleMergeToleranceNeeded(c1, c2) < tolerance;
  }

  // Merges near-identical circles, refitting each group to all of its points
  // so the result is the best circle for every piece, not just one of them.
  // Each input circle is tagged with `group` (index into the result) and
  // `merged` (true when it was folded into another circle).
  function consolidateOverlappingCircles(circles, tolerance) {
    var result = [];
    var processed = [];
    for (var i = 0; i < circles.length; i++) {
      if (processed[i]) continue;
      var group = [circles[i]];
      var kept = circles[i];
      kept.parts = group;
      processed[i] = true;
      for (var j = i + 1; j < circles.length; j++) {
        if (processed[j] || !areCirclesOverlapping(circles[i], circles[j], tolerance)) continue;
        // Similar isn't enough: the merged circle has to hug every arc it replaces.
        var candidate = group.concat([circles[j]]);
        var refit = fitCircle([].concat.apply([], candidate.map(function (c) { return c.keyPoints; })));
        if (!refit || !hugsAll(refit, candidate)) continue;
        refit.sourceItem = circles[i].sourceItem;
        refit.parts = candidate;
        kept = refit;
        group = candidate;
        processed[j] = true;
      }
      group.forEach(function (c, k) {
        c.group = result.length;
        c.merged = k > 0;
      });
      result.push(kept);
    }
    return result;
  }

  function curvesJoinable(s1, s2) {
    return s1.curved && s2.curved && angleBetween(endTangent(s1.p, s1.q), startTangent(s2.p, s2.q)) < TANGENT_BREAK_DEGREES;
  }

  function pieceOf(seg, opt) {
    var points = sampleSegment(seg.p, seg.q);
    var piece = { segs: [seg], points: points, keyPoints: keyPointsOf(seg), length: polylineLength(points), fit: fitCircle(points) };
    piece.pieces = [piece];
    piece.ok = fitAcceptable(piece.fit, opt, piece.length);
    return piece;
  }

  // One arc from two neighbors, if a single circle genuinely describes both.
  function joinArcs(a, b, opt) {
    if (!a.ok || !b.ok) return null;
    var points = a.points.concat(b.points.slice(1));
    var fit = fitCircle(points);
    var length = a.length + b.length;
    var pieces = a.pieces.concat(b.pieces);
    if (!fitAcceptable(fit, opt, length) || !hugsAll(fit, pieces)) return null;
    return {
      segs: a.segs.concat(b.segs),
      points: points,
      keyPoints: a.keyPoints.concat(b.keyPoints.slice(1)),
      length: length,
      fit: fit,
      pieces: pieces,
      ok: true,
    };
  }

  // Groups smooth, co-circular curve pieces into arcs. Tangent arcs with
  // different radii (the usual construction of a swoosh) stay separate.
  function curvedArcs(sp, segs, opt) {
    var walk = traversal(segs, sp.closed, curvesJoinable);
    var arcs = [];
    var arc = null;
    function close() {
      if (arc) arcs.push(arc);
      arc = null;
    }
    walk.order.forEach(function (seg) {
      if (!seg.curved) return close();
      var piece = pieceOf(seg, opt);
      var joined = arc && curvesJoinable(arc.segs[arc.segs.length - 1], seg) ? joinArcs(arc, piece, opt) : null;
      if (joined) {
        arc = joined;
        return;
      }
      close();
      arc = piece;
    });
    close();

    // A closed loop with no corners (a full circle) may have been split where
    // the walk happened to start; rejoin the last arc onto the first.
    if (walk.loop && arcs.length > 1) {
      var rejoined = joinArcs(arcs[arcs.length - 1], arcs[0], opt);
      if (rejoined) {
        arcs[0] = rejoined;
        arcs.pop();
      }
    }
    return arcs;
  }

  // Decides whether an arc is a construction circle. Status:
  //   short     arc length below minArcLength
  //   rejected  not a plausible circle (reason: "fit" = strays too far, "shape" = other checks)
  //   small     a valid circle, but below minRadius
  //   circle    detected
  function classifyArc(arc, bounds, opt) {
    var length = arc.length;
    var fit = preciseCircle(arc, opt);
    var result = {
      length: length,
      status: "short",
      reason: "",
      deviation: fit ? fit.maxDev / arcSize(fit, length) : null, // same measure the Circle fit setting uses
      circle: null,
    };
    if (length < opt.minArcLength) return result;
    result.status = "rejected";
    if (!fit) {
      result.reason = "shape";
      return result;
    }
    if (!fitAcceptable(fit, opt, length)) {
      result.reason = fit.radius > opt.maxRadius ? "shape" : "fit";
      return result;
    }
    result.reason = "shape";
    var sweep = sweepAround(fit.center, arc.points);
    if (!sweep.oneWay || sweep.degrees < MIN_SWEEP_DEGREES) return result;
    if (!isCircleWithinReasonableBounds(fit, bounds)) return result;
    result.reason = "";
    result.circle = { center: fit.center, radius: fit.radius, maxDev: fit.maxDev, keyPoints: arc.keyPoints, points: arc.points, length: length };
    result.status = fit.radius < opt.minRadius ? "small" : "circle";
    return result;
  }

  // ===============================================================
  // Main analysis
  // ===============================================================

  // paths:      [{ id, closed, nodes }]
  // canvasRect: { x, y, w, h } — guidelines extend to these edges
  // artBounds:  { x, y, w, h } — artwork size, used to normalize thresholds
  function analyze(paths, canvasRect, artBounds, options) {
    var opt = {};
    for (var key in DEFAULT_OPTIONS) {
      opt[key] = options && options[key] != null ? options[key] : DEFAULT_OPTIONS[key];
    }

    var maxDim = artBounds ? Math.max(artBounds.w, artBounds.h) : 0;
    var s = maxDim > 0 ? DETECTION_SIZE / maxDim : 1;
    function sc(p) { return [p[0] * s, p[1] * s]; }
    function un(p) { return [p[0] / s, p[1] / s]; }

    var scaled = paths.map(function (sp) {
      return {
        id: sp.id,
        closed: sp.closed,
        nodes: sp.nodes.map(function (n) {
          return { anchor: sc(n.anchor), left: sc(n.left), right: sc(n.right) };
        }),
      };
    });
    var rect = { x: canvasRect.x * s, y: canvasRect.y * s, w: canvasRect.w * s, h: canvasRect.h * s };
    var artworkBounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    scaled.forEach(function (sp) {
      var b = getAnchorBounds(sp);
      artworkBounds.left = Math.min(artworkBounds.left, b.left);
      artworkBounds.right = Math.max(artworkBounds.right, b.right);
      artworkBounds.top = Math.min(artworkBounds.top, b.top);
      artworkBounds.bottom = Math.max(artworkBounds.bottom, b.bottom);
    });

    var lines = [];
    var detectedCircles = [];
    var smallCircles = [];
    var points = [];
    var pointKeys = {};
    var handles = [];
    // Why each decision was made, so the UI can show what a setting affects.
    // Lengths and distances are in detection units (the units the settings use).
    var straight = []; // { vertices, length, status: line | merged | short | outside, line }
    var mergedLines = []; // { line, into, angle, distance } — duplicates absorbed by an existing guideline
    var curves = []; // { segs, length, status, reason, deviation, candidate }

    scaled.forEach(function (sp) {
      var segs = describeSegments(sp);

      straightEdges(sp, segs).forEach(function (edge) {
        var entry = { vertices: edge.vertices, length: edge.length, status: "short", line: -1 };
        straight.push(entry);
        if (edge.length < opt.minSegmentLength) return;
        var fit = snapToAxis(edgeFit(edge.vertices));
        var line = clipLineToRect(fit.point, [fit.point[0] + fit.dir[0], fit.point[1] + fit.dir[1]], rect);
        if (!line) {
          entry.status = "outside";
          return;
        }
        for (var i = 0; i < lines.length; i++) {
          if (areLinesEqual(line, lines[i], opt)) {
            entry.status = "merged";
            entry.line = i;
            var measure = lineMergeMeasure(line, lines[i]);
            mergedLines.push({ line: line, into: i, angle: measure.angle, distance: measure.distance });
            return;
          }
        }
        entry.status = "line";
        entry.line = lines.length;
        lines.push(line);
      });

      curvedArcs(sp, segs, opt).forEach(function (arc) {
        var verdict = classifyArc(arc, artworkBounds, opt);
        var entry = { segs: arc.segs, length: verdict.length, status: verdict.status, reason: verdict.reason, deviation: verdict.deviation, candidate: null };
        curves.push(entry);
        if (!verdict.circle) return;
        verdict.circle.sourceItem = sp.id;
        entry.candidate = verdict.circle;
        (verdict.status === "small" ? smallCircles : detectedCircles).push(verdict.circle);
      });

      // Every anchor, including those in compound paths (the original skipped them).
      sp.nodes.forEach(function (n) {
        var k = n.anchor[0].toFixed(2) + "," + n.anchor[1].toFixed(2);
        if (!pointKeys[k]) {
          pointKeys[k] = true;
          points.push(n.anchor);
        }
        if (!arePointsEqual(n.left, n.anchor, 0.01)) handles.push([n.anchor, n.left]);
        if (!arePointsEqual(n.right, n.anchor, 0.01)) handles.push([n.anchor, n.right]);
      });
    });

    var circles = consolidateOverlappingCircles(detectedCircles, opt.circleMergeTolerance);
    var droppedSmall = consolidateOverlappingCircles(smallCircles, opt.circleMergeTolerance);

    function outLine(l) { return [un(l[0]), un(l[1])]; }
    function outCircle(c) { return { cx: c.center[0] / s, cy: c.center[1] / s, r: c.radius / s, radius: c.radius }; }

    // Pairs of guidelines that are close to merging: what the merge settings
    // would combine if they were raised.
    var linePairs = [];
    for (var i = 0; i < lines.length; i++) {
      for (var j = i + 1; j < lines.length; j++) {
        var m = lineMergeMeasure(lines[j], lines[i]);
        if (m.angle <= 15 && m.distance <= 60) linePairs.push({ i: i, j: j, angle: m.angle, distance: m.distance });
      }
    }

    // Only pairs that could really merge: similar, and one circle hugs both.
    var circlePairs = [];
    for (var ci = 0; ci < circles.length; ci++) {
      for (var cj = ci + 1; cj < circles.length; cj++) {
        var needed = circleMergeToleranceNeeded(circles[ci], circles[cj]);
        if (needed > 0.5) continue;
        var parts = circles[ci].parts.concat(circles[cj].parts);
        var both = fitCircle([].concat.apply([], parts.map(function (c) { return c.keyPoints; })));
        if (both && hugsAll(both, parts)) circlePairs.push({ i: ci, j: cj, tolerance: needed });
      }
    }

    var circlePieces = 0;
    curves.forEach(function (e) { if (e.status === "circle") circlePieces += e.segs.length; });

    return {
      lines: lines.map(outLine),
      circles: circles.map(function (c) {
        return { cx: c.center[0] / s, cy: c.center[1] / s, r: c.radius / s };
      }),
      points: points.map(un),
      handles: handles.map(function (h) { return [un(h[0]), un(h[1])]; }),
      scale: s, // artwork units → detection units
      trace: {
        straight: straight.map(function (e) {
          var vertices = e.vertices.map(un);
          return { points: vertices, a: vertices[0], b: vertices[vertices.length - 1], length: e.length, status: e.status, line: e.line };
        }),
        mergedLines: mergedLines.map(function (e) {
          return { line: outLine(e.line), into: e.into, angle: e.angle, distance: e.distance };
        }),
        linePairs: linePairs,
        curves: curves.map(function (e) {
          var c = e.candidate;
          return {
            beziers: e.segs.map(function (seg) { return [seg.p.anchor, seg.p.right, seg.q.left, seg.q.anchor].map(un); }),
            length: e.length,
            status: e.status,
            reason: e.reason,
            deviation: e.deviation, // fraction of radius the curve strays from its best circle
            circle: e.status === "circle" && c ? c.group : -1, // index into circles
            merged: e.status === "circle" && c ? c.merged : false,
          };
        }),
        circlePieces: circlePieces,
        smallCircles: droppedSmall.map(outCircle),
        circlePairs: circlePairs,
      },
    };
  }

  // Angle difference (degrees) and the largest endpoint distance from one
  // guideline to another — the two quantities the merge settings compare.
  function lineMergeMeasure(line1, line2) {
    var diff = Math.abs(lineAngle(line1) - lineAngle(line2));
    return {
      angle: Math.min(diff, 180 - diff),
      distance: Math.max(pointToLineDistance(line1[0], line2), pointToLineDistance(line1[1], line2)),
    };
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    DETECTION_SIZE: DETECTION_SIZE,
    IDENTITY: IDENTITY,
    analyze: analyze,
    parsePathData: parsePathData,
    parseTransform: parseTransform,
    multiplyMatrix: multiplyMatrix,
    applyMatrix: applyMatrix,
    transformSubpath: transformSubpath,
    subpathToPathData: subpathToPathData,
    getPathsBounds: getPathsBounds,
    clipLineToRect: clipLineToRect,
    areLinesParallel: areLinesParallel,
    isSegmentCurved: isSegmentCurved,
    fitCircle: fitCircle,
  };
});
