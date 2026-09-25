import { describe, expect, it } from 'vitest';

import { attachBehaviorForMode, registerCoreBehaviors } from '@/core/behavior/behaviors/modes';
import { BehaviorManager } from '@/core/behavior/manager';
import { Viewport } from '@/core/coords/viewport';
import type { FlickEvent } from '@/core/gesture/flick';
import { createIdleGestures, type GestureState } from '@/core/gesture/types';
import { InteractionManager } from '@/core/interaction/interactionManager';
import { Scene } from '@/core/scene/scene';

/**
 * 指弹删除的**端到端**（交互层 + 行为 + Scene）：
 * 弹中 -> 淡出（不透明度真的在降）-> 撤销 或 到期移除。
 *
 * 为什么必须有这一层：删除要跨三个模块（交互层管"算不算数"、行为管"看起来怎么样"、
 * Scene 管"真的移除"）。单测各自绿不代表合起来对 —— 比如行为可能根本没挂上，
 * 素材就会"啪一下消失"而不是淡出。
 */

const DT = 1 / 30;

function createViewport(): Viewport {
  return new Viewport({ width: 1280, height: 720 }, { width: 400, height: 800 }, {
    mirrored: false,
    outputAspect: 0.5,
  });
}

function createScene(options: { deleteGraceSeconds?: number } = {}): { scene: Scene; viewport: Viewport } {
  const behaviors = new BehaviorManager();
  registerCoreBehaviors(behaviors);
  const viewport = createViewport();
  const scene = new Scene({
    viewport,
    behaviors,
    aspectOf: () => 1,
    interactions: new InteractionManager({ deleteGraceSeconds: options.deleteGraceSeconds ?? 1 }),
  });
  return { scene, viewport };
}

function flickAt(position: { x: number; y: number }): FlickEvent {
  return { gesture: 'index-flick', hand: 'right', position, direction: { x: 0, y: -1 }, speed: 2.5, frames: 1, time: 0 };
}

/**
 * 造素材并挂上该模式的行为（app 层就是这么做的）。
 * 不挂行为就没有 `flick-fade`，素材会"啪一下消失"而不是淡出 ——
 * 第一版这个测试就是因为忘了挂行为而失败的，值得留一行说明。
 */
function createObject(
  scene: Scene,
  patch: { position: { x: number; y: number }; size: { width: number }; mode?: 'FIXED' | 'FOLLOW_HAND' },
) {
  const object = scene.objects.create(patch);
  attachBehaviorForMode(scene.behaviors, object);
  return object;
}

function gestures(flicks: readonly FlickEvent[] = []): GestureState {
  return { time: 0, controls: createIdleGestures(), events: [], flicks, snaps: [] };
}

