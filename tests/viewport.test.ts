import { describe, expect, it } from 'vitest';

import { mat2dApply, mat2dDeterminant } from '@/core/coords/mat2d';
import { ASPECT_PRESETS, computeCoverFit, computeLetterbox, Viewport } from '@/core/coords/viewport';

const SOURCE = { width: 1280, height: 720 };
const CANVAS = { width: 400, height: 800 };
/** 让输出画幅等于画布比例，断言就不受默认 9:16 letterbox 影响 */
const FILL_CANVAS = { mirrored: false, outputAspect: CANVAS.width / CANVAS.height } as const;

describe('computeCoverFit', () => {
  it('横向源图盖住竖向目标框：按宽度放大、上下裁切', () => {
    const fit = computeCoverFit({ width: 1280, height: 720 }, { width: 400, height: 800 });

    expect(fit.scale).toBeCloseTo(800 / 720, 10);
    expect(fit.visible.height).toBeCloseTo(720, 6);
    expect(fit.visible.width).toBeCloseTo(360, 6);
    expect(fit.visible.x).toBeCloseTo(460, 6);
    expect(fit.visible.y).toBeCloseTo(0, 6);
  });

  it('竖向源图盖住横向目标框：按高度放大、左右裁切', () => {
    const fit = computeCoverFit({ width: 720, height: 1280 }, { width: 800, height: 400 });

    expect(fit.scale).toBeCloseTo(800 / 720, 10);
    expect(fit.visible.width).toBeCloseTo(720, 6);
    expect(fit.visible.height).toBeCloseTo(360, 6);
    expect(fit.visible.y).toBeCloseTo(460, 6);
  });

  it('源图与目标框同比例时没有裁切', () => {
    const fit = computeCoverFit({ width: 1920, height: 1080 }, { width: 960, height: 540 });

    expect(fit.scale).toBeCloseTo(0.5, 10);
    expect(fit.visible.x).toBeCloseTo(0, 6);
    expect(fit.visible.y).toBeCloseTo(0, 6);
  });

  it('尺寸非正时安全退化，不抛错也不产生 NaN', () => {
    const fit = computeCoverFit({ width: 0, height: 0 }, { width: 400, height: 800 });

    expect(fit.scale).toBe(1);
    expect(fit.visible.width).toBe(0);
    expect(Number.isNaN(fit.offsetX)).toBe(false);
  });
});

