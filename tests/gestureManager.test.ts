import { describe, expect, it } from 'vitest';

import { Viewport } from '@/core/coords/viewport';
import {
  DEFAULT_PINCH_ENTER_RATIO,
  DEFAULT_PINCH_EXIT_RATIO,
  GestureManager,
} from '@/core/gesture/gestureManager';
import { readHandShapeMetrics } from '@/core/gesture/handShape';
import { toSceneHand, type RawHand } from '@/core/hand/handState';
import {
  FIST_HAND,
  makeHand,
  OPEN_HAND,
  PINCH_HAND,
  RELAXED_HAND,
  STRAIGHT_PINCH_HAND,
  type SyntheticHandOptions,
} from './helpers/syntheticHand';

/**
 * 让缩放/裁剪成为恒等映射，这样归一化坐标就等于场景坐标，断言直观。
 * 同时把 One-Euro 的截止频率调到极高 = 几乎不平滑，
 * 把"判定逻辑"和"滤波行为"分开测（滤波另有 oneEuro.test.ts 覆盖）。
 */
function identityViewport(mirrored = false): Viewport {
  return new Viewport({ width: 1280, height: 720 }, { width: 1280, height: 720 }, {
    mirrored,
    outputAspect: 1280 / 720,
  });
}

function noSmoothing() {
  return { minCutoff: 1e4, beta: 0, dCutoff: 1e4 };
}

/**
 * 造一只"参数可控"的假手。
 *
 * 几何在 `helpers/syntheticHand.ts` 里生成（解剖上说得通的全 21 点），
 * 这里只是把默认视口固定下来，让每个用例只关心自己要变的那一个参数。
 */
function hand(patch: SyntheticHandOptions = {}, viewport = identityViewport()): RawHand {
  return makeHand(viewport, patch);
}

/** 捏合距离取"稳稳在阈值以内"，避开阈值附近的抖动 */
const PINCHED = { ...PINCH_HAND };
/** 张开的手 */
const OPEN = { ...OPEN_HAND };
/** 落在 enter(0.50) 与 exit(0.60) 之间 */
const BETWEEN: SyntheticHandOptions = { ...PINCH_HAND, gap: 0.55 };

describe('GestureManager 阈值标定', () => {
  it('enter 0.50（真机手感），exit 收到 0.60（不再为单手缩放留余量）', () => {
    // handy 的原始默认是 0.40 / 0.58（见 docs/handy-借鉴笔记.md）。
    // enter 放宽是因为真机上"自然捏合"常停在 0.4~0.5。
    // exit 曾经放到 1.00，唯一原因是"单手张开手指来放大"需要余量；
    // 缩放改成双手之后这个余量没用了，收紧到 0.60 能显著减少误判的捏合。
    expect(DEFAULT_PINCH_ENTER_RATIO).toBe(0.5);
    expect(DEFAULT_PINCH_EXIT_RATIO).toBe(0.6);
    // 迟滞必须严格成立，否则会退化成单阈值抖动
    expect(DEFAULT_PINCH_EXIT_RATIO).toBeGreaterThan(DEFAULT_PINCH_ENTER_RATIO);
  });

  it('手指张到 0.9 就结束捏合了（单手张开不再有"缩放余量"）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand(PINCHED, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(true);

    // 0.9 远高于 exit 0.60 -> 判定要走"张开手掌"这条路，而张开与握拳一样需要连续 2 帧确认
    const first = manager.update([hand({ ...PINCH_HAND, gap: 0.9 }, viewport)], 1 / 30, viewport);
    expect(first.controls.pinch.active).toBe(true); // 第 1 帧还不算（防单帧抖动）
    const second = manager.update([hand({ ...PINCH_HAND, gap: 0.9 }, viewport)], 2 / 30, viewport);
    expect(second.controls.pinch.active).toBe(false);
    expect(second.controls.pinch.shape).toBe('open');
    expect(second.events.map((event) => event.type)).toEqual(['gesture-end']);
  });

  it('手型阈值参数写反时直接抛错（迟滞必须严格成立）', () => {
    expect(() => new GestureManager({ handShape: { pinchGapExit: 0.4 } })).toThrow(RangeError);
    expect(() => new GestureManager({ handShape: { pinchAngleEnter: 0.1, pinchAngleExit: 0.5 } })).toThrow(
      RangeError,
    );
  });
});

