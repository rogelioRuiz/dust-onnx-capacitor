#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path


def main() -> None:
    try:
        import onnx
        from onnx import TensorProto, helper
    except ImportError as exc:
        raise SystemExit(
            "The `onnx` package is required to generate the fixture. Install it with `python3 -m pip install onnx`."
        ) from exc

    root = Path(__file__).resolve().parents[1]
    output_path = root.parent / "dust-onnx-swift" / "Tests" / "DustOnnxTests" / "Fixtures" / "tiny-test.onnx"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    input_a = helper.make_tensor_value_info("input_a", TensorProto.FLOAT, [1, 3])
    input_b = helper.make_tensor_value_info("input_b", TensorProto.FLOAT, [1, 3])
    output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3])

    node = helper.make_node("Add", ["input_a", "input_b"], ["output"])
    graph = helper.make_graph([node], "tiny_test", [input_a, input_b], [output])
    model = helper.make_model(
        graph,
        producer_name="capacitor-onnx",
        opset_imports=[helper.make_opsetid("", 13)],
    )
    model.ir_version = 7
    onnx.save(model, output_path)

    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
