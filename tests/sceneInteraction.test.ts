import { describe, expect, it } from 'vitest';

import type { BehaviorContext } from '@/core/behavior/behavior';
import { BehaviorManager } from '@/core/behavior/manager';
import { Viewport } from '@/core/coords/viewport';
import {
  createIdleGestures,
  type ContinuousGestures,
  type GestureEvent,
  type GestureState,
  type PinchState,
} from '@/core/gesture/types';
import type { Vec2 } from '@/core/math/vec2';
import { InteractionManager } from '@/core/interaction/interactionManager';
import { Scene } from '@/core/scene/scene';

const DT = 1 / 60;

function pinch(gap: number, center: Vec2): PinchState {
  return { active: true, handedness: 'right', shape: 'pinch', center, gap };
}

function gestures(
  patch: Partial<ContinuousGestures> = {},
  events: readonly GestureEvent[] = [],
  time = 0,
): GestureState {
  return { time, controls: { ...createIdleGestures(), ...patch }, events, flicks: [], snaps: [] };
}

function event(type: GestureEvent['type'], position: Vec2, time = 0): GestureEvent {
  return { type, gesture: 'pinch', hand: 'right', position, time };
}

/**
 * 组装一个"最小可用"的场景：
 *   - 视口 400×800，源 1280×720，输出画幅 = 画布（cover 裁切生效）
 *   - aspectOf 恒为 1，所以 0.4 宽的素材是 160×160 像素，中心在场景 (0.5, 0.5)
 *   - 只挂一个把素材挪到交互层目标位置的行为。
 *     真正的 FollowHandBehavior（带平滑 / 死区 / 增益）属于 Phase 4，
 *     这里的行为存在的意义只是验证「手势 → 交互 → 行为 → 对象」这条链路是通的。
 */
function createScene(): { scene: Scene; dragCount: () => number } {
  const behaviors = new BehaviorManager();
  let drags = 0;

  behaviors.register('drag-to-target', () => ({
    type: 'drag-to-target',
    stage: 'input' as const,
    update: ({ interaction, object }: BehaviorContext) => {
      if (interaction.grabbed && interaction.targetPosition) {
        object.setPosition(interaction.targetPosition);
        drags += 1;
      }
    },
  }));

  const viewport = new Viewport({ width: 1280, height: 720 }, { width: 400, height: 800 }, {
    mirrored: false,
    outputAspect: 0.5,
  });
  const scene = new Scene({ viewport, behaviors, aspectOf: () => 1 });

  return { scene, dragCount: () => drags };
}

