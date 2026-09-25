import { palette } from './theme';

/**
 * 极简 UI 层 —— 对应需求文档第十五节"第一版 UI 要极简"。
 *
 * 这里只做一件事：把 DOM 节点的查询和事件绑定的样板代码收拢起来，
 * 让 main.ts 专心做"装配"。UI 层不持有任何业务状态。
 *
 * 颜色**一律走 `palette()`**（`src/ui/theme.ts` 从 CSS 变量读），不在这里写十六进制 ——
 * 见 styles.css 顶部那段"颜色约定"。
 */

export type StatusKind = 'info' | 'warn' | 'error';

/** 素材箱里的一行（UI 层只认这个结构，不认核心层的 Material —— 少一层耦合） */
export interface MaterialRow {
  id: string;
  label: string;
  /** 缩略图加载不出来时显示的短标（一个字） */
  badge: string;
  /** 图片的缩略图地址；没有的（将来的文字等）传 null */
  thumbUrl: string | null;
  /** 次要说明，例如"图片 · PNG / JPG / WEBP" */
  kindHint: string;
}

/** 抽屉里的一行：比素材箱多一个"现在显示着没有" */
export interface DrawerRow extends MaterialRow {
  revealed: boolean;
}

function statusColor(kind: StatusKind): string {
  const theme = palette();
  if (kind === 'warn') return theme.warn;
  if (kind === 'error') return theme.danger;
  return '';
}

/**
 * 抽屉里"点空了算点中"的半径（CSS 像素）。
 *
 * 捏合中点是拇食指的**中点**，天然会偏；用户的感觉就是"这抽屉怎么选不中"。
 * 取 48 ≈ 一个可点区域，比行高还大一点。
 */
const DRAWER_TAP_RADIUS = 48;

function must<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`缺少必需的 DOM 节点：${selector}`);
  return element;
}

export class Controls {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  readonly status: HTMLElement;
  readonly error: HTMLElement;
  readonly addImageButton: HTMLButtonElement;
  readonly aspectButton: HTMLButtonElement;
  readonly aspectChip: HTMLElement;
  readonly recordButton: HTMLButtonElement;
  readonly clearButton: HTMLButtonElement;
  readonly switchCameraButton: HTMLButtonElement;
  readonly mirrorButton: HTMLButtonElement;
  readonly debugButton: HTMLButtonElement;
  readonly openSettingsButton: HTMLButtonElement;
  readonly closeSettingsButton: HTMLButtonElement;
  readonly settingsSheet: HTMLElement;
  readonly fileInput: HTMLInputElement;
  readonly resultPanel: HTMLElement;
  readonly resultVideo: HTMLVideoElement;
  readonly resultMeta: HTMLElement;
  readonly resultSave: HTMLButtonElement;
  readonly resultDownload: HTMLAnchorElement;
  readonly resultClose: HTMLButtonElement;
  readonly resultHint: HTMLElement;
  readonly materialSheet: HTMLElement;
  readonly materialList: HTMLElement;
  readonly materialCount: HTMLElement;
  readonly materialEmpty: HTMLElement;
  readonly materialPlanned: HTMLElement;
  readonly materialAddImage: HTMLButtonElement;
  readonly materialClear: HTMLButtonElement;
  readonly materialClose: HTMLButtonElement;
  readonly drawer: HTMLElement;
  readonly drawerList: HTMLElement;
  readonly drawerEmpty: HTMLElement;
  readonly drawerClose: HTMLButtonElement;

