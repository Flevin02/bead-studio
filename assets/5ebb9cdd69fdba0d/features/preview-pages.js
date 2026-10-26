/** 原图／图纸／3D 共用预览区；导航手势与中部修图、平移及旋转彼此隔离。 */
import { $, motionPreference, state } from '../core/state.js';
import { openBeadPreview, releaseBeadPreview } from './bead-preview.js';
import { editorHasDraft } from './editor.js';
import { waitForGeneration } from './pattern.js';
import { closeSourcePreview, toggleSourcePreview } from './source-preview.js';
import { toast } from './shell.js';
import { clearInspectHover } from './view.js';

// 顺序对应自然左右滑动；图纸为默认页，切换本身不属于作品编辑或保存。
const previewPages = ['source', 'pattern', 'beads'];
let previewSequence = 0;
let previewGesture = null;
let previewIgnoreClickUntil = 0;
let previewAnimation = null;

/** 暂停图纸专属控件，不替换缩放、颜色、工具或撤销历史；导航本身始终可用。 */
function syncPreviewPages() {
  const mode = state.previewMode, locked = mode !== 'pattern';
  $('canvasStage').dataset.preview = mode;
  $('canvasStage').parentElement.dataset.preview = mode;
  $('sourcePreviewTools').hidden = mode !== 'source';
  $('bead3DTools').hidden = mode !== 'beads';
  $('canvasScroll').inert = locked;
  // visibility 保持图纸几何和滚动，不用 display:none 使阅读位置丢失。
  $('canvasScroll').style.visibility = locked ? 'hidden' : '';
  for (const node of [$('editorPanel'), $('settingsPanel'), $('palettePanel'), $('normalBtn').parentElement, $('zoomInBtn').parentElement, $('editorToolsBtn'), $('paletteToggleBtn').parentElement]) node.inert = locked;
  for (const button of $('previewTabs').querySelectorAll('[data-preview-page]')) {
    const active = button.dataset.previewPage === mode;
    button.setAttribute('aria-selected', String(active));
    button.setAttribute('aria-pressed', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $('previewPrevious').hidden = mode === 'source';
  $('previewNext').hidden = mode === 'beads';
  $('previewHeading').textContent = mode === 'source' ? '原图预览' : mode === 'beads' ? '3D 图纸预览' : state.mode === 'beading' ? '拼豆图纸' : '图纸预览';
}

/**
 * 切换查看页；只有最新导航请求可显示。未应用草稿必须先由用户处理。
 * 计算中的图纸先等完整提交；导航不改作品数据，也不请求重新量化。
 */
export async function showPreviewPage(mode, focus = false) {
  if (!previewPages.includes(mode)) return false;
  if (editorHasDraft()) { toast('请先应用或取消修图预览，再切换查看。'); return false; }
  if (state.loading) return false;
  const request = ++previewSequence;
  // 最新生成结果是查看前提；等待期间继续点击时，仅最后一次导航生效。
  await waitForGeneration();
  if (request !== previewSequence || state.loading) return false;
  const previous = state.previewMode, focusTab = focus || !!document.activeElement?.closest('#previewTabs');
  if (previous === mode) return true;
  // 临时检查效果不跨查看页保留，返回图纸立即显示已应用的完整颜色。
  clearInspectHover();
  previewAnimation?.cancel(); previewAnimation = null;
  // 使过期原图编码失效并退出其全屏；二维画布一直保留在原位置。
  await closeSourcePreview();
  if (request !== previewSequence) return false;
  $('bead3DView').hidden = true;
  let opened = true;
  if (mode === 'source') {
    // 原图组件保留自己最后一次缩放和滚动；仅换源才归零。
    opened = await toggleSourcePreview();
  } else if (mode === 'beads') {
    // 立体组件复用同一作品模型及视角，离开时停止重绘。
    opened = await openBeadPreview();
  }
  if (request !== previewSequence) return false;
  state.previewMode = opened ? mode : 'pattern';
  // 查看控件随页同步，不触发保存、重新拟合或编辑工具切换。
  syncPreviewPages();
  const panel = state.previewMode === 'source' ? $('sourcePreview') : state.previewMode === 'beads' ? $('bead3DView') : $('canvasScroll');
  if (!motionPreference.matches) {
    const direction = previewPages.indexOf(mode) > previewPages.indexOf(previous) ? 1 : -1;
    // 只变换当前页的视觉位置，不参与布局，手机两个工作模式保持等高。
    previewAnimation = panel.animate([{ opacity: .35, transform: `translateX(${direction * 36}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    previewAnimation.finished.catch(() => {});
  }
  if (focusTab) $('previewTabs').querySelector(`[data-preview-page="${state.previewMode}"]`).focus({ preventScroll: true });
  return opened;
}

/** 换源成功前统一退回默认图纸，释放旧模型；不影响新作品提交事务。 */
export async function resetPreviewPages() {
  previewSequence++;
  previewAnimation?.cancel(); previewAnimation = null; previewGesture = null;
  // 原图 URL 由原图组件清理，导航这里只关闭查看并回收 GPU。
  await closeSourcePreview();
  $('bead3DView').hidden = true;
  releaseBeadPreview();
  state.previewMode = 'pattern';
  syncPreviewPages();
}

/** 按自然顺序切换相邻一页，端点不循环，避免误跳到另一端。 */
function adjacentPreviewPage(direction) {
  const index = Math.max(0, Math.min(previewPages.length - 1, previewPages.indexOf(state.previewMode) + direction));
  // 统一走草稿、异步结果及焦点保护，箭头与滑动不会各自改状态。
  showPreviewPage(previewPages[index]);
}

/** 绑定明确点选、键盘导航及预览边缘／切换条手势；中部事件交回原工具。 */
export function initPreviewPages() {
  const stage = $('canvasStage'), tabs = $('previewTabs');
  for (const button of tabs.querySelectorAll('[data-preview-page]')) button.addEventListener('click', () => showPreviewPage(button.dataset.previewPage));
  $('previewPrevious').addEventListener('click', () => adjacentPreviewPage(-1));
  $('previewNext').addEventListener('click', () => adjacentPreviewPage(1));
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = previewPages.indexOf(state.previewMode);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : Math.max(0, Math.min(2, index + (event.key === 'ArrowRight' ? 1 : -1)));
    // 键盘选择完成后焦点随选中标签移动，Tab 不需穿过三个重复入口。
    showPreviewPage(previewPages[next], true);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || state.previewMode === 'pattern' || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    showPreviewPage('pattern', true);
  });
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // 新一次按下是独立操作，不继承上一笔滑动的兼容 click 抑制。
    previewIgnoreClickUntil = 0;
    // 双指缩放不建立导航候选；第二根手指落在边缘也不能误切页。
    if (event.pointerType === 'touch' && !event.isPrimary) { previewGesture = null; return; }
    if (previewGesture) { previewGesture = null; return; }
    const rect = stage.getBoundingClientRect(), inTabs = !!event.target.closest('#previewTabs');
    const edge = event.clientX - rect.left <= 26 || rect.right - event.clientX <= 26;
    const tool = document.querySelector('[data-edit-tool][aria-pressed="true"]')?.dataset.editTool;
    // 图纸正在画笔／擦除等工具时，连边缘也交给原笔触；切换条仍可明确导航。
    if (!inTabs && (!edge || event.target.closest('button') && !event.target.closest('.preview-edge') || state.previewMode === 'pattern' && state.mode === 'design' && !['inspect', 'pan'].includes(tool))) return;
    previewGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now(), button: event.target.closest('button') };
    // 边缘是明确的导航区域，不把同一 pointerdown 再送给图纸或立体旋转。
    event.stopPropagation();
    stage.setPointerCapture(event.pointerId);
  }, true);
  stage.addEventListener('pointermove', event => {
    if (!previewGesture || event.pointerId !== previewGesture.id) return;
    const dx = event.clientX - previewGesture.x, dy = event.clientY - previewGesture.y;
    if (Math.abs(dy) > 30 && Math.abs(dy) > Math.abs(dx)) {
      // 纵向拖动不切页；交还页面滚动，避免手机被导航区域锁住。
      previewGesture = null;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      return;
    }
    event.preventDefault(); event.stopPropagation();
  }, true);
  stage.addEventListener('pointerup', event => {
    const gesture = previewGesture;
    if (!gesture || event.pointerId !== gesture.id) return;
    previewGesture = null;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) previewIgnoreClickUntil = performance.now() + 450;
    if (Math.abs(dx) >= 54 && Math.abs(dx) > Math.abs(dy) * 1.35 && performance.now() - gesture.time < 1000) {
      // 左滑前进，右滑后退；一笔最多切换一页。
      adjacentPreviewPage(dx < 0 ? 1 : -1);
    }
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    // capture 会把原生 click 目标改成预览容器；静止点按明确转交给原按钮。
    if (Math.abs(dx) <= 8 && Math.abs(dy) <= 8 && gesture.button) gesture.button.click();
    event.stopPropagation();
  }, true);
  stage.addEventListener('pointercancel', () => { previewGesture = null; }, true);
  stage.addEventListener('click', event => {
    // 已识别的滑动不能再触发释放点的按钮或格子改色。
    if (event.detail > 0 && performance.now() < previewIgnoreClickUntil) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  // 页面启动及作品恢复默认回到图纸；查看页不写入作品格式。
  syncPreviewPages();
}
