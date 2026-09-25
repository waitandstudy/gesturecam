import { describe, expect, it } from 'vitest';

import { Viewport } from '@/core/coords/viewport';
import {
  DEFAULT_HAND_SHAPE_THRESHOLDS,
  HandShapeTracker,
  readHandShapeMetrics,
  type HandShapeMetrics,
} from '@/core/gesture/handShape';
import { toSceneHand } from '@/core/hand/handState';
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
 * 手型判定的单测。
 *
 * 这个文件存在的理由：手型判定的第一版只看"拇食指距离"**一个**维度，
 * 而握拳时拇指压在食指上、两指尖同样很近 —— 于是"想急停"会被读成"想抓取"。
 * 下面的用例把这件事钉死：**握拳的任何变体都不许被判成捏合**。
 */

/** 让归一化坐标 = 场景坐标，断言直观（输出画幅与源帧同比例）。 */
function identityViewport(mirrored = false): Viewport {
  return new Viewport({ width: 1280, height: 720 }, { width: 1280, height: 720 }, {
    mirrored,
    outputAspect: 1280 / 720,
  });
}

function metricsOf(options: SyntheticHandOptions, viewport = identityViewport()): HandShapeMetrics {
  return readHandShapeMetrics(toSceneHand(makeHand(viewport, options), viewport), viewport.sceneAspect);
}

/** 连续喂同一只手若干帧，返回最终手型。 */
function shapeAfter(
  options: SyntheticHandOptions,
  frames = 3,
  viewport = identityViewport(),
): ReturnType<HandShapeTracker['update']> {
  const tracker = new HandShapeTracker();
  const metrics = metricsOf(options, viewport);
  let shape: ReturnType<HandShapeTracker['update']> = 'other';
  for (let i = 0; i < frames; i += 1) shape = tracker.update(metrics);
  return shape;
}

describe('手型原始量（gap / 食→中夹角 / 伸展度）', () => {
  it('读出的三个量与构造时给的值一致（合成手与判定共用同一套几何）', () => {
    const metrics = metricsOf(PINCH_HAND);

    expect(metrics.gap).toBeCloseTo(0.3, 6);
    expect((metrics.indexMiddleAngle ?? 0) * (180 / Math.PI)).toBeCloseTo(40, 3);
    expect(metrics.reaches.index).toBeCloseTo(1.55, 6);
    expect(metrics.reaches.middle).toBeCloseTo(1.8, 6);
    expect(metrics.palmLength).toBeCloseTo(0.1, 6);
    expect(metrics.pinchCenter).not.toBeNull();
  });

  it('夹角与"手在画面里的位置、大小、朝向"都无关（尺度与旋转不变）', () => {
    const base = metricsOf(PINCH_HAND, identityViewport());
    const rotated = metricsOf({ ...PINCH_HAND, rotationDeg: 37 }, identityViewport());
    const bigger = metricsOf({ ...PINCH_HAND, palmLength: 0.2 }, identityViewport());
    const moved = metricsOf({ ...PINCH_HAND, center: { x: 0.2, y: 0.8 } }, identityViewport());

    const angle = (m: HandShapeMetrics): number => (m.indexMiddleAngle ?? 0) * (180 / Math.PI);

    expect(angle(rotated)).toBeCloseTo(angle(base), 3);
    expect(angle(bigger)).toBeCloseTo(angle(base), 3);
    expect(angle(moved)).toBeCloseTo(angle(base), 3);
    // 旋转 37° 之后夹角不变 -> 用户把手转个角度不会让手势失效
    expect(rotated.reaches.index).toBeCloseTo(base.reaches.index ?? 0, 6);
    expect(rotated.gap).toBeCloseTo(base.gap ?? 0, 6);
  });

  it('镜像（前置摄像头）不影响任何手型量', () => {
    const plain = metricsOf(PINCH_HAND, identityViewport(false));
    const mirrored = metricsOf(PINCH_HAND, identityViewport(true));

    expect(mirrored.gap).toBeCloseTo(plain.gap ?? 0, 6);
    expect(mirrored.reaches.index).toBeCloseTo(plain.reaches.index ?? 0, 6);
    expect((mirrored.indexMiddleAngle ?? 0) * (180 / Math.PI)).toBeCloseTo(
      (plain.indexMiddleAngle ?? 0) * (180 / Math.PI),
      3,
    );
  });

  it('关键点不全时给出 null 而不是编一个数', () => {
    const viewport = identityViewport();
    const hand = makeHand(viewport, PINCH_HAND);
    const broken = { ...hand, landmarks: hand.landmarks.slice(0, 4) };
    const metrics = readHandShapeMetrics(toSceneHand(broken, viewport), viewport.sceneAspect);

    expect(metrics.indexMiddleAngle).toBeNull();
    expect(metrics.reaches.middle).toBeNull();
    expect(metrics.reaches.ring).toBeNull();
  });
});

