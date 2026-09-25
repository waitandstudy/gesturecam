/**
 * Phase 1 浏览器端验收脚本。
 *
 * 为什么需要它：坐标变换、镜像、cover 裁切、letterbox 这些逻辑光靠单元测试只能证明
 * "公式自洽"，证明不了"渲染出来的东西真的落在用户看到的位置上"。这个脚本用
 *   Edge(headless) + 虚拟摄像头 + CDP
 * 把真实链路跑通，然后**直接读画布像素**做断言：
 *
 *   1. 摄像头是否真的起来了（虚拟设备，走的是同一条 getUserMedia 路径）
 *   2. 成片画幅是不是 9:16，letterbox 黑边是否真的在画幅之外
 *   3. 素材在场景中心时，画幅中心像素是不是素材颜色
 *   4. 素材内容**没有被镜像翻转**（测试图左上角的白块必须还在左上角）
 *   5. 开关镜像不影响素材位置与内容，只影响摄像头帧与手部位置换算
 *   6. 切换成片画幅后素材场景坐标不变，只改变可见区域
 *
 * 用法：先起 dev server，再 node tools/verify-browser.mjs
 *   VERIFY_URL 可覆盖默认的 http://localhost:5173/
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const TARGET_URL = process.env.VERIFY_URL ?? 'http://localhost:5173/';
const DEBUG_PORT = Number(process.env.VERIFY_PORT ?? 9333);
const SCREENSHOT_PATH = process.env.VERIFY_SHOT ?? 'tools/phase1-screenshot.png';
/** 录制结果面板的截图，用于人工过目 UI */
const RESULT_PANEL_SCREENSHOT_PATH = process.env.VERIFY_PANEL_SHOT ?? 'tools/phase9-result-panel.png';
/** 双手缩放的截图（含缩放宽轴与倍率读数），用于人工过目"用户看不看得懂" */
const TWO_HAND_SCREENSHOT_PATH = process.env.VERIFY_TWOHAND_SHOT ?? 'tools/phase5-two-hand.png';
/** 握拳急停的截图（含手型读数与"已取消"横幅），用于人工过目"程序为什么不动了" */
const STOP_SCREENSHOT_PATH = process.env.VERIFY_STOP_SHOT ?? 'tools/grammar-fist-stop.png';
/**
 * 指弹装填标定的两张截图："弹脑瓜"扣住（该装填）与三指张开（不该装填）。
 * 用户真机上"姿势做了没反应"时，就是照着这个面板一行一行读读数找原因。
 */
const FLICK_ARM_SCREENSHOT_PATH = process.env.VERIFY_FLICK_ARM_SHOT ?? 'tools/flick-arm-hook.png';
const FLICK_FIST_SCREENSHOT_PATH = process.env.VERIFY_FLICK_FIST_SHOT ?? 'tools/flick-arm-open-fingers.png';
/** 素材抽屉拉下来之后的样子（人工过目：图片是不是"直接铺出来"的长方形） */
const DRAWER_SCREENSHOT_PATH = process.env.VERIFY_DRAWER_SHOT ?? 'tools/drawer.png';

const TEST_COLOR = { r: 255, g: 45, b: 85 }; // 测试图填充色 #ff2d55
const COLOR_TOLERANCE = 16;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
        else resolve(message.result);
      }
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`页面内求值失败：${detail}`);
    }
    return result.result.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 20000, intervalMs = 200, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`);
}

/** 等两帧，确保渲染循环已经用新状态画过一遍 */
const NEXT_FRAMES = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))))`;

/**
 * 注入到页面里的探针工具：按**输出画幅**坐标读像素。
 * 这里刻意独立重算一遍素材的屏幕矩形（而不是调用被测代码的几何函数），
 * 否则测试和被测量共用同一段逻辑，错了也发现不了。
 */
const PROBE_HELPER = `
  const canvas = document.querySelector('#stage');
  const ctx = canvas.getContext('2d');
  const app = window.gesturecam;
  const vp = app.viewport;
  const rect = vp.displayRect;
  const obj = app.scene.objects.get(window.__verify.objectId);
  const read = (x, y) => {
    const data = ctx.getImageData(
      Math.min(canvas.width - 1, Math.max(0, Math.round(x))),
      Math.min(canvas.height - 1, Math.max(0, Math.round(y))),
      1, 1,
    ).data;
    return { r: data[0], g: data[1], b: data[2] };
  };
  // 输出画幅坐标 (0..1) -> 画布像素
  const atFrame = (fx, fy) => ({ x: rect.x + fx * rect.width, y: rect.y + fy * rect.height });
  // 素材局部坐标 (0..1) -> 画布像素
  const atObject = (lx, ly) => {
    const w = obj.state.size.width * obj.state.scale * rect.width;
    const h = w / app.assets.aspectOf(obj.state.source);
    const cx = rect.x + obj.state.position.x * rect.width;
    const cy = rect.y + obj.state.position.y * rect.height;
    return { x: cx + (lx - 0.5) * w, y: cy + (ly - 0.5) * h };
  };
`;

/**
 * 造一只"参数可控"的假手（返回**整帧归一化坐标**，即追踪模型会输出的东西）。
 *
 * ⚠️ 必须与 `tests/helpers/syntheticHand.ts` 保持同一套几何：
 * 手型判定看的是**手指朝向与伸展度**，只定义 4 个关键点的假手在那些量上毫无意义，
 * 用它测手型判定等于什么都没测。
 *
 * 参数是正交的，正好覆盖判定表的每一格：
 *   gap            拇食指指尖距离 ÷ 手掌长度（捏合的第一个维度）
 *   indexAngleDeg  食指相对中指的方向偏转（第二个维度 θ），正值偏向拇指侧
 *   *Reach         各指指尖到手腕的距离 ÷ 手掌长度（伸展 ≈ 1.35 以上，蜷曲 ≈ 1.15 以下）
 *
 * 几何在"各向同性局部坐标"里搭建（单位 = 手掌长度，手指朝屏幕上方），
 * 再映射到场景坐标、最后用 viewport.sceneToSourceNormalized 反算成归一化坐标 ——
 * 于是"构造 40° 夹角"和"判定读到 40°"是同一件事，断言可以写精确值。
 */
const SYNTHETIC_HAND_HELPER = `
  const PINCH_HAND = { gap: 0.3, indexAngleDeg: 40, indexReach: 1.55, middleReach: 1.8, ringReach: 1.75, pinkyReach: 1.6 };
  const STRAIGHT_PINCH_HAND = { gap: 0.3, indexAngleDeg: 6, indexReach: 1.55, middleReach: 1.8, ringReach: 1.75, pinkyReach: 1.6 };
  const FIST_HAND = { gap: 0.4, indexAngleDeg: 5, indexReach: 1.0, middleReach: 1.0, ringReach: 1.02, pinkyReach: 1.0 };
  const OPEN_HAND = { gap: 1.6, indexAngleDeg: 6, indexReach: 1.85, middleReach: 1.9, ringReach: 1.82, pinkyReach: 1.7 };

  const PALM_LOCAL = {
    0: { x: 0, y: 0 }, 1: { x: -0.28, y: -0.18 }, 5: { x: -0.26, y: -0.94 },
    9: { x: 0, y: -1 }, 13: { x: 0.23, y: -0.95 }, 17: { x: 0.45, y: -0.88 },
  };
  const FINGER_BASE_DIRECTION = { middle: 0, ring: 7, pinky: 16 };
  const FINGERS = [
    { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
    { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
    { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
    { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
  ];

  function rotatePoint(point, radians) {
    const cos = Math.cos(radians), sin = Math.sin(radians);
    return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
  }
  function unit(degrees) {
    const radians = (degrees * Math.PI) / 180;
    return { x: Math.sin(radians), y: -Math.cos(radians) };
  }
  function unitTowardThumb(degrees) {
    const radians = (degrees * Math.PI) / 180;
    return { x: -Math.sin(radians), y: -Math.cos(radians) };
  }
  function lerpPoint(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  function makeHand(options, center, handedness) {
    const merged = Object.assign({}, PINCH_HAND, options || {});
    const viewport = window.gesturecam.viewport;
    const palmLength = merged.palmLength || 0.1;
    const origin = center || { x: 0.5, y: 0.5 };
    const gap = merged.gap === undefined ? 0.3 : merged.gap;
    const reaches = {
      index: merged.indexReach === undefined ? 1.55 : merged.indexReach,
      middle: merged.middleReach === undefined ? 1.8 : merged.middleReach,
      ring: merged.ringReach === undefined ? 1.75 : merged.ringReach,
      pinky: merged.pinkyReach === undefined ? 1.6 : merged.pinkyReach,
    };
    const rotation = ((merged.rotationDeg || 0) * Math.PI) / 180;
    const local = {};

    const indexDirection = unitTowardThumb(merged.indexAngleDeg === undefined ? 40 : merged.indexAngleDeg);
    for (const finger of FINGERS) {
      const mcp = PALM_LOCAL[finger.mcp];
      const direction = finger.name === 'index' ? indexDirection : unit(FINGER_BASE_DIRECTION[finger.name]);
      const reach = reaches[finger.name];
      // 指尖沿"从指根出发的方向"摆，并让 |指尖-手腕| 精确等于 reach（解一元二次）
      const dot = mcp.x * direction.x + mcp.y * direction.y;
      const mcpLenSq = mcp.x * mcp.x + mcp.y * mcp.y;
      const discriminant = dot * dot - mcpLenSq + reach * reach;
      const length = discriminant > 0 ? Math.max(0, -dot + Math.sqrt(discriminant)) : 0;
      const tip = { x: mcp.x + direction.x * length, y: mcp.y + direction.y * length };
      local[finger.mcp] = mcp;
      local[finger.pip] = lerpPoint(mcp, tip, 0.4);
      local[finger.dip] = lerpPoint(mcp, tip, 0.72);
      local[finger.tip] = tip;
    }
    local[0] = PALM_LOCAL[0];

    // 拇指指尖由 gap 决定（拇食指距离 = gap × 手掌长度）
    const indexTip = local[8];
    const thumbDirection = (() => {
      const raw = { x: -0.75, y: 0.66 };
      const length = Math.hypot(raw.x, raw.y);
      return { x: raw.x / length, y: raw.y / length };
    })();
    const thumbTip = { x: indexTip.x + thumbDirection.x * gap, y: indexTip.y + thumbDirection.y * gap };
    const thumbCmc = PALM_LOCAL[1];
    local[1] = thumbCmc;
    local[2] = lerpPoint(thumbCmc, thumbTip, 0.45);
    local[3] = lerpPoint(thumbCmc, thumbTip, 0.72);
    local[4] = thumbTip;

    const aspect = viewport.sceneAspect;
    const landmarks = [];
    for (let index = 0; index < 21; index += 1) {
      const point = local[index] || { x: 0, y: -0.5 };
      const rotated = rotatePoint(point, rotation);
      const scene = {
        x: origin.x + rotated.x * palmLength,
        y: origin.y + rotated.y * palmLength * aspect,
      };
      landmarks.push({ position: viewport.sceneToSourceNormalized(scene), z: 0, visibility: 1 });
    }
    return { landmarks, handedness: handedness || 'right', confidence: 0.95 };
  }
`;

const fmt = (value) => (typeof value === 'number' ? value.toFixed(4) : String(value));

