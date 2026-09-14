// Run with: node tests/geometry.test.js
const assert = require("assert");
const G = require("../app/web/geometry.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL " + name + "\n       " + e.message);
    process.exitCode = 1;
  }
}
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

function toPaths(dList) {
  const paths = [];
  dList.forEach((d, i) => {
    const subs = G.parsePathData(d);
    subs.forEach((sp, j) => paths.push({ id: subs.length > 1 ? `${i}_compound_${j}` : `${i}`, ...sp }));
  });
  return paths;
}

function run(dList, canvas, opts) {
  const paths = toPaths(dList);
  const art = G.getPathsBounds(paths);
  return G.analyze(paths, canvas || { x: 0, y: 0, w: 400, h: 400 }, art, opts);
}

console.log("path parsing");

test("rect path: 4 straight nodes, closed", () => {
  const [sp] = G.parsePathData("M10 10 H110 V60 H10 Z");
  assert.strictEqual(sp.closed, true);
  assert.strictEqual(sp.nodes.length, 4);
});

test("explicit return to start is merged", () => {
  const [sp] = G.parsePathData("M0 0 L10 0 L10 10 L0 0 Z");
  assert.strictEqual(sp.nodes.length, 3);
});

test("relative commands and implicit lineto after m", () => {
  const [sp] = G.parsePathData("m5 5 10 0 0 10z");
  assert.deepStrictEqual(sp.nodes.map((n) => n.anchor), [[5, 5], [15, 5], [15, 15]]);
});

test("compact arc flags (a1 1 0 011 1)", () => {
  const [sp] = G.parsePathData("M0 0a10 10 0 0110 10");
  assert.strictEqual(sp.nodes.length, 2);
  assert.deepStrictEqual(sp.nodes[1].anchor, [10, 10]);
});

test("numbers without separators (1.5.5 and -1-2)", () => {
  const [sp] = G.parsePathData("M1.5.5L-1-2");
  assert.deepStrictEqual(sp.nodes.map((n) => n.anchor), [[1.5, 0.5], [-1, -2]]);
});

test("multiple subpaths become separate subpaths", () => {
  assert.strictEqual(G.parsePathData("M0 0H10V10ZM20 20H30V30Z").length, 2);
});

test("transform parsing: translate + rotate about point", () => {
  const m = G.parseTransform("translate(10 0) rotate(90 5 5)");
  const p = G.applyMatrix(m, [10, 5]);
  assert.ok(near(p[0], 15, 1e-9) && near(p[1], 10, 1e-9), JSON.stringify(p));
});

test("round trip through subpathToPathData keeps geometry", () => {
  const d = "M0 0C10 0 20 10 20 20L0 20Z";
  const again = G.parsePathData(G.subpathToPathData(G.parsePathData(d)[0]))[0];
  assert.deepStrictEqual(again.nodes, G.parsePathData(d)[0].nodes);
});

console.log("guidelines");

test("square gives 4 guidelines spanning the canvas", () => {
  const r = run(["M100 100H300V300H100Z"]);
  assert.strictEqual(r.lines.length, 4);
  r.lines.forEach((l) => {
    const len = Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]);
    assert.ok(near(len, 400, 1e-6), "line should span the canvas, got " + len);
  });
});

test("fix: open path gets no closing guideline", () => {
  // An "L" shape: two segments. The original also joined the end back to the start.
  const r = run(["M100 100V300H300"]);
  assert.strictEqual(r.lines.length, 2);
});

test("fix: -45° and +45° lines are not treated as parallel", () => {
  const up = [[0, 0], [10, 10]];
  const down = [[0, 0], [10, -10]];
  assert.strictEqual(G.areLinesParallel(up, down, 2), false);
  const same = [[0, 0], [-10, -10]];
  assert.strictEqual(G.areLinesParallel(up, same, 2), true);
});

test("fix: X shape produces both diagonals", () => {
  const r = run(["M50 50L350 350", "M50 350L350 50"]);
  assert.strictEqual(r.lines.length, 2);
});

test("collinear edges on the same line merge into one guideline", () => {
  const r = run(["M50 100H150V120H50Z", "M250 100H350V120H250Z"]);
  assert.strictEqual(r.lines.length, 6); // shared y=100 and y=120, plus four verticals
});

test("bezier with handles on the chord counts as straight", () => {
  const r = run(["M100 100C150 100 250 100 300 100"]);
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.circles.length, 0);
});

console.log("arcs");

test("full circle (4 arcs) consolidates to one circle", () => {
  const r = run(["M60 200A140 140 0 0 1 200 60A140 140 0 0 1 340 200A140 140 0 0 1 200 340A140 140 0 0 1 60 200Z"]);
  assert.strictEqual(r.circles.length, 1);
  const c = r.circles[0];
  assert.ok(near(c.cx, 200) && near(c.cy, 200) && near(c.r, 140), JSON.stringify(c));
  assert.strictEqual(r.lines.length, 0);
});

test("fix: inner ring of an O is kept", () => {
  const ring =
    "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z" +
    "M120 200A80 80 0 1 0 280 200A80 80 0 1 0 120 200Z";
  const r = run([ring]);
  const radii = r.circles.map((c) => Math.round(c.r)).sort((a, b) => a - b);
  assert.deepStrictEqual(radii, [80, 140]);
});

test("small construction circle is detected", () => {
  const r = run([
    "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z",
    "M272 300A28 28 0 1 1 328 300A28 28 0 1 1 272 300Z",
  ]);
  assert.ok(r.circles.some((c) => near(c.r, 28) && near(c.cx, 300)), JSON.stringify(r.circles));
});

