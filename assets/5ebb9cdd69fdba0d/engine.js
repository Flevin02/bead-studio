/** 图纸共用计算运行时：主线程、兼容分段执行和 Worker 只维护这一套算法。 */
globalThis.BeadEngine = (() => {
'use strict';
const P = globalThis.BeadPalettes;
// 按源帧对象缓存主体分析；换源和 Worker 终止后可回收。
const subjectCache = new WeakMap();

/** 创建 1:1 读回的工作表面；不借用浏览器缩放核，不依赖页面状态。 */
function makeSurface() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
  // 老浏览器兼容路径仍使用相同采样器，执行器会在分段点让出主线程。
  return document.createElement('canvas');
}

/** 完成同一分段器，返回整份结果；仅用于同步参考及小型初始化。 */
function complete(steps) {
  let step;
  // 同步和后台不会分叉出另一套算法。
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

/** 按约 8ms 预算推进计算；signal 失效时停止，不产生半份结果。 */
async function cooperative(steps, signal = () => false) {
  let step, start = performance.now();
  while (true) {
    if (signal()) throw new DOMException('计算已取消', 'AbortError');
    // 每次推进只跨越预先定义的小块计算。
    step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - start >= 8) {
      // 定时任务让出绘制和输入机会；后台页也能推进，不依赖 requestAnimationFrame。
      await new Promise(resolve => setTimeout(resolve, 0));
      start = performance.now();
    }
  }
}

/** 泛洪识别在多小的帧上做：最长边约 512 像素，小图保持原分辨率，几毫秒内完成。 */
const WORK_LIMIT = 512;

/**
 * 估计背景颜色：取四边 2 格厚的边框条带里不透明像素的 Lab 中位数。
 * 中位数抗边框上的小杂物；全部透明则返回 transparent 模式，由 alpha 直接判定。
 * opaque 为 false 表示图片自带透明通道，调用方应直接沿用旧路径，不做识别。
 */
function* estimateBackgroundSteps(frame) {
  const { data, width: w, height: h } = frame;
  const strip = 2;
  const labs = [];
  let minAlpha = 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      if (x >= strip && x < w - strip && y >= strip && y < h - strip) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 250) continue;
      labs.push(P.toLab([data[i], data[i + 1], data[i + 2]]));
    }
  }
  if (!labs.length) return { opaque: minAlpha >= 250, mode: 'transparent', lab: null };
  // 逐通道取中位数；Lab 各通道独立排序即可，边框颜色接近时误差远小于容差。
  const median = channel => {
    const values = labs.map(lab => lab[channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  return { opaque: minAlpha >= 250, mode: 'solid', lab: [median(0), median(1), median(2)] };
}

/**
 * 从四边种子向内泛洪，标记与外部连通的背景格。
 * 双阈值滞回：强匹配决定「泛洪能在哪里流动」，弱匹配决定「强背景外围清除哪一圈」。
 * 强阈值取容差的四分之一（下限 2）：真实背景平坦，色差几乎为 0；
 * 而与背景只差 ΔE5~12 的浅色主体（白发、浅紫发、肤色边缘）不构成流动通道，
 * 泛洪无法成片吞掉，只会被弱圈层吃掉最外圈抗锯齿混色缝。
 * lab 为帧的逐格 Lab 缓存（可传 null，由本函数就地计算并写回）。
 * 返回标记数组（0 前景 / 1 强背景 / 2 弱背景）与背景格数；人物内部不与边缘连通的同色区域保持前景。
 */
function* floodBackgroundSteps(frame, bg, tolerance, labs = null) {
  const { data, width: w, height: h } = frame;
  const total = w * h;
  const mask = new Uint8Array(total);
  if (!labs) { labs = new Float32Array(total * 3); yield* fillLabsSteps(frame, labs); }
  const weakLimit = tolerance * tolerance;
  const strongTol = Math.min(tolerance, Math.max(2, tolerance / 4));
  const strongLimit = strongTol * strongTol;
  const solid = bg.mode === 'solid';
  // 每格的匹配级别：0 不匹配、1 弱、2 强；透明像素始终按强处理。
  const near = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if ((i & 2047) === 0) yield;
    if (data[i * 4 + 3] < 16) { near[i] = 2; continue; }
    if (!solid) continue;
    const d = P.distance([labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]], bg.lab);
    near[i] = d <= strongLimit ? 2 : (d <= weakLimit ? 1 : 0);
  }
  const queue = new Int32Array(total);
  let head = 0, tail = 0, count = 0;
  const mark = index => {
    if (mask[index] || near[index] !== 2) return;
    mask[index] = 1; count++; queue[tail++] = index;
  };
  for (let x = 0; x < w; x++) { mark(x); mark((h - 1) * w + x); }
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield; mark(y * w); mark(y * w + w - 1); }
  while (head < tail) {
    if ((head & 1023) === 0) yield;
    const index = queue[head++];
    const x = index % w, y = (index - x) / w;
    if (x > 0) mark(index - 1);
    if (x < w - 1) mark(index + 1);
    if (y > 0) mark(index - w);
    if (y < h - 1) mark(index + w);
  }
  // 弱层只从强背景向外扩一整圈（8 邻域）：收走抗锯齿缝与轻微光晕，止步于浅色主体。
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (mask[index] || near[index] !== 1) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx] === 1) { touch = true; break; }
        }
      }
      if (touch) { mask[index] = 2; count++; }
    }
  }
  return { mask, count, labs, near };
}

