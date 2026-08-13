import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appendPenPoint,
  clampRect,
  defaultAnnotationFontSize,
  defaultAnnotationStrokeWidth,
  flattenImageAnnotation,
  imageAnnotationHasChanges,
  nextPinLabel,
  normalizeRect,
  pointerToImagePoint,
} from "./imageAnnotation";

describe("imageAnnotation geometry", () => {
  it("normalizes a dragged rectangle regardless of direction", () => {
    expect(normalizeRect({ x: 40, y: 10 }, { x: 8, y: 30 })).toEqual({
      x: 8,
      y: 10,
      width: 32,
      height: 20,
    });
  });

  it("rejects crop rectangles that are too small after clamping", () => {
    expect(clampRect({ x: 0, y: 0, width: 2, height: 80 }, 100, 100)).toBeNull();
    expect(clampRect({ x: 90, y: 90, width: 40, height: 40 }, 100, 100)).toEqual({
      x: 90,
      y: 90,
      width: 10,
      height: 10,
    });
  });

  it("maps pointer coordinates into image pixels", () => {
    expect(
      pointerToImagePoint(125, 60, { left: 100, top: 50, width: 200, height: 100 }, 800, 400),
    ).toEqual({ x: 100, y: 40 });
  });

  it("clamps pointer samples that leave the image", () => {
    expect(
      pointerToImagePoint(-20, 400, { left: 0, top: 0, width: 100, height: 100 }, 200, 200),
    ).toEqual({ x: 0, y: 200 });
  });

  it("skips pen samples that are too close together", () => {
    const first = appendPenPoint([], { x: 0, y: 0 });
    const skipped = appendPenPoint(first, { x: 0.4, y: 0.4 });
    const added = appendPenPoint(first, { x: 4, y: 3 });
    expect(skipped).toHaveLength(1);
    expect(added).toHaveLength(2);
  });
});

describe("imageAnnotation marks", () => {
  it("reports changes from either marks or a crop", () => {
    expect(imageAnnotationHasChanges({ marks: [], crop: null })).toBe(false);
    expect(
      imageAnnotationHasChanges({
        marks: [],
        crop: { x: 1, y: 1, width: 20, height: 20 },
      }),
    ).toBe(true);
    expect(
      imageAnnotationHasChanges({
        marks: [
          {
            type: "pin",
            id: "p1",
            color: "#f43f5e",
            position: { x: 4, y: 4 },
            label: "1",
          },
        ],
        crop: null,
      }),
    ).toBe(true);
  });

  it("increments pin labels from existing numeric pins", () => {
    expect(
      nextPinLabel([
        {
          type: "pin",
          id: "a",
          color: "#f43f5e",
          position: { x: 1, y: 1 },
          label: "2",
        },
        {
          type: "text",
          id: "b",
          color: "#fff",
          fontSize: 16,
          position: { x: 2, y: 2 },
          text: "3",
        },
      ]),
    ).toBe("3");
  });

  it("keeps stroke and type large enough to read on a large image", () => {
    expect(defaultAnnotationStrokeWidth(2400, 1800, "m")).toBeGreaterThanOrEqual(8);
    expect(defaultAnnotationFontSize(2400, 1800, "m")).toBeGreaterThanOrEqual(28);
  });
});

describe("flattenImageAnnotation", () => {
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.OffscreenCanvas = originalOffscreenCanvas;
  });

  it("burns marks into a PNG named as marked", async () => {
    const drawImage = vi.fn();
    const convertToBlob = vi.fn(
      async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return {
            drawImage,
            save: vi.fn(),
            restore: vi.fn(),
            translate: vi.fn(),
            beginPath: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            closePath: vi.fn(),
            stroke: vi.fn(),
            fill: vi.fn(),
            fillRect: vi.fn(),
            strokeRect: vi.fn(),
            fillText: vi.fn(),
            strokeText: vi.fn(),
            arc: vi.fn(),
          };
        }
        convertToBlob = convertToBlob;
      },
    );

    const file = await flattenImageAnnotation({
      source: {} as CanvasImageSource,
      sourceWidth: 400,
      sourceHeight: 300,
      fileName: "clients.png",
      document: {
        crop: { x: 10, y: 20, width: 80, height: 60 },
        marks: [
          {
            type: "arrow",
            id: "a1",
            color: "#f43f5e",
            width: 6,
            from: { x: 12, y: 24 },
            to: { x: 40, y: 50 },
          },
        ],
      },
    });

    expect(drawImage).toHaveBeenCalled();
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("clients-marked.png");
  });
});
