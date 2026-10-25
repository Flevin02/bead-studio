/**
 * 主体识别（纯算法组件）：纯色/近纯色背景的估计、边缘连通泛洪、主体边界与留白裁剪。
 * 输入输出都是 pattern.js 自算的取样帧；不碰 DOM、不持有状态，识别结果由调用方缓存。
 *
 * 第一阶段刻意只做「与边缘连通的背景」：从图片四边向内泛洪，
 * 人物内部的同色区域（白衣、白墙前的白发内芯）不会被顺带删除。
 */

import { P } from '../core/state.js';

/** 泛洪识别在多小的帧上做：最长边约 512 像素，小图保持原分辨率，几毫秒内完成。 */
export const WORK_LIMIT = 512;

/**
 * 估计背景颜色：取四边 2 格厚的边框条带里不透明像素的 Lab 中位数。
 * 中位数抗边框上的小杂物；全部透明则返回 transparent 模式，由 alpha 直接判定。
 * opaque 为 false 表示图片自带透明通道，调用方应直接沿用旧路径，不做识别。
 */
export function estimateBackground(frame) {
  const { data, width: w, height: h } = frame;
  const strip = 2;
  const labs = [];
  let minAlpha = 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
  for (let y = 0; y < h; y++) {
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
export function floodBackground(frame, bg, tolerance, labs = null) {
  const { data, width: w, height: h } = frame;
  const total = w * h;
  const mask = new Uint8Array(total);
  if (!labs) { labs = new Float32Array(total * 3); fillLabs(frame, labs); }
  const weakLimit = tolerance * tolerance;
  const strongTol = Math.min(tolerance, Math.max(2, tolerance / 4));
  const strongLimit = strongTol * strongTol;
  const solid = bg.mode === 'solid';
  // 每格的匹配级别：0 不匹配、1 弱、2 强；透明像素始终按强处理。
  const near = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
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
  for (let y = 0; y < h; y++) { mark(y * w); mark(y * w + w - 1); }
  while (head < tail) {
    const index = queue[head++];
    const x = index % w, y = (index - x) / w;
    if (x > 0) mark(index - 1);
    if (x < w - 1) mark(index + 1);
    if (y > 0) mark(index - w);
    if (y < h - 1) mark(index + w);
  }
  // 弱层只从强背景向外扩一整圈（8 邻域）：收走抗锯齿缝与轻微光晕，止步于浅色主体。
  for (let y = 0; y < h; y++) {
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
export function shallowBand(frame, flood, depth = 3) {
  const { width: w, height: h } = frame;
  const total = w * h;
  const band = new Uint8Array(total);
  const { mask, near } = flood;
  const dist = new Int16Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  for (let i = 0; i < total; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
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
export function fillLabs(frame, labs) {
  const { data } = frame;
  const rgb = [0, 0, 0];
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
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
export function subjectBounds(frame, bgMask) {
  const { width: w, height: h } = frame;
  const total = w * h, fg = new Uint8Array(total);
  let count = 0;
  for (let i = 0; i < total; i++) if (!bgMask[i]) { fg[i] = 1; count++; }
  if (count < total * .005) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
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
export function planCrop(bounds, longest, margin, sourceWidth, sourceHeight) {
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
export function applySubjectMask(frame, mask) {
  const { data } = frame;
  let cleared = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (data[i * 4 + 3]) { data[i * 4 + 3] = 0; cleared++; }
  }
  return cleared / mask.length;
}