/**
 * 弱像素浅带：从已清除的背景出发，在未被清除的「弱匹配」像素里按 BFS 距离
 * 标出贴边浅带（默认 3 格深，棋盘距离）。浅带多半是抗锯齿混色与 JPEG 噪声的
 * 半程残余——清除它们会误伤细发丝，保留则让轮廓渲染成脏灰色；调用方据此让
 * 浅带像素只占格子覆盖率、不参与配色，纯浅带格子直接留空。
 * 深处的弱像素（浅色主体内部、被主体包住的浅色区）距离背景远，不受影响。
 */
function* shallowBandSteps(frame, flood, depth = 3) {
  const { width: w, height: h } = frame;
  const total = w * h;
  const band = new Uint8Array(total);
  const { mask, near } = flood;
  const dist = new Int16Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  for (let i = 0; i < total; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    if ((head & 1023) === 0) yield;
    const index = queue[head++], d = dist[index];
    if (d >= depth) continue;
    const x = index % w, y = (index - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const n = ny * w + nx;
        if (dist[n] >= 0 || mask[n] || near[n] !== 1) continue;
        dist[n] = d + 1;
        band[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  return band;
}

/** 把帧的 RGB 逐格转成 Lab，缓存后多次泛洪不再重复换算。 */
function* fillLabsSteps(frame, labs) {
  const { data } = frame;
  const rgb = [0, 0, 0];
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    if ((i & 8191) === 0) yield;
    rgb[0] = data[i]; rgb[1] = data[i + 1]; rgb[2] = data[i + 2];
    const lab = P.toLab(rgb);
    labs[j] = lab[0]; labs[j + 1] = lab[1]; labs[j + 2] = lab[2];
  }
}

/**
 * 主体边界：前景（非背景）格的外接矩形，先剥掉孤立噪点再量边界。
 * 只有 8 邻域内前景数不足 2 的格视为噪点，不参与边界；发丝、对角细线仍保留。
 * 返回帧坐标的 bounds，前景过少（识别失败）时返回 null。
 */
function* subjectBoundsSteps(frame, bgMask) {
  const { width: w, height: h } = frame;
  const total = w * h, fg = new Uint8Array(total);
  let count = 0;
  for (let i = 0; i < total; i++) if (!bgMask[i]) { fg[i] = 1; count++; }
  if (count < total * .005) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (!fg[index]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1 && neighbors < 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (fg[ny * w + nx] && ++neighbors >= 2) break;
        }
      }
      if (neighbors < 2) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 留白裁剪计划：主体外扩 margin 格，同时保持用户设置的最长边不变。
 * 每格对应的源像素由主体最长边除以「最长边 − 两侧留白」得出，留白挤占的是主体精度而不是网格尺寸。
 * 返回取样用的源图矩形与最终网格尺寸；margin 会让小格数图纸放不下留白，此时按剩余空间收缩。
 */
function* planCropSteps(bounds, longest, margin, sourceWidth, sourceHeight) {
  margin = Math.max(0, Math.min(margin, Math.floor((longest - 8) / 2)));
  const subjectW = Math.max(1, bounds.width), subjectH = Math.max(1, bounds.height);
  const cell = Math.max(subjectW, subjectH) / Math.max(8, longest - 2 * margin);
  const width = Math.min(128, Math.max(1, Math.round(subjectW / cell)) + 2 * margin);
  const height = Math.min(128, Math.max(1, Math.round(subjectH / cell)) + 2 * margin);
  const left = Math.max(0, Math.min(sourceWidth - 1, Math.round(bounds.x - margin * cell)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.round(bounds.y - margin * cell)));
  const rect = {
    x: left, y: top,
    width: Math.max(1, Math.min(sourceWidth - left, Math.round(subjectW + 2 * margin * cell))),
    height: Math.max(1, Math.min(sourceHeight - top, Math.round(subjectH + 2 * margin * cell)))
  };
  return { rect, width, height };
}

/**
 * 把泛洪结果写进取样帧的 alpha：背景格透明，前景格保留原值。
 * 帧是二值透明（0/255），sample() 的边缘去光晕分支会自动只统计前景颜色，不把背景白掺进轮廓。
 * 返回被清成空白的格数占比；几乎为 0 说明这帧没有可用背景，调用方应退回整图路径。
 */
function* applySubjectMaskSteps(frame, mask) {
  const { data } = frame;
  let cleared = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (data[i * 4 + 3]) { data[i * 4 + 3] = 0; cleared++; }
  }
  return cleared / mask.length;
}

function patternSize(source, longest) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const ratio = longest / Math.max(width, height);
  return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
}

