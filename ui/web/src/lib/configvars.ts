// Shared config-variable helpers used by the Config page and the per-service
// config editor on ServiceDetail. Keeping the conversion + diff logic here means
// both editors agree on parsing rules and dirty-detection.
import type { TypedValue, VarType } from "./api";

export const VAR_TYPES: VarType[] = ["string", "int", "float", "bool", "json", "bytes"];

export interface Row { id: number; key: string; type: VarType; val: string; }

let rowSeq = 1;
export function nextRowId(): number { return rowSeq++; }

// tvToStr renders a TypedValue's value into an editable string.
export function tvToStr(tv: TypedValue): string {
  if (tv.type === "json") return JSON.stringify(tv.value, null, 2);
  if (tv.value === null || tv.value === undefined) return "";
  return String(tv.value);
}

// strToTypedValue parses an editor string back into a TypedValue (throws on bad input).
export function strToTypedValue(type: VarType, s: string): TypedValue {
  switch (type) {
    case "int": {
      if (!/^-?\d+$/.test(s.trim())) throw new Error("not a whole number");
      return { type, value: parseInt(s, 10) };
    }
    case "float": {
      const f = Number(s);
      if (Number.isNaN(f)) throw new Error("not a number");
      return { type, value: f };
    }
    case "bool":
      return { type, value: s === "true" };
    case "json":
      return { type, value: JSON.parse(s) }; // throws on invalid
    case "bytes":
      return { type, value: s }; // stored/edited as base64 string
    default:
      return { type: "string", value: s };
  }
}

export function varsToRows(vars: Record<string, TypedValue>): Row[] {
  return Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, tv]) => ({ id: nextRowId(), key, type: tv.type, val: tvToStr(tv) }));
}

export function rowsToVars(rows: Row[]): Record<string, TypedValue> {
  const out: Record<string, TypedValue> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = strToTypedValue(r.type, r.val); // may throw
  }
  return out;
}

// rowsSignature is an order-independent fingerprint of the current edits, used
// to decide whether Apply/Reset should be enabled (dirty vs the loaded state).
export function rowsSignature(rows: Row[]): string {
  return JSON.stringify(
    rows
      .map(r => [r.key.trim(), r.type, r.val] as const)
      .filter(([k]) => k)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

export type VarDiffKind = "added" | "changed" | "removed" | "same";

export interface VarDiff {
  key: string;
  kind: VarDiffKind;
  before?: TypedValue;
  after?: TypedValue;
}

// diffVars compares two variable sets key-by-key for the revision diff view.
export function diffVars(
  before: Record<string, TypedValue> | undefined,
  after: Record<string, TypedValue> | undefined,
): VarDiff[] {
  const b = before || {};
  const a = after || {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) => x.localeCompare(y));
  return keys.map(key => {
    const hasB = key in b;
    const hasA = key in a;
    if (hasA && !hasB) return { key, kind: "added", after: a[key] };
    if (!hasA && hasB) return { key, kind: "removed", before: b[key] };
    const same = JSON.stringify(b[key]) === JSON.stringify(a[key]);
    return { key, kind: same ? "same" : "changed", before: b[key], after: a[key] };
  });
}

// truncate keeps inline previews short for big bytes/json values.
export function truncate(s: string, n = 140): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n) + "…" : oneLine;
}
