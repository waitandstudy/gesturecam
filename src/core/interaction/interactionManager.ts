import type { Viewport } from '../coords/viewport';
import type { HandShape } from '../gesture/handShape';
import type { ContinuousGestures, GestureState, PinchState } from '../gesture/types';
import type { Handedness } from '../hand/handState';
import type { Vec2 } from '../math/vec2';
import { hitTestObject } from '../scene/geometry';
import type { SceneObject } from '../scene/object';
import type { ObjectState } from '../scene/types';
import {
  createIdleInteractionState,
  createIdleTwoHandState,
  IDLE_INTERACTION_STATE,
  type InteractionSnapshot,
  type ObjectInteractionState,
  type TwoHandInteractionState,
} from './types';

export interface InteractionUpdateParams {
  /** 距上一帧的秒数 */
  dt: number;
  /** 场景时间（秒） */
  time: number;
  /** 手势层本帧的输出；还没有接入手势识别时为 null */
  gestures: GestureState | null;
  /** 命中测试要用它把场景坐标换算成屏幕坐标 */
  viewport: Viewport;
  /** 场景内所有素材，**按绘制顺序（zIndex 升序）**传入 */
  objects: readonly SceneObject[];
  /** 纹理宽高比解析器（命中测试需要考虑素材真实形状）。缺省当正方形处理。 */
  aspectOf?: (state: Readonly<ObjectState>) => number;
}

export interface InteractionManagerOptions {
  /**
   * 手消失多久之后自动释放（秒）。
   *
   * 手甩出画面时 MediaPipe 会有若干帧识别不到手；立刻释放会让素材在半空中突然停住。
   * 给一点宽限时间手感更连贯，而且**宽限期内素材是冻结的**，恢复时还会重锚（见下）。
   * 注意"捏合结束"是由 `gesture-end` 事件即刻触发的，这个超时**只**用于"手整只丢了"。
   */
  releaseTimeoutSeconds?: number;
  /**
   * 抓取起手的宽容边距，占输出画幅短边的比例（handy: `GRAB_HIT_MARGIN_FRAC = 0.06`）。
   * 手机上手指更粗、素材更小，所以略放宽到 8%。
   */
  grabHitMarginFrac?: number;
  /**
   * 抓取起手后多久之内允许"手移到素材上才抓住"（秒）。
   * 现实里用户常常先捏上、再把手移到图片上，只认"捏合起点落在素材上"会让人感觉抓不住。
   */
  grabEntryWindowSeconds?: number;
  /**
   * "待重新武装"最多持续多久（秒），默认 1.5。
   * 这是安全阀：手型判定卡住时不能把应用永久锁死。
   */
  rearmTimeoutSeconds?: number;
  /** 指弹删除的淡出期（秒），默认 2。期间再捏住素材即可撤销 */
  deleteGraceSeconds?: number;
}

interface InteractionRecord {
  state: ObjectInteractionState;
  /** 已经连续多少秒没拿到手指位置（> 0 表示刚从一次"手丢失"里恢复） */
  sinceCursorLost: number;
  /** 双手缩放是否已经激活 */
  twoHandActive: boolean;
  /** 第二只手加入时的两手间距，作为缩放基准 */
  twoHandStartDistance: number | null;
  /** 第二只手加入时素材相对两手中点的偏移，保证位置跟随时素材不跳 */
  twoHandOffset: Vec2;
}

const DEFAULT_RELEASE_TIMEOUT_SECONDS = 0.25;
/** 输出画幅短边的 8%（handy 是 6%，手机上手指更粗所以略放宽） */
const DEFAULT_GRAB_HIT_MARGIN_FRAC = 0.08;
const DEFAULT_GRAB_ENTRY_WINDOW_SECONDS = 0.7;
/**
 * 指弹删除的**淡出期**（秒）。
 *
 * 指弹是破坏性操作：手一弹就消失的话，误弹一次就只能重新加图（录到一半尤其致命）。
 * 所以弹中之后素材进入约 2 秒的淡出期 —— 半透明留在原地，
 * **期间再捏住它就等于撤销**，时间到才真正移除。
 */
const DEFAULT_DELETE_GRACE_SECONDS = 2;
/**
 * "待重新武装"最多持续多久（秒）。
 *
 * 安全阀：手型判定万一卡在握拳上，没有它用户就再也抓不住任何东西。
 * 1.5 秒足够覆盖"取消动作本身顺手抓回一张图"那个窗口，又不至于让人等到烦。
 */
