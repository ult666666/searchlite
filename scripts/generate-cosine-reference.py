"""Independent, deterministic binary64-input cosine reference. Standard library only."""
from decimal import Decimal, localcontext
import hashlib
import json
import math
import sys

if len(sys.argv) != 1:
    print("Usage: python3 scripts/generate-cosine-reference.py", file=sys.stderr)
    raise SystemExit(2)

PRECISION = 3500
SEED = 0xC0514E
state = SEED


def component():
    global state
    state = (1664525 * state + 1013904223) & 0xFFFFFFFF
    return ((state >> 16) % 33 - 16) / 16


def reference(left, right):
    assert len(left) == len(right)
    assert all(math.isfinite(x) for x in left + right)
    with localcontext() as context:
        context.prec = PRECISION
        a = [Decimal.from_float(float(x)) for x in left]
        b = [Decimal.from_float(float(x)) for x in right]
        dot = sum((x * y for x, y in zip(a, b)), Decimal(0))
        squared_a = sum((x * x for x in a), Decimal(0))
        squared_b = sum((x * x for x in b), Decimal(0))
        if squared_a == 0 or squared_b == 0:
            return 0.0
        return float(dot / (squared_a.sqrt() * squared_b.sqrt()))


maximum = float.fromhex("0x1.fffffffffffffp+1023")
minimum = float.fromhex("0x0.0000000000001p-1022")
inputs = [
    ("empty", [], [], False),
    ("zero-left", [0.0, -0.0], [maximum, maximum], False),
    ("zero-right", [minimum, minimum], [0.0, 0.0], False),
    ("huge-parallel", [1e308, 1e308], [1e308, 1e308], False),
    ("huge-opposed", [maximum, maximum], [-maximum, -maximum], False),
    ("huge-orthogonal", [maximum, 0.0], [0.0, maximum], False),
    ("tiny-parallel", [1e-300, 1e-300], [1e-300, 1e-300], False),
    ("subnormal-parallel", [minimum, minimum], [minimum, minimum], False),
    ("subnormal-oblique", [minimum, minimum], [0.0, minimum], False),
    ("mixed-huge", [1e308, 1.0], [0.0, 1e308], True),
    ("underflow-dot", [1e-100, 1e-220], [0.0, 1e-100], True),
    ("cancellation", [1.0, 1e-300, -1.0], [1.0, 1.0, 1.0], True),
    ("ordinary", [3.0, 4.0], [4.0, 3.0], False),
    ("ordinary-oblique", [1.0, 2.0, 3.0], [2.0, -1.0, 0.5], False),
    ("large-and-tiny", [maximum, minimum], [-maximum, minimum], False),
]
scales = [minimum, 1e-308, 1e-200, 1e-100, 1.0, 1e100, 1e200, 1e308]
for i, left_scale in enumerate(scales):
    for j, right_scale in enumerate(scales):
        a = [1.0] + [component() for _ in range(7)]
        b = [-1.0] + [component() for _ in range(7)]
        inputs.append((f"scaled-{i}-{j}", [x * left_scale for x in a],
                       [x * right_scale for x in b], False))
for i in range(16):
    left_scale = 2.0 ** (-500 if i % 2 else 500)
    right_scale = 2.0 ** (500 if i % 3 else -500)
    inputs.append((f"seeded-64-{i}", [component() * left_scale for _ in range(64)],
                   [component() * right_scale for _ in range(64)], False))
inputs.append(("wide-mixed", [x * 1e300 for x in [1.0, -1.0, 0.5, -0.5] * 64],
               [x * 1e-300 for x in [-1.0, -1.0, 0.5, 0.5] * 64], False))
assert len(inputs) == 96
cases = [{"id": name, "left": left, "right": right,
          "expected": reference(left, right), "relative": relative}
         for name, left, right, relative in inputs]
assert next(c["expected"] for c in cases if c["id"] == "ordinary") == 0.96
assert next(c["expected"] for c in cases if c["id"] == "huge-parallel") == 1.0
report = {
    "schema": "searchlite.cosine-reference/1",
    "precisionDigits": PRECISION,
    "seed": SEED,
    "method": "Decimal.from_float converts exact binary64 inputs; raw dot, squared norms and Decimal.sqrt at 3500 digits, then one float conversion. No JS scaling or compensation.",
    "limits": "Finite synthetic conformance evidence, not a correctly-rounded or exhaustive proof. Absolute tolerance 8*Number.EPSILON; selected tiny cases also use relative tolerance.",
    "inputSha256": hashlib.sha256(json.dumps(inputs, separators=(",", ":"), allow_nan=False).encode()).hexdigest(),
    "cases": cases,
}
print(json.dumps(report, indent=2, allow_nan=False))