describe('GestureManager 判定延迟（"抓取不灵敏"的回归）', () => {
  it('单帧内从张开变成捏合就立刻触发 —— 判定不能被平滑拖慢', () => {
    // 用默认平滑参数（minCutoff 1.2），不关掉滤波
    const manager = new GestureManager();
    const viewport = identityViewport();

    // 先喂一帧张开的手，让滤波器有历史
    manager.update([hand(OPEN, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(false);

    /*
     * 下一帧手指已经捏拢。位置用的 One-Euro（约 130ms 时间常数）这一刻还远没跟上，
     * 但**手型判定取自未平滑的原始关键点**，所以必须立刻成立。
     * 如果哪天有人"顺手"把判定也接到平滑信号上，这一条会立刻失败 ——
     * 那正是真机上"抓取不灵敏"的成因。
     */
    const state = manager.update([hand(PINCHED, viewport)], 1 / 30, viewport);

    expect(state.controls.pinch.active).toBe(true);
    expect(state.controls.pinch.shape).toBe('pinch');
    expect(state.events.map((event) => event.type)).toEqual(['gesture-start']);
    expect(manager.debug.pinchRatio).toBeCloseTo(0.3, 3);
  });

  it('准星在没捏合时也给（否则图片盖住手时没法瞄准）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();
    const state = manager.update([hand({ ...OPEN, center: { x: 0.4, y: 0.6 } }, viewport)], 0, viewport);

    expect(state.controls.pinch.active).toBe(false);
    expect(state.controls.pinch.center).toBeNull();
    // 关键：准星点仍然要有（它是"捏下去会抓到这里"的唯一依据）
    expect(state.controls.pinchPoint).not.toBeNull();
    // 手指朝屏幕上方，所以准星在掌心之上；拇指在左，所以准星偏左
    expect(state.controls.pinchPoint?.y).toBeLessThan(0.6);
    expect(state.controls.pinchPoint?.x).toBeLessThan(0.4);
  });

  it('手丢了之后准星也清空（不能指着一个不存在的位置）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand(OPEN, viewport)], 0, viewport);
    const lost = manager.update([], 1 / 30, viewport);

    expect(lost.controls.pinchPoint).toBeNull();
  });
});

describe('GestureManager 基础', () => {
  it('没有手时输出空闲状态', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const state = manager.update([], 0, identityViewport());

    expect(state.controls.handCount).toBe(0);
    expect(state.controls.palm).toBeNull();
    expect(state.controls.pinch.active).toBe(false);
    expect(state.controls.pinch.center).toBeNull();
    expect(state.controls.pinch.shape).toBe('other');
    expect(state.controls.fistHands).toEqual([]);
    expect(state.events).toEqual([]);
    expect(manager.pinchActive).toBe(false);
  });

  it('张开的手不触发 pinch，捏合才触发', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    const open = manager.update([hand(OPEN, viewport)], 0, viewport);
    expect(open.controls.pinch.active).toBe(false);
    expect(open.events).toEqual([]);
    expect(open.controls.palm).not.toBeNull();

    const pinched = manager.update([hand(PINCHED, viewport)], 1 / 30, viewport);
    expect(pinched.controls.pinch.active).toBe(true);
    expect(pinched.events).toHaveLength(1);
    expect(pinched.events[0]?.type).toBe('gesture-start');
    expect(pinched.events[0]?.gesture).toBe('pinch');
    expect(pinched.events[0]?.hand).toBe('right');
    // 事件位置就是拇食指中点（与手型量算出来的中心一致；
    // 事件位置取自平滑后的手、期望值取自原始手，所以留 1e-3 的容差）
    const expected = readHandShapeMetrics(
      toSceneHand(hand(PINCHED, viewport), viewport),
      viewport.sceneAspect,
    ).pinchCenter;
    expect(pinched.events[0]?.position.x).toBeCloseTo(expected?.x ?? 0, 3);
    expect(pinched.events[0]?.position.y).toBeCloseTo(expected?.y ?? 0, 3);
  });

  it('事件只在本帧产出，后续帧为空（否则 60fps 会重复触发抓取）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();
    const pinched = hand(PINCHED, viewport);

    expect(manager.update([pinched], 0, viewport).events).toHaveLength(1);
    expect(manager.update([pinched], 1 / 30, viewport).events).toHaveLength(0);
    expect(manager.update([pinched], 2 / 30, viewport).events).toHaveLength(0);
    expect(manager.pinchActive).toBe(true);
  });

  it('掌心速度按位移/时间计算，并随移动方向变化', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), palmVelocitySmoothing: 1 });
    const viewport = identityViewport();

    manager.update([hand({ ...OPEN, center: { x: 0.4, y: 0.5 } }, viewport)], 0, viewport);
    const moved = manager.update([hand({ ...OPEN, center: { x: 0.5, y: 0.5 } }, viewport)], 0.1, viewport);

    // 0.1 秒里向右移动 0.1 -> 速度约 1.0 /秒（微小残差来自 One-Euro）
    expect(moved.controls.palmVelocity.x).toBeCloseTo(1, 3);
    expect(moved.controls.palmVelocity.y).toBeCloseTo(0, 6);

    const still = manager.update([hand({ ...OPEN, center: { x: 0.5, y: 0.5 } }, viewport)], 0.2, viewport);
    // 手停住后速度应该基本归零（残差来自 One-Euro 收敛的最后一点位移）
    expect(Math.abs(still.controls.palmVelocity.x)).toBeLessThan(0.01);
  });

  it('关键点不全时不产生 pinch 证据（不误触发）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();
    const full = hand(PINCHED, viewport);
    const broken: RawHand = { ...full, landmarks: full.landmarks.slice(0, 6) };

    const state = manager.update([broken], 0, viewport);

    expect(state.controls.pinch.active).toBe(false);
    expect(state.controls.pinch.shape).toBe('other');
    expect(manager.debug.pinchRatio).toBeNull();
  });
});

