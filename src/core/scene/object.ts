import type { Behavior, BehaviorStage } from '../behavior/behavior';
import { BEHAVIOR_STAGE_ORDER } from '../behavior/behavior';
import { createInteractionConfig, type ObjectInteractionConfig } from '../interaction/types';
import type { Vec2 } from '../math/vec2';
import type { ObjectMode, BoundaryMode, ObjectState, ObjectStatePatch } from './types';
import { cloneObjectState, createObjectState } from './types';

export const MIN_SCALE = 0.01;
export const MAX_SCALE = 50;
export const MIN_SIZE_WIDTH = 0.001;
export const MAX_SIZE_WIDTH = 20;

/**
 * 行为的执行排名：先按阶段，再按 priority。
 * 阶段是字符串，所以这里显式换成整数排名，避免依赖字面量顺序。
 */
function behaviorRank(behavior: Behavior): number {
  const stageIndex = BEHAVIOR_STAGE_ORDER.indexOf(behavior.stage as BehaviorStage);
  const safeStageIndex = stageIndex < 0 ? BEHAVIOR_STAGE_ORDER.length : stageIndex;
  return safeStageIndex * 1000 + (behavior.priority ?? 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把角度规整到 (-π, π]，避免长时间累加后精度劣化。 */
function normalizeAngle(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const twoPi = Math.PI * 2;
  let angle = radians % twoPi;
  if (angle > Math.PI) angle -= twoPi;
  if (angle <= -Math.PI) angle += twoPi;
  return angle;
}

/**
 * 场景里的一个素材对象（需求文档第十节）。
 *
 * 这个类只做两件事：
 *   1) 安全地读写 ObjectState（带取值域约束）；
 *   2) 持有挂载在自己身上的 Behavior 列表。
 *
 * 它**不知道**自己怎么被渲染，也**不知道**手势怎么来 —— 这正是需求文档第二节
 * "不要把图片 = 当前手掌位置这种逻辑写死"的落点。
 */
export class SceneObject {
  private _state: ObjectState;
  private readonly _behaviors: Behavior[] = [];
  /** 已调用过 onAttach 的行为，弱引用集合用数组即可（行为数量极少） */
  private readonly _attached = new Set<Behavior>();

  constructor(state: ObjectState) {
    this._state = state;
  }

  static create(id: string, patch: ObjectStatePatch = {}): SceneObject {
    return new SceneObject(createObjectState(id, patch));
  }

  static fromJSON(state: ObjectState): SceneObject {
    // 走一次 factory，保证反序列化出来的字段同样经过默认值/结构规整
    return new SceneObject(createObjectState(state.id, state));
  }

  get id(): string {
    return this._state.id;
  }

  get state(): Readonly<ObjectState> {
    return this._state;
  }

  get mode(): ObjectMode {
    return this._state.mode;
  }

  get zIndex(): number {
    return this._state.zIndex;
  }

  get visible(): boolean {
    return this._state.visible;
  }

  get behaviors(): readonly Behavior[] {
    return this._behaviors;
  }

  // ------------------------------------------------------------------ 状态写入

  setPosition(position: Vec2): void {
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
    this._state.position = { x: position.x, y: position.y };
  }

  translate(delta: Vec2): void {
    this.setPosition({ x: this._state.position.x + delta.x, y: this._state.position.y + delta.y });
  }

  setScale(scale: number): void {
    if (!Number.isFinite(scale)) return;
    this._state.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  }

  multiplyScale(factor: number): void {
    this.setScale(this._state.scale * factor);
  }

  setRotation(radians: number): void {
    this._state.rotation = normalizeAngle(radians);
  }

  rotateBy(delta: number): void {
    this.setRotation(this._state.rotation + delta);
  }

  setOpacity(opacity: number): void {
    if (!Number.isFinite(opacity)) return;
    this._state.opacity = clamp(opacity, 0, 1);
  }

  setVisible(visible: boolean): void {
    this._state.visible = visible;
  }

  setMode(mode: ObjectMode): void {
    this._state.mode = mode;
  }

  setBoundaryMode(mode: BoundaryMode): void {
    this._state.boundaryMode = mode;
  }

  setSource(assetId: string | null): void {
    this._state.source = assetId;
  }

  setSizeWidth(width: number): void {
    if (!Number.isFinite(width)) return;
    this._state.size = { width: clamp(width, MIN_SIZE_WIDTH, MAX_SIZE_WIDTH) };
  }

  setAnchor(anchor: Vec2): void {
    this._state.anchor = {
      x: clamp(anchor.x, 0, 1),
      y: clamp(anchor.y, 0, 1),
    };
  }

  setPhysicsEnabled(enabled: boolean): void {
    this._state.physicsEnabled = enabled;
  }

  /** 局部更新交互能力开关（grabbable / scalable / rotatable）。 */
  setInteractionConfig(patch: Partial<ObjectInteractionConfig>): void {
    this._state.interaction = createInteractionConfig({ ...this._state.interaction, ...patch });
  }

  /** 仅供 ObjectManager 调整层级使用。 */
  setZIndex(zIndex: number): void {
    if (!Number.isFinite(zIndex)) return;
    this._state.zIndex = zIndex;
  }

  // ------------------------------------------------------------------ 行为挂载

  /**
   * 直接挂载一个已构建好的行为实例（由 BehaviorManager 调用）。
   * 列表按 (阶段顺序, priority) 保持有序，这样每帧执行时零分配、顺序确定。
   */
  addBehavior(behavior: Behavior): void {
    if (this._behaviors.some((existing) => existing.type === behavior.type)) {
      throw new Error(`对象 ${this.id} 已经挂载了 ${behavior.type} 行为`);
    }
    const rank = behaviorRank(behavior);
    const index = this._behaviors.findIndex((existing) => behaviorRank(existing) > rank);
    if (index < 0) this._behaviors.push(behavior);
    else this._behaviors.splice(index, 0, behavior);
  }

  removeBehavior(type: string): Behavior | undefined {
    const index = this._behaviors.findIndex((behavior) => behavior.type === type);
    if (index < 0) return undefined;
    const [removed] = this._behaviors.splice(index, 1);
    if (removed) this._attached.delete(removed);
    return removed;
  }

  getBehavior(type: string): Behavior | undefined {
    return this._behaviors.find((behavior) => behavior.type === type);
  }

  /** @internal 记录 onAttach 是否已经调用过。 */
  markAttached(behavior: Behavior): boolean {
    if (this._attached.has(behavior)) return false;
    this._attached.add(behavior);
    return true;
  }

  // ------------------------------------------------------------------ 序列化

  /** 导出为纯数据（深拷贝），可以直接 JSON.stringify。 */
  toJSON(): ObjectState {
    return cloneObjectState(this._state);
  }

  /** 直接改状态对象的逃生口，只给序列化/回放等内部代码使用。 */
  replaceState(state: ObjectState): void {
    this._state = state;
  }
}
