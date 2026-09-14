# LogoGrid

A standalone Mac app that draws construction grids for logos. Drop in an SVG
and it finds the guidelines, arcs, anchor points and bezier handles, previews
them live, and exports SVG or PNG. You don't need Illustrator.

It's a rebuild of [Logo Grid Lines](Logo-Grid-Lines.jsx), the Illustrator
script by [Studio Gibbous](https://www.studiogibbous.com), with the same
detection approach, fixes for several bugs, and a full UI.

## Install

```bash
./build.sh --install
```

This runs the tests, compiles a universal (Apple Silicon + Intel) app, and copies it to `~/Applications/LogoGrid.app`.
Use `./build.sh` on its own to build into `build/` without installing.

Requirements: macOS 13+, Xcode command line tools (`swiftc`), and Node (for tests).

## Share with a friend

Send them the link to the latest release:
**https://github.com/austynundrafted-lgtm/LogoGrid/releases/latest**
(or email them the `LogoGrid-x.y.z.zip` from that page). They:

1. Double-click the zip and drag **LogoGrid** into **Applications**. Running it from Downloads works, but it can't update itself from there.
2. Open it. The first time, macOS says it can't verify the app: click **Done**, then open
   **System Settings › Privacy & Security**, scroll down and click **Open Anyway**. This is only needed once,
   because the app isn't notarized by Apple yet (that needs an Apple Developer Program membership).

It runs on Apple Silicon and Intel Macs with macOS 13 or later.

## Release an update

1. Make and commit your changes.
2. Bump the number in `VERSION` (for example `1.0.0` → `1.1.0`) and commit that too.
3. Run `./release.sh "What changed"`.

That builds the universal app, zips it, pushes your branch and publishes a GitHub Release. Everyone's copy
checks for a newer release a few seconds after it opens and shows an **Update available** card; **Install &
Relaunch** downloads it, verifies it (checksum, app identity, code signature), swaps it in and reopens.
They can also use **LogoGrid › Check for Updates…**, or skip a version.

## Use

- **Open**: ⌘O, drag a file onto the window, paste SVG code (⌘V), or right-click an SVG in Finder › Open With › LogoGrid.
  From Illustrator, use File › Export › Export As… › SVG, and convert live text to outlines first.
- **Layers**: toggle Logo, Guidelines, Arcs, Anchor points and Bézier handles. Click a layer's name to change its color, stroke, opacity, dashes, and point shape and size.
- **Style presets**: Signal, Classic (the original script's look), Blueprint and Midnight. "Save current" stores your own.
- **Canvas**: extend guidelines to the SVG artboard or to the artwork bounds, add padding, and set a background color or transparency.
- **Detection** (advanced): minimum line and arc length, circle fit, merge tolerances and minimum radius.
  Hover any setting (or layer, or canvas option) to highlight on the logo exactly what it affects.
- **Export**: ⌘E for SVG, ⇧⌘E for PNG at 1×, 2× or 4×, and ⇧⌘C to copy SVG. Exported SVGs keep named groups
  (`Logo`, `Arcs`, `Guidelines`, `Handles`, `Points`) so they arrive organized in Illustrator or Figma.

Settings, presets and the last opened logo are remembered between launches.

## Changes from the original script

| Original behavior | LogoGrid |
| --- | --- |
| Anchor squares skipped compound paths | All anchors are marked |
| Open paths got a stray guideline joining their end to their start | Only closed paths get a closing segment |
| `Math.abs(angle) % 180` treated −45° and 45° lines as parallel | Angles are folded correctly |
| Parallel lines merged by measuring from one endpoint only | Both endpoints must be close |
| Any circle inside a bigger one was merged away, which lost inner rings | Only near-identical circles merge |
| The 300° arc limit could never trigger, and arcs were judged from 3 points | Arcs are least-squares fitted and their sweep measured along the whole arc |
| Each run piled up duplicate layers | Output is regenerated live |
| Thresholds were in absolute pixels | Artwork is normalized first, so results don't depend on SVG size |
| Straight segments with on-line handles counted as curves | They're treated as straight lines |

## How detection works

- **Edges.** Consecutive straight pieces that continue the same line are joined into one edge, and its
  guideline follows a least-squares fit through every point, so a jittery piece can't tilt it. Curves that
  bow less than you could see count as straight. Guidelines within 0.15° of horizontal/vertical snap to the axis.
- **Arcs.** Every curve piece is fitted with a least-squares circle and read as circular when it strays less
  than the Circle fit tolerance (2% of the arc's size by default). The final center and radius come from the
  points a bezier arc draws exactly, so standard arcs are exact.
- **Joining and merging.** Neighboring pieces become one arc, and similar circles merge, only when a single
  circle still hugs every piece (within 0.4%). So a circle drawn in many small pieces, a quadratic font outline
  or slightly imperfect tracing reads as one circle, while a swoosh built from tangent arcs of different radii
  gets one circle per arc instead of an average that fits none of them.
- **Guarantee.** Every circle LogoGrid draws hugs the curve it was read from. The accuracy tests check this
  for every case.
- **Import.** Invisible shapes (like an exporter's empty artboard rectangle) are skipped. Live text, embedded
  images, stroke-only shapes and clipped shapes are listed on the file card, since the grid can't see them as drawn.

`tests/accuracy.test.js` checks all of this against synthetic artwork with known answers.

## Project layout

```
app/web/geometry.js   detection engine (pure JS, no DOM)
app/web/importer.js   SVG → bezier paths (shapes, transforms, <use>, sanitizing)
app/web/app.js        UI, rendering, presets, export
app/macos/main.swift  native window, menus, open/save panels, clipboard, settings
app/macos/Updater.swift  checks GitHub Releases, installs updates
VERSION               the version number releases are published under
release.sh            build, zip and publish a GitHub Release
tests/                node tests/geometry.test.js · node tests/accuracy.test.js
build.sh              build + optional install
```

## Credit

Detection logic adapted from *Logo Grid Lines* v1.3 by Studio Gibbous,
released under a Creative Commons license.