  constructor(root: ParentNode = document) {
    this.video = must<HTMLVideoElement>(root, '#camera-source');
    this.canvas = must<HTMLCanvasElement>(root, '#stage');
    this.status = must<HTMLElement>(root, '#status');
    this.error = must<HTMLElement>(root, '#error');
    this.addImageButton = must<HTMLButtonElement>(root, '#add-image');
    this.aspectButton = must<HTMLButtonElement>(root, '#cycle-aspect');
    this.aspectChip = must<HTMLElement>(root, '#aspect-chip');
    this.recordButton = must<HTMLButtonElement>(root, '#record');
    this.clearButton = must<HTMLButtonElement>(root, '#clear-scene');
    this.switchCameraButton = must<HTMLButtonElement>(root, '#switch-camera');
    this.mirrorButton = must<HTMLButtonElement>(root, '#toggle-mirror');
    this.debugButton = must<HTMLButtonElement>(root, '#toggle-debug');
    this.openSettingsButton = must<HTMLButtonElement>(root, '#open-settings');
    this.closeSettingsButton = must<HTMLButtonElement>(root, '#close-settings');
    this.settingsSheet = must<HTMLElement>(root, '#settings-sheet');
    this.fileInput = must<HTMLInputElement>(root, '#file-input');
    this.resultPanel = must<HTMLElement>(root, '#result-panel');
    this.resultVideo = must<HTMLVideoElement>(root, '#result-video');
    this.resultMeta = must<HTMLElement>(root, '#result-meta');
    this.resultSave = must<HTMLButtonElement>(root, '#result-save');
    this.resultDownload = must<HTMLAnchorElement>(root, '#result-download');
    this.resultClose = must<HTMLButtonElement>(root, '#result-close');
    this.resultHint = must<HTMLElement>(root, '#result-hint');
    this.materialSheet = must<HTMLElement>(root, '#material-sheet');
    this.materialList = must<HTMLElement>(root, '#material-list');
    this.materialCount = must<HTMLElement>(root, '#material-count');
    this.materialEmpty = must<HTMLElement>(root, '#material-empty');
    this.materialPlanned = must<HTMLElement>(root, '#material-planned');
    this.materialAddImage = must<HTMLButtonElement>(root, '#material-add-image');
    this.materialClear = must<HTMLButtonElement>(root, '#material-clear');
    this.materialClose = must<HTMLButtonElement>(root, '#material-close');
    this.drawer = must<HTMLElement>(root, '#drawer');
    this.drawerList = must<HTMLElement>(root, '#drawer-list');
    this.drawerEmpty = must<HTMLElement>(root, '#drawer-empty');
    this.drawerClose = must<HTMLButtonElement>(root, '#drawer-close');
  }

  /**
   * 成片画幅同时写两处：设置面板里的按钮、和顶部那个只显示的小标。
   * 顶部小标是"随时要知道"的状态，按钮是"偶尔要改"的操作 —— 两者分开，各自才够大。
   */
  setAspectLabel(label: string): void {
    this.aspectButton.textContent = `成片 ${label}`;
    this.aspectChip.textContent = label;
  }

  /** 这台设备能不能录制；不能就禁用按钮并把原因放到 title 里。 */
  setRecordingSupported(supported: boolean, reason?: string): void {
    this.recordButton.disabled = !supported;
    this.recordButton.title = supported ? '开始/停止录制' : (reason ?? '当前浏览器不支持录制');
  }

  setRecording(active: boolean): void {
    this.recordButton.dataset.recording = String(active);
    this.recordButton.setAttribute('aria-pressed', String(active));
    this.recordButton.textContent = active ? '■ 0:00' : '● 拍摄';
  }

  /**
   * 录制计时。
   * @param seconds 已经录了多久
   * @param usageRatio 0..1，用掉的上限比例（接近 1 时会变色提醒）
   */
  setRecordingTimer(seconds: number, usageRatio = 0): void {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    this.recordButton.textContent = `■ ${minutes}:${String(rest).padStart(2, '0')}`;
    // 接近上限时把按钮染成警示色：用户必须有机会主动收尾，而不是被突然停掉
    this.recordButton.dataset.usage = usageRatio >= 0.95 ? 'critical' : usageRatio >= 0.8 ? 'warning' : 'normal';
  }

