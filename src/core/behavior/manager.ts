import type { Behavior, BehaviorContext, BehaviorFactory, BehaviorSceneQuery, BehaviorViewport } from './behavior';
import { BEHAVIOR_STAGE_ORDER } from './behavior';
import type { GestureState } from '../gesture/types';
import type { InteractionSnapshot } from '../interaction/types';
import type { SceneObject } from '../scene/object';
import type { ObjectState } from '../scene/types';

/** 每帧传给行为管线的环境信息。 */
export interface BehaviorEnvironment {
  dt: number;
  time: number;
  frame: number;
  /** 手势层本帧输出（连续量 + 离散事件） */
  gestures: GestureState | null;
  viewport: BehaviorViewport;
  /** 场景内所有素材，调用方需按绘制顺序（zIndex 升序）传入 */
  objects: readonly SceneObject[];
  /** 本帧的交互状态（由 InteractionManager 在行为之前更新） */
  interactions: InteractionSnapshot;
  /**
   * 纹理宽高比解析器。Scene 注入；缺省当正方形处理
   * （边界约束会因此对非正方形素材偏保守，但不会算错方向）。
   */
  aspectOf?: (state: Readonly<ObjectState>) => number;
}

/**
 * 行为管理器。
 *
 * 它把"素材该怎么动"从素材本身和渲染代码里彻底剥离出来：
 *   - 所有可用行为通过 register() 注册成"类型名 + 工厂"；
 *   - 每个素材按需挂载若干行为实例；
 *   - 每帧按 (阶段, priority) 顺序统一驱动。
 *
 * 将来加"惯性/重力/碰撞/甩出/悬挂"只需要 register 一个新类型，
 * 不需要碰这里的任何一行代码，也不需要碰渲染代码。
 */
export class BehaviorManager {
  private readonly _factories = new Map<string, BehaviorFactory<unknown>>();

  register<TConfig>(type: string, factory: BehaviorFactory<TConfig>): this {
    if (this._factories.has(type)) {
      throw new Error(`行为类型 ${type} 已经注册过了`);
    }
    this._factories.set(type, factory as BehaviorFactory<unknown>);
    return this;
  }

  has(type: string): boolean {
    return this._factories.has(type);
  }

  registeredTypes(): string[] {
    return [...this._factories.keys()];
  }

  create(type: string, config?: unknown): Behavior {
    const factory = this._factories.get(type);
    if (!factory) {
      throw new Error(`未注册的行为类型：${type}（已注册：${this.registeredTypes().join(', ') || '无'}）`);
    }
    return factory(config);
  }

  /** 给素材挂载行为。config 必须是可 JSON 序列化的数据（场景保存时要重建）。 */
  attach(object: SceneObject, type: string, config?: unknown): Behavior {
    const behavior = this.create(type, config);
    object.addBehavior(behavior);
    return behavior;
  }

  detach(object: SceneObject, type: string): boolean {
    const behavior = object.removeBehavior(type);
    if (!behavior) return false;
    behavior.onDetach?.();
    return true;
  }

  /**
   * 驱动一帧。
   *
   * 循环顺序刻意是"**阶段优先**"：先把所有素材的 input 跑完，再跑所有素材的 simulate。
   * 这样将来加物理系统时，碰撞检测不会因为"素材 A 已经积分、素材 B 还没积分"而出现偏差。
   */
  update(environment: BehaviorEnvironment): void {
    const objects = environment.objects;
    const scene: BehaviorSceneQuery = {
      get size() {
        return objects.length;
      },
      list: () => objects,
      get: (id: string) => objects.find((object) => object.id === id),
    };

    for (const stage of BEHAVIOR_STAGE_ORDER) {
      for (const object of objects) {
        for (const behavior of object.behaviors) {
          if (behavior.stage !== stage) continue;
          const context = this.createContext(object, scene, environment);
          if (object.markAttached(behavior)) behavior.onAttach?.(context);
          behavior.update(context);
        }
      }
    }
  }

  private createContext(
    object: SceneObject,
    scene: BehaviorSceneQuery,
    environment: BehaviorEnvironment,
  ): BehaviorContext {
    // 返回值标注为 BehaviorContext，等于顺带断言 SceneObject 满足 BehaviorObject 契约。
    return {
      dt: environment.dt,
      time: environment.time,
      frame: environment.frame,
      gestures: environment.gestures,
      interaction: environment.interactions.get(object.id),
      object,
      assetAspect: environment.aspectOf ? environment.aspectOf(object.state) : 1,
      scene,
      viewport: environment.viewport,
    };
  }
}
