/**
 * 素材管理 —— 对应需求文档第十六节的 AssetManager。
 *
 * 第一版只支持 PNG / JPG / WEBP 三种静态图片（需求文档第三节）。
 * "素材"和"场景对象"是分开的：同一张图片可以被多个对象引用（将来做"同一素材多份"
 * 或者场景模板时很有用），对象只持有 assetId。
 */

export const SUPPORTED_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const SUPPORTED_IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];

export type AssetErrorCode = 'unsupported-type' | 'load-failed' | 'empty';

export class AssetError extends Error {
  readonly code: AssetErrorCode;

  constructor(code: AssetErrorCode, message: string) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

export interface Asset {
  id: string;
  name: string;
  /** MIME 类型 */
  type: string;
  /** 由 URL.createObjectURL 生成，remove() 时会 revoke。注意：**不能**直接 JSON 序列化持久化 */
  objectUrl: string;
  width: number;
  height: number;
  image: HTMLImageElement;
  createdAt: number;
}

export interface AssetManagerOptions {
  idPrefix?: string;
  idGenerator?: (ordinal: number, prefix: string) => string;
}

function isSupported(file: File): boolean {
  if (file.type && SUPPORTED_IMAGE_TYPES.includes(file.type)) return true;
  const lower = file.name.toLowerCase();
  return SUPPORTED_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new AssetError('load-failed', '图片解码失败，文件可能已损坏或格式不受支持。'));
    image.src = url;
  });
}

export class AssetManager {
  private readonly _assets = new Map<string, Asset>();
  private readonly _idPrefix: string;
  private readonly _idGenerator: (ordinal: number, prefix: string) => string;
  private _ordinal = 1;

  constructor(options: AssetManagerOptions = {}) {
    this._idPrefix = options.idPrefix ?? 'asset';
    this._idGenerator = options.idGenerator ?? ((ordinal, prefix) => `${prefix}-${ordinal}`);
  }

  get count(): number {
    return this._assets.size;
  }

  get(id: string | null | undefined): Asset | undefined {
    return id ? this._assets.get(id) : undefined;
  }

  has(id: string): boolean {
    return this._assets.has(id);
  }

  list(): Asset[] {
    return [...this._assets.values()];
  }

  /**
   * 纹理宽高比（宽 / 高）。geometry 用它保证图片不变形。
   * 找不到素材（例如对象还没绑定图片）时退化为 1，渲染成正方形占位。
   */
  aspectOf(id: string | null | undefined): number {
    const asset = this.get(id);
    if (!asset || asset.height <= 0) return 1;
    return asset.width / asset.height;
  }

  /** 从用户选择的文件创建素材。 */
  async addImage(file: File): Promise<Asset> {
    if (file.size <= 0) {
      throw new AssetError('empty', `文件 ${file.name} 是空的。`);
    }
    if (!isSupported(file)) {
      throw new AssetError(
        'unsupported-type',
        `第一版只支持 PNG / JPG / WEBP 图片，收到的是 ${file.type || file.name}。`,
      );
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await loadImageElement(objectUrl);
      const asset: Asset = {
        id: this._idGenerator(this._ordinal, this._idPrefix),
        name: file.name,
        type: file.type || 'image/*',
        objectUrl,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        image,
        createdAt: Date.now(),
      };
      this._ordinal += 1;
      this._assets.set(asset.id, asset);
      return asset;
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  remove(id: string): boolean {
    const asset = this._assets.get(id);
    if (!asset) return false;
    URL.revokeObjectURL(asset.objectUrl);
    return this._assets.delete(id);
  }

  /** 释放所有素材（对象 URL 必须显式 revoke，否则会泄漏内存）。 */
  clear(): void {
    for (const asset of this._assets.values()) URL.revokeObjectURL(asset.objectUrl);
    this._assets.clear();
  }
}
