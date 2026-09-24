import { useId, useState, type ReactNode } from "react";
import type { SceneNode } from "@psd-studio/scene-graph";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Box, Folder, Image, Shapes, SlidersHorizontal, Trash2, Type, X } from "lucide-react";
import type { FieldType, TemplateField } from "../lib/types";
import { TYPE_LABEL } from "./LayerTree";

const ALL_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
const ALIGN_ICON = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify } as const;
const ALL_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  TEXT: "Editable text",
  IMAGE: "Replaceable image",
  SMART_OBJECT: "Smart object photo",
  VISIBILITY: "Show / hide toggle",
};

export function NodeTypeIcon({ node, size = 16 }: { node: SceneNode; size?: number }) {
  const Icon = { text: Type, smartObject: Box, pixel: Image, shape: Shapes, group: Folder, adjustment: SlidersHorizontal }[node.type];
  return <Icon size={size} aria-hidden="true" />;
}

function allowedFieldTypesFor(node: SceneNode): FieldType[] {
  switch (node.type) {
    case "text":
      return ["TEXT", "VISIBILITY"];
    case "smartObject":
      return ["IMAGE", "SMART_OBJECT", "VISIBILITY"];
    case "pixel":
    case "shape":
      return ["IMAGE", "VISIBILITY"];
    default:
      return ["VISIBILITY"];
  }
}

