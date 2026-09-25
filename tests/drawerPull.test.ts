import { describe, expect, it } from 'vitest';

import { DrawerPullDetector, type DrawerPullSample } from '@/core/gesture/drawerPull';

/**
 * 抽屉（拉窗帘）的手势判定。
 *
 * 这一组最要紧的两件事：
 *   1. **只认"从顶边拉手条带里起手"的那一下** —— 在别处捏合必须完全不理会，
 *      否则它会去抢正常的抓取/拖动（这个项目最贵的 bug 全是"一个姿势被两件事抢"）；
 *   2. **拉的过程中必须屏蔽指弹** —— 拉到底松手那一帧，`gap` 由小变大、
 *      指尖又在快速移动，指弹的两个条件可能同时成立，不挡就是"拉个抽屉把图删了"。
 */

const FRAME = 1 / 30;
/** 拉手条带里（handleZone 默认 0.2） */
const IN_HANDLE = 0.1;
/** 条带之外 */
const BELOW = 0.6;

function press(y: number, time = 0): DrawerPullSample {
  return { pinching: true, point: { x: 0.5, y }, time };
}

const RELEASE: DrawerPullSample = { pinching: false, point: null, time: 1 };

/** 一路拉到指定高度再松手，返回探测器 */
function pullAndRelease(fromY: number, toY: number): DrawerPullDetector {
  const detector = new DrawerPullDetector();
  detector.update(press(fromY, 0));
  detector.update(press(toY, FRAME));
  detector.update(RELEASE);
  return detector;
}

describe('DrawerPullDetector 拉下来', () => {
  it('在拉手条带里捏合 + 下拉 -> 跟手拉开（进度 = 拖过的距离 / fullDistance）', () => {
    const detector = new DrawerPullDetector();
    detector.update(press(IN_HANDLE, 0));
    expect(detector.isPulling).toBe(true);

    // 0.25 - 0.10 = 0.15，fullDistance 默认 0.3 -> 正好一半
    detector.update(press(IN_HANDLE + 0.15, FRAME));
    expect(detector.pull).toBeCloseTo(0.5, 6);
  });

  it('拉够了松手 -> 保持打开', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.3);
    expect(detector.isOpen).toBe(true);
    expect(detector.pull).toBe(1);
  });

  it('拉得不够就松手 -> 弹回去（不会半开着留在屏幕上）', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.1);
    expect(detector.isOpen).toBe(false);
    expect(detector.isPulling).toBe(false);
    expect(detector.pull).toBe(0);
  });

  it('拉过头也封顶在 1', () => {
    const detector = new DrawerPullDetector();
    detector.update(press(IN_HANDLE, 0));
    detector.update(press(IN_HANDLE + 0.9, FRAME));
    expect(detector.pull).toBe(1);
  });

  it('**条带之外**捏合下拉完全不理（不许抢正常的抓取/拖动）', () => {
    const detector = new DrawerPullDetector();
    detector.update(press(BELOW, 0));
    detector.update(press(BELOW + 0.4, FRAME));

    expect(detector.isPulling).toBe(false);
    expect(detector.isOpen).toBe(false);
    expect(detector.pull).toBe(0);
  });
});

describe('DrawerPullDetector 推回去', () => {
  it('开着时在拉手条带里捏合 + 上推够远 -> 关掉', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.3);
    expect(detector.isOpen).toBe(true);

    detector.update(press(IN_HANDLE, 2 * FRAME)); // 条带里重新起手 = 推手
    detector.update(press(IN_HANDLE - 0.12, 3 * FRAME)); // 上推 0.12 >= closeDistance(0.1)

    expect(detector.isOpen).toBe(false);
    expect(detector.pull).toBe(0);
  });

  it('上推得不够 -> 还开着（防手抖把抽屉关掉）', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.3);

    detector.update(press(IN_HANDLE, 2 * FRAME));
    detector.update(press(IN_HANDLE - 0.04, 3 * FRAME));

    expect(detector.isOpen).toBe(true);
  });

  it('开着时在**抽屉下面**捏合，不该把抽屉关掉（那是正常操作场景）', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.3);
    detector.update(press(BELOW, 2 * FRAME));
    detector.update(press(BELOW - 0.3, 3 * FRAME));

    expect(detector.isOpen).toBe(true);
  });
});

describe('DrawerPullDetector 屏蔽指弹（"拉个抽屉把图删了"的护栏）', () => {
  it('拉的过程中屏蔽；抽屉开着但没在推，就不屏蔽（下面比划指弹是正常操作）', () => {
    const detector = new DrawerPullDetector();
    detector.update(press(IN_HANDLE, 0));
    expect(detector.suppressFlick).toBe(true);

    detector.update(press(IN_HANDLE + 0.3, FRAME));
    detector.update(RELEASE);
    expect(detector.isOpen).toBe(true);
    expect(detector.suppressFlick).toBe(false);

    // 重新起手推回去的过程也要屏蔽
    detector.update(press(IN_HANDLE, 2 * FRAME));
    expect(detector.suppressFlick).toBe(true);
  });

  it('条带之外捏合不屏蔽（那是场景自己的操作）', () => {
    const detector = new DrawerPullDetector();
    detector.update(press(BELOW, 0));
    detector.update(press(BELOW + 0.2, FRAME));
    expect(detector.suppressFlick).toBe(false);
  });
});

describe('DrawerPullDetector 其它', () => {
  it('isInHandleZone 给调用方判断"这一下是操作抽屉还是操作场景"', () => {
    const detector = new DrawerPullDetector();
    expect(detector.isInHandleZone({ x: 0.5, y: IN_HANDLE })).toBe(true);
    expect(detector.isInHandleZone({ x: 0.5, y: BELOW })).toBe(false);
    expect(detector.isInHandleZone(null)).toBe(false);
  });

  it('setOpen 给 UI 上的"收起"按钮用', () => {
    const detector = new DrawerPullDetector();
    detector.setOpen(true);
    expect(detector.isOpen).toBe(true);
    expect(detector.pull).toBe(1);

    detector.setOpen(false);
    expect(detector.isOpen).toBe(false);
    expect(detector.pull).toBe(0);
  });

  it('reset 回到初始状态', () => {
    const detector = pullAndRelease(IN_HANDLE, IN_HANDLE + 0.3);
    detector.reset();
    expect(detector.isOpen).toBe(false);
    expect(detector.isPulling).toBe(false);
    expect(detector.pull).toBe(0);
    expect(detector.suppressFlick).toBe(false);
  });

  it('参数非法时抛错（拉手条带占满整屏之类的配置会让它抢掉所有手势）', () => {
    expect(() => new DrawerPullDetector({ handleZone: 0 })).toThrow(RangeError);
    expect(() => new DrawerPullDetector({ handleZone: 1 })).toThrow(RangeError);
    expect(() => new DrawerPullDetector({ fullDistance: 0 })).toThrow(RangeError);
    expect(() => new DrawerPullDetector({ closeDistance: 0 })).toThrow(RangeError);
  });
});