describe('GestureManager 迟滞', () => {
  it('进入用较紧的阈值，退出用较松的阈值', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    // 一开始就处于 enter/exit 之间：不该触发
    expect(manager.update([hand(BETWEEN, viewport)], 0, viewport).controls.pinch.active).toBe(false);

    // 捏到 enter 以下 -> 触发
    manager.update([hand(PINCHED, viewport)], 1 / 30, viewport);
    expect(manager.pinchActive).toBe(true);

    // 退回 enter/exit 之间 -> 仍然按着（这就是迟滞的意义）
    const stillHolding = manager.update([hand(BETWEEN, viewport)], 2 / 30, viewport);
    expect(stillHolding.controls.pinch.active).toBe(true);
    expect(stillHolding.events).toEqual([]);

    // 超过 exit -> 走"张开手掌"那条路（2 帧确认），然后释放并发 end 事件
    const first = manager.update([hand(OPEN, viewport)], 3 / 30, viewport);
    expect(first.controls.pinch.active).toBe(true);
    const released = manager.update([hand(OPEN, viewport)], 4 / 30, viewport);
    expect(released.controls.pinch.active).toBe(false);
    expect(released.events).toHaveLength(1);
    expect(released.events[0]?.type).toBe('gesture-end');
  });

  it('手指停在阈值附近抖动时不会反复开关', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand({ ...PINCH_HAND, gap: 0.4 }, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(true);

    let transitions = 0;
    for (let i = 1; i <= 120; i += 1) {
      // 在 enter 阈值两侧晃动：0.49 / 0.51
      const gap = i % 2 === 0 ? 0.51 : 0.49;
      transitions += manager.update([hand({ ...PINCH_HAND, gap }, viewport)], i / 30, viewport).events.length;
    }

    expect(transitions).toBe(0);
    expect(manager.pinchActive).toBe(true);
  });
});

describe('GestureManager 尺度无关（handy 的关键设计）', () => {
  it('手离摄像头远近变化时判定结果不变', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    // 手靠近摄像头：整只手放大（手掌长度 0.1 -> 0.3）
    const close = manager.update([hand({ ...PINCH_HAND, palmLength: 0.3 }, viewport)], 0, viewport);
    expect(close.controls.pinch.active).toBe(true);
    // 掌心长度也同比放大，所以 gap（比值）不变
    expect(manager.debug.pinchRatio).toBeCloseTo(0.3, 3);

    // 手离远（缩小）依然判定为捏合
    const far = manager.update([hand({ ...PINCH_HAND, palmLength: 0.05 }, viewport)], 1 / 30, viewport);
    expect(far.controls.pinch.active).toBe(true);
    expect(manager.debug.pinchRatio).toBeCloseTo(0.3, 3);
  });
});