const DEFAULT_REARM_TIMEOUT_SECONDS = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 取素材当前位置（重锚定时要用）。 */
function findPosition(objects: readonly SceneObject[], objectId: string): Vec2 | null {
  for (const object of objects) {
    if (object.id === objectId) return { x: object.state.position.x, y: object.state.position.y };
  }
  return null;
}

/**
 * 交互管理器 —— 把手势语义落到具体素材上。
 *
 * 职责边界（严格遵守参考文档第九节）：
 *   ✅ 命中测试 / 抓取会话 / 抓取偏移 / 双手缩放会话 / 准星目标
 *   ❌ 不修改素材位置或大小 —— 怎么动由 Behavior 决定
 *
 * 最后这条是刻意的：InteractionManager 只产出"目标位置"和"两手间距倍率"，
 * 于是"硬跟手""弹簧跟手""带惯性和摩擦地跟手"可以共用同一套抓取逻辑，
 * 换手感只需要换 Behavior。
 *
 * 缩放为什么改成双手：单只手的捏合同时表达了位置和大小，两个自由度本质耦合
 * （间距一变，捏合中点跟着动 → 素材同时漂移；手一抖两个都变）。
 * 双手是干净的解耦，而且两手间距比单手捏合间距大一个数量级，
 * 相对噪声小十倍（详见 types.ts 里 `TwoHandInteractionState` 的说明）。
 */
export class InteractionManager implements InteractionSnapshot {
  private readonly _records = new Map<string, InteractionRecord>();
  private readonly _releaseTimeout: number;
  private readonly _grabHitMarginFrac: number;
  private readonly _grabEntryWindow: number;
  private _time = 0;
  /** 本次捏合开始的时间（秒）；没在捏合时为 null。用于"移到素材上才抓住"的窗口 */
  private _pinchStartedAt: number | null = null;
  /** 现在捏合会抓到哪个素材（屏幕上的准星提示用，和真实抓取走同一套判定） */
  private _previewTargetId: string | null = null;
  /** 是否处于"刚被急停取消、必须先松开手"的状态 */
  private _rearmRequired = false;
  /** 哪些手必须离开捏合/握拳状态，才解除上面那个状态 */
  private readonly _rearmBlocked = new Set<Handedness>();
  /** 进入"待重新武装"的时刻；配 `rearmTimeoutSeconds` 做安全阀 */
  private _rearmSince = 0;
  /**
   * 重新武装最多拦住多久（秒）。
   *
   * 这是一个**安全阀**，不是功能：手型判定万一卡在"握拳"上，
   * 没有它用户就再也抓不住任何东西了（真机反馈过这个现象）。
   */
  private readonly _rearmTimeoutSeconds: number;
  /** 指弹删除的淡出期（秒） */
  private readonly _deleteGraceSeconds: number;
  /**
   * 正在淡出（待删除）的素材：id -> 剩余秒数。
   *
   * 放在交互层而不是直接删对象：交互层负责"这次删除还算不算数"
   * （撤销、超时），**真正从场景里移除**由 Scene 做 —— 它才是对象树的拥有者。
   */
  private readonly _deletions = new Map<string, number>();
  /** 本帧到期、等着 Scene 移除的素材 id */
  private _expiredDeletions: string[] = [];
  /** 取消的原因（目前只有握拳；留着是为了调试与将来扩展） */
  private _cancelReason: 'fist' | null = null;

  constructor(options: InteractionManagerOptions = {}) {
    this._releaseTimeout = options.releaseTimeoutSeconds ?? DEFAULT_RELEASE_TIMEOUT_SECONDS;
    this._grabHitMarginFrac = options.grabHitMarginFrac ?? DEFAULT_GRAB_HIT_MARGIN_FRAC;
    this._grabEntryWindow = options.grabEntryWindowSeconds ?? DEFAULT_GRAB_ENTRY_WINDOW_SECONDS;
    this._rearmTimeoutSeconds = options.rearmTimeoutSeconds ?? DEFAULT_REARM_TIMEOUT_SECONDS;
    this._deleteGraceSeconds = options.deleteGraceSeconds ?? DEFAULT_DELETE_GRACE_SECONDS;

    if (!Number.isFinite(this._grabHitMarginFrac) || this._grabHitMarginFrac < 0) {
      throw new RangeError('grabHitMarginFrac 必须是非负有限数');
    }
    if (!Number.isFinite(this._releaseTimeout) || this._releaseTimeout < 0) {
      throw new RangeError('releaseTimeoutSeconds 必须是非负有限数');
    }
    if (!Number.isFinite(this._grabEntryWindow) || this._grabEntryWindow < 0) {
      throw new RangeError('grabEntryWindowSeconds 必须是非负有限数');
    }
    if (!Number.isFinite(this._rearmTimeoutSeconds) || this._rearmTimeoutSeconds <= 0) {
      throw new RangeError('rearmTimeoutSeconds 必须是正有限数');
    }
    if (!Number.isFinite(this._deleteGraceSeconds) || this._deleteGraceSeconds <= 0) {
      throw new RangeError('deleteGraceSeconds 必须是正有限数');
    }
  }

