// V5 toast: vanilla JS, no deps, auto-mounts container, screen-reader friendly.
//
// Lifecycle (per /autoplan Phase 2 design decision):
//   - success: auto-dismiss 3s, role="status" aria-live="polite"
//   - error:   sticky until click, role="alert" aria-live="assertive"
//   - warning: auto-dismiss 5s, polite
//   - stack cap 3 — older toasts removed when full
//   - click any toast = dismiss
//
// CSP: middleware allows 'unsafe-inline' + 'self', so module-bundled JS works.
// No external CDN.

export type ToastKind = "success" | "error" | "warning";

interface ToastOptions {
  kind?: ToastKind;
  duration?: number; // ms; pass Infinity for sticky
}

const STACK_CAP = 3;
const DEFAULT_MS: Record<ToastKind, number> = {
  success: 3000,
  warning: 5000,
  error: Infinity,
};

let containerEl: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  const c = document.createElement("div");
  c.id = "v5-toast-container";
  c.className =
    // mobile: bottom-center above sticky bar; desktop: top-right
    "fixed z-40 pointer-events-none flex flex-col gap-2 " +
    "bottom-24 inset-x-4 items-stretch " +
    "sm:bottom-auto sm:top-4 sm:right-4 sm:left-auto sm:inset-x-auto sm:items-end";
  document.body.appendChild(c);
  containerEl = c;
  return c;
}

function colorClasses(kind: ToastKind): string {
  switch (kind) {
    case "success":
      return "bg-emerald-50 border-emerald-300 text-emerald-900";
    case "error":
      return "bg-red-50 border-red-300 text-red-900";
    case "warning":
      return "bg-amber-50 border-amber-300 text-amber-900";
  }
}

export function showToast(message: string, opts: ToastOptions = {}): () => void {
  const kind = opts.kind ?? "success";
  const duration = opts.duration ?? DEFAULT_MS[kind];
  const container = ensureContainer();

  // Cap stack: drop oldest when over limit.
  while (container.children.length >= STACK_CAP) {
    container.firstElementChild?.remove();
  }

  const t = document.createElement("div");
  t.className = `pointer-events-auto rounded-md border px-4 py-3 shadow-md text-sm cursor-pointer transition-opacity duration-150 sm:max-w-sm ${colorClasses(kind)}`;
  t.setAttribute("role", kind === "error" ? "alert" : "status");
  t.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  t.textContent = message;

  let timer: number | null = null;
  const dismiss = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 150);
  };
  t.addEventListener("click", dismiss);
  container.appendChild(t);

  if (Number.isFinite(duration)) {
    timer = setTimeout(dismiss, duration) as unknown as number;
  }
  return dismiss;
}

export function clearToasts(): void {
  if (containerEl) containerEl.innerHTML = "";
}
