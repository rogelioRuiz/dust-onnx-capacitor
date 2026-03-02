// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DustOnnxCapacitor",
    platforms: [.iOS(.v16), .macOS(.v14)],
    products: [
        .library(
            name: "DustOnnxCapacitor",
            targets: ["ONNXPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/rogelioRuiz/dust-core-capacitor.git", from: "0.1.0"),
        .package(url: "https://github.com/rogelioRuiz/dust-core-swift.git", from: "0.1.0"),
        .package(url: "https://github.com/rogelioRuiz/dust-onnx-swift.git", from: "0.1.0"),
    ],
    targets: [
        .target(
            name: "ONNXPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "DustCoreCapacitor", package: "dust-core-capacitor"),
                .product(name: "DustCore", package: "dust-core-swift"),
                .product(name: "DustOnnx", package: "dust-onnx-swift"),
            ],
            path: "ios/Sources/ONNXPlugin"
        )
    ]
)