describe('GestureManager 手型（手势文法）', () => {
  it('握拳被暴露成 fistHands，并且**不是** pinch', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand(PINCHED, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(true);

    // 握拳：gap 比捏合阈值还小，单维度判定一定会误判，双维度不会
    manager.update([hand(FIST_HAND, viewport)], 1 / 30, viewport);
    const state = manager.update([hand(FIST_HAND, viewport)], 2 / 30, viewport);

    expect(state.controls.fistHands).toEqual(['right']);
    expect(state.controls.pinch.active).toBe(false);
    expect(state.controls.pinch.shape).toBe('fist');
    expect(manager.pinchActive).toBe(false);
    // 松手事件照常发出（急停的双保险：交互层还看 fistHands）
    expect(state.events.map((event) => event.type)).toEqual(['gesture-end']);
  });

  it('张开手掌被暴露成 open，并且不是 pinch', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand(OPEN, viewport)], 0, viewport);
    const state = manager.update([hand(OPEN, viewport)], 1 / 30, viewport);

    expect(state.controls.pinch.shape).toBe('open');
    expect(state.controls.fistHands).toEqual([]);
    expect(state.controls.pinch.active).toBe(false);
  });

  it('"直捏"（拇指碰伸直的食指）照样算捏合', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const state = manager.update([hand(STRAIGHT_PINCH_HAND, identityViewport())], 0, identityViewport());

    expect(state.controls.pinch.active).toBe(true);
    expect(state.events.map((event) => event.type)).toEqual(['gesture-start']);
  });

  it('手离开画面后，`pinches` 里的手型必须变回 other（陈旧手型会把应用锁住）', () => {
    /*
     * 回归（真机反馈"张开手了还是抓不住"的根因之一）：
     * 第一版在"这一帧没看到手"时，对非捏合的手型直接 return ——
     * 于是槽位里**留着上一次的 fist**，而交互层是拿 `controls.pinches[].shape`
     * 判断"能不能重新武装"的，那份陈旧手型让重新武装永远解不开。
     *
     * 正确语义：手型描述"这一帧看到了什么"，看不到就是 other；
     * "捏合会话还按着"是另一件事，由 active 单独表达（宽限期内 active=true、center=null）。
     */
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    // 握拳两帧 -> 成立
    manager.update([hand(FIST_HAND, viewport)], 0, viewport);
    const fistState = manager.update([hand(FIST_HAND, viewport)], 1 / 30, viewport);
    expect(fistState.controls.fistHands).toEqual(['right']);
    expect(fistState.controls.pinches[0]?.shape).toBe('fist');

    // 手离开画面
    const lost = manager.update([], 2 / 30, viewport);
    expect(lost.controls.fistHands).toEqual([]);
    expect(lost.controls.pinches.map((pinch) => pinch.shape)).toEqual(['other', 'other']);
    expect(manager.fistHands).toEqual([]);
  });

  it('宽限期内 active 仍然为真但 shape 已经是 other（两者刻意分开）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), handLossGraceSeconds: 0.25 });
    const viewport = identityViewport();

    manager.update([hand(PINCHED, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(true);

    const lost = manager.update([], 1 / 30, viewport);
    // "按着但不知道在哪"：active 保持、center 为空 —— 交互层据此冻结素材
    expect(lost.controls.pinch.active).toBe(true);
    expect(lost.controls.pinch.center).toBeNull();
    // 而手型必须诚实：这一帧没看到手
    expect(lost.controls.pinch.shape).toBe('other');
  });

  it('一只手离开画面时，另一只手的捏合会话不受影响', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    manager.update(
      [
        hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'left' }, viewport),
        hand({ ...PINCH_HAND, center: { x: 0.7, y: 0.5 }, handedness: 'right' }, viewport),
      ],
      0,
      viewport,
    );
    expect(manager.debug.twoHandActive).toBe(true);

    // 左手离开
    const single = manager.update(
      [hand({ ...PINCH_HAND, center: { x: 0.7, y: 0.5 }, handedness: 'right' }, viewport)],
      1 / 30,
      viewport,
    );

    expect(single.controls.twoHand.active).toBe(false);
    const right = single.controls.pinches.find((pinch) => pinch.handedness === 'right');
    expect(right?.active).toBe(true);
    const left = single.controls.pinches.find((pinch) => pinch.shape === 'fist');
    expect(left).toBeUndefined();
  });

  it('debug 暴露每只手的 gap / 夹角 / 四指伸展度（真机标定全靠它）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();
    manager.update([hand(PINCHED, viewport)], 0, viewport);

    const debug = manager.debug;
    expect(debug.pinchRatio).toBeCloseTo(0.3, 3);
    expect(debug.palmLength).toBeCloseTo(0.1, 3);
    expect(debug.handCount).toBe(1);
    expect(debug.perHand).toHaveLength(1);
    expect(debug.perHand[0]?.shape).toBe('pinch');
    expect(debug.perHand[0]?.angleDeg).toBeCloseTo(40, 3);
    expect(debug.perHand[0]?.reaches.index).toBeCloseTo(1.55, 6);
  });

  it('reset 清空全部状态（含手型）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing() });
    const viewport = identityViewport();

    manager.update([hand(PINCHED, viewport)], 0, viewport);
    expect(manager.pinchActive).toBe(true);

    manager.reset();
    expect(manager.pinchActive).toBe(false);
    expect(manager.fistHands).toEqual([]);
    expect(manager.smoothedHands).toEqual([]);
    expect(manager.debug.perHand).toEqual([]);
  });
});

