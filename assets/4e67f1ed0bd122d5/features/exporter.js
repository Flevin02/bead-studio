/**
 * 导出与打印：高清 PNG 与打印页共用的成品画布。
 */

import { CELL, FONT, MAX_CANVAS_EDGE, canvas, exportButtons, motionPreference, state } from '../core/state.js';
import { paletteListEntries } from '../features/panels.js';
import { drawPattern } from '../features/renderer.js';
import { positionExportIcons, toast } from '../features/shell.js';

// 同一时刻只允许一次导出；按钮的忙碌态由这里统一开关。
let exporting = false;

/** 直接绘制高清PNG与打印页：默认宽高各2倍，最长边4096像素，保持完整原色、辅助线、色号和用量。 */
export function createExportCanvas() {
  const gridWidth = state.width * CELL, gridHeight = state.height * CELL;
  const gridArea = Math.max(gridWidth, 480);
  const legendWidth = 220;
  const legendHeight = 100 + state.palette.length * 43;
  const width = gridArea + legendWidth + 100;
  // 图纸下方留出四边刻度的位置，底部数字不会和色卡说明叠在一起。
  const height = Math.max(gridHeight + 200, legendHeight + 180, 520);
  const scale = Math.min(2, MAX_CANVAS_EDGE / Math.max(width, height));
  const sheet = document.createElement('canvas');
  sheet.width = Math.round(width * scale);
  sheet.height = Math.round(height * scale);
  const ctx = sheet.getContext('2d');
  // 文字、线条和色块直接在高清画布上栅格化，避免拉伸预览截图导致色号发虚。
  ctx.setTransform(sheet.width / width, 0, 0, sheet.height / height, 0, 0);
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#7755CC'; ctx.font = `600 24px ${FONT}`;
  ctx.fillText('我勒个豆 · 拼豆图纸', 34, 42);
  ctx.fillStyle = '#776985'; ctx.font = `13px ${FONT}`;
  const direction = state.mirrored ? '镜像' : '正向';
  const total = state.palette.reduce((sum, color) => sum + color.count, 0);
  const colorCount = state.palette.length;
  ctx.fillText(`${state.width} × ${state.height} 格  |  ${direction}  |  ${total} 颗豆子  |  ${colorCount} 种颜色`, 34, 70);
  const gx = 36 + (gridArea - gridWidth) / 2, gy = 120;
  // 导出与打印始终带分区辅助线和四边刻度，屏幕上的显示开关只影响预览。
  drawPattern(ctx, { x: gx, y: gy, cell: CELL, grid: true, guides: true, codes: true, beads: false });
  const lx = gridArea + 72;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#584561'; ctx.font = `600 15px ${FONT}`;
  ctx.fillText('配色与用量', lx, 112);
  // 导出和打印共用与屏幕清单一致的顺序，图纸像素仍读取原始配色索引。
  const legend = paletteListEntries();
  for (let i = 0; i < legend.length; i++) {
    const color = legend[i].color, top = 134 + i * 43;
    ctx.fillStyle = color.hex; ctx.fillRect(lx, top, 27, 27);
    ctx.strokeStyle = '#D8CFDF'; ctx.lineWidth = .7; ctx.strokeRect(lx, top, 27, 27);
    ctx.fillStyle = '#5D4B68'; ctx.font = `600 12px ${FONT}`;
    ctx.fillText(`${color.code}   ${color.count} 颗`, lx + 38, top + 11, 165);
    ctx.fillStyle = '#A195A9'; ctx.font = `10px ${FONT}`;
    ctx.fillText(color.hex, lx + 38, top + 26);
  }
  ctx.fillStyle = '#A094AA'; ctx.font = `11px ${FONT}`;
  ctx.fillText(`色卡：${state.card.name} · 参考颜色请以实物核对。透明格不放豆。`, 34, height - 32, width - 68);
  ctx.fillText(`成品约 ${state.width / 2} × ${state.height / 2} cm（按 5 mm 豆估算）`, 34, height - 14);
  return sheet;
}

/** 用Blob下载PNG；动画只反馈生成状态，成功或失败均恢复按钮，连续点击不重复创建下载。 */
export async function exportPattern() {
  if (exporting) return;  if (state.loading) { toast('图片正在读取，请稍后再导出。'); return; }
  exporting = true;
  // 先按未变形的布局计算中心，文字仅淡出，三个入口始终保留原有宽高。
  positionExportIcons();
  for (const button of exportButtons) {
    button.disabled = true; button.classList.add('is-exporting'); button.setAttribute('aria-busy', 'true');
  }
  // 不延迟真正的下载；仅给视觉反馈留出最短展示时间，减少动画设置下不额外等待。
  const feedback = motionPreference.matches ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, 520));
  try {
    // 同步生成完整原色图纸，并冻结文件名，避免编码期间切换方向让名称与图像不一致。
    const sheet = createExportCanvas();
    const cleanName = state.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 60);
    const filename = `${cleanName}-${state.mirrored ? '镜像' : '正向'}-${state.width}x${state.height}-拼豆图纸.png`;
    const blob = await new Promise(resolve => sheet.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('图纸已导出，包含辅助线、色号和完整用量清单。');
  } catch (error) {
    // 页面已给出可操作的提示，同时把真实原因留在控制台，方便按环境排查编码失败。
    console.error('图纸导出失败', error);
    toast('图纸导出失败，请降低精细度后重新导出。', true);
  } finally {
    // 编码失败也走同一复位链；不显示“保存到设备成功”等无法由网页确认的状态。
    await feedback;
    exporting = false;
    for (const button of exportButtons) {
      button.disabled = false; button.classList.remove('is-exporting'); button.removeAttribute('aria-busy');
    }
  }
}

/** 生成当前方向的打印页面；保持图纸与清单同页，具体纸张由打印对话框选择。 */
export async function printPattern() {
  if (state.loading) { toast('图片正在读取，请稍后再打印。'); return; }
  try {
    let printArea = document.querySelector('.print-sheet');
    if (!printArea) { printArea = document.createElement('div'); printArea.className = 'print-sheet'; document.body.append(printArea); }
    const image = new Image(); image.alt = '当前方向的拼豆图纸和配色用量';
    image.src = createExportCanvas().toDataURL('image/png');
    await image.decode();
    printArea.replaceChildren(image);
    window.print();
  } catch (error) { toast('无法准备打印图纸，请先导出 PNG 再打印。', true); }
}
