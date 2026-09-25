import type { Viewport } from '@/core/coords/viewport';
import type { Handedness, NormalizedLandmark, RawHand } from '@/core/hand/handState';
import type { Vec2 } from '@/core/math/vec2';

/**
 * ============================================================================
 * 合成手生成器（单测与浏览器验收共用同一套几何）
 * ============================================================================
 *
 * 为什么需要它：手型判定用的是**手指的朝向与伸展度**，所以测试用的假手必须
 * 在解剖上说得通。第一版的假手只定义了 4 个关键点（手腕、拇食指指尖、中指指根），
 * 其余 17 个关键点全堆在掌心 —— 那种手在"手指伸展度"上的读数毫无意义，
 * 用它测手型判定等于什么都没测。
 *
 * ## 参数是正交的，正好覆盖判定表的每一格
 *
 * | 参数 | 控制什么 |
 * | --- | --- |
 * | `gap` | 拇食指指尖距离 ÷ 手掌长度 —— 捏合判定的第一个维度 |
 * | `indexAngleDeg` | 食指相对中指的方向偏转 —— 第二个维度（夹角 θ） |
 * | `indexReach` / `middleReach` / `ringReach` / `pinkyReach` | 各指伸展度 —— 握拳与"直捏"的区分 |
 *
 * 于是"握拳不能被读成捏合""直捏必须被认作捏合"这类断言可以直接构造出来。
 *
 * ## 几何约定
 *
 * 在**各向同性局部坐标**里搭建（长度单位 = 手掌长度，y 向下，手指朝 -y = 屏幕上方），
 * 然后映射到场景坐标、再交给 `viewport.sceneToSourceNormalized()` 反算成
 * "追踪模型会输出的整帧归一化坐标"。
 *
 * 映射到场景时 y 要乘一次宽高比：
 * 场景坐标是 [0,1]² 铺在画幅上，1 单位 x = 画幅宽、1 单位 y = 画幅高，
 * 而判定里的 `sceneDistance` 会把 y 除回宽高比。乘一次、除一次，
 * 最终判定读到的几何**就是**这里写的局部几何 —— 于是"我构造了 40° 夹角"
 * 和"判定读到 40°"是同一件事，断言可以写精确值。
 */
export interface SyntheticHandOptions {
  /** 手掌中心（场景坐标） */
  center?: Vec2;
  /** 手掌长度（各向同性单位 = 占画幅宽度的比例），默认 0.1 */
  palmLength?: number;
  /** 拇食指指尖距离 ÷ 手掌长度：0.3 ≈ 捏合，1.6 ≈ 张开 */
  gap?: number;
  /** 食指向量相对中指的偏转角（度）。正值 = 偏向拇指侧（常规捏合就是这个方向） */
  indexAngleDeg?: number;
  /** 各指指尖到手腕的距离 ÷ 手掌长度（伸展 ≈ 1.35 以上，蜷曲 ≈ 1.15 以下） */
  indexReach?: number;
  middleReach?: number;
  ringReach?: number;
  pinkyReach?: number;
  handedness?: Handedness;
  /** 整只手绕手掌中心旋转（度）。用来验证"旋转不改变判定" */
  rotationDeg?: number;
  /**
   * 手掌相对镜头的俯仰角（度，绕手掌的横轴转）。
   *
   * `0` = 手掌正对镜头（手指在画面平面内），`70` = 手指基本指向镜头。
   * 这是**透视缩短**的复现手段，也是真机反馈"我明明张开手了，它还说我是握拳"
   * 的成因：手指指向镜头时指尖到手腕的**平面**距离会塌缩，
   * 只看平面距离的话伸开的手和蜷曲的手长得一模一样。
   * 转起来之后平面距离塌缩、而**三维**距离（含 z）不变，两者就能分开。
   */
  viewAngleDeg?: number;
}

/** 常规捏合：食指屈向拇指（夹角大），其余手指伸展 */
export const PINCH_HAND: SyntheticHandOptions = Object.freeze({
  gap: 0.3,
  indexAngleDeg: 40,
  indexReach: 1.55,
  middleReach: 1.8,
  ringReach: 1.75,
  pinkyReach: 1.6,
});

/** "直捏"：拇指去碰伸直的食指（夹角极小，靠"食指伸展"这一格兜住） */
export const STRAIGHT_PINCH_HAND: SyntheticHandOptions = Object.freeze({
  gap: 0.3,
  indexAngleDeg: 6,
  indexReach: 1.55,
  middleReach: 1.8,
  ringReach: 1.75,
  pinkyReach: 1.6,
});

