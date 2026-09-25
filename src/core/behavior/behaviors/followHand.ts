import type { Behavior, BehaviorContext, BehaviorStage } from '../behavior';
import { BehaviorManager } from '../manager';

export const FOLLOW_HAND_BEHAVIOR_TYPE = 'follow-hand';

/**
 * FOLLOW_HAND —— 抓住之后素材跟着手走。
 *
 * 这是 Phase 4 的核心行为，也是"手势控制素材"这句话真正落地的地方：
 * **交互层只负责算出 `targetPosition`（素材该去哪），移动素材是行为的职责。**
 * （之前这里缺了这一环，导致捏合能抓成功但图片纹丝不动。）
 *
 * 三个参数决定了手感，缺一个都会不满意：
 *
 * 1. **死区 deadZone**：手指的微小位移直接忽略。没有它，手静止时的残余抖动
 *    会让素材持续"呼吸"，看起来像没夹稳。
 * 2. **增益 gain**：素材位移 = 手指位移 × gain。1 是硬跟手；小于 1 时手指要移动更远
 *    才能把素材推到同样的位置，做精细摆放更容易（手指在镜头前的大幅移动被压缩）。
 * 3. **平滑 smoothing**：让素材用指数逼近目标，而不是瞬间焊死在手指上。
 *    时间常数 0 就是刚性跟随；0.03 秒左右既有"重量感"又不会觉得拖。
 *    逼近系数用 `1 - exp(-dt/tau)` 计算，所以**与帧率无关** ——
 *    60fps 和 30fps 下的手感一致（用固定 alpha 的 lerp 在掉帧时会明显变慢）。
 *
 * 死区和增益都作用在"抓取以来的累计位移"上，而不是每帧增量上。
 * 否则 gain < 1 时素材永远追不上手指（每帧只走剩余距离的一部分，会稳定在一个偏差上）。
 */
export interface FollowHandConfig {
  /** 死区，单位是场景坐标（占输出画幅宽度的比例） */
  deadZone?: number;
  /** 增益，1 = 硬跟手 */
  gain?: number;
  /** 跟随平滑的时间常数（秒），0 = 刚性跟随 */
  smoothing?: number;
}

const DEFAULT_DEAD_ZONE = 0.006;
const DEFAULT_GAIN = 1;
const DEFAULT_SMOOTHING = 0.03;

/** 一次抓取会话的锚点：抓取瞬间的素材位置与手指位置，用来算"累计位移"。 */
interface GrabSession {
  /** 抓取瞬间素材所在位置 */
  objectStart: { x: number; y: number };
  /** 抓取瞬间手指所在位置 */
  targetStart: { x: number; y: number };
  /** 当前已经应用到的位置（平滑用） */
  applied: { x: number; y: number };
}

export class FollowHandBehavior implements Behavior {
  readonly type = FOLLOW_HAND_BEHAVIOR_TYPE;
  readonly stage: BehaviorStage = 'input';

  private readonly deadZone: number;
  private readonly gain: number;
  private readonly smoothing: number;
  private session: GrabSession | null = null;

  constructor(config: FollowHandConfig = {}) {
    this.deadZone = config.deadZone ?? DEFAULT_DEAD_ZONE;
    this.gain = config.gain ?? DEFAULT_GAIN;
    this.smoothing = config.smoothing ?? DEFAULT_SMOOTHING;

    if (!Number.isFinite(this.deadZone) || this.deadZone < 0) {
      throw new RangeError('deadZone 必须是非负有限数');
    }
    if (!Number.isFinite(this.gain) || this.gain <= 0) {
      throw new RangeError('gain 必须是正有限数');
    }
    if (!Number.isFinite(this.smoothing) || this.smoothing < 0) {
      throw new RangeError('smoothing 必须是非负有限数');
    }
  }

  /** 配置回序列化（场景保存时要能重建行为）。 */
  serialize(): FollowHandConfig {
    return { deadZone: this.deadZone, gain: this.gain, smoothing: this.smoothing };
  }

  onDetach(): void {
    this.session = null;
  }

  update(context: BehaviorContext): void {
    const { interaction, object, dt } = context;

    // 没被抓住 -> 会话结束，素材停在原地
    if (!interaction.grabbed) {
      this.session = null;
      return;
    }

    // 抓住了但暂时拿不到手指位置（手丢失宽限期）：
    // 冻结在当前位置，既不要乱跟，也不要重置会话（否则手回来时会跳）。
    const target = interaction.targetPosition;
    if (!target) return;

    if (!this.session) {
      this.session = {
        objectStart: { x: object.state.position.x, y: object.state.position.y },
        targetStart: { x: target.x, y: target.y },
        applied: { x: object.state.position.x, y: object.state.position.y },
      };
    }

    const session = this.session;
    const rawX = target.x - session.targetStart.x;
    const rawY = target.y - session.targetStart.y;

    // 死区 + 增益都作用在"抓取以来的累计位移"上
    const desired =
      Math.hypot(rawX, rawY) < this.deadZone
        ? session.objectStart
        : {
            x: session.objectStart.x + rawX * this.gain,
            y: session.objectStart.y + rawY * this.gain,
          };

    if (this.smoothing > 0) {
      // 与帧率无关的指数逼近：dt 越大走完的比例越大，掉帧时手感不会变慢
      const k = 1 - Math.exp(-Math.max(dt, 0) / this.smoothing);
      session.applied = {
        x: session.applied.x + (desired.x - session.applied.x) * k,
        y: session.applied.y + (desired.y - session.applied.y) * k,
      };
    } else {
      session.applied = { x: desired.x, y: desired.y };
    }

    object.setPosition(session.applied);
  }
}

export function registerFollowHandBehavior(manager: BehaviorManager): void {
  manager.register(FOLLOW_HAND_BEHAVIOR_TYPE, (config) => new FollowHandBehavior((config ?? {}) as FollowHandConfig));
}