  showResult(options: { url: string; meta: string; downloadName: string; saveLabel: string; hint: string }): void {
    this.resultVideo.src = options.url;
    this.resultMeta.textContent = options.meta;
    this.resultSave.textContent = options.saveLabel;
    this.resultDownload.href = options.url;
    this.resultDownload.download = options.downloadName;
    this.resultHint.textContent = options.hint;
    this.resultPanel.hidden = false;
  }

  /** 保存结果反馈（成功了/被取消了），不弹红字。 */
  setResultHint(text: string, kind: 'info' | 'error' = 'info'): void {
    const theme = palette();
    this.resultHint.textContent = text;
    this.resultHint.style.color = kind === 'error' ? theme.danger : theme.success;
  }

  hideResult(): void {
    this.resultPanel.hidden = true;
    this.resultVideo.pause();
    this.resultVideo.removeAttribute('src');
    this.resultVideo.load();
  }

  // ---------------------------------------------------------------- 素材箱

  setMaterialsOpen(open: boolean): void {
    this.materialSheet.hidden = !open;
    this.addImageButton.setAttribute('aria-pressed', String(open));
  }

  /**
   * 素材箱开关。和设置面板同一套约定：回调收到**目标状态**，不是"切换一下"——
   * 关闭按钮与点暗背景都必须传 false，做成 toggle 就会"关一次又开回来"。
   */
  onMaterialsToggle(handler: (open: boolean) => void): void {
    const apply = (open: boolean): void => {
      this.setMaterialsOpen(open);
      handler(open);
    };
    this.addImageButton.addEventListener('click', () => apply(this.materialSheet.hidden));
    this.materialClose.addEventListener('click', () => apply(false));
    this.materialSheet.addEventListener('click', (event) => {
      if (event.target === this.materialSheet) apply(false);
    });
  }

  onMaterialClear(handler: () => void): void {
    this.materialClear.addEventListener('click', handler);
  }

