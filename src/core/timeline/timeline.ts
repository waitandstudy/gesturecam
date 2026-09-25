import type { Vec2 } from '../math/vec2';
import type { ObjectState } from '../scene/types';

/**
 * ============================================================================
 * 时间轴（录制路线的数据底座）
 * ============================================================================
 *
 * 已确认的技术路线：**实时合成录制（所见即所得）+ 每帧把素材状态写入 timeline**。
 *
 * 为什么两边都要：
 *   - 实时合成：用户拍完立刻拿到成品，不需要二次导出；
 *   - timeline：素材轨迹是一份纯数据，未来"拍完重新编辑对象""保存场景""场景模板"
 *     "换分辨率重新导出""离线重新合成"都直接复用，不需要重录。
 *
 * Phase 1 只交付**数据结构 + 采样/插值 + 序列化**（有单测覆盖），
 * 真正的采集（跟随 render loop）与导出在 Phase 9 接入。这样做的原因是需求文档第十八节
 * 明确要求逐阶段验证，不要一次把未来功能都实现。
 */

/** 单个素材在某一帧的"呈现状态"。刻意不含 mode / gestureBinding 等静态编排字段。 */
export interface ObjectTrackSample {
  position: Vec2;
  scale: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  zIndex: number;
}

export interface TimelineFrame {
  /** 相对录制开始的秒数 */
  t: number;
  /** 全局帧序号 */
  frame: number;
  objects: Record<string, ObjectTrackSample>;
}

export interface TimelineSnapshot {
  version: 1;
  fps: number;
  duration: number;
  frames: TimelineFrame[];
}

/** 能被采样到时间轴上的东西（SceneObject 结构上满足它）。 */
export interface TimelineSource {
  readonly id: string;
  readonly state: Readonly<ObjectState>;
}

export const TIMELINE_VERSION = 1;

function cloneSample(sample: ObjectTrackSample): ObjectTrackSample {
  return { ...sample, position: { ...sample.position } };
}

