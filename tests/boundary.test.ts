import { describe, expect, it } from 'vitest';

import type { BehaviorContext, BehaviorViewport } from '@/core/behavior/behavior';
import { BoundaryBehavior, BOUNDARY_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/boundary';
import { createIdleInteractionState } from '@/core/interaction/types';
import { SceneObject } from '@/core/scene/object';
import type { BoundaryMode, ObjectStatePatch } from '@/core/scene/types';

/**
 * 边界约束（Phase 8）的单测。
 *
 * 这一层存在的理由是"素材被拖出画幅就找不回来"：`boundaryMode` 以前只存不执行。
 * 所以测试的重点不是"钳制公式对不对"，而是**"任何模式下素材都不会彻底丢"**。
 */

const VIEWPORT: BehaviorViewport = { width: 400, height: 800, aspect: 0.5, mirrored: true };

function contextFor(
  object: SceneObject,
  options: { assetAspect?: number; viewport?: BehaviorViewport } = {},
): BehaviorContext {
  return {
    dt: 1 / 60,
    time: 0,
    frame: 1,
    gestures: null,
    interaction: createIdleInteractionState(object.id),
    object,
    assetAspect: options.assetAspect ?? 1,
    scene: {
      size: 1,
      list: () => [object],
      get: (id: string) => (id === object.id ? object : undefined),
    },
    viewport: options.viewport ?? VIEWPORT,
  };
}

/** 造一个素材，跑到稳定，返回最终位置。 */
function settle(
  patch: ObjectStatePatch = {},
  options: { assetAspect?: number; frames?: number; viewport?: BehaviorViewport } = {},
): { object: SceneObject; behavior: BoundaryBehavior; context: BehaviorContext } {
  const behavior = new BoundaryBehavior();
  const object = SceneObject.create('obj-1', { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 }, ...patch });
  const context = contextFor(object, options);
  for (let i = 0; i < (options.frames ?? 1); i += 1) behavior.update(context);
  return { object, behavior, context };
}

describe('BoundaryBehavior 基本契约', () => {
  it('type 与阶段：落在 constrain 阶段（跑在跟随/缩放之后）', () => {
    const behavior = new BoundaryBehavior();
    expect(behavior.type).toBe(BOUNDARY_BEHAVIOR_TYPE);
    expect(behavior.stage).toBe('constrain');
  });

  it('画幅内的合法位置一动不动（约束不能变成"吸到中间"）', () => {
    const { object } = settle({ boundaryMode: 'CENTER_CLAMP', position: { x: 0.2, y: 0.7 } });
    expect(object.state.position).toEqual({ x: 0.2, y: 0.7 });
  });

  it('minVisibleFrac 非法时抛错', () => {
    expect(() => new BoundaryBehavior({ minVisibleFrac: 0 })).toThrow(RangeError);
    expect(() => new BoundaryBehavior({ minVisibleFrac: 1 })).toThrow(RangeError);
  });
});

describe('CENTER_CLAMP（默认）：锚点留在画幅内', () => {
  const positions: [number, number][] = [
    [1.5, 0.5],
    [-0.5, 0.5],
    [0.5, 1.8],
    [0.5, -0.3],
    [2, 2],
    [-2, -2],
  ];

  it.each(positions)('把 (%s, %s) 拖出去也会被钳回画幅内', (x, y) => {
    const { object } = settle({ boundaryMode: 'CENTER_CLAMP', position: { x, y } });
    expect(object.state.position.x).toBeGreaterThanOrEqual(0);
    expect(object.state.position.x).toBeLessThanOrEqual(1);
    expect(object.state.position.y).toBeGreaterThanOrEqual(0);
    expect(object.state.position.y).toBeLessThanOrEqual(1);
  });
});