function* samplingFrameSteps(source, width, height, rect = null) {
  const rx = rect ? rect.x : 0, ry = rect ? rect.y : 0;
  const sw = rect ? rect.width : source.naturalWidth || source.width;
  const sh = rect ? rect.height : source.naturalHeight || source.height;
  const bw = Math.min(sw, Math.max(1, width * 4)), bh = Math.min(sh, Math.max(1, height * 4));
  const acc = new Float64Array(bw * bh * 4), weight = new Uint32Array(bw * bh);
  // 源像素落在哪个取样格，预先算成查表；否则几百万像素的内层循环每步都要做一次除法。
  const column = new Int32Array(sw), rowOrigin = new Int32Array(sh);
  for (let x = 0; x < sw; x++) column[x] = Math.floor(x * bw / sw);
  for (let y = 0; y < sh; y++) rowOrigin[y] = Math.floor(y * bh / sh) * bw;
  const tile = makeSurface();
  const context = tile.getContext('2d', { willReadFrequently: true });
  const size = 1024;
  for (let ty = 0; ty < sh; ty += size) {
    for (let tx = 0; tx < sw; tx += size) {
      const w = Math.min(size, sw - tx), h = Math.min(size, sh - ty);
        // 切片按原始像素 1:1 绘制，不触发重采样；重设尺寸同时清空上一片。
        tile.width = w; tile.height = h;
        context.drawImage(source, tx + rx, ty + ry, w, h, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y++) {
        if ((y & 15) === 0) yield;
        const line = rowOrigin[ty + y], data8 = y * w;
        for (let x = 0; x < w; x++) {
          const bin = line + column[tx + x], target = bin * 4, from = (data8 + x) * 4;
          acc[target] += data[from]; acc[target + 1] += data[from + 1];
          acc[target + 2] += data[from + 2]; acc[target + 3] += data[from + 3];
          weight[bin]++;
        }
      }
    }
  }
  const frame = new Uint8ClampedArray(bw * bh * 4);
  for (let bin = 0; bin < weight.length; bin++) {
    const count = weight[bin], target = bin * 4;
    // 缩得比源图还密的格子没有样本，保持透明，不能被当成白色前景。
    if (!count) continue;
    for (let channel = 0; channel < 4; channel++) frame[target + channel] = Math.round(acc[target + channel] / count);
  }
  return { data: frame, width: bw, height: bh };
}