  get time(): number {
    return this._time;
  }

  get size(): number {
    return this._records.size;
  }

  /** 未知素材返回只读的 idle 兜底值，所以行为里不需要判空。 */
  get(objectId: string): Readonly<ObjectInteractionState> {
    return this._records.get(objectId)?.state ?? IDLE_INTERACTION_STATE;
  }

  /**
   * 此刻捏合会抓到哪个素材（没抓住任何东西时也有效）。
   * 屏幕上的准星用它高亮"现在捏下去会抓到谁" —— 用的是与真实抓取完全相同的判定。
   */
  get previewTargetId(): string | null {
    return this._previewTargetId;
  }

  /** 刚被握拳取消、必须先松开手才能重新抓取。 */
  get rearmRequired(): boolean {
    return this._rearmRequired;
  }

  /** 有几个素材正在"弹掉了但还能撤销"的淡出期。 */
  get deletingCount(): number {
    return this._deletions.size;
  }

  /** 取消原因（调试用）。 */
  get cancelReason(): 'fist' | null {
    return this._cancelReason;
  }

  /**
   * 双手缩放会话的调试快照（调试叠层与真机排查用）。
   *
   * 只汇报**当前被抓住的那个素材**上的会话：一次只抓一个素材，而双手缩放
   * 在语义上也只能作用在一个素材上，所以取第一个抓取会话就够。
   */
  get twoHandDebug(): { active: boolean; startDistance: number | null; distanceRatio: number | null } {
    for (const record of this._records.values()) {
      if (!record.state.grabbed) continue;
      return {
        active: record.twoHandActive,
        startDistance: record.twoHandStartDistance,
        distanceRatio: record.twoHandActive ? record.state.twoHand.distanceRatio : null,
      };
    }
    return { active: false, startDistance: null, distanceRatio: null };
  }

  grabbedIds(): string[] {
    const ids: string[] = [];
    for (const record of this._records.values()) {
      if (record.state.grabbed) ids.push(record.state.objectId);
    }
    return ids;
  }

  list(): readonly Readonly<ObjectInteractionState>[] {
    return [...this._records.values()].map((record) => record.state);
  }

  reset(): void {
    this._records.clear();
    this._deletions.clear();
    this._expiredDeletions = [];
    this._pinchStartedAt = null;
    this._previewTargetId = null;
    this._rearmRequired = false;
    this._rearmBlocked.clear();
    this._cancelReason = null;
  }