describe('FULL_VISIBLE：整个素材都要在画幅里', () => {
  it('素材 0.4 宽时，锚点最多到 0.8（右边界内收半个宽）', () => {
    const { object } = settle({ boundaryMode: 'FULL_VISIBLE', position: { x: 0.99, y: 0.5 }, size: { width: 0.4 } });
    expect(object.state.position.x).toBeCloseTo(0.8, 6);
  });

  it('纵向按纹理宽高比收：横图能比竖图更靠边', () => {
    // 场景纵向高度（含画幅宽高比换算）= 宽 / 纹理比 × 场景比；半高就是它的一半
    const sceneHeight = (width: number, assetAspect: number): number =>
      (width / assetAspect) * VIEWPORT.aspect;
    const halfHeight = (width: number, assetAspect: number): number => sceneHeight(width, assetAspect) / 2;

    // 横图（16:9）：纵向很扁，可以更靠边
    const wide = settle(
      { boundaryMode: 'FULL_VISIBLE', position: { x: 0.5, y: 0.99 }, size: { width: 0.2 } },
      { assetAspect: 16 / 9 },
    );
    expect(wide.object.state.position.y).toBeCloseTo(1 - halfHeight(0.2, 16 / 9), 9);

    // 竖图（9:16）：纵向很高，必须离边更远
    const tall = settle(
      { boundaryMode: 'FULL_VISIBLE', position: { x: 0.5, y: 0.99 }, size: { width: 0.2 } },
      { assetAspect: 9 / 16 },
    );
    expect(tall.object.state.position.y).toBeCloseTo(1 - halfHeight(0.2, 9 / 16), 9);

    // 而且横图确实比竖图更靠边
    expect(wide.object.state.position.y).toBeGreaterThan(tall.object.state.position.y);
  });

  it('缩放参与约束：放大 2 倍之后能靠到边上的距离减半', () => {
    const { object } = settle({
      boundaryMode: 'FULL_VISIBLE',
      position: { x: 0.99, y: 0.5 },
      size: { width: 0.2 },
      scale: 2,
    });
    // 宽 0.4 -> 半宽 0.2 -> 最多到 0.8
    expect(object.state.position.x).toBeCloseTo(0.8, 6);
  });

  it('素材比画幅还大时居中（唯一合理的选择）', () => {
    const { object } = settle({ boundaryMode: 'FULL_VISIBLE', position: { x: 0.99, y: 0.5 }, size: { width: 1.4 } });
    expect(object.state.position.x).toBeCloseTo(0.5, 6);
  });

  it('非居中锚点也算对（锚点在左上角时向左收满整个宽度）', () => {
    const { object } = settle({
      boundaryMode: 'FULL_VISIBLE',
      position: { x: 0.99, y: 0.5 },
      size: { width: 0.4 },
      anchor: { x: 0, y: 0.5 },
    });
    // 锚点在左边缘 -> 整个素材在锚点右侧 -> 锚点最多到 0.6
    expect(object.state.position.x).toBeCloseTo(0.6, 6);
  });

  it('旋转 90° 后按旋转后的外框约束（宽高互换）', () => {
    // 宽 0.2、正方形纹理 -> 半宽与半高都是 0.1；转 90° 之后纵向变成 0.2 宽那一维
    const rotated = settle({
      boundaryMode: 'FULL_VISIBLE',
      position: { x: 0.99, y: 0.5 },
      size: { width: 0.2 },
      rotation: Math.PI / 2,
    });
    expect(rotated.object.state.position.x).toBeCloseTo(0.9, 6);
  });
});

describe('ALLOW_OVERFLOW：允许越界，但必须留一块可见', () => {
  it('可以露出一部分，但不会整块跑出去', () => {
    const { object } = settle({ boundaryMode: 'ALLOW_OVERFLOW', position: { x: 1.4, y: 0.5 }, size: { width: 0.4 } });
    // 至少露出 15% 自身宽度（0.06）
    expect(object.state.position.x).toBeLessThanOrEqual(1 - 0.06 + 0.2 + 1e-9);
    expect(object.state.position.x + 0.2).toBeGreaterThan(0.059);
  });

  it('比 CENTER_CLAMP 松（能比它更靠外）', () => {
    const clamped = settle({ boundaryMode: 'CENTER_CLAMP', position: { x: 1.4, y: 0.5 }, size: { width: 0.4 } });
    const overflow = settle({ boundaryMode: 'ALLOW_OVERFLOW', position: { x: 1.4, y: 0.5 }, size: { width: 0.4 } });
    expect(overflow.object.state.position.x).toBeGreaterThanOrEqual(clamped.object.state.position.x);
  });
});

describe('NO_BOUNDARY 与兜底', () => {
  it('NO_BOUNDARY 完全不约束（预留给"扔出画面"这类玩法）', () => {
    const { object } = settle({ boundaryMode: 'NO_BOUNDARY', position: { x: 3, y: -2 } });
    expect(object.state.position).toEqual({ x: 3, y: -2 });
  });

  it('兜底：任何模式下都不会让素材与画幅**完全没有交集**', () => {
    const modes: BoundaryMode[] = ['CENTER_CLAMP', 'CLAMP', 'FULL_VISIBLE', 'ALLOW_OVERFLOW'];
    for (const mode of modes) {
      const { object } = settle({ boundaryMode: mode, position: { x: 12, y: -9 }, size: { width: 0.4 } });
      const { x, y } = object.state.position;
      // 外框（半宽 0.2、半高 0.1，正方形纹理 + aspect 0.5）必须与 [0,1]² 有交集
      const overlapX = Math.min(x + 0.2, 1) - Math.max(x - 0.2, 0);
      const overlapY = Math.min(y + 0.1, 1) - Math.max(y - 0.1, 0);
      expect(overlapX, `${mode} 的横向交集`).toBeGreaterThan(0);
      expect(overlapY, `${mode} 的纵向交集`).toBeGreaterThan(0);
    }
  });

  it('每帧都跑，所以"已经被拖丢"的素材会在下一帧被拉回来（自愈）', () => {
    // 模拟"上一帧被别的东西挪到画面外"：直接写一个越界位置，再跑一帧约束
    const { object, behavior, context } = settle({ boundaryMode: 'CENTER_CLAMP' });
    object.setPosition({ x: 5, y: 5 });
    behavior.update(context);
    expect(object.state.position.x).toBeLessThanOrEqual(1);
    expect(object.state.position.y).toBeLessThanOrEqual(1);
  });
});
