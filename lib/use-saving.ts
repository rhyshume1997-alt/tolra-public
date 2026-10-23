"use client";

import { useCallback, useRef, useState } from "react";

/** Guards against double submits: run(fn) ignores calls while one is in flight. */
export function useSaving() {
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setSaving(true);
    try {
      return await fn();
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);
  return { saving, run };
}