  update(params: InteractionUpdateParams): void {
    const { dt, time, objects } = params;
    this._time = time;

    // 1) 一次性标记只存活一帧
    for (const record of this._records.values()) {
      record.state.transition = 'none';
      record.state.releasedByTimeout = false;
    }

    // 2) 素材已被删除 -> 它的交互状态没有意义了
    if (this._records.size > 0) {
      const alive = new Set<string>();
      for (const object of objects) alive.add(object.id);
      for (const id of [...this._records.keys()]) {
        if (!alive.has(id)) this._records.delete(id);
      }
    }

    const controls = params.gestures?.controls ?? null;
    const events = params.gestures?.events ?? [];
    const flicks = params.gestures?.flicks ?? [];
    /**
     * 准星点：拇指尖-食指尖中点，**没捏合时也有**。
     * 准星要在用户"还没捏下去"的时候就能告诉他"捏下去会抓到谁"。
     */
    const previewPoint = controls?.pinchPoint ?? null;

    /*
     * 2.5) 指弹：把这只手**抓着的那张**弹掉；没抓着就弹掉指尖下的那一张。
     *
     * 为什么"手里那张"优先：第五轮真机标定确认，指弹的蓄力姿势（拇指扣住食指尖）
     * 在本项目里**就是捏合**（真机 gap 0.45，面板判 `pinch ACTIVE`），
     * 所以"对着目标图弹"必然先把它抓起来。原来的 `if (grabbing) continue`
     * 会让真机上**永远删不掉** —— 那句话的理由（"装填态要求拇指不参与，
     * 已经挡住了捏合"）现在不成立了。而且"手里那张"比"指尖下最上层"更贴合意图。
     *
     * 放在"握拳急停"之前：指弹是**主动操作**，而急停只是取消；
     * 一帧里两者同时出现的话（比如弹完顺手握拳），先记下删除更符合意图。
     */
    for (const flick of flicks) {
      const held = this.grabbedIds().find(
        (id) => this._records.get(id)?.state.grabbedBy === flick.hand,
      );
      if (held !== undefined) this.startDeletion(held, params);
      else this.beginDelete(flick.position, params);
    }

    // 3) 握拳急停：**只停这只手自己的会话**（另一只手的操作不受影响 —— 见 cancelByHand）
    if (controls) {
      for (const hand of controls.fistHands) this.cancelByHand(hand, controls);
    }

    // 3.2) 重新武装：直到当初"挡住"的手都不再捏合/握拳，才允许新的抓取。
    //      不加这道门槛的话，取消动作本身（手指还停在捏合位置）会立刻抓回一张图。
    this.updateRearm(controls);

    // 3.3) 推进淡出：到期的记下来，交给 Scene 真正移除
    this.updateDeletions(dt, objects);
    // 刷新"是否在淡出中"（放在指弹与推进之后，保证同一帧就生效）
    for (const record of this._records.values()) {
      const active = this._deletions.has(record.state.objectId);
      record.state.deleting = {
        active,
        progress: active ? this.deletionProgress(record.state.objectId) : 0,
      };
    }

    // 3.4) 离散事件：开始 / 结束抓取
    for (const event of events) {
      if (event.gesture !== 'pinch') continue;
      if (event.type === 'gesture-start') {
        this._pinchStartedAt = time;
        if (!this._rearmRequired) this.beginGrab(event.position, event.hand, params);
      } else {
        this._pinchStartedAt = null;
        this.release(event.hand);
      }
    }

    /*
     * 3.5) "移到素材上才抓住" 的宽限窗口。
     *
     * 现实里用户的动作顺序常常是"先捏上、再把手移到图片上"，而不是精确地
     * "在图片上方起手捏合"。严密只认后者会让人强烈感觉抓不住。
     */
    if (controls && this._pinchStartedAt !== null && !this._hasGrab() && !this._rearmRequired) {
      const entering = this.resolveCursor(controls, null);
      if (
        entering &&
        time - this._pinchStartedAt <= this._grabEntryWindow &&
        !events.some((event) => event.type === 'gesture-start')
      ) {
        this.beginGrab(entering, controls.primaryHandedness ?? 'unknown', params);
      }
    }

    // 4) 持续状态：维持抓取会话
    for (const record of this._records.values()) {
      const state = record.state;
      if (!state.grabbed) continue;

      // 抓取发生的那一帧时长为 0：「已经抓了多久」从 0 开始算
      if (state.transition !== 'grab') state.grabDuration += dt;

      // 光标取**正在抓着素材的那只手**，而不是"第一个捏合槽位"。
      // 槽位是可以对调的（第二只手出现时尤其容易），取错了素材会瞬间跳到另一只手下面。
      const cursor = controls ? this.resolveCursor(controls, state.grabbedBy) : null;

      if (!cursor) {
        // 手指位置暂时拿不到（手丢失宽限期）-> 冻结，不做任何位移
        record.sinceCursorLost += dt;
        if (record.sinceCursorLost >= this._releaseTimeout) {
          this.release(state.grabbedBy);
          state.releasedByTimeout = true;
        }
        continue;
      }

      // 刚经历了一段"手丢失"——重新锚定，否则恢复的那一帧素材会瞬间跳到手指下面。
      // 这条经验来自 handy 的 update_grab：`offset = _anchor_offset(...) if grab.misses else grab.offset`。
      if (record.sinceCursorLost > 0) {
        const currentPosition = findPosition(objects, state.objectId);
        if (currentPosition) {
          state.grabOffset = { x: cursor.x - currentPosition.x, y: cursor.y - currentPosition.y };
        }
      }
      record.sinceCursorLost = 0;

      const target = this.resolveTarget(record, controls, cursor, objects);
      const previous = state.targetPosition;
      state.dragDelta = previous ? { x: target.position.x - previous.x, y: target.position.y - previous.y } : { x: 0, y: 0 };
      state.cursorPosition = { ...target.cursor };
      state.targetPosition = target.position;
      state.twoHand = target.twoHand;
      if (state.transition === 'none') state.transition = 'move';
    }

    /*
     * 5) 准星：算出"现在捏合会抓到谁"。
     * 和真实抓取共用 findTopmostAt，所以高亮的对象一定就是捏下去会抓到的那个。
     *
     * 取消之后刻意**不高亮**：此时捏下去并不会抓到它，高亮会骗人。
     */
    this._previewTargetId = null;
    if (this._hasGrab()) {
      for (const record of this._records.values()) {
        if (record.state.grabbed) this._previewTargetId = record.state.objectId;
      }
    } else if (previewPoint && !this._rearmRequired) {
      this._previewTargetId = this.findTopmostAt(previewPoint, params)?.id ?? null;
    }
  }

