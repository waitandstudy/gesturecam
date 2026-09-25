/**
 * 素材箱的**数据层**。
 *
 * ## 素材 vs 对象 vs 资源 —— 三个概念别混
 *
 * | 概念 | 是什么 | 谁持有 |
 * | --- | --- | --- |
 * | **资源** Asset | 真正解码出来的东西（图片位图、将来的视频元素） | `core/assets/assetManager` |
 * | **素材** Material | 用户"这次拍摄要用"的那一件（箱子里的一格） | 本文件 |
 * | **对象** SceneObject | 摆在画面上、被手势操控的那一份 | `core/scene/objectManager` |
 *
 * 为什么素材要和对象分开：用户的心智是"我先挑好这次要用的东西，拍摄时再让它们出现"——
 * 挑好的那一刻它还不该出现在画面上（§25 的流程）。而同一个素材将来也可能同时摆出好几份
 * （资源/对象分离本来就是为这个留的，见 `assetManager` 的注释）。
 *
 * ## 加一种新素材要改哪里
 *
 * 只改一处：往 `MATERIAL_KINDS` 里加一条，并把 `implemented` 打开。
 * 判定、UI、提示文案全都从这张表读 —— **不要在别处写 `if (kind === 'image')` 这种分支**，
 * 那正是"写死"的来源。
 */

export type MaterialKind = 'image' | 'text' | 'video' | 'gif' | 'sticker';

export interface MaterialKindSpec {
  kind: MaterialKind;
  /** 给用户看的名字 */
  label: string;
  /** 一格列表里用得上的短标（一个字，缩略图加载不出来时当占位） */
  badge: string;
  /**
   * 是否**已经真的能用**。
   *
   * false 的条目不会变成按钮（不做点了没反应的假按钮），只在界面上列成"以后支持"。
   * 打开它 = 渲染层能画出这种素材了，别提前打开。
   */
  implemented: boolean;
  /** 一句话说明它是什么 */
  hint: string;
}

/**
 * 素材种类表 —— **唯一出处**。
 *
 * 顺序就是界面上"以后支持"的展示顺序：先做用户最常要的。
 */
export const MATERIAL_KINDS: readonly MaterialKindSpec[] = [
  { kind: 'image', label: '图片', badge: '图', implemented: true, hint: 'PNG / JPG / WEBP' },
  { kind: 'text', label: '文字', badge: '字', implemented: false, hint: '标题、要点、字幕' },
  { kind: 'video', label: '视频', badge: '视', implemented: false, hint: '一小段视频一起播' },
  { kind: 'gif', label: '动图', badge: '动', implemented: false, hint: 'GIF / 动态图' },
  { kind: 'sticker', label: '贴纸', badge: '贴', implemented: false, hint: '箭头、圈、遮挡块' },
];

/** 已经能用的种类（UI 用它决定给哪些按钮） */
export function implementedKinds(): readonly MaterialKindSpec[] {
  return MATERIAL_KINDS.filter((spec) => spec.implemented);
}

/** 还没有的种类（UI 用它生成"以后支持"那行提示） */
export function plannedKinds(): readonly MaterialKindSpec[] {
  return MATERIAL_KINDS.filter((spec) => !spec.implemented);
}

export function kindSpec(kind: MaterialKind): MaterialKindSpec {
  const found = MATERIAL_KINDS.find((spec) => spec.kind === kind);
  if (!found) throw new RangeError(`未知的素材种类：${kind}`);
  return found;
}

export interface Material {
  id: string;
  kind: MaterialKind;
  /** 用户在箱子里认得出的名字（图片用文件名，文字用内容头几个字） */
  label: string;
  /** 指向 `AssetManager` 的素材 id；文字这类没有外部资源的为 null */
  assetId: string | null;
  /**
   * 它在画面上对应的那个对象 id；还没摆出来时为 null。
   *
   * 目前一个素材最多对应一个对象。将来要"同一素材摆多份"，
   * 把这个字段换成 `objectIds: string[]` 即可 —— 调用方只经过 `link`/`unlink` 两个口子。
   */
  objectId: string | null;
}

export interface AddMaterialInput {
  kind: MaterialKind;
  label: string;
  assetId?: string | null;
}

/**
 * 素材箱：一次拍摄要用到的素材清单。
 *
 * 刻意做得很薄 —— 它只负责"有哪几件、谁对应画面上的哪一份"。
 * 解码、摆放、手势都不在这里，避免它长成一个什么都知道的上帝对象。
 */
export class MaterialLibrary {
  private readonly items: Material[] = [];
  private nextOrdinal = 1;

  get count(): number {
    return this.items.length;
  }

  list(): readonly Material[] {
    return this.items;
  }

  get(id: string): Material | undefined {
    return this.items.find((item) => item.id === id);
  }

  add(input: AddMaterialInput): Material {
    const material: Material = {
      id: `material-${this.nextOrdinal}`,
      kind: input.kind,
      label: input.label,
      assetId: input.assetId ?? null,
      objectId: null,
    };
    this.nextOrdinal += 1;
    this.items.push(material);
    return material;
  }

  /**
   * 记下"这件素材对应画面上哪个对象"。
   * 返回 false 表示素材不存在（调用方可能刚删掉它，不该当成错误）。
   */
  link(id: string, objectId: string): boolean {
    const material = this.get(id);
    if (!material) return false;
    material.objectId = objectId;
    return true;
  }

  /** 移除一件素材，返回它原来对应的对象 id（没有则 null），让调用方去收拾画面。 */
  remove(id: string): string | null {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = this.items.splice(index, 1);
    return removed?.objectId ?? null;
  }

  /**
   * 把一件素材在清单里挪 `delta` 位（`-1` = 上移，`+1` = 下移）。
   *
   * 顺序**就是响指翻页的顺序**（§28），所以这个操作是有语义的，不只是"好看"。
   * 挪不动（已经在头/尾）返回 false，让界面能把按钮禁掉 ——
   * **点了没反应的按钮比没有按钮更烦**。
   */
  move(id: string, delta: number): boolean {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const target = index + delta;
    if (target < 0 || target >= this.items.length) return false;

    const [moved] = this.items.splice(index, 1);
    if (!moved) return false;
    this.items.splice(target, 0, moved);
    return true;
  }

  clear(): void {
    this.items.length = 0;
  }
}
