import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createDomBuffer, cssFont } from "@psd-studio/canvas-renderer";
import type { TextLayerNode } from "@psd-studio/scene-graph";
import type { View } from "../canvas/viewport";

/** Plain text of a contenteditable, reading the <br>/<div> line breaks browsers may insert as newlines. */
function readPlainText(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node, isLast: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) out += (node as Text).data;
    else if (node.nodeName === "BR") {
      if (!isLast) out += "\n";
    } else {
      if ((node.nodeName === "DIV" || node.nodeName === "P") && out.length > 0 && !out.endsWith("\n")) out += "\n";
      node.childNodes.forEach((child, i) => walk(child, isLast && i === node.childNodes.length - 1));
    }
  };
  el.childNodes.forEach((child, i) => walk(child, i === el.childNodes.length - 1));
  return out;
}

/**
 * In-place editor for a text field. Its own glyphs are transparent: what you see is the canvas
 * rendering the live value through the same compositor as the export, and this element only
 * supplies the caret, selection and IME, laid out with the renderer's font, size, leading and wrap width.
 */
export function TextEditOverlay({
  node,
  label,
  view,
  text,
  maxLength,
  status,
  onChange,
  onClose,
}: {
  node: TextLayerNode;
  label: string;
  view: View;
  text: string;
  maxLength: number | null;
  status: { message: string; tone: "ok" | "warn" | "error" };
  onChange: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [limitHit, setLimitHit] = useState(false);
  const style = node.runs[0]!;
  const sizePx = style.fontSize * view.zoom;
  const font = cssFont(style, sizePx);
  const lineHeight = (style.leadingPt ?? style.fontSize * 1.2) * view.zoom;
  const { left, top, right, bottom } = node.bounds;
  const width = (right - left || style.fontSize * 20) * view.zoom;

  // The canvas puts the first baseline one font size below the box top; CSS puts it half-leading plus ascent down.
  const cssBaseline = useMemo(() => {
    const ctx = createDomBuffer(1, 1);
    ctx.font = font;
    const m = ctx.measureText("Hg");
    return (lineHeight - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  }, [font, lineHeight]);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.textContent = text;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    // Mount-only: afterwards the element owns its content and reports it through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current!;
    if (readPlainText(el) !== text) el.textContent = text;
  }, [text]);

  useEffect(() => {
    const el = ref.current!;
    const onBeforeInput = (e: InputEvent) => {
      if (maxLength === null || !e.inputType.startsWith("insert") || e.isComposing) return;
      const incoming = e.data ?? e.dataTransfer?.getData("text/plain") ?? (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak" ? "\n" : "");
      const replaced = getSelection()?.toString().length ?? 0;
      if (readPlainText(el).length - replaced + incoming.length > maxLength) {
        e.preventDefault();
        setLimitHit(true);
      }
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => el.removeEventListener("beforeinput", onBeforeInput);
  }, [maxLength]);

  const textStyle: CSSProperties = {
    left: left * view.zoom + view.x,
    top: top * view.zoom + view.y + sizePx - cssBaseline,
    width,
    minHeight: Math.max(lineHeight, (bottom - top) * view.zoom),
    font,
    lineHeight: `${lineHeight}px`,
    letterSpacing: `${((style.tracking ?? 0) / 1000) * sizePx}px`,
    textAlign: node.alignment === "justify" ? "left" : node.alignment,
  };
  const count = maxLength === null ? null : `${text.length}/${maxLength}`;
  const shown = limitHit && maxLength !== null && text.length >= maxLength ? { message: `${maxLength}-character limit reached`, tone: "error" as const } : status;

  return (
    <>
      <div
        ref={ref}
        className="text-edit-overlay"
        style={textStyle}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={`Edit ${label} on canvas`}
        spellCheck
        onInput={(e) => {
          setLimitHit(false);
          onChange(readPlainText(e.currentTarget));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onBlur={onClose}
      />
      <div className={`text-edit-meta ${shown.tone}`} role="status" aria-label="Text field status">
        {count && <span className="count">{count}</span>}
        {shown.message}
      </div>
    </>
  );
}