  // ---------------------------------------------------------------- 指弹删除

  /**
   * 指弹命中：让指尖下最上层的可抓素材进入淡出期。
   *
   * 命中判定复用抓取那一套（`findTopmostAt`）—— 指尖和捏合中点用的是同一套
   * 屏幕坐标几何与宽容边距，所以"准星指着的"和"弹得到的"永远一致。
   */
  private beginDelete(at: Vec2, params: InteractionUpdateParams): string | null {
    const target = this.findTopmostAt(at, params);
    if (!target) return null;
    return this.startDeletion(target.id, params);
  }

  /**
   * 让某个素材进入淡出期。
   *
   * 两个入口共用：`beginDelete`（弹中指尖下最上层）和"弹掉这只手抓着的那张"
   * （见 §2.5 —— 真机上蓄力就会把它抓起来，所以这才是主路径）。
   */
  private startDeletion(objectId: string, params: InteractionUpdateParams): string {
    // 已经在淡出中就不重置计时（否则反复弹同一个素材就永远删不掉）
    if (!this._deletions.has(objectId)) {
      /*
       * `+ dt` 是补偿：淡出计时在**同一帧稍后**就会先扣掉一次 dt
       * （`updateDeletions` 在指弹处理之后跑），不补的话弹中当帧就少掉一帧时间。
       * 语义上"淡出期从被弹中那一刻开始算满"，所以补回来。
       */
      this._deletions.set(objectId, this._deleteGraceSeconds + params.dt);
    }
    // 正在抓着它的话，顺手松开 —— 一个"正在被你抓着"的素材被弹掉会很怪
    const record = this._records.get(objectId);
    if (record?.state.grabbed) this.release(record.state.grabbedBy);
    /*
     * 淡出要靠**行为**改不透明度，而行为只能看到"自己素材的交互状态"，
     * 所以淡出目标必须有记录 —— 否则 `get(id)` 返回兜底值，`deleting` 永远是 false，
     * 素材会"到点突然消失"而不是淡出。
     */
    if (!this._records.has(objectId)) this._records.set(objectId, this.createRecord(objectId));
    return objectId;
  }

  /** 撤销：捏住一个正在淡出的素材 = 我后悔了。 */
  private cancelDelete(objectId: string): boolean {
    return this._deletions.delete(objectId);
  }

  /** 推进淡出计时；到期的放进 `_expiredDeletions`，由 Scene 移除。 */
  private updateDeletions(dt: number, objects: readonly SceneObject[]): void {
    this._expiredDeletions = [];
    if (this._deletions.size === 0) return;

    const alive = new Set<string>();
    for (const object of objects) alive.add(object.id);

    for (const [id, remaining] of [...this._deletions.entries()]) {
      // 素材已经因为别的原因没了：直接丢掉这条记录
      if (!alive.has(id)) {
        this._deletions.delete(id);
        continue;
      }
      const next = remaining - dt;
      if (next <= 0) {
        this._deletions.delete(id);
        this._expiredDeletions.push(id);
      } else {
        this._deletions.set(id, next);
      }
    }
  }

  /**
   * 取走本帧到期的删除（Scene 在 interactions.update 之后调用它并真正移除对象）。
   *
   * 为什么不让交互层自己删：`objects` 是**只读快照**，交互层不该改对象树。
   * 分工是"交互层说'这次删除还算数'，Scene 执行移除"。
   */
  takeExpiredDeletions(): string[] {
    const expired = this._expiredDeletions;
    this._expiredDeletions = [];
    return expired;
  }

  /** 某个素材的淡出进度 0..1（1 = 已到期）。不在淡出中时为 0。 */
  private deletionProgress(objectId: string): number {
    const remaining = this._deletions.get(objectId);
    if (remaining === undefined) return 0;
    return clamp(1 - remaining / this._deleteGraceSeconds, 0, 1);
  }

  // ---------------------------------------------------------------- 取消与重新武装

