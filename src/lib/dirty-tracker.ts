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
// Field key requirement: every tracked field MUST have an explicit
// `data-dirty-key`. Fields without it are skipped — this avoids name-collision
// bugs where two inputs share `name="new_stock"` and overwrite each other in
// the initial-values map (caused a false-positive dirty count of 1 on first
// load of /admin/products because the stock-adjust panel inputs collided).

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

function fieldKey(el: TrackedField): string {
  return el.dataset.dirtyKey!;
}

export function createDirtyTracker(opts: DirtyTrackerOptions): DirtyTracker {
  const { root, onChange } = opts;

  const fields: TrackedField[] = Array.from(
    root.querySelectorAll<HTMLElement>(
      "input[data-dirty-key], select[data-dirty-key], textarea[data-dirty-key]",
    ),
  ).filter(isTrackedField);

  const initial = new Map<string, FieldValue>();
  fields.forEach((f) => initial.set(fieldKey(f), readField(f)));

  function compute(): DirtyState {
    const changed = new Map<string, DirtyChange>();
    fields.forEach((f) => {
      const k = fieldKey(f);
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
      fields.forEach((f) => initial.set(fieldKey(f), readField(f)));
      emit();
    },
    discard() {
      fields.forEach((f) => {
        const v = initial.get(fieldKey(f));
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