describe('GestureManager 双手与槽位稳定', () => {
  /**
   * 捏合中点相对**掌心**的固定偏移。
   * 拇食指都在掌心的偏左上方，所以这个偏移不为零 —— 双手的"中点"同样带这个偏移，
   * 断言要把它算进去，否则会把"几何偏移"误判成"槽位串了"。
   */
  function pinchOffset(viewport = identityViewport()): { x: number; y: number } {
    const center = readHandShapeMetrics(
      toSceneHand(hand({ ...PINCH_HAND, center: { x: 0.5, y: 0.5 } }, viewport), viewport),
      viewport.sceneAspect,
    ).pinchCenter;
    return { x: (center?.x ?? 0) - 0.5, y: (center?.y ?? 0) - 0.5 };
  }

  /** 左手 / 右手，各自捏合，水平分开 separation */
  function pair(separation: number, leftX = 0.5 - separation / 2, rightX = 0.5 + separation / 2) {
    const viewport = identityViewport();
    return [
      hand({ ...PINCH_HAND, center: { x: rightX, y: 0.5 }, handedness: 'right' }, viewport),
      hand({ ...PINCH_HAND, center: { x: leftX, y: 0.5 }, handedness: 'left' }, viewport),
    ];
  }

  it('两只手都在捏合时给出双手中心与间距', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    const offset = pinchOffset(viewport);

    const state = manager.update(pair(0.4), 0, viewport);

    expect(state.controls.handCount).toBe(2);
    expect(state.controls.twoHand.active).toBe(true);
    expect(state.controls.twoHand.center?.x).toBeCloseTo(0.5 + offset.x, 6);
    expect(state.controls.twoHand.distance).toBeCloseTo(0.4, 6);
    expect(state.controls.fistHands).toEqual([]);
  });

  it('只捏一只手时双手状态是 inactive（另一只只是放在画面里不算）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    const [right] = pair(0.4);

    const state = manager.update(
      [right as RawHand, hand({ ...OPEN_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'left' }, viewport)],
      0,
      viewport,
    );

    expect(state.controls.twoHand.active).toBe(false);
    expect(state.controls.pinch.active).toBe(true);
    expect(state.controls.primaryHandedness).toBe('right');
  });

  it('两只手都没在捏合时，双手状态是 inactive（必须两只都捏）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    const state = manager.update(
      [
        hand({ ...OPEN_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'left' }, viewport),
        hand({ ...OPEN_HAND, center: { x: 0.7, y: 0.5 }, handedness: 'right' }, viewport),
      ],
      0,
      viewport,
    );

    expect(state.controls.handCount).toBe(2);
    expect(state.controls.twoHand.active).toBe(false);
  });

  it('两只手的输出顺序变了，槽位也不会串（双手缩放的稳定性回归）', () => {
    // 识别输出的手序不可靠：真实设备上两只手交叉/一进一出时顺序会变。
    // 如果按下标取，右手的位置会从左手上一帧的位置滑过来 —— 表现为间距突然跳一下。
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    manager.update(pair(0.6, 0.2, 0.8), 0, viewport);

    // 第二帧把两只手的顺序对调，位置各移动一点点
    const swapped = manager.update(pair(0.58, 0.21, 0.79).reverse(), 1 / 30, viewport);

    const twoHand = swapped.controls.twoHand;
    expect(twoHand.active).toBe(true);
    expect(twoHand.center?.x).toBeCloseTo(0.5 + pinchOffset(viewport).x, 3);
    // 间距基本不变（如果串了槽位，位置会跳到对面，间距也会算错）
    expect(twoHand.distance).toBeCloseTo(0.58, 3);

    // 槽位 0 仍然是右手（会被就近归位拉回去）
    expect(swapped.controls.pinches[0]?.center?.x).toBeGreaterThan(0.5);
  });

  it('镜像画布下槽位依然稳定（前置摄像头默认镜像，拿场景坐标当锚点会认反）', () => {
    const mirrored = identityViewport(true);
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });

    const build = (_separation: number, leftX: number, rightX: number) => [
      makeHand(mirrored, { ...PINCH_HAND, center: { x: rightX, y: 0.5 }, handedness: 'right' }),
      makeHand(mirrored, { ...PINCH_HAND, center: { x: leftX, y: 0.5 }, handedness: 'left' }),
    ];

    manager.update(build(0.6, 0.2, 0.8), 0, mirrored);
    const swapped = manager.update(build(0.58, 0.21, 0.79).reverse(), 1 / 30, mirrored);

    expect(swapped.controls.twoHand.active).toBe(true);
    expect(swapped.controls.twoHand.distance).toBeCloseTo(0.58, 3);
  });

  it('一只手握拳时 fistHands 会带上它（急停信号与是哪只手无关）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    manager.update(
      [
        hand({ ...PINCH_HAND, center: { x: 0.5, y: 0.5 }, handedness: 'right' }, viewport),
        hand({ ...FIST_HAND, center: { x: 0.8, y: 0.6 }, handedness: 'left' }, viewport),
      ],
      0,
      viewport,
    );
    const state = manager.update(
      [
        hand({ ...PINCH_HAND, center: { x: 0.5, y: 0.5 }, handedness: 'right' }, viewport),
        hand({ ...FIST_HAND, center: { x: 0.8, y: 0.6 }, handedness: 'left' }, viewport),
      ],
      1 / 30,
      viewport,
    );

    expect(state.controls.fistHands).toEqual(['left']);
    // 右手还在捏着，所以 pinch 仍然成立 —— 由交互层来决定"急停清空一切"
    expect(state.controls.pinch.active).toBe(true);
  });
});

