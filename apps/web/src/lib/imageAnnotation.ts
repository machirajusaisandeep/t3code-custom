/**
 * Markup drawn on a composer image before send. Coordinates are always
 * in source-image pixels so the overlay can scale independently of the
 * flattened file the agent actually receives.
 */

export type ImageAnnotationTool = "pen" | "arrow" | "rect" | "pin" | "text" | "crop";
export type ImageAnnotationStrokeSize = "s" | "m" | "l";

export interface ImageAnnotationPoint {
  x: number;
  y: number;
}

export interface ImageAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const IMAGE_ANNOTATION_COLORS = [
  "#f43f5e",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#38bdf8",
  "#ffffff",
] as const;

export const DEFAULT_IMAGE_ANNOTATION_COLOR = IMAGE_ANNOTATION_COLORS[0];

export interface ImageAnnotationPen {
  type: "pen";
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<ImageAnnotationPoint>;
}

export interface ImageAnnotationArrow {
  type: "arrow";
  id: string;
  color: string;
  width: number;
  from: ImageAnnotationPoint;
  to: ImageAnnotationPoint;
}

export interface ImageAnnotationBox {
  type: "rect";
  id: string;
  color: string;
  width: number;
  rect: ImageAnnotationRect;
}

export interface ImageAnnotationPin {
  type: "pin";
  id: string;
  color: string;
  position: ImageAnnotationPoint;
  label: string;
}

export interface ImageAnnotationText {
  type: "text";
  id: string;
  color: string;
  fontSize: number;
  position: ImageAnnotationPoint;
  text: string;
}

export type ImageAnnotationMark =
  | ImageAnnotationPen
  | ImageAnnotationArrow
  | ImageAnnotationBox
  | ImageAnnotationPin
  | ImageAnnotationText;

export interface ImageAnnotationDocument {
  marks: ReadonlyArray<ImageAnnotationMark>;
  crop: ImageAnnotationRect | null;
}

export const EMPTY_IMAGE_ANNOTATION_DOCUMENT: ImageAnnotationDocument = {
  marks: [],
  crop: null,
};

const STROKE_SIZE_RATIOS: Record<ImageAnnotationStrokeSize, number> = {
  s: 0.0032,
  m: 0.0054,
  l: 0.0086,
};

export function createEmptyImageAnnotationDocument(): ImageAnnotationDocument {
  return EMPTY_IMAGE_ANNOTATION_DOCUMENT;
}