function* planSubjectSteps(source, settings) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  let cache = subjectCache.get(source);
  if (!cache) {
    // 工作帧最长边约 512 像素；samplingFrame 的帧尺寸是网格的 4 倍，按比例反推网格。
    const ratio = Math.min(1, WORK_LIMIT / Math.max(sw, sh));
    const frame = yield* samplingFrameSteps(source, Math.max(1, Math.round(sw * ratio / 4)), Math.max(1, Math.round(sh * ratio / 4)));
    const bg = yield* estimateBackgroundSteps(frame);
    const labs = new Float32Array(frame.width * frame.height * 3);
    yield* fillLabsSteps(frame, labs);
    cache = { frame, bg, labs };
    subjectCache.set(source, cache);
  }
  // 图片自带透明通道时，空白格本来就存在；不重复识别，行为与旧版完全一致。
  if (!cache.bg.opaque) return null;
  const flood = yield* floodBackgroundSteps(cache.frame, cache.bg, settings.tolerance, cache.labs);
  if (flood.count < cache.frame.width * cache.frame.height * .02) return null;
  const bounds = yield* subjectBoundsSteps(cache.frame, flood.mask);
  if (!bounds) return null;
  // 帧坐标换成源像素：向下取整起点、向上取整边长，宁多留一格也不切掉主体。
  const boundsPx = {
    x: Math.max(0, Math.floor(bounds.x * sw / cache.frame.width)),
    y: Math.max(0, Math.floor(bounds.y * sh / cache.frame.height)),
    width: Math.ceil(bounds.width * sw / cache.frame.width),
    height: Math.ceil(bounds.height * sh / cache.frame.height)
  };
  boundsPx.width = Math.min(sw - boundsPx.x, boundsPx.width);
  boundsPx.height = Math.min(sh - boundsPx.y, boundsPx.height);
  return { bg: cache.bg, ...yield* planCropSteps(boundsPx, settings.longest, settings.margin, sw, sh) };
}

function* calculateSteps(source, parameters, colors) {
  // 沿用现有格数、色数上限；背景清理不改变保存格式，只影响取样范围与空白格。
  const longest = parameters.longest, colorLimit = parameters.maxColors;
  // 渐变过渡（抖动）强度 0~100% → 0~1；默认关闭，行为与旧版一致。
  const dither = parameters.dither / 100;
  const settings = { longest, remove: parameters.background.remove, tolerance: parameters.background.tolerance, margin: parameters.background.margin };
  // 先识别主体、确定留白裁剪，再在裁剪后的取样帧上按同一容差泛洪写透明。
  let plan = settings.remove ? (yield* planSubjectSteps(source, settings)) : null;
  let width = 0, height = 0, frame = null, removed = 0, shallow = null;
  if (plan) {
    width = plan.width; height = plan.height;
    frame = yield* samplingFrameSteps(source, width, height, plan.rect);
    const flood = yield* floodBackgroundSteps(frame, plan.bg, settings.tolerance);
    removed = yield* applySubjectMaskSteps(frame, flood.mask);
    // 裁剪后的边框上找不到背景（留白被原图边界顶满、容差在细分辨率下失配），退回整图。
    if (removed < .02) plan = frame = null;
    // 贴边混色残带只占覆盖率不配色：轮廓豆色取自主体本体，纯残带格子留空。
    else shallow = yield* shallowBandSteps(frame, flood);
  }
  if (!plan) [width, height] = patternSize(source, longest);
  // 覆盖率决定留空，取样器自动保留明确像素结构，无需用户选择模式。
  if (!frame) frame = yield* samplingFrameSteps(source, width, height);
  const pixels = yield* P.sampleSteps(frame, width, height, shallow);
  // 在真实色卡上优化有限色集；结果生成成功后，调用方才替换当前作品。
  const result = yield* P.quantizeSteps(pixels, colorLimit, colors, dither, width, height, parameters.ditherMode || 'fs');
  const background = plan ? { rect: plan.rect, removed } : null;
  // 抖动点是主动生成的过渡色，后续清理会把它们当杂点抹掉；开启时保留，关闭后沿用清理偏好。
  if (dither > 0 || !parameters.denoise) return { ...result, width, height, background };
  // 无抖动时才按图纸密度清理抗锯齿混色与柔和阴影留下的孤格。
  const cleaned = yield* P.refineSteps(result, width, height, Math.min(2, Math.floor(Math.max(width, height) / 40) + 1));
  return { ...cleaned, width, height, background };
}


const subject = { WORK_LIMIT, estimateBackground: (...args) => complete(estimateBackgroundSteps(...args)), floodBackground: (...args) => complete(floodBackgroundSteps(...args)), shallowBand: (...args) => complete(shallowBandSteps(...args)), fillLabs: (...args) => complete(fillLabsSteps(...args)), subjectBounds: (...args) => complete(subjectBoundsSteps(...args)), planCrop: (...args) => complete(planCropSteps(...args)), applySubjectMask: (...args) => complete(applySubjectMaskSteps(...args)) };
return { subject, patternSize, samplingFrame: (...args) => complete(samplingFrameSteps(...args)), calculate: (...args) => complete(calculateSteps(...args)), calculateSteps, cooperative };
})();