describe('GestureManager 指弹调试读数', () => {
  /**
   * "弹脑瓜"的蓄力姿势 —— **第五轮真机实测**：拇指扣住食指尖（gap 0.45）、
   * 其余三指蜷着（中指 0.91）、食指是伸着的（1.52）。
   * 注意食指**不需要**弯：旧模型要求的"食指 ≤1.35"恰好装填不上。
   */
  const HOOK: SyntheticHandOptions = {
    gap: 0.45,
    indexAngleDeg: 40,
    indexReach: 1.52,
    middleReach: 0.91,
    ringReach: 0.8,
    pinkyReach: 0.7,
  };

  it('debug.flick 给出读数与门槛，装填帧数随帧数增长', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    manager.update([hand(HOOK, viewport)], 0, viewport);
    manager.update([hand(HOOK, viewport)], 1 / 30, viewport);

    const flick = manager.debug.flick;
    expect(flick).not.toBeNull();
    expect(flick?.indexReach).toBeCloseTo(1.52, 2);
    expect(flick?.gap).toBeCloseTo(0.45, 2);
    expect(flick?.armedFrames).toBe(2);
    expect(manager.debug.flickArmed).toBe(true);
    // 门槛要一并暴露，面板才能打出"读数 vs 门槛"
    expect(flick?.thresholds.loadedMaxGap).toBeGreaterThanOrEqual(0.45);
    expect(flick?.thresholds.maxMiddleReach).toBeGreaterThanOrEqual(0.91);
    expect(flick?.thresholds.minTipSpeed).toBeGreaterThan(0);
  });

  /**
   * 双手同时在画面里时，**正在装填的那只手**才是读数来源。
   * 早期版本固定取 `primarySlot()`（优先给捏合中的手），于是用户勾住的是另一只手，
   * 面板读数却纹丝不动 —— 排查时最容易被这个假象带偏。
   */
  it('一只手捏着、另一只手勾住时，读数给的是**勾住**的那只手', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    const frames = [
      hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'right' }, viewport),
      hand({ ...HOOK, center: { x: 0.8, y: 0.5 }, handedness: 'left' }, viewport),
    ];
    manager.update(frames, 0, viewport);
    const state = manager.update(frames, 1 / 30, viewport);

    expect(state.controls.pinch.active).toBe(true);
    expect(manager.debug.flickArmed).toBe(true);
    expect(manager.debug.flick?.handedness).toBe('left');
    expect(manager.debug.flick?.indexReach).toBeCloseTo(1.52, 2);
  });

  it('其余三指张开时不装填，且面板能看出是三指那一条在挡', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    // 拇指照旧扣着（gap 达标），但其余三指张开了 —— 那是"张开手掌"，不是弹脑瓜
    const opened: SyntheticHandOptions = { ...HOOK, middleReach: 1.4, ringReach: 1.35, pinkyReach: 1.25 };

    manager.update([hand(opened, viewport)], 0, viewport);
    manager.update([hand(opened, viewport)], 1 / 30, viewport);

    const flick = manager.debug.flick;
    expect(manager.debug.flickArmed).toBe(false);
    expect(flick?.armedFrames).toBe(0);
    // gap 这一条是达标的，挡路的是"其余三指" —— 面板的短提示正是靠这个判断
    expect(flick?.gap).toBeLessThanOrEqual(flick?.thresholds.loadedMaxGap ?? 0);
    expect(flick?.middleReach).toBeGreaterThan(flick?.thresholds.maxMiddleReach ?? 0);
  });

  /**
   * 这两个是浏览器验收里抓到的一条真问题：面板可能**停在"已扣住"上不动**。
   * 浏览器探针在两次姿势之间会隔一段真实时间（截图期间没有合成帧），
   * 而那段时间手是"丢了"的 —— 如果槽位的指弹检测器不跟着清，装填状态就会一直留着。
   */
  it('手离开画面后装填状态必须清掉（不能停在"已扣住"）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    let t = 0;
    for (let i = 0; i < 12; i += 1) {
      manager.update([hand(HOOK, viewport)], t, viewport);
      t += 1 / 30;
    }
    expect(manager.debug.flickArmed).toBe(true);

    // 手丢了（真实时间流逝、没有合成帧时就是这样）
    for (let i = 0; i < 6; i += 1) {
      manager.update([], t, viewport);
      t += 1 / 30;
    }
    expect(manager.debug.flickArmed).toBe(false);
  });

  it('从"扣住"直接切到"三指张开"之后，装填状态也要清掉', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    let t = 0;
    for (let i = 0; i < 12; i += 1) {
      manager.update([hand(HOOK, viewport)], t, viewport);
      t += 1 / 30;
    }
    expect(manager.debug.flickArmed).toBe(true);

    const opened: SyntheticHandOptions = { ...HOOK, middleReach: 1.4, ringReach: 1.35, pinkyReach: 1.25 };
    for (let i = 0; i < 12; i += 1) {
      manager.update([hand(opened, viewport)], t, viewport);
      t += 1 / 30;
    }
    expect(manager.debug.flickArmed).toBe(false);
  });
});

