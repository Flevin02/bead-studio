/**
 * 阅读视图：缩放、阅读中心、定位标记、点格找色与清单开合。
 */

import { cancelEditorDraft } from './editor.js';

import { $, CELL, MARGIN, canvas, directionSwitch, mobileLayout, paletteHome, palettePanel, state } from '../core/state.js';
import { openColorEditor } from '../features/panels.js';
import { flushPending } from '../features/pattern.js';
import { markProjectChange } from '../features/project.js';
import { cellAt, fitCanvas, paintPattern, render } from '../features/renderer.js';
import { animateWorkspace, captureWorkspace, syncFluidSwitch } from '../features/shell.js';

/** 取得画布中心的归一化坐标；布局、模式及缩放变化后仍对着同一阅读区域。 */
export function readingCenter() {
  const area = $('canvasScroll').getBoundingClientRect(), image = canvas.getBoundingClientRect();
  return {
    x: image.width ? Math.max(0, Math.min(1, (area.x + area.width / 2 - image.x) / image.width)) : .5,
    y: image.height ? Math.max(0, Math.min(1, (area.y + area.height / 2 - image.y) / image.height)) : .5
  };
}

/** 在下一帧按新布局恢复中心；启动恢复时优先保证最近定位格可见，旧布局任务自动失效。 */
export function restoreReadingView(center, ensureActive = false) {
  const task = ++state.viewTask;
  state.adjustingView = true;
  return new Promise(resolve => requestAnimationFrame(() => {
    if (task !== state.viewTask) { resolve(); return; }
    const area = $('canvasScroll'), view = area.getBoundingClientRect();
    let image = canvas.getBoundingClientRect();
    area.scrollLeft += image.x + image.width * center.x - view.x - view.width / 2;
    area.scrollTop += image.y + image.height * center.y - view.y - view.height / 2;
    if (ensureActive && state.activeCell) {
      image = canvas.getBoundingClientRect();
      const scale = image.width / (state.width * CELL + MARGIN * 2);
      const left = image.x + (MARGIN + state.activeCell.x * CELL) * scale;
      const top = image.y + (MARGIN + state.activeCell.y * CELL) * scale;
      const cell = CELL * scale;
      if (left < view.left || left + cell > view.right) area.scrollLeft += left + cell / 2 - view.x - view.width / 2;
      if (top < view.top || top + cell > view.bottom) area.scrollTop += top + cell / 2 - view.y - view.height / 2;
    }
    // DOM 定位层只用于阅读，任何导出路径均不绘制这些标记。
    updateCellMarker();
    // 浏览器在下一帧派发程序滚动事件，等事件完成后再允许记录用户阅读变化。
    requestAnimationFrame(() => {
      if (task === state.viewTask) state.adjustingView = false;
      resolve();
    });
  }));
}

/** 更新DOM定位框与行列边缘标记，外框不遮住格内色号，且不会进入PNG或打印。 */
export function updateCellMarker() {
  const cell = state.activeCell, show = state.mode === 'beading' && cell !== null;
  for (const id of ['cellMarker', 'rowMarker', 'columnMarker']) $(id).hidden = !show;
  if (!show) return;
  const scale = canvas.getBoundingClientRect().width / (state.width * CELL + MARGIN * 2);
  const size = CELL * scale, left = (MARGIN + cell.x * CELL) * scale, top = (MARGIN + cell.y * CELL) * scale;
  Object.assign($('cellMarker').style, { left: `${left}px`, top: `${top}px`, width: `${size}px`, height: `${size}px` });
  Object.assign($('rowMarker').style, { left: '0px', top: `${top}px`, width: `${Math.max(0, MARGIN * scale - 2)}px`, height: `${size}px` });
  Object.assign($('columnMarker').style, { left: `${left}px`, top: '0px', width: `${size}px`, height: `${Math.max(0, MARGIN * scale - 2)}px` });
}

/** 收起豆子清单；桌面在工作区展开，手机使用同一份清单的底部弹窗。 */
export function closeReadingPalette() {
  $('readingPaletteDialog').close();
  document.body.classList.remove('palette-open');
  $('paletteToggleBtn').setAttribute('aria-expanded', 'false');
  $('mobilePaletteBtn').setAttribute('aria-expanded', 'false');
}

/** 放大或缩小时围绕当前阅读中心变化，避免每次操作跳回画布边缘。 */
export function changeZoom(value) {
  const center = readingCenter();
  state.zoom = Math.max(.5, Math.min(maxZoom(), value));
  // 新缩放先布局，再还原中心；滚动稳定后才记入阅读快照。
  fitCanvas();
  restoreReadingView(center).then(() => markProjectChange());
}

/** 手机需要更大的格子供触摸与读色号；桌面沿用 250% 的缩放上限。 */
export function maxZoom() { return mobileLayout.matches ? 4 : 2.5; }

/** 按模式和屏幕放置清单；手机返回制图时恢复原来的页面位置。 */
export function placePalette() {
  // 手机两种模式均从同一份清单弹窗读取；主图下只保留四个常用色快捷预览。
  if (mobileLayout.matches) $('readingPaletteContent').append(palettePanel);
  else paletteHome.after(palettePanel);
  $('paletteToggleBtn').setAttribute('aria-controls', mobileLayout.matches ? 'readingPaletteDialog' : 'palettePanel');
}

