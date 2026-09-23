import { useState } from "react";
import type { SceneNode } from "@psd-studio/scene-graph";
import type { FieldType, TemplateField } from "../lib/types";

const ALL_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
const ALL_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

function allowedFieldTypesFor(node: SceneNode): FieldType[] {
  switch (node.type) {
    case "text":
      return ["TEXT", "VISIBILITY"];
    case "smartObject":
      return ["SMART_OBJECT", "VISIBILITY"];
    case "pixel":
    case "shape":
      return ["IMAGE", "VISIBILITY"];
    default:
      return ["VISIBILITY"];
  }
}

export function FieldMappingForm({
  node,
  existingField,
  onSave,
  onDelete,
  saving,
}: {
  node: SceneNode;
  existingField: TemplateField | undefined;
  onSave: (fieldType: FieldType, label: string, constraints: Record<string, unknown>) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const options = allowedFieldTypesFor(node);
  const [fieldType, setFieldType] = useState<FieldType>((existingField?.fieldType as FieldType) ?? options[0]!);
  const [label, setLabel] = useState(existingField?.label ?? node.name);

  const c = existingField?.constraints as Record<string, unknown> | undefined;

  const [maxLength, setMaxLength] = useState(Number(c?.maxLength ?? 60));
  const [allowedFonts, setAllowedFonts] = useState(
    node.type === "text" ? Array.from(new Set(node.runs.map((r) => r.fontName))).join(", ") : "",
  );
  const [minFontSizePt, setMinFontSizePt] = useState(Number(c?.minFontSizePt ?? 8));
  const [maxFontSizePt, setMaxFontSizePt] = useState(Number(c?.maxFontSizePt ?? 72));
  const [colorLocked, setColorLocked] = useState(Boolean(c?.colorLocked ?? true));
  const [alignments, setAlignments] = useState<string[]>((c?.allowedAlignments as string[]) ?? ["left"]);
  const [required, setRequired] = useState(Boolean(c?.required ?? true));

  const [aspectW, setAspectW] = useState(Number(c?.aspectRatioW ?? 1));
  const [aspectH, setAspectH] = useState(Number(c?.aspectRatioH ?? 1));
  const [aspectTolerance, setAspectTolerance] = useState(Number(c?.aspectTolerancePct ?? 10));
  const [minWidthPx, setMinWidthPx] = useState(Number(c?.minWidthPx ?? 200));
  const [minHeightPx, setMinHeightPx] = useState(Number(c?.minHeightPx ?? 200));
  const [maxUploadMb, setMaxUploadMb] = useState(Number(c?.maxUploadBytes ?? 10_000_000) / 1_000_000);
  const [mimeTypes, setMimeTypes] = useState<string[]>((c?.allowedMimeTypes as string[]) ?? ["image/png", "image/jpeg"]);

  const [defaultVisible, setDefaultVisible] = useState(Boolean(c?.defaultVisible ?? node.visible));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let constraints: Record<string, unknown>;
    if (fieldType === "TEXT") {
      constraints = {
        kind: "text",
        maxLength,
        allowedFonts: allowedFonts.split(",").map((f) => f.trim()).filter(Boolean),
        minFontSizePt,
        maxFontSizePt,
        colorLocked,
        allowedAlignments: alignments,
        required,
      };
    } else if (fieldType === "IMAGE" || fieldType === "SMART_OBJECT") {
      constraints = {
        kind: "image",
        aspectRatioW: aspectW,
        aspectRatioH: aspectH,
        aspectTolerancePct: aspectTolerance,
        minWidthPx,
        minHeightPx,
        maxUploadBytes: Math.round(maxUploadMb * 1_000_000),
        allowedMimeTypes: mimeTypes,
        required,
      };
    } else {
      constraints = { kind: "visibility", defaultVisible };
    }
    onSave(fieldType, label, constraints);
  };

  return (
    <form onSubmit={submit} className="stack">
      <h3>{node.name}</h3>
      <p className="hint">{node.path}</p>

      <label>Field type</label>
      <select value={fieldType} onChange={(e) => setFieldType(e.target.value as FieldType)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>

      <label>Label (shown to end users)</label>
      <input value={label} onChange={(e) => setLabel(e.target.value)} required />

      {fieldType === "TEXT" && (
        <>
          <label>Max length</label>
          <input type="number" value={maxLength} onChange={(e) => setMaxLength(Number(e.target.value))} min={1} />
          <label>Allowed fonts (comma-separated)</label>
          <input value={allowedFonts} onChange={(e) => setAllowedFonts(e.target.value)} required />
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Min size (pt)</label>
              <input type="number" value={minFontSizePt} onChange={(e) => setMinFontSizePt(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Max size (pt)</label>
              <input type="number" value={maxFontSizePt} onChange={(e) => setMaxFontSizePt(Number(e.target.value))} />
            </div>
          </div>
          <label>Allowed alignments</label>
          <div className="row">
            {ALL_ALIGNMENTS.map((a) => (
              <label key={a} className="row" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={alignments.includes(a)}
                  onChange={(e) =>
                    setAlignments((prev) => (e.target.checked ? [...prev, a] : prev.filter((x) => x !== a)))
                  }
                />
                {a}
              </label>
            ))}
          </div>
          <label className="row">
            <input type="checkbox" checked={colorLocked} onChange={(e) => setColorLocked(e.target.checked)} /> Lock color to
            template default
          </label>
          <label className="row">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
          </label>
        </>
      )}

      {(fieldType === "IMAGE" || fieldType === "SMART_OBJECT") && (
        <>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Aspect ratio W</label>
              <input type="number" value={aspectW} onChange={(e) => setAspectW(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Aspect ratio H</label>
              <input type="number" value={aspectH} onChange={(e) => setAspectH(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Tolerance %</label>
              <input type="number" value={aspectTolerance} onChange={(e) => setAspectTolerance(Number(e.target.value))} />
            </div>
          </div>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label>Min width (px)</label>
              <input type="number" value={minWidthPx} onChange={(e) => setMinWidthPx(Number(e.target.value))} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Min height (px)</label>
              <input type="number" value={minHeightPx} onChange={(e) => setMinHeightPx(Number(e.target.value))} />
            </div>
          </div>
          <label>Max upload size (MB)</label>
          <input type="number" value={maxUploadMb} onChange={(e) => setMaxUploadMb(Number(e.target.value))} />
          <label>Allowed file types</label>
          <div className="row">
            {ALL_MIME_TYPES.map((m) => (
              <label key={m} className="row" style={{ fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={mimeTypes.includes(m)}
                  onChange={(e) => setMimeTypes((prev) => (e.target.checked ? [...prev, m] : prev.filter((x) => x !== m)))}
                />
                {m.replace("image/", "")}
              </label>
            ))}
          </div>
          <label className="row">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
          </label>
        </>
      )}

      {fieldType === "VISIBILITY" && (
        <label className="row">
          <input type="checkbox" checked={defaultVisible} onChange={(e) => setDefaultVisible(e.target.checked)} /> Visible by
          default
        </label>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button type="submit" className="primary" disabled={saving}>
          {existingField ? "Update field" : "Create field"}
        </button>
        {existingField && (
          <button type="button" className="danger" onClick={onDelete} disabled={saving}>
            Remove
          </button>
        )}
      </div>
    </form>
  );
}