/**
 * 松手去抖 —— 真机反馈"拖动的时候有时候会突然松掉"的回归。
 *
 * `pinch → 其他` 的手型切换是**即时**的（只有 fist/open 需要连续帧），
 * 所以一帧误判就够发出 `gesture-end`，而交互层收到它就立刻放手。
 * 这里钉住：偶发一帧不算松手，连续几帧才算。
 *
 * ⚠️ 用 `RELAXED_HAND`（判成 `other`）而不是 `OPEN_HAND`：
 * `pinch → open` 本来就有 2 帧保持，用它测不出这个 bug。
 */
describe('GestureManager 松手去抖', () => {
  it('捏合中途偶发一帧误判不会松手；连续几帧才结束会话', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    let t = 0;
    const feed = (options: SyntheticHandOptions) => {
      const state = manager.update([hand(options, viewport)], t, viewport);
      t += 1 / 30;
      return state.events.filter((event) => event.type === 'gesture-end').length;
    };

    // 先稳稳捏住
    let ends = 0;
    for (let i = 0; i < 5; i += 1) ends += feed(PINCH_HAND);
    expect(ends).toBe(0);

    // 一帧误判（判成 other，即时生效）：**不该**松手
    expect(feed(RELAXED_HAND)).toBe(0);

    // 恢复捏合：这次错判不该留下任何后果
    expect(feed(PINCH_HAND)).toBe(0);

    // 真正连续松开 -> 才结束，而且只结束一次
    let endsAfterRelease = 0;
    for (let i = 0; i < 4; i += 1) endsAfterRelease += feed(RELAXED_HAND);
    expect(endsAfterRelease).toBe(1);
  });
});

