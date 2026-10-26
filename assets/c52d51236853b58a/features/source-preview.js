/** 完整原图的只读查看：独立缩放/平移，不改图纸、历史、保存或导出。 */
import { $, state } from '../core/state.js';
import { editorHasDraft } from './editor.js';
import { sourcePacket } from './project.js';
import { fitCanvas } from './renderer.js';
import { toast } from './shell.js';

// 只缓存当前源帧的本地URL；图纸阅读位置单独保存，不能被原图缩放覆盖。
const sourceView = { id: null, url: null, zoom: 1, token: 0, diagram: null, pointers: new Map(), gesture: null, position: { left: 0, top: 0 } };

/** 按完整源帧原始尺寸等比适应，随后乘独立缩放；88px缩略图不参与显示。 */
function layoutSourcePreview() {
  if (!state.originalPreview || !state.source) return;
  const area = $('sourcePreviewScroll');
  const fit = Math.min(Math.max(1, area.clientWidth - 24) / state.source.width, Math.max(1, area.clientHeight - 24) / state.source.height);
  $('sourcePreviewImage').style.width = `${Math.max(1, Math.round(state.source.width * fit * sourceView.zoom))}px`;
  $('sourceZoomValue').textContent = `${Math.round(sourceView.zoom * 100)}%`;
  $('sourceZoomOut').disabled = sourceView.zoom <= .25;
  $('sourceZoomIn').disabled = sourceView.zoom >= 8;
  $('sourceFullscreenBtn').textContent = document.fullscreenElement ? '退出全屏' : '全屏';
}

/** 独立改变原图缩放并保持查看中心；不触碰state.zoom和图纸滚动。 */
function zoomSourcePreview(value) {
  const area = $('sourcePreviewScroll'), image = $('sourcePreviewImage');
  const before = image.getBoundingClientRect(), view = area.getBoundingClientRect();
  const center = { x: before.width ? (view.x + view.width / 2 - before.x) / before.width : .5, y: before.height ? (view.y + view.height / 2 - before.y) / before.height : .5 };
  sourceView.zoom = Math.max(.25, Math.min(8, value));
  layoutSourcePreview();
  const after = image.getBoundingClientRect();
  area.scrollLeft += after.x + after.width * center.x - view.x - view.width / 2;
  area.scrollTop += after.y + after.height * center.y - view.y - view.height / 2;
}

/** 原图查看时暂停图纸专属控件，避免用户把底部图纸缩放误当成原图缩放。 */
function lockSourceControls(locked) {
  for (const node of [$('editorPanel'), $('settingsPanel'), $('palettePanel'), $('normalBtn').parentElement, $('zoomInBtn').parentElement, $('editorToolsBtn'), $('paletteToggleBtn').parentElement]) node.inert = locked;
  $('canvasStage').parentElement.classList.toggle('viewing-source', locked);
}

/** 关闭只读查看并恢复原图纸几何；查看工具和色号从未被替换。 */
export async function closeSourcePreview() {
  const token = ++sourceView.token;
  $('sourcePreviewBtn').disabled = false;
  if (!state.originalPreview) return;
  if (document.fullscreenElement === $('canvasStage').parentElement) await document.exitFullscreen();
  // 先记录源图滚动，隐藏后浏览器可能返回零尺寸；下次打开恢复本页位置。
  sourceView.position = { left: $('sourcePreviewScroll').scrollLeft, top: $('sourcePreviewScroll').scrollTop };

  if (token !== sourceView.token) return;
  state.originalPreview = false;
  $('sourcePreview').hidden = true;
  $('sourcePreviewBtn').querySelector('span').textContent = '原图'; $('sourcePreviewBtn').setAttribute('aria-label', '原图'); $('sourcePreviewBtn').setAttribute('aria-pressed', 'false');
  lockSourceControls(false);
  sourceView.pointers.clear(); sourceView.gesture = null;
  // 全屏可能触发resize；等两帧布局完成后回到进入查看前的准确阅读位置。
  state.adjustingView = true;
  fitCanvas();
  const saved = sourceView.diagram;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (saved) { $('canvasScroll').scrollLeft = saved.left; $('canvasScroll').scrollTop = saved.top; }
    requestAnimationFrame(() => { state.adjustingView = false; });
  }));
  $('sourcePreviewBtn').focus({ preventScroll: true });
}

/** 源图成功替换后释放旧URL；迟到的编码结果不能显示到新作品。 */
export async function resetSourcePreview() {
  sourceView.diagram = null;
  await closeSourcePreview(true);
  if (sourceView.url) URL.revokeObjectURL(sourceView.url);
  sourceView.url = null; sourceView.id = null; sourceView.zoom = 1; sourceView.position = { left: 0, top: 0 };
  $('sourcePreviewImage').removeAttribute('src');
}

