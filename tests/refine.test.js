// Refine engine: finds near-misses and corrects them without disturbing the rest.
// Run with: node tests/refine.test.js
const assert = require("assert");
const G = require("../app/web/geometry.js");
const R = require("../app/web/refine.js");

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

function toPaths(dList) {
  const paths = [];
  dList.forEach((d, i) => {
    const subs = G.parsePathData(d);
    subs.forEach((sp, j) => paths.push({ id: subs.length > 1 ? `${i}_compound_${j}` : `${i}`, ...sp }));
  });
  return paths;
}

const rect = (x, y, w, h) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
// Corner radii [top-left, top-right, bottom-right, bottom-left].
const roundedRect = (x, y, w, h, [a, b, c, d]) =>
  `M${x + a} ${y}H${x + w - b}A${b} ${b} 0 0 1 ${x + w} ${y + b}V${y + h - c}A${c} ${c} 0 0 1 ${x + w - c} ${y + h}` +
  `H${x + d}A${d} ${d} 0 0 1 ${x} ${y + h - d}V${y + a}A${a} ${a} 0 0 1 ${x + a} ${y}Z`;
const circle = (cx, cy, r, reverse) =>
  reverse
    ? `M${cx - r} ${cy}A${r} ${r} 0 1 0 ${cx + r} ${cy}A${r} ${r} 0 1 0 ${cx - r} ${cy}Z`
    : `M${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}Z`;

function inspect(dList, rules) {
  return R.inspect(toPaths(dList), rules);
}
function only(result, kind) {
  const list = result.suggestions.filter((s) => s.kind === kind);
  assert.strictEqual(list.length, 1, `expected one ${kind} suggestion, got: ${result.suggestions.map((s) => s.title).join("; ") || "none"}`);
  return list[0];
}
function refined(result, kinds) {
  return result.refine(result.suggestions.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => s.id)).paths;
}
function xs(sp) { return sp.nodes.map((n) => n.anchor[0]); }
function ys(sp) { return sp.nodes.map((n) => n.anchor[1]); }
function width(sp) { return Math.max(...xs(sp)) - Math.min(...xs(sp)); }
function height(sp) { return Math.max(...ys(sp)) - Math.min(...ys(sp)); }
const close = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

// Largest distance from a circle of any point on the given bezier nodes' segments.
function circleMiss(sp, from, to, cx, cy, r) {
  let worst = 0;
  for (let j = from; j < to; j++) {
    const p = sp.nodes[j % sp.nodes.length], q = sp.nodes[(j + 1) % sp.nodes.length];
    for (let i = 0; i <= 16; i++) {
      const pt = G.cubicPoint(p.anchor, p.right, q.left, q.anchor, i / 16);
      worst = Math.max(worst, Math.abs(Math.hypot(pt[0] - cx, pt[1] - cy) - r));
    }
  }
  return worst;
}

function edgeAngle(a, b) {
  return ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 180;
}

console.log("finding");

test("a logo built consistently gets no suggestions", () => {
  const r = inspect([
    "M60 200A140 140 0 1 1 340 200A140 140 0 1 1 60 200ZM120 200A80 80 0 1 0 280 200A80 80 0 1 0 120 200Z",
    "M250 40L310 40L150 360L90 360Z",
    "M336 306A30 30 0 1 1 276 306A30 30 0 1 1 336 306Z",
  ], ["evenodd"]);
  assert.deepStrictEqual(r.suggestions.map((s) => s.title), []);
});

test("equal bars with equal gaps: nothing to fix", () => {
  assert.strictEqual(inspect([rect(0, 0, 40, 200), rect(100, 0, 40, 200), rect(200, 0, 40, 200)]).suggestions.length, 0);
});

test("stroke weights that almost match", () => {
  const s = only(inspect([rect(0, 0, 40, 200), rect(100, 0, 41, 200), rect(200, 0, 40, 200)]), "weight");
  assert.strictEqual(s.title, "Match 3 stroke weights");
  assert.ok(/Set to 40 · now 40, 41/.test(s.detail), s.detail);
});

test("clearly different weights are left alone", () => {
  const r = inspect([rect(0, 0, 40, 200), rect(100, 0, 52, 200)]);
  assert.strictEqual(r.suggestions.filter((s) => s.kind === "weight").length, 0);
});

