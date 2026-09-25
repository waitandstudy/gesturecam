import type { Vec2 } from './vec2';

/** 轴对齐矩形。(x, y) 是左上角。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rect(x = 0, y = 0, width = 0, height = 0): Rect {
  return { x, y, width, height };
}

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectContains(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** 四个角，顺序：左上、右上、右下、左下。 */
export function rectCorners(r: Rect): [Vec2, Vec2, Vec2, Vec2] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

/** 包住一组点的最小轴对齐矩形。空数组返回零矩形。 */
export function rectFromPoints(points: readonly Vec2[]): Rect {
  const first = points[0];
  if (!first) return rect();

  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  return rect(minX, minY, maxX - minX, maxY - minY);
}
