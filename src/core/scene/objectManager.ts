import { SceneObject } from './object';
import type { ObjectState, ObjectStatePatch, SceneSnapshot } from './types';

export const SCENE_SNAPSHOT_VERSION = 1;

export interface ObjectManagerOptions {
  /** id 前缀，便于日志辨认；默认 obj */
  idPrefix?: string;
  /** 可注入的 id 生成器，测试里用来得到确定结果 */
  idGenerator?: (ordinal: number, prefix: string) => string;
}

function defaultIdGenerator(ordinal: number, prefix: string): string {
  return `${prefix}-${ordinal}`;
}

/**
 * 素材对象管理器。
 *
 * 需求文档第六节明确要求：**不要设计成"一次只能控制一张图片"**。
 * 所以这里从第一天起就是集合语义：多素材、各自独立的层级与控制方式。
 */
export class ObjectManager {
  private readonly _objects = new Map<string, SceneObject>();
  private readonly _idPrefix: string;
  private readonly _idGenerator: (ordinal: number, prefix: string) => string;
  private _ordinal = 1;
  private _nextZIndex = 0;

  constructor(options: ObjectManagerOptions = {}) {
    this._idPrefix = options.idPrefix ?? 'obj';
    this._idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  get count(): number {
    return this._objects.size;
  }

  /** 分配一个新的 id（不创建对象）。 */
  allocateId(): string {
    let id = this._idGenerator(this._ordinal, this._idPrefix);
    let guard = 0;
    while (this._objects.has(id)) {
      this._ordinal += 1;
      id = this._idGenerator(this._ordinal, this._idPrefix);
      guard += 1;
      if (guard > 10000) throw new Error('无法分配唯一 id，请检查 idGenerator');
    }
    this._ordinal += 1;
    return id;
  }

  /** 创建一个新素材对象并加入场景。 */
  create(patch: ObjectStatePatch = {}): SceneObject {
    const zIndex = patch.zIndex ?? this._nextZIndex;
    const object = SceneObject.create(this.allocateId(), { ...patch, zIndex });
    this._nextZIndex = Math.max(this._nextZIndex, zIndex) + 1;
    this._objects.set(object.id, object);
    return object;
  }

  /** 直接加入一个已存在的状态（场景加载 / 撤销重做用）。 */
  add(state: ObjectState): SceneObject {
    const object = SceneObject.fromJSON(state);
    this._objects.set(object.id, object);
    this._nextZIndex = Math.max(this._nextZIndex, object.zIndex) + 1;
    return object;
  }

  get(id: string): SceneObject | undefined {
    return this._objects.get(id);
  }

  has(id: string): boolean {
    return this._objects.has(id);
  }

  remove(id: string): boolean {
    return this._objects.delete(id);
  }

  clear(): void {
    this._objects.clear();
    this._nextZIndex = 0;
  }

  /** 按加入顺序（稳定）。 */
  list(): SceneObject[] {
    return [...this._objects.values()];
  }

  /** 按绘制顺序（zIndex 升序，数值大的画在上面；同 z 保持加入顺序）。 */
  listByZ(): SceneObject[] {
    return this.list().sort((a, b) => a.zIndex - b.zIndex);
  }

  bringToFront(id: string): void {
    const object = this._objects.get(id);
    if (!object) return;
    object.setZIndex(this.maxZIndex() + 1);
  }

  sendToBack(id: string): void {
    const object = this._objects.get(id);
    if (!object) return;
    object.setZIndex(this.minZIndex() - 1);
  }

  setZIndex(id: string, zIndex: number): void {
    this._objects.get(id)?.setZIndex(zIndex);
  }

  /** 把 zIndex 规范化成 0..n-1，保持相对顺序。 */
  normalizeZIndex(): void {
    this.listByZ().forEach((object, index) => object.setZIndex(index));
    this._nextZIndex = this._objects.size;
  }

  private maxZIndex(): number {
    let max = Number.NEGATIVE_INFINITY;
    for (const object of this._objects.values()) max = Math.max(max, object.zIndex);
    return Number.isFinite(max) ? max : 0;
  }

  private minZIndex(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const object of this._objects.values()) min = Math.min(min, object.zIndex);
    return Number.isFinite(min) ? min : 0;
  }

  // ------------------------------------------------------------------ 序列化

  /** 导出场景快照（纯数据，可 JSON.stringify，可存 localStorage）。 */
  toJSON(name?: string): SceneSnapshot {
    const snapshot: SceneSnapshot = {
      version: SCENE_SNAPSHOT_VERSION,
      objects: this.listByZ().map((object) => object.toJSON()),
    };
    if (name !== undefined) snapshot.name = name;
    return snapshot;
  }

  /**
   * 从快照恢复。默认替换整个场景。
   * version 不认识时直接抛错而不是猜 —— 宁可炸掉也不要静默丢素材。
   */
  load(snapshot: SceneSnapshot, options: { replace?: boolean } = {}): void {
    if (snapshot.version !== SCENE_SNAPSHOT_VERSION) {
      throw new Error(`不支持的场景快照版本：${String(snapshot.version)}（当前支持 ${SCENE_SNAPSHOT_VERSION}）`);
    }
    if (options.replace !== false) this.clear();
    for (const state of snapshot.objects) this.add(state);
    this.normalizeZIndex();
  }
}
