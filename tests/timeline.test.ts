import { describe, expect, it } from 'vitest';

import { SceneObject } from '@/core/scene/object';
import { Timeline, TIMELINE_VERSION, type TimelineSnapshot } from '@/core/timeline/timeline';

describe('Timeline', () => {
  it('fps 非法时抛错', () => {
    expect(() => new Timeline(0)).toThrow(RangeError);
    expect(() => new Timeline(Number.NaN)).toThrow(RangeError);
  });

  it('按 fps 节流采样（30fps 时同一帧内的多次调用只记录一次）', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1');

    expect(timeline.sample(0, 0, [object])).toBe(true);
    expect(timeline.sample(0.01, 1, [object])).toBe(false);
    expect(timeline.sample(0.02, 2, [object])).toBe(false);
    expect(timeline.sample(0.034, 3, [object])).toBe(true);
    expect(timeline.frameCount).toBe(2);
  });

  it('时间不回退时不会记录（防止长按/时钟跳变产生错乱轨迹）', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1');

    timeline.sample(1, 0, [object]);
    expect(timeline.sample(0.5, 1, [object])).toBe(false);
    expect(timeline.frameCount).toBe(1);
  });

  it('push 强制记录（录制首帧/末帧用）', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1');

    timeline.push(0, 0, [object]);
    timeline.push(0.001, 1, [object]);
    expect(timeline.frameCount).toBe(2);
  });

  it('记录的是素材状态的快照，之后改素材不会污染时间轴', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1', { position: { x: 0.1, y: 0.2 } });

    timeline.push(0, 0, [object]);
    object.setPosition({ x: 0.9, y: 0.9 });

    const frame = timeline.frames[0];
    expect(frame?.objects['obj-1']?.position).toEqual({ x: 0.1, y: 0.2 });
  });

  it('帧里记录了需求文档要求的全部呈现字段', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1', {
      position: { x: 0.25, y: 0.5 },
      scale: 2,
      rotation: 0.3,
      opacity: 0.8,
      visible: false,
      zIndex: 3,
    });

    timeline.push(0, 0, [object]);
    const sample = timeline.frames[0]?.objects['obj-1'];

    expect(sample).toEqual({
      position: { x: 0.25, y: 0.5 },
      scale: 2,
      rotation: 0.3,
      opacity: 0.8,
      visible: false,
      zIndex: 3,
    });
  });

  it('sampleAt 在帧之间做线性插值', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1', { position: { x: 0, y: 0 }, scale: 1, opacity: 0 });

    timeline.push(0, 0, [object]);
    object.setPosition({ x: 1, y: 0.5 });
    object.setScale(3);
    object.setOpacity(1);
    timeline.push(1, 30, [object]);

    const quarter = timeline.sampleAt(0.25)['obj-1'];
    expect(quarter?.position.x).toBeCloseTo(0.25, 9);
    expect(quarter?.position.y).toBeCloseTo(0.125, 9);
    expect(quarter?.scale).toBeCloseTo(1.5, 9);
    expect(quarter?.opacity).toBeCloseTo(0.25, 9);
  });

  it('sampleAt 在时间范围之外取最近帧', () => {
    const timeline = new Timeline(30);
    const a = SceneObject.create('a', { position: { x: 0, y: 0 } });
    const b = SceneObject.create('b', { position: { x: 1, y: 1 } });

    timeline.push(1, 0, [a, b]);
    a.setPosition({ x: 0.5, y: 0.5 });
    b.setPosition({ x: 0.5, y: 0.5 });
    timeline.push(2, 30, [a, b]);

    expect(timeline.sampleAt(0.5)['a']?.position).toEqual({ x: 0, y: 0 });
    expect(timeline.sampleAt(99)['b']?.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('sampleAt 能处理"中途才出现 / 中途消失"的素材', () => {
    const timeline = new Timeline(30);
    const a = SceneObject.create('a');
    const b = SceneObject.create('b');

    timeline.push(0, 0, [a]);
    timeline.push(1, 30, [a, b]);

    const mid = timeline.sampleAt(0.5);
    expect(mid['a']).toBeDefined();
    expect(mid['b']).toBeDefined();
    expect(timeline.objectIds().sort()).toEqual(['a', 'b']);
  });

  it('空时间轴是安全的', () => {
    const timeline = new Timeline(30);
    expect(timeline.isEmpty).toBe(true);
    expect(timeline.duration).toBe(0);
    expect(timeline.sampleAt(1)).toEqual({});
  });

  it('duration 是末帧减首帧', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1');

    timeline.push(2, 0, [object]);
    timeline.push(5.5, 100, [object]);
    expect(timeline.duration).toBeCloseTo(3.5, 9);
  });

  it('序列化 / 反序列化保持轨迹一致', () => {
    const timeline = new Timeline(30);
    const object = SceneObject.create('obj-1', { position: { x: 0.1, y: 0.6 } });
    timeline.push(0, 0, [object]);
    object.setPosition({ x: 0.4, y: 0.2 });
    timeline.push(1 / 30, 1, [object]);

    const snapshot: TimelineSnapshot = JSON.parse(JSON.stringify(timeline.toJSON()));
    expect(snapshot.version).toBe(TIMELINE_VERSION);

    const restored = Timeline.fromJSON(snapshot);
    expect(restored.fps).toBe(30);
    expect(restored.frameCount).toBe(2);
    expect(restored.toJSON()).toEqual(timeline.toJSON());
    expect(restored.sampleAt(1 / 60)['obj-1']?.position.x).toBeCloseTo(0.25, 9);
  });

  it('版本不认识时抛错', () => {
    expect(() => Timeline.fromJSON({ version: 99 as unknown as 1, fps: 30, duration: 0, frames: [] })).toThrow(
      /不支持的时间轴版本/,
    );
  });
});
