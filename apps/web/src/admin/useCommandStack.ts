import { useRef, useState } from "react";

export interface Command {
  /** Shown as "Undo <label>" / "Redo <label>". */
  label: string;
  run: () => Promise<void> | void;
  undo: () => Promise<void> | void;
}

/** Session-local undo/redo: each step goes through the same API calls a fresh action would, one at a time. */
export function useCommandStack(onError: (err: unknown) => void) {
  const undoStack = useRef<Command[]>([]);
  const redoStack = useRef<Command[]>([]);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // A step that fails stays where it was, so the admin can retry it.
  const step = async (action: () => Promise<void> | void, commit: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      commit();
    } catch (err) {
      onErrorRef.current(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const execute = (cmd: Command) =>
    step(cmd.run, () => {
      undoStack.current.push(cmd);
      redoStack.current = [];
    });

  const undo = async () => {
    const cmd = undoStack.current.at(-1);
    if (!cmd) return;
    await step(cmd.undo, () => redoStack.current.push(undoStack.current.pop()!));
  };

  const redo = async () => {
    const cmd = redoStack.current.at(-1);
    if (!cmd) return;
    await step(cmd.run, () => undoStack.current.push(redoStack.current.pop()!));
  };

  return { execute, undo, redo, busy, undoLabel: undoStack.current.at(-1)?.label ?? null, redoLabel: redoStack.current.at(-1)?.label ?? null };
}