describe('指弹删除端到端（Scene + 行为）', () => {
  it('弹中 -> 不透明度真的在下降（是"淡出"不是"啪一下没了"）', () => {
    const { scene } = createScene({ deleteGraceSeconds: 1 });
    const object = createObject(scene, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    scene.update(DT, gestures([flickAt({ x: 0.5, y: 0.5 })]));
    expect(object.state.opacity).toBeCloseTo(1, 6);

    // 走掉一半淡出期
    for (let i = 0; i < 15; i += 1) scene.update(DT, gestures());
    expect(object.state.opacity).toBeLessThan(1);
    expect(object.state.opacity).toBeGreaterThan(0.2);
    // 关键：淡出期间素材**还在场景里**
    expect(scene.objects.get(object.id)).toBeDefined();
  });

  it('淡出期走完 -> 素材真的从场景里移除', () => {
    const { scene } = createScene({ deleteGraceSeconds: 0.5 });
    const object = createObject(scene, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    scene.update(DT, gestures([flickAt({ x: 0.5, y: 0.5 })]));
    for (let i = 0; i < 20; i += 1) scene.update(DT, gestures());

    expect(scene.objects.get(object.id)).toBeUndefined();
    expect(scene.objects.count).toBe(0);
  });

  it('撤销：淡出期里再捏住它 -> 不透明度还原、素材保留', () => {
    const { scene } = createScene({ deleteGraceSeconds: 1 });
    const object = createObject(scene, {
      position: { x: 0.5, y: 0.5 },
      size: { width: 0.4 },
      mode: 'FOLLOW_HAND',
    });

    scene.update(DT, gestures([flickAt({ x: 0.5, y: 0.5 })]));
    for (let i = 0; i < 10; i += 1) scene.update(DT, gestures());
    expect(object.state.opacity).toBeLessThan(1);

    // 捏住它 = 撤销
    scene.update(DT, {
      time: 0,
      controls: {
        ...createIdleGestures(),
        pinch: { active: true, handedness: 'right', shape: 'pinch', center: { x: 0.5, y: 0.5 }, gap: 0.3 },
        pinches: [{ active: true, handedness: 'right', shape: 'pinch', center: { x: 0.5, y: 0.5 }, gap: 0.3 }],
      },
      events: [
        { type: 'gesture-start', gesture: 'pinch', hand: 'right', position: { x: 0.5, y: 0.5 }, time: 0 },
      ],
      flicks: [],
      snaps: [],
    });

    expect(scene.interactions.deletingCount).toBe(0);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    // 不透明度还原（不然撤销之后图会一直是半透明的，用户以为坏了）
    expect(object.state.opacity).toBeCloseTo(1, 6);

    // 再等很久也不会被删
    for (let i = 0; i < 60; i += 1) scene.update(DT, gestures());
    expect(scene.objects.get(object.id)).toBeDefined();
  });

  it('弹到空白处不动任何素材', () => {
    const { scene } = createScene();
    const object = createObject(scene, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    scene.update(DT, gestures([flickAt({ x: 0.02, y: 0.98 })]));
    for (let i = 0; i < 60; i += 1) scene.update(DT, gestures());

    expect(scene.objects.get(object.id)).toBeDefined();
    expect(object.state.opacity).toBeCloseTo(1, 6);
  });

  /**
   * 这一条钉住第五轮真机标定改掉的那句 `if (grabbing) continue`。
   *
   * 真机上"弹脑瓜"的蓄力姿势（拇指扣住食指尖，gap 0.45）**本来就会被判成捏合**，
   * 所以对着目标图蓄力必然先把它抓起来。原来那句"正抓着东西的那只手弹一下没有意义"
   * 会让删除**永远不触发**；现在的语义是：手里那张就是删除目标。
   */
  it('这只手正抓着东西时，弹掉的是**手里那张**，而不是指尖下最上层', () => {
    const { scene } = createScene({ deleteGraceSeconds: 1 });
    const held = createObject(scene, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });
    const other = createObject(scene, { position: { x: 0.15, y: 0.5 }, size: { width: 0.3 } });

    // 先捏住 held（真机上"扣住蓄力"这一步就会被判成捏合，于是素材被抓起）
    scene.update(DT, {
      time: 0,
      controls: {
        ...createIdleGestures(),
        pinch: { active: true, handedness: 'right', shape: 'pinch', center: { x: 0.5, y: 0.5 }, gap: 0.3 },
        pinches: [{ active: true, handedness: 'right', shape: 'pinch', center: { x: 0.5, y: 0.5 }, gap: 0.3 }],
      },
      events: [
        { type: 'gesture-start', gesture: 'pinch', hand: 'right', position: { x: 0.5, y: 0.5 }, time: 0 },
      ],
      flicks: [],
      snaps: [],
    });
    expect(scene.interactions.get(held.id).grabbed).toBe(true);

    /*
     * 甩开：指尖位置故意报在 other 那边（模拟"手甩的时候已经滑开了"），
     * 但删掉的必须是**手里那张** —— 指尖位置在这条路径上不参与选目标。
     */
    scene.update(DT, gestures([flickAt({ x: 0.15, y: 0.5 })]));

    expect(scene.interactions.get(held.id).deleting.active).toBe(true);
    expect(scene.interactions.get(other.id).deleting.active).toBe(false);
  });

  it('被弹掉的素材不会留在"命中最上层"里（不会出现幽灵目标）', () => {
    const { scene } = createScene({ deleteGraceSeconds: 0.3 });
    createObject(scene, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 } });

    // 先确认能命中
    scene.update(DT, gestures([flickAt({ x: 0.5, y: 0.5 })]));
    expect(scene.interactions.deletingCount).toBe(1);

    for (let i = 0; i < 20; i += 1) scene.update(DT, gestures());
    expect(scene.objects.count).toBe(0);
    // 再往同一个位置弹也不会命中任何东西
    scene.update(DT, gestures([flickAt({ x: 0.5, y: 0.5 })]));
    expect(scene.interactions.deletingCount).toBe(0);
  });
});