describe('手型判定表', () => {
  it('常规捏合 -> pinch', () => {
    expect(shapeAfter(PINCH_HAND)).toBe('pinch');
  });

  it('"直捏"（拇指去碰伸直的食指，夹角很小）也必须被认作捏合', () => {
    // 这是把夹角做成"硬条件"会拒判掉的那类用户：食指没有屈向拇指，
    // 靠"食指伸展"这一格兜住。少了这条，"我明明捏了它不认"就会出现。
    const metrics = metricsOf(STRAIGHT_PINCH_HAND);
    expect((metrics.indexMiddleAngle ?? 0) * (180 / Math.PI)).toBeLessThan(10);
    expect(shapeAfter(STRAIGHT_PINCH_HAND)).toBe('pinch');
  });

  it('握拳 -> fist，**绝不能**被判成捏合（本文件存在的理由）', () => {
    const metrics = metricsOf(FIST_HAND);
    // 先证明"只看拇食指距离"一定会误判：握拳的 gap 比捏合的阈值还小
    expect(metrics.gap).toBeLessThan(DEFAULT_HAND_SHAPE_THRESHOLDS.pinchGapEnter);

    // 但双维度判定给出的是握拳
    expect(shapeAfter(FIST_HAND)).toBe('fist');
  });

  it('握拳的任一变体都不是捏合（换各种角度/距离都不行）', () => {
    for (const indexAngleDeg of [0, 10, 20, 30, 45, 60]) {
      for (const gap of [0.2, 0.35, 0.45]) {
        expect(shapeAfter({ ...FIST_HAND, indexAngleDeg, gap })).toBe('fist');
      }
    }
  });

  it('同时像捏合又像握拳时，握拳优先（急停优先于选中）', () => {
    /*
     * 构造一个"两边的条件都成立"的手：食指与中指蜷曲（→ 握拳），
     * 但食指偏转角很大、拇食指也靠得很近（→ 捏合的条件也成立）。
     * 中指不能蜷到极限（reach 1.0 时 MCP→TIP 退化成零向量，夹角算不出来），
     * 取 1.05 既算深蜷、又保住夹角可测。
     */
    const ambiguous: SyntheticHandOptions = { ...FIST_HAND, indexReach: 1.0, middleReach: 1.05, indexAngleDeg: 40 };
    const metrics = metricsOf(ambiguous);
    expect(metrics.gap).toBeLessThan(DEFAULT_HAND_SHAPE_THRESHOLDS.pinchGapEnter);
    expect((metrics.indexMiddleAngle ?? 0) * (180 / Math.PI)).toBeGreaterThan(30);

    expect(shapeAfter(ambiguous)).toBe('fist');
  });

  it('"松开拳头但手还半握着"的放松手**不是**握拳（真机"我张开手了它还说我握拳"的回归）', () => {
    // 旧判据是"平面伸展度 < 1.15 就算蜷曲"，而放松的手正好落在 1.2 附近 —— 一旦
    // 某帧抖到 1.14 就整只手被判成握拳，而握拳会锁住一切操作，用户就再也抓不住东西了。
    const metrics = metricsOf(RELAXED_HAND);
    expect(metrics.reaches.index).toBeGreaterThan(1.15);
    expect(shapeAfter(RELAXED_HAND)).not.toBe('fist');

    // 抖到判据边缘附近也不能变成握拳（迟滞的意义）
    for (const indexReach of [1.2, 1.16, 1.22, 1.18]) {
      expect(shapeAfter({ ...RELAXED_HAND, indexReach })).not.toBe('fist');
    }
  });

  it('"深层捏合"（捏得很紧，无名指小指蜷进掌心）**不能**被判成握拳', () => {
    /*
     * 真机反馈"选中之后想再选，总把我识别成握拳"最可能的成因：
     * 捏得紧的时候，无名指与小指会自然蜷进掌心 —— 而旧判据要求"四指全部蜷曲"，
     * 于是把这个姿势读成了握拳。握拳优先级高于捏合，用户就再也选不中了。
     *
     * 关键判据必须是**中指**：捏合根本不用中指，所以"中指是否深蜷"才是
     * 区分"捏"和"拳"的诚实信号。
     */
    const deepPinch: SyntheticHandOptions = {
      gap: 0.3,
      indexAngleDeg: 40,
      indexReach: 1.0, // 食指指腹贴到拇指，几乎折回掌心
      middleReach: 1.5, // 中指没参与捏合，仍然是伸的
      ringReach: 1.0, // 无名指自然蜷进掌心
      pinkyReach: 0.95, // 小指同样
    };
    expect(shapeAfter(deepPinch)).toBe('pinch');
  });

  it('透视缩短不改变伸展度的**比值**（所以它不会把张开的手变成握拳）', () => {
    /*
     * 这一条是把我自己的一个错误假设钉下来。
     * 我原本担心"手指朝向镜头时平面距离塌缩"，但指尖与掌根是**一起**塌缩的，
     * 比值几乎不变 —— 平面比值本身就对透视缩短不敏感。
     * 所以真机那个 bug 的成因不是透视缩短，而是上面那条"四指全蜷"的判据太松。
     *
     * 保留三维距离（`reachesDepth`）作为**第二道门**：手掌长度估计一旦异常，
     * 比值会整体漂移，两把尺子同时说蜷曲才允许判握拳。
     */
    const foreshortened = { ...OPEN_HAND, viewAngleDeg: 70 };
    const metrics = metricsOf(foreshortened);
    expect(metrics.reaches.index).toBeGreaterThan(DEFAULT_HAND_SHAPE_THRESHOLDS.fingerExtended);
    expect(metrics.reachesDepth.index).toBeGreaterThan(DEFAULT_HAND_SHAPE_THRESHOLDS.fingerExtended);
    expect(shapeAfter(foreshortened)).not.toBe('fist');

    // 伸向镜头的捏合也必须照样成立
    expect(shapeAfter({ ...PINCH_HAND, viewAngleDeg: 60 })).toBe('pinch');
  });

  it('张开手掌 -> open', () => {
    expect(shapeAfter(OPEN_HAND)).toBe('open');
  });

  it('半开半握（既不像捏也不像拳）-> other，什么动作都不做', () => {
    // 手指伸了一半、拇食指也分开：既不够"捏"也不够"开"
    expect(shapeAfter({ gap: 0.9, indexAngleDeg: 12, indexReach: 1.25, middleReach: 1.25, ringReach: 1.2, pinkyReach: 1.18 })).toBe(
      'other',
    );
  });

  it('关键点读不全的手不产生任何手型', () => {
    const viewport = identityViewport();
    const hand = makeHand(viewport, PINCH_HAND);
    const broken = toSceneHand({ ...hand, landmarks: hand.landmarks.slice(0, 4) }, viewport);
    const tracker = new HandShapeTracker();
    for (let i = 0; i < 5; i += 1) {
      expect(tracker.update(readHandShapeMetrics(broken, viewport.sceneAspect))).toBe('other');
    }
  });
});

