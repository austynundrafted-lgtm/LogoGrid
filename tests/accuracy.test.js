// Detection accuracy benchmark: synthetic artwork with known ground truth.
// Run with: node tests/accuracy.test.js
const G = require("../app/web/geometry.js");

let failures = 0;
const results = [];

function paths(dList) {
  const out = [];
  dList.forEach((d, i) => {
    const subs = G.parsePathData(d);
    subs.forEach((sp, j) => out.push({ id: subs.length > 1 ? `${i}_compound_${j}` : `${i}`, ...sp }));
  });
  return out;
}

// Every analysis in this file is also checked for the core guarantee: each
// reported circle hugs the curves it was read from (within the fit tolerance).
const hugViolations = [];
let currentCase = "";

function analyze(dList, opts) {
  const p = paths(dList);
  const art = G.getPathsBounds(p);
  const pad = Math.max(art.w, art.h) * 0.1;
  const r = G.analyze(p, { x: art.x - pad, y: art.y - pad, w: art.w + 2 * pad, h: art.h + 2 * pad }, art, opts);
  const tol = (opts && opts.circleFitTolerance) || G.DEFAULT_OPTIONS.circleFitTolerance;
  r.trace.curves.filter((c) => c.status === "circle").forEach((c) => {
    const circle = r.circles[c.circle];
    let worst = 0;
    c.beziers.forEach((bz) => {
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, m = 1 - t;
        const x = m * m * m * bz[0][0] + 3 * m * m * t * bz[1][0] + 3 * m * t * t * bz[2][0] + t * t * t * bz[3][0];
        const y = m * m * m * bz[0][1] + 3 * m * m * t * bz[1][1] + 3 * m * t * t * bz[2][1] + t * t * t * bz[3][1];
        worst = Math.max(worst, Math.abs(Math.hypot(x - circle.cx, y - circle.cy) - circle.r));
      }
    });
    const size = Math.min(circle.r, c.length / r.scale);
    const allowed = Math.max(tol * size, 0.25 / r.scale);
    if (worst > allowed + 1e-9) hugViolations.push(`${currentCase}: circle r=${f(circle.r)} misses its curve by ${f(worst)} (allowed ${f(allowed)})`);
  });
  return r;
}

const f = (n) => Math.round(n * 1e4) / 1e4;

// Cubic arc from angle a0 to a1 (radians), one cubic per call. Assumes |a1-a0| <= 90°.
function cubicArc(cx, cy, r, a0, a1) {
  const k = (4 / 3) * Math.tan((a1 - a0) / 4);
  const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const p3 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const c1 = [p0[0] - k * r * Math.sin(a0), p0[1] + k * r * Math.cos(a0)];
  const c2 = [p3[0] + k * r * Math.sin(a1), p3[1] - k * r * Math.cos(a1)];
  return { p0, d: `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p3[0])} ${f(p3[1])}` };
}

// Arc split at the given angles (radians). Pieces may be uneven.
function arcPath(cx, cy, r, angles, close) {
  let d = "";
  for (let i = 0; i < angles.length - 1; i++) {
    const seg = cubicArc(cx, cy, r, angles[i], angles[i + 1]);
    if (i === 0) d += `M${f(seg.p0[0])} ${f(seg.p0[1])}`;
    d += seg.d;
  }
  return d + (close ? "Z" : "");
}

function evenAngles(start, sweepDeg, pieces) {
  return Array.from({ length: pieces + 1 }, (_, i) => start + ((sweepDeg * Math.PI) / 180) * (i / pieces));
}

