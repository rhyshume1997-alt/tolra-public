import { describe, expect, it } from "vitest";

import { MAX_PATH_LENGTH, MIN_STROKE_LENGTH, PATH_PATTERN, drawnSignature, encodePath, parseSignaturePath, strokeLength } from "@/components/signature-pad";

describe("signature pad path encoding (M4)", () => {
  it("encodes strokes as SVG move/line commands, rounded and kept on the pad", () => {
    expect(encodePath([[{ x: 10.4, y: 20.6 }, { x: 30, y: 40 }], [{ x: 50, y: 60 }, { x: 70.5, y: 80.49 }]])).toBe("M10 21L30 40M50 60L71 80");
    expect(encodePath([[{ x: -5, y: 999 }, { x: 700, y: -1 }]])).toBe("M0 200L600 0");
    expect(encodePath([[{ x: 5, y: 5 }]])).toBe("M5 5L5 5");
    expect(encodePath([[], []])).toBe("");
  });

  it("only uses the characters the database accepts", () => {
    const path = encodePath([[{ x: 1, y: 2 }, { x: 599.9, y: 199.9 }, { x: 0.2, y: 0.4 }]]);
    expect(path).toMatch(PATH_PATTERN);
    expect("M1 2L3 4<script>").not.toMatch(PATH_PATTERN);
  });

  it("needs a minimum amount of ink, and refuses a path too long to store", () => {
    expect(strokeLength([[{ x: 0, y: 0 }, { x: 3, y: 4 }]])).toBe(5);
    expect(drawnSignature([[{ x: 0, y: 0 }, { x: MIN_STROKE_LENGTH - 1, y: 0 }]])).toBeNull();
    expect(drawnSignature([[{ x: 0, y: 0 }, { x: MIN_STROKE_LENGTH, y: 0 }]])).toBe(`M0 0L${MIN_STROKE_LENGTH} 0`);
    const scribble = Array.from({ length: MAX_PATH_LENGTH / 4 }, (_, i) => ({ x: (i * 7) % 600, y: (i * 13) % 200 }));
    expect(drawnSignature([scribble])).toBeNull();
  });

  it("renders a stored path only from parsed numbers: anything that isn't move/line pairs is dropped, never passed through", () => {
    expect(parseSignaturePath("M10 10L60 40L120 20")).toBe("M10 10L60 40L120 20");
    expect(parseSignaturePath("M 10,10 L 60.6 40M5 5L7 7")).toBe("M10 10L61 40M5 5L7 7");
    expect(parseSignaturePath("M700 300L-1 5")).toBeNull();
    for (const bad of ["M1 2L3 4<script>", "M1 2L3 4\"onload=alert(1)", "M1 2", "L1 2L3 4", "M1 2Q3 4 5 6", "M1 2l3 4", "", "M1 2L3 4 5", "M1 2L3 4Z"]) {
      expect(parseSignaturePath(bad), bad).toBeNull();
    }
    const round = encodePath([[{ x: 1, y: 2 }, { x: 300, y: 100 }, { x: 599, y: 199 }]]);
    expect(parseSignaturePath(round)).toBe(round);
  });
});
