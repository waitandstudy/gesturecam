import type { BehaviorViewport } from '../behavior/behavior';
import { BehaviorManager } from '../behavior/manager';
import { Viewport } from '../coords/viewport';
import type { GestureState } from '../gesture/types';
import { InteractionManager } from '../interaction/interactionManager';
import { Timeline } from '../timeline/timeline';
import { ObjectManager } from './objectManager';
import type { ObjectState, SceneSnapshot } from './types';

/**
 * 纹理宽高比解析器。命中测试和渲染都需要知道素材真实形状，
 * 但 Scene 不应该依赖 AssetManager，所以由 app 层注入。
 */
export type AspectResolver = (state: Readonly<ObjectState>) => number;

export interface SceneOptions {
  viewport?: Viewport;
  objects?: ObjectManager;
  behaviors?: BehaviorManager;
  interactions?: InteractionManager;
  timeline?: Timeline;
  name?: string;
  /** dt 上限（秒）。标签页切回来时 dt 会很大，必须夹住，否则行为积分会炸。 */
  maxDeltaSeconds?: number;
  aspectOf?: AspectResolver;
}

const DEFAULT_ASPECT_RESOLVER: AspectResolver = () => 1;

/**
 * 场景 —— 对象树的根节点。
 *
 * 每帧的推进顺序（**顺序本身就是架构**，不要随意调整）：
 *
 *   1. 推进时间
 *   2. InteractionManager：手势 → 落到具体素材的交互状态（抓取会话、抓取偏移、目标位置）
 *   3. BehaviorManager   ：交互状态 → 素材状态（怎么动由行为决定）
 *   4. （渲染器在 app 层读取素材状态出画面）
 *
 * 第 2 步必须早于第 3 步，而且必须在同一帧内完成 ——
 * 这样"刚被抓住""刚松开"这类一次性变化，行为能在同一帧就看到，不会延迟一帧。
 *
 * **对需求文档的一处刻意偏离**：文档把 Camera 与 HandTracker 画在 Scene 下面，
 * 这里把它们放在了 app 层，Scene 每帧以参数形式接收 GestureState、只读取 viewport 尺寸。
 * 原因：相机和手部追踪都绑死在浏览器/DOM 上，把它们塞进 Scene 会让 Scene 无法在
 * Node 里做单元测试，也无法离线重放。这只是"谁持引用"的差异，不影响模块划分与可替换性。
 */
export class Scene {
  readonly viewport: Viewport;
  readonly objects: ObjectManager;
  readonly behaviors: BehaviorManager;
  readonly interactions: InteractionManager;
  readonly timeline: Timeline;

  private readonly _maxDelta: number;
  private _aspectOf: AspectResolver;
  private _time = 0;
  private _frame = 0;
  private _name: string | undefined;

  constructor(options: SceneOptions = {}) {
    this.viewport = options.viewport ?? new Viewport();
    this.objects = options.objects ?? new ObjectManager();
    this.behaviors = options.behaviors ?? new BehaviorManager();
    this.interactions = options.interactions ?? new InteractionManager();
    this.timeline = options.timeline ?? new Timeline();
    this._aspectOf = options.aspectOf ?? DEFAULT_ASPECT_RESOLVER;
    this._maxDelta = options.maxDeltaSeconds ?? 0.1;
    this._name = options.name;
  }

  get name(): string | undefined {
    return this._name;
  }

  set name(value: string | undefined) {
    this._name = value;
  }

  /** 场景运行时间（秒）。 */
  get time(): number {
    return this._time;
  }

  /** 场景运行帧数。 */
  get frame(): number {
    return this._frame;
  }

  get aspectOf(): AspectResolver {
    return this._aspectOf;
  }

  set aspectOf(resolver: AspectResolver) {
    this._aspectOf = resolver;
  }

  /** 暴露给行为系统的渲染区域信息（输出画幅，不是整个屏幕）。 */
  get behaviorViewport(): BehaviorViewport {
    const frame = this.viewport.frame;
    return {
      width: frame.width,
      height: frame.height,
      aspect: this.viewport.sceneAspect,
      mirrored: this.viewport.mirrored,
    };
  }

  /** 推进一帧。手部/手势尚未接入时传 null，InteractionManager 会走超时逻辑。 */
  update(dt: number, gestures: GestureState | null = null): void {
    const delta = Math.min(Math.max(dt, 0), this._maxDelta);
    this._time += delta;
    this._frame += 1;

    // 按绘制顺序（z 升序）取一次，交互层和行为层共用同一份快照
    const objects = this.objects.listByZ();

    this.interactions.update({
      dt: delta,
      time: this._time,
      gestures,
      viewport: this.viewport,
      objects,
      aspectOf: this._aspectOf,
    });

    /*
     * 指弹删除的淡出期结束了 -> 真正把素材从场景里移除。
     *
     * 分工是刻意的：交互层只管"这次删除还算不算数"（撤销、超时），
     * **对象树由 Scene 拥有**，所以移除必须在这里做。
     * 移除同时也把素材从后续帧的 objects 快照里去掉了 ——
     * 下一帧交互层的那条记录会因为"素材不在了"被自动清理。
     */
    for (const objectId of this.interactions.takeExpiredDeletions()) {
      this.objects.remove(objectId);
    }

    this.behaviors.update({
      dt: delta,
      time: this._time,
      frame: this._frame,
      gestures,
      viewport: this.behaviorViewport,
      objects,
      interactions: this.interactions,
      // 边界约束要知道素材真实形状（纵向占多少），所以把解析器一起交出去
      aspectOf: this._aspectOf,
    });
  }

  /**
   * 把当前所有素材状态写入时间轴。Phase 1 不调用它（录制属于 Phase 9），
   * 数据结构与插值已经实现并有测试覆盖。
   */
  captureTimelineFrame(force = false): boolean {
    const objects = this.objects.listByZ();
    if (force) {
      this.timeline.push(this._time, this._frame, objects);
      return true;
    }
    return this.timeline.sample(this._time, this._frame, objects);
  }

  /** 时间归零（开始一段新录制时调用）。不影响素材状态。 */
  resetClock(): void {
    this._time = 0;
    this._frame = 0;
    this.interactions.reset();
  }

  toJSON(): SceneSnapshot {
    return this.objects.toJSON(this._name);
  }

  load(snapshot: SceneSnapshot): void {
    this.objects.load(snapshot);
    this._name = snapshot.name;
    this.interactions.reset();
  }
}
