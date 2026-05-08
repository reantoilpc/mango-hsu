// V5 dirty tracker: track field-level changes within a region marked
// `[data-dirty-track]`, emit dirty count, support discard / lock / clear.
//
// Contract (per /autoplan design decisions):
//   - Unit: per-field. revert-to-clean clears dirty (typing then changing back
//     to original is NOT a change).
//   - getDirty(): { count, changed: Map<key, {before, after}> }
//   - clear(): mark current values as the new initial baseline (after save success)
//   - discard(): reset all fields to initial (used by sticky bar 「捨棄」)
//   - lock() / unlock(): disable / enable all tracked fields (used during save / status events)
//   - destroy(): remove listeners
//
// Field key resolution (in order): data-dirty-key, name, id.

export type FieldValue = string | number | boolean;

export interface DirtyChange {
  before: FieldValue;
  after: FieldValue;
}

export interface DirtyState {
  count: number;
  changed: Map<string, DirtyChange>;
}

export interface DirtyTrackerOptions {
  root: HTMLElement;
  onChange?: (state: DirtyState) => void;
}

export interface DirtyTracker {
  getDirty(): DirtyState;
  clear(): void;
  discard(): void;
  lock(): void;
  unlock(): void;
  destroy(): void;
}

type TrackedField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function isTrackedField(el: Element): el is TrackedField {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

function readField(el: TrackedField): FieldValue {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") return el.checked;
    if (el.type === "number") return el.value === "" ? "" : Number(el.value);
    return el.value;
  }
  return el.value;
}

function writeField(el: TrackedField, val: FieldValue): void {
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.checked = Boolean(val);
    return;
  }
  el.value = String(val);
}

function fieldKey(el: TrackedField, idx: number): string {
  return el.dataset.dirtyKey ?? el.name ?? el.id ?? `__f${idx}`;
}

export function createDirtyTracker(opts: DirtyTrackerOptions): DirtyTracker {
  const { root, onChange } = opts;

  const fields: TrackedField[] = Array.from(
    root.querySelectorAll<HTMLElement>(
      "[data-dirty-track] input, [data-dirty-track] select, [data-dirty-track] textarea",
    ),
  ).filter(isTrackedField);

  const initial = new Map<string, FieldValue>();
  fields.forEach((f, i) => initial.set(fieldKey(f, i), readField(f)));

  function compute(): DirtyState {
    const changed = new Map<string, DirtyChange>();
    fields.forEach((f, i) => {
      const k = fieldKey(f, i);
      const before = initial.get(k);
      const after = readField(f);
      if (before !== after) {
        changed.set(k, { before: before as FieldValue, after });
      }
    });
    return { count: changed.size, changed };
  }

  function emit(): void {
    onChange?.(compute());
  }

  const handler = (): void => emit();
  fields.forEach((f) => {
    f.addEventListener("input", handler);
    f.addEventListener("change", handler);
  });

  return {
    getDirty: compute,
    clear() {
      fields.forEach((f, i) => initial.set(fieldKey(f, i), readField(f)));
      emit();
    },
    discard() {
      fields.forEach((f, i) => {
        const v = initial.get(fieldKey(f, i));
        if (v !== undefined) writeField(f, v);
      });
      emit();
    },
    lock() {
      fields.forEach((f) => {
        f.disabled = true;
      });
    },
    unlock() {
      fields.forEach((f) => {
        f.disabled = false;
      });
    },
    destroy() {
      fields.forEach((f) => {
        f.removeEventListener("input", handler);
        f.removeEventListener("change", handler);
      });
    },
  };
}