describe('Scene 端到端：手势 → 交互 → 行为 → 对象', () => {
  it('没有手势时素材原地不动', () => {
    const { scene, dragCount } = createScene();
    const object = scene.objects.create({ position: { x: 0.3, y: 0.7 } });
    scene.behaviors.attach(object, 'drag-to-target');

    for (let i = 0; i < 10; i += 1) scene.update(DT, null);

    expect(object.state.position).toEqual({ x: 0.3, y: 0.7 });
    expect(dragCount()).toBe(0);
    expect(scene.interactions.get(object.id).grabbed).toBe(false);
  });

  it('抓住 → 拖动 → 松手：素材按抓取偏移跟随，松手后停住', () => {
    const { scene } = createScene();
    const object = scene.objects.create({ position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    scene.behaviors.attach(object, 'drag-to-target');

    // 第 1 帧：在 (0.45, 0.45) 捏合 —— 落在素材内，且相对中心偏左上 0.05
    scene.update(
      DT,
      gestures({ pinch: pinch(0.1, { x: 0.45, y: 0.45 }) }, [event('gesture-start', { x: 0.45, y: 0.45 })]),
    );

    const afterGrab = scene.interactions.get(object.id);
    expect(afterGrab.grabbed).toBe(true);
    // 交互状态在同一帧就对行为可见（InteractionManager 先于 BehaviorManager 执行）
    expect(afterGrab.transition).toBe('grab');
    // 抓住的第一帧不跳
    expect(object.state.position.x).toBeCloseTo(0.5, 9);
    expect(object.state.position.y).toBeCloseTo(0.5, 9);

    // 第 2 帧：手指右移 0.1、下移 0.05 —— 素材同步移动，保持抓取偏移
    scene.update(DT, gestures({ pinch: pinch(0.1, { x: 0.55, y: 0.5 }) }));
    expect(object.state.position.x).toBeCloseTo(0.6, 9);
    expect(object.state.position.y).toBeCloseTo(0.55, 9);

    // 第 3 帧：松手 —— 目标位置清空，素材停在原地
    scene.update(DT, gestures({}, [event('gesture-end', { x: 0.55, y: 0.5 })]));
    expect(scene.interactions.get(object.id).grabbed).toBe(false);
    expect(scene.interactions.get(object.id).transition).toBe('release');

    scene.update(DT, gestures({}));
    expect(object.state.position.x).toBeCloseTo(0.6, 9);
    expect(object.state.position.y).toBeCloseTo(0.55, 9);
  });

  it('交接给行为的双手倍率可用于改素材 scale（Phase 5 的接口）', () => {
    const behaviors = new BehaviorManager();
    const applied: number[] = [];

    behaviors.register('scale-by-two-hand', () => ({
      type: 'scale-by-two-hand',
      stage: 'input' as const,
      update: ({ interaction, object }: BehaviorContext) => {
        if (!interaction.grabbed || !interaction.twoHand.active) return;
        applied.push(interaction.twoHand.distanceRatio);
        object.setScale(interaction.twoHand.distanceRatio);
      },
    }));

    const viewport = new Viewport({ width: 1280, height: 720 }, { width: 400, height: 800 }, {
      mirrored: false,
      outputAspect: 0.5,
    });
    const scene = new Scene({
      viewport,
      behaviors,
      aspectOf: () => 1,
      interactions: new InteractionManager(),
    });
    const object = scene.objects.create({ position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    scene.behaviors.attach(object, 'scale-by-two-hand');

    scene.update(
      DT,
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [event('gesture-start', { x: 0.5, y: 0.5 })]),
    );

    // 两只手都在捏合、间距 0.4 -> 基准就是 0.4
    scene.update(
      DT,
      gestures({
        pinch: pinch(0.1, { x: 0.5, y: 0.5 }),
        twoHand: { active: true, center: { x: 0.5, y: 0.5 }, distance: 0.4, rawDistance: 0.4 },
      }),
    );
    expect(object.state.scale).toBeCloseTo(1, 9);

    // 两手拉开到 0.8 -> 素材放大 2 倍
    for (let i = 0; i < 20; i += 1) {
      scene.update(
        DT,
        gestures({
          pinch: pinch(0.1, { x: 0.5, y: 0.5 }),
          twoHand: { active: true, center: { x: 0.5, y: 0.5 }, distance: 0.8, rawDistance: 0.8 },
        }),
      );
    }

    expect(object.state.scale).toBeCloseTo(2, 9);
    expect(applied[applied.length - 1]).toBeCloseTo(2, 9);
  });

  it('Scene 把输出画幅的尺寸、比例与镜像状态交给行为', () => {
    const { scene } = createScene();
    scene.viewport.setMirrored(true);

    const seen: string[] = [];
    scene.behaviors.register('probe', () => ({
      type: 'probe',
      stage: 'present' as const,
      update: ({ viewport }: BehaviorContext) => {
        seen.push(`${viewport.width}x${viewport.height}:${viewport.aspect}:${String(viewport.mirrored)}`);
      },
    }));

    const object = scene.objects.create();
    scene.behaviors.attach(object, 'probe');
    scene.update(DT, null);

    expect(seen).toEqual(['400x800:0.5:true']);
  });

  it('切换成片画幅会改变可见区域，但不改素材的场景坐标', () => {
    const { scene } = createScene();
    const object = scene.objects.create({ position: { x: 0.25, y: 0.25 }, size: { width: 0.4 } });
    scene.behaviors.attach(object, 'drag-to-target');

    const before = scene.viewport.visibleSourceRect;
    scene.viewport.setOutputAspect(9 / 16);
    const after = scene.viewport.visibleSourceRect;

    expect(object.state.position).toEqual({ x: 0.25, y: 0.25 });
    // 9:16 比 1:2 更宽，所以可见宽度变大（裁掉的横向内容变少）
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeCloseTo(before.height, 6);
  });

  it('素材被清空后，交互状态也不会残留', () => {
    const { scene } = createScene();
    const object = scene.objects.create({ position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    scene.behaviors.attach(object, 'drag-to-target');

    scene.update(
      DT,
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [event('gesture-start', { x: 0.5, y: 0.5 })]),
    );
    expect(scene.interactions.size).toBe(1);

    scene.objects.clear();
    scene.update(DT, gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }));

    expect(scene.interactions.size).toBe(0);
  });
});