/** 原位打开完整源帧；编码复用作品源图缓存，不写入浏览器数据库。 */
export async function toggleSourcePreview() {
  if (state.originalPreview) return true;
  if (!state.source || state.loading) return;
  if (editorHasDraft()) { toast('请先应用或取消修图预览，再查看原图。'); return; }
  const id = state.sourceId, token = ++sourceView.token;
  $('sourcePreviewBtn').disabled = true;
  try {
    // sourcePacket只形成/复用完整PNG源帧，不保存、不重新量化。
    const packet = await sourcePacket();
    if (token !== sourceView.token || id !== state.sourceId) return;
    if (sourceView.id !== id) {
      if (sourceView.url) URL.revokeObjectURL(sourceView.url);
      sourceView.url = URL.createObjectURL(packet.blob); sourceView.id = id;
      sourceView.zoom = 1; sourceView.position = { left: 0, top: 0 };
    }
    // 像素示例保持硬边；用户照片仍按浏览器正常插值展示完整源帧。
    $('sourcePreviewImage').style.imageRendering = state.demo ? 'pixelated' : 'auto';
    $('sourcePreviewImage').src = sourceView.url;
    await $('sourcePreviewImage').decode();
    if (token !== sourceView.token || id !== state.sourceId) return;
    sourceView.diagram = { left: $('canvasScroll').scrollLeft, top: $('canvasScroll').scrollTop };
    state.originalPreview = true;
    $('sourcePreview').hidden = false;
    lockSourceControls(true);
    $('sourcePreviewBtn').querySelector('span').textContent = '原图'; $('sourcePreviewBtn').setAttribute('aria-label', '原图'); $('sourcePreviewBtn').setAttribute('aria-pressed', 'true');
    layoutSourcePreview();
    $('sourcePreviewScroll').scrollTo(sourceView.position.left, sourceView.position.top);
    return true;
  } catch (error) {
    if (token === sourceView.token) toast('无法显示完整原图，请返回图纸后重试。', true);
  } finally {
    if (token === sourceView.token) $('sourcePreviewBtn').disabled = false;
  }
}

/** 绑定原图的独立缩放、全屏和触摸；图纸画布及编辑处理器不接收这些指针。 */
export function initSourcePreview() {
  $('sourceZoomIn').addEventListener('click', () => zoomSourcePreview(sourceView.zoom * 1.5));
  $('sourceZoomOut').addEventListener('click', () => zoomSourcePreview(sourceView.zoom / 1.5));
  $('sourceFitBtn').addEventListener('click', () => zoomSourcePreview(1));
  $('sourceFullscreenBtn').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if ($('canvasStage').parentElement.requestFullscreen) await $('canvasStage').parentElement.requestFullscreen();
      else { toast('当前浏览器不支持全屏，可以直接放大查看原图。'); return; }
      layoutSourcePreview();
    } catch { toast('暂时无法进入全屏，请使用放大查看。'); }
  });
  document.addEventListener('fullscreenchange', layoutSourcePreview);
  window.addEventListener('resize', layoutSourcePreview);
  $('sourcePreviewImage').addEventListener('dragstart', event => event.preventDefault());
  const area = $('sourcePreviewScroll');
  area.addEventListener('pointerdown', event => {
    event.preventDefault(); area.setPointerCapture(event.pointerId);
    sourceView.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (sourceView.pointers.size === 2) {
      const [a, b] = [...sourceView.pointers.values()];
      sourceView.gesture = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: sourceView.zoom, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  });
  area.addEventListener('pointermove', event => {
    const previous = sourceView.pointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault(); sourceView.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (sourceView.pointers.size >= 2 && sourceView.gesture) {
      const [a, b] = [...sourceView.pointers.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, before = $('sourcePreviewImage').getBoundingClientRect();
      const anchor = { x: (sourceView.gesture.center.x - before.x) / before.width, y: (sourceView.gesture.center.y - before.y) / before.height };
      sourceView.zoom = Math.max(.25, Math.min(8, sourceView.gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, sourceView.gesture.distance)));
      // 原图同样围绕双指中点进行独立缩放/平移，不能借用图纸的zoom或scroll。
      layoutSourcePreview();
      const after = $('sourcePreviewImage').getBoundingClientRect();
      area.scrollLeft += after.x + anchor.x * after.width - center.x;
      area.scrollTop += after.y + anchor.y * after.height - center.y;
      sourceView.gesture.center = center;
    } else { area.scrollLeft -= event.clientX - previous.x; area.scrollTop -= event.clientY - previous.y; }
  });
  for (const event of ['pointerup', 'pointercancel']) area.addEventListener(event, pointer => {
    sourceView.pointers.delete(pointer.pointerId);
    if (sourceView.pointers.size < 2) sourceView.gesture = null;
  });
}
