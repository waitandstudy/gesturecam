import { describe, expect, it } from 'vitest';

import {
  implementedKinds,
  kindSpec,
  MATERIAL_KINDS,
  MaterialLibrary,
  plannedKinds,
} from '@/core/material/library';

/**
 * 素材箱的数据层。
 *
 * 这一层最值得钉的不是"增删查改"，而是**两张表的一致性**：
 * 种类表是 UI、判定、文案的唯一出处，它一旦自相矛盾（重复、缺字段、
 * implemented 和 planned 对不上），坏的是整个界面，而不是某一个函数。
 */

describe('素材种类表', () => {
  it('每种都有名字、短标和说明（UI 直接读它，缺字段就渲染成空白）', () => {
    for (const spec of MATERIAL_KINDS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.badge.length).toBeGreaterThan(0);
      expect(spec.hint.length).toBeGreaterThan(0);
    }
  });

  it('种类不重复（重复会让"按种类查"变成碰运气）', () => {
    const kinds = MATERIAL_KINDS.map((spec) => spec.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('implemented 与 planned 互补，合起来正好是全部', () => {
    expect(implementedKinds().length + plannedKinds().length).toBe(MATERIAL_KINDS.length);
    const union = new Set([...implementedKinds(), ...plannedKinds()].map((spec) => spec.kind));
    expect(union.size).toBe(MATERIAL_KINDS.length);
  });

  it('这一轮只有"图片"是真的能用 —— 做新的种类时改这里，别去 UI 里加分支', () => {
    expect(implementedKinds().map((spec) => spec.kind)).toEqual(['image']);
  });

  it('查不到的 kind 抛错，而不是悄悄给个 undefined 让 UI 画空白', () => {
    expect(() => kindSpec('nope' as never)).toThrow(RangeError);
  });
});

describe('MaterialLibrary', () => {
  it('加进去能列出来，且 id 不重复', () => {
    const library = new MaterialLibrary();
    const a = library.add({ kind: 'image', label: 'a.png', assetId: 'asset-1' });
    const b = library.add({ kind: 'image', label: 'b.png', assetId: 'asset-2' });

    expect(library.count).toBe(2);
    expect(a.id).not.toBe(b.id);
    expect(library.list().map((item) => item.label)).toEqual(['a.png', 'b.png']);
    // 文字这类没有外部资源，assetId 必须是 null 而不是 undefined（UI 靠它判断有没有缩略图）
    expect(library.add({ kind: 'text', label: '标题' }).assetId).toBeNull();
  });

  it('link 把素材和画面上的对象对上；对不存在的素材返回 false 而不是抛错', () => {
    const library = new MaterialLibrary();
    const material = library.add({ kind: 'image', label: 'a.png', assetId: 'asset-1' });

    expect(library.link(material.id, 'obj-1')).toBe(true);
    expect(library.get(material.id)?.objectId).toBe('obj-1');

    // 素材可能刚被删掉，调用方这时不该崩
    expect(library.link('material-does-not-exist', 'obj-9')).toBe(false);
  });

  it('remove 把它对应的对象 id 交出来（调用方要据此收拾画面）', () => {
    const library = new MaterialLibrary();
    const material = library.add({ kind: 'image', label: 'a.png', assetId: 'asset-1' });
    library.link(material.id, 'obj-7');

    expect(library.remove(material.id)).toBe('obj-7');
    expect(library.count).toBe(0);
    expect(library.get(material.id)).toBeUndefined();
  });

  it('remove 不存在的 id 返回 null', () => {
    expect(new MaterialLibrary().remove('nope')).toBeNull();
  });

  it('clear 之后清空', () => {
    const library = new MaterialLibrary();
    library.add({ kind: 'image', label: 'a.png' });
    library.add({ kind: 'image', label: 'b.png' });

    library.clear();

    expect(library.count).toBe(0);
    expect(library.list()).toEqual([]);
  });

  it('move 挪位置（顺序 = 响指翻页的顺序，所以这是有语义的）', () => {
    const library = new MaterialLibrary();
    const a = library.add({ kind: 'image', label: 'a.png' });
    library.add({ kind: 'image', label: 'b.png' });
    const c = library.add({ kind: 'image', label: 'c.png' });
    const labels = (): string[] => library.list().map((item) => item.label);

    expect(library.move(c.id, -1)).toBe(true);
    expect(labels()).toEqual(['a.png', 'c.png', 'b.png']);

    expect(library.move(c.id, -1)).toBe(true);
    expect(labels()).toEqual(['c.png', 'a.png', 'b.png']);

    expect(library.move(a.id, 1)).toBe(true);
    expect(labels()).toEqual(['c.png', 'b.png', 'a.png']);
  });

  it('挪到头/尾就不动了，返回 false（界面据此把按钮禁掉）', () => {
    const library = new MaterialLibrary();
    const a = library.add({ kind: 'image', label: 'a.png' });
    const b = library.add({ kind: 'image', label: 'b.png' });
    const labels = (): string[] => library.list().map((item) => item.label);

    expect(library.move(a.id, -1)).toBe(false); // 已经在最上面
    expect(library.move(b.id, 1)).toBe(false); // 已经在最下面
    expect(labels()).toEqual(['a.png', 'b.png']); // 顺序不能被弄乱
  });

  it('挪一个不存在的 id 返回 false，不抛错', () => {
    expect(new MaterialLibrary().move('nope', -1)).toBe(false);
  });
});