/**
 * 握拳：食指与中指深蜷，拇指压在食指上。
 *
 * 注意 `middleReach` 与 `indexReach` 取到"指尖落回指根"的极限值（≈1.0）：
 * 判据只认这两根（见 `handShape.ts` 里为什么），所以它们必须是**深蜷**的。
 */
export const FIST_HAND: SyntheticHandOptions = Object.freeze({
  gap: 0.4,
  indexAngleDeg: 5,
  indexReach: 1.0,
  middleReach: 1.0,
  ringReach: 1.02,
  pinkyReach: 1.0,
});

/**
 * "松开拳头但手还半握着"的放松手：手指半屈（伸展度 ≈1.25）。
 *
 * **它必须是 `other`，不能是 `fist`** —— 真机反馈"我已经张开手了，它还说我是握拳"
 * 就是这么来的（旧的蜷曲判据 1.15 太松，把放松手也算了进去）。
 */
export const RELAXED_HAND: SyntheticHandOptions = Object.freeze({
  gap: 0.75,
  indexAngleDeg: 18,
  indexReach: 1.28,
  middleReach: 1.26,
  ringReach: 1.22,
  pinkyReach: 1.2,
});

/** 张开手掌：五指伸展，拇食指分开 */
export const OPEN_HAND: SyntheticHandOptions = Object.freeze({
  gap: 1.6,
  indexAngleDeg: 6,
  indexReach: 1.85,
  middleReach: 1.9,
  ringReach: 1.82,
  pinkyReach: 1.7,
});

/** 局部坐标里手掌各处的固定点（单位 = 手掌长度）。 */
const PALM_LOCAL: Record<number, Vec2> = {
  0: { x: 0, y: 0 }, // 手腕
  1: { x: -0.28, y: -0.18 }, // 拇指 CMC
  5: { x: -0.26, y: -0.94 }, // 食指 MCP
  9: { x: 0, y: -1 }, // 中指 MCP
  13: { x: 0.23, y: -0.95 }, // 无名指 MCP
  17: { x: 0.45, y: -0.88 }, // 小指 MCP
};

/** 中指以外的三指的中指方向基准（局部单位向量），带一点自然张开 */
const FINGER_BASE_DIRECTION: Record<'middle' | 'ring' | 'pinky', number> = {
  // 度数：相对"正上方"，正值偏向小指侧
  middle: 0,
  ring: 7,
  pinky: 16,
};