// A smooth chain of tangent arcs: [{ r, sweep (degrees, sign = turn direction) }].
// Returns the path and each arc's true circle.
function tangentChain(start, heading, arcs) {
  let p = start.slice(), h = heading;
  let d = `M${f(p[0])} ${f(p[1])}`;
  const truth = [];
  arcs.forEach(({ r, sweep }) => {
    const dir = Math.sign(sweep);
    const normal = [-Math.sin(h) * dir, Math.cos(h) * dir];
    const c = [p[0] + normal[0] * r, p[1] + normal[1] * r];
    truth.push({ cx: c[0], cy: c[1], r });
    const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const pieces = Math.ceil(Math.abs(sweep) / 90);
    for (let i = 0; i < pieces; i++) {
      const s0 = a0 + (dir * (Math.abs(sweep) * Math.PI) / 180) * (i / pieces);
      const s1 = a0 + (dir * (Math.abs(sweep) * Math.PI) / 180) * ((i + 1) / pieces);
      d += cubicArc(c[0], c[1], r, s0, s1).d;
    }
    const a1 = a0 + (dir * Math.abs(sweep) * Math.PI) / 180;
    p = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)];
    h += (dir * Math.abs(sweep) * Math.PI) / 180;
  });
  return { d, truth };
}

// Deterministic pseudo-random numbers.
let seed = 7;
function rand() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

function check(name, fn) {
  currentCase = name;
  let detail = "";
  let ok = false;
  try {
    const out = fn();
    ok = out === true || (out && out.ok);
    detail = out && out.detail ? out.detail : "";
  } catch (e) {
    detail = "threw: " + e.message;
  }
  if (!ok) failures++;
  results.push({ name, ok, detail });
}

function circleCheck(r, expected, tol) {
  const found = r.circles;
  if (found.length !== expected.length) {
    return { ok: false, detail: `found ${found.length} circles, expected ${expected.length}: ` + JSON.stringify(found.map((c) => [f(c.cx), f(c.cy), f(c.r)])) };
  }
  let worst = 0;
  const ok = expected.every((e) => {
    const c = found.reduce((best, c) => (Math.hypot(c.cx - e.cx, c.cy - e.cy) + Math.abs(c.r - e.r) < Math.hypot(best.cx - e.cx, best.cy - e.cy) + Math.abs(best.r - e.r) ? c : best));
    const err = Math.max(Math.hypot(c.cx - e.cx, c.cy - e.cy), Math.abs(c.r - e.r)) / e.r;
    worst = Math.max(worst, err);
    return err <= tol;
  });
  return { ok, detail: `worst center/radius error ${(worst * 100).toFixed(3)}% of r` };
}

// ---------------------------------------------------------------
// Circles and arcs
// ---------------------------------------------------------------

check("Illustrator circle (4 even pieces)", () =>
  circleCheck(analyze([arcPath(200, 200, 150, evenAngles(0, 360, 4), true)]), [{ cx: 200, cy: 200, r: 150 }], 0.001)
);

check("circle split unevenly into 5 pieces, rotated", () => {
  const angles = [0.3, 1.2, 1.9, 3.4, 4.6, 0.3 + 2 * Math.PI];
  return circleCheck(analyze([arcPath(200, 200, 120, angles, true)]), [{ cx: 200, cy: 200, r: 120 }], 0.001);
});

check("60° arc as a single cubic", () =>
  circleCheck(analyze([arcPath(200, 200, 150, evenAngles(0.5, 60, 1)), "M0 0H400V400H0Z"]), [{ cx: 200, cy: 200, r: 150 }], 0.002)
);

check("200° arc as 3 pieces", () =>
  circleCheck(analyze([arcPath(200, 200, 100, evenAngles(1, 200, 3))]), [{ cx: 200, cy: 200, r: 100 }], 0.002)
);

check("small circle drawn with 24 tiny pieces (next to a large shape)", () =>
  circleCheck(
    analyze(["M0 0H400V400H0Z", arcPath(300, 100, 20, evenAngles(0, 360, 24), true)]),
    [{ cx: 300, cy: 100, r: 20 }],
    0.005
  )
);