  /**
   * 素材箱子里的三个操作：上移 / 下移 / 删除。
   *
   * 用**事件委托**：列表每次都是整块重建的，逐行绑监听会在重建时丢掉。
   */
  onMaterialAction(handler: (action: 'up' | 'down' | 'remove', id: string) => void): void {
    this.materialList.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('[data-action]');
      const id = button?.dataset.materialId;
      const action = button?.dataset.action;
      if (!id || (action !== 'up' && action !== 'down' && action !== 'remove')) return;
      handler(action, id);
    });
  }

  /**
   * 造一行（缩略图 + 名称 + 次要说明）—— **素材箱**用的是列表行。
   *
   * 抽屉**不用**它：抽屉是给人用手指点的，要的是"图片直接铺出来"（见 `renderDrawer`），
   * 细长的行很难指中。
   */
  private createRow(row: MaterialRow, kindText: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'material-row';

    const thumb = document.createElement('div');
    thumb.className = 'material-thumb';
    if (row.thumbUrl) {
      const image = document.createElement('img');
      image.src = row.thumbUrl;
      image.alt = '';
      thumb.append(image);
    } else {
      // 没有位图的种类（将来的文字）显示短标，不留一个空白框
      thumb.textContent = row.badge;
    }

    const info = document.createElement('div');
    info.className = 'material-info';
    const label = document.createElement('p');
    label.className = 'material-label';
    // 用 textContent：label 来自用户给的文件名，绝不能让它可以注入标签
    label.textContent = row.label;
    const kind = document.createElement('p');
    kind.className = 'material-kind';
    kind.textContent = kindText;
    info.append(label, kind);

    item.append(thumb, info);
    return item;
  }

  renderMaterials(rows: readonly MaterialRow[]): void {
    this.materialCount.textContent = String(rows.length);
    this.materialEmpty.hidden = rows.length > 0;
    // 空清单时「全部清空」没有意义，禁掉而不是让它点了没反应
    this.materialClear.disabled = rows.length === 0;

    this.materialList.replaceChildren(
      ...rows.map((row, index) => {
        const item = this.createRow(row, row.kindHint);

        // 序号：顺序**就是响指翻页的顺序**，必须让人看得见
        const order = document.createElement('span');
        order.className = 'material-order';
        order.textContent = String(index + 1);
        item.prepend(order);

        const actions = document.createElement('div');
        actions.className = 'material-actions';
        actions.append(
          this.makeActionButton('↑', '上移', 'up', row.id, index === 0),
          this.makeActionButton('↓', '下移', 'down', row.id, index === rows.length - 1),
          this.makeActionButton('✕', '删除这一件', 'remove', row.id),
        );
        item.append(actions);
        return item;
      }),
    );
  }

  /**
   * 行内的小按钮（上移 / 下移 / 删除）。
   *
   * 已经在头/尾就把按钮**禁掉**，而不是让它点了没反应 ——
   * 点了没反应的按钮比没有按钮更让人困惑。
   */
  private makeActionButton(
    label: string,
    title: string,
    action: 'up' | 'down' | 'remove',
    id: string,
    disabled = false,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button material-action';
    button.textContent = label;
    button.title = title;
    button.disabled = disabled;
    button.dataset.action = action;
    button.dataset.materialId = id;
    return button;
  }

  /**
   * 抽屉跟手：`pull` 是 0..1 的露出比例（由 `core/gesture/drawerPull.ts` 每帧给出）。
   *
   * 只写一个 CSS 变量、不直接写 transform —— 位移算式留在样式表里，
   * 以后改"从哪边拉"或调动画不用动 JS。
   */
  setDrawerPull(pull: number, visible: boolean): void {
    this.drawer.hidden = !visible;
    if (visible) this.drawer.style.setProperty('--drawer-pull', String(pull));
  }

  /**
   * 抽屉里**直接把素材铺成图片格子**（不是列表行）。
   *
   * 两个理由：用手指去指的时候，大目标才点得中；而且"这是哪张图"一眼就看出来，
   * 不必读文件名。没显示出来的压暗，显示中的加主色描边 + 角标。
   */
  renderDrawer(rows: readonly DrawerRow[]): void {
    this.drawerEmpty.hidden = rows.length > 0;
    this.drawerList.replaceChildren(
      ...rows.map((row) => {
        const tile = document.createElement('li');
        tile.className = 'drawer-tile';
        tile.dataset.drawerMaterialId = row.id;
        tile.dataset.revealed = String(row.revealed);
        // 格子里只有图，名字放 title：读屏和排查问题都需要它
        tile.title = row.label;

        if (row.thumbUrl) {
          const image = document.createElement('img');
          image.src = row.thumbUrl;
          image.alt = row.label;
          tile.append(image);
        } else {
          const badge = document.createElement('span');
          badge.className = 'drawer-tile-badge';
          badge.textContent = row.badge;
          tile.append(badge);
        }

        if (row.revealed) {
          const state = document.createElement('span');
          state.className = 'drawer-tile-state';
          state.textContent = '显示中';
          tile.append(state);
        }

        return tile;
      }),
    );
  }

  /**
   * 屏幕坐标 (x, y) 对应哪一格素材；没有则 null。
   *
   * 先按**点到的元素**判；点空了就找**最近的一格**（半径内）。
   * 这一步是刻意的：捏合中点是拇食指的中点、天然会偏，没有它就会变成"怎么选都选不中"。
   * 距离按**点到矩形**算（点落在格子里就是 0），比"到中心的距离"更符合直觉 ——
   * 点在两格之间的缝里时也能归到最近那格。
   */
  drawerMaterialAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    if (element instanceof Element) {
      const direct = element.closest<HTMLElement>('[data-drawer-material-id]');
      if (direct?.dataset.drawerMaterialId) return direct.dataset.drawerMaterialId;
    }

    let best: string | null = null;
    let bestDistance = DRAWER_TAP_RADIUS * DRAWER_TAP_RADIUS;
    for (const tile of this.drawerList.querySelectorAll<HTMLElement>('[data-drawer-material-id]')) {
      const rect = tile.getBoundingClientRect();
      const nearestX = Math.min(Math.max(x, rect.left), rect.right);
      const nearestY = Math.min(Math.max(y, rect.top), rect.bottom);
      const dx = x - nearestX;
      const dy = y - nearestY;
      const squared = dx * dx + dy * dy;
      if (squared <= bestDistance) {
        bestDistance = squared;
        best = tile.dataset.drawerMaterialId ?? null;
      }
    }
    return best;
  }

  onDrawerClose(handler: () => void): void {
    this.drawerClose.addEventListener('click', handler);
  }

  /**
   * 屏幕坐标 (x, y) 是不是落在**抽屉盖住的那块区域**里。
   *
   * 按真实布局算（`getBoundingClientRect`），不在 JS 里另抄一份高度 ——
   * 抽屉的高度是 CSS 定的，抄一份迟早对不上，而"这块区域归谁"决定着手势会不会打架。
   */
  isPointInDrawer(x: number, y: number): boolean {
    if (this.drawer.hidden) return false;
    const rect = this.drawer.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /** "以后支持：文字 / 视频 …" 那行提示（内容由种类表生成，不在 UI 里写死） */
  setPlannedMaterials(text: string): void {
    this.materialPlanned.textContent = text;
    this.materialPlanned.hidden = text.length === 0;
  }

  /** 设置面板开关。面板打开时按钮状态跟着变，方便用 aria-pressed 做样式。 */
  setSettingsOpen(open: boolean): void {
    this.settingsSheet.hidden = !open;
    this.openSettingsButton.setAttribute('aria-pressed', String(open));
  }

  /**
   * 设置面板开关。
   *
   * 回调收到的是**目标状态**（true = 要打开），不是"切换一下"——
   * 关闭按钮与点暗背景都必须传 false，做成 toggle 就会"关一次又开回来"。
   */
  onSettingsToggle(handler: (open: boolean) => void): void {
    const apply = (open: boolean): void => {
      this.setSettingsOpen(open);
      handler(open);
    };
    this.openSettingsButton.addEventListener('click', () => apply(this.settingsSheet.hidden));
    this.closeSettingsButton.addEventListener('click', () => apply(false));
    // 点面板外的暗背景也关掉（和原生抽屉一致）
    this.settingsSheet.addEventListener('click', (event) => {
      if (event.target === this.settingsSheet) apply(false);
    });
  }

  onToggleRecord(handler: () => void): void {
    this.recordButton.addEventListener('click', handler);
  }

  onCloseResult(handler: () => void): void {
    this.resultClose.addEventListener('click', handler);
  }

  onSaveResult(handler: () => void): void {
    this.resultSave.addEventListener('click', handler);
  }

  setStatus(text: string, kind: StatusKind = 'info'): void {
    this.status.textContent = text;
    this.status.style.color = statusColor(kind);
  }

  showError(text: string | null): void {
    if (!text) {
      this.error.hidden = true;
      this.error.textContent = '';
      return;
    }
    this.error.hidden = false;
    this.error.textContent = text;
  }

  setMirrorPressed(pressed: boolean): void {
    this.mirrorButton.setAttribute('aria-pressed', String(pressed));
  }

  setDebugPressed(pressed: boolean): void {
    this.debugButton.setAttribute('aria-pressed', String(pressed));
  }

  setCameraReady(ready: boolean): void {
    this.switchCameraButton.disabled = !ready;
  }

  /**
   * 绑定"选择图片"。
   *
   * 触发它的**不是**底栏那个「＋」（那个现在开素材箱），而是素材箱里的「添加图片」。
   * 多这一步是有意的：素材箱是"这次要用的东西"的清单，加素材只是它的一个操作（§25）。
   */
  onPickImages(handler: (files: readonly File[]) => void): void {
    this.materialAddImage.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      if (files.length > 0) handler(files);
    });
  }
}