describe('computeLetterbox（成片画幅在屏幕上的摆放）', () => {
  it('画布比画幅更宽 -> 按高度铺满，左右留黑边', () => {
    // 画布 16:9，成片 9:16
    const rect = computeLetterbox({ width: 1600, height: 900 }, ASPECT_PRESETS.vertical);

    expect(rect.height).toBeCloseTo(900, 6);
    expect(rect.width).toBeCloseTo(900 * (9 / 16), 6);
    expect(rect.x).toBeCloseTo((1600 - rect.width) / 2, 6);
    expect(rect.y).toBeCloseTo(0, 6);
  });

  it('画布比画幅更高 -> 按宽度铺满，上下留黑边', () => {
    const rect = computeLetterbox(CANVAS, ASPECT_PRESETS.vertical);

    expect(rect.width).toBeCloseTo(400, 6);
    expect(rect.height).toBeCloseTo(400 / (9 / 16), 6);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y).toBeCloseTo((800 - rect.height) / 2, 6);
  });

  it('比例相同时铺满整块画布', () => {
    const rect = computeLetterbox({ width: 1080, height: 1920 }, ASPECT_PRESETS.vertical);

    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.width).toBeCloseTo(1080, 6);
    expect(rect.height).toBeCloseTo(1920, 6);
  });

  it('非法尺寸返回零矩形而不是 NaN', () => {
    const rect = computeLetterbox({ width: 0, height: 0 }, ASPECT_PRESETS.vertical);

    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('Viewport 场景坐标（输出画幅 = 画布）', () => {
  const viewport = new Viewport(SOURCE, CANVAS, FILL_CANVAS);

  it('场景坐标就是输出画幅的归一化坐标', () => {
    expect(viewport.sceneToViewport({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(viewport.sceneToViewport({ x: 1, y: 1 })).toEqual({ x: 400, y: 800 });
    expect(viewport.sceneToViewport({ x: 0.25, y: 0.5 })).toEqual({ x: 100, y: 400 });
  });

  it('sceneToViewport / viewportToScene 互为逆运算', () => {
    const point = { x: 0.37, y: 0.82 };
    const roundTrip = viewport.viewportToScene(viewport.sceneToViewport(point));

    expect(roundTrip.x).toBeCloseTo(point.x, 12);
    expect(roundTrip.y).toBeCloseTo(point.y, 12);
  });

  it('镜像不参与场景到画布的映射：素材内容永远不翻转', () => {
    const point = { x: 0.25, y: 0.3 };

    expect(viewport.sceneToViewport(point)).toEqual({ x: 100, y: 240 });

    viewport.setMirrored(true);
    expect(viewport.sceneToViewport(point)).toEqual({ x: 100, y: 240 });
    viewport.setMirrored(false);
  });

  it('cameraDrawParams 的裁切区等于可见区，目标尺寸等于输出画幅', () => {
    const params = viewport.cameraDrawParams(SOURCE);

    expect(params.sx).toBeCloseTo(460, 6);
    expect(params.sw).toBeCloseTo(360, 6);
    expect(params.dw).toBe(400);
    expect(params.dh).toBe(800);
  });

  it('尺寸变化后重算适配', () => {
    const local = new Viewport(SOURCE, CANVAS, FILL_CANVAS);
    // 输出画幅是显式设置的比例，不会跟着画布自动变；这里让它一起切到 16:9
    local.setOutputAspect(1280 / 720);
    local.setCanvasSize(1280, 720);

    expect(local.visibleSourceRect.x).toBeCloseTo(0, 6);
    expect(local.visibleSourceRect.width).toBeCloseTo(1280, 6);

    local.setSourceSize(640, 360);
    expect(local.coverScale).toBeCloseTo(2, 10);
  });

  it('尺寸非法时直接抛错而不是静默产生坏数据', () => {
    expect(() => new Viewport({ width: -1, height: 720 }, CANVAS)).toThrow(RangeError);
  });
});

describe('Viewport 输出画幅（letterbox）', () => {
  const viewport = new Viewport(SOURCE, CANVAS, { mirrored: false, outputAspect: ASPECT_PRESETS.vertical });

  it('9:16 成片在 1:2 画布上居中，上下留边', () => {
    const rect = viewport.displayRect;

    expect(rect.width).toBeCloseTo(400, 6);
    expect(rect.height).toBeCloseTo(400 / (9 / 16), 6);
    expect(rect.y).toBeCloseTo((800 - rect.height) / 2, 6);
  });

  it('场景中心仍然落在画布中心', () => {
    const center = viewport.sceneToViewport({ x: 0.5, y: 0.5 });

    expect(center.x).toBeCloseTo(200, 6);
    expect(center.y).toBeCloseTo(400, 6);
  });

  it('场景坐标以输出画幅为基准，不是整个画布', () => {
    const rect = viewport.displayRect;
    const topLeft = viewport.sceneToViewport({ x: 0, y: 0 });

    expect(topLeft).toEqual({ x: rect.x, y: rect.y });
    expect(viewport.sceneToViewport({ x: 1, y: 1 })).toEqual({ x: rect.x + rect.width, y: rect.y + rect.height });
  });

  it('实际输出比例随设置变化，`source` 时跟随摄像头', () => {
    expect(viewport.outputAspect).toBeCloseTo(9 / 16, 10);

    viewport.setOutputAspect(ASPECT_PRESETS.square);
    expect(viewport.outputAspect).toBe(1);
    expect(viewport.displayRect.height).toBeCloseTo(400, 6);

    viewport.setOutputAspect('source');
    expect(viewport.outputAspect).toBeCloseTo(1280 / 720, 10);
  });

  it('竖屏摄像头流裁成 9:16 几乎不损失视野（手机端的理想情况）', () => {
    const portrait = new Viewport({ width: 720, height: 1280 }, { width: 390, height: 844 }, {
      mirrored: true,
      outputAspect: ASPECT_PRESETS.vertical,
    });

    // 源本来就是 9:16，cover 不需要裁掉任何内容
    expect(portrait.coverScale).toBeCloseTo(390 / 720, 6);
    expect(portrait.visibleSourceRect.width).toBeCloseTo(720, 4);
    expect(portrait.visibleSourceRect.height).toBeCloseTo(1280, 4);
  });

  it('exportSize 按输出比例给出成片尺寸', () => {
    const portrait = new Viewport(SOURCE, CANVAS, { outputAspect: ASPECT_PRESETS.vertical });

    expect(portrait.exportSize(1920)).toEqual({ width: 1080, height: 1920 });
  });
});

describe('Viewport 镜像矩阵（只用于摄像头帧）', () => {
  it('未开镜像时是"输出画幅 -> 画布"的平移', () => {
    const viewport = new Viewport(SOURCE, CANVAS, FILL_CANVAS);

    expect(viewport.createCameraMatrix()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it('开镜像时绕输出画幅垂直中线翻转，行列式为 -1', () => {
    const viewport = new Viewport(SOURCE, CANVAS, { ...FILL_CANVAS, mirrored: true });
    const matrix = viewport.createCameraMatrix();

    expect(mat2dApply(matrix, { x: 0, y: 12 })).toEqual({ x: 400, y: 12 });
    expect(mat2dApply(matrix, { x: 400, y: 12 })).toEqual({ x: 0, y: 12 });
    expect(mat2dDeterminant(matrix)).toBe(-1);
  });

  it('镜像与 letterbox 偏移叠加：翻转发生在输出画幅内部', () => {
    const viewport = new Viewport(SOURCE, CANVAS, { mirrored: true, outputAspect: ASPECT_PRESETS.vertical });
    const rect = viewport.displayRect;
    const matrix = viewport.createCameraMatrix();

    expect(mat2dApply(matrix, { x: 0, y: 0 })).toEqual({ x: rect.x + rect.width, y: rect.y });
    expect(mat2dApply(matrix, { x: rect.width, y: 0 })).toEqual({ x: rect.x, y: rect.y });
  });
});

describe('Viewport 手部坐标换算', () => {
  const viewport = new Viewport(SOURCE, CANVAS, FILL_CANVAS);

  it('整帧归一化坐标 -> 场景坐标（只做 cover 裁切）', () => {
    // 可见区域在源图里是 x ∈ [460, 820]（宽 360）
    expect(viewport.sourceNormalizedToScene({ x: 460 / 1280, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(viewport.sourceNormalizedToScene({ x: 820 / 1280, y: 1 })).toEqual({ x: 1, y: 1 });

    const center = viewport.sourceNormalizedToScene({ x: 0.5, y: 0.5 });
    expect(center.x).toBeCloseTo(0.5, 12);
    expect(center.y).toBeCloseTo(0.5, 12);
  });

  it('被 cover 裁掉的区域会落到场景 [0,1] 之外（画面外缓冲的表达方式）', () => {
    expect(viewport.sourceNormalizedToScene({ x: 0.05, y: 0.5 }).x).toBeLessThan(0);
  });

  it('开镜像后手部换算翻转：源帧最左侧的手显示在画面右侧', () => {
    viewport.setMirrored(true);

    expect(viewport.sourceNormalizedToScene({ x: 460 / 1280, y: 0.5 }).x).toBeCloseTo(1, 12);
    expect(viewport.sourceNormalizedToScene({ x: 820 / 1280, y: 0.5 }).x).toBeCloseTo(0, 12);

    viewport.setMirrored(false);
  });

  it('sourceNormalizedToScene 与 sceneToSourceNormalized 互为逆运算（含镜像）', () => {
    for (const mirrored of [false, true]) {
      viewport.setMirrored(mirrored);
      const source = { x: 0.62, y: 0.31 };
      const back = viewport.sceneToSourceNormalized(viewport.sourceNormalizedToScene(source));

      expect(back.x).toBeCloseTo(source.x, 12);
      expect(back.y).toBeCloseTo(source.y, 12);
    }
    viewport.setMirrored(false);
  });
});
