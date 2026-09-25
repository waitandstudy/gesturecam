import type { NormalizedLandmark, RawHand } from '../hand/handState';

/**
 * One-Euro 滤波（Casiez et al. 2012）。
 *
 * 为什么必须是它，而不是简单的指数平滑：手部关键点有两个互相矛盾的需求 ——
 *   · 手停住不动时要**很稳**（消抖），否则 pinch 会在阈值附近反复触发；
 *   · 手快速拖动时要**跟得上**（低延迟），否则素材像拖着一条橡皮筋。
 * 固定系数的低通滤波只能二选一。One-Euro 的截止频率随速度自适应：
 * 静止时用低截止频率重平滑，快速移动时提高截止频率放行 —— 两个需求同时满足。
 *
 * 参数与默认值来自 handy 的实测经验（`src/smoothing.py`），坐标系口径一致
 * （归一化帧坐标 + ~20-30fps），所以可以直接用：
 *   min_cutoff = 1.2  静止时的平滑强度（越小越稳但越滞后）
 *   beta       = 0.03 快速移动时放松平滑的程度（越大越跟手）
 *   d_cutoff   = 1.0  速度估计本身的平滑
 *
 * 纯数学、无副作用，可在 Node 里单测。
 */

export const DEFAULT_MIN_CUTOFF = 1.2;
export const DEFAULT_BETA = 0.03;
export const DEFAULT_D_CUTOFF = 1.0;

/** 时间戳不递增时的兜底 dt，避免除零。 */
const MIN_DT = 1e-3;

/**
 * 判定"这已经不是同一只手的连续轨迹"的手腕跳变阈值（占整帧宽度的比例）。
 *
 * 手在 33ms 内不可能移动画面的 1/4（挥手大约 0.05–0.1），所以超过它一定是
 * 重新捕获而不是真实运动。阈值给得宽松是刻意的：宁可漏判（只是多一点平滑滞后），
 * 也不要误判（把真实的快速挥手当跳变，反而丢掉平滑）。
 */
export const REACQUIRE_JUMP = 0.25;

export interface OneEuroOptions {
  minCutoff?: number;
  beta?: number;
  dCutoff?: number;
}

/** 给定截止频率与时间步长，算出低通系数。 */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  private _value: number | null = null;
  private _derivative = 0;
  private _time: number | null = null;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? DEFAULT_MIN_CUTOFF;
    this.beta = options.beta ?? DEFAULT_BETA;
    this.dCutoff = options.dCutoff ?? DEFAULT_D_CUTOFF;

    if (!(this.minCutoff > 0) || !(this.dCutoff > 0) || this.beta < 0) {
      throw new RangeError('One-Euro 参数非法：要求 minCutoff > 0、dCutoff > 0、beta >= 0');
    }
  }

  /** 忘记历史。信号源消失时必须调用（见 LandmarkSmoother）。 */
  reset(): void {
    this._value = null;
    this._derivative = 0;
    this._time = null;
  }

  get hasHistory(): boolean {
    return this._value !== null;
  }

  /** 当前平滑值；还没有任何历史时为 null。用于"跳变 = 重新捕获"的检测。 */
  get value(): number | null {
    return this._value;
  }

  filter(value: number, timestampSeconds: number): number {
    if (!Number.isFinite(value)) return this._value ?? 0;

    if (this._value === null || this._time === null) {
      this._value = value;
      this._time = timestampSeconds;
      return value;
    }

    let dt = timestampSeconds - this._time;
    if (!(dt > 0)) dt = MIN_DT;

    const derivative = (value - this._value) / dt;
    const smoothedDerivative = this._derivative + alpha(this.dCutoff, dt) * (derivative - this._derivative);
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    const next = this._value + alpha(cutoff, dt) * (value - this._value);

    this._value = next;
    this._derivative = smoothedDerivative;
    this._time = timestampSeconds;
    return next;
  }
}