function rotate(point: Vec2, radians: number): Vec2 {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function unit(degrees: number): Vec2 {
  const radians = (degrees * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/** 指向**拇指侧**（画面的 -x 方向）的单位向量。食指屈向拇指时用这个。 */
function unitTowardThumb(degrees: number): Vec2 {
  const radians = (degrees * Math.PI) / 180;
  return { x: -Math.sin(radians), y: -Math.cos(radians) };
}

/** 沿线段插值（用来放置 PIP/DIP 中间关节）。 */
function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * 造一只解剖上说得通的假手，返回"追踪模型会输出的整帧归一化坐标"。
 *
 * @param viewport 用来把场景坐标反算成归一化坐标（镜像与 cover 裁切都会被正确抵消）
 */
export function makeHand(viewport: Viewport, options: SyntheticHandOptions = {}): RawHand {
  const merged = { ...PINCH_HAND, ...options };
  const palmLength = merged.palmLength ?? 0.1;
  const center = merged.center ?? { x: 0.5, y: 0.5 };
  const gap = merged.gap ?? 0.3;
  const indexAngle = merged.indexAngleDeg ?? 40;
  const reaches = {
    index: merged.indexReach ?? 1.55,
    middle: merged.middleReach ?? 1.8,
    ring: merged.ringReach ?? 1.75,
    pinky: merged.pinkyReach ?? 1.6,
  };
  const rotation = ((merged.rotationDeg ?? 0) * Math.PI) / 180;
  const viewAngle = ((merged.viewAngleDeg ?? 0) * Math.PI) / 180;

  const local: Record<number, Vec2> = {};

  // ---- 四指：指尖位置由 (方向, 伸展度) 直接给出 ----
  // 食指的方向**直接**由 indexAngleDeg 给出（相对中指，中指在 0°），正值偏向拇指侧，
  // 所以判定读到的夹角 θ 就等于这个参数的绝对值 —— 断言可以写精确值。
  const indexDirection = unitTowardThumb(indexAngle);
  const fingerSpec: { name: 'index' | 'middle' | 'ring' | 'pinky'; mcp: number; pip: number; dip: number; tip: number }[] = [
    { name: 'index', mcp: 5, pip: 6, dip: 7, tip: 8 },
    { name: 'middle', mcp: 9, pip: 10, dip: 11, tip: 12 },
    { name: 'ring', mcp: 13, pip: 14, dip: 15, tip: 16 },
    { name: 'pinky', mcp: 17, pip: 18, dip: 19, tip: 20 },
  ];

  for (const finger of fingerSpec) {
    const mcp = PALM_LOCAL[finger.mcp] as Vec2;
    const direction =
      finger.name === 'index' ? indexDirection : unit(FINGER_BASE_DIRECTION[finger.name]);
    const reach = reaches[finger.name];

    /*
     * 判定量用的是 **MCP→TIP 的方向**，所以指尖要沿着"从指根出发的方向"摆，
     * 而不是"从手腕出发的方向"。同时我们还要求 |指尖 - 手腕| / 手掌长度 **精确等于**
     * 参数给定的伸展度，否则"伸展度"这个参数就没法用来构造断言。
     *
     * 解 |mcp + L·d| = reach 即可（L 是指尖到指根的距离）：
     *   L² + 2L(mcp·d) + |mcp|² - reach² = 0
     *   L = -(mcp·d) + sqrt((mcp·d)² - |mcp|² + reach²)
     * 判别式为负说明这条射线根本到不了那个距离（reach 比指根还近），
     * 此时取 L = 0（指尖落在指根上 = 完全蜷曲）。
     */
    const dot = mcp.x * direction.x + mcp.y * direction.y;
    const mcpLengthSquared = mcp.x * mcp.x + mcp.y * mcp.y;
    const discriminant = dot * dot - mcpLengthSquared + reach * reach;
    const length = discriminant > 0 ? Math.max(0, -dot + Math.sqrt(discriminant)) : 0;
    const tip: Vec2 = { x: mcp.x + direction.x * length, y: mcp.y + direction.y * length };

    local[finger.mcp] = mcp;
    // 中间关节放在指根到指尖的连线上：判定只用 MCP 与 TIP，中间点只为骨架好看
    local[finger.pip] = lerp(mcp, tip, 0.4);
    local[finger.dip] = lerp(mcp, tip, 0.72);
    local[finger.tip] = tip;
  }

  local[0] = PALM_LOCAL[0] as Vec2;

  // ---- 拇指：指尖由 gap 决定（拇食指距离 = gap × 手掌长度） ----
  const indexTip = local[8] as Vec2;
  // 拇指从食指一侧斜向下伸过来：方向取"食指 → 掌心外下侧"
  const thumbDirection = (() => {
    const raw = { x: -0.75, y: 0.66 };
    const length = Math.hypot(raw.x, raw.y);
    return { x: raw.x / length, y: raw.y / length };
  })();
  const thumbTip: Vec2 = {
    x: indexTip.x + thumbDirection.x * gap,
    y: indexTip.y + thumbDirection.y * gap,
  };
  const thumbCmc = PALM_LOCAL[1] as Vec2;
  local[1] = thumbCmc;
  local[2] = lerp(thumbCmc, thumbTip, 0.45);
  local[3] = lerp(thumbCmc, thumbTip, 0.72);
  local[4] = thumbTip;

  // ---- 旋转（绕手掌中心）后映射到场景坐标 ----
  const aspect = viewport.sceneAspect;
  const landmarks: NormalizedLandmark[] = [];
  for (let index = 0; index < 21; index += 1) {
    const point = local[index] ?? { x: 0, y: -0.5 };
    const rotated = rotate(point, rotation);
    /*
     * 俯仰：把局部点绕横轴转 `viewAngle`。
     * 局部坐标是各向同性的（单位 = 手掌长度），所以这里先用**宽度单位**做三维旋转：
     *   y' = y·cosφ（留在画面平面内）    z' = y·sinφ（沉进深度）
     * 再分别换算成场景 y（乘宽高比）和 z（z 与 x 同尺度，直接乘手掌长度）。
     */
    const flatY = rotated.y * Math.cos(viewAngle);
    const depth = rotated.y * Math.sin(viewAngle);
    const scene = {
      x: center.x + rotated.x * palmLength,
      y: center.y + flatY * palmLength * aspect,
    };
    landmarks.push({
      position: viewport.sceneToSourceNormalized(scene),
      // 注意：z 的单位与归一化 x 一致（MediaPipe 的约定），所以不乘宽高比
      z: depth * palmLength,
      visibility: 1,
    });
  }

  return { landmarks, handedness: merged.handedness ?? 'right', confidence: 0.95 };
}

/** 一次造两只手（顺序 = 数组顺序）。 */
export function makeHands(viewport: Viewport, options: readonly SyntheticHandOptions[]): RawHand[] {
  return options.map((option) => makeHand(viewport, option));
}