/** 高亮仅用于屏幕找色，不改变豆数或导出数据。 */
export function updateHighlight(repaint = true) {
  document.querySelectorAll('.color-row, .palette-peek-color').forEach(button => {
    const selected = Number(button.dataset.colorIndex) === state.selected;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('clearHighlightBtn').hidden = state.selected === null;
  // 找色只重绘内容；批量提交时可只同步 DOM，随后由 render 统一绘制。
  if (repaint) paintPattern();
}

/** 切换展示方向，并让按钮、方向提示与图纸保持一致。 */
export function setDirection(mirrored) {
  // 坐标方向变化不能把未应用草稿提交到相反位置。
  cancelEditorDraft();
  const changed = state.mirrored !== mirrored;
  // 切换方向后取消旧的点击坐标，避免把旧位置误当成当前选中的那颗豆子。
  if (state.mirrored !== mirrored) state.activeCell = null;
  state.mirrored = mirrored;
  $('normalBtn').classList.toggle('active', !mirrored);
  $('mirrorBtn').classList.toggle('active', mirrored);
  $('normalBtn').setAttribute('aria-pressed', String(!mirrored));
  $('mirrorBtn').setAttribute('aria-pressed', String(mirrored));
  // 与模式按钮共用流动轮廓；图纸镜像和编号仍按原规则立即更新。
  syncFluidSwitch(directionSwitch, mirrored ? $('mirrorBtn') : $('normalBtn'), changed);
  $('directionBadge').classList.toggle('mirrored', mirrored);
  $('directionBadge').querySelector('span').textContent = mirrored ? '镜像图纸' : '正向图纸';
  $('directionBadge').querySelector('use').setAttribute('href', mirrored ? '#i-mirror' : '#i-normal');
  $('mirrorNote').hidden = !mirrored;
  $('readingDirection').textContent = mirrored ? '镜像' : '正向';
  // 新图已经按当前方向绘制；未改变方向时仅同步控件，避免重复绘制数万格。
  if (changed) render();
  if (changed) markProjectChange(true);
}

/** 显示悬停格或最近点击格的坐标、色号和 HEX；未指定坐标时保留点击信息。 */
export function showCellInfo(cell = state.activeCell) {
  const output = $('cellInfo').querySelector('span');
  if (!cell) { output.textContent = state.mode === 'beading' ? '点击色块，只看同色号豆子' : '点击色块，快捷改色'; return; }
  const index = cellAt(cell.x, cell.y);
  const label = index < 0 ? '留空' : `${state.palette[index].code} · ${state.palette[index].hex}`;
  output.textContent = `第 ${cell.y + 1} 行，第 ${cell.x + 1} 列 · ${label}`;
}

/** 按CSS缩放换算当前显示坐标；返回格子坐标，画布边距和越界位置返回 null。 */
export function inspectCell(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) * (state.width * CELL + MARGIN * 2) / rect.width - MARGIN) / CELL);
  const y = Math.floor(((event.clientY - rect.top) * (state.height * CELL + MARGIN * 2) / rect.height - MARGIN) / CELL);
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) { canvas.style.cursor = 'default'; return null; }
  const cell = { x, y };
  // 有色格可以点击改色，以小手提示；留空格只读信息，保留定位用的十字准星。
  canvas.style.cursor = state.mode === 'beading' || cellAt(x, y) >= 0 ? 'pointer' : 'crosshair';
  // 悬停仅展示信息，不覆盖最近一次点击固定的坐标，也不打开改色窗口。
  showCellInfo(cell);
  return cell;
}

/** 制图点击有色格打开全图同色号改色；拼豆点击则仅显示同色号，留空格只定位。 */
export function editCellColor(event) {
  // 先提交滑块待执行的重新采样，再按当前尺寸和镜像方向判断点击位置。
  flushPending();
  // 后台结果尚未提交，不能对即将替换的格子创建编辑事务。
  if (state.generating) return;
  const cell = inspectCell(event);
  if (!cell) return;
  state.activeCell = cell;
  // 两种模式都保留完整格子信息；DOM外框和边缘标记不会写进导出图纸。
  updateCellMarker();
  const index = cellAt(cell.x, cell.y);
  if (state.mode === 'beading') {
    if (index >= 0) {
      state.selected = index;
      // 复用清单高亮与取消入口，所有同色号保留原色，其他豆子只在预览中隐藏。
      updateHighlight();
    }
    // 阅读选择随已有作品保存；点击留空格不清除当前找色结果。
    markProjectChange();
    return;
  }
  markProjectChange();
  if (index < 0) return;
  // 复用已有的色卡、校验、合并用量及保存逻辑，快捷入口只改变打开方式。
  openColorEditor(index, cell);
}

/** 顶部和手机预览入口打开同一份清单；只有桌面实际展开侧栏时才需要重新适配。 */
export function togglePalette() {
  const center = readingCenter();
  // 同一套桌面边界过渡覆盖清单展开和收起，不只播放进入动画。
  const layout = captureWorkspace();
  if (document.body.classList.contains('palette-open')) closeReadingPalette();
  else {
    document.body.classList.add('palette-open');
    $('paletteToggleBtn').setAttribute('aria-expanded', 'true');
    $('mobilePaletteBtn').setAttribute('aria-expanded', 'true');
    if (mobileLayout.matches) {
      // 原生初始焦点交给标题，避免关闭按钮打开即出现焦点环。
      $('readingPaletteDialog').showModal();
      // 重开时也聚焦标题；preventScroll保留清单和背景图纸的阅读位置。
      $('readingPaletteTitle').focus({ preventScroll: true });
    }
  }
  // 展开桌面侧栏时画布变窄，仍然保留原来的阅读中心。
  if (!mobileLayout.matches) {
    // 桌面侧栏宽度实际变化，继续按原阅读中心适配。
    fitCanvas();
    // 手机弹窗不占背景布局，不创建无必要的阅读恢复任务。
    restoreReadingView(center);
    // 清单与中央预览共用节奏，侧栏不会突然消失或挤动图纸。
    animateWorkspace(layout, center);
  }
}