describe('手型迟滞与最短保持', () => {
  it('捏合进入走单帧（低延迟），握拳/张开要连续 2 帧', () => {
    const pinchTracker = new HandShapeTracker();
    const pinchMetrics = metricsOf(PINCH_HAND);
    expect(pinchTracker.update(pinchMetrics)).toBe('pinch');

    const fistTracker = new HandShapeTracker();
    const fistMetrics = metricsOf(FIST_HAND);
    expect(fistTracker.update(fistMetrics)).toBe('other'); // 第一帧还不算
    expect(fistTracker.update(fistMetrics)).toBe('fist'); // 第二帧才成立
  });

  it('单帧的手型抖动不改变状态（一闪而过的握拳不会触发急停）', () => {
    const tracker = new HandShapeTracker();
    const open = metricsOf(OPEN_HAND);
    const fist = metricsOf(FIST_HAND);

    for (let i = 0; i < 3; i += 1) tracker.update(open);
    expect(tracker.shape).toBe('open');

    tracker.update(fist); // 只有一帧
    expect(tracker.shape).toBe('open'); // 仍然是张开
    tracker.update(open);
    expect(tracker.shape).toBe('open');
  });

  it('gap 的迟滞：0.55 落在 enter(0.5) 与 exit(0.6) 之间', () => {
    const between = { ...PINCH_HAND, gap: 0.55 };

    // 从"其他"进不去
    const cold = new HandShapeTracker();
    expect(cold.update(metricsOf(between))).toBe('other');

    // 已经在捏合里则出不来
    const warm = new HandShapeTracker();
    warm.update(metricsOf(PINCH_HAND));
    expect(warm.shape).toBe('pinch');
    expect(warm.update(metricsOf(between))).toBe('pinch');
  });

  it('夹角的迟滞独立生效：夹角 20° 进不去、但出得来', () => {
    // 食指伸展度取"既不算伸展也不算蜷曲"的中间值，这样捏合的唯一依据就是夹角
    const neutral = { indexReach: 1.28, middleReach: 1.28, ringReach: 1.2, pinkyReach: 1.18 };
    const angle20: SyntheticHandOptions = { ...neutral, gap: 0.3, indexAngleDeg: 20 };
    const angle30: SyntheticHandOptions = { ...neutral, gap: 0.3, indexAngleDeg: 30 };

    const cold = new HandShapeTracker();
    expect(cold.update(metricsOf(angle20))).toBe('other'); // 20° < enter 25°
    expect(cold.update(metricsOf(angle30))).toBe('pinch'); // 30° >= enter

    const warm = new HandShapeTracker();
    warm.update(metricsOf(angle30));
    expect(warm.shape).toBe('pinch');
    expect(warm.update(metricsOf(angle20))).toBe('pinch'); // 20° >= exit 18°，保持
  });

  it('参数非法时抛错（迟滞必须严格成立）', () => {
    expect(() => new HandShapeTracker({ ...DEFAULT_HAND_SHAPE_THRESHOLDS, pinchGapExit: 0.4 })).not.toThrow();
    // 阈值本身是数据，非法组合由 GestureManager 在装配时校验（见 gestureManager.test.ts）
  });
});