/**
 * 整只手的 One-Euro 平滑：每只手一个滤波组，每个关键点 3 个分量各一个滤波器。
 *
 * 关键细节（来自 handy）：**某一帧该 slot 没有手时，整组滤波器必须 reset**。
 * 否则手离开画面再回来，滤波器会带着"离开前那一刻"的陈旧状态，
 * 表现为手一出现就从旧位置"滑"过来。
 *
 * 另一个关键点：`smooth()` 是**保槽位**的 —— 输入输出长度都等于槽位数，
 * 缺席的槽位用 `undefined` 占位。第一版是"只返回有手的那些"，在单手时看不出问题，
 * 双手时就致命了：slot 0 缺席、slot 1 有手时，输出数组的第 0 项其实是右手，
 * 于是右手的滤波状态被塞进左手那个槽，位置会从左手上一帧的地方滑过来。
 */
export class LandmarkSmoother {  /** slots[手][关键点][x, y, z] */
  private readonly banks: OneEuroFilter[][][];

  constructor(numHands = 1, landmarksPerHand = 21, options: OneEuroOptions = {}) {
    if (!Number.isFinite(numHands) || numHands < 1) {
      throw new RangeError(`numHands 必须 >= 1，收到 ${numHands}`);
    }
    this.banks = Array.from({ length: numHands }, () =>
      Array.from({ length: landmarksPerHand }, () => [
        new OneEuroFilter(options),
        new OneEuroFilter(options),
        new OneEuroFilter(options),
      ]),
    );
  }

  /** 全部忘记历史（例如手部追踪被关掉/重启）。 */
  reset(): void {
    for (const bank of this.banks) {
      for (const filters of bank) for (const filter of filters) filter.reset();
    }
  }

  /**
   * 按槽位平滑。输入输出的长度都等于构造时的槽位数，缺席槽位为 `undefined`。
   * @param hands 长度 <= 槽位数；第 i 项是该槽位这一帧的手（没有就传 undefined）
   */
  smooth(hands: readonly (RawHand | undefined)[], timestampSeconds: number): (RawHand | undefined)[] {
    return this.banks.map((bank, slot) => {
      const hand = hands[slot];
      if (!hand) {
        // 该 slot 这一帧没有手 -> 整组重置，避免陈旧状态渗到下一次出现
        for (const filters of bank) for (const filter of filters) filter.reset();
        return undefined;
      }
      return this.smoothHand(bank, hand, timestampSeconds);
    });
  }

  private smoothHand(bank: OneEuroFilter[][], hand: RawHand, timestampSeconds: number): RawHand {
    /*
     * "跳变 = 重新捕获" 检测。
     *
     * 手不可能在 33ms 内移动画面的 1/4。超过这个幅度就说明这**不是同一只手的连续轨迹**：
     * MediaPipe 偶尔会把左右手认反、或在一只手短暂丢失后于别处重新捕获。
     * 这时必须整组重置 —— 否则滤波器要花约 0.4 秒"滑"过去，
     * 而双手缩放的基准间距恰好在这段时间里被采样：基准偏小 -> 素材一捏上第二只手就自己变大
     * （真机复现过）。重置之后第一帧直接采用新位置，基准取到的是真实间距。
     *
     * 用**手腕**当参照：它是整只手里最稳的点（手指姿态变化不影响它）。
     */
    const wrist = hand.landmarks[0]?.position;
    const [wristX, wristY] = bank[0] ?? [];
    if (wrist && wristX?.value !== null && wristX?.value !== undefined && wristY?.value !== null && wristY?.value !== undefined) {
      const dx = wrist.x - wristX.value;
      const dy = wrist.y - wristY.value;
      if (Math.hypot(dx, dy) > REACQUIRE_JUMP) {
        for (const filters of bank) for (const filter of filters) filter.reset();
      }
    }

    const landmarks: NormalizedLandmark[] = hand.landmarks.map((landmark, index) => {
      const filters = bank[index];
      if (!filters) return landmark;
      const [fx, fy, fz] = filters;
      return {
        position: {
          x: fx ? fx.filter(landmark.position.x, timestampSeconds) : landmark.position.x,
          y: fy ? fy.filter(landmark.position.y, timestampSeconds) : landmark.position.y,
        },
        z: fz ? fz.filter(landmark.z, timestampSeconds) : landmark.z,
        visibility: landmark.visibility,
      };
    });

    return { landmarks, handedness: hand.handedness, confidence: hand.confidence };
  }
}
