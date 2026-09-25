import type { Vec2 } from '../math/vec2';

/**
 * 2D 仿射变换矩阵。
 *
 * 与 CanvasRenderingContext2D.setTransform(a, b, c, d, e, f) 的参数顺序一致：
 *
 *   | a  c  e |
 *   | b  d  f |
 *   | 0  0  1 |
 *
 *   x' = a * x + c * y + e
 *   y' = b * x + d * y + f
 *
 * 组合约定：mat2dMultiply(A, B) = A · B，即 **先应用 B，再应用 A**。
 * 相当于 canvas 里先 B 的变换后 A 的变换（与 ctx.transform 的调用顺序直觉一致）。
 */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function mat2dIdentity(): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function mat2dFrom(a: number, b: number, c: number, d: number, e: number, f: number): Mat2D {
  return { a, b, c, d, e, f };
}

export function mat2dTranslate(tx: number, ty: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function mat2dScale(sx: number, sy: number): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/**
 * 平移 + 缩放（无旋转）的紧凑形式：x' = sx * x + tx， y' = sy * y + ty。
 * 镜像（x' = canvasW - x）就是 mat2dTranslateScale(canvasW, 0, -1, 1)。
 */
export function mat2dTranslateScale(tx: number, ty: number, sx: number, sy: number): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: tx, f: ty };
}

/** 顺时针旋转（因为 y 轴向下，正值在视觉上表现为顺时针）。 */
export function mat2dRotate(radians: number): Mat2D {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** A · B，先 B 后 A。 */
export function mat2dMultiply(a: Mat2D, b: Mat2D): Mat2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function mat2dMultiplyAll(...mats: readonly Mat2D[]): Mat2D {
  let out = mat2dIdentity();
  for (const m of mats) out = mat2dMultiply(out, m);
  return out;
}

/** 变换一个点（受平移影响）。 */
export function mat2dApply(m: Mat2D, p: Vec2): Vec2 {
  return {
    x: m.a * p.x + m.c * p.y + m.e,
    y: m.b * p.x + m.d * p.y + m.f,
  };
}

/** 变换一个方向向量（不受平移影响）。 */
export function mat2dApplyVector(m: Mat2D, v: Vec2): Vec2 {
  return {
    x: m.a * v.x + m.c * v.y,
    y: m.b * v.x + m.d * v.y,
  };
}

export function mat2dDeterminant(m: Mat2D): number {
  return m.a * m.d - m.b * m.c;
}

/** 逆矩阵；行列式接近 0（降维 / 退化）时返回 null。 */
export function mat2dInvert(m: Mat2D): Mat2D | null {
  const det = mat2dDeterminant(m);
  if (Math.abs(det) < 1e-12) return null;
  const invDet = 1 / det;
  return {
    a: m.d * invDet,
    b: -m.b * invDet,
    c: -m.c * invDet,
    d: m.a * invDet,
    e: (m.c * m.f - m.d * m.e) * invDet,
    f: (m.b * m.e - m.a * m.f) * invDet,
  };
}

export function mat2dEquals(a: Mat2D, b: Mat2D, eps = 1e-9): boolean {
  return (
    Math.abs(a.a - b.a) <= eps &&
    Math.abs(a.b - b.b) <= eps &&
    Math.abs(a.c - b.c) <= eps &&
    Math.abs(a.d - b.d) <= eps &&
    Math.abs(a.e - b.e) <= eps &&
    Math.abs(a.f - b.f) <= eps
  );
}

export function mat2dToArray(m: Mat2D): [number, number, number, number, number, number] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}
