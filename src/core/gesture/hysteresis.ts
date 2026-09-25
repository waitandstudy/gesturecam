/**
 * 双阈值迟滞（hysteresis）。
 *
 * 参考文档第三节明确要求：「手势迟滞：进入 pinch 和退出 pinch 使用不同阈值，
 * 降低临界状态抖动」。
 *
 * 为什么必须有：单阈值判定会在临界值附近疯狂翻转。例如捏合距离刚好在阈值上下抖动
 * 1e-3，对象就会"抓住-松开-抓住-松开"每秒几十次，表现为剧烈抖动。
 * 加了迟滞之后，中间地带保持原状态，手感立刻稳定。
 *
 * 两个类分别对应两种单调方向，各自的构造函数会校验阈值方向是否合理 ——
 * 写反了直接抛错，而不是留一个永远不生效的静默 bug。
 */

abstract class HysteresisBase {
  protected _active: boolean;

  constructor(
    readonly enterThreshold: number,
    readonly exitThreshold: number,
    initial = false,
  ) {
    if (!Number.isFinite(enterThreshold) || !Number.isFinite(exitThreshold)) {
      throw new RangeError('阈值必须是有限数');
    }
    this._active = initial;
  }

  get active(): boolean {
    return this._active;
  }

  /** 本次调用是否发生了状态**跳变**（用于产出离散事件）。 */
  protected set(next: boolean): boolean {
    if (next === this._active) return false;
    this._active = next;
    return true;
  }

  reset(active = false): void {
    this._active = active;
  }
}

/**
 * 值**越大越激活**（例如手掌张开程度、两指距离）。
 * 必须 enter > exit，否则会在同一个值上反复翻转。
 */
export class RisingHysteresis extends HysteresisBase {
  constructor(enterThreshold: number, exitThreshold: number, initial = false) {
    super(enterThreshold, exitThreshold, initial);
    if (enterThreshold <= exitThreshold) {
      throw new RangeError(`RisingHysteresis 要求 enter > exit，收到 enter=${enterThreshold} exit=${exitThreshold}`);
    }
  }

  /** @returns 本次调用是否发生了跳变 */
  update(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (this._active) return this.set(value > this.exitThreshold);
    return this.set(value >= this.enterThreshold);
  }
}

/**
 * 值**越小越激活**（例如捏合距离：越近越算捏住）。
 * 必须 enter < exit。
 */
export class FallingHysteresis extends HysteresisBase {
  constructor(enterThreshold: number, exitThreshold: number, initial = false) {
    super(enterThreshold, exitThreshold, initial);
    if (enterThreshold >= exitThreshold) {
      throw new RangeError(`FallingHysteresis 要求 enter < exit，收到 enter=${enterThreshold} exit=${exitThreshold}`);
    }
  }

  /** @returns 本次调用是否发生了跳变 */
  update(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    if (this._active) return this.set(value < this.exitThreshold);
    return this.set(value <= this.enterThreshold);
  }
}
