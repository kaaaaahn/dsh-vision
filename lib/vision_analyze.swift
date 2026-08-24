// vision_analyze.swift — macOS Vision 图像分析 + ollama 视觉模型语义描述
// 用法: swift vision_analyze.swift <image-path> [describe|describe:模型名]
//   - 默认: OCR 文本（像素坐标，左上原点，按 y 分组）+ 图片尺寸
//   - describe: 额外调用 ollama 本地视觉模型（默认 qwen3-vl:4b-instruct-q4_K_M）输出语义描述
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("usage: swift vision_analyze.swift <image-path> [describe]\n", stderr)
    exit(1)
}
let path = args[1]
let describeFlag = args.count >= 3 ? args[2] : ""

guard let img = NSImage(contentsOfFile: path) else {
    fputs("cannot load image: \(path)\n", stderr)
    exit(2)
}
var rect = NSRect(origin: .zero, size: img.size)
guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
    fputs("cannot make cgImage\n", stderr)
    exit(3)
}

let W = cg.width
let H = cg.height
var result: [String: Any] = [
    "path": path,
    "width": W,
    "height": H,
]

// ── OCR + 标注定位 ──
let ocr = VNRecognizeTextRequest()
ocr.recognitionLevel = .accurate
ocr.usesLanguageCorrection = true
ocr.recognitionLanguages = ["zh-Hans", "en-US"]

// 矩形检测：捕捉框线/标注框/划线区域（Vision 原生，毫秒级）
let rectReq = VNDetectRectanglesRequest()
rectReq.minimumAspectRatio = 0.2
rectReq.maximumAspectRatio = 10
rectReq.minimumSize = 0.03
rectReq.maximumObservations = 12

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([ocr, rectReq])

var texts: [[String: Any]] = []
var textBoxes: [CGRect] = [] // 原图像素坐标，供区域推导
for obs in ocr.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox // 归一化，原点左下
    let x = b.origin.x * CGFloat(W)
    let y = (1 - b.origin.y - b.size.height) * CGFloat(H) // 转左上原点
    let w = b.size.width * CGFloat(W)
    let h = b.size.height * CGFloat(H)
    textBoxes.append(CGRect(x: x, y: y, width: w, height: h))
    texts.append([
        "text": cand.string,
        "x": Int(x.rounded()),
        "y": Int(y.rounded()),
        "w": Int(w.rounded()),
        "h": Int(h.rounded()),
        "conf": Double(cand.confidence),
    ])
}
texts.sort { a, b in
    let ya = (a["y"] as? Int) ?? 0
    let yb = (b["y"] as? Int) ?? 0
    if abs(ya - yb) > 8 { return ya < yb }
    return (a["x"] as? Int) ?? 0 < (b["x"] as? Int) ?? 0
}
result["texts"] = texts

// ── 关注区域推导：文本密集区 ∪ 矩形框，膨胀后合并重叠 ──
// 用户只传图不传文案 → 图内必有标注；这些区域值得放大细看
func growAndMerge(_ boxes: [CGRect], expand: CGFloat, maxBoxes: Int = 4) -> [CGRect] {
    var merged: [CGRect] = []
    for b in boxes.sorted(by: { $0.width * $0.height > $1.width * $1.height }) {
        let g = b.insetBy(dx: -expand, dy: -expand)
        if let i = merged.firstIndex(where: { $0.intersects(g) }) {
            merged[i] = merged[i].union(g)
        } else if merged.count < maxBoxes {
            merged.append(g)
        }
    }
    return merged
}
let grownTexts = growAndMerge(textBoxes, expand: 20)
var rectCands: [CGRect] = []
for obs in rectReq.results ?? [] {
    let b = obs.boundingBox
    let x = b.origin.x * CGFloat(W)
    let y = (1 - b.origin.y - b.size.height) * CGFloat(H)
    let w = b.size.width * CGFloat(W)
    let h = b.size.height * CGFloat(H)
    let area = w * h
    let total = CGFloat(W * H)
    // 过滤：太小（<2% 全图）或几乎铺满全图（外框无意义）
    if area < total * 0.02 || (w > total * 0.95 && h > total * 0.95) { continue }
    rectCands.append(CGRect(x: x, y: y, width: w, height: h))
}
let regions = growAndMerge(rectCands + grownTexts, expand: 12, maxBoxes: 4)
var regionMeta: [[String: Any]] = []
for r in regions {
    // 裁剪边界收敛到原图内
    let cx = max(0, r.origin.x)
    let cy = max(0, r.origin.y)
    let cw = min(CGFloat(W) - cx, r.width)
    let ch = min(CGFloat(H) - cy, r.height)
    regionMeta.append(["x": Int(cx.rounded()), "y": Int(cy.rounded()), "w": Int(cw.rounded()), "h": Int(ch.rounded())])
}
if !regionMeta.isEmpty { result["regions"] = regionMeta }

