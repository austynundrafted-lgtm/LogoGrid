// Renders the LogoGrid app icon as a 1024×1024 PNG.
// Usage: swift make_icon.swift output.png
import AppKit

let size: CGFloat = 1024
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

// macOS icon grid: 824pt rounded rect centered on a 1024 canvas.
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.3).cgColor)
ctx.addPath(tilePath)
ctx.setFillColor(NSColor.black.cgColor)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [
        NSColor(red: 1.0, green: 0.45, blue: 0.2, alpha: 1).cgColor,
        NSColor(red: 0.93, green: 0.27, blue: 0.06, alpha: 1).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: tile.maxY), end: CGPoint(x: 0, y: tile.minY), options: [])

let center = CGPoint(x: 512, y: 512)
let radius: CGFloat = 230

// Construction grid
ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.45).cgColor)
ctx.setLineWidth(6)
for v in [center.x - radius, center.x + radius] {
    ctx.move(to: CGPoint(x: v, y: tile.minY)); ctx.addLine(to: CGPoint(x: v, y: tile.maxY))
}
for v in [center.y - radius, center.y + radius] {
    ctx.move(to: CGPoint(x: tile.minX, y: v)); ctx.addLine(to: CGPoint(x: tile.maxX, y: v))
}
ctx.move(to: CGPoint(x: tile.minX, y: tile.minY)); ctx.addLine(to: CGPoint(x: tile.maxX, y: tile.maxY))
ctx.strokePath()

// Mark: a ring
ctx.setStrokeColor(NSColor.white.cgColor)
ctx.setLineWidth(58)
ctx.addEllipse(in: CGRect(x: center.x - radius + 29, y: center.y - radius + 29, width: (radius - 29) * 2, height: (radius - 29) * 2))
ctx.strokePath()

// Anchor points
let pointSize: CGFloat = 54
let anchors = [
    CGPoint(x: center.x, y: center.y + radius), CGPoint(x: center.x + radius, y: center.y),
    CGPoint(x: center.x, y: center.y - radius), CGPoint(x: center.x - radius, y: center.y),
]
for p in anchors {
    let r = CGRect(x: p.x - pointSize / 2, y: p.y - pointSize / 2, width: pointSize, height: pointSize)
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fill(r)
    ctx.setStrokeColor(NSColor(red: 0.93, green: 0.27, blue: 0.06, alpha: 1).cgColor)
    ctx.setLineWidth(9)
    ctx.stroke(r.insetBy(dx: 4.5, dy: 4.5))
}
ctx.restoreGState()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