export function imageAnnotationHasChanges(document: ImageAnnotationDocument): boolean {
  return document.marks.length > 0 || document.crop !== null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeRect(
  a: ImageAnnotationPoint,
  b: ImageAnnotationPoint,
): ImageAnnotationRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function clampPoint(
  point: ImageAnnotationPoint,
  width: number,
  height: number,
): ImageAnnotationPoint {
  return {
    x: clamp(point.x, 0, Math.max(0, width)),
    y: clamp(point.y, 0, Math.max(0, height)),
  };
}

export function clampRect(
  rect: ImageAnnotationRect,
  width: number,
  height: number,
): ImageAnnotationRect | null {
  const x = clamp(rect.x, 0, width);
  const y = clamp(rect.y, 0, height);
  const right = clamp(rect.x + rect.width, 0, width);
  const bottom = clamp(rect.y + rect.height, 0, height);
  const nextWidth = right - x;
  const nextHeight = bottom - y;
  if (nextWidth < 4 || nextHeight < 4) {
    return null;
  }
  return { x, y, width: nextWidth, height: nextHeight };
}

export function rectArea(rect: ImageAnnotationRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function defaultAnnotationStrokeWidth(
  imageWidth: number,
  imageHeight: number,
  size: ImageAnnotationStrokeSize = "m",
): number {
  const minEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  return Math.max(3, Math.round(minEdge * STROKE_SIZE_RATIOS[size]));
}

export function defaultAnnotationFontSize(
  imageWidth: number,
  imageHeight: number,
  size: ImageAnnotationStrokeSize = "m",
): number {
  return Math.max(
    14,
    Math.round(defaultAnnotationStrokeWidth(imageWidth, imageHeight, size) * 4.2),
  );
}

export function nextPinLabel(marks: ReadonlyArray<ImageAnnotationMark>): string {
  let next = 1;
  for (const mark of marks) {
    if (mark.type !== "pin") continue;
    const parsed = Number.parseInt(mark.label, 10);
    if (Number.isFinite(parsed) && parsed >= next) {
      next = parsed + 1;
    }
  }
  return String(next);
}

export function pointerToImagePoint(
  clientX: number,
  clientY: number,
  bounds: { left: number; top: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): ImageAnnotationPoint {
  if (bounds.width <= 0 || bounds.height <= 0) {
    return { x: 0, y: 0 };
  }
  return clampPoint(
    {
      x: ((clientX - bounds.left) / bounds.width) * imageWidth,
      y: ((clientY - bounds.top) / bounds.height) * imageHeight,
    },
    imageWidth,
    imageHeight,
  );
}

export function appendPenPoint(
  points: ReadonlyArray<ImageAnnotationPoint>,
  point: ImageAnnotationPoint,
  minDistance = 1.5,
): ReadonlyArray<ImageAnnotationPoint> {
  const last = points[points.length - 1];
  if (!last) return [point];
  const dx = point.x - last.x;
  const dy = point.y - last.y;
  if (dx * dx + dy * dy < minDistance * minDistance) {
    return points;
  }
  return [...points, point];
}

export function annotationVisibleBounds(
  imageWidth: number,
  imageHeight: number,
  crop: ImageAnnotationRect | null,
): ImageAnnotationRect {
  return (
    crop ?? {
      x: 0,
      y: 0,
      width: imageWidth,
      height: imageHeight,
    }
  );
}

function arrowHead(
  from: ImageAnnotationPoint,
  to: ImageAnnotationPoint,
  width: number,
): [ImageAnnotationPoint, ImageAnnotationPoint, ImageAnnotationPoint] | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 4) return null;
  const head = Math.max(10, width * 3.4);
  const ux = dx / length;
  const uy = dy / length;
  const baseX = to.x - ux * head;
  const baseY = to.y - uy * head;
  const px = -uy;
  const py = ux;
  const half = head * 0.42;
  return [
    to,
    { x: baseX + px * half, y: baseY + py * half },
    { x: baseX - px * half, y: baseY - py * half },
  ];
}

function drawHaloedStroke(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string,
  width: number,
  draw: () => void,
): void {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(0, 0, 0, 0.72)";
  context.lineWidth = width + Math.max(2, width * 0.55);
  draw();
  context.strokeStyle = color;
  context.lineWidth = width;
  draw();
  context.restore();
}

function drawPen(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  mark: ImageAnnotationPen,
): void {
  if (mark.points.length === 0) return;
  drawHaloedStroke(context, mark.color, mark.width, () => {
    const first = mark.points[0];
    if (!first) return;
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (let index = 1; index < mark.points.length; index += 1) {
      const point = mark.points[index];
      if (!point) continue;
      context.lineTo(point.x, point.y);
    }
    if (mark.points.length === 1) {
      context.lineTo(first.x + 0.01, first.y);
    }
    context.stroke();
  });
}

function drawArrow(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  mark: ImageAnnotationArrow,
): void {
  const head = arrowHead(mark.from, mark.to, mark.width);
  drawHaloedStroke(context, mark.color, mark.width, () => {
    context.beginPath();
    context.moveTo(mark.from.x, mark.from.y);
    context.lineTo(mark.to.x, mark.to.y);
    context.stroke();
  });
  if (!head) return;
  context.save();
  context.beginPath();
  context.moveTo(head[0].x, head[0].y);
  context.lineTo(head[1].x, head[1].y);
  context.lineTo(head[2].x, head[2].y);
  context.closePath();
  context.fillStyle = "rgba(0, 0, 0, 0.72)";
  context.fill();
  context.beginPath();
  context.moveTo(head[0].x, head[0].y);
  context.lineTo(head[1].x, head[1].y);
  context.lineTo(head[2].x, head[2].y);
  context.closePath();
  context.fillStyle = mark.color;
  context.fill();
  context.restore();
}

function drawBox(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  mark: ImageAnnotationBox,
): void {
  context.save();
  context.fillStyle = withAlpha(mark.color, 0.16);
  context.fillRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height);
  context.restore();
  drawHaloedStroke(context, mark.color, mark.width, () => {
    context.strokeRect(mark.rect.x, mark.rect.y, mark.rect.width, mark.rect.height);
  });
}

function pinRadius(imageWidth: number, imageHeight: number): number {
  return Math.max(12, Math.round(Math.min(imageWidth, imageHeight) * 0.018));
}