function NumberInput({ id, value, onChange, suffix, min }: { id: string; value: number; onChange: (n: number) => void; suffix?: string; min?: number }) {
  return (
    <div className="input-affix">
      <input id={id} type="number" value={value} min={min} onChange={(e) => onChange(Number(e.target.value))} />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

function Switch({ checked, onChange, children, sub }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; sub?: ReactNode }) {
  return (
    <label className="switch-row">
      <span>
        {children}
        {sub && <span className="sub">{sub}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function FieldMappingForm({
  node,
  existingField,
  followsLocks,
  lockedBy,
  onSave,
  onDelete,
  onClose,
  saving,
}: {
  node: SceneNode;
  existingField: TemplateField | undefined;
  /** Until publish, a layer is a field exactly when it's unlocked: creating a field unlocks it, removing one locks it. */
  followsLocks: boolean;
  /** The locked layer (this one or a group it's in) keeping it fixed design. */
  lockedBy: SceneNode | undefined;
  onSave: (fieldType: FieldType, label: string, constraints: Record<string, unknown>) => void;
  onDelete: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  const id = useId();
  const options = allowedFieldTypesFor(node);
  const lockedByGroup = followsLocks && !existingField && lockedBy !== undefined && lockedBy !== node;
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

  const toggleIn = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((x) => x !== value));

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className={`type-icon${existingField ? " mapped" : ""}`}>
          <NodeTypeIcon node={node} size={17} />
        </span>
        <div className="meta">
          <h3 title={node.name}>{node.name}</h3>
          <p className="path" title={node.path}>
            {node.path}
          </p>
          <div className="status-line">
            {existingField ? <span className="badge PUBLISHED">Editable</span> : <span className="badge">{followsLocks && lockedBy ? "Locked" : "Fixed design"}</span>}
            <span className="badge plain">{TYPE_LABEL[node.type]} layer</span>
          </div>
          {followsLocks && !existingField && lockedBy && (
            <p className="control-hint">
              {lockedByGroup
                ? `Inside the locked group “${lockedBy.name}”, so it stays fixed design. Unlock the group to make it editable.`
                : "Locked, so it stays fixed design. Creating a field unlocks it."}
            </p>
          )}
        </div>
        <button type="button" className="icon-btn sm" aria-label="Deselect layer" data-tip="Deselect  Esc" data-tip-align="end" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={submit} className="inspector-form">
        <section className="panel-section">
          <p className="section-title">Field</p>
          <label htmlFor={`${id}-type`}>Field type</label>
          <select id={`${id}-type`} value={fieldType} onChange={(e) => setFieldType(e.target.value as FieldType)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {FIELD_TYPE_LABEL[o]}
              </option>
            ))}
          </select>
          <label htmlFor={`${id}-label`}>Label shown to end users</label>
          <input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} required />
        </section>

        {fieldType === "TEXT" && (
          <section className="panel-section">
            <p className="section-title">Text rules</p>
            <label htmlFor={`${id}-max`}>Max length</label>
            <NumberInput id={`${id}-max`} value={maxLength} onChange={setMaxLength} suffix="chars" min={1} />
            <label htmlFor={`${id}-fonts`}>Allowed fonts</label>
            <input id={`${id}-fonts`} value={allowedFonts} onChange={(e) => setAllowedFonts(e.target.value)} required />
            <p className="control-hint">Comma-separated PostScript names.</p>
            <div className="field-grid">
              <div>
                <label htmlFor={`${id}-minpt`}>Min size</label>
                <NumberInput id={`${id}-minpt`} value={minFontSizePt} onChange={setMinFontSizePt} suffix="pt" />
              </div>
              <div>
                <label htmlFor={`${id}-maxpt`}>Max size</label>
                <NumberInput id={`${id}-maxpt`} value={maxFontSizePt} onChange={setMaxFontSizePt} suffix="pt" />
              </div>
            </div>
            <label id={`${id}-align`}>Allowed alignments</label>
            <div className="chip-group" role="group" aria-labelledby={`${id}-align`}>
              {ALL_ALIGNMENTS.map((a) => {
                const Icon = ALIGN_ICON[a];
                return (
                  <label key={a} className="chip-toggle">
                    <input type="checkbox" checked={alignments.includes(a)} onChange={(e) => setAlignments((prev) => toggleIn(prev, a, e.target.checked))} />
                    <Icon size={14} aria-hidden="true" />
                    {a}
                  </label>
                );
              })}
            </div>
            <div style={{ marginTop: 12 }}>
              <Switch checked={colorLocked} onChange={setColorLocked} sub="End users can't change the text color.">
                Lock color to template
              </Switch>
              <Switch checked={required} onChange={setRequired} sub="Can't be left empty.">
                Required
              </Switch>
            </div>
          </section>
        )}

        {(fieldType === "IMAGE" || fieldType === "SMART_OBJECT") && (
          <section className="panel-section">
            <p className="section-title">Image rules</p>
            <div className="field-grid three">
              <div>
                <label htmlFor={`${id}-aw`}>Ratio W</label>
                <NumberInput id={`${id}-aw`} value={aspectW} onChange={setAspectW} />
              </div>
              <div>
                <label htmlFor={`${id}-ah`}>Ratio H</label>
                <NumberInput id={`${id}-ah`} value={aspectH} onChange={setAspectH} />
              </div>
              <div>
                <label htmlFor={`${id}-tol`}>Tolerance</label>
                <NumberInput id={`${id}-tol`} value={aspectTolerance} onChange={setAspectTolerance} suffix="%" />
              </div>
            </div>
            <div className="field-grid">
              <div>
                <label htmlFor={`${id}-mw`}>Min width</label>
                <NumberInput id={`${id}-mw`} value={minWidthPx} onChange={setMinWidthPx} suffix="px" />
              </div>
              <div>
                <label htmlFor={`${id}-mh`}>Min height</label>
                <NumberInput id={`${id}-mh`} value={minHeightPx} onChange={setMinHeightPx} suffix="px" />
              </div>
            </div>
            <label htmlFor={`${id}-mb`}>Max upload size</label>
            <NumberInput id={`${id}-mb`} value={maxUploadMb} onChange={setMaxUploadMb} suffix="MB" />
            <label id={`${id}-mime`}>Allowed file types</label>
            <div className="chip-group" role="group" aria-labelledby={`${id}-mime`}>
              {ALL_MIME_TYPES.map((m) => (
                <label key={m} className="chip-toggle" style={{ textTransform: "uppercase" }}>
                  <input type="checkbox" checked={mimeTypes.includes(m)} onChange={(e) => setMimeTypes((prev) => toggleIn(prev, m, e.target.checked))} />
                  {m.replace("image/", "")}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <Switch checked={required} onChange={setRequired} sub="End users must supply a photo.">
                Required
              </Switch>
            </div>
          </section>
        )}

        {fieldType === "VISIBILITY" && (
          <section className="panel-section">
            <p className="section-title">Visibility</p>
            <Switch checked={defaultVisible} onChange={setDefaultVisible} sub="End users can toggle it on or off.">
              Visible by default
            </Switch>
          </section>
        )}

        <div className="inspector-actions">
          <button type="submit" className="primary" disabled={saving || lockedByGroup}>
            {existingField ? "Update field" : "Create field"}
          </button>
          {existingField && (
            <button
              type="button"
              className="danger"
              onClick={onDelete}
              disabled={saving}
              aria-label="Remove field"
              data-tip={followsLocks ? "Remove field and lock the layer  Delete" : "Remove field  Delete"}
              data-tip-pos="top"
              data-tip-align="end"
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