test("rounded corners a hair apart", () => {
  const s = only(inspect([roundedRect(0, 0, 300, 200, [20, 20.6, 20, 19.6])]), "radius");
  assert.strictEqual(s.title, "Match 4 corner radii");
});

test("edges just off a standard angle", () => {
  const s = only(inspect(["M0 200L60 200L175.47 0L115.47 0Z", "M200 200L260 200L376.5 0L316.5 0Z"]), "angle");
  assert.strictEqual(s.title, "Set 2 edges to exactly 60°");
});

test("edges almost on one line", () => {
  const s = only(inspect([rect(0, 0, 50, 200), rect(100, 0.8, 50, 199.2), rect(200, 0, 60, 90)]), "align");
  assert.strictEqual(s.title, "Align 3 edges");
});

test("circles almost sharing a center", () => {
  only(inspect([circle(100, 100, 100) + circle(101.2, 100.5, 60, true)]), "concentric");
});

test("a shape that is almost a mirror image", () => {
  const s = only(inspect(["M0 0L100 80L200 0L200 40L100 120L0 41.5Z"]), "symmetry");
  assert.strictEqual(s.title, "Mirror across the vertical axis");
});

test("a deliberately asymmetric shape is not called symmetric", () => {
  const r = inspect(["M0 0L140 0L200 60L200 200L0 200Z", rect(260, 0, 30, 200)]);
  assert.strictEqual(r.suggestions.filter((s) => s.kind === "symmetry").length, 0);
});

console.log("\ncorrecting");

test("matching weights makes every bar the same width and keeps the rest", () => {
  const out = refined(inspect([rect(0, 0, 40, 200), rect(100, 0, 41, 200), rect(200, 0, 40, 200)]), ["weight"]);
  out.forEach((sp) => assert.ok(close(width(sp), 40), `width ${width(sp)}`));
  out.forEach((sp) => assert.ok(close(height(sp), 200) && close(Math.min(...ys(sp)), 0), "heights unchanged"));
  assert.deepStrictEqual(xs(out[0]), [0, 40, 40, 0], "bars already at the target don't move");
});

test("a stroke and a ring share one weight", () => {
  const r = inspect([circle(100, 100, 100) + circle(100, 100, 60, true), rect(260, 0, 41.5, 200)], ["evenodd"]);
  only(r, "weight");
  const out = refined(r);
  const ringWeight = (width(out[0]) - width(out[1])) / 2;
  assert.ok(close(ringWeight, width(out[2]), 1e-6), `ring ${ringWeight} vs stem ${width(out[2])}`);
});

test("matching corner radii keeps corners tangent and edges in place", () => {
  const r = inspect([roundedRect(0, 0, 300, 200, [20, 20.6, 20, 19.6]), "M400 0L450 80L350 80Z"]);
  const s = r.suggestions.find((x) => x.kind === "radius");
  const [box, triangle] = r.refine([s.id]).paths;
  assert.ok(close(Math.min(...xs(box)), 0) && close(Math.max(...xs(box)), 300), "left/right edges stay");
  assert.ok(close(Math.min(...ys(box)), 0) && close(Math.max(...ys(box)), 200), "top/bottom edges stay");
  // Nodes alternate: straight edge end, corner start. Each corner: nodes 2k+1 → 2k+2.
  const target = Number(s.detail.match(/Set to ([\d.]+)/)[1]);
  const n = box.nodes;
  for (let k = 0; k < 4; k++) {
    const a = n[(2 * k + 1) % 8].anchor, b = n[(2 * k + 2) % 8].anchor;
    // Tangent to horizontal and vertical edges: the corner spans exactly r in x and y.
    assert.ok(close(Math.abs(a[0] - b[0]), target, 0.01) && close(Math.abs(a[1] - b[1]), target, 0.01), `corner ${k}: ${a} → ${b}`);
  }
  assert.deepStrictEqual(triangle.nodes.map((nd) => nd.anchor), [[400, 0], [450, 80], [350, 80]], "unrelated shapes never move");
});

test("a corner with the odd radius out is redrawn between the same edges", () => {
  const bar = "M20 40A20 20 0 0 1 40 20H60A21 21 0 0 1 81 41V260A20 20 0 0 1 61 280H40A20 20 0 0 1 20 260Z";
  const r = inspect([bar]);
  const out = refined(r, ["radius"])[0];
  const p = out.nodes.map((nd) => nd.anchor);
  assert.deepStrictEqual(p[2], [61, 20], "starts on the top edge");
  assert.deepStrictEqual(p[3], [81, 40], "ends on the right edge");
  assert.ok(circleMiss(out, 2, 3, 61, 40, 20) < 20 * 3e-4, "a true 20 radius");
});