  /**
   * 握拳急停：**只取消这只手自己**的抓取会话，素材停在原地（不带投掷速度）。
   *
   * 为什么不是"清空一切"（第一版就是清空一切，真机证明是错的）：
   * 屏幕里同时有两只手时，另一只手常常只是放松搭着，容易被判成握拳 ——
   * 于是它的握拳会把**另一只手正在进行的抓取**也清掉。用户的感觉是
   * "我另一只手什么都没做，怎么突然就抓不住了"。真机反馈原话：
   * "屏幕里同时有两个手，如果一只手握拳，自动识别为无法选取，容易干扰另一个手的抓取"。
   *
   * 现在的语义是"**每只手管自己的会话**"：既保住了急停（抓着素材的那只手一握拳就停），
   * 又不可能被旁观的手干扰。要停两只手就两只手都握拳 —— 规则简单、可预期。
   */
  private cancelByHand(hand: Handedness, controls: ContinuousGestures): void {
    let cancelled = false;
    for (const record of this._records.values()) {
      const state = record.state;
      if (!state.grabbed || state.grabbedBy !== hand) continue;
      state.grabbed = false;
      state.transition = 'cancel';
      state.releasedByTimeout = false;
      state.targetPosition = null;
      state.grabDuration = 0;
      state.twoHand = createIdleTwoHandState();
      record.sinceCursorLost = 0;
      record.twoHandActive = false;
      record.twoHandStartDistance = null;
      cancelled = true;
    }

    this._pinchStartedAt = null;
    this._previewTargetId = null;

    /*
     * "这只手什么都没抓着"时**什么都不做**：不设重新武装。
     * 这正是"旁观的手握拳不该有副作用"的关键 —— 否则它会顺手把整个应用锁住。
     */
    if (!cancelled && !this._rearmRequired) return;

    /*
     * 只在**进入**这个状态时记时刻。
     * 握拳会连续很多帧，如果每帧都刷新计时器，安全阀就永远不会到点
     * （第一版就是这样，被单测当场抓住）。
     */
    if (!this._rearmRequired) {
      this._rearmRequired = true;
      this._rearmSince = this._time;
    }
    this._cancelReason = 'fist';

    /*
     * 记下"哪些手必须离开捏合/握拳才能重新武装"。
     * 刻意**不是**"所有手"：另一只随手搭着的手不该让程序永远无法重新武装。
     */
    this._rearmBlocked.clear();
    for (const other of controls.fistHands) this._rearmBlocked.add(other);
    for (const other of this.holdingHands(controls).keys()) this._rearmBlocked.add(other);
  }

  /**
   * 把"哪些手正处在捏合/握拳状态"整理成一张表。
   *
   * 同时看 `pinches` 和 `pinch` 两个字段：正常情况下它们是同一份数据的两视图，
   * 但只要有调用方（或测试）只填了其中一个，重新武装的判断就可能被"看不见的手"骗过 ——
   * 而急停失效是这套文法里最不能接受的失败。多读一个字段的代价是零。
   */
  private holdingHands(controls: ContinuousGestures): Map<Handedness, HandShape> {
    const map = new Map<Handedness, HandShape>();
    for (const pinch of [...controls.pinches, controls.pinch]) {
      if (!pinch.handedness) continue;
      if (pinch.shape === 'pinch' || pinch.shape === 'fist') map.set(pinch.handedness, pinch.shape);
    }
    return map;
  }

  /**
   * 重新武装：当所有"挡住"的手都不再捏合/握拳之后，才允许新的抓取。
   * 手整只离开画面同样算离开（此时它的手型是 other）。
   */
  private updateRearm(controls: ContinuousGestures | null): void {
    if (!this._rearmRequired) return;

    /*
     * 安全阀：即便手型判定卡在握拳上，也不能把应用永久锁死。
     * 急停的意图（"别让取消动作本身立刻抓回一张图"）只需要一小段时间就够，
     * 而"被锁住"是比"多等一秒"严重得多的失败 —— 真机上就踩到过。
     */
    if (this._time - this._rearmSince >= this._rearmTimeoutSeconds) {
      this.clearRearm();
      return;
    }

    if (!controls) return;

    const holding = this.holdingHands(controls);
    for (const handedness of this._rearmBlocked) {
      if (holding.has(handedness)) return;
    }

    this.clearRearm();
  }

  private clearRearm(): void {
    this._rearmRequired = false;
    this._rearmBlocked.clear();
    this._cancelReason = null;
  }

  // ---------------------------------------------------------------- 内部

  /** 建一条空白交互记录（抓取与淡出都要用，保证两边字段一致）。 */
  private createRecord(objectId: string): InteractionRecord {
    return {
      state: createIdleInteractionState(objectId),
      sinceCursorLost: 0,
      twoHandActive: false,
      twoHandStartDistance: null,
      twoHandOffset: { x: 0, y: 0 },
    };
  }

