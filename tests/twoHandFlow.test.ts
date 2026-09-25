import { describe, expect, it } from 'vitest';

import { registerCoreBehaviors } from '@/core/behavior/behaviors/modes';
import { BehaviorManager } from '@/core/behavior/manager';
import { Viewport } from '@/core/coords/viewport';
import { GestureManager } from '@/core/gesture/gestureManager';
import type { RawHand } from '@/core/hand/handState';
import { InteractionManager } from '@/core/interaction/interactionManager';
import { Scene } from '@/core/scene/scene';
import { makeHand } from './helpers/syntheticHand';
import { FIST_HAND, OPEN_HAND, PINCH_HAND, type SyntheticHandOptions } from './helpers/syntheticHand';

/**
 * ============================================================================
 * 手势文法的端到端回归（合成手 → GestureManager → InteractionManager → 行为 → 素材）
 * ============================================================================
 *
 * 为什么要有这个文件：单手缩放的单测当时全绿，但真机上就是"颤、不好把控"。
 * 因为真正的数值来自**层与层之间**（平滑后的关键点、镜像、cover 裁切、
 * 素材宽度是画幅比例而不是像素），单测里用理想值喂进去根本复现不了。
 * 所以这里刻意用"和真机同构"的视口（16:9 摄像头 + 9:16 输出画幅 + 前置镜像），
 * 而且**每一层都用真实实现**。
 *
 * 这里钉住的是真机上出过的现象：
 *   1. 第二只手一捏上，图片掉 / 跳 / 自己变大（槽位对调 + 基准取在滤波追赶途中）
 *   2. 握拳急停之后必须能重新抓（重新武装），而且**不能**被无关的手卡死
 */

const DT = 1 / 30;

function createViewport(): Viewport {
  // 与真机一致：16:9 摄像头 + 9:16 输出画幅 + 前置镜像。
  // cover 裁切后横向只剩约 32% 的画面，所以两手相距 0.4 时已经在可视区之外 ——
  // 这正是"两手间距信噪比高"的物理来源，也是必须用真实视口才能复现的场景。
  return new Viewport({ width: 1280, height: 720 }, { width: 496, height: 720 }, {
    mirrored: true,
    outputAspect: 9 / 16,
  });
}

/** 抓着手的那只手始终停在这里（真机上不会为了摆姿势瞬移） */
const HOLD = { x: 0.5, y: 0.5 };
/** 第二只手出现的位置（与 HOLD 相距 0.2） */
const SECOND = { x: 0.7, y: 0.5 };

function right(patch: SyntheticHandOptions = {}, viewport: Viewport): RawHand {
  return makeHand(viewport, { ...PINCH_HAND, center: HOLD, handedness: 'right', ...patch });
}

function left(patch: SyntheticHandOptions = {}, viewport: Viewport): RawHand {
  return makeHand(viewport, { ...OPEN_HAND, center: SECOND, handedness: 'left', ...patch });
}

interface Harness {
  scene: Scene;
  gestures: GestureManager;
  object: ReturnType<Scene['objects']['create']>;
  viewport: Viewport;
  step(hands: readonly RawHand[]): void;
}

function createHarness(): Harness {
  const behaviors = new BehaviorManager();
  registerCoreBehaviors(behaviors);

  const viewport = createViewport();
  const gestures = new GestureManager({ maxHands: 2 });
  const scene = new Scene({
    viewport,
    behaviors,
    aspectOf: () => 1,
    interactions: new InteractionManager(),
  });

  const object = scene.objects.create({ position: { x: 0.5, y: 0.5 }, size: { width: 0.28 } });
  scene.behaviors.attach(object, 'follow-hand');
  scene.behaviors.attach(object, 'two-hand-scale');

  let time = 0;
  const step = (hands: readonly RawHand[]): void => {
    time += DT;
    scene.update(DT, gestures.update(hands, time, viewport));
  };

  return { scene, gestures, object, viewport, step };
}

/** 把素材放到准星（拇食指中点）下面，这样随后捏合就是抓住它 */
function aimObjectAtCrosshair(harness: Harness): void {
  const hand = harness.gestures.smoothedHands[0];
  const thumb = hand?.landmarks[4]?.position;
  const indexTip = hand?.landmarks[8]?.position;
  expect(thumb).toBeDefined();
  expect(indexTip).toBeDefined();
  if (thumb && indexTip) {
    harness.object.setPosition({ x: (thumb.x + indexTip.x) / 2, y: (thumb.y + indexTip.y) / 2 });
  }
}