test("detection is scale independent", () => {
  const d = "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200ZM100 100H300";
  const big = run([d]);
  const tiny = G.analyze(
    toPaths([d]).map((sp) => G.transformSubpath(sp, [0.05, 0, 0, 0.05, 0, 0])),
    { x: 0, y: 0, w: 20, h: 20 },
    { x: 3, y: 3, w: 14, h: 14 }
  );
  assert.strictEqual(tiny.circles.length, big.circles.length);
  assert.strictEqual(tiny.lines.length, big.lines.length);
});

console.log("points and handles");

test("points are unique anchors across subpaths", () => {
  const r = run(["M100 100H300V300H100Z", "M100 100H200V200Z"]);
  assert.strictEqual(r.points.length, 6);
});

test("handles are reported for curve nodes only", () => {
  const r = run(["M0 0C10 0 20 10 20 20L0 20Z"]);
  assert.strictEqual(r.handles.length, 2);
});

console.log("decision trace (hover explanations)");

test("short straight edges are reported as short, others as lines", () => {
  // 300 wide, 4 tall (8 units after normalizing to 600): the short sides fall under minSegmentLength.
  const r = run(["M50 100H350V104H50Z"]);
  const byStatus = (s) => r.trace.straight.filter((e) => e.status === s).length;
  assert.strictEqual(byStatus("short"), 2);
  assert.strictEqual(byStatus("line"), 2);
  assert.strictEqual(r.lines.length, 2);
});

test("collinear edges report which guideline absorbed them", () => {
  const r = run(["M50 100H150V120H50Z", "M250 100H350V120H250Z"]);
  const merged = r.trace.straight.filter((e) => e.status === "merged");
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(r.trace.mergedLines.length, 2);
  merged.forEach((e) => assert.ok(e.line >= 0 && e.line < r.lines.length));
});

test("near-parallel lines appear as a pair needing a larger angle", () => {
  // Two long lines 3° apart crossing at the center.
  const a = 3 * Math.PI / 180;
  const d2 = `M${200 - 150 * Math.cos(a)} ${200 - 150 * Math.sin(a)}L${200 + 150 * Math.cos(a)} ${200 + 150 * Math.sin(a)}`;
  const r = run(["M50 200L350 200", d2], null, { lineMergeDistance: 30 });
  assert.strictEqual(r.lines.length, 2);
  const pair = r.trace.linePairs[0];
  assert.ok(pair && near(pair.angle, 3, 0.01), JSON.stringify(r.trace.linePairs));
  // Raising the tolerance past the reported angle really merges them.
  assert.strictEqual(run(["M50 200L350 200", d2], null, { lineMergeDistance: 30, lineAngleTolerance: 3.5 }).lines.length, 1);
});

test("a circle's pieces form one arc mapped to its circle", () => {
  const r = run(["M60 200A140 140 0 0 1 200 60A140 140 0 0 1 340 200A140 140 0 0 1 200 340A140 140 0 0 1 60 200Z"]);
  const curves = r.trace.curves;
  assert.strictEqual(curves.length, 1);
  assert.strictEqual(curves[0].beziers.length, 4);
  assert.strictEqual(curves[0].status, "circle");
  assert.strictEqual(curves[0].circle, 0);
  assert.strictEqual(r.trace.circlePieces, 4);
});

test("circles drawn in separate shapes merge and report it", () => {
  const half1 = "M60 200A140 140 0 0 1 340 200";
  const half2 = "M340 200A140 140 0 0 1 60 200";
  const r = run([half1, half2], null, { circleMergeTolerance: 0.05 });
  assert.strictEqual(r.circles.length, 1);
  assert.deepStrictEqual(r.trace.curves.map((c) => c.merged), [false, true]);
});

test("circles below min radius are reported, not silently lost", () => {
  const dot = "M272 300A28 28 0 1 1 328 300A28 28 0 1 1 272 300Z";
  const big = "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z";
  const r = run([big, dot], null, { minRadius: 70 });
  assert.strictEqual(r.circles.length, 1);
  assert.strictEqual(r.trace.smallCircles.length, 1);
  assert.ok(near(r.trace.smallCircles[0].r, 28));
  assert.ok(r.trace.curves.some((c) => c.status === "small"));
});

test("short curves are reported as short", () => {
  // The whole ring is ~1900 units long after normalizing.
  const r = run(["M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z"], null, { minArcLength: 2500 });
  assert.strictEqual(r.circles.length, 0);
  assert.ok(r.trace.curves.every((c) => c.status === "short"));
});

test("similar but different circles are never merged into one that misses both", () => {
  const c1 = "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200Z";
  const c2 = "M66 200A134 134 0 1 1 334 200A134 134 0 1 1 66 200Z"; // radius 134, ~4.4% smaller
  const r = run([c1 + c2], null, { circleMergeTolerance: 0.2 });
  assert.strictEqual(r.circles.length, 2);
  assert.strictEqual(r.trace.circlePairs.length, 0, "no misleading 'would merge' hint");
});

test("pieces of one circle in separate shapes report a real merge pair", () => {
  // Two halves of the same ring, in separate shapes, with merging switched off.
  const r = run(["M60 200A140 140 0 0 1 340 200", "M340 200A140 140 0 0 1 60 200"], null, { circleMergeTolerance: 0 });
  assert.strictEqual(r.circles.length, 2);
  assert.strictEqual(r.trace.circlePairs.length, 1);
  assert.strictEqual(run(["M60 200A140 140 0 0 1 340 200", "M340 200A140 140 0 0 1 60 200"], null, { circleMergeTolerance: r.trace.circlePairs[0].tolerance + 0.001 }).circles.length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