  /**
   * 本帧素材该去哪、大小倍率是多少。位置有两个来源：
   *   · 单手拖动：手指位置 − 抓取偏移；
   *   · 双手缩放：两手捏合中点的位置 + 加入时的偏移（同时给出间距倍率）。
   *
   * **双手缩放只在"场上只有一个素材被抓住"时生效。**
   * 因为两手间距是一个**全局**量：如果两只手各抓了一张图，两张图都会跟着同一个中点、
   * 按同一个倍率动，于是叠在一起（真机上很容易发生：第二只手正好落在另一张图上）。
   * 退化成"各拖各的"是唯一可预测的语义 —— 想缩放就松开一只手重来，
   * 而真实用法里第二只手本来就是从空处捏上来的。
   */
  private resolveTarget(
    record: InteractionRecord,
    controls: ContinuousGestures | null,
    cursor: Vec2,
    objects: readonly SceneObject[],
  ): { position: Vec2; cursor: Vec2; twoHand: TwoHandInteractionState } {
    const twoHand = controls?.twoHand ?? null;
    const active = Boolean(
      twoHand?.active && twoHand.center && twoHand.distance !== null && this.grabbedCount() === 1,
    );

    if (active && twoHand?.center && twoHand.distance !== null) {
      if (!record.twoHandActive) {
        // 第二只手刚加入：记下起始间距，以及素材相对两手中点的偏移（避免素材跳）
        record.twoHandActive = true;
        /*
         * 基准取**原始**间距（`rawDistance`），不是平滑值。
         * "张开 → 捏合"时捏合中点会移动约 3–4% 掌长，而平滑值要 ~0.26 秒才追到位；
         * 用平滑值当基准，素材会在这段时间里自己变大 6%（真机反馈过）。
         */
        record.twoHandStartDistance = twoHand.rawDistance ?? twoHand.distance;
        const currentPosition = findPosition(objects, record.state.objectId) ?? record.state.targetPosition ?? twoHand.center;
        record.twoHandOffset = {
          x: currentPosition.x - twoHand.center.x,
          y: currentPosition.y - twoHand.center.y,
        };
      }

      const start = record.twoHandStartDistance ?? twoHand.distance;
      return {
        position: {
          x: twoHand.center.x + record.twoHandOffset.x,
          y: twoHand.center.y + record.twoHandOffset.y,
        },
        cursor: { ...twoHand.center },
        twoHand: {
          active: true,
          distanceRatio: start > 1e-6 ? clamp(twoHand.distance / start, 0.1, 10) : 1,
        },
      };
    }

    if (record.twoHandActive) {
      // 第二只手走了或松开了：结束双手会话，并以当前手指位置重锚，避免素材跳一下
      record.twoHandActive = false;
      record.twoHandStartDistance = null;
      const currentPosition = findPosition(objects, record.state.objectId);
      if (currentPosition) {
        record.state.grabOffset = { x: cursor.x - currentPosition.x, y: cursor.y - currentPosition.y };
      }
    }

    return {
      position: { x: cursor.x - record.state.grabOffset.x, y: cursor.y - record.state.grabOffset.y },
      cursor: { ...cursor },
      twoHand: createIdleTwoHandState(),
    };
  }

  /**
   * 抓取时光标的位置：只用捏合中点，**不回退到掌心**。
   * 回退会造成一个很难查的 bug：捏合一旦消失，素材会瞬间跳到掌心位置。
   *
   * 优先找**正在抓着素材的那只手**（按左右手匹配）；找不到再做退化处理。
   * 这一步是真机上"第二只手一捏上图片就掉/就跳"的根因修复：
   * 捏合状态是按槽位排的，而槽位会因为第二只手出现而对调，
   * "取第一个捏合槽位"于是会取到另一只手。
   */
  private resolveCursor(controls: ContinuousGestures, grabbedBy: Handedness | null): Vec2 | null {
    if (grabbedBy) {
      const own = controls.pinches.find((pinch) => pinch.active && pinch.handedness === grabbedBy);
      if (own?.center) return own.center;
    }

    const primary: PinchState | undefined = controls.pinch;
    if (primary?.active && primary.center) return primary.center;

    // 退化：抓着手的那只手这一帧没有位置，但有且仅有一只的手在捏合 -> 用它的位置。
    // （槽位/标签在极端情况下会短暂错位，这个兜底让拖动不至于断掉。）
    const activePinches = controls.pinches.filter((pinch) => pinch.active && pinch.center);
    if (activePinches.length === 1 && activePinches[0]?.center) return activePinches[0].center;

    return null;
  }

  private _hasGrab(): boolean {
    return this.grabbedCount() > 0;
  }

