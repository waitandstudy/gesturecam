import { describe, expect, it } from 'vitest';

import {
  mat2dApply,
  mat2dApplyVector,
  mat2dDeterminant,
  mat2dEquals,
  mat2dIdentity,
  mat2dInvert,
  mat2dMultiply,
  mat2dMultiplyAll,
  mat2dRotate,
  mat2dScale,
  mat2dTranslate,
  mat2dTranslateScale,
} from '@/core/coords/mat2d';

describe('Mat2D', () => {
  it('单位矩阵不改变点', () => {
    expect(mat2dApply(mat2dIdentity(), { x: 3, y: -4 })).toEqual({ x: 3, y: -4 });
  });

  it('平移矩阵把点搬到目标位置', () => {
    expect(mat2dApply(mat2dTranslate(10, -5), { x: 1, y: 2 })).toEqual({ x: 11, y: -3 });
  });

  it('方向向量不受平移影响', () => {
    expect(mat2dApplyVector(mat2dTranslate(100, 100), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
  });

  it('组合顺序是"先 B 后 A"', () => {
    const scaleThenTranslate = mat2dMultiply(mat2dTranslate(10, 0), mat2dScale(2, 2));
    expect(mat2dApply(scaleThenTranslate, { x: 3, y: 0 })).toEqual({ x: 16, y: 0 });

    const translateThenScale = mat2dMultiply(mat2dScale(2, 2), mat2dTranslate(10, 0));
    expect(mat2dApply(translateThenScale, { x: 3, y: 0 })).toEqual({ x: 26, y: 0 });
  });

  it('mat2dMultiplyAll 等价于从左到右依次相乘', () => {
    const a = mat2dTranslate(5, 5);
    const b = mat2dRotate(0.3);
    const c = mat2dScale(2, 3);

    expect(mat2dEquals(mat2dMultiplyAll(a, b, c), mat2dMultiply(mat2dMultiply(a, b), c))).toBe(true);
  });

  it('90° 旋转（y 轴向下时视觉上为顺时针）把 +x 转到 +y', () => {
    const rotated = mat2dApply(mat2dRotate(Math.PI / 2), { x: 1, y: 0 });

    expect(rotated.x).toBeCloseTo(0, 12);
    expect(rotated.y).toBeCloseTo(1, 12);
  });

  it('逆矩阵能把点还原', () => {
    const matrix = mat2dMultiplyAll(mat2dTranslate(120, 40), mat2dRotate(0.7), mat2dScale(3, 3));
    const inverse = mat2dInvert(matrix);
    expect(inverse).not.toBeNull();
    if (!inverse) return;

    const point = { x: 17, y: -9 };
    const restored = mat2dApply(inverse, mat2dApply(matrix, point));

    expect(restored.x).toBeCloseTo(point.x, 9);
    expect(restored.y).toBeCloseTo(point.y, 9);
  });

  it('退化矩阵求逆返回 null', () => {
    expect(mat2dInvert(mat2dScale(0, 0))).toBeNull();
    expect(mat2dDeterminant(mat2dScale(1, 0))).toBe(0);
  });

  it('镜像矩阵是 x 轴围绕画布宽度的翻转', () => {
    const mirror = mat2dTranslateScale(400, 0, -1, 1);

    expect(mat2dApply(mirror, { x: 0, y: 0 })).toEqual({ x: 400, y: 0 });
    expect(mat2dApply(mirror, { x: 400, y: 10 })).toEqual({ x: 0, y: 10 });
    expect(mat2dApply(mirror, { x: 100, y: 240 })).toEqual({ x: 300, y: 240 });
    // 镜像行列式为负，可以用来识别"发生了翻转"
    expect(mat2dDeterminant(mirror)).toBe(-1);
  });
});
