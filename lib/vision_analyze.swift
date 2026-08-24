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

// ── OCR ──
let ocr = VNRecognizeTextRequest()
ocr.recognitionLevel = .accurate
ocr.usesLanguageCorrection = true
ocr.recognitionLanguages = ["zh-Hans", "en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([ocr])

var texts: [[String: Any]] = []
for obs in ocr.results ?? [] {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox // 归一化，原点左下
    let x = b.origin.x * CGFloat(W)
    let y = (1 - b.origin.y - b.size.height) * CGFloat(H) // 转左上原点
    let w = b.size.width * CGFloat(W)
    let h = b.size.height * CGFloat(H)
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

    // ── 前置压缩：Qwen3-VL 推荐单图视觉 token 256~1280（32× 空间压缩，≈ 0.26M~1.31M 像素）──
    // 双约束：最长边 ≤ 1280 且总像素 ≤ 1M；Lanczos 高质量插值；大图用 JPEG 85 减小 payload
    let MAX_SIDE: CGFloat = 1280
    let MAX_PIXELS: CGFloat = 1_048_576 // 1M 像素，对应官方 max_pixels 推荐档
    var target = rep
    var scaleUsed: CGFloat = 1.0
    let srcW = CGFloat(rep.pixelsWide)
    let srcH = CGFloat(rep.pixelsHigh)
    let longest = max(srcW, srcH)
    let pixels = srcW * srcH
    let scaleBySide = MAX_SIDE / longest
    let scaleByPixels = sqrt(MAX_PIXELS / pixels)
    let scale = min(scaleBySide, scaleByPixels, 1.0)
    if scale < 1.0 {
        let w = max(1, Int((srcW * scale).rounded()))
        let h = max(1, Int((srcH * scale).rounded()))
        if let srcCG = rep.cgImage,
           let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.interpolationQuality = .high // Lanczos 级缩放，文字边缘更清晰
            ctx.draw(srcCG, in: CGRect(x: 0, y: 0, width: w, height: h))
            if let scaled = ctx.makeImage() {
                let scaledRep = NSBitmapImageRep(cgImage: scaled)
                scaledRep.size = NSSize(width: w, height: h)
                target = scaledRep
                scaleUsed = CGFloat(w) / srcW
            }
        }
    }

    // 编码选择：带透明通道用 PNG（保留 alpha），否则 JPEG 85（截图 payload 可小 5~10 倍）
    let enc: NSBitmapImageRep.FileType = rep.hasAlpha ? .png : .jpeg
    let props: [NSBitmapImageRep.PropertyKey: Any] = enc == .jpeg ? [.compressionFactor: 0.85] : [:]
    guard let encoded = target.representation(using: enc, properties: props) else {
        result["vision"] = ["error": "图片编码失败"]
        let out = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        print(String(data: out, encoding: .utf8)!)
        exit(0)
    }
    let b64 = encoded.base64EncodedString()

    // 元信息：让模型知道当前看到的是压缩视图，原图尺寸是多少
    result["vision_meta"] = [
        "original": ["width": Int(srcW), "height": Int(srcH)],
        "scaled": ["width": target.pixelsWide, "height": target.pixelsHigh],
        "scale": round(scaleUsed * 1000) / 1000,
        "encoding": enc == .jpeg ? "jpeg-85" : "png",
        "payloadKB": encoded.count / 1024,
    ]

    let prompt = "这是一张软件界面截图（可能是游戏开发工具）。输入图像已被压缩（原图 \(Int(srcW))×\(Int(srcH))，当前 \(target.pixelsWide)×\(target.pixelsHigh)），小号文字可能无法辨认。请用简洁的中文描述：1) 界面整体布局；2) 可见的主要元素与文字；3) 任何看起来异常、错位、被裁剪或样式有问题的地方。如果无法确定就说明无法确定。控制在150字以内。"

    let payload: [String: Any] = [
        "model": modelName,
        "prompt": prompt,
        "images": [b64],
        "stream": false,
        "options": ["temperature": 0.2, "num_predict": 400, "num_ctx": 16384],
    ]
    var request = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/generate")!)
    request.httpMethod = "POST"
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