/**
 * 代码审计里那三处的回归（真机反馈"拖动时突然松掉 / 单手捏着会忽大忽小"之后查出来的）。
 */
describe('GestureManager 审计修补', () => {
  it('两手贴在一起不算双手缩放（间距太小 -> 倍率会被子像素噪声放大）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    const close = [
      hand({ ...PINCH_HAND, center: { x: 0.5, y: 0.5 }, handedness: 'right' }, viewport),
      hand({ ...PINCH_HAND, center: { x: 0.52, y: 0.5 }, handedness: 'left' }, viewport),
    ];
    manager.update(close, 0, viewport);
    expect(manager.update(close, 1 / 30, viewport).controls.twoHand.active).toBe(false);

    const far = [
      hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'right' }, viewport),
      hand({ ...PINCH_HAND, center: { x: 0.7, y: 0.5 }, handedness: 'left' }, viewport),
    ];
    manager.update(far, 2 / 30, viewport);
    expect(manager.update(far, 3 / 30, viewport).controls.twoHand.active).toBe(true);
  });

  it('两手相距 0.09（自然起手间距）也必须算双手 —— 门槛不能压在正常姿势上', () => {
    /*
     * 这条是"门槛订得太狠"的回归。
     * 最小间距第一版取 1 个掌长（≈0.10 画幅宽），而验收脚本里
     * "两手相距 0.09、再拉到 0.18 = 正好 2 倍"用的是**自然起手间距** ——
     * 门槛压在它上面，基准被推迟到拉开之后才取，倍率凭空少了一半（2.0 → 1.42）。
     */
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();
    let t = 0;
    const feed = (rightX: number, leftX: number) => {
      const state = manager.update(
        [
          hand({ ...PINCH_HAND, center: { x: rightX, y: 0.5 }, handedness: 'right' }, viewport),
          hand({ ...PINCH_HAND, center: { x: leftX, y: 0.5 }, handedness: 'left' }, viewport),
        ],
        t,
        viewport,
      );
      t += 1 / 30;
      return state;
    };

    for (let i = 0; i < 6; i += 1) feed(0.5, 0.59); // 相距 0.09
    expect(feed(0.5, 0.59).controls.twoHand.active).toBe(true);
  });

  it('标签翻一次不该把正在拖图的那只手换到另一个槽位（换槽 = 手丢了 = 0.25s 后放手）', () => {
    const manager = new GestureManager({ smoothing: noSmoothing(), maxHands: 2 });
    const viewport = identityViewport();

    // 左手先出现过（让 slot 记住 left），然后走了
    const withLeft = [
      hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'right' }, viewport),
      hand({ ...PINCH_HAND, center: { x: 0.7, y: 0.5 }, handedness: 'left' }, viewport),
    ];
    for (let i = 0; i < 6; i += 1) manager.update(withLeft, i / 30, viewport);

    /*
     * 左手走人。要喂够帧数让它的"手丢失宽限"（0.25s ≈ 8 帧）走完、`gesture-end` 发出去，
     * 否则那个事件会掉进下面统计的窗口里，把这条测试变成假阳性。
     */
    const rightOnly = [
      hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'right' }, viewport),
    ];
    for (let i = 0; i < 12; i += 1) manager.update(rightOnly, (6 + i) / 30, viewport);

    // 右手原地不动，只是 MediaPipe 把它的标签翻成了 left
    const flipped = [
      hand({ ...PINCH_HAND, center: { x: 0.3, y: 0.5 }, handedness: 'left' }, viewport),
    ];
    let rightEnds = 0;
    for (let i = 0; i < 8; i += 1) {
      const state = manager.update(flipped, (18 + i) / 30, viewport);
      rightEnds += state.events.filter(
        (event) => event.type === 'gesture-end' && event.hand === 'right',
      ).length;
    }
    expect(rightEnds).toBe(0);
  });
});
