import { describe, expect, it } from 'vitest';

import { ObjectManager } from '@/core/scene/objectManager';
import { DEFAULT_OBJECT_WIDTH, type SceneSnapshot } from '@/core/scene/types';

function createManager(): ObjectManager {
  let ordinal = 0;
  return new ObjectManager({ idGenerator: () => `obj-${(ordinal += 1)}` });
}

describe('ObjectManager', () => {
  it('可以同时存在多个素材，各自有独立的层级（需求文档第六节）', () => {
    const manager = createManager();
    const a = manager.create();
    const b = manager.create();
    const c = manager.create();

    expect(manager.count).toBe(3);
    expect([a.zIndex, b.zIndex, c.zIndex]).toEqual([0, 1, 2]);
    expect(manager.listByZ().map((object) => object.id)).toEqual(['obj-1', 'obj-2', 'obj-3']);
  });

  it('每个素材可以有不同的模式与控制方式', () => {
    const manager = createManager();
    const a = manager.create({ mode: 'FOLLOW_HAND' });
    const b = manager.create({ mode: 'FIXED' });
    const c = manager.create({ mode: 'TOP_HANGING', boundaryMode: 'ALLOW_OVERFLOW' });

    expect(a.mode).toBe('FOLLOW_HAND');
    expect(b.mode).toBe('FIXED');
    expect(c.mode).toBe('TOP_HANGING');
    expect(c.state.boundaryMode).toBe('ALLOW_OVERFLOW');
  });

  it('新素材带有符合需求文档第五节的完整字段集', () => {
    const manager = createManager();
    const object = manager.create();
    const state = object.state;

    expect(state.source).toBeNull();
    expect(state.position).toEqual({ x: 0.5, y: 0.5 });
    expect(state.scale).toBe(1);
    expect(state.rotation).toBe(0);
    expect(state.opacity).toBe(1);
    expect(state.visible).toBe(true);
    expect(state.anchor).toEqual({ x: 0.5, y: 0.5 });
    expect(state.mode).toBe('FIXED');
    expect(state.gestureBinding).toEqual({ activate: null, scale: null, extra: {} });
    expect(state.physicsEnabled).toBe(false);
    expect(state.interaction).toEqual({ grabbable: true, scalable: true, rotatable: false });
    expect(state.boundaryMode).toBe('CENTER_CLAMP');
    expect(state.size.width).toBe(DEFAULT_OBJECT_WIDTH);
  });

  it('交互能力开关是数据，不是代码里的特例', () => {
    const manager = createManager();
    const locked = manager.create({ interaction: { grabbable: false } });
    const normal = manager.create();

    expect(locked.state.interaction.grabbable).toBe(false);
    expect(locked.state.interaction.scalable).toBe(true);
    expect(normal.state.interaction.grabbable).toBe(true);

    normal.setInteractionConfig({ grabbable: false, rotatable: true });
    expect(normal.state.interaction).toEqual({ grabbable: false, scalable: true, rotatable: true });
  });

  it('bringToFront / sendToBack 调整绘制顺序', () => {
    const manager = createManager();
    const a = manager.create();
    const b = manager.create();
    const c = manager.create();

    manager.bringToFront(a.id);
    expect(manager.listByZ().map((object) => object.id)).toEqual([b.id, c.id, a.id]);

    manager.sendToBack(a.id);
    expect(manager.listByZ().map((object) => object.id)).toEqual([a.id, b.id, c.id]);
  });

  it('normalizeZIndex 保持相对顺序并把层级压成 0..n-1', () => {
    const manager = createManager();
    const a = manager.create();
    const b = manager.create();
    const c = manager.create();

    manager.setZIndex(a.id, 100);
    manager.setZIndex(b.id, -50);
    manager.setZIndex(c.id, 7);
    manager.normalizeZIndex();

    expect(manager.listByZ().map((object) => object.id)).toEqual([b.id, c.id, a.id]);
    expect(manager.listByZ().map((object) => object.zIndex)).toEqual([0, 1, 2]);
  });

  it('取值域约束不会被绕过', () => {
    const manager = createManager();
    const object = manager.create();

    object.setOpacity(5);
    expect(object.state.opacity).toBe(1);
    object.setOpacity(-3);
    expect(object.state.opacity).toBe(0);

    object.setScale(0);
    expect(object.state.scale).toBeGreaterThan(0);

    object.setAnchor({ x: 3, y: -1 });
    expect(object.state.anchor).toEqual({ x: 1, y: 0 });

    object.setRotation(Math.PI * 3);
    expect(Math.abs(object.state.rotation)).toBeLessThanOrEqual(Math.PI);

    object.setPosition({ x: Number.NaN, y: 0 });
    expect(object.state.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('序列化 / 反序列化保持场景完全一致', () => {
    const manager = createManager();
    manager.create({ position: { x: 0.2, y: 0.8 }, scale: 1.5, rotation: 0.4, mode: 'FOLLOW_HAND' });
    manager.create({ source: 'asset-9', opacity: 0.5, visible: false, boundaryMode: 'FULL_VISIBLE' });

    const snapshot: SceneSnapshot = JSON.parse(JSON.stringify(manager.toJSON()));

    const restored = createManager();
    restored.load(snapshot);

    expect(restored.count).toBe(2);
    expect(restored.toJSON().objects).toEqual(manager.toJSON().objects);
  });

  it('toJSON 返回深拷贝，外部改动不会污染场景', () => {
    const manager = createManager();
    const object = manager.create();
    const snapshot = manager.toJSON();

    const first = snapshot.objects[0];
    if (!first) throw new Error('缺少快照对象');
    first.position.x = 0.99;
    first.gestureBinding.extra.injected = 'yes';

    expect(object.state.position.x).toBe(0.5);
    expect(object.state.gestureBinding.extra).toEqual({});
  });

  it('版本不认识时直接抛错，而不是静默丢素材', () => {
    const manager = createManager();
    expect(() => manager.load({ version: 2 as unknown as 1, objects: [] })).toThrow(/不支持的场景快照版本/);
  });

  it('删除与清空', () => {
    const manager = createManager();
    const a = manager.create();
    manager.create();

    expect(manager.remove(a.id)).toBe(true);
    expect(manager.remove(a.id)).toBe(false);
    expect(manager.count).toBe(1);

    manager.clear();
    expect(manager.count).toBe(0);
    expect(manager.listByZ()).toEqual([]);
  });
});