function capture(state: Readonly<ObjectState>): ObjectTrackSample {
  return {
    position: { x: state.position.x, y: state.position.y },
    scale: state.scale,
    rotation: state.rotation,
    opacity: state.opacity,
    visible: state.visible,
    zIndex: state.zIndex,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolate(a: ObjectTrackSample, b: ObjectTrackSample, t: number): ObjectTrackSample {
  return {
    position: { x: lerp(a.position.x, b.position.x, t), y: lerp(a.position.y, b.position.y, t) },
    scale: lerp(a.scale, b.scale, t),
    rotation: lerp(a.rotation, b.rotation, t),
    opacity: lerp(a.opacity, b.opacity, t),
    // 布尔和层级不做插值，取更近的一帧
    visible: t < 0.5 ? a.visible : b.visible,
    zIndex: t < 0.5 ? a.zIndex : b.zIndex,
  };
}

export class Timeline {
  readonly fps: number;
  private _frames: TimelineFrame[] = [];

  constructor(fps = 30) {
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new RangeError(`fps 必须是正数，收到 ${fps}`);
    }
    this.fps = fps;
  }

  get frames(): readonly TimelineFrame[] {
    return this._frames;
  }

  get frameCount(): number {
    return this._frames.length;
  }

  get isEmpty(): boolean {
    return this._frames.length === 0;
  }

  /** 录制时长（秒）= 末帧时间 - 首帧时间。 */
  get duration(): number {
    const first = this._frames[0];
    const last = this._frames[this._frames.length - 1];
    if (!first || !last) return 0;
    return Math.max(0, last.t - first.t);
  }

  /** 采样间隔（秒）。 */
  get interval(): number {
    return 1 / this.fps;
  }

  /**
   * 按 fps 节流采样。返回 true 表示这一帧真的被记录了。
   *
   * 之所以要节流：渲染循环通常是 60fps，但把 60fps 的素材状态全存下来意义不大，
   * 30fps（甚至 15fps）+ sampleAt() 的线性插值已经足够还原轨迹，还能省一半内存。
   *
   * 阈值取 interval 的 75% 是刻意的：60fps 循环下 dt≈16.7ms < 25ms 会被跳过，
   * 于是稳定落在每 2 帧记 1 次，正好 30fps；同时又能容忍 rAF 的轻微抖动，
   * 不会因为差几个微秒就掉到 20fps。
   */
  sample(time: number, frame: number, objects: readonly TimelineSource[]): boolean {
    const last = this._frames[this._frames.length - 1];
    if (last) {
      if (time <= last.t) return false;
      if (time - last.t < this.interval * 0.75) return false;
    }
    this.push(time, frame, objects);
    return true;
  }

  /** 强制记录一帧（录制开始的第一帧、结束的最后一帧用）。 */
  push(time: number, frame: number, objects: readonly TimelineSource[]): void {
    const sample: TimelineFrame = { t: time, frame, objects: {} };
    for (const object of objects) {
      sample.objects[object.id] = capture(object.state);
    }
    this._frames.push(sample);
  }

  /** 时间轴上出现过的所有素材 id。 */
  objectIds(): string[] {
    const ids = new Set<string>();
    for (const frame of this._frames) for (const id of Object.keys(frame.objects)) ids.add(id);
    return [...ids];
  }

  /**
   * 在任意时刻取插值后的状态。这是"拍完离线重新合成 / 换分辨率重导出"的核心能力：
   * 有了它，就不需要保存原始逐帧视频，也能在任意时间点重建画面。
   */
  sampleAt(time: number): Record<string, ObjectTrackSample> {
    const frames = this._frames;
    const first = frames[0];
    if (!first) return {};

    const last = frames[frames.length - 1];
    if (!last) return {};
    if (time <= first.t) return mapSamples(first);
    if (time >= last.t) return mapSamples(last);

    // 二分找到 time 右侧的帧
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      const frame = frames[mid];
      if (frame && frame.t < time) low = mid + 1;
      else high = mid;
    }

    const right = frames[low];
    const left = frames[low - 1];
    if (!right) return mapSamples(last);
    if (!left) return mapSamples(right);

    const span = right.t - left.t;
    const ratio = span > 0 ? (time - left.t) / span : 0;
    const result: Record<string, ObjectTrackSample> = {};

    for (const id of new Set([...Object.keys(left.objects), ...Object.keys(right.objects)])) {
      const a = left.objects[id];
      const b = right.objects[id];
      if (a && b) result[id] = interpolate(a, b, ratio);
      else if (a) result[id] = cloneSample(a);
      else if (b) result[id] = cloneSample(b);
    }

    return result;
  }

  clear(): void {
    this._frames = [];
  }

  toJSON(): TimelineSnapshot {
    return {
      version: TIMELINE_VERSION,
      fps: this.fps,
      duration: this.duration,
      frames: this._frames.map((frame) => ({
        t: frame.t,
        frame: frame.frame,
        objects: Object.fromEntries(Object.entries(frame.objects).map(([id, sample]) => [id, cloneSample(sample)])),
      })),
    };
  }

  static fromJSON(snapshot: TimelineSnapshot): Timeline {
    if (snapshot.version !== TIMELINE_VERSION) {
      throw new Error(`不支持的时间轴版本：${String(snapshot.version)}（当前支持 ${TIMELINE_VERSION}）`);
    }
    const timeline = new Timeline(snapshot.fps);
    timeline._frames = snapshot.frames.map((frame) => ({
      t: frame.t,
      frame: frame.frame,
      objects: Object.fromEntries(Object.entries(frame.objects).map(([id, sample]) => [id, cloneSample(sample)])),
    }));
    return timeline;
  }
}

function mapSamples(frame: TimelineFrame): Record<string, ObjectTrackSample> {
  return Object.fromEntries(Object.entries(frame.objects).map(([id, sample]) => [id, cloneSample(sample)]));
}