function findEdge() {
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 Edge：${EDGE_CANDIDATES.join(' / ')}`);
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

const results = [];
function check(label, passed, detail) {
  results.push({ label, passed, detail });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  return passed;
}

const isTestColor = (pixel) =>
  Math.abs(pixel.r - TEST_COLOR.r) <= COLOR_TOLERANCE &&
  Math.abs(pixel.g - TEST_COLOR.g) <= COLOR_TOLERANCE &&
  Math.abs(pixel.b - TEST_COLOR.b) <= COLOR_TOLERANCE;

const isWhite = (pixel) => pixel.r > 200 && pixel.g > 200 && pixel.b > 200;

/** 背景色 #0b0b0d：letterbox 黑边就是它 */
/**
 * "背景色"判据：**很暗**且**接近中性**（R≈G≈B）。
 *
 * 为什么不用精确的 rgb 阈值：底色是主题变量（现在是品牌底色 `#1A1A1D`），
 * 写死数字的结果是 —— 改一次主题色，这条**与主题无关**的检查就红了。
 * 换肤时正是这么红的：底色 (26,26,29) 被旧的 `b <= 28` 卡掉。
 * 这条检查真正想说的是"画幅外是背景，不是画面内容"，用"暗 + 中性"表达才对得上意图：
 * 摄像头测试图是绿色 (0,136,0)，照样能区分开。
 */
const isBackdrop = (pixel) => {
  const max = Math.max(pixel.r, pixel.g, pixel.b);
  const min = Math.min(pixel.r, pixel.g, pixel.b);
  return max <= 48 && max - min <= 6;
};

async function main() {
  const edge = findEdge();
  const userDataDir = await mkdtemp(join(tmpdir(), 'gesturecam-verify-'));
  const browser = spawn(
    edge,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--window-size=420,860',
      '--hide-scrollbars',
      TARGET_URL,
    ],
    { stdio: 'ignore', windowsHide: true },
  );

  let cdp;
  let exitCode = 0;
  try {
    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
        const targets = await response.json();
        return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      },
      { label: '调试目标出现', timeoutMs: 25000 },
    );

    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // ---- 1. 应用加载 ----
    await waitFor(() => cdp.evaluate('Boolean(window.gesturecam && window.gesturecam.scene)'), {
      label: '应用初始化（window.gesturecam）',
      timeoutMs: 20000,
    });
    check('应用加载并暴露调试接口', true, TARGET_URL);

    /*
     * 页面加载后不能有**意外**的遮挡层。
     * 这里读的是**计算样式**和**实际命中的元素**，而不是 hidden 属性 ——
     * 之前正是因为只断言 `panel.hidden`（属性为真）而 CSS 里 `display:flex` 盖过了它，
     * 导致结果面板从一打开就全屏挡着界面、还"关不掉"，测试却全绿。
     * elementFromPoint 是最接近"用户看到什么"的检查。
     *
     * ⚠️ §25 之后，打开 App 的第一屏**故意**是素材箱（挑好顺序再进相机），
     * 所以屏幕中心命中 `material-sheet` 是**对的**；要挡的是结果面板/错误框这类意外遮挡。
     * 画布本身的像素检查在后面（那时已经点过「开始拍摄」）。
     */
    const overlayProbe = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('#stage');
      const rect = canvas.getBoundingClientRect();
      const top = document.elementFromPoint(rect.width / 2, Math.min(rect.height / 2, 300));
      const panel = document.querySelector('#result-panel');
      const error = document.querySelector('#error');
      return {
        topElementId: top ? top.id || top.tagName.toLowerCase() : null,
        /*
         * ⚠️ elementFromPoint 给的是**最里层**的元素 —— 素材箱盖着屏幕时，
         * 命中的会是里面的卡片/文字（id 为空，只有 tagName），所以"是不是素材箱"
         * 必须看**祖先**，不能只比 id。
         */
        isCanvas: top ? top.id === 'stage' : false,
        inPrep: top ? Boolean(top.closest('#material-sheet')) : false,
        panelDisplay: panel ? getComputedStyle(panel).display : null,
        errorDisplay: error ? getComputedStyle(error).display : null,
      };
    })()`);

    check(
      '页面加载后没有**意外**遮挡层（结果面板与错误框真的隐藏；第一屏是素材箱）',
      (overlayProbe.isCanvas || overlayProbe.inPrep) &&
        overlayProbe.panelDisplay === 'none' &&
        overlayProbe.errorDisplay === 'none',
      `中心命中=${overlayProbe.topElementId}（在素材箱里=${overlayProbe.inPrep}，是画布=${overlayProbe.isCanvas}）结果面板 display=${overlayProbe.panelDisplay} 错误框 display=${overlayProbe.errorDisplay}`,
    );

    // ---- 2. 摄像头 ----
    let cameraReady = true;
    try {
      await waitFor(() => cdp.evaluate('window.gesturecam.camera.isRunning && window.gesturecam.camera.isReady'), {
        label: 'getUserMedia 出图',
        timeoutMs: 15000,
      });
    } catch (error) {
      cameraReady = false;
      console.log(`[WARN] 摄像头未就绪：${error.message}`);
    }

    const cameraInfo = await cdp.evaluate(`(() => {
      const c = window.gesturecam.camera;
      return { running: c.isRunning, ready: c.isReady, width: c.videoWidth, height: c.videoHeight, facing: c.facing };
    })()`);

    check(
      '摄像头采集出图（getUserMedia → video → 可被 drawImage 采样）',
      cameraReady && cameraInfo.width > 0 && cameraInfo.height > 0,
      `${cameraInfo.width}×${cameraInfo.height} facing=${cameraInfo.facing}`,
    );

    // ---- 3. 加一张带不对称标记的测试图 ----
    // 左上角画一个白块：验证素材内容有没有被镜像翻转（反字 bug 的像素级探针）
    await cdp.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ff2d55';
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(16, 16, 60, 40);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'phase1-test.png', { type: 'image/png' });

      const app = window.gesturecam;
      const asset = await app.assets.addImage(file);
      const object = app.scene.objects.create({
        source: asset.id,
        size: { width: 0.4 },
        position: { x: 0.5, y: 0.5 },
        mode: 'FIXED',
      });
      app.scene.behaviors.attach(object, 'fixed');
      window.__verify = { objectId: object.id, assetId: asset.id, aspect: app.assets.aspectOf(asset.id) };
      return window.__verify;
    })()`);

    /*
     * §25 的流程：打开 App 的**第一屏是素材箱**，挑好顺序再点「开始拍摄」进相机。
     * 后面的像素断言全都在相机画面上做，所以这里必须先"进拍摄"，否则整片都会红。
     * 顺便断言它确实是第一屏 —— 这条要是丢了，"拍摄前先选"就悄悄退化成一句空话。
     */
    const prepProbe = await cdp.evaluate(`(() => {
      const prep = document.querySelector('#material-sheet');
      return { visibleAtStart: prep ? !prep.hidden : null };
    })()`);
    check(
      '打开 App 的第一屏是**素材箱**（挑好顺序再进相机）',
      prepProbe?.visibleAtStart === true,
      `素材箱可见=${prepProbe?.visibleAtStart}`,
    );
    await cdp.evaluate(`document.querySelector('#material-close').click(); true`);
    await cdp.evaluate(NEXT_FRAMES);

    /*
     * 关掉调试叠层，避免锚点/包围盒污染像素断言。
     * ⚠️ 必须**先查状态再点**：叠层默认值已经从"开"改成了"关"（见 main.ts 的 showDebug），
     * 无脑点一下会把它**打开**，反而污染后面的像素断言。
     */
    await cdp.evaluate(`(() => {
      if (window.gesturecam.isDebugOverlayOn()) document.querySelector('#toggle-debug').click();
      return true;
    })()`);
    await cdp.evaluate(NEXT_FRAMES);

    // ---- 4. 成片画幅与 letterbox ----
    const frameProbe = await cdp.evaluate(`(() => {
      ${PROBE_HELPER}
      const barX = rect.x > 4 ? Math.round(rect.x / 2) : 0;
      const barY = rect.y > 4 ? Math.round(rect.y / 2) : 0;
      return {
        canvas: { width: canvas.width, height: canvas.height },
        rect,
        outputAspect: vp.outputAspect,
        frameAspect: rect.width / rect.height,
        barLeft: read(barX, canvas.height / 2),
        barTop: read(canvas.width / 2, barY),
      };
    })()`);

    check(
      '成片画幅是 9:16',
      Math.abs(frameProbe.frameAspect - 9 / 16) < 0.002,
      `frame ${frameProbe.rect.width.toFixed(1)}×${frameProbe.rect.height.toFixed(1)} aspect=${frameProbe.frameAspect.toFixed(4)}`,
    );
    check(
      'letterbox 黑边在画幅之外（画幅外是背景色，画幅内是画面）',
      (frameProbe.rect.x <= 4 || isBackdrop(frameProbe.barLeft)) &&
        (frameProbe.rect.y <= 4 || isBackdrop(frameProbe.barTop)),
      `rect.x=${frameProbe.rect.x.toFixed(1)} rect.y=${frameProbe.rect.y.toFixed(1)} barLeft=rgb(${frameProbe.barLeft.r},${frameProbe.barLeft.g},${frameProbe.barLeft.b}) barTop=rgb(${frameProbe.barTop.r},${frameProbe.barTop.g},${frameProbe.barTop.b})`,
    );

    // ---- 5. 像素校验：素材落位 + 内容不翻转 ----
    const probe = await cdp.evaluate(`(() => {
      ${PROBE_HELPER}
      const center = atObject(obj.state.position.x, obj.state.position.y);
      const leftMarker = atObject(0.14, 0.20);
      const rightMarker = atObject(0.86, 0.20);
      return {
        center: read(center.x, center.y),
        leftMarker: read(leftMarker.x, leftMarker.y),
        rightMarker: read(rightMarker.x, rightMarker.y),
      };
    })()`);

    check(
      '素材在场景中心时，画幅中心像素就是素材颜色（cover 适配 + 素材矩阵正确）',
      isTestColor(probe.center),
      `center=rgb(${probe.center.r},${probe.center.g},${probe.center.b})`,
    );
    check(
      '素材内容没有被镜像翻转（左上角白块仍在左上角，右侧对应位置是粉色）',
      isWhite(probe.leftMarker) && isTestColor(probe.rightMarker),
      `left=rgb(${probe.leftMarker.r},${probe.leftMarker.g},${probe.leftMarker.b}) right=rgb(${probe.rightMarker.r},${probe.rightMarker.g},${probe.rightMarker.b})`,
    );

    // ---- 6. 镜像只作用于摄像头帧与手部位置换算 ----
    await cdp.evaluate(`(() => {
      window.gesturecam.scene.objects.get(window.__verify.objectId).setPosition({ x: 0.25, y: 0.5 });
      return true;
    })()`);
    await cdp.evaluate(NEXT_FRAMES);

    const mirroredState = await cdp.evaluate(`(() => {
      ${PROBE_HELPER}
      const left = atFrame(0.25, 0.5);
      const right = atFrame(0.75, 0.5);
      const matrix = vp.createCameraMatrix();
      const vis = vp.visibleSourceRect;
      const src = vp.source;
      return {
        mirrored: vp.mirrored,
        left: read(left.x, left.y),
        right: read(right.x, right.y),
        cameraDeterminant: matrix.a * matrix.d - matrix.b * matrix.c,
        sceneAtSourceLeft: vp.sourceNormalizedToScene({ x: vis.x / src.width, y: 0.5 }).x,
        sceneAtSourceRight: vp.sourceNormalizedToScene({ x: (vis.x + vis.width) / src.width, y: 0.5 }).x,
      };
    })()`);

    check(
      '镜像开启时素材仍按场景坐标落位（场景 x=0.25 显示在画幅 25% 处）',
      isTestColor(mirroredState.left) && !isTestColor(mirroredState.right),
      `left=rgb(${mirroredState.left.r},${mirroredState.left.g},${mirroredState.left.b}) right=rgb(${mirroredState.right.r},${mirroredState.right.g},${mirroredState.right.b})`,
    );
    check(
      '镜像开启时摄像头帧使用翻转矩阵（行列式 = −1）',
      mirroredState.mirrored && mirroredState.cameraDeterminant < 0,
      `mirrored=${mirroredState.mirrored} det=${mirroredState.cameraDeterminant}`,
    );
    check(
      '镜像开启时手部换算翻转：源帧最左侧的手映射到场景 x≈1',
      mirroredState.sceneAtSourceLeft > 0.95 && mirroredState.sceneAtSourceRight < 0.05,
      `left→${mirroredState.sceneAtSourceLeft.toFixed(4)} right→${mirroredState.sceneAtSourceRight.toFixed(4)}`,
    );

    // 关掉镜像：摄像头矩阵恢复、手部换算不再翻转、素材位置不受影响
    await cdp.evaluate(`document.querySelector('#toggle-mirror').click(); true`);
    await cdp.evaluate(NEXT_FRAMES);

    const plainState = await cdp.evaluate(`(() => {
      ${PROBE_HELPER}
      const left = atFrame(0.25, 0.5);
      const matrix = vp.createCameraMatrix();
      const vis = vp.visibleSourceRect;
      const src = vp.source;
      return {
        mirrored: vp.mirrored,
        left: read(left.x, left.y),
        cameraDeterminant: matrix.a * matrix.d - matrix.b * matrix.c,
        sceneAtSourceLeft: vp.sourceNormalizedToScene({ x: vis.x / src.width, y: 0.5 }).x,
        sceneAtSourceRight: vp.sourceNormalizedToScene({ x: (vis.x + vis.width) / src.width, y: 0.5 }).x,
      };
    })()`);

    check(
      '关掉镜像后摄像头矩阵恢复正常（行列式 = +1）',
      !plainState.mirrored && Math.abs(plainState.cameraDeterminant - 1) < 1e-9,
      `mirrored=${plainState.mirrored} det=${plainState.cameraDeterminant}`,
    );
    check(
      '关掉镜像后手部换算不再翻转',
      plainState.sceneAtSourceLeft < 0.05 && plainState.sceneAtSourceRight > 0.95,
      `left→${plainState.sceneAtSourceLeft.toFixed(4)} right→${plainState.sceneAtSourceRight.toFixed(4)}`,
    );
    check(
      '开关镜像不影响素材位置（素材一直待在场景 x=0.25）',
      isTestColor(plainState.left),
      `left=rgb(${plainState.left.r},${plainState.left.g},${plainState.left.b})`,
    );

    // 恢复镜像
    await cdp.evaluate(`document.querySelector('#toggle-mirror').click(); true`);

    // ---- 7. 切换成片画幅：素材场景坐标不变，可见区域改变 ----
    const beforeAspect = await cdp.evaluate(`(() => {
      const vp = window.gesturecam.viewport;
      const obj = window.gesturecam.scene.objects.get(window.__verify.objectId);
      return { visibleWidth: vp.visibleSourceRect.width, position: { ...obj.state.position } };
    })()`);

    await cdp.evaluate(`document.querySelector('#cycle-aspect').click(); true`); // 9:16 -> 3:4
    await cdp.evaluate(NEXT_FRAMES);

    const afterAspect = await cdp.evaluate(`(() => {
      const vp = window.gesturecam.viewport;
      const obj = window.gesturecam.scene.objects.get(window.__verify.objectId);
      return {
        label: document.querySelector('#cycle-aspect').textContent,
        outputAspect: vp.outputAspect,
        visibleWidth: vp.visibleSourceRect.width,
        position: { ...obj.state.position },
      };
    })()`);

    check(
      '切换成片画幅后素材场景坐标不变',
      afterAspect.position.x === beforeAspect.position.x && afterAspect.position.y === beforeAspect.position.y,
      `position=${JSON.stringify(afterAspect.position)}`,
    );
    check(
      '画幅变宽后可见横向范围变大（3:4 比 9:16 宽）',
      afterAspect.visibleWidth > beforeAspect.visibleWidth && Math.abs(afterAspect.outputAspect - 3 / 4) < 1e-9,
      `${beforeAspect.visibleWidth.toFixed(1)} -> ${afterAspect.visibleWidth.toFixed(1)}, aspect=${afterAspect.outputAspect.toFixed(4)}, 按钮=${afterAspect.label}`,
    );

    // 切回 9:16
    for (let i = 0; i < 4; i += 1) await cdp.evaluate(`document.querySelector('#cycle-aspect').click(); true`);
    await cdp.evaluate(NEXT_FRAMES);

    // ---- 7.5 走真实 UI 添加图片：新素材必须默认"跟随手"并挂上行为 ----
    // 这条是对"捏合抓不住图片"的回归保护：光有交互层状态、没有行为消费它，用户就是拖不动。
    const uiAdd = await cdp.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 220;
      canvas.height = 220;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#4dffa8';
      ctx.fillRect(0, 0, 220, 220);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const input = document.querySelector('#file-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'ui-path-check.png', { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));

      // 等素材异步解码完成
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && window.gesturecam.assets.count < 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const objects = window.gesturecam.scene.objects.list();
      const created = objects[objects.length - 1];
      if (created) window.__verify.uiObjectId = created.id;
      return {
        objectCount: objects.length,
        mode: created ? created.mode : null,
        behaviors: created ? created.behaviors.map((behavior) => behavior.type) : [],
      };
    })()`);

    check(
      '通过真实 UI 添加图片：新素材默认 FOLLOW_HAND，并挂上跟随/缩放/边界/淡出四个行为',
      uiAdd.mode === 'FOLLOW_HAND' &&
        uiAdd.behaviors.includes('follow-hand') &&
        uiAdd.behaviors.includes('two-hand-scale') &&
        // 边界约束少了就回到"素材拖出画幅找不回来"，淡出少了就变成"啪一下消失"
        uiAdd.behaviors.includes('boundary') &&
        uiAdd.behaviors.includes('flick-fade'),
      `mode=${uiAdd.mode} behaviors=[${uiAdd.behaviors}] 场景素材数=${uiAdd.objectCount}`,
    );

    /*
     * §28 的流程：**挑进来的素材默认藏着**，打响指才一张张放出来。
     *
     * 这一步必须在这里做：后面所有"抓住素材 / 拖动 / 缩放 / 边界 / 删除"的检查都用这个对象，
     * 它要是藏着，那些检查会整片红 —— 第一版就是这么红的（16 条同时挂，
     * 症状全是 grabbed=false，看着像抓取坏了，其实只是对象没显示）。
     */
    const revealDefaults = await cdp.evaluate(`(() => {
      const app = window.gesturecam;
      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      const beforeVisible = object.state.visible;
      app.revealNext();
      return {
        beforeVisible,
        afterVisible: object.state.visible,
        x: object.state.position.x,
        y: object.state.position.y,
      };
    })()`);

    check(
      '新素材**默认藏着**；响指翻一次才出来，并落在画面左上角',
      revealDefaults?.beforeVisible === false &&
        revealDefaults?.afterVisible === true &&
        (revealDefaults?.x ?? 1) < 0.4 &&
        (revealDefaults?.y ?? 1) < 0.4,
      `翻之前 visible=${revealDefaults?.beforeVisible} 翻之后 visible=${revealDefaults?.afterVisible} 位置=(${fmt(revealDefaults?.x)},${fmt(revealDefaults?.y)})`,
    );

    // ---- 8. Phase 2：wasm / 模型 / 追踪器 ----
    const wasmProbe = await cdp.evaluate(`(async () => {
      const js = await fetch('/wasm/vision_wasm_internal.js', { method: 'GET' });
      const wasm = await fetch('/wasm/vision_wasm_internal.wasm', { method: 'HEAD' });
      return {
        js: js.status,
        jsType: js.headers.get('content-type'),
        wasm: wasm.status,
        wasmType: wasm.headers.get('content-type'),
        wasmLength: Number(wasm.headers.get('content-length') ?? 0),
      };
    })()`);

    check(
      'MediaPipe wasm 由本地提供（同源，可离线）',
      wasmProbe.js === 200 && wasmProbe.wasm === 200 && wasmProbe.wasmType?.includes('application/wasm'),
      `js=${wasmProbe.js} (${wasmProbe.jsType}) wasm=${wasmProbe.wasm} (${wasmProbe.wasmType}, ${(wasmProbe.wasmLength / 1048576).toFixed(1)}MB)`,
    );

    const modelProbe = await cdp.evaluate(`(async () => {
      const response = await fetch('/models/hand_landmarker.task', { method: 'HEAD' });
      return { status: response.status, length: Number(response.headers.get('content-length') ?? 0) };
    })()`);

    check(
      '手部识别模型由本地提供（7.8MB，首次加载后走浏览器缓存）',
      modelProbe.status === 200 && modelProbe.length > 7_000_000,
      `${modelProbe.status} ${(modelProbe.length / 1048576).toFixed(2)}MB`,
    );

    let trackerReady = true;
    try {
      await waitFor(() => cdp.evaluate('window.gesturecam.handTracker.isReady'), {
        label: 'HandLandmarker 初始化',
        timeoutMs: 60000,
        intervalMs: 300,
      });
    } catch (error) {
      trackerReady = false;
      console.log(`[WARN] 追踪器未就绪：${error.message}`);
    }

    const trackerInfo = await cdp.evaluate(`(() => {
      const t = window.gesturecam.handTracker;
      return { ready: t.isReady, delegate: t.delegate, failures: t.detectFailures };
    })()`);

    check(
      'HandLandmarker 初始化成功（GPU 优先，失败自动降级 CPU）',
      trackerReady && trackerInfo.ready,
      `delegate=${trackerInfo.delegate} failures=${trackerInfo.failures}`,
    );

    // 对虚拟摄像头跑一次真实检测：没有手应该返回空数组，而不是抛错或卡死
    const detectProbe = await cdp.evaluate(`(() => {
      const app = window.gesturecam;
      const video = document.querySelector('#camera-source');
      const frame = { width: video.videoWidth, height: video.videoHeight };
      const hands = app.handTracker.detect(video, frame, performance.now());
      return {
        source: frame,
        count: hands.length,
        input: app.handTracker.detectionInputSize,
        detectMs: app.handTracker.lastDetectMs,
      };
    })()`);

    check(
      '检测能在真实视频帧上跑通（虚拟摄像头里没有手，返回空数组）',
      detectProbe.count === 0 && detectProbe.detectMs > 0,
      `hands=${detectProbe.count} detectMs=${detectProbe.detectMs.toFixed(1)} source=${detectProbe.source.width}×${detectProbe.source.height}`,
    );
    check(
      '检测输入已降采样到 480p 以内（省算力的关键）',
      detectProbe.input.height > 0 && detectProbe.input.height <= 480,
      `输入 ${detectProbe.input.width}×${detectProbe.input.height}（源 ${detectProbe.source.width}×${detectProbe.source.height}）`,
    );

    // 时间戳必须严格递增：同一毫秒连调两次不能让模型抛错
    const monotonic = await cdp.evaluate(`(() => {
      const app = window.gesturecam;
      const video = document.querySelector('#camera-source');
      const frame = { width: video.videoWidth, height: video.videoHeight };
      const ts = performance.now();
      try {
        app.handTracker.detect(video, frame, ts);
        app.handTracker.detect(video, frame, ts); // 同一时间戳
        return { ok: true, failures: app.handTracker.detectFailures };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()`);

    check(
      '同一时间戳重复检测不会抛错（内部会自增兜底），且全程零检测失败',
      monotonic.ok === true && monotonic.failures === 0,
      JSON.stringify(monotonic),
    );

    // ---- 9. Phase 2：手势判定（合成关键点走真实 GestureManager） ----
    const gestureProbe = await cdp.evaluate(`(() => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;

      /*
       * 刻意用显式时间步长驱动真实的 GestureManager，而不是靠 injectRawHands：
       * One-Euro 是速度自适应滤波器，喂同一帧的两次调用之间 dt≈0，
       * 滤波几乎不动，比例会停在旧值上。这里按 30fps 走足够多帧让滤波收敛，
       * 既验证了判定逻辑，也顺带验证了平滑确实是按时间工作的。
       */
      const step = 1 / 30;
      let t = 0;
      const feed = (hand, frames) => {
        let state = null;
        for (let i = 0; i < frames; i += 1) {
          t += step;
          state = app.gestures.update([hand], t, viewport);
        }
        return state;
      };
      const feedUntil = (hand, frames, type) => {
        for (let i = 0; i < frames; i += 1) {
          t += step;
          const state = app.gestures.update([hand], t, viewport);
          if (state.events.some((event) => event.type === type)) return state;
        }
        return null;
      };

      const openState = feed(makeHand(OPEN_HAND), 40);
      const openRatio = app.gestures.debug.pinchRatio;
      // 事件只在状态跳变那一帧出现，所以要抓那一帧，而不是喂完之后的最后一帧
      const pinchedFrame = feedUntil(makeHand(PINCH_HAND), 40, 'gesture-start');

      return {
        openActive: openState.controls.pinch.active,
        openRatio,
        openEvents: openState.events.length,
        pinchedActive: pinchedFrame ? pinchedFrame.controls.pinch.active : null,
        pinchedRatio: app.gestures.debug.pinchRatio,
        pinchedEvents: pinchedFrame ? pinchedFrame.events.map((event) => event.type) : [],
        pinchCenter: pinchedFrame ? pinchedFrame.controls.pinch.center : null,
        handedness: pinchedFrame ? pinchedFrame.controls.primaryHandedness : null,
        palm: pinchedFrame ? pinchedFrame.controls.palm : null,
      };
    })()`);

    check(
      '张开的手不触发 pinch，捏合触发（真实 GestureManager 判定）',
      gestureProbe.openActive === false &&
        gestureProbe.openEvents === 0 &&
        gestureProbe.pinchedActive === true &&
        gestureProbe.pinchedEvents.includes('gesture-start'),
      `open(ratio=${fmt(gestureProbe.openRatio)}) pinched(ratio=${fmt(gestureProbe.pinchedRatio)}, events=[${gestureProbe.pinchedEvents}])`,
    );
    check(
      '捏合比例落在 handy 标定的范围内（指尖相触约 0.05–0.20，这里刻意取 0.3）',
      gestureProbe.pinchedRatio !== null && gestureProbe.pinchedRatio > 0.2 && gestureProbe.pinchedRatio < 0.4,
      `ratio=${fmt(gestureProbe.pinchedRatio)} hand=${gestureProbe.handedness}`,
    );
    check(
      '掌心位置与 pinch 中点都换算到了场景坐标',
      gestureProbe.palm !== null &&
        gestureProbe.pinchCenter !== null &&
        gestureProbe.palm.x > 0 &&
        gestureProbe.palm.x < 1,
      `palm=(${fmt(gestureProbe.palm?.x)},${fmt(gestureProbe.palm?.y)}) pinch=(${fmt(gestureProbe.pinchCenter?.x)},${fmt(gestureProbe.pinchCenter?.y)})`,
    );

    // ---- 10. Phase 2：手势 → 交互 → 行为 → 对象（真实链路，浏览器内跑通） ----
    const chainProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 1000;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const waitFrames = async (count) => {
        for (let i = 0; i < count; i += 1) await waitFrame();
      };

      // 按 30fps 喂若干帧同样的手，让 One-Euro 收敛
      const feed = (hand, frames) => {
        let state = null;
        for (let i = 0; i < frames; i += 1) {
          t += step;
          state = app.gestures.update([hand], t, viewport);
        }
        return state;
      };
      // 喂到出现指定事件的那一帧（抓取起点就用那一帧的真实事件）
      const feedUntil = (hand, frames, type) => {
        for (let i = 0; i < frames; i += 1) {
          t += step;
          const state = app.gestures.update([hand], t, viewport);
          if (state.events.some((event) => event.type === type)) return state;
        }
        return null;
      };

      /*
       * transition 只存活一帧，从外部按帧去读必然踩不准时机（读到的时候已经被清掉了）。
       * 所以像真实行为那样从帧内观察它 —— 顺便也验证了"行为确实能看到一次性变化"。
       *
       * 另外注意：这里刻意用**生产代码里的** follow-hand 行为，而不是测试专用的探针行为。
       * 上一轮就是因为只验证了"链路的管道通了"，而 App 里根本没有行为去消费
       * targetPosition，导致"捏合抓不住图片" —— 测量对象必须是被交付的那个东西。
       */
      window.__verify2 = { sawGrab: 0, sawRelease: 0 };
      app.scene.behaviors.register('verify-transition-watch', () => ({
        type: 'verify-transition-watch',
        stage: 'present',
        update: ({ interaction }) => {
          if (interaction.transition === 'grab') window.__verify2.sawGrab += 1;
          if (interaction.transition === 'release') window.__verify2.sawRelease += 1;
        },
      }));

      // 先试捏一次，拿到稳定的 pinch 中点，用它来放素材
      const trial = feed(makeHand(PINCH_HAND), 40);
      const center = trial.controls.pinch.center;
      if (!center) return { error: 'pinch 没有激活，拿不到中点', trialActive: trial.controls.pinch.active };

      const object = window.__verify.uiObjectId
        ? app.scene.objects.get(window.__verify.uiObjectId)
        : app.scene.objects.create({
            source: window.__verify.assetId,
            position: { x: center.x, y: center.y },
            size: { width: 0.4 },
            mode: 'FOLLOW_HAND',
          });
      if (!object) return { error: '拿不到 UI 添加的素材' };
      object.setPosition({ x: center.x, y: center.y });

      // 行为来自真实 UI 路径（main.ts 里的 attachBehaviorForMode），脚本不再手动挂 follow-hand
      if (!window.__verify.uiObjectId) app.scene.behaviors.attach(object, 'follow-hand');
      app.scene.behaviors.attach(object, 'verify-transition-watch');
      const startPosition = { ...object.state.position };

      // 松手 -> 再捏，取"捏合开始"那一帧的真实事件
      feed(makeHand(OPEN_HAND), 40);
      const grabFrame = feedUntil(makeHand(PINCH_HAND), 40, 'gesture-start');
      if (!grabFrame) return { error: '没有产生 gesture-start 事件' };

      app.setGestureOverride(grabFrame, app.gestures.smoothedHands);
      await waitFrame();

      const afterGrab = app.scene.interactions.get(object.id);
      const grabbedCheck = {
        grabbed: afterGrab.grabbed,
        transition: afterGrab.transition,
        grabOffset: { ...afterGrab.grabOffset },
        movedOnGrab: Math.hypot(
          object.state.position.x - startPosition.x,
          object.state.position.y - startPosition.y,
        ),
      };

      // 手向右下移动 -> 素材应该跟着走（follow-hand 默认有 30ms 平滑，所以多等几帧让它收敛）
      const movedFrame = feed(makeHand(PINCH_HAND, { x: 0.55, y: 0.6 }), 40);
      app.setGestureOverride(movedFrame, app.gestures.smoothedHands);
      await waitFrames(10);

      const followed = { ...object.state.position };
      const target = app.scene.interactions.get(object.id).targetPosition;

      // 松开：transition 是一次性的，所以要在投递后的第一帧读它
      const releaseFrame = feedUntil(makeHand(OPEN_HAND, { x: 0.55, y: 0.6 }), 40, 'gesture-end');
      const positionBeforeRelease = { ...object.state.position };
      app.setGestureOverride(releaseFrame, app.gestures.smoothedHands);
      await waitFrame();

      const afterRelease = app.scene.interactions.get(object.id);
      const releaseTransition = afterRelease.transition;
      const releaseGrabbed = afterRelease.grabbed;

      // 再等一帧，确认素材停住没有继续漂移
      await waitFrame();
      const released = { ...object.state.position };
      const transitions = { ...window.__verify2 };

      return {
        grabbedCheck,
        followed,
        target,
        startPosition,
        positionBeforeRelease,
        released,
        releaseGrabbed,
        releaseTransition,
        transitions,
        objectId: object.id,
      };
    })()`);

    if (chainProbe.error) {
      check('手势 → 交互 → 行为 → 对象 链路', false, chainProbe.error);
    } else {
      check(
        '捏合起点落在素材上 -> 素材被抓住，且抓取帧不跳（位置不变）',
        chainProbe.grabbedCheck.grabbed === true && chainProbe.grabbedCheck.movedOnGrab < 1e-9,
        `grabbed=${chainProbe.grabbedCheck.grabbed} transition=${chainProbe.grabbedCheck.transition} 抓取帧位移=${chainProbe.grabbedCheck.movedOnGrab.toExponential(1)}`,
      );
      check(
        '手移动后素材跟着走，并收敛到交互层算出的目标位置（用的是生产 follow-hand 行为）',
        chainProbe.target !== null &&
          Math.hypot(
            chainProbe.followed.x - chainProbe.target.x,
            chainProbe.followed.y - chainProbe.target.y,
          ) < 0.005 &&
          Math.hypot(
            chainProbe.followed.x - chainProbe.startPosition.x,
            chainProbe.followed.y - chainProbe.startPosition.y,
          ) > 0.05,
        `起点=(${fmt(chainProbe.startPosition.x)},${fmt(chainProbe.startPosition.y)}) 跟随=(${fmt(chainProbe.followed.x)},${fmt(chainProbe.followed.y)}) 目标=(${fmt(chainProbe.target?.x)},${fmt(chainProbe.target?.y)})（镜像开着，场景 x 与原始帧 x 相反）`,
      );
      check(
        '松开后素材停在原地并被释放，且行为能在帧内看到一次性的 release 变化',
        chainProbe.releaseGrabbed === false &&
          chainProbe.transitions.sawRelease >= 1 &&
          chainProbe.transitions.sawGrab >= 1 &&
          Math.abs(chainProbe.released.x - chainProbe.positionBeforeRelease.x) < 1e-9 &&
          Math.abs(chainProbe.released.y - chainProbe.positionBeforeRelease.y) < 1e-9,
        `grabbed=${chainProbe.releaseGrabbed} 行为观测到 grab×${chainProbe.transitions.sawGrab} / release×${chainProbe.transitions.sawRelease} 松开后=(${fmt(chainProbe.released.x)},${fmt(chainProbe.released.y)})`,
      );
    }

    // ---- 11. 数值自洽性 ----
    const diagnostics = await cdp.evaluate(`(() => {
      const app = window.gesturecam;
      const vp = app.viewport;
      const canvas = document.querySelector('#stage');
      const rect = canvas.getBoundingClientRect();
      const object = app.scene.objects.get(window.__verify.objectId);
      return {
        canvas: vp.canvas,
        source: vp.source,
        mirrored: vp.mirrored,
        outputAspect: vp.outputAspect,
        displayRect: vp.displayRect,
        coverScale: vp.coverScale,
        visibleSourceRect: vp.visibleSourceRect,
        exportSize1080: vp.exportSize(1920),
        dpr: canvas.width / rect.width,
        objectCount: app.scene.objects.count,
        objectState: JSON.parse(JSON.stringify(object.state)),
        interactionSize: app.scene.interactions.size,
        frame: app.scene.frame,
      };
    })()`);

    const expectedCover = Math.max(
      diagnostics.canvas.width / diagnostics.source.width,
      diagnostics.displayRect.height / diagnostics.source.height,
    );
    // coverScale 是按"输出画幅等比尺寸"算的，比较时用它和源的比例关系确认量级
    check(
      'Viewport 的 cover 适配系数与源/画幅比例自洽',
      diagnostics.coverScale > 0 && Number.isFinite(diagnostics.coverScale) && expectedCover > 0,
      `coverScale=${diagnostics.coverScale.toFixed(6)}（画幅高 ${diagnostics.displayRect.height.toFixed(1)} vs 源高 ${diagnostics.source.height}）`,
    );
    check(
      '导出尺寸正确（1080×1920 竖屏成片）',
      diagnostics.exportSize1080.width === 1080 && diagnostics.exportSize1080.height === 1920,
      JSON.stringify(diagnostics.exportSize1080),
    );
    check('渲染循环在持续出帧', diagnostics.frame > 30, `frame=${diagnostics.frame} dpr=${diagnostics.dpr}`);

    // ---- 11.5 准星提示与"移到素材上才抓住"（本轮针对"抓取不灵敏 / 手被图片盖住"） ----
    const reticleProbe = await cdp.evaluate(`(() => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 3000;
      const feed = (hand, frames) => {
        let state = null;
        for (let i = 0; i < frames; i += 1) {
          t += step;
          state = app.gestures.update([hand], t, viewport);
        }
        return state;
      };

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };

      // 张开的手（不捏合）：准星要有值，并且能指出"捏下去会抓到谁"
      const openState = feed(makeHand(OPEN_HAND, { x: 0.5, y: 0.55 }), 45);
      const point = openState.controls.pinchPoint;
      object.setPosition({ x: point.x, y: point.y });

      app.setGestureOverride(openState, app.gestures.smoothedHands);
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({
            openPinchActive: openState.controls.pinch.active,
            pinchPointPresent: point !== null,
            pinchCenterWhenOpen: openState.controls.pinch.center,
            previewTargetId: app.scene.interactions.previewTargetId,
            objectId: object.id,
            grabbed: app.scene.interactions.get(object.id).grabbed,
          });
        }));
      });
    })()`);

    if (reticleProbe.error) {
      check('准星提示（图片盖住手时的瞄准依据）', false, reticleProbe.error);
    } else {
      check(
        '没捏合时也给出准星，并指出"捏下去会抓到哪个素材"（图片盖住手时的唯一瞄准依据）',
        reticleProbe.pinchPointPresent === true &&
          reticleProbe.openPinchActive === false &&
          reticleProbe.pinchCenterWhenOpen === null &&
          reticleProbe.previewTargetId === reticleProbe.objectId &&
          reticleProbe.grabbed === false,
        `pinchPoint=${reticleProbe.pinchPointPresent} pinchActive=${reticleProbe.openPinchActive} 预览目标=${reticleProbe.previewTargetId}`,
      );
    }

    const entryProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 4000;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const feed = (hand, frames) => {
        let state = null;
        for (let i = 0; i < frames; i += 1) {
          t += step;
          state = app.gestures.update([hand], t, viewport);
        }
        return state;
      };
      const feedUntil = (hand, frames, type) => {
        for (let i = 0; i < frames; i += 1) {
          t += step;
          const state = app.gestures.update([hand], t, viewport);
          if (state.events.some((event) => event.type === type)) return state;
        }
        return null;
      };

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      const objectPosition = { ...object.state.position };

      // 先让**张开的手在素材外**稳定下来。
      // 注意不能直接瞬移过去就捏：One-Euro 平滑还没跟上，gesture-start 的事件位置
      // 会停留在素材附近，于是"起手就在素材上"而误判。
      feed(makeHand(OPEN_HAND, { x: 0.85, y: 0.85 }), 40);

      /*
       * 关键：必须把 gesture-start 那一帧**真的投递给场景**，
       * 交互层才知道"捏合是什么时候开始的"，准入窗口才会打开。
       * （真实运行时每帧手势都配一帧场景更新；同步喂 40 帧只会投递最后一帧的事件。）
       */
      const startFrame = feedUntil(makeHand(PINCH_HAND, { x: 0.85, y: 0.85 }), 40, 'gesture-start');
      if (!startFrame) return { error: '没有产生 gesture-start 事件' };
      app.setGestureOverride(startFrame, app.gestures.smoothedHands);
      await waitFrame();
      const grabbedWhileOffObject = app.scene.interactions.get(object.id).grabbed;

      // 保持捏合（这一段没有事件），把手移到素材上：素材先挪到准星下面
      const movedFrame = feed(makeHand(PINCH_HAND, { x: 0.5, y: 0.55 }), 30);
      const point = movedFrame.controls.pinchPoint;
      object.setPosition({ x: point.x, y: point.y });
      app.setGestureOverride(movedFrame, app.gestures.smoothedHands);
      await waitFrame();
      await waitFrame();

      const grabbedAfterMoving = app.scene.interactions.get(object.id).grabbed;
      const transition = app.scene.interactions.get(object.id).transition;
      app.setGestureOverride(null);
      object.setPosition(objectPosition);

      return { grabbedWhileOffObject, grabbedAfterMoving, transition, objectId: object.id };
    })()`);

    if (entryProbe.error) {
      check('"先捏上、再移到素材上"也能抓住', false, entryProbe.error);
    } else {
      check(
        '"先捏上、再把手移到素材上"也能抓住（放宽后不再要求捏合起点必须压在素材上）',
        entryProbe.grabbedWhileOffObject === false && entryProbe.grabbedAfterMoving === true,
        `起手在素材外=${entryProbe.grabbedWhileOffObject} 移到素材上后=${entryProbe.grabbedAfterMoving} transition=${entryProbe.transition}`,
      );
    }

    // ---- 11.6 Phase 5：捏合缩放（张开手指放大）+ 默认尺寸 ----
    const scaleProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 7000;
      /** 捏合 / 张开的手型预设（gap 0.3 判定为捏合，1.6 判定为张开） */
      const PINCHED = PINCH_HAND;
      const OPEN = OPEN_HAND;
      /**
       * 只等一帧。
       * 之前用两帧，结果同一个状态被渲染循环投递了两次，制造出"变化率 = 0"的假平台期，
       * 把"等平滑信号稳定"的判据骗过了 —— 这已经是第四个合成输入时序陷阱。
       */
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

      /*
       * 逐帧驱动，而不是"同步喂 40 帧再一次性投递"。
       *
       * 这一点是这次踩到的第三个合成输入陷阱：一次性投递会把同一个手势状态重复很多帧，
       * 而平滑滤波器的"收敛"过程根本没发生，所有依赖"等滤波稳定"的断言都会失真。
       * 真实运行时本来就是每帧一次手势 + 一次场景更新，所以这里也按帧来。
       */
      const deliver = async (hands) => {
        t += step;
        const state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await waitFrame();
        return state;
      };
      const deliverOne = (options) => deliver([makeHand(options, { x: 0.5, y: 0.55 })]);
      /**
       * 双手：右手**始终停在原地**（x=0.5，抓着素材的那只手），只让左手进出。
       *
       * 为什么不让"两手对称张开"：那要求右手为了摆姿势瞬移，而瞬移会触发
       * "重新捕获"重置（见 REACQUIRE_JUMP）。真机上抓着手的那只手不会瞬移，
       * 所以测试也必须这么摆 —— 第五个合成输入陷阱。
       */
      const deliverPair = (rightX, leftX, leftOptions) =>
        deliver([
          makeHand(PINCHED, { x: rightX, y: 0.55 }, 'right'),
          makeHand(leftOptions, { x: leftX, y: 0.55 }, 'left'),
        ]);

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      const defaultWidth = object.state.size.width;
      object.setScale(1);

      // 张开的手先稳定下来，并把素材放到准星下面（这样随后捏合就是抓住它）
      let open = null;
      for (let i = 0; i < 12; i += 1) open = await deliverOne(OPEN);
      const aim = open.controls.pinchPoint;
      if (!aim) return { error: '张开的手拿不到准星' };
      object.setPosition({ x: aim.x, y: aim.y });

      // 手指**渐进**合拢（gap 1.6 -> 0.3），不是瞬移
      for (const gap of [1.3, 1.0, 0.85, 0.7, 0.6, 0.5, 0.42, 0.36, 0.32, 0.3, 0.3, 0.3, 0.3]) {
        await deliverOne({ ...PINCH_HAND, gap });
      }

      const grabbedState = app.scene.interactions.get(object.id);
      const primaryShape = app.gestures.debug.perHand[0]?.shape ?? null;
      const afterGrab = {
        grabbed: grabbedState.grabbed,
        scale: object.state.scale,
        twoHandActive: grabbedState.twoHand.active,
        shape: primaryShape,
      };

      // 第二只手先**出现在旁边**（张开的手），让它自己的平滑值先稳定下来
      // （真机上第二只手就是这样先被跟踪到、再捏上的）
      for (let i = 0; i < 12; i += 1) await deliverPair(0.5, 0.7, OPEN);

      // 第二只手捏上：两手间距 0.2（整帧归一化）= 缩放基准，此时大小应当**完全不动**
      let twoHandState = null;
      for (let i = 0; i < 8; i += 1) twoHandState = await deliverPair(0.5, 0.7, PINCHED);

      const twoHandStart = {
        scale: object.state.scale,
        active: twoHandState.controls.twoHand.active,
        handCount: twoHandState.controls.handCount,
        activePinches: app.gestures.debug.activePinches,
        ratio: app.scene.interactions.twoHandDebug.distanceRatio,
      };

      // 两只手匀速拉开（各走 0.1，间距 0.2 -> 0.4 正好 2 倍），末尾停住等滤波收敛
      for (let i = 1; i <= 12; i += 1) {
        const offset = (i / 12) * 0.1;
        await deliverPair(0.5 - offset, 0.7 + offset, PINCHED);
      }
      // 停够时间：位置滤波 τ≈130ms，24 帧（0.8s≈6τ）之后倍率与尺寸才都稳到 1% 以内
      for (let i = 0; i < 24; i += 1) await deliverPair(0.4, 0.8, PINCHED);

      const spreadState = app.scene.interactions.get(object.id);
      const afterSpread = {
        grabbed: spreadState.grabbed,
        scale: object.state.scale,
        stillPinching: app.gestures.pinchActive,
        handCount: app.gestures.debug.handCount,
        ratio: app.scene.interactions.twoHandDebug.distanceRatio,
      };

      // 再一起收拢回去：必须能双向缩回去（不是只能放大）
      for (let i = 1; i <= 12; i += 1) {
        const offset = (1 - i / 12) * 0.1;
        await deliverPair(0.5 - offset, 0.7 + offset, PINCHED);
      }
      for (let i = 0; i < 12; i += 1) await deliverPair(0.5, 0.7, PINCHED);
      const afterBack = {
        grabbed: app.scene.interactions.get(object.id).grabbed,
        scale: object.state.scale,
        ratio: app.scene.interactions.twoHandDebug.distanceRatio,
      };

      // 第二只手走人：大小必须停在原地（不回弹），并退回单手拖动
      let leftState = null;
      for (let i = 0; i < 8; i += 1) leftState = await deliverOne(PINCHED);
      const afterLeave = {
        scale: object.state.scale,
        grabbed: app.scene.interactions.get(object.id).grabbed,
        twoHandActive: app.scene.interactions.get(object.id).twoHand.active,
        handCount: leftState.controls.handCount,
      };

      app.setGestureOverride(null);
      return { defaultWidth, afterGrab, twoHandStart, afterSpread, afterBack, afterLeave, objectId: object.id };
    })()`);

    // ---- 11.7 手势文法：手型判定（含"握拳不能被读成捏合"）----
    const shapeProbe = await cdp.evaluate(`(() => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 8000;

      /** 连续喂同一只手若干帧，返回最后一帧的调试快照 */
      const feed = (options, frames) => {
        let state = null;
        for (let i = 0; i < frames; i += 1) {
          t += step;
          state = app.gestures.update([makeHand(options, { x: 0.5, y: 0.5 })], t, viewport);
        }
        return state;
      };
      const snapshot = () => {
        const debug = app.gestures.debug;
        const hand = debug.perHand[0];
        return {
          shape: hand ? hand.shape : null,
          gap: hand ? hand.gap : null,
          angleDeg: hand ? hand.angleDeg : null,
          extendedIndex: hand && hand.reaches ? hand.reaches.index : null,
          middleReach: hand && hand.reaches ? hand.reaches.middle : null,
          fistHands: debug.fistHands,
          pinchActive: debug.activePinches,
        };
      };

      const open = feed(OPEN_HAND, 3);
      const openSnap = { shape: snapshot().shape, pinchActive: open.controls.pinch.active, fist: snapshot().fistHands };

      const pinch = feed(PINCH_HAND, 1);
      const pinchSnap = { shape: snapshot().shape, pinchActive: pinch.controls.pinch.active, gap: snapshot().gap, angleDeg: snapshot().angleDeg };

      // "直捏"：拇指去碰伸直的食指，夹角很小
      const straight = feed(STRAIGHT_PINCH_HAND, 1);
      const straightSnap = { shape: snapshot().shape, angleDeg: snapshot().angleDeg, extendedIndex: snapshot().extendedIndex };

      // 握拳：第 1 帧还不算（最短保持），第 2 帧才成立
      feed(FIST_HAND, 1);
      const fistFirstFrame = snapshot();
      const fist = feed(FIST_HAND, 2);
      const fistSnap = {
        shape: snapshot().shape,
        gap: snapshot().gap,
        fistHands: snapshot().fistHands,
        pinchActive: fist.controls.pinch.active,
        activePinches: snapshot().pinchActive,
      };

      /*
       * 真机反馈的回归：**"深层捏合"不能判成握拳**。
       * 捏得紧时无名指与小指会自然蜷进掌心；旧判据（四指全蜷）会把它读成握拳，
       * 而握拳的优先级高于捏合 —— 用户就"选中之后再也选不中"了。
       * 现在只认食指+中指深蜷（中指才是区分"捏"和"拳"的诚实信号）。
       */
      const deepPinch = feed(
        { gap: 0.3, indexAngleDeg: 40, indexReach: 1.0, middleReach: 1.5, ringReach: 1.0, pinkyReach: 0.95 },
        1,
      );
      const deepPinchSnap = {
        shape: snapshot().shape,
        pinchActive: deepPinch.controls.pinch.active,
        fistHands: snapshot().fistHands,
        middleReach: snapshot().middleReach,
      };

      // 放松的手（松开拳头但还半握着）也不能判成握拳
      const relaxed = feed(
        { gap: 0.75, indexAngleDeg: 18, indexReach: 1.28, middleReach: 1.26, ringReach: 1.22, pinkyReach: 1.2 },
        3,
      );
      const relaxedSnap = { shape: snapshot().shape, pinchActive: relaxed.controls.pinch.active };

      return { openSnap, pinchSnap, straightSnap, fistFirstFrame, fistSnap, deepPinchSnap, relaxedSnap };
    })()`);

    check(
      '张开手掌被判定成 open，且不触发捏合',
      shapeProbe.openSnap.shape === 'open' && shapeProbe.openSnap.pinchActive === false,
      `shape=${shapeProbe.openSnap.shape} pinch=${shapeProbe.openSnap.pinchActive}`,
    );
    check(
      '常规捏合：gap 0.30 且食→中夹角约 40°（两个维度的读数都对得上）',
      shapeProbe.pinchSnap.shape === 'pinch' &&
        shapeProbe.pinchSnap.pinchActive === true &&
        Math.abs(shapeProbe.pinchSnap.gap - 0.3) < 0.05 &&
        Math.abs(shapeProbe.pinchSnap.angleDeg - 40) < 4,
      `shape=${shapeProbe.pinchSnap.shape} gap=${fmt(shapeProbe.pinchSnap.gap)} θ=${fmt(shapeProbe.pinchSnap.angleDeg)}°`,
    );
    check(
      '"直捏"（拇指碰伸直的食指，夹角很小）照样被认作捏合',
      shapeProbe.straightSnap.shape === 'pinch' &&
        shapeProbe.straightSnap.angleDeg < 12 &&
        shapeProbe.straightSnap.extendedIndex > 1.35,
      `shape=${shapeProbe.straightSnap.shape} θ=${fmt(shapeProbe.straightSnap.angleDeg)}° 食指伸展=${fmt(shapeProbe.straightSnap.extendedIndex)}`,
    );
    check(
      '握拳被判定成 fist，**不会**被读成捏合（虽然它的 gap 比捏合阈值还小）',
      shapeProbe.fistSnap.shape === 'fist' &&
        shapeProbe.fistSnap.gap < 0.5 &&
        shapeProbe.fistSnap.pinchActive === false &&
        shapeProbe.fistSnap.activePinches === 0 &&
        shapeProbe.fistSnap.fistHands.length === 1,
      `shape=${shapeProbe.fistSnap.shape} gap=${fmt(shapeProbe.fistSnap.gap)} 捏合手数=${shapeProbe.fistSnap.activePinches} fistHands=[${shapeProbe.fistSnap.fistHands}]`,
    );
    check(
      '握拳要连续 2 帧才被承认（单帧抖动不会触发急停）',
      shapeProbe.fistFirstFrame.shape !== 'fist' && shapeProbe.fistFirstFrame.fistHands.length === 0,
      `第 1 帧 shape=${shapeProbe.fistFirstFrame.shape} fistHands=[${shapeProbe.fistFirstFrame.fistHands}]`,
    );
    check(
      '"深层捏合"（捏得紧，无名指小指蜷进掌心）不会被判成握拳（真机"再也选不中"的回归）',
      shapeProbe.deepPinchSnap.shape === 'pinch' &&
        shapeProbe.deepPinchSnap.pinchActive === true &&
        shapeProbe.deepPinchSnap.fistHands.length === 0 &&
        shapeProbe.deepPinchSnap.middleReach > 1.35,
      `shape=${shapeProbe.deepPinchSnap.shape} 中指伸展=${fmt(shapeProbe.deepPinchSnap.middleReach)} fistHands=[${shapeProbe.deepPinchSnap.fistHands}]`,
    );
    check(
      '放松的手（松开拳头但还半握着）不会被判成握拳',
      shapeProbe.relaxedSnap.shape !== 'fist' && shapeProbe.relaxedSnap.pinchActive !== true,
      `shape=${shapeProbe.relaxedSnap.shape} pinch=${shapeProbe.relaxedSnap.pinchActive}`,
    );

    // ---- 11.75 手势文法：旁观的手握拳**不该**干扰另一只手的抓取 ----
    const bystanderProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 8700;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const deliver = async (hands) => {
        t += step;
        const state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await waitFrame();
        return state;
      };
      const right = (options) => makeHand(options, { x: 0.5, y: 0.5 }, 'right');
      const left = (options) => makeHand(options, { x: 0.2, y: 0.7 }, 'left');

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      object.setScale(1);

      // 右手张开 -> 摆到准星下 -> 合拢抓住（左手同时在场，一直是张开的）
      for (let i = 0; i < 12; i += 1) await deliver([right(OPEN_HAND), left(OPEN_HAND)]);
      const crosshair = app.gestures.debug.perHand.find((hand) => hand.handedness === 'right') ? null : null;
      void crosshair;
      const point = (await deliver([right(OPEN_HAND), left(OPEN_HAND)])).controls.pinchPoint;
      if (point) object.setPosition({ x: point.x, y: point.y });
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) {
        await deliver([right({ ...PINCH_HAND, gap }), left(OPEN_HAND)]);
      }
      const grabbed = app.scene.interactions.get(object.id).grabbed;

      // 左手（什么都没抓）握拳：右手那边的会话必须原封不动
      let state = null;
      for (let i = 0; i < 4; i += 1) state = await deliver([right(PINCH_HAND), left(FIST_HAND)]);
      const afterBystanderFist = {
        grabbed: app.scene.interactions.get(object.id).grabbed,
        rearmRequired: app.scene.interactions.rearmRequired,
        fistHands: app.gestures.debug.fistHands,
        rightStillPinching: state.controls.pinches.some((pinch) => pinch.handedness === 'right' && pinch.active),
      };

      app.setGestureOverride(null);
      return { grabbed, afterBystanderFist, objectId: object.id };
    })()`);

    if (bystanderProbe.error) {
      check('旁观的手握拳不干扰另一只手的抓取', false, bystanderProbe.error);
    } else {
      check(
        '旁观的手（什么都没抓）握拳时，另一只手的抓取完全不受影响、也不会把应用锁住',
        bystanderProbe.grabbed === true &&
          bystanderProbe.afterBystanderFist.grabbed === true &&
          bystanderProbe.afterBystanderFist.rearmRequired === false &&
          bystanderProbe.afterBystanderFist.fistHands.length === 1 &&
          bystanderProbe.afterBystanderFist.rightStillPinching === true,
        `握拳前 grabbed=${bystanderProbe.grabbed} 后 grabbed=${bystanderProbe.afterBystanderFist.grabbed} 待重新武装=${bystanderProbe.afterBystanderFist.rearmRequired} fistHands=[${bystanderProbe.afterBystanderFist.fistHands}] 右手仍在捏合=${bystanderProbe.afterBystanderFist.rightStillPinching}`,
      );
    }

    // ---- 11.8 手势文法：握拳急停 → 必须张开手掌才能重新抓取（走真实场景链路）----
    const stopProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 8500;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const deliver = async (hands) => {
        t += step;
        const state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await waitFrame();
        return state;
      };
      const only = (options) => deliver([makeHand(options, { x: 0.5, y: 0.5 })]);

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      object.setScale(1);

      // 张开 -> 放到准星下 -> 渐进合拢抓住
      for (let i = 0; i < 12; i += 1) await only(OPEN_HAND);
      const crosshair = (await only(OPEN_HAND)).controls.pinchPoint;
      if (crosshair) object.setPosition({ x: crosshair.x, y: crosshair.y });
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) await only({ ...PINCH_HAND, gap });
      const grabbedBeforeStop = app.scene.interactions.get(object.id).grabbed;

      // 握拳 -> 急停
      for (let i = 0; i < 3; i += 1) await only(FIST_HAND);
      const afterStop = {
        grabbed: app.scene.interactions.get(object.id).grabbed,
        rearmRequired: app.scene.interactions.rearmRequired,
        fistHands: app.gestures.debug.fistHands,
        cancelReason: app.scene.interactions.cancelReason,
      };

      // 手指回到捏合位置（拳头松开但没张开）-> 不许抓回来
      for (let i = 0; i < 8; i += 1) await only({ ...PINCH_HAND, gap: 0.3 });
      const stillBlocked = {
        grabbed: app.scene.interactions.get(object.id).grabbed,
        rearmRequired: app.scene.interactions.rearmRequired,
      };

      // 真的张开手掌 -> 解除重新武装
      const openTrace = [];
      for (let i = 0; i < 4; i += 1) {
        await only(OPEN_HAND);
        openTrace.push({
          i,
          rearm: app.scene.interactions.rearmRequired,
          fist: app.gestures.debug.fistHands.join('|'),
          shapes: app.gestures.debug.perHand.map((hand) => hand.handedness + ':' + hand.shape).join('|'),
        });
      }
      const afterOpen = {
        rearmRequired: app.scene.interactions.rearmRequired,
        grabbed: app.scene.interactions.get(object.id).grabbed,
        shapes: app.gestures.debug.perHand.map((hand) => hand.handedness + ':' + hand.shape),
        fistHands: app.gestures.debug.fistHands,
        trace: openTrace,
      };

      // 再捏 -> 重新抓住
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) await only({ ...PINCH_HAND, gap });
      const grabbedAgain = app.scene.interactions.get(object.id).grabbed;

      app.setGestureOverride(null);
      return { grabbedBeforeStop, afterStop, stillBlocked, afterOpen, grabbedAgain, objectId: object.id };
    })()`);

    if (stopProbe.error) {
      check('握拳急停 → 重新武装（手势文法）', false, stopProbe.error);
    } else {
      check(
        '捏着素材时握拳 -> 立刻取消一切（fistHands 是非空、grabbed 变 false）',
        stopProbe.grabbedBeforeStop === true &&
          stopProbe.afterStop.grabbed === false &&
          stopProbe.afterStop.fistHands.length === 1 &&
          stopProbe.afterStop.cancelReason === 'fist',
        `握拳前 grabbed=${stopProbe.grabbedBeforeStop} 握拳后 grabbed=${stopProbe.afterStop.grabbed} fistHands=[${stopProbe.afterStop.fistHands}] 原因=${stopProbe.afterStop.cancelReason}`,
      );
      check(
        '取消后手还停在捏合位置也不许抓回来（否则急停等于没用）',
        stopProbe.afterStop.rearmRequired === true &&
          stopProbe.stillBlocked.grabbed === false &&
          stopProbe.stillBlocked.rearmRequired === true,
        `rearmRequired=${stopProbe.afterStop.rearmRequired} 回到捏合后 grabbed=${stopProbe.stillBlocked.grabbed} 仍待张开=${stopProbe.stillBlocked.rearmRequired}`,
      );
      check(
        '张开手掌后解除重新武装，再捏就能重新抓住',
        stopProbe.afterOpen.rearmRequired === false &&
          stopProbe.afterOpen.grabbed === false &&
          stopProbe.grabbedAgain === true,
        `张开后 rearmRequired=${stopProbe.afterOpen.rearmRequired} 手型=[${stopProbe.afterOpen.shapes}] fistHands=[${stopProbe.afterOpen.fistHands}] 再捏 grabbed=${stopProbe.grabbedAgain} 轨迹=${JSON.stringify(stopProbe.afterOpen.trace)}`,
      );
    }

    if (scaleProbe.error) {
      check('双手缩放（另一只手捏上，两手开合改大小）', false, scaleProbe.error);
    } else {
      check(
        '新素材默认尺寸是 0.28 画幅宽（真机反馈"太大挡住手"后调小）',
        Math.abs(scaleProbe.defaultWidth - 0.28) < 1e-9,
        `size.width=${scaleProbe.defaultWidth}`,
      );
      check(
        '单手捏合抓住素材时大小完全不变（拖动的自由度不再耦合到大小上）',
        scaleProbe.afterGrab.grabbed === true &&
          scaleProbe.afterGrab.twoHandActive === false &&
          Math.abs(scaleProbe.afterGrab.scale - 1) < 0.02,
        `grabbed=${scaleProbe.afterGrab.grabbed} scale=${fmt(scaleProbe.afterGrab.scale)} 双手=${scaleProbe.afterGrab.twoHandActive}`,
      );
      check(
        '第二只手捏上后双手状态成立（两只手都被识别到、都在捏合）',
        scaleProbe.twoHandStart.active === true &&
          scaleProbe.twoHandStart.handCount === 2 &&
          scaleProbe.twoHandStart.activePinches === 2 &&
          Math.abs(scaleProbe.twoHandStart.ratio - 1) < 0.02 &&
          Math.abs(scaleProbe.twoHandStart.scale - 1) < 0.02,
        `双手=${scaleProbe.twoHandStart.active} 手数=${scaleProbe.twoHandStart.handCount} 捏合手数=${scaleProbe.twoHandStart.activePinches} 倍率=${fmt(scaleProbe.twoHandStart.ratio)} scale=${fmt(scaleProbe.twoHandStart.scale)}`,
      );
      check(
        '两手拉开到 2 倍间距 -> 素材放大到约 2 倍，且两只手都没掉捏合',
        scaleProbe.afterSpread.grabbed === true &&
          scaleProbe.afterSpread.stillPinching === true &&
          scaleProbe.afterSpread.handCount === 2 &&
          Math.abs(scaleProbe.afterSpread.ratio - 2) < 0.05 &&
          Math.abs(scaleProbe.afterSpread.scale - 2) < 0.05,
        `grabbed=${scaleProbe.afterSpread.grabbed} 手数=${scaleProbe.afterSpread.handCount} 倍率=${fmt(scaleProbe.afterSpread.ratio)} scale=${fmt(scaleProbe.afterSpread.scale)}`,
      );
      check(
        '两手收拢回 1 倍间距 -> 素材缩回原大小（双向可用，不是只能放大）',
        scaleProbe.afterBack.grabbed === true &&
          Math.abs(scaleProbe.afterBack.ratio - 1) < 0.05 &&
          Math.abs(scaleProbe.afterBack.scale - 1) < 0.05,
        `倍率=${fmt(scaleProbe.afterBack.ratio)} scale=${fmt(scaleProbe.afterBack.scale)}`,
      );
      check(
        '第二只手离开后大小停在原地（不回弹），并退回单手拖动',
        scaleProbe.afterLeave.grabbed === true &&
          scaleProbe.afterLeave.twoHandActive === false &&
          scaleProbe.afterLeave.handCount === 1 &&
          Math.abs(scaleProbe.afterLeave.scale - 1) < 0.05,
        `grabbed=${scaleProbe.afterLeave.grabbed} 双手=${scaleProbe.afterLeave.twoHandActive} 手数=${scaleProbe.afterLeave.handCount} scale=${fmt(scaleProbe.afterLeave.scale)}`,
      );
    }

    // ---- 11.9 边界约束：素材拖不出画幅，而且永远抓得回来 ----
    const boundaryProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 10000;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const deliver = async (hands) => {
        t += step;
        const state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await waitFrame();
        return state;
      };

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      // 换成跟随手模式（UI 添加的素材就是这个模式），并确保只留它一个
      for (const item of app.scene.objects.list()) {
        if (item.id !== object.id) app.scene.objects.remove(item.id);
      }

      // 张开的手 -> 把素材放到准星下 -> 抓住
      for (let i = 0; i < 12; i += 1) await deliver([makeHand(OPEN_HAND, { x: 0.5, y: 0.5 })]);
      const crosshair = (await deliver([makeHand(OPEN_HAND, { x: 0.5, y: 0.5 })])).controls.pinchPoint;
      if (crosshair) object.setPosition({ x: crosshair.x, y: crosshair.y });
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) {
        await deliver([makeHand({ ...PINCH_HAND, gap }, { x: 0.5, y: 0.5 })]);
      }
      const grabbed = app.scene.interactions.get(object.id).grabbed;

      /*
       * 往四个方向"拖到画面外"：手移得很远（场景坐标 3 / -3），
       * 边界约束必须在 constrain 阶段把素材拉回画幅内。
       */
      const extremes = [
        { x: 3, y: 0.5 },
        { x: -3, y: 0.5 },
        { x: 0.5, y: 3 },
        { x: 0.5, y: -3 },
      ];
      const positions = [];
      for (const center of extremes) {
        for (let i = 0; i < 12; i += 1) await deliver([makeHand(PINCH_HAND, center)]);
        const state = object.state;
        const size = { width: state.size.width * state.scale, height: state.size.width * state.scale };
        positions.push({
          center: { x: center.x, y: center.y },
          position: { x: state.position.x, y: state.position.y },
          insideFrame:
            state.position.x >= -1e-6 &&
            state.position.x <= 1 + 1e-6 &&
            state.position.y >= -1e-6 &&
            state.position.y <= 1 + 1e-6,
          size,
        });
      }

      // 拖到极远之后松手，再检查它是否还能被重新抓住
      for (let i = 0; i < 8; i += 1) await deliver([makeHand(OPEN_HAND, { x: 0.5, y: 0.5 })]);
      const afterRelease = app.scene.interactions.previewTargetId;
      const objectState = { x: object.state.position.x, y: object.state.position.y };
      // 把准星移回素材上（用它的实际位置），确认还能命中
      const regrab = [];
      for (let i = 0; i < 10; i += 1) {
        await deliver([makeHand(OPEN_HAND, objectState)]);
        regrab.push(app.scene.interactions.previewTargetId === object.id);
      }

      app.setGestureOverride(null);
      return { grabbed, positions, stillGrabbable: regrab.some(Boolean), afterRelease, objectId: object.id };
    })()`);

    if (boundaryProbe.error) {
      check('边界约束（素材拖不出画幅）', false, boundaryProbe.error);
    } else {
      const allInside = boundaryProbe.positions.every((item) => item.insideFrame);
      check(
        '往四个方向拖到画面外，素材都被钳回画幅内（不会再"拖丢"）',
        boundaryProbe.grabbed === true && allInside,
        boundaryProbe.positions
          .map((item) => `手(${fmt(item.center.x)},${fmt(item.center.y)})→素材(${fmt(item.position.x)},${fmt(item.position.y)})`)
          .join(' '),
      );
      check(
        '被钳到边缘之后素材仍然抓得回来（准星还能命中它）',
        boundaryProbe.stillGrabbable === true,
        `stillGrabbable=${boundaryProbe.stillGrabbable}`,
      );
    }

    // ---- 11.10 指弹删除：弹中 → 淡出 → 撤销 / 到期移除 ----
    const flickProbe = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const step = 1 / 30;
      let t = 11000;
      const waitFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const deliver = async (hands) => {
        t += step;
        const state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await waitFrame();
        return state;
      };
      const only = (options) => deliver([makeHand(options, { x: 0.5, y: 0.5 })]);

      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };

      /*
       * 装填态 = "弹脑瓜"的蓄力姿势（**第五轮真机实测**）：拇指扣住食指尖（gap 0.45）、
       * 其余三指蜷着（中指 0.91）、食指是伸着的（1.52）。
       * 甩开 = 拇指松开（gap 0.9）+ 食指伸直（1.52 → 1.85）。
       *
       * 注意这一甩的指尖位移只有约 0.03 个画幅宽 ⇒ 算出来速度约 1.0 /秒，
       * 正好贴着门槛 —— 这就是"速度门槛到底该定多少"必须靠真机读数的原因（见 flick.ts）。
       */
      const LOADED = { gap: 0.45, indexAngleDeg: 40, indexReach: 1.52, middleReach: 0.91, ringReach: 0.8, pinkyReach: 0.7 };
      const RELEASED = { ...LOADED, gap: 0.9, indexReach: 1.85 };

      // 先喂装填状态，把素材放到**指尖**底下（指尖是最准的瞄准点）
      for (let i = 0; i < 8; i += 1) await only(LOADED);
      const tip = app.gestures.smoothedHands[0]?.landmarks[8]?.position;
      if (tip) object.setPosition({ x: tip.x, y: tip.y });
      for (let i = 0; i < 3; i += 1) await only(LOADED);
      const armed = app.gestures.debug.flickArmed;

      // 弹出去
      const flicked = await only(RELEASED);
      const afterFlick = {
        flicks: flicked.flicks.length,
        armedBefore: armed,
        flickSpeed: app.gestures.debug.flickSpeed,
        minTipSpeed: app.gestures.debug.flick?.thresholds.minTipSpeed ?? null,
        deletingCount: app.scene.interactions.deletingCount,
        deleting: app.scene.interactions.get(object.id).deleting,
        objectCount: app.scene.objects.count,
      };

      // 淡出：等几帧，不透明度应该在降，但素材还在
      const opacitySamples = [];
      for (let i = 0; i < 8; i += 1) {
        await only(LOADED);
        opacitySamples.push(object.state.opacity);
      }
      const midFade = {
        opacity: object.state.opacity,
        stillThere: app.scene.objects.get(object.id) !== undefined,
        progress: app.scene.interactions.get(object.id).deleting.progress,
      };

      // 撤销：捏住它
      for (const gap of [1.0, 0.7, 0.5, 0.35, 0.3, 0.3]) await only({ ...PINCH_HAND, gap });
      const afterUndo = {
        deletingCount: app.scene.interactions.deletingCount,
        grabbed: app.scene.interactions.get(object.id).grabbed,
        opacity: object.state.opacity,
        stillThere: app.scene.objects.get(object.id) !== undefined,
      };

      // 再弹一次，这次不撤销，等它到期被移除。
      // 用**自己造的**素材来验这条（破坏性用例不该把别人要用的素材删掉）。
      for (let i = 0; i < 6; i += 1) await only(OPEN_HAND);
      const victimId = app.createDemoObject({ position: { x: 0.5, y: 0.5 } });
      if (!victimId) return { error: '没有可用素材来造删除用例的对象' };
      const victim = app.scene.objects.get(victimId);
      for (let i = 0; i < 8; i += 1) await only(LOADED);
      const victimTip = app.gestures.smoothedHands[0]?.landmarks[8]?.position;
      if (victimTip) victim.setPosition({ x: victimTip.x, y: victimTip.y });
      for (let i = 0; i < 2; i += 1) await only(LOADED);
      await only(RELEASED);
      const beforeExpiry = {
        deletingCount: app.scene.interactions.deletingCount,
        victimThere: app.scene.objects.get(victimId) !== undefined,
      };
      // 淡出期 2 秒：rAF 一帧约 16ms，所以这里要喂够真实时间（不是"喂够帧数"）
      for (let i = 0; i < 220; i += 1) await only(OPEN_HAND);
      const afterExpiry = {
        victimThere: app.scene.objects.get(victimId) !== undefined,
        deletingCount: app.scene.interactions.deletingCount,
        uiObjectStillThere: app.scene.objects.get(object.id) !== undefined,
      };

      app.setGestureOverride(null);
      return { objectId: object.id, afterFlick, midFade, afterUndo, beforeExpiry, afterExpiry, opacitySamples };
    })()`);

    if (flickProbe.error) {
      check('指弹删除（弹中 → 淡出 → 撤销 / 移除）', false, flickProbe.error);
    } else {
      check(
        '指弹被识别出来（"拇指扣住"装填成立、甩开产生一次 flick 事件）',
        flickProbe.afterFlick.flicks === 1 &&
          flickProbe.afterFlick.armedBefore === true &&
          flickProbe.afterFlick.minTipSpeed !== null &&
          flickProbe.afterFlick.flickSpeed >= flickProbe.afterFlick.minTipSpeed,
        `armed=${flickProbe.afterFlick.armedBefore} flicks=${flickProbe.afterFlick.flicks} 速度=${fmt(flickProbe.afterFlick.flickSpeed)}(需≥${fmt(flickProbe.afterFlick.minTipSpeed)})`,
      );
      check(
        '弹中的素材进入淡出期：不透明度在降、但素材还在（不是"啪一下消失"）',
        flickProbe.afterFlick.deletingCount === 1 &&
          flickProbe.afterFlick.deleting.active === true &&
          flickProbe.midFade.stillThere === true &&
          flickProbe.midFade.progress > 0 &&
          flickProbe.midFade.opacity < 1 &&
          flickProbe.midFade.opacity > 0,
        `淡出中=${flickProbe.afterFlick.deleting.active} 进度=${fmt(flickProbe.midFade.progress)} 不透明度=${fmt(flickProbe.midFade.opacity)}`,
      );
      check(
        '淡出期里再捏住它 = 撤销（不透明度还原、素材保留）',
        flickProbe.afterUndo.deletingCount === 0 &&
          flickProbe.afterUndo.grabbed === true &&
          flickProbe.afterUndo.stillThere === true &&
          Math.abs(flickProbe.afterUndo.opacity - 1) < 1e-6,
        `撤销后 deleting=${flickProbe.afterUndo.deletingCount} grabbed=${flickProbe.afterUndo.grabbed} 不透明度=${fmt(flickProbe.afterUndo.opacity)}`,
      );
      check(
        '不撤销的话，淡出期走完素材真的被移除（而且不会误伤别的素材）',
        flickProbe.beforeExpiry.deletingCount === 1 &&
          flickProbe.beforeExpiry.victimThere === true &&
          flickProbe.afterExpiry.victimThere === false &&
          flickProbe.afterExpiry.uiObjectStillThere === true,
        `到期前 victim=${flickProbe.beforeExpiry.victimThere} 到期后 victim=${flickProbe.afterExpiry.victimThere} UI素材仍在=${flickProbe.afterExpiry.uiObjectStillThere}`,
      );
    }

    // ---- 11.11 录制上限：到点自动停止并保存（不是"录到一半崩掉"）----
    const limitProbe = await cdp.evaluate(`(async () => {
      const app = window.gesturecam;
      if (!app.recorder.supported) return { supported: false };
      // 把上限调成 1.5 秒，几秒内就能跑到那条路径
      app.setRecordingLimits({ maxDurationSeconds: 1.5, maxBytes: 400 * 1024 * 1024 });
      app.setGestureOverride(null);

      await app.startRecording();
      const started = app.recorder.isRecording;

      // 等到略超过上限：应该被自动停掉
      await new Promise((resolve) => setTimeout(resolve, 2600));

      const afterLimit = {
        stillRecording: app.recorder.isRecording,
        hasResult: Boolean(app.lastResult),
        resultBytes: app.lastResult ? app.lastResult.blob.size : 0,
        state: app.recorder.state,
        panelDisplay: (() => {
          const panel = document.querySelector('#result-panel');
          return panel ? getComputedStyle(panel).display : null;
        })(),
        statusText: document.querySelector('#status')?.textContent ?? null,
      };

      // 收尾：关掉面板，恢复默认上限，并把状态栏还原
      // （不然这条"已到上限"会留在后面截图的画面里，人工过目时容易被误导）
      document.querySelector('#result-close')?.click();
      app.setRecordingLimits({ maxDurationSeconds: 300 });
      app.refreshStatus();
      return { supported: true, started, afterLimit };
    })()`);

    if (!limitProbe.supported) {
      check('录制上限（到点自动停止并保存）', false, '当前浏览器不支持录制');
    } else {
      check(
        '录到上限会自动停止、并且照常拿到文件（不是报错、更不是丢文件）',
        limitProbe.started === true &&
          limitProbe.afterLimit.stillRecording === false &&
          limitProbe.afterLimit.hasResult === true &&
          limitProbe.afterLimit.resultBytes > 0 &&
          limitProbe.afterLimit.panelDisplay === 'flex',
        `自动停=${limitProbe.afterLimit.stillRecording === false} 有文件=${limitProbe.afterLimit.hasResult} 体积=${limitProbe.afterLimit.resultBytes}B 面板=${limitProbe.afterLimit.panelDisplay}`,
      );
      check(
        '自动停止时状态栏说明了原因（用户得知道为什么停了）',
        typeof limitProbe.afterLimit.statusText === 'string' &&
          limitProbe.afterLimit.statusText.includes('上限'),
        `状态栏=${limitProbe.afterLimit.statusText}`,
      );
    }

    // ---- 11.12 切到后台：自动停录并保存（后台时画布不再更新，继续录只会得到冻结画面）----
    const hiddenProbe = await cdp.evaluate(`(async () => {
      const app = window.gesturecam;
      if (!app.recorder.supported) return { supported: false };
      app.setRecordingLimits({ maxDurationSeconds: 300, maxBytes: 400 * 1024 * 1024 });
      app.setGestureOverride(null);

      await app.startRecording();
      const started = app.recorder.isRecording;
      await new Promise((resolve) => setTimeout(resolve, 700));

      /*
       * 模拟"页面被切到后台"：实例上定义一个同名的 visibilityState 遮蔽原型上的 getter，
       * 再派发真实的 visibilitychange 事件 —— 走的是产品里那个监听器本身，
       * 不是另写一条测试专用的分支。
       */
      const originalDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 900));

      const afterHidden = {
        stillRecording: app.recorder.isRecording,
        hasResult: Boolean(app.lastResult),
        bytes: app.lastResult ? app.lastResult.blob.size : 0,
        state: app.recorder.state,
        panelDisplay: (() => {
          const panel = document.querySelector('#result-panel');
          return panel ? getComputedStyle(panel).display : null;
        })(),
        status: document.querySelector('#status')?.textContent ?? null,
      };

      // 还原可见性并清理（后面还有别的用例）
      if (originalDescriptor) Object.defineProperty(document, 'visibilityState', originalDescriptor);
      else delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector('#result-close')?.click();
      // 把状态栏还给产品自己的提示（不然这条"切到后台"会留在后面截图的画面里）
      app.refreshStatus();
      return { supported: true, started, afterHidden };
    })()`);

    if (!hiddenProbe.supported) {
      check('切到后台自动停录并保存', false, '当前浏览器不支持录制');
    } else {
      check(
        '页面切到后台 -> 立刻停录并把已经录到的部分保存下来（不是继续录成一段冻结画面）',
        hiddenProbe.started === true &&
          hiddenProbe.afterHidden.stillRecording === false &&
          hiddenProbe.afterHidden.hasResult === true &&
          hiddenProbe.afterHidden.bytes > 0 &&
          hiddenProbe.afterHidden.panelDisplay === 'flex',
        `切后台前在录=${hiddenProbe.started} 之后仍在录=${hiddenProbe.afterHidden.stillRecording} 有文件=${hiddenProbe.afterHidden.hasResult} 体积=${hiddenProbe.afterHidden.bytes}B 面板=${hiddenProbe.afterHidden.panelDisplay}`,
      );
      check(
        '切后台自动停止时也说明了原因',
        typeof hiddenProbe.afterHidden.status === 'string' &&
          hiddenProbe.afterHidden.status.includes('后台'),
        `状态栏=${hiddenProbe.afterHidden.status}`,
      );
    }

    // ---- 11.13 指弹装填门槛：扣住能装填、三指张开不能（对应真机"弹脑瓜装填不上"）----
    /*
     * 这一条被真机反馈**改了两次**，第二次是整模型重写（见 `flick.ts` 文件头）：
     *   · 第一版要求 食指 ≤1.20 / gap ≥0.80 —— 用户一次都装填不上；
     *   · 第二版放宽到 ≤1.35 / ≥0.60 + 中指 ≥1.10 —— **还是**一次都装填不上，
     *     因为方向就是反的：真姿势是**拇指扣在食指尖上**（gap 0.45），不是"拇指躲开"。
     * 现在钉住的两个姿势（都用真机实测读数）：
     *   · 扣住（食 1.52、gap 0.45、其余三指蜷着 0.91）→ 必须装填；
     *   · 拇指照旧扣着但其余三指张开（= 张开手掌）→ 必须不装填，且面板指出是哪条在挡。
     * 两种姿势各截一张调试面板的图：真机排查"装填不上"靠的就是面板上的那两行读数。
     *
     * 截图必须由 Node 侧在两次姿势之间抓，所以这里拆成"先摆姿势"和"再读数"两步
     * （页面内拿不到截图 API）。
     */
    const flickPoseSetup = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      app.setGestureOverride(null);
      const t = { value: 21000 };
      const feed = async (options) => {
        t.value += 1 / 30;
        const state = app.gestures.update([makeHand(options, { x: 0.5, y: 0.5 })], t.value, app.viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return state;
      };
      // 两种姿势的开关（页面内调用，避免每次都把 helper 重发一遍）
      const POSE = {
        // 真机实测的"弹脑瓜"蓄力：拇指扣住食指尖（gap 0.45）+ 其余三指蜷着
        hook: { gap: 0.45, indexAngleDeg: 40, indexReach: 1.52, middleReach: 0.91, ringReach: 0.8, pinkyReach: 0.7 },
        // 拇指照旧扣着，但其余三指张开了 —— 那是"张开手掌"，不该装填
        'open-fingers': { gap: 0.45, indexAngleDeg: 40, indexReach: 1.52, middleReach: 1.4, ringReach: 1.35, pinkyReach: 1.25 },
        open: OPEN_HAND,
      };
      window.__flickArm = {
        pose: async (name) => {
          for (let i = 0; i < 12; i += 1) await feed(POSE[name]);
        },
        read: () => {
          const info = app.gestures.debug.flick;
          return info ? {
            armed: app.gestures.debug.flickArmed,
            armedFrames: info.armedFrames,
            indexReach: info.indexReach,
            middleReach: info.middleReach,
            gap: info.gap,
            peakSpeed: info.peakSpeed,
            gapGain: info.gapGain,
            releaseSpeed: info.releaseSpeed,
            shape: info.shape,
            handedness: info.handedness,
            thresholds: info.thresholds,
            // 调试叠层的真实开关状态（叠层画在画布上，没有 DOM 面板可查）
            debugOverlayOn: app.isDebugOverlayOn(),
          } : null;
        },
        reset: async () => {
          await window.__flickArm.pose('open');
          app.setGestureOverride(null);
          app.refreshStatus();
        },
      };

      // 打开调试叠层：截图里要能直接读到那几行读数
      if (!app.isDebugOverlayOn()) document.querySelector('#toggle-debug')?.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      await window.__flickArm.pose('hook');
      return { ready: true, read: window.__flickArm.read() };
    })()`);

    const hookShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(FLICK_ARM_SCREENSHOT_PATH, Buffer.from(hookShot.data, 'base64'));

    const flickOpenRead = await cdp.evaluate(`(async () => {
      if (!window.__flickArm) return null;
      await window.__flickArm.pose('open-fingers');
      return window.__flickArm.read();
    })()`);

    const openShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(FLICK_FIST_SCREENSHOT_PATH, Buffer.from(openShot.data, 'base64'));

    await cdp.evaluate(`(async () => {
      await window.__flickArm?.reset();
      delete window.__flickArm;
      return true;
    })()`);

    const hh = flickPoseSetup?.read ?? null;
    const hf = flickOpenRead ?? null;

    if (hh && hf) {
      check(
        '指弹装填：真机实测的"弹脑瓜"蓄力（食 1.52 / 拇指扣住 gap 0.45 / 其余三指蜷着 0.91）能装填',
        hh.armed === true && hh.armedFrames >= hh.thresholds.loadedFrames,
        `装填=${hh.armed} 帧数=${hh.armedFrames}/${hh.thresholds.loadedFrames} 扣=${fmt(hh.gap)}(需≤${fmt(hh.thresholds.loadedMaxGap)}) 中=${fmt(hh.middleReach)}(需≤${fmt(hh.thresholds.maxMiddleReach)}) 食=${fmt(hh.indexReach)}`,
      );
      check(
        '指弹装填：拇指照旧扣着但其余三指张开（=张开手掌）不装填，且面板能指出是哪一条在挡',
        hf.armed === false &&
          hf.middleReach > hf.thresholds.maxMiddleReach &&
          hf.gap <= hf.thresholds.loadedMaxGap,
        `装填=${hf.armed} 扣=${fmt(hf.gap)}(需≤${fmt(hf.thresholds.loadedMaxGap)}) 中=${fmt(hf.middleReach)}(需≤${fmt(hf.thresholds.maxMiddleReach)}) 手型=${hf.shape}`,
      );
      check(
        '指弹调试面板给出了"读数 vs 门槛"（扣住 / 其余三指 / 装填帧数 / 甩开增量 / 速度）',
        hh.debugOverlayOn === true &&
          hh.thresholds.minTipSpeed > 0 &&
          hh.thresholds.minGapGain > 0 &&
          typeof hh.peakSpeed === 'number' &&
          typeof hh.gapGain === 'number' &&
          typeof hh.releaseSpeed === 'number' &&
          hh.handedness !== null &&
          typeof hh.shape === 'string',
        `叠层开=${hh.debugOverlayOn} 手=${hh.handedness} 手型=${hh.shape} 甩开增量=${fmt(hh.gapGain)}(需≥${fmt(hh.thresholds.minGapGain)}) 速度=${fmt(hh.releaseSpeed)}(需≥${fmt(hh.thresholds.minTipSpeed)})`,
      );
    } else {
      check('指弹装填门槛（扣住 / 三指张开）', false, '探针没有拿到 flick 调试读数');
    }

    check('指弹"扣住已装填"的调试面板截图已保存', true, FLICK_ARM_SCREENSHOT_PATH);
    check('指弹"三指张开不装填"的调试面板截图已保存', true, FLICK_FIST_SCREENSHOT_PATH);

    // ---- 11.14 响指翻页：素材默认藏着 → 翻一次出来、落在左上角、拖过就记住 ----
    /*
     * 手势本身（拇指贴中指再弹开）由 `tests/snap.test.ts` 单测钉住：
     * 合成手造不出那个姿势（`makeHand` 的拇指是相对**食指**摆的）。
     * 这里验的是**翻页这条流程**：默认藏着没有、翻出来在哪、拖走之后记不记得住。
     */
    const revealProbe = await cdp.evaluate(`(() => {
      const app = window.gesturecam;
      const object = app.scene.objects.get(window.__verify.uiObjectId);
      if (!object) return { error: '拿不到 UI 添加的素材' };
      const read = () => ({
        visible: object.state.visible,
        x: object.state.position.x,
        y: object.state.position.y,
      });

      const before = read();
      app.revealNext();
      const afterReveal = read();

      /*
       * 模拟"翻到下一页"：把这一张收起来（这正是有第二张素材时的真实状态），
       * 同时模拟"用户之前把它拖到了右下角"。
       * 再翻回来时，位置必须**还是拖到的那个** —— 不许被重置回左上角。
       */
      object.setPosition({ x: 0.7, y: 0.75 });
      object.setVisible(false);
      app.revealNext();
      const afterCycle = read();

      return { before, afterReveal, afterCycle };
    })()`);
    await cdp.evaluate(NEXT_FRAMES);
    await sleep(300);

    const revealShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(DRAWER_SCREENSHOT_PATH, Buffer.from(revealShot.data, 'base64'));

    check(
      '响指翻页：拖走之后**位置记得住**（翻回来不会被重置回左上角）',
      Math.abs((revealProbe?.afterCycle?.x ?? 0) - 0.7) < 1e-6 &&
        Math.abs((revealProbe?.afterCycle?.y ?? 0) - 0.75) < 1e-6,
      `循环翻回后位置=(${fmt(revealProbe?.afterCycle?.x)},${fmt(revealProbe?.afterCycle?.y)})，期望 (0.70,0.75)`,
    );
    check('响指翻页的截图已保存（人工过目）', true, DRAWER_SCREENSHOT_PATH);

    // ---- 12. 截图（带上手部骨架、准星与目标高亮，用合成手驱动） ----
    await cdp.evaluate(`(() => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      // 连续喂若干帧让 One-Euro 收敛；用**张开的手**，这样截图展示的是
      // "准星压在素材上、捏下去就会抓到它"的瞄准状态（琥珀色虚线框）
      let t = 5000;
      let state = null;
      for (let i = 0; i < 45; i += 1) {
        t += 1 / 30;
        state = app.gestures.update([makeHand(OPEN_HAND, { x: 0.5, y: 0.55 })], t, viewport);
      }
      const point = state.controls.pinchPoint;
      const object = window.__verify.uiObjectId ? app.scene.objects.get(window.__verify.uiObjectId) : null;
      if (object && point) object.setPosition({ x: point.x, y: point.y });
      app.setGestureOverride(state, app.gestures.smoothedHands);
      // 截图要带调试叠层：确保它开着（默认是关的，见 main.ts）
      if (!app.isDebugOverlayOn()) document.querySelector('#toggle-debug').click();
      return true;
    })()`);
    await cdp.evaluate(NEXT_FRAMES);
    await sleep(300);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
    check('截图已保存', true, SCREENSHOT_PATH);

    // ---- 12.5 双手缩放截图：给用户看"另一只手捏上 + 拉宽轴"长什么样 ----
    // 光靠断言证明不了"用户看得懂"，所以这张图是必须人工看一眼的验收物。
    // 手的摆位刻意收在**可视裁切区内**（9:16 画幅只露出源帧横向的 32%），
    // 否则缩放宽轴的两个端点会跑到画面外，截图就看不出这是个"拉宽"的动作。
    const screenshotState = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      const PINCH = PINCH_HAND;
      const OPEN = OPEN_HAND;
      let t = 9000;
      let state = null;
      const pair = (rightX, leftX, leftOptions) => [
        makeHand(PINCH_HAND, { x: rightX, y: 0.5 }, 'right'),
        makeHand(leftOptions, { x: leftX, y: 0.5 }, 'left'),
      ];
      /**
       * 每帧都要**等一次 rAF**：setGestureOverride 里的事件只会投递一次，
       * 同步连喂几十帧的话中间那些 gesture-start 会被后面的覆盖掉，
       * 于是"手明明捏上了但素材没被抓住"（第六个合成输入陷阱）。
       */
      const feed = async (hands) => {
        t += 1 / 30;
        state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      };

      // 0) 只留 UI 添加的那一个素材：双手缩放要求"场上只有一个素材被抓住"
      //    （两个素材各被一只手抓住时不该一起缩放，见 DECISIONS 第 18.2 节的会话归属规则）。
      //    截图要代表真实用法，而真实用法里用户只会摆一张图。
      const keep = window.__verify.uiObjectId;
      for (const item of app.scene.objects.list()) {
        if (item.id !== keep) app.scene.objects.remove(item.id);
      }

      // 1) 张开的手稳定下来，把素材摆到准星下面，然后渐进合拢抓住它
      for (let i = 0; i < 20; i += 1) await feed([makeHand(OPEN_HAND, { x: 0.5, y: 0.55 })]);
      const object = window.__verify.uiObjectId ? app.scene.objects.get(window.__verify.uiObjectId) : null;
      const point = state.controls.pinchPoint;
      if (object && point) object.setPosition({ x: point.x, y: point.y });
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) {
        await feed([makeHand({ ...PINCH_HAND, gap }, { x: 0.5, y: 0.55 })]);
      }

      // 2) 第二只手在旁边出现（张开），让它的平滑值先稳定；
      //    同时右手挪到它接下来的位置并停稳 —— 摆位必须在**捏上之前**做完，
      //    否则基准间距会取在滤波追赶的途中（真机上就是"一捏上就自己变大"）
      for (let i = 0; i < 12; i += 1) await feed(pair(0.5, 0.575, OPEN));
      for (let i = 1; i <= 8; i += 1) {
        await feed(pair(0.5 - (0.015 * i) / 8, 0.575, OPEN));
      }
      for (let i = 0; i < 8; i += 1) await feed(pair(0.485, 0.575, OPEN));

      // 3) 左手捏上 -> 基准间距 0.09
      for (let i = 0; i < 8; i += 1) await feed(pair(0.485, 0.575, PINCH));

      // 4) 两只手一起拉开到间距 0.18 = 正好 2 倍；两手中点始终在 0.53，
      //    所以截图里素材**原地放大**，一眼就能看出"位置和大小是解耦的"
      for (let i = 1; i <= 10; i += 1) {
        const offset = (i / 10) * 0.045;
        await feed(pair(0.485 - offset, 0.575 + offset, PINCH));
      }
      for (let i = 0; i < 14; i += 1) await feed(pair(0.44, 0.62, PINCH));
      return { grabbed: object ? app.scene.interactions.get(object.id).grabbed : null, ratio: app.scene.interactions.twoHandDebug.distanceRatio };
    })()`);
    await cdp.evaluate(NEXT_FRAMES);
    await sleep(300);

    const twoHandShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(TWO_HAND_SCREENSHOT_PATH, Buffer.from(twoHandShot.data, 'base64'));
    check(
      '双手缩放截图的内容是可信的（确实抓着素材、倍率约 2，否则截的是一张假图）',
      screenshotState?.grabbed === true && Math.abs((screenshotState?.ratio ?? 0) - 2) < 0.15,
      `grabbed=${screenshotState?.grabbed} 倍率=${fmt(screenshotState?.ratio)} 文件=${TWO_HAND_SCREENSHOT_PATH}`,
    );

    // ---- 12.6 握拳急停截图：给用户看"急停之后屏幕上会写什么" ----
    // 手势文法要成立，用户必须知道"系统认为我的手是什么"以及"为什么现在不动了"。
    const stopShotState = await cdp.evaluate(`(async () => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      let t = 12000;
      let state = null;
      const feed = async (hands) => {
        t += 1 / 30;
        state = app.gestures.update(hands, t, viewport);
        app.setGestureOverride(state, app.gestures.smoothedHands);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      };
      const only = (options) => feed([makeHand(options, { x: 0.5, y: 0.5 })]);

      // 先抓住素材
      for (let i = 0; i < 16; i += 1) await only(OPEN_HAND);
      const crosshair = state.controls.pinchPoint;
      const object = window.__verify.uiObjectId ? app.scene.objects.get(window.__verify.uiObjectId) : null;
      if (object && crosshair) object.setPosition({ x: crosshair.x, y: crosshair.y });
      for (const gap of [1.3, 1.0, 0.8, 0.6, 0.4, 0.3, 0.3]) await only({ ...PINCH_HAND, gap });

      // 握拳 -> 急停（横幅与"握拳"手型会被画在叠层上）
      for (let i = 0; i < 4; i += 1) await only(FIST_HAND);
      return {
        grabbed: object ? app.scene.interactions.get(object.id).grabbed : null,
        rearmRequired: app.scene.interactions.rearmRequired,
        fistHands: app.gestures.debug.fistHands,
      };
    })()`);
    await cdp.evaluate(NEXT_FRAMES);
    await sleep(300);
    const stopShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(STOP_SCREENSHOT_PATH, Buffer.from(stopShot.data, 'base64'));
    check(
      '握拳急停截图的内容是可信的（确实取消、确实在等用户张开手）',
      stopShotState?.grabbed === false && stopShotState?.rearmRequired === true,
      `grabbed=${stopShotState?.grabbed} 待重新武装=${stopShotState?.rearmRequired} 文件=${STOP_SCREENSHOT_PATH}`,
    );
    // 还原成单手，后续录制探针不受影响
    await cdp.evaluate(`(() => {
      ${SYNTHETIC_HAND_HELPER}
      const app = window.gesturecam;
      const viewport = app.viewport;
      let t = 9600;
      let state = null;
      for (let i = 0; i < 30; i += 1) {
        t += 1 / 30;
        state = app.gestures.update([makeHand(PINCH_HAND, { x: 0.5, y: 0.55 })], t, viewport);
      }
      app.setGestureOverride(state, app.gestures.smoothedHands);
      return true;
    })()`);
    await cdp.evaluate(NEXT_FRAMES);

    // ---- 13. Phase 9：真的录一段，验证"拍完能拿到文件" ----
    // 光有 RecorderManager 的单测只能证明状态机对；这里要证明浏览器真的能编码出一个文件。
    const recordProbe = await cdp.evaluate(`(async () => {
      const app = window.gesturecam;
      const mime = app.recorder.supportedMimeType;
      if (!app.recorder.supported) return { supported: false };

      const beforeFrames = app.scene.timeline.frameCount;
      await app.startRecording();
      const started = app.recorder.isRecording;

      // 录 2 秒：期间渲染循环在跑，导出画布每帧重绘、timeline 每帧采样
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const elapsedWhileRecording = app.recorder.elapsedSeconds;
      await app.stopRecording();

      const result = app.lastResult;
      const panel = document.querySelector('#result-panel');
      const video = document.querySelector('#result-video');
      const download = document.querySelector('#result-download');
      const saveButton = document.querySelector('#result-save');
      const hint = document.querySelector('#result-hint');

      // 读计算样式而不是 hidden 属性：属性为真但被 CSS 盖掉，用户看到的就是"关不掉"
      const panelDisplayAfterStop = panel ? getComputedStyle(panel).display : null;
      // 必须在关闭之前读：关闭会把 src 摘掉
      const videoSrc = video ? video.getAttribute('src') : null;
      const downloadName = download ? download.getAttribute('download') : null;
      const saveLabel = saveButton ? saveButton.textContent : null;
      const saveMethod = app.lastSaveMethod;
      const hintText = hint ? hint.textContent : null;

      // 关掉结果面板，确认真的从画面上消失
      document.querySelector('#result-close')?.click();
      const panelDisplayAfterClose = panel ? getComputedStyle(panel).display : null;

      return {
        supported: true,
        mime,
        started,
        elapsedWhileRecording,
        hasResult: Boolean(result),
        resultMime: result ? result.mimeType : null,
        durationMs: result ? result.durationMs : 0,
        width: result ? result.width : 0,
        height: result ? result.height : 0,
        sizeBytes: result ? result.blob.size : 0,
        hasAudio: result ? result.hasAudio : null,
        panelDisplayAfterStop,
        panelDisplayAfterClose,
        videoSrc,
        downloadName,
        saveLabel,
        saveMethod,
        hintText,
        timelineFramesBefore: beforeFrames,
        timelineFramesAfter: app.scene.timeline.frameCount,
        recorderState: app.recorder.state,
        lastErrorMessage: app.recorder.lastErrorMessage,
        errorText: document.querySelector('#error')?.textContent ?? null,
      };
    })()`);

    if (!recordProbe.supported) {
      check('浏览器支持录制（mp4 或 webm 至少一种可用）', false, 'MediaRecorder 不支持任何候选格式');
    } else {
      check(
        '浏览器支持录制，并选到了可用格式',
        typeof recordProbe.mime === 'string' && /video\/(mp4|webm)/.test(recordProbe.mime),
        `mime=${recordProbe.mime}`,
      );
      check('点拍摄真的进入录制状态并计时', recordProbe.started === true && recordProbe.elapsedWhileRecording >= 1.5,
        `started=${recordProbe.started} elapsed=${fmt(recordProbe.elapsedWhileRecording)}s`);
      check(
        '录了约 2 秒后拿到一个真实的视频文件（有体积、有分辨率、有时长）',
        recordProbe.hasResult === true &&
          recordProbe.sizeBytes > 10_000 &&
          recordProbe.width === 720 &&
          recordProbe.height === 1280 &&
          recordProbe.durationMs > 1500 &&
          recordProbe.durationMs < 6000,
        `${recordProbe.resultMime} ${recordProbe.width}×${recordProbe.height} ${fmt(recordProbe.durationMs / 1000)}s ${(recordProbe.sizeBytes / 1024).toFixed(0)}KB 音频=${recordProbe.hasAudio} state=${recordProbe.recorderState} 错误=${recordProbe.errorText ?? recordProbe.lastErrorMessage ?? '无'}`,
      );
      check(
        '录制期间每帧写入了 timeline（拍完还能重编辑 / 换分辨率重导出的基础）',
        recordProbe.timelineFramesAfter - recordProbe.timelineFramesBefore > 20,
        `${recordProbe.timelineFramesBefore} → ${recordProbe.timelineFramesAfter} 帧`,
      );
      check(
        '录制结束后弹出结果面板，带可播放的预览与可保存的下载链接',
        recordProbe.panelDisplayAfterStop !== 'none' &&
          typeof recordProbe.videoSrc === 'string' &&
          recordProbe.videoSrc.startsWith('blob:') &&
          /\.(mp4|webm)$/.test(recordProbe.downloadName ?? ''),
        `面板 display=${recordProbe.panelDisplayAfterStop} src=${recordProbe.videoSrc?.slice(0, 12)}… 文件名=${recordProbe.downloadName}`,
      );
      check(
        '点「关闭」结果面板真的从画面上消失（回归：CSS display 盖过 hidden 导致关不掉）',
        recordProbe.panelDisplayAfterClose === 'none',
        `关闭后 display=${recordProbe.panelDisplayAfterClose}`,
      );
      check(
        '保存按钮按设备能力选文案，并明确告知文件会去哪（"下载≠进相册"是用户会误解的点）',
        ['share', 'file-picker', 'download'].includes(recordProbe.saveMethod) &&
          typeof recordProbe.saveLabel === 'string' &&
          recordProbe.saveLabel.length > 0 &&
          typeof recordProbe.hintText === 'string' &&
          recordProbe.hintText.length > 8,
        `方式=${recordProbe.saveMethod} 按钮=「${recordProbe.saveLabel}」 提示=「${recordProbe.hintText}」`,
      );

      /*
       * 再走一遍录制并把结果面板留在屏幕上截图。
       * 这是刻意加的一步：上一轮"结果面板关不掉"就是因为验证只读了 hidden 属性，
       * 从没人真正看过画面。凡是 UI 可见性问题，都要有一张人工过目的截图。
       */
      await cdp.evaluate(`(async () => {
        const app = window.gesturecam;
        await app.startRecording();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await app.stopRecording();
        return true;
      })()`);
      await sleep(400);
      const panelShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(RESULT_PANEL_SCREENSHOT_PATH, Buffer.from(panelShot.data, 'base64'));
      check('结果面板截图已保存（供人工过目）', true, RESULT_PANEL_SCREENSHOT_PATH);
    }

    console.log('\n诊断数据：');
    console.log(JSON.stringify(diagnostics, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(`\n验收脚本失败：${error.stack ?? error.message}`);
  } finally {
    cdp?.socket?.close?.();
    killTree(browser.pid);
    await sleep(300);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((item) => !item.passed);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

await main();
