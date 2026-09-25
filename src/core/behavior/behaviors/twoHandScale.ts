import type { Behavior, BehaviorContext, BehaviorStage } from '../behavior';
import type { BehaviorManager } from '../manager';

export const TWO_HAND_SCALE_BEHAVIOR_TYPE = 'two-hand-scale';

/**
 * TWO_HAND_SCALE —— 双手捏合：一只手把素材拿着，两只手一起张开/收拢来放大/缩小。
 *
 * ## 为什么从单手改成了双手
 *
 * 第一版用"单手捏合间距"控制大小（需求文档第四节 C 的字面做法）。真机上被反复反馈
 * "缩放不好把控、捏着的时候图片一直放大缩小地颤"。根因是几何上的：
 *
 *   单只手的捏合同时编码了**两个**自由度 —— 拇指尖与食指尖的**中点**是位置，
 *   两者**距离**是大小。用户想只改大小，但手指的运动学根本做不到：一开合，
 *   中点必然跟着漂，手一抖两个量一起变。这就是"不好操控"的本质。
 *
 *   更糟的是信噪比。单手捏合间距只有约 **0.03 个画幅宽**，而 One-Euro 滤波后
 *   残余抖动仍在 ±0.003 量级 —— 相对噪声 **10%**。于是 ±0.03 的手抖被放大成
 *   ±10% 的尺寸振荡，看起来就是"震颤"。第一版为此堆了三轮"基准冻结"逻辑
 *   （固定延迟 → 判定 smoothed≈raw → 判定速率阈值），每一轮都只是把抖动换个形式暴露出来。
 *
 * 双手把这两个自由度**真正解耦**：位置由两手中点（或单手拖动）决定，大小由两手间距决定。
 * 而且两手间距约 **0.4 个画幅宽**，同样的绝对噪声除以大一个数量级的基准，
 * **相对误差小十倍** —— 震颤的根因消失了，那套脆弱的冻结逻辑也一并删掉。
 *
 * ## 参数
 *
 * 1. **以会话开始时的 scale 为基准**（`baseScale`），不是在当前 scale 上累乘。
 *    累乘会让比例逐帧叠加，手停住素材也停不下来。
 * 2. **死区**：两手间距相对起始间距的变化小于 `deadZone` 时完全不缩放。
 *    否则"第二只手刚搭上来"的微小动作就会让素材莫名变大一点。
 *    注意双手方案的死区可以开得比单手小（因为噪声本来就小），响应更跟手。
 * 3. **上下限**：太小看不清、太大盖满画面。
 * 4. **输出平滑**：`1 − exp(−dt/τ)`，与帧率无关。
 *    输入侧已经平滑过，这一层是让尺寸变化带点"重量"，不是用来压抖动的。
 */
export interface TwoHandScaleConfig {
  /** 缩放倍率下限（乘在 size.width 上的倍率） */
  minScale?: number;
  /** 缩放倍率上限 */
  maxScale?: number;
  /** 死区：两手间距比例相对会话开始的变化小于它就不缩放 */
  deadZone?: number;
  /**
   * 输出平滑的时间常数（秒）。0 = 立即到位。
   * 用 `1 - exp(-dt/tau)` 计算逼近系数，保证与帧率无关。
   */
  smoothing?: number;
}

const DEFAULT_MIN_SCALE = 0.15;
const DEFAULT_MAX_SCALE = 5;
/**
 * 5% 的间距变化才开始缩放。
 * 单手方案要 8% 才敢动（噪声大），双手的间距信噪比高一个数量级，所以可以更灵敏。
 */
const DEFAULT_DEAD_ZONE = 0.05;
/** 50ms 时间常数：比单手的 60ms 更快一点，双手操作本身就更精确 */
const DEFAULT_SMOOTHING = 0.05;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class TwoHandScaleBehavior implements Behavior {
  readonly type = TWO_HAND_SCALE_BEHAVIOR_TYPE;
  readonly stage: BehaviorStage = 'input';

  private readonly minScale: number;
  private readonly maxScale: number;
  private readonly deadZone: number;
  private readonly smoothing: number;
  /** 本次抓取开始时的 scale，作为缩放的绝对基准 */
  private scaleAtGrab: number | null = null;
  /** 双手会话开始时已应用到的大小（比例乘在它上面） */
  private baseScale: number | null = null;
  /** 已经实际应用到的 scale（输出平滑用） */
  private appliedScale: number | null = null;

  constructor(config: TwoHandScaleConfig = {}) {
    this.minScale = config.minScale ?? DEFAULT_MIN_SCALE;
    this.maxScale = config.maxScale ?? DEFAULT_MAX_SCALE;
    this.deadZone = config.deadZone ?? DEFAULT_DEAD_ZONE;
    this.smoothing = config.smoothing ?? DEFAULT_SMOOTHING;

    if (!(this.minScale > 0)) throw new RangeError('minScale 必须是正数');
    if (!(this.maxScale > this.minScale)) throw new RangeError('要求 0 < minScale < maxScale');
    if (!(this.deadZone >= 0)) throw new RangeError('deadZone 必须是非负数');
    if (!(this.smoothing >= 0)) throw new RangeError('smoothing 必须是非负数');
  }

  serialize(): TwoHandScaleConfig {
    return {
      minScale: this.minScale,
      maxScale: this.maxScale,
      deadZone: this.deadZone,
      smoothing: this.smoothing,
    };
  }

  onDetach(): void {
    this.scaleAtGrab = null;
    this.baseScale = null;
    this.appliedScale = null;
  }

  update(context: BehaviorContext): void {
    const { interaction, object, dt } = context;

    // 松手就结束会话；下次抓取会以当时的 scale 重新定基准
    if (!interaction.grabbed) {
      this.scaleAtGrab = null;
      this.baseScale = null;
      this.appliedScale = null;
      return;
    }

    // 素材自己声明了不可缩放（参考文档第五节 Interaction 配置）-> 只跟随，不改大小
    if (!object.state.interaction.scalable) return;

    if (this.scaleAtGrab === null) {
      this.scaleAtGrab = object.state.scale;
      this.appliedScale = object.state.scale;
    }

    const twoHand = interaction.twoHand;

    // 双手会话结束（第二只手离开/松开）：大小**停在当前值**，不做任何回弹。
    // 同时清掉基准，等下一次双手会话重新以"当时的大小"定基准 ——
    // 否则下次张开手会跳回上一轮的比例。
    if (!twoHand.active) {
      this.baseScale = null;
      return;
    }

    if (this.baseScale === null) {
      this.baseScale = this.appliedScale ?? this.scaleAtGrab;
    }

    const ratio = twoHand.distanceRatio;
    const desired =
      Math.abs(ratio - 1) < this.deadZone
        ? // 死区内：回到会话开始时的大小，而不是保留上一帧的中间值
          this.baseScale
        : clamp(this.baseScale * ratio, this.minScale, this.maxScale);

    const applied = this.appliedScale ?? desired;
    const next =
      this.smoothing > 0
        ? applied + (desired - applied) * (1 - Math.exp(-Math.max(dt, 0) / this.smoothing))
        : desired;

    this.appliedScale = next;
    object.setScale(next);
  }
}

export function registerTwoHandScaleBehavior(manager: BehaviorManager): void {
  manager.register(
    TWO_HAND_SCALE_BEHAVIOR_TYPE,
    (config) => new TwoHandScaleBehavior((config ?? {}) as TwoHandScaleConfig),
  );
}
