"use client";

import { useCallback, useRef, useState } from "react";

export interface EditSnapshot {
  routeId: string;
  stopSequence: string[];
  date?: string;
}

export interface EditOperation {
  type: "reorder" | "crossMove" | "addStop" | "removeStop" | "changeDate";
  timestamp: number;
  description: string;
  before: EditSnapshot[];
  after: EditSnapshot[];
}

const MAX_HISTORY = 50;

export function useEditHistory() {
  const historyStack = useRef<EditOperation[]>([]);
  const redoStack = useRef<EditOperation[]>([]);
  const [revision, setRevision] = useState(0); // trigger re-renders

  const pushEdit = useCallback((op: EditOperation) => {
    historyStack.current.push(op);
    if (historyStack.current.length > MAX_HISTORY) {
      historyStack.current.shift();
    }
    redoStack.current = []; // clear redo on new edit
    setRevision(r => r + 1);
  }, []);

  const canUndo = historyStack.current.length > 0;
  const canRedo = redoStack.current.length > 0;

  const undo = useCallback((): EditOperation | null => {
    const op = historyStack.current.pop();
    if (!op) return null;
    redoStack.current.push(op);
    setRevision(r => r + 1);
    return op;
  }, []);

  const redo = useCallback((): EditOperation | null => {
    const op = redoStack.current.pop();
    if (!op) return null;
    historyStack.current.push(op);
    setRevision(r => r + 1);
    return op;
  }, []);

  const undoCount = historyStack.current.length;
  const redoCount = redoStack.current.length;

  return { pushEdit, undo, redo, canUndo, canRedo, undoCount, redoCount, revision };
}