function drawPin(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  mark: ImageAnnotationPin,
  imageWidth: number,
  imageHeight: number,
): void {
  const radius = pinRadius(imageWidth, imageHeight);
  context.save();
  context.beginPath();
  context.arc(mark.position.x, mark.position.y, radius + 2, 0, Math.PI * 2);
  context.fillStyle = "rgba(0, 0, 0, 0.72)";
  context.fill();
  context.beginPath();
  context.arc(mark.position.x, mark.position.y, radius, 0, Math.PI * 2);
  context.fillStyle = mark.color;
  context.fill();
  context.fillStyle = mark.color.toLowerCase() === "#ffffff" ? "#111827" : "#ffffff";
  context.font = `700 ${Math.round(radius * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(mark.label, mark.position.x, mark.position.y + 0.5);
  context.restore();
}

function drawText(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  mark: ImageAnnotationText,
): void {
  const lines = mark.text.split("\n");
  context.save();
  context.font = `700 ${mark.fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.miterLimit = 2;
  context.strokeStyle = "rgba(0, 0, 0, 0.78)";
  context.lineWidth = Math.max(3, mark.fontSize * 0.16);
  context.fillStyle = mark.color;
  lines.forEach((line, index) => {
    const y = mark.position.y + index * mark.fontSize * 1.2;
    context.strokeText(line, mark.position.x, y);
    context.fillText(line, mark.position.x, y);
  });
  context.restore();
}

function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith("#") || (color.length !== 7 && color.length !== 4)) {
    return color;
  }
  const hex =
    color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function drawImageAnnotationMarks(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  marks: ReadonlyArray<ImageAnnotationMark>,
  imageWidth: number,
  imageHeight: number,
): void {
  for (const mark of marks) {
    switch (mark.type) {
      case "pen":
        drawPen(context, mark);
        break;
      case "arrow":
        drawArrow(context, mark);
        break;
      case "rect":
        drawBox(context, mark);
        break;
      case "pin":
        drawPin(context, mark, imageWidth, imageHeight);
        break;
      case "text":
        drawText(context, mark);
        break;
    }
  }
}

export function drawCropMask(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  crop: ImageAnnotationRect,
  imageWidth: number,
  imageHeight: number,
): void {
  context.save();
  context.fillStyle = "rgba(0, 0, 0, 0.45)";
  context.beginPath();
  context.rect(0, 0, imageWidth, imageHeight);
  context.rect(crop.x, crop.y, crop.width, crop.height);
  context.fill("evenodd");
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(2, Math.min(imageWidth, imageHeight) * 0.003);
  context.strokeRect(crop.x, crop.y, crop.width, crop.height);
  context.restore();
}

export interface FlattenImageAnnotationOptions {
  source: CanvasImageSource;
  sourceWidth: number;
  sourceHeight: number;
  document: ImageAnnotationDocument;
  fileName: string;
}

function createFlattenCanvas(
  width: number,
  height: number,
): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    return { canvas, context };
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  return { canvas, context };
}

async function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if (typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      throw new Error("Could not encode annotated image.");
    }
    return blob;
  }
  return (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
}

function annotatedFileName(name: string): string {
  const trimmed = name.trim() || "image";
  const dotIndex = trimmed.lastIndexOf(".");
  const base = dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
  const alreadyMarked = /-marked$/i.test(base);
  return `${alreadyMarked ? base : `${base}-marked`}.png`;
}

export async function flattenImageAnnotation(
  options: FlattenImageAnnotationOptions,
): Promise<File> {
  const crop = annotationVisibleBounds(
    options.sourceWidth,
    options.sourceHeight,
    options.document.crop,
  );
  const width = Math.max(1, Math.round(crop.width));
  const height = Math.max(1, Math.round(crop.height));
  const target = createFlattenCanvas(width, height);
  if (!target) {
    throw new Error("Canvas is not available to flatten this markup.");
  }

  target.context.drawImage(
    options.source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    width,
    height,
  );
  target.context.save();
  target.context.translate(-crop.x, -crop.y);
  drawImageAnnotationMarks(
    target.context,
    options.document.marks,
    options.sourceWidth,
    options.sourceHeight,
  );
  target.context.restore();

  const blob = await canvasToBlob(target.canvas);
  return new File([blob], annotatedFileName(options.fileName), { type: "image/png" });
}

export async function loadImageBitmapFromFile(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}
