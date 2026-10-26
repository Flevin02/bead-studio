/**
 * 图纸绘制：格子坐标、对比色，以及预览 / 导出共用的 drawPattern 路径。
 */

import { drawEditorOverlay } from './editor.js';

import { $, CELL, FONT, MARGIN, MAX_CANVAS_EDGE, canvas, mobileLayout, state } from '../core/state.js';
import { maxZoom, readingCenter, restoreReadingView, showCellInfo, updateCellMarker } from '../features/view.js';

/** 取当前方向的格子；x、y始终是成品图纸坐标，镜像转换只在此处执行。 */
export function cellAt(x, y, mirrored = state.mirrored) {
  const sourceX = mirrored ? state.width - 1 - x : x;
  return state.cells[y * state.width + sourceX];
}

/** 根据颜色亮度选择文字颜色，保证深色格和浅色格中的色号均可辨认。 */
export function textColor(rgb) {
  // 转为线性亮度后判断对比度，避免饱和绿色被普通RGB平均值误判成深色。
  const linear = rgb.map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  return luminance > .197 ? '#1B1221' : '#FFFFFF';
}

/** 绘制完整图纸。预览与PNG共用同一绘制路径，导出不受缩放和高亮影响。 */
export function drawPattern(ctx, { x = MARGIN, y = MARGIN, cell = CELL, codes = false, grid = true, guides = true, beads = false, highlight = null, dark = false, isolateColor = false } = {}) {
  const width = state.width * cell, height = state.height * cell;
  // 深色仅用于屏幕环境；调用方未指定 dark 时，导出和打印保持白底及原始豆色。
  ctx.fillStyle = dark ? '#191C25' : '#FFFFFF';
  ctx.fillRect(x - MARGIN, y - MARGIN, width + MARGIN * 2, height + MARGIN * 2);
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      const index = cellAt(col, row);
      if (index < 0) continue;
      // 拼豆找色只绘制目标色号：其他豆子及其格内文字暂时隐藏，原始格子数据不变。
      if (isolateColor && highlight !== null && highlight !== index) continue;
      const color = state.palette[index];
      const left = x + col * cell, top = y + row * cell;
      ctx.globalAlpha = highlight !== null && highlight !== index ? .15 : 1;
      ctx.fillStyle = color.hex;
      if (beads) {
        ctx.beginPath(); ctx.arc(left + cell / 2, top + cell / 2, cell * .44, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = dark ? '#191C25CC' : '#FFFFFFB8';
        ctx.beginPath(); ctx.arc(left + cell / 2, top + cell / 2, cell * .12, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(left, top, cell, cell);
      }
      if (codes) {
        ctx.fillStyle = textColor(color.rgb);
        ctx.font = `500 ${Math.min(cell * .35, cell * 1.5 / color.code.length)}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(color.code, left + cell / 2, top + cell / 2 + .5);
      }
      ctx.globalAlpha = 1;
    }
  }

  // 每五格加深网格线，编号按1起算，方便对照实体模板数格。
  if (grid) {
    for (let col = 0; col <= state.width; col++) {
      ctx.beginPath(); ctx.strokeStyle = dark ? (col % 5 === 0 ? '#9B90AD80' : '#70667F66') : (col % 5 === 0 ? '#A99CB98C' : '#CFC6D55C');
      ctx.lineWidth = col % 5 === 0 ? 1.2 : .65;
      ctx.moveTo(x + col * cell, y); ctx.lineTo(x + col * cell, y + height); ctx.stroke();
    }
    for (let row = 0; row <= state.height; row++) {
      ctx.beginPath(); ctx.strokeStyle = dark ? (row % 5 === 0 ? '#9B90AD80' : '#70667F66') : (row % 5 === 0 ? '#A99CB98C' : '#CFC6D55C');
      ctx.lineWidth = row % 5 === 0 ? 1.2 : .65;
      ctx.moveTo(x, y + row * cell); ctx.lineTo(x + width, y + row * cell); ctx.stroke();
    }
  }

  // 分区辅助线：每5格一条主线、正中一条虚线对折线，配合四边刻度方便打印后数格对位。
  if (guides) {
    ctx.strokeStyle = dark ? '#B7ABCE73' : '#7B6A9A8F';
    ctx.lineWidth = 1.8;
    for (let col = 5; col < state.width; col += 5) {
      ctx.beginPath(); ctx.moveTo(x + col * cell, y); ctx.lineTo(x + col * cell, y + height); ctx.stroke();
    }
    for (let row = 5; row < state.height; row += 5) {
      ctx.beginPath(); ctx.moveTo(x, y + row * cell); ctx.lineTo(x + width, y + row * cell); ctx.stroke();
    }
    // 外框与主线同色，避免边缘比内部5格线还细。
    ctx.strokeRect(x, y, width, height);
    // 主线已落在正中的尺寸不再补虚线，避免同一条线一半实一半虚。
    ctx.save();
    ctx.setLineDash([cell * .4, cell * .3]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = dark ? '#C0B2E0A6' : '#7755CC73';
    if ((state.width / 2) % 5 !== 0) {
      ctx.beginPath(); ctx.moveTo(x + width / 2, y); ctx.lineTo(x + width / 2, y + height); ctx.stroke();
    }
    if ((state.height / 2) % 5 !== 0) {
      ctx.beginPath(); ctx.moveTo(x, y + height / 2); ctx.lineTo(x + width, y + height / 2); ctx.stroke();
    }
    ctx.restore();
  }

  // 刻度数字每5格一个；10的倍数加粗并用强调色，四边都标，任意一边起拼都能对上行列。
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const label = (text, lx, ly, strong) => {
    ctx.fillStyle = strong ? (dark ? '#CFC3E8' : '#6E5C88') : (dark ? '#B8ADC8' : '#A69BAE');
    ctx.font = `${strong ? '600 ' : ''}10px ${FONT}`;
    ctx.fillText(text, lx, ly);
  };
  for (let col = 0; col < state.width; col++) {
    if (col !== 0 && (col + 1) % 5 !== 0) continue;
    const strong = (col + 1) % 10 === 0, cx = x + (col + .5) * cell;
    label(col + 1, cx, y - 14, strong);
    if (guides) label(col + 1, cx, y + height + 14, strong);
  }
  for (let row = 0; row < state.height; row++) {
    if (row !== 0 && (row + 1) % 5 !== 0) continue;
    const strong = (row + 1) % 10 === 0, cy = y + (row + .5) * cell;
    label(row + 1, x - 15, cy, strong);
    if (guides) label(row + 1, x + width + 15, cy, strong);
  }
}

/** 仅覆盖屏幕像素与找色信息，不适配尺寸、不恢复滚动；找色更新始终保持同一阅读几何。 */
export function paintPattern() {
  $('readingHighlightStatus').hidden = state.mode !== 'beading';
  $('readingAllColors').hidden = state.selected !== null;
  $('readingSelectedColor').hidden = state.selected === null;
  $('cancelReadingHighlightBtn').hidden = state.selected === null;
  if (state.selected !== null) {
    $('readingHighlightCode').textContent = state.palette[state.selected].code;
    $('readingHighlightSwatch').style.background = state.palette[state.selected].hex;
  }
  const ctx = canvas.getContext('2d');
  // 业务坐标仍以24为一格；只提高底层像素密度，点击、镜像和定位不随分辨率改变。
  ctx.setTransform(canvas.width / (state.width * CELL + MARGIN * 2), 0,
    0, canvas.height / (state.height * CELL + MARGIN * 2), 0, 0);
  // 在目标分辨率直接绘制文字和网格，切色及取消先覆盖完整底色，不放大旧位图。
  drawPattern(ctx, {
    grid: $('gridCheck').checked, codes: $('codeCheck').checked, guides: $('guideCheck').checked,
    beads: $('beadCheck').checked, highlight: state.selected,
    dark: document.documentElement.dataset.theme === 'dark', isolateColor: state.mode === 'beading'
  });
  // 修图草稿只画在屏幕层，导出路径不经过此入口。
  drawEditorOverlay(ctx);
  // 渲染可能由换色或恢复触发，格子信息也要读取新的色号与颜色。
  showCellInfo();
  // DOM定位标记只随当前格更新，不改变Canvas像素或CSS尺寸。
  updateCellMarker();
}

/** 图纸或布局变化时按当前屏幕密度重绘，保留逻辑格子与阅读中心。 */
export function render() {
  const center = readingCenter();
  // 先确定CSS和底层像素尺寸，本次由下方统一绘制，避免改尺寸时重复画两遍。
  fitCanvas(false);
  // 内容与尺寸适配分开，普通找色只使用绘制入口，不移动阅读位置。
  paintPattern();
  // 放大后的完整布局更新也不把阅读位置带回左上角。
  restoreReadingView(center);
}

/** 按逻辑尺寸适应容器；repaint为false时由调用方重绘，否则分辨率变化后立即补画。 */
export function fitCanvas(repaint = true) {
  const container = $('canvasScroll');
  const width = state.width * CELL + MARGIN * 2, height = state.height * CELL + MARGIN * 2;
  const availableWidth = Math.max(80, container.clientWidth - (mobileLayout.matches ? 20 : 36));
  const availableHeight = Math.max(80, container.clientHeight - 12);
  const scale = Math.min(availableWidth / width, availableHeight / height) * state.zoom;
  canvas.style.width = `${Math.round(width * scale)}px`;
  canvas.style.height = `${Math.round(height * scale)}px`;
  // 至少保留原始分辨率；高密度屏及放大阅读按实际显示像素补足，最长边统一封顶。
  const density = Math.max(1, window.devicePixelRatio || 1);
  const pixelScale = Math.min(Math.max(1, scale * density), MAX_CANVAS_EDGE / Math.max(width, height));
  const pixelWidth = Math.round(width * pixelScale), pixelHeight = Math.round(height * pixelScale);
  const resized = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  // 重设尺寸会清空画布；已有作品立即补画，启动时的resize等待恢复完成后再绘制格子。
  if (resized && repaint && state.source) paintPattern();
  $('zoomResetBtn').textContent = `${Math.round(state.zoom * 100)}%`;
  $('zoomOutBtn').disabled = state.zoom <= .5;
  $('zoomInBtn').disabled = state.zoom >= maxZoom();
  // CSS尺寸变化后同步定位层，不在Canvas上留下不可移除的标记。
  updateCellMarker();
}
