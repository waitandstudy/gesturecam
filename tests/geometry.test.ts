import { describe, expect, it } from 'vitest';

import { mat2dDeterminant } from '@/core/coords/mat2d';
import { ASPECT_PRESETS, Viewport } from '@/core/coords/viewport';
import type { Vec2 } from '@/core/math/vec2';
import {
  computeObjectPixelSize,
  computeObjectRenderGeometry,
  computeObjectScreenCorners,
  hitTestObject,
} from '@/core/scene/geometry';
import { createObjectState } from '@/core/scene/types';

const SOURCE = { width: 1280, height: 720 };
const WIDE_ASPECT = 16 / 9;

/** 输出画幅 = 画布，断言不受默认 9:16 letterbox 影响 */
function flatViewport(canvas = { width: 400, height: 800 }, mirrored = false): Viewport {
  return new Viewport(SOURCE, canvas, { mirrored, outputAspect: canvas.width / canvas.height });
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('素材几何', () => {
  it('图片永远不会被拉伸：像素宽高比恒等于纹理宽高比', () => {
    for (const canvas of [
      { width: 400, height: 800 },
      { width: 800, height: 400 },
      { width: 500, height: 500 },
    ]) {
      const viewport = flatViewport(canvas);
      const state = createObjectState('obj-1', { size: { width: 0.4 } });
      const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, viewport);

      expect(geometry.localWidth / geometry.localHeight).toBeCloseTo(WIDE_ASPECT, 10);
    }
  });

  it('旋转之后图片依然不变形（四边与对角线长度守恒）', () => {
    const viewport = flatViewport();
    const state = createObjectState('obj-1', { size: { width: 0.3 }, rotation: Math.PI / 5 });
    const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, viewport);
    const [tl, tr, br, bl] = computeObjectScreenCorners(state, WIDE_ASPECT, viewport);

    expect(distance(tl, tr)).toBeCloseTo(geometry.localWidth, 6);
    expect(distance(bl, br)).toBeCloseTo(geometry.localWidth, 6);
    expect(distance(tl, bl)).toBeCloseTo(geometry.localHeight, 6);
    expect(distance(tr, br)).toBeCloseTo(geometry.localHeight, 6);
    expect(distance(tl, br)).toBeCloseTo(Math.hypot(geometry.localWidth, geometry.localHeight), 6);
  });

  it('锚点决定素材相对 position 的摆放（默认以中心定位）', () => {
    const viewport = flatViewport();
    const state = createObjectState('center', { anchor: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, viewport);
    const expected = viewport.sceneToViewport(state.position);

    const localCenter = { x: geometry.localWidth / 2, y: geometry.localHeight / 2 };
    const mapped = {
      x: geometry.matrix.a * localCenter.x + geometry.matrix.c * localCenter.y + geometry.matrix.e,
      y: geometry.matrix.b * localCenter.x + geometry.matrix.d * localCenter.y + geometry.matrix.f,
    };

    expect(mapped.x).toBeCloseTo(expected.x, 9);
    expect(mapped.y).toBeCloseTo(expected.y, 9);
  });

  it('左上角锚点让素材从 position 向右下展开', () => {
    const viewport = flatViewport();
    const state = createObjectState('tl', {
      anchor: { x: 0, y: 0 },
      position: { x: 0.2, y: 0.3 },
      size: { width: 0.4 },
    });
    const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, viewport);

    expect(geometry.matrix.e).toBeCloseTo(0.2 * 400, 9);
    expect(geometry.matrix.f).toBeCloseTo(0.3 * 800, 9);
  });

  it('scale 与 size.width 相乘得到最终渲染宽度', () => {
    const viewport = flatViewport();
    const base = createObjectState('a', { size: { width: 0.25 } });
    const scaled = createObjectState('b', { size: { width: 0.25 }, scale: 2 });

    const baseSize = computeObjectPixelSize(base, WIDE_ASPECT, viewport);
    const scaledSize = computeObjectPixelSize(scaled, WIDE_ASPECT, viewport);

    expect(baseSize.width).toBeCloseTo(0.25 * 400, 9);
    expect(scaledSize.width).toBeCloseTo(baseSize.width * 2, 9);
    expect(scaledSize.height).toBeCloseTo(baseSize.height * 2, 9);
  });

  it('素材尺寸相对输出画幅而不是整个屏幕（letterbox 不改变素材相对大小）', () => {
    const canvas = { width: 400, height: 800 };
    const letterboxed = new Viewport(SOURCE, canvas, { outputAspect: ASPECT_PRESETS.vertical });
    const state = createObjectState('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.5 } });
    const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, letterboxed);

    expect(geometry.localWidth).toBeCloseTo(letterboxed.frame.width * 0.5, 9);
    // 9:16 输出在 1:2 画布上左右铺满、上下留边
    expect(letterboxed.frame.width).toBeCloseTo(canvas.width, 6);
    expect(letterboxed.frame.height).toBeLessThan(canvas.height);
  });

  it('换一个渲染分辨率时素材相对位置与相对大小不变', () => {
    const phone = flatViewport({ width: 400, height: 800 });
    const export1080 = flatViewport({ width: 1080, height: 1920 });
    const state = createObjectState('obj-1', { position: { x: 0.3, y: 0.7 }, size: { width: 0.5 } });

    const a = computeObjectRenderGeometry(state, WIDE_ASPECT, phone);
    const b = computeObjectRenderGeometry(state, WIDE_ASPECT, export1080);

    expect(a.localWidth / phone.frame.width).toBeCloseTo(b.localWidth / export1080.frame.width, 10);
    expect(a.localHeight / a.localWidth).toBeCloseTo(b.localHeight / b.localWidth, 10);
  });

  it('开镜像不会翻转素材内容（回归：反字 bug）', () => {
    const state = createObjectState('obj-1', { position: { x: 0.25, y: 0.5 }, size: { width: 0.3 } });
    const plain = computeObjectRenderGeometry(state, WIDE_ASPECT, flatViewport());
    const mirrored = computeObjectRenderGeometry(state, WIDE_ASPECT, flatViewport(undefined, true));

    expect(mirrored.matrix).toEqual(plain.matrix);
    // 行列式为正 = 没有发生镜像翻转（否则一张写着字的图会变成反字）
    expect(mat2dDeterminant(mirrored.matrix)).toBeGreaterThan(0);
    expect(mat2dDeterminant(plain.matrix)).toBeGreaterThan(0);
  });

  it('命中测试能识别素材内外的点', () => {
    const viewport = flatViewport();
    const state = createObjectState('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    expect(hitTestObject(state, WIDE_ASPECT, viewport, viewport.sceneToViewport({ x: 0.5, y: 0.5 }))).toBe(true);
    expect(hitTestObject(state, WIDE_ASPECT, viewport, viewport.sceneToViewport({ x: 0.95, y: 0.05 }))).toBe(false);
  });

  it('镜像不影响命中判定（素材位置没变）', () => {
    const viewport = flatViewport(undefined, true);
    const state = createObjectState('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    expect(hitTestObject(state, WIDE_ASPECT, viewport, viewport.sceneToViewport({ x: 0.5, y: 0.5 }))).toBe(true);
    expect(hitTestObject(state, WIDE_ASPECT, viewport, viewport.sceneToViewport({ x: 0.95, y: 0.05 }))).toBe(false);
  });

  it('宽容边距让"差一点点"的捏合也能抓到（handy 的 GRAB_HIT_MARGIN_FRAC）', () => {
    const viewport = flatViewport();
    const state = createObjectState('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    // 素材屏幕包围盒 x∈[120,280] y∈[320,480]，取右侧外 10px 的点
    const justOutside = { x: 290, y: 400 };

    expect(hitTestObject(state, WIDE_ASPECT, viewport, justOutside, 0)).toBe(false);
    expect(hitTestObject(state, WIDE_ASPECT, viewport, justOutside, 12)).toBe(true);
    // 边距只在局部空间外扩，超出太多依然不命中
    expect(hitTestObject(state, WIDE_ASPECT, viewport, { x: 340, y: 400 }, 12)).toBe(false);
  });

  it('宽容边距同样支持旋转后的素材', () => {
    const viewport = flatViewport();
    const state = createObjectState('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 }, rotation: Math.PI / 2 });
    const geometry = computeObjectRenderGeometry(state, WIDE_ASPECT, viewport);
    // 旋转 90° 后素材变成高瘦，其上方外侧的点应该靠边距命中
    const above = { x: 200, y: 400 - geometry.localWidth / 2 - 6 };

    expect(hitTestObject(state, WIDE_ASPECT, viewport, above, 0)).toBe(false);
    expect(hitTestObject(state, WIDE_ASPECT, viewport, above, 10)).toBe(true);
  });

  it('纹理宽高比非法时退化为正方形，不产生 NaN', () => {
    const size = computeObjectPixelSize(createObjectState('obj-1'), 0, flatViewport());

    expect(size.width).toBeCloseTo(size.height, 9);
    expect(Number.isNaN(size.width)).toBe(false);
  });
});