  /** 当前处于"被抓住"状态的素材数量（已释放的记录不算）。 */
  private grabbedCount(): number {
    let count = 0;
    for (const record of this._records.values()) {
      if (record.state.grabbed) count += 1;
    }
    return count;
  }

  /**
   * 找出该点下最上层的可抓素材。
   *
   * 命中多个时取 zIndex 最大的那个。刻意**不依赖 objects 的传入顺序** ——
   * 依赖顺序的话，调用方某天传了一份没排序的数组就会变成"抓到了被压在下面的素材"。
   */
  private findTopmostAt(at: Vec2, params: InteractionUpdateParams): SceneObject | null {
    const viewport = params.viewport;
    const aspectOf = params.aspectOf ?? (() => 1);
    const screenPoint = viewport.sceneToViewport(at);
    const frame = viewport.frame;
    const margin = this._grabHitMarginFrac * Math.min(frame.width, frame.height);

    let target: SceneObject | null = null;
    for (const object of params.objects) {
      const objectState = object.state;
      if (!objectState.visible) continue;
      if (!objectState.interaction.grabbable) continue;
      if (!hitTestObject(objectState, aspectOf(objectState), viewport, screenPoint, margin)) continue;
      if (target === null || object.zIndex >= target.zIndex) target = object;
    }
    return target;
  }

  private beginGrab(at: Vec2, hand: Handedness, params: InteractionUpdateParams): void {
    /*
     * 同一只手已经在抓着东西了 -> 这是一次**重复的 start**，直接忽略。
     *
     * 为什么会有重复：抓取会话按左右手记账，捏合状态按槽位排。槽位一旦对调，
     * 抓着手的那只手会在新槽位里"第一次"触发 pinch，于是又发一次 start。
     * 以前这里会先 `release(hand)` 释放掉正在进行的抓取，然后因为这次的新位置
     * 并不在素材上而找不到新目标 —— 结果就是"第二只手一捏上，图片掉了"。
     * 保留原会话是唯一正确的解释：**这只手从头到尾就没有松开过**。
     */
    if (this.grabbedIds().some((id) => this._records.get(id)?.state.grabbedBy === hand)) return;

    const target = this.findTopmostAt(at, params);
    if (!target) return;

    /*
     * 目标**已经被抓着**了 -> 这次 pinch 是"第二只手加入同一次操作"，不要抢走会话。
     *
     * 这一条是双手缩放能成立的关键语义：两只手通常都捏在同一张图上，
     * 如果后来的手把会话抢过去，拖动会在两只手之间反复易主
     * （用户感觉"刚才还跟着我的右手，怎么突然跟左手了"）。
     * 会话始终属于**先抓住的那只手**，第二只手只贡献位置/间距。
     */
    if (this._records.get(target.id)?.state.grabbed) return;

    /*
     * 捏住一个"正在淡出"的素材 = **撤销这次删除**。
     * 指弹是破坏性操作，误弹一次就丢一张图太狠；用"再捏住它"当撤销，
     * 不需要任何按钮，也不需要瞄准（它就在原地、还是半透明的）。
     */
    this.cancelDelete(target.id);

    // 同一只手换抓另一个素材：先松开原来那个
    this.release(hand);

    const objectState = target.state;
    const record: InteractionRecord = this.createRecord(target.id);
    const interaction = record.state;
    interaction.grabbed = true;
    interaction.grabbedBy = hand;
    interaction.grabOffset = { x: at.x - objectState.position.x, y: at.y - objectState.position.y };
    interaction.cursorPosition = { x: at.x, y: at.y };
    // 首帧目标位置就等于原地，避免"抓住瞬间跳一下"
    interaction.targetPosition = { x: objectState.position.x, y: objectState.position.y };
    interaction.transition = 'grab';

    this._records.set(target.id, record);
  }

  /**
   * 释放抓取。hand 为 null 时释放所有手。
   * 注意 cursorPosition 与 dragDelta 会保留下来：行为在"松手"那一帧正好需要它算投掷初速度。
   */
  private release(hand: Handedness | null): boolean {
    let released = false;
    for (const record of this._records.values()) {
      const state = record.state;
      if (!state.grabbed) continue;
      if (hand !== null && state.grabbedBy !== hand) continue;

      state.grabbed = false;
      state.transition = 'release';
      state.releasedByTimeout = false;
      state.targetPosition = null;
      state.grabDuration = 0;
      state.twoHand = createIdleTwoHandState();
      record.sinceCursorLost = 0;
      record.twoHandActive = false;
      record.twoHandStartDistance = null;
      released = true;
    }
    return released;
  }
}