// ── ollama 语义描述 ──
if describeFlag.hasPrefix("describe") {
    var modelName = "qwen3-vl:4b-instruct-q4_K_M"
    let parts = describeFlag.split(separator: ":")
    if parts.count >= 2 { modelName = String(parts[1]) }

    guard let data = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: data) else {
        result["vision"] = ["error": "图片编码失败"]
        let out = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(data: out, encoding: .utf8)!)
        exit(0)
    }
    let srcW = CGFloat(rep.pixelsWide)
    let srcH = CGFloat(rep.pixelsHigh)

    // ── 两阶段读图：整体压缩图 + 关注区域放大图，一次请求多图 ──
    // Qwen3-VL 推荐单图视觉 token 256~1280（32× 空间压缩，≈ 0.26M~1.31M 像素）。
    // 有标注区域时整体图降档（≤896），把 token 预算让给放大区域；无区域时整体用满 1280。
    func encodeImage(_ source: NSBitmapImageRep, maxSide: CGFloat, maxPixels: CGFloat) -> (b64: String?, w: Int, h: Int, scale: CGFloat) {
        var target = source
        var scaleUsed: CGFloat = 1.0
        let lw = CGFloat(source.pixelsWide)
        let lh = CGFloat(source.pixelsHigh)
        let scale = min(maxSide / max(lw, lh), sqrt(maxPixels / (lw * lh)), 1.0)
        if scale < 1.0 {
            let w = max(1, Int((lw * scale).rounded()))
            let h = max(1, Int((lh * scale).rounded()))
            if let srcCG = source.cgImage,
               let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                ctx.interpolationQuality = .high // Lanczos 级缩放，文字边缘更清晰
                ctx.draw(srcCG, in: CGRect(x: 0, y: 0, width: w, height: h))
                if let scaled = ctx.makeImage() {
                    let scaledRep = NSBitmapImageRep(cgImage: scaled)
                    scaledRep.size = NSSize(width: w, height: h)
                    target = scaledRep
                    scaleUsed = CGFloat(w) / lw
                }
            }
        }
        // 带透明通道用 PNG（保留 alpha），否则 JPEG 85（截图 payload 小 5~10 倍）
        let enc: NSBitmapImageRep.FileType = source.hasAlpha ? .png : .jpeg
        let props: [NSBitmapImageRep.PropertyKey: Any] = enc == .jpeg ? [.compressionFactor: 0.85] : [:]
        guard let encoded = target.representation(using: enc, properties: props) else { return (nil, target.pixelsWide, target.pixelsHigh, scaleUsed) }
        return (encoded.base64EncodedString(), target.pixelsWide, target.pixelsHigh, scaleUsed)
    }

    var images: [String] = []
    var imageNotes: [String] = []

    // 整体图：无区域时 1280/1M 满档；有区域时降档留预算
    let hasRegions = !regions.isEmpty
    let whole = encodeImage(rep, maxSide: hasRegions ? 896 : 1280, maxPixels: hasRegions ? 524_288 : 1_048_576)
    if let b = whole.b64 { images.append(b) }
    imageNotes.append("第1张=整体视图(\(whole.w)×\(whole.h))")

    // 区域放大图：裁剪原图 → 放大到 640 档（≈0.2M 像素，每张约 200 视觉 token）。最多 2 张，控制总 token
    var regionMetaOut: [[String: Any]] = []
    for (i, r) in regions.prefix(2).enumerated() {
        let crop = CGRect(x: r.origin.x, y: r.origin.y, width: r.width, height: r.height)
        guard let cgImg = cg.cropping(to: crop) else { continue }
        let cropRep = NSBitmapImageRep(cgImage: cgImg)
        let scaled = encodeImage(cropRep, maxSide: 640, maxPixels: 262_144)
        guard let b = scaled.b64 else { continue }
        images.append(b)
        imageNotes.append("第\(i + 2)张=标注区域放大(原坐标 \(Int(r.origin.x)),\(Int(r.origin.y)) \(Int(r.width))×\(Int(r.height))，缩放后 \(scaled.w)×\(scaled.h))")
        regionMetaOut.append([
            "x": Int(max(0, r.origin.x).rounded()), "y": Int(max(0, r.origin.y).rounded()),
            "w": Int(min(r.width, srcW - max(0, r.origin.x)).rounded()),
            "h": Int(min(r.height, srcH - max(0, r.origin.y)).rounded()),
            "scaled": ["width": scaled.w, "height": scaled.h],
        ])
    }

    // 元信息：让模型知道当前看到的是压缩视图 + 放大区域
    result["vision_meta"] = [
        "original": ["width": Int(srcW), "height": Int(srcH)],
        "scaled": ["width": whole.w, "height": whole.h],
        "scale": round(whole.scale * 1000) / 1000,
        "encoding": "jpeg-85/png",
        "payloadKB": images.reduce(0) { $0 + ($1.count * 3 / 4) } / 1024,
        "regions": regionMetaOut,
    ]

    let totalBytes = images.reduce(0) { $0 + $1.count * 3 / 4 } // base64 → 字节估算（保留供调试）
    let prompt = "这是一张软件界面截图（可能是游戏开发工具），共 \(images.count) 张图。\(imageNotes.joined(separator: "；"))。"
        + "用户只发了图片没有附带文字说明，因此图内通常包含标注（文字、框线、划线、箭头等），请优先查找这些标注并解读其含义。"
        + "请用简洁的中文输出：1) 界面整体布局（看第1张）；2) 放大区域中可见的文字标注与框线/箭头所指内容（逐张细看）；3) 任何异常、错位、被裁剪或样式问题。无法确定就说明无法确定。控制在200字以内。"

    let payload: [String: Any] = [
        "model": modelName,
        "prompt": prompt,
        "images": images,
        "stream": false,
        "options": ["temperature": 0.2, "num_predict": 500, "num_ctx": 16384],
    ]
    _ = totalBytes
    var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/generate")!)
    request.httpMethod = "POST"
    request.timeoutInterval = 300 // 多图推理可能超过默认 60s
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)

    do {
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 200,
           let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
           let text = json["response"] as? String {
            result["vision"] = text
        } else {
            let raw = String(data: data, encoding: .utf8) ?? "no body"
            result["vision"] = ["error": "ollama 调用失败: \(raw.prefix(200))"]
        }
    } catch {
        result["vision"] = ["error": "ollama 不可达: \(error.localizedDescription)（确认已运行 ollama serve）"]
    }
}

let out = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(data: out, encoding: .utf8)!)
