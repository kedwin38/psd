import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import type { FieldValue } from "./fields";

const TYPING_DEBOUNCE_MS = 400;

/** "debounced" for keystrokes, "now" for discrete edits, "local" for values that must not save (e.g. an empty required field). */
export type SaveMode = "debounced" | "now" | "local";

export type SaveState = "saved" | "saving" | "error";

function message(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? (err.errors?.join("; ") || err.title);
  return "Could not save this field.";
}

/**
 * Field values live locally first (the canvas renders them instantly) and save through
 * PUT /projects/:id/fields/:fieldId: one request in flight per field, latest value wins.
 */
export function useFieldValues(projectId: string | undefined) {
  const [values, setValues] = useState<Record<string, FieldValue>>({});
  const [saveErrors, setSaveErrorsState] = useState<Record<string, string>>({});
  const errorsRef = useRef(saveErrors);
  const setSaveErrors = (update: (prev: Record<string, string>) => Record<string, string>) => {
    errorsRef.current = update(errorsRef.current);
    setSaveErrorsState(errorsRef.current);
  };
  const [busy, setBusy] = useState(0);
  const valuesRef = useRef(values);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Map<string, Promise<void>>());
  const dirty = useRef(new Set<string>());

  const save = useCallback(
    (fieldId: string): Promise<void> => {
      const running = inFlight.current.get(fieldId);
      if (running) {
        dirty.current.add(fieldId);
        return running;
      }
      dirty.current.delete(fieldId);
      const value = valuesRef.current[fieldId];
      if (!projectId || !value) return Promise.resolve();
      setBusy((n) => n + 1);
      const request = api
        .put(`/projects/${projectId}/fields/${fieldId}`, value)
        .then(
          () => setSaveErrors(({ [fieldId]: _, ...rest }) => rest),
          (err: unknown) => setSaveErrors((prev) => ({ ...prev, [fieldId]: message(err) })),
        )
        .finally(() => {
          inFlight.current.delete(fieldId);
          setBusy((n) => n - 1);
          if (dirty.current.has(fieldId)) void save(fieldId);
        });
      inFlight.current.set(fieldId, request);
      return request;
    },
    [projectId],
  );

  const set = useCallback(
    (fieldId: string, value: FieldValue, mode: SaveMode) => {
      valuesRef.current = { ...valuesRef.current, [fieldId]: value };
      setValues(valuesRef.current);
      clearTimeout(timers.current.get(fieldId));
      timers.current.delete(fieldId);
      if (mode === "now") void save(fieldId);
      else if (mode === "debounced") {
        const timer = setTimeout(() => {
          timers.current.delete(fieldId);
          void save(fieldId);
        }, TYPING_DEBOUNCE_MS);
        timers.current.set(fieldId, timer);
      }
    },
    [save],
  );

  /** Saves every pending edit now and waits for all of them (e.g. before an export renders the saved state); false if any failed. */
  const flush = useCallback(async (): Promise<boolean> => {
    const pending = [...timers.current.keys()];
    for (const id of pending) clearTimeout(timers.current.get(id));
    timers.current.clear();
    await Promise.all(pending.map(save));
    while (inFlight.current.size > 0) await Promise.all(inFlight.current.values());
    return Object.keys(errorsRef.current).length === 0;
  }, [save]);

  const reset = useCallback((initial: Record<string, FieldValue>) => {
    valuesRef.current = initial;
    setValues(initial);
  }, []);

  const unsaved = busy > 0 || timers.current.size > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  useEffect(() => () => void flush(), [flush]);

  const saveState: SaveState = Object.keys(saveErrors).length > 0 ? "error" : unsaved ? "saving" : "saved";
  return { values, set, flush, reset, saveErrors, saveState };
}
