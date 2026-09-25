/**
 * 主题（Theme）—— **颜色的唯一出处**。
 *
 * 为什么要单独一层：以前品牌色散在 `styles.css`、`ui/controls.ts`、
 * `render/canvas2dRenderer.ts`、`render/debugOverlay.ts` 四个地方，改一次颜色要满仓库找。
 * 更难受的是 canvas 上的颜色（画布底色、骨架、准星）和 DOM 上的**对不上时最难查** ——
 * 两边各写一份十六进制，迟早漂移。
 *
 * 现在的约定：
 *   1. **真实取值只写在 `styles.css` 的 `:root`** —— 那里不依赖 JS 就能生效，首屏不会闪默认色；
 *   2. canvas / JS 要用颜色时，走这里的 `palette()` **读一次**，不手抄常量。
 *
 * 品牌色由用户指定：主色 `#1DDFFF`（青）、底色 `#1A1A1D`（近黑）；其余是派生副色。
 */
export interface Palette {
  /** 页面 / 画布底色（品牌色之二） */
  bg: string;
  fg: string;
  muted: string;
  /** 主色（品牌色之一）：高亮、选中、准星 */
  accent: string;
  /** 主色的低透明度版本，用于填充块 */
  accentSoft: string;
  danger: string;
  warn: string;
  success: string;
  /** 半透明面板底（浮在相机画面上） */
  panel: string;
  /** 不透明的高一层表面（设置面板、结果卡片） */
  surface: string;
  border: string;
}

/**
 * CSS 变量读不到时的兜底。
 * 理论上不该发生，但 canvas 每帧都要用这些值 ——
 * 拿到空字符串会让 `fillStyle` 静默失效（不报错、什么都不画），所以宁可给一份看得见的默认值。
 */
const FALLBACK: Palette = {
  bg: '#1a1a1d',
  fg: '#f2f4f8',
  muted: '#8b94a6',
  accent: '#1ddfff',
  accentSoft: 'rgba(29, 223, 255, 0.16)',
  danger: '#ff3b5c',
  warn: '#ffb020',
  success: '#3ddc97',
  panel: 'rgba(26, 26, 29, 0.86)',
  surface: '#232329',
  border: 'rgba(255, 255, 255, 0.12)',
};

/** Palette 字段 -> CSS 变量名 */
const VARS: Record<keyof Palette, string> = {
  bg: '--bg',
  fg: '--fg',
  muted: '--muted',
  accent: '--accent',
  accentSoft: '--accent-soft',
  danger: '--danger',
  warn: '--warn',
  success: '--success',
  panel: '--panel',
  surface: '--surface',
  border: '--border',
};

let cached: Palette | null = null;

/**
 * 读一次主题色并缓存。
 *
 * 缓存不是为了省事：`getComputedStyle` 会强制样式重算，每帧调一次会明显掉帧。
 * 换肤（改 CSS 变量）之后要调 `resetPaletteCache()`。
 */
export function palette(): Palette {
  if (cached) return cached;
  const result = { ...FALLBACK };
  try {
    const style = getComputedStyle(document.documentElement);
    for (const key of Object.keys(VARS) as (keyof Palette)[]) {
      const value = style.getPropertyValue(VARS[key]).trim();
      if (value) result[key] = value;
    }
  } catch {
    /* 没有 DOM（单测环境）就用兜底值 —— 不该因为读不到样式而崩 */
  }
  cached = result;
  return result;
}

/** 换肤 / 测试用：丢掉缓存，下次重新读。 */
export function resetPaletteCache(): void {
  cached = null;
}

/**
 * 给颜色加透明度，例如 `withAlpha(accent, 0.2)`。
 *
 * canvas 不认 CSS 变量，也不认 `rgb(var(--x) / 0.2)` 这类写法，
 * 所以"主色 + 不同透明度"必须在 JS 里换算。
 * 传进来的如果不是十六进制（已经是 `rgba(...)` 或颜色名）就**原样返回** —— 不猜。
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return color;
  const r = Number.parseInt(full.slice(0, 2), 16);
  const g = Number.parseInt(full.slice(2, 4), 16);
  const b = Number.parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
