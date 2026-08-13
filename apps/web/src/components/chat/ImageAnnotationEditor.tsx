import {
  ArrowUpRightIcon,
  CheckIcon,
  CropIcon,
  PenLineIcon,
  Redo2Icon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import {
  appendPenPoint,
  annotationVisibleBounds,
  clampRect,
  DEFAULT_IMAGE_ANNOTATION_COLOR,
  defaultAnnotationFontSize,
  defaultAnnotationStrokeWidth,
  drawCropMask,
  drawImageAnnotationMarks,
  flattenImageAnnotation,
  IMAGE_ANNOTATION_COLORS,
  imageAnnotationHasChanges,
  loadImageBitmapFromFile,
  nextPinLabel,
  normalizeRect,
  pointerToImagePoint,
  type ImageAnnotationDocument,
  type ImageAnnotationMark,
  type ImageAnnotationPoint,
  type ImageAnnotationRect,
  type ImageAnnotationStrokeSize,
  type ImageAnnotationTool,
} from "~/lib/imageAnnotation";
import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ImageAnnotationEditorProps {
  image: ComposerImageAttachment;
  onCancel: () => void;
  onApply: (file: File) => Promise<void> | void;
}

interface PendingText {
  position: ImageAnnotationPoint;
  value: string;
}

const TOOLS: ReadonlyArray<{
  id: ImageAnnotationTool;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
}> = [
  { id: "pen", label: "Draw", icon: PenLineIcon },
  { id: "arrow", label: "Arrow", icon: ArrowUpRightIcon },
  { id: "rect", label: "Box", icon: SquareIcon },
  { id: "pin", label: "Number", icon: PinIcon },
  { id: "text", label: "Text", icon: TypeIcon },
  { id: "crop", label: "Crop", icon: CropIcon },
];

function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <text
        x="8"
        y="11"
        textAnchor="middle"
        fill="currentColor"
        fontSize="8"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        1
      </text>
    </svg>
  );
}

function ToolbarButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={props.pressed ? "secondary" : "ghost"}
            disabled={props.disabled}
            aria-label={props.label}
            aria-pressed={props.pressed}
            className={cn(
              "text-white/90 hover:bg-white/10 hover:text-white",
              props.pressed && "bg-white/16 text-white",
            )}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export const ImageAnnotationEditor = memo(function ImageAnnotationEditor({
  image,
  onCancel,
  onApply,
}: ImageAnnotationEditorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{
    tool: ImageAnnotationTool;
    origin: ImageAnnotationPoint;
    markId: string;
    mark: ImageAnnotationMark | null;
    crop: ImageAnnotationRect | null;
  } | null>(null);

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<ImageAnnotationTool>("arrow");
  const [color, setColor] = useState<string>(DEFAULT_IMAGE_ANNOTATION_COLOR);
  const [strokeSize, setStrokeSize] = useState<ImageAnnotationStrokeSize>("m");
  const [documentState, setDocumentState] = useState<ImageAnnotationDocument>({
    marks: [],
    crop: null,
  });
  const [draftMark, setDraftMark] = useState<ImageAnnotationMark | null>(null);
  const [draftCrop, setDraftCrop] = useState<ImageAnnotationRect | null>(null);
  const [pendingText, setPendingText] = useState<PendingText | null>(null);
  const [history, setHistory] = useState<{
    items: ImageAnnotationDocument[];
    index: number;
  }>({ items: [{ marks: [], crop: null }], index: 0 });
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const applyRef = useRef<() => void>(() => {});

  const showFullImage = tool === "crop" || draftCrop !== null;
  const visibleBounds = naturalSize
    ? annotationVisibleBounds(
        naturalSize.width,
        naturalSize.height,
        showFullImage ? null : documentState.crop,
      )
    : null;

  useEffect(() => {
    let cancelled = false;
    const preview = new Image();
    preview.onload = () => {
      if (cancelled) return;
      setNaturalSize({
        width: Math.max(1, preview.naturalWidth),
        height: Math.max(1, preview.naturalHeight),
      });
    };
    preview.onerror = () => {
      if (!cancelled) setError("Could not load this image for markup.");
    };
    preview.src = image.previewUrl;
    return () => {
      cancelled = true;
    };
  }, [image.previewUrl]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const display = useMemo(() => {
    if (!visibleBounds || stageSize.width <= 0 || stageSize.height <= 0) return null;
    const scale = Math.min(
      stageSize.width / visibleBounds.width,
      stageSize.height / visibleBounds.height,
    );
    return {
      width: Math.max(1, Math.round(visibleBounds.width * scale)),
      height: Math.max(1, Math.round(visibleBounds.height * scale)),
      scale,
    };
  }, [stageSize.height, stageSize.width, visibleBounds]);

  const commitDocument = useCallback((next: ImageAnnotationDocument) => {
    setDocumentState(next);
    setHistory((current) => ({
      items: [...current.items.slice(0, current.index + 1), next],
      index: current.index + 1,
    }));
  }, []);

  const undo = useCallback(() => {
    const current = history;
    if (current.index <= 0) return;
    const nextIndex = current.index - 1;
    const previous = current.items[nextIndex];
    if (!previous) return;
    setHistory({ ...current, index: nextIndex });
    setDocumentState(previous);
    setDraftMark(null);
    setDraftCrop(null);
    setPendingText(null);
  }, [history]);

  const redo = useCallback(() => {
    const current = history;
    if (current.index >= current.items.length - 1) return;
    const nextIndex = current.index + 1;
    const next = current.items[nextIndex];
    if (!next) return;
    setHistory({ ...current, index: nextIndex });
    setDocumentState(next);
    setDraftMark(null);
    setDraftCrop(null);
    setPendingText(null);
  }, [history]);

  const strokeWidth = naturalSize
    ? defaultAnnotationStrokeWidth(naturalSize.width, naturalSize.height, strokeSize)
    : 6;
  const fontSize = naturalSize
    ? defaultAnnotationFontSize(naturalSize.width, naturalSize.height, strokeSize)
    : 18;

  const toImagePoint = useCallback(
    (clientX: number, clientY: number): ImageAnnotationPoint | null => {
      const surface = surfaceRef.current;
      if (!surface || !visibleBounds) return null;
      const bounds = surface.getBoundingClientRect();
      const local = pointerToImagePoint(
        clientX,
        clientY,
        bounds,
        visibleBounds.width,
        visibleBounds.height,
      );
      return {
        x: local.x + visibleBounds.x,
        y: local.y + visibleBounds.y,
      };
    },
    [visibleBounds],
  );

  const documentWithPendingText = useCallback((): ImageAnnotationDocument => {
    const text = pendingText?.value.trim() ?? "";
    if (!pendingText || text.length === 0) return documentState;
    return {
      ...documentState,
      marks: [
        ...documentState.marks,
        {
          type: "text",
          id: randomUUID(),
          color,
          fontSize,
          position: pendingText.position,
          text,
        },
      ],
    };
  }, [color, documentState, fontSize, pendingText]);

  const commitPendingText = useCallback(() => {
    const next = documentWithPendingText();
    const hadText = next !== documentState;
    setPendingText(null);
    if (hadText) commitDocument(next);
  }, [commitDocument, documentState, documentWithPendingText]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !naturalSize || isApplying) return;
    if (pendingText) {
      commitPendingText();
      return;
    }
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === "text") {
      setPendingText({ position: point, value: "" });
      return;
    }
    if (tool === "pin") {
      commitDocument({
        ...documentState,
        marks: [
          ...documentState.marks,
          {
            type: "pin",
            id: randomUUID(),
            color,
            position: point,
            label: nextPinLabel(documentState.marks),
          },
        ],
      });
      return;
    }

    const markId = randomUUID();
    if (tool === "pen") {
      const mark: ImageAnnotationMark = {
        type: "pen",
        id: markId,
        color,
        width: strokeWidth,
        points: [point],
      };
      dragRef.current = { tool, origin: point, markId, mark, crop: null };
      setDraftMark(mark);
      return;
    }
    if (tool === "arrow") {
      const mark: ImageAnnotationMark = {
        type: "arrow",
        id: markId,
        color,
        width: strokeWidth,
        from: point,
        to: point,
      };
      dragRef.current = { tool, origin: point, markId, mark, crop: null };
      setDraftMark(mark);
      return;
    }
    if (tool === "rect") {
      const mark: ImageAnnotationMark = {
        type: "rect",
        id: markId,
        color,
        width: strokeWidth,
        rect: normalizeRect(point, point),
      };
      dragRef.current = { tool, origin: point, markId, mark, crop: null };
      setDraftMark(mark);
      return;
    }
    const crop = normalizeRect(point, point);
    dragRef.current = { tool, origin: point, markId, mark: null, crop };
    setDraftCrop(crop);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toImagePoint(event.clientX, event.clientY);
    if (!point) return;
    if (drag.tool === "pen") {
      const current = drag.mark;
      if (!current || current.type !== "pen") return;
      const next: ImageAnnotationMark = {
        ...current,
        points: appendPenPoint(current.points, point),
      };
      drag.mark = next;
      setDraftMark(next);
      return;
    }
    if (drag.tool === "arrow") {
      const next: ImageAnnotationMark = {
        type: "arrow",
        id: drag.markId,
        color,
        width: strokeWidth,
        from: drag.origin,
        to: point,
      };
      drag.mark = next;
      setDraftMark(next);
      return;
    }
    if (drag.tool === "rect") {
      const next: ImageAnnotationMark = {
        type: "rect",
        id: drag.markId,
        color,
        width: strokeWidth,
        rect: normalizeRect(drag.origin, point),
      };
      drag.mark = next;
      setDraftMark(next);
      return;
    }
    const crop = normalizeRect(drag.origin, point);
    drag.crop = crop;
    setDraftCrop(crop);
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !naturalSize) {
      setDraftMark(null);
      setDraftCrop(null);
      return;
    }
    if (drag.tool === "crop") {
      const nextCrop = drag.crop
        ? clampRect(drag.crop, naturalSize.width, naturalSize.height)
        : null;
      setDraftCrop(null);
      if (nextCrop) {
        commitDocument({ ...documentState, crop: nextCrop });
        setTool("arrow");
      }
      return;
    }
    const mark = drag.mark;
    setDraftMark(null);
    if (!mark) return;
    if (mark.type === "arrow") {
      const length = Math.hypot(mark.to.x - mark.from.x, mark.to.y - mark.from.y);
      if (length < 6) return;
    }
    if (mark.type === "rect" && (mark.rect.width < 4 || mark.rect.height < 4)) return;
    if (mark.type === "pen" && mark.points.length === 0) return;
    commitDocument({
      ...documentState,
      marks: [...documentState.marks, mark],
    });
  };

  useLayoutEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !naturalSize || !display || !visibleBounds) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(display.width * dpr);
    canvas.height = Math.round(display.height * dpr);
    context.setTransform(
      (display.width * dpr) / visibleBounds.width,
      0,
      0,
      (display.height * dpr) / visibleBounds.height,
      (-visibleBounds.x * display.width * dpr) / visibleBounds.width,
      (-visibleBounds.y * display.height * dpr) / visibleBounds.height,
    );
    context.clearRect(0, 0, naturalSize.width, naturalSize.height);
    const previewCrop = draftCrop ?? (showFullImage ? documentState.crop : null);
    if (previewCrop) {
      drawCropMask(context, previewCrop, naturalSize.width, naturalSize.height);
    }
    drawImageAnnotationMarks(
      context,
      draftMark ? [...documentState.marks, draftMark] : documentState.marks,
      naturalSize.width,
      naturalSize.height,
    );
  }, [display, documentState, draftCrop, draftMark, naturalSize, showFullImage, visibleBounds]);

  useEffect(() => {
    if (!pendingText) return;
    textInputRef.current?.focus();
  }, [pendingText]);

  const applyMarkup = useCallback(async () => {
    if (isApplying) return;
    const nextDocument = documentWithPendingText();
    setPendingText(null);
    if (!imageAnnotationHasChanges(nextDocument)) {
      onCancel();
      return;
    }
    if (nextDocument !== documentState) {
      commitDocument(nextDocument);
    }
    setIsApplying(true);
    setError(null);
    try {
      const bitmap = await loadImageBitmapFromFile(image.file);
      try {
        const file = await flattenImageAnnotation({
          source: bitmap,
          sourceWidth: bitmap.width,
          sourceHeight: bitmap.height,
          document: nextDocument,
          fileName: image.name,
        });
        await onApply(file);
      } finally {
        bitmap.close();
      }
    } catch {
      setError("Could not save markup onto this image.");
    } finally {
      setIsApplying(false);
    }
  }, [
    commitDocument,
    documentState,
    documentWithPendingText,
    image.file,
    image.name,
    isApplying,
    onApply,
    onCancel,
  ]);

  useEffect(() => {
    applyRef.current = () => {
      void applyMarkup();
    };
  }, [applyMarkup]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (pendingText) {
          setPendingText(null);
          return;
        }
        if (draftMark || draftCrop) {
          dragRef.current = null;
          setDraftMark(null);
          setDraftCrop(null);
          return;
        }
        onCancel();
        return;
      }
      const hasMeta = event.metaKey || event.ctrlKey;
      if (hasMeta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (pendingText || event.key !== "Enter" || isApplying) return;
      event.preventDefault();
      applyRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [draftCrop, draftMark, isApplying, onCancel, pendingText, redo, undo]);

  const textOverlay = useMemo(() => {
    if (!pendingText || !display || !visibleBounds) return null;
    return {
      left: (pendingText.position.x - visibleBounds.x) * display.scale,
      top: (pendingText.position.y - visibleBounds.y) * display.scale,
      fontSize: fontSize * display.scale,
    };
  }, [display, fontSize, pendingText, visibleBounds]);

  const dirty = imageAnnotationHasChanges(documentState);
  const canUndo = history.index > 0;
  const canRedo = history.index < history.items.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Mark up image"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Mark up image</p>
          <p className="truncate text-xs text-white/60">
            Draw on the area that should change. Markup is burned into the image the agent sees.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-white/80 hover:bg-white/10 hover:text-white"
            onClick={onCancel}
            disabled={isApplying}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void applyMarkup()} disabled={isApplying}>
            <CheckIcon />
            {isApplying ? "Saving" : dirty ? "Apply" : "Done"}
          </Button>
        </div>
      </div>

      <div ref={stageRef} className="relative min-h-0 flex-1 px-4 pb-3">
        {display && visibleBounds ? (
          <div className="flex h-full items-center justify-center">
            <div
              ref={surfaceRef}
              className={cn(
                "relative overflow-hidden rounded-lg shadow-2xl",
                tool === "text" ? "cursor-text" : "cursor-crosshair",
              )}
              style={{ width: display.width, height: display.height, touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                draggable={false}
                className="pointer-events-none absolute max-w-none select-none"
                style={{
                  width: naturalSize ? naturalSize.width * display.scale : display.width,
                  height: naturalSize ? naturalSize.height * display.scale : display.height,
                  left: -visibleBounds.x * display.scale,
                  top: -visibleBounds.y * display.scale,
                }}
              />
              <canvas
                ref={overlayRef}
                className="pointer-events-none absolute inset-0 h-full w-full"
              />
              {textOverlay ? (
                <textarea
                  ref={textInputRef}
                  value={pendingText?.value ?? ""}
                  rows={1}
                  aria-label="Annotation text"
                  className="absolute z-10 min-w-24 resize-none bg-transparent p-0 font-bold outline-none"
                  style={{
                    left: textOverlay.left,
                    top: textOverlay.top,
                    fontSize: textOverlay.fontSize,
                    color,
                    textShadow: "0 0 4px rgba(0,0,0,0.85)",
                    caretColor: color,
                  }}
                  onChange={(event) =>
                    setPendingText((current) =>
                      current ? { ...current, value: event.target.value } : current,
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      commitPendingText();
                    }
                  }}
                  onBlur={commitPendingText}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm text-white/60">
            {error ?? "Loading image…"}
          </div>
        )}
      </div>

      <div className="flex justify-center px-4 pb-4">
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1 rounded-full border border-white/10 bg-black/55 px-2 py-1.5 backdrop-blur-md">
          {TOOLS.map((entry) => {
            const Icon = entry.icon;
            return (
              <ToolbarButton
                key={entry.id}
                label={entry.label}
                pressed={tool === entry.id}
                onClick={() => {
                  commitPendingText();
                  setTool(entry.id);
                }}
              >
                <Icon className="size-4" />
              </ToolbarButton>
            );
          })}
          <span className="mx-1 h-5 w-px bg-white/15" />
          {IMAGE_ANNOTATION_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Use ${value} markup`}
              className={cn(
                "size-5 rounded-full border border-black/30",
                color === value && "ring-2 ring-white ring-offset-1 ring-offset-black",
              )}
              style={{ backgroundColor: value }}
              onClick={() => setColor(value)}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-white/15" />
          {(["s", "m", "l"] as const).map((size) => (
            <ToolbarButton
              key={size}
              label={size === "s" ? "Thin" : size === "m" ? "Medium" : "Thick"}
              pressed={strokeSize === size}
              onClick={() => setStrokeSize(size)}
            >
              <span className="text-[10px] font-semibold uppercase">{size}</span>
            </ToolbarButton>
          ))}
          <span className="mx-1 h-5 w-px bg-white/15" />
          <ToolbarButton label="Undo" disabled={!canUndo} onClick={undo}>
            <Undo2Icon className="size-4" />
          </ToolbarButton>
          <ToolbarButton label="Redo" disabled={!canRedo} onClick={redo}>
            <Redo2Icon className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            label="Clear"
            disabled={!dirty}
            onClick={() => commitDocument({ marks: [], crop: null })}
          >
            <XIcon className="size-4" />
          </ToolbarButton>
        </div>
      </div>
      {error ? <p className="px-4 pb-3 text-center text-xs text-red-300">{error}</p> : null}
    </div>
  );
});