test("widening a stem moves its rounded corner with it", () => {
  const r = inspect([`M0 200V30A30 30 0 0 1 30 0H50V200Z`, `M100 200V30A30 30 0 0 1 130 0H151.2V200Z`]);
  const out = refined(r, ["weight"]);
  assert.ok(close(width(out[0]), width(out[1]), 1e-6), `widths ${width(out[0])} and ${width(out[1])}`);
  const n = out[1].nodes;
  const corner = [n[1].anchor, n[2].anchor];
  assert.ok(close(corner[0][1], 30, 1e-6) && close(corner[1][1], 0, 1e-6), "corner still meets the edges it rounds");
  assert.ok(close(corner[0][0], Math.min(...xs(out[1])), 1e-6), "and starts on the moved edge");
  assert.ok(circleMiss(out[1], 1, 2, corner[1][0], corner[0][1], 30) < 30 * 3e-4, "and is still a true circle");
});

test("snapping angles rotates edges exactly onto the angle", () => {
  const out = refined(inspect(["M0 200L60 200L175.47 0L115.47 0Z", "M200 200L260 200L376.5 0L316.5 0Z"]));
  out.forEach((sp) => {
    const [a, b, c, d] = sp.nodes.map((nd) => nd.anchor);
    assert.ok(close(edgeAngle(b, c), 120, 1e-6) && close(edgeAngle(d, a), 120, 1e-6), "slanted edges at 60° (SVG y points down)");
    assert.ok(close(a[1], 200) && close(c[1], 0), "horizontal edges stay put");
  });
});

test("aligning moves only the edge that was off", () => {
  const out = refined(inspect([rect(0, 0, 50, 200), rect(100, 0.8, 50, 199.2), rect(200, 0, 60, 90)]));
  assert.deepStrictEqual(out.map((sp) => Math.min(...ys(sp))), [0, 0, 0]);
  assert.ok(close(Math.max(...ys(out[1])), 200), "bottom of the shifted bar stays");
});

test("centering slides the smaller circle and keeps it round", () => {
  const input = toPaths([circle(100, 100, 100) + circle(101.2, 100.5, 60, true)]);
  const out = refined(R.inspect(input));
  assert.deepStrictEqual(out[0].nodes.map((nd) => nd.anchor), input[0].nodes.map((nd) => nd.anchor), "the bigger circle stays");
  assert.ok(circleMiss(out[1], 0, out[1].nodes.length, 100, 100, 60) < 60 * 3e-4, "inner circle now centered and round");
  assert.ok(out[1].nodes.some((nd) => close(nd.anchor[0], 40, 1e-6) && close(nd.anchor[1], 100, 1e-6)), "its anchors keep their angles");
});

test("mirroring makes the shape exactly symmetric and keeps edges straight", () => {
  const out = refined(inspect(["M0 0L100 80L200 0L200 40L100 120L0 41.5Z"]))[0];
  const p = out.nodes.map((nd) => nd.anchor);
  assert.ok(close(p[0][1], p[2][1], 1e-9) && close(p[5][1], p[3][1], 1e-9), "mirrored points match");
  assert.ok(close(p[0][0] + p[2][0], 200, 1e-9), "axis stays in the middle");
  assert.ok(close(p[2][0], p[3][0], 1e-6), "vertical end edges stay vertical");
});

test("everything accepted together settles, and a second pass finds nothing", () => {
  const cases = [
    [[rect(0, 0, 40, 200), rect(100, 0, 41, 200), rect(200, 0, 40.4, 200)]],
    [[roundedRect(0, 0, 300, 200, [20, 20.6, 20, 19.6])]],
    [["M0 0L100 80L200 0L200 40L100 120L0 41.5Z"]],
    [[circle(100, 100, 100) + circle(100, 100, 60, true), rect(260, 0, 41.5, 200)], ["evenodd"]],
    [[circle(20, 20, 15), circle(100, 21, 15), circle(180, 20, 15), rect(0, 60, 200, 30)]],
  ];
  cases.forEach(([dList, rules], i) => {
    const again = R.inspect(refined(inspect(dList, rules)), rules);
    assert.deepStrictEqual(again.suggestions.map((s) => s.title), [], `case ${i}`);
  });
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