check("traced circle: 16 pieces with 0.3% wobble", () => {
  // Each anchor sits at a slightly different radius; handles stay tangent.
  const n = 16, cx = 200, cy = 200;
  const k = (4 / 3) * Math.tan(Math.PI / (2 * n));
  const nodes = Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n, rr = 150 * (1 + (rand() - 0.5) * 0.006);
    return { a, rr, p: [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] };
  });
  let d = `M${f(nodes[0].p[0])} ${f(nodes[0].p[1])}`;
  for (let i = 0; i < n; i++) {
    const A = nodes[i], B = nodes[(i + 1) % n];
    const c1 = [A.p[0] - k * A.rr * Math.sin(A.a), A.p[1] + k * A.rr * Math.cos(A.a)];
    const c2 = [B.p[0] + k * B.rr * Math.sin(B.a), B.p[1] - k * B.rr * Math.cos(B.a)];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(B.p[0])} ${f(B.p[1])}`;
  }
  return circleCheck(analyze([d + "Z"]), [{ cx: 200, cy: 200, r: 150 }], 0.003);
});

check("rounded rectangle path starting mid-edge: 4 corner circles", () => {
  const d = "M200 50H320A30 30 0 0 1 350 80V320A30 30 0 0 1 320 350H80A30 30 0 0 1 50 320V80A30 30 0 0 1 80 50Z";
  return circleCheck(analyze([d]), [
    { cx: 320, cy: 80, r: 30 }, { cx: 320, cy: 320, r: 30 }, { cx: 80, cy: 320, r: 30 }, { cx: 80, cy: 80, r: 30 },
  ], 0.002);
});

check("concentric rings (O counter) stay separate", () =>
  circleCheck(
    analyze([arcPath(200, 200, 150, evenAngles(0, 360, 4), true) + arcPath(200, 200, 110, evenAngles(0, 360, 4), true)]),
    [{ cx: 200, cy: 200, r: 150 }, { cx: 200, cy: 200, r: 110 }],
    0.001
  )
);

check("font-style circle made of 8 quadratic curves (TrueType)", () => {
  // Each 45° piece: quadratic through the tangent intersection, as font outlines are stored.
  const n = 8, R = 150;
  let d = `M${200 + R} 200`;
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n, am = (a0 + a1) / 2;
    const rc = R / Math.cos(Math.PI / n);
    d += `Q${f(200 + rc * Math.cos(am))} ${f(200 + rc * Math.sin(am))} ${f(200 + R * Math.cos(a1))} ${f(200 + R * Math.sin(a1))}`;
  }
  return circleCheck(analyze([d + "Z"]), [{ cx: 200, cy: 200, r: R }], 0.003);
});

check("C letterform: outer and inner arcs plus flat caps", () => {
  const a0 = Math.PI / 4, a1 = 2 * Math.PI - Math.PI / 4;
  const outer = arcPath(200, 200, 150, evenAngles(a0, 270, 3));
  const innerAngles = evenAngles(a0, 270, 3).reverse();
  const inner = arcPath(200, 200, 100, innerAngles).replace(/^M[^C]*/, "");
  const innerStart = [200 + 100 * Math.cos(a1), 200 + 100 * Math.sin(a1)];
  const d = outer + `L${f(innerStart[0])} ${f(innerStart[1])}` + inner + "Z";
  const r = analyze([d]);
  const circles = circleCheck(r, [{ cx: 200, cy: 200, r: 150 }, { cx: 200, cy: 200, r: 100 }], 0.001);
  return { ok: circles.ok && r.lines.length === 2, detail: circles.detail + `, ${r.lines.length} cap guidelines` };
});

check("ring broken into 3 separate shapes still gives one circle", () => {
  const pieces = [[10, 100], [130, 220], [250, 340]].map(([s0, s1]) => arcPath(200, 200, 150, evenAngles((s0 * Math.PI) / 180, s1 - s0, 1)));
  return circleCheck(analyze(pieces), [{ cx: 200, cy: 200, r: 150 }], 0.001);
});

check("tangent arcs with different radii (r 150 flowing into r 60) keep both circles", () => {
  const a = arcPath(200, 200, 150, evenAngles(0, 90, 1)); // ends at (200, 350) heading left
  const b = arcPath(200, 290, 60, evenAngles(Math.PI / 2, 90, 1)).replace(/^M[^C]*/, "");
  return circleCheck(analyze([a + b]), [{ cx: 200, cy: 200, r: 150 }, { cx: 200, cy: 290, r: 60 }], 0.001);
});

check("S made of two exact opposite arcs keeps both circles", () => {
  // One continuous path: around the left of the top circle, then the right of the bottom one.
  // Both arcs head right where they meet at (200, 200), so the join is smooth.
  const top = arcPath(200, 130, 70, evenAngles(-Math.PI / 2, -180, 2));
  const bottom = arcPath(200, 270, 70, evenAngles(-Math.PI / 2, 180, 2)).replace(/^M[^C]*/, "");
  return circleCheck(analyze([top + bottom]), [{ cx: 200, cy: 130, r: 70 }, { cx: 200, cy: 270, r: 70 }], 0.001);
});

check("swoosh built from tangent arcs of different radii (like FC-Icon)", () => {
  const chain = tangentChain([40, 60], 0.6, [
    { r: 90, sweep: 40 }, { r: 300, sweep: 25 }, { r: 60, sweep: 70 }, { r: 180, sweep: -35 }, { r: 420, sweep: -20 },
  ]);
  return circleCheck(analyze([chain.d]), chain.truth, 0.001);
});

check("swoosh with export rounding (2 decimals) still reads every arc", () => {
  const chain = tangentChain([40, 60], 0.6, [
    { r: 90, sweep: 40 }, { r: 300, sweep: 25 }, { r: 60, sweep: 70 }, { r: 180, sweep: -35 }, { r: 420, sweep: -20 },
  ]);
  const rounded = chain.d.replace(/-?\d+\.\d+/g, (n) => (Math.round(parseFloat(n) * 100) / 100).toString());
  return circleCheck(analyze([rounded]), chain.truth, 0.01);
});

// ---------------------------------------------------------------
// Things that are NOT circles
// ---------------------------------------------------------------

// An ellipse is not a circle, but each quarter can be read as its own tangent
// circle (the classic four-center oval). What must never happen is one circle
// claimed for the whole ellipse; the hug check below covers the rest.
function ellipsePath(rx, ry) {
  const k = 0.5522847498;
  return `M${200 + rx} 200C${200 + rx} ${200 + ry * k} ${200 + rx * k} ${200 + ry} 200 ${200 + ry}C${200 - rx * k} ${200 + ry} ${200 - rx} ${200 + ry * k} ${200 - rx} 200C${200 - rx} ${200 - ry * k} ${200 - rx * k} ${200 - ry} 200 ${200 - ry}C${200 + rx * k} ${200 - ry} ${200 + rx} ${200 - ry * k} ${200 + rx} 200Z`;
}

check("ellipse (rx 150, ry 120) is never read as one circle", () => {
  const r = analyze([ellipsePath(150, 120)]);
  const whole = r.trace.curves.some((c) => c.status === "circle" && c.beziers.length === 4);
  return { ok: !whole, detail: `${r.circles.length} quarter circles, none spanning the whole ellipse` };
});

check("subtle ellipse (4% squash) is never read as one circle", () => {
  const r = analyze([ellipsePath(150, 144)]);
  const whole = r.trace.curves.some((c) => c.status === "circle" && c.beziers.length === 4);
  return { ok: !whole, detail: `${r.circles.length} quarter circles, none spanning the whole ellipse` };
});

check("S-curve (sigmoid cubic) is not a circle", () => {
  const r = analyze(["M0 0H400V400H0Z", "M50 300C200 300 200 100 350 100"]);
  return { ok: r.circles.length === 0, detail: `found ${r.circles.length} circles` };
});

check("squircle app-icon shape has no circles", () => {
  // Superellipse-like corners: handles stretched well past a circular kappa.
  const d = "M200 50C330 50 350 70 350 200C350 330 330 350 200 350C70 350 50 330 50 200C50 70 70 50 200 50Z";
  const r = analyze([d]);
  return { ok: r.circles.length === 0, detail: `found ${r.circles.length} circles: ` + JSON.stringify(r.circles.map((c) => f(c.r))) };
});

// ---------------------------------------------------------------
// Guidelines
// ---------------------------------------------------------------

check("line drawn as 60 tiny collinear segments gives one guideline", () => {
  // Each piece is 5 units (7.5 after normalizing) — under the 10-unit minimum on its own.
  let d = "M50 200";
  for (let i = 1; i <= 60; i++) d += `L${50 + i * 5} 200`;
  const r = analyze(["M0 0H400V400H0Z", d]);
  const horizontalAt200 = r.lines.filter((l) => Math.abs(l[0][1] - 200) < 0.5 && Math.abs(l[1][1] - 200) < 0.5);
  return { ok: horizontalAt200.length === 1, detail: `${horizontalAt200.length} guidelines at y=200` };
});

check("nearly flat curve (0.05% bow) counts as a straight edge", () => {
  const r = analyze(["M0 0H400V400H0Z", "M50 200C150 200.15 250 200.15 350 200"]);
  const atY = r.lines.filter((l) => Math.abs(l[0][1] - 200) < 1 && Math.abs(l[1][1] - 200) < 1);
  return { ok: atY.length === 1 && r.circles.length === 0, detail: `${atY.length} guidelines, ${r.circles.length} circles` };
});

check("vertical edge with export rounding noise is exactly vertical", () => {
  const r = analyze(["M100 50L100.03 350L300 350Z"]);
  const vertical = r.lines.find((l) => Math.abs(l[0][0] - 100) < 1 && Math.abs(l[1][0] - 100) < 1);
  if (!vertical) return { ok: false, detail: "no vertical guideline" };
  const dx = Math.abs(vertical[1][0] - vertical[0][0]);
  return { ok: dx < 1e-6, detail: `x drift across canvas ${dx.toFixed(4)}` };
});

check("rectangle path starting mid-edge gives exactly 4 guidelines", () => {
  const r = analyze(["M200 100H300V300H100V100Z"]);
  return { ok: r.lines.length === 4, detail: `${r.lines.length} guidelines` };
});

check("guideline angle follows the whole edge, not one noisy piece", () => {
  // A 300-unit diagonal at exactly 30°, drawn as 6 pieces with ±0.05 jitter on inner joints.
  const a = Math.PI / 6;
  let d = "M50 50";
  for (let i = 1; i <= 6; i++) {
    const t = (300 * i) / 6;
    const j = i < 6 ? (i % 2 ? 0.05 : -0.05) : 0;
    d += `L${f(50 + t * Math.cos(a) - j * Math.sin(a))} ${f(50 + t * Math.sin(a) + j * Math.cos(a))}`;
  }
  const r = analyze(["M0 0H400V400H0Z", d]);
  const diag = r.lines.filter((l) => {
    const ang = (Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]) * 180) / Math.PI;
    const folded = ((ang % 180) + 180) % 180;
    return Math.abs(folded - 30) < 3;
  });
  if (diag.length !== 1) return { ok: false, detail: `${diag.length} diagonal guidelines` };
  const ang = (Math.atan2(diag[0][1][1] - diag[0][0][1], diag[0][1][0] - diag[0][0][0]) * 180) / Math.PI;
  const err = Math.abs(((ang % 180) + 180) % 180 - 30);
  return { ok: err < 0.01, detail: `angle error ${err.toFixed(4)}°` };
});

// ---------------------------------------------------------------

check("every detected circle hugs the curves it came from (all cases above)", () => ({
  ok: hugViolations.length === 0,
  detail: hugViolations.length ? hugViolations.slice(0, 3).join("; ") : "no misses",
}));

const width = Math.max(...results.map((r) => r.name.length));
results.forEach((r) => console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  ${r.detail}`));
console.log(`\n${results.length - failures}/${results.length} accurate`);
if (failures) process.exitCode = 1;
