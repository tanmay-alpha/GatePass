/**
 * Theme toggle.
 *
 * Theme toggle markup contract:
 *
 *   - Three buttons: AUTO / LIGHT / DARK.
 *   - Active state: aria-pressed="true", gold color, baseline underline.
 *   - Persistence: localStorage('ct-theme') ∈ {'auto','light','dark'}.
 *   - Resolution: writes data-theme="light"|"dark" on <html>.
 *     The abstract choice is mirrored to data-theme-choice so
 *     the toggle can render the right button as pressed.
 *
 * The pre-paint inline script in index.html does the first-paint
 * resolution. This module mounts the visible buttons and keeps the
 * dataset in sync after hydration.
 */

type ThemeChoice = 'auto' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ct-theme';

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'auto' || stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    /* localStorage unavailable — fall through to auto */
  }
  return 'auto';
}

function writeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* localStorage unavailable — silently no-op */
  }
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function apply(choice: ThemeChoice): void {
  const resolved = resolve(choice);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeChoice = choice;
}

export function mountThemeToggle(root: HTMLElement | null | undefined): void {
  if (!root) return;

  // Find or create the inner row container.
  let inner = root.querySelector<HTMLElement>('.theme-strip-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'theme-strip-inner';
    root.appendChild(inner);
  }

  // Idempotent: don't double-mount.
  if (inner.dataset.themeToggleMounted === 'true') return;
  inner.dataset.themeToggleMounted = 'true';
  inner.innerHTML = '';

  const choices: ThemeChoice[] = ['auto', 'light', 'dark'];
  const buttons = new Map<ThemeChoice, HTMLButtonElement>();

  for (const choice of choices) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.themeChoice = choice;
    btn.setAttribute('aria-label', `Set theme: ${choice}`);
    btn.textContent = choice.toUpperCase();
    btn.addEventListener('click', () => {
      writeChoice(choice);
      apply(choice);
      sync();
    });
    inner.appendChild(btn);
    buttons.set(choice, btn);
  }

  function sync(): void {
    const choice = readChoice();
    for (const [c, btn] of buttons) {
      btn.setAttribute('aria-pressed', c === choice ? 'true' : 'false');
    }
  }

  // Listen for OS preference changes — only honor them while choice is 'auto'.
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (readChoice() === 'auto') {
        apply('auto');
      }
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
    } else if (typeof (media as MediaQueryList & { addListener?: (l: () => void) => void }).addListener === 'function') {
      (media as MediaQueryList & { addListener: (l: () => void) => void }).addListener(onChange);
    }
  } catch {
    /* matchMedia unavailable — no-op */
  }

  // Make sure html dataset matches the stored choice (the inline pre-paint
  // script already did this on first load; this guards against drift).
  apply(readChoice());
  sync();
}
