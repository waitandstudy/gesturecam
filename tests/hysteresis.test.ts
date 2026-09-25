import { describe, expect, it } from 'vitest';

import { FallingHysteresis, RisingHysteresis } from '@/core/gesture/hysteresis';

describe('FallingHysteresis（值越小越激活，例如捏合距离）', () => {
  it('阈值方向写反时直接抛错', () => {
    expect(() => new FallingHysteresis(0.5, 0.3)).toThrow(RangeError);
    expect(() => new FallingHysteresis(0.3, 0.3)).toThrow(RangeError);
  });

  it('进入用 enter 阈值，退出用 exit 阈值', () => {
    const gate = new FallingHysteresis(0.3, 0.45);

    expect(gate.update(0.31)).toBe(false);
    expect(gate.active).toBe(false);

    expect(gate.update(0.29)).toBe(true);
    expect(gate.active).toBe(true);

    // 中间地带保持激活 —— 这正是迟滞要解决的问题
    expect(gate.update(0.4)).toBe(false);
    expect(gate.active).toBe(true);

    expect(gate.update(0.46)).toBe(true);
    expect(gate.active).toBe(false);
  });

  it('在临界值附近抖动时不会来回翻转', () => {
    const gate = new FallingHysteresis(0.3, 0.45);
    gate.update(0.29);

    let transitions = 0;
    for (let i = 0; i < 200; i += 1) {
      // 在 0.30 上下抖 ±0.001
      if (gate.update(0.3 + (i % 2 === 0 ? 0.001 : -0.001))) transitions += 1;
    }

    expect(transitions).toBe(0);
    expect(gate.active).toBe(true);
  });

  it('非有限值被忽略，不改变状态', () => {
    const gate = new FallingHysteresis(0.3, 0.45, true);
    expect(gate.update(Number.NaN)).toBe(false);
    expect(gate.active).toBe(true);
  });

  it('reset 可以强制状态', () => {
    const gate = new FallingHysteresis(0.3, 0.45);
    gate.reset(true);
    expect(gate.active).toBe(true);
  });
});

describe('RisingHysteresis（值越大越激活，例如张开程度）', () => {
  it('阈值方向写反时直接抛错', () => {
    expect(() => new RisingHysteresis(0.3, 0.5)).toThrow(RangeError);
  });

  it('进入用 enter 阈值，退出用 exit 阈值', () => {
    const gate = new RisingHysteresis(0.7, 0.5);

    expect(gate.update(0.6)).toBe(false);
    expect(gate.update(0.7)).toBe(true);
    expect(gate.update(0.55)).toBe(false);
    expect(gate.active).toBe(true);
    expect(gate.update(0.4)).toBe(true);
    expect(gate.active).toBe(false);
  });

  it('非有限阈值抛错', () => {
    expect(() => new RisingHysteresis(Number.NaN, 0.5)).toThrow(RangeError);
  });
});