describe('双手缩放端到端（真机同构视口）', () => {
  it('单手抓住 → 第二只手捏上 → 两手拉开 2 倍 → 收拢回来，全程不掉抓、不漂移', () => {
    const harness = createHarness();
    const { scene, gestures, object, viewport, step } = harness;

    // 1) 张开的手稳定下来，把素材放到准星下面
    for (let i = 0; i < 20; i += 1) step([right({ ...OPEN_HAND }, viewport)]);
    aimObjectAtCrosshair(harness);

    // 2) 渐进合拢到捏合 -> 抓住
    for (const gap of [0.9, 0.7, 0.5, 0.4, 0.3, 0.3, 0.3]) {
      step([right({ gap }, viewport)]);
    }
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(scene.interactions.get(object.id).grabbedBy).toBe('right');
    expect(object.state.scale).toBeCloseTo(1, 2);

    // 3) 第二只手先出现在旁边（张开），让它的平滑值先稳定 ——
    //    真机上第二只手就是这样先被跟踪到、再捏上的
    for (let i = 0; i < 12; i += 1) step([right({}, viewport), left({}, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(scene.interactions.get(object.id).twoHand.active).toBe(false);

    // 4) 第二只手捏上：此时两手间距就是**真实基准**，大小必须纹丝不动
    for (let i = 0; i < 8; i += 1) step([right({}, viewport), left({ ...PINCH_HAND }, viewport)]);
    const startState = scene.interactions.get(object.id);
    expect(startState.grabbed).toBe(true);
    expect(startState.twoHand.active).toBe(true);
    expect(startState.twoHand.distanceRatio).toBeCloseTo(1, 1);
    expect(object.state.scale).toBeCloseTo(1, 2);

    // 5) 两只手一起拉开（各走 0.1），间距从 0.2 变成 0.4 = 2 倍
    const spread = (offset: number): void => {
      step([
        right({ center: { x: HOLD.x - offset, y: HOLD.y } }, viewport),
        left({ ...PINCH_HAND, center: { x: SECOND.x + offset, y: SECOND.y } }, viewport),
      ]);
    };
    for (let i = 1; i <= 12; i += 1) spread((i / 12) * 0.1);
    /*
     * 停住 1 秒再断言。
     * 位置用的 One-Euro 时间常数约 130ms，运动中读数会偏低（这是滤波滞后，不是控制错误）；
     * 而 12 帧（0.4s ≈ 3τ）还剩约 5% 残差，**大到足以让"回到 1 倍"这条断言失败** ——
     * 第七次踩同一类坑：合成输入必须把时间结构喂够，否则测的是脚本的采样时机。
     */
    for (let i = 0; i < 30; i += 1) spread(0.1);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(gestures.pinchActive).toBe(true);
    expect(scene.interactions.get(object.id).twoHand.distanceRatio).toBeCloseTo(2, 1);
    expect(object.state.scale).toBeCloseTo(2, 1);

    // 6) 再一起收拢回去（双向可用，不是只能放大）
    for (let i = 1; i <= 12; i += 1) spread((1 - i / 12) * 0.1);
    for (let i = 0; i < 30; i += 1) spread(0);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(scene.interactions.get(object.id).twoHand.distanceRatio).toBeCloseTo(1, 1);
    expect(object.state.scale).toBeCloseTo(1, 1);

    // 7) 第二只手走人：大小停在原地（不回弹），退回单手拖动
    for (let i = 0; i < 10; i += 1) step([right({}, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(scene.interactions.get(object.id).twoHand.active).toBe(false);
    expect(object.state.scale).toBeCloseTo(1, 1);
  });

  it('素材跟着"抓着它的那只手"，而不是第一个捏合槽位（槽位对调也不会跳）', () => {
    const harness = createHarness();
    const { scene, gestures, object, viewport, step } = harness;

    for (let i = 0; i < 20; i += 1) step([right({ ...OPEN_HAND }, viewport)]);
    aimObjectAtCrosshair(harness);
    for (const gap of [0.9, 0.7, 0.5, 0.4, 0.3, 0.3]) step([right({ gap }, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);

    // 第二只手捏上来，而它的**输出顺序在前**（识别顺序不稳定是常态）
    const leftPinch = (): RawHand => left({ ...PINCH_HAND, center: { x: 0.75, y: 0.5 } }, viewport);
    for (let i = 0; i < 10; i += 1) step([leftPinch(), right({}, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(scene.interactions.get(object.id).grabbedBy).toBe('right');
    expect(scene.interactions.get(object.id).twoHand.active).toBe(true);

    // 左手松开（只剩右手在捏）：光标必须回到**右手**的捏合中点，而不是留在左手那边
    for (let i = 0; i < 6; i += 1) step([left({ center: { x: 0.75, y: 0.5 } }, viewport), right({}, viewport)]);

    const single = scene.interactions.get(object.id);
    expect(single.grabbed).toBe(true);
    expect(single.twoHand.active).toBe(false);

    // 用两只手的实际位置做参照物：光标离右手必须比离左手近。
    // 注意必须在**场景坐标**里比 —— 归一化坐标是镜像+裁切之前的，两边混着比会得出相反结论。
    const sceneCenterOf = (handedness: 'left' | 'right'): number => {
      const hand = gestures.smoothedHands.find((item) => item.handedness === handedness);
      const a = hand?.landmarks[4]?.position.x ?? 0;
      const b = hand?.landmarks[8]?.position.x ?? 0;
      return (a + b) / 2;
    };
    const rightCenter = sceneCenterOf('right');
    const leftCenter = sceneCenterOf('left');
    const cursorX = single.cursorPosition?.x ?? 0;
    expect(Math.abs(cursorX - rightCenter)).toBeLessThan(Math.abs(cursorX - leftCenter));
  });
});

describe('握拳急停端到端（手势文法）', () => {
  it('捏着素材时握拳 -> 全部取消；张开手之后才能重新抓住', () => {
    const harness = createHarness();
    const { scene, gestures, object, viewport, step } = harness;

    for (let i = 0; i < 20; i += 1) step([right({ ...OPEN_HAND }, viewport)]);
    aimObjectAtCrosshair(harness);
    for (const gap of [0.9, 0.7, 0.5, 0.4, 0.3, 0.3]) step([right({ gap }, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(object.state.scale).toBeCloseTo(1, 2);

    // 握拳：手势层要连续 2 帧才承认，之后急停清空一切
    for (let i = 0; i < 3; i += 1) step([right({ ...FIST_HAND }, viewport)]);

    expect(gestures.fistHands).toEqual(['right']);
    expect(scene.interactions.get(object.id).grabbed).toBe(false);
    expect(scene.interactions.rearmRequired).toBe(true);

    // 拳头松开、手指又回到捏合位置 —— 这时候**不许**立刻抓回来
    for (let i = 0; i < 5; i += 1) step([right({ gap: 0.3 }, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(false);
    expect(scene.interactions.rearmRequired).toBe(true);

    // 真正张开手掌 -> 解除重新武装
    for (let i = 0; i < 3; i += 1) step([right({ ...OPEN_HAND }, viewport)]);
    expect(scene.interactions.rearmRequired).toBe(false);
    expect(scene.interactions.get(object.id).grabbed).toBe(false);

    // 再捏 -> 正常抓住
    for (const gap of [0.9, 0.7, 0.5, 0.4, 0.3, 0.3]) step([right({ gap }, viewport)]);
    expect(scene.interactions.get(object.id).grabbed).toBe(true);
    expect(object.state.scale).toBeCloseTo(1, 2);
  });

  it('素材停在原地：急停不带投掷速度（targetPosition 清空）', () => {
    const harness = createHarness();
    const { scene, object, viewport, step } = harness;
    for (let i = 0; i < 20; i += 1) step([right({ ...OPEN_HAND }, viewport)]);
    aimObjectAtCrosshair(harness);
    for (const gap of [0.9, 0.7, 0.5, 0.4, 0.3, 0.3]) step([right({ gap }, viewport)]);

    // 拖一段距离
    for (let i = 0; i < 6; i += 1) step([right({ center: { x: 0.5 + i * 0.02, y: 0.5 } }, viewport)]);
    const positionBefore = { ...object.state.position };

    for (let i = 0; i < 3; i += 1) step([right({ ...FIST_HAND, center: { x: 0.5, y: 0.5 } }, viewport)]);
    const afterCancel = { ...object.state.position };

    // 取消后素材**停在原地**（follow-hand 没有目标位置就不会动）
    expect(scene.interactions.get(object.id).grabbed).toBe(false);
    for (let i = 0; i < 10; i += 1) step([right({ ...OPEN_HAND, center: { x: 0.2, y: 0.8 } }, viewport)]);
    expect(object.state.position.x).toBeCloseTo(afterCancel.x, 6);
    expect(object.state.position.y).toBeCloseTo(afterCancel.y, 6);
    expect(positionBefore).toBeDefined();
  });
});
