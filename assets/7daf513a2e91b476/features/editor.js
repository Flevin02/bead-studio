/**
 * 手动修图：真实色号格子事务、连通区域、会话历史及指针手势。
 * 草稿和预览独立于 state.cells；只有应用/完整一笔才写入作品，导出永远读取已提交格子。
 */
import { $, CELL, MARGIN, canvas, mobileLayout, persistence, state } from '../core/state.js';
import { openColorEditor, renderPalette, updateControls } from './panels.js';
import { flushPending } from './pattern.js';
import { markProjectChange } from './project.js';
import { fitCanvas, paintPattern } from './renderer.js';
import { toast } from './shell.js';

// 仅当前会话保留历史/指针和区域草稿；颜色用 code 关联，避免配色合并后的索引失效。
const editorSession = {
  tool: 'inspect', previous: 'inspect', draft: null, stroke: null,
  past: [], future: [], bytes: 0, pointers: new Map(), gesture: null,
  pan: null, space: false, suppressUntil: 0
};
const editorNames = { inspect: '检查', pencil: '画笔', eraser: '橡皮', fill: '填充', remove: '消除', recolor: '换色', eyedropper: '吸管', pan: '平移' };

/** 把当前或自动结果转为真实色号/null；返回独立数组，任何草稿都不能改原图纸。 */
export function editorCodes(result = state) {
  return result.cells.map(index => index < 0 ? null : result.palette[index].code);
}

/** 按四连通收集指定区域；all 为全图同色号，occupied 为跨颜色的连通有豆区域。 */
export function editorRegion(codes, width, height, start, scope = 'connected') {
  if (start < 0 || start >= codes.length) return [];
  const color = codes[start];
  if (scope === 'cell') return [start];
  if (scope === 'all') return codes.flatMap((code, index) => code === color ? [index] : []);
  if (scope === 'occupied' && color === null) return [];
  const seen = new Uint8Array(codes.length), pending = [start], result = [];
  seen[start] = 1;
  while (pending.length) {
    const index = pending.pop(), x = index % width;
    result.push(index);
    const around = [x ? index - 1 : -1, x < width - 1 ? index + 1 : -1, index >= width ? index - width : -1, index + width < width * height ? index + width : -1];
    for (const next of around) {
      if (next < 0 || seen[next] || (scope === 'occupied' ? codes[next] === null : codes[next] !== color)) continue;
      seen[next] = 1; pending.push(next);
    }
  }
  return result;
}

/** 规范化已提交的真实色号网格，同时重建用量与索引；空格可与自动基线不同。 */
function applyEditorCodes(codes) {
  const colors = new Map(state.card.colors.map(color => [color.code, color])), counts = new Map();
  if (codes.length !== state.width * state.height || codes.some(code => code !== null && !colors.has(code))) throw new Error('修图色号或格子尺寸不正确。');
  for (const code of codes) if (code !== null) counts.set(code, (counts.get(code) || 0) + 1);
  state.palette = [...counts].map(([code, count]) => ({ ...colors.get(code), count })).sort((a, b) => b.count - a.count);
  const indices = new Map(state.palette.map((color, index) => [color.code, index]));
  state.cells = codes.map(code => code === null ? -1 : indices.get(code));
  // 自动基线按 code 比较，撤销回自动结果时也能准确撤下“已有手改”状态。
  const automatic = editorCodes(state.autoResult);
  state.hasEdits = codes.some((code, index) => code !== automatic[index]);
  state.selected = null;
  // 重绘内容而不重新适配大小，编辑不改变用户缩放或滚动。
  updateControls();
  renderPalette();
  paintPattern();
  refreshEditor();
  markProjectChange(true);
}

/** 保存一条完整操作前快照；最多100步/约16MiB，淘汰历史不影响当前作品。 */
function rememberEditor(codes, label) {
  const bytes = JSON.stringify(codes).length * 2;
  editorSession.past.push({ codes, label, bytes }); editorSession.bytes += bytes;
  while (editorSession.past.length > 100 || editorSession.bytes > 16 * 1024 * 1024) editorSession.bytes -= editorSession.past.shift().bytes;
}

/** 提交一笔或一次区域/换色操作；无变化不入历史，受恢复和并发冲突保护。 */
export function commitEditorCodes(codes, label = '修图') {
  if (!persistence.ready || state.loading || state.generating || persistence.blocked || (state.originalPreview || state.previewMode === 'beads')) return false;
  const before = editorCodes();
  if (!codes.some((code, index) => code !== before[index])) return false;
  // 应用前验证整份候选，不能在坏输入时先记录历史或部分替换作品。
  if (codes.length !== before.length || codes.some(code => code !== null && !state.card.colors.some(color => color.code === code))) throw new Error('修图数据无效。');
  rememberEditor(before, label);
  editorSession.future = []; editorSession.draft = null;
  applyEditorCodes(codes);
  return true;
}

/** 撤销/重做只交换完整色号快照，自动基线、源图和生成参数保持不变。 */
export function editorHistory(redo = false) {
  if (state.loading || state.generating || persistence.blocked || (state.originalPreview || state.previewMode === 'beads') || editorSession.stroke) return;
  cancelEditorDraft();
  const from = redo ? editorSession.future : editorSession.past, entry = from.pop();
  if (!entry) return;
  const current = editorCodes();
  if (redo) rememberEditor(current, entry.label);
  else {
    editorSession.bytes -= entry.bytes;
    editorSession.future.push({ codes: current, label: entry.label });
  }
  applyEditorCodes(entry.codes);
}

/** 统一确认框：取消/Escape返回false；同时只允许一项待确认操作，不替换已打开的请求。 */
export function confirmEditorAction(message, title = '重新生成图纸？', accept = '重新生成') {
  const dialog = $('editorConfirmDialog');
  if (dialog.open) return Promise.resolve(false);
  $('editorConfirmTitle').textContent = title; $('editorConfirmMessage').textContent = message;
  $('editorConfirmApply').textContent = accept; dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'apply'), { once: true });
    dialog.showModal();
    $('editorConfirmTitle').focus({ preventScroll: true });
  });
}

/** 使用独立自动快照恢复；应用属于一条可撤销操作，不重新识别原图。 */
export async function restoreEditorAutomatic() {
  if (!state.hasEdits || !state.autoResult) return;
  // 先收起次级菜单，让确认框独立说明整张图纸的恢复范围；取消不改作品。
  $('editorMoreMenu').hidePopover();
  // 恢复读取已保存的自动基线，不重新计算原图；确认后仍只记录一条可撤销事务。
  if (!await confirmEditorAction('将移除全部手动修改，恢复到本轮自动生成的图纸。恢复后可撤销。', '恢复自动图纸？', '恢复自动图纸')) return;
  // 把自动基线作为一次完整修改提交，保留恢复前的补豆、擦除和换色快照。
  commitEditorCodes(editorCodes(state.autoResult), '恢复自动结果');
}

/** 新图/新自动结果成功后开始新历史；初始化/恢复不制造作品修改。 */
export function resetEditorSession() {
  editorSession.past = []; editorSession.future = []; editorSession.bytes = 0;
  editorSession.pointers.clear(); editorSession.gesture = null;
  setEditorTool('inspect');
  if (!state.card.colors.some(color => color.code === state.currentColorCode)) state.currentColorCode = state.palette[0]?.code || state.card.colors[0]?.code || null;
  refreshEditor();
}

/** 切换工具时取消未提交草稿；拼豆和原图查看只读，不允许激活落笔。 */
export function setEditorTool(tool) {
  cancelEditorDraft();
  // 切工具或吸管返回时终止旧指针会话，防止模态选色后的迟到触点被误当双指。
  editorSession.pointers.clear(); editorSession.gesture = null;
  if (!editorNames[tool] || state.mode !== 'design' || (state.originalPreview || state.previewMode === 'beads')) tool = 'inspect';
  if (tool === 'eyedropper') editorSession.previous = editorSession.tool === 'eyedropper' ? 'inspect' : editorSession.tool;
  editorSession.tool = tool;
  canvas.style.touchAction = tool === 'inspect' ? '' : 'none';
  refreshEditor();
}

/** 更新工具、当前真实色号和范围操作状态；临时状态不进入作品存档。 */
export function refreshEditor() {
  // 切换工具、阅读模式或原图查看时收起菜单，避免低频操作悬留在新的上下文里。
  $('editorMoreMenu').hidePopover();
  const tool = editorSession.tool, color = state.card.colors.find(item => item.code === state.currentColorCode);
  for (const button of document.querySelectorAll('[data-edit-tool]')) button.setAttribute('aria-pressed', String(button.dataset.editTool === tool));
  $('editorToolName').textContent = editorNames[tool];
  $('editorToolHint').textContent = { inspect: '点击查看格子与色号', pencil: '拖动连续绘制，抬起完成一笔', eraser: '拖动擦除，抬起完成一笔', fill: '点击预览连续区域，再应用', remove: '选择范围，预览后消除', recolor: '点击起点，选择色号和范围', eyedropper: '点击豆子，取回真实色号', pan: '拖动查看位置，不修改图纸' }[tool];
  $('editorColorCode').textContent = color?.code || '选择色号';
  $('editorColorChip').style.backgroundColor = color?.hex || 'transparent';
  $('editorUndoBtn').disabled = !editorSession.past.length;
  $('editorRedoBtn').disabled = !editorSession.future.length;
  $('editorRemoveOptions').hidden = tool !== 'remove';
  $('editorRegionActions').hidden = !editorSession.draft || !!editorSession.stroke;
  $('editorRegionSummary').textContent = editorSession.draft ? `将修改 ${editorSession.draft.changed.length} 格` : '';
  canvas.classList.toggle('editing-canvas', tool !== 'inspect');
}

/** 取消草稿不入历史，清掉预览后显示已应用图纸；安全用于模式/方向切换。 */
export function cancelEditorDraft() {
  // 只有可见草稿才需要擦除覆盖层；空会话重置不应重画整张大图纸。
  const repaint = editorSession.draft !== null;
  editorSession.draft = null; editorSession.stroke = null; editorSession.pan = null;
  if (repaint && state.source) paintPattern();
  if ($('editorToolName')) refreshEditor();
}

/** 原图查看/导出入口可据此拒绝未应用的区域草稿，而不是悄悄应用它。 */
export function editorHasDraft() { return editorSession.draft !== null; }

/** 提交区域工具的明确应用动作；预览时作品、自动保存和导出都不变。 */
export function applyEditorDraft() {
  if (!editorSession.draft) return;
  const { codes, label } = editorSession.draft;
  commitEditorCodes(codes, label);
  cancelEditorDraft();
}

/** 按起点、范围和目标真实色号形成区域预览，所有区域工具复用同一事务。 */
export function previewEditorRegion(start, code, scope = 'connected', label = '区域换色') {
  const codes = editorCodes();
  const region = editorRegion(codes, state.width, state.height, start, scope);
  const changed = region.filter(index => codes[index] !== code);
  if (!changed.length) { cancelEditorDraft(); toast('这个范围没有需要修改的格子。'); return; }
  for (const index of changed) codes[index] = code;
  editorSession.draft = { codes, changed, label };
  refreshEditor();
  paintPattern();
}

/** 按当前CSS尺寸和镜像换算到底层格子，边距与越界返回null。 */
export function editorPoint(event) {
  const rect = canvas.getBoundingClientRect();
  // CSS宽高分别取整后比例可能略有不同；按各自尺寸逆算，长条图也不能串行/串列。
  const scaleX = rect.width / (state.width * CELL + MARGIN * 2), scaleY = rect.height / (state.height * CELL + MARGIN * 2);
  const x = Math.floor(((event.clientX - rect.left) / scaleX - MARGIN) / CELL);
  const y = Math.floor(((event.clientY - rect.top) / scaleY - MARGIN) / CELL);
  return x < 0 || y < 0 || x >= state.width || y >= state.height ? null : { x: state.mirrored ? state.width - 1 - x : x, y };
}

/** Bresenham格子插值，快速拖动仍连成完整笔触；一笔草稿只在抬起时提交。 */
function extendEditorStroke(point) {
  const stroke = editorSession.stroke;
  if (!point) { stroke.last = null; return; }
  let x = stroke.last?.x ?? point.x, y = stroke.last?.y ?? point.y;
  const dx = Math.abs(point.x - x), dy = -Math.abs(point.y - y), sx = x < point.x ? 1 : -1, sy = y < point.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    const index = y * state.width + x;
    editorSession.draft.codes[index] = stroke.code; stroke.changed.add(index);
    if (x === point.x && y === point.y) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
  stroke.last = point; editorSession.draft.changed = [...stroke.changed];
  paintPattern();
}

/** 指针进入工具：检查保留原点击；其他工具阻断旧的全图换色点击。 */
export function editorPointerDown(event) {
  // 画布上的第一次外点只收起更多菜单，不能同时落笔、擦除或触发检查模式改色。
  if ($('editorMoreMenu').matches(':popover-open')) {
    // 阻止触摸默认行为，并沿用既有点击抑制窗口，拦住随后派发的旧改色click。
    event.preventDefault();
    editorSession.suppressUntil = performance.now() + 500;
    // 主动关闭原生浮层，保持当前工具、草稿和已应用格子不变。
    $('editorMoreMenu').hidePopover();
    return true;
  }
  if (state.mode !== 'design' || (state.originalPreview || state.previewMode === 'beads') || state.loading || state.generating || persistence.blocked || !persistence.ready) return false;
  const active = editorSession.tool !== 'inspect' || editorSession.space;
  if (!active || (event.pointerType !== 'touch' && event.button !== 0)) return false;
  event.preventDefault();
  flushPending();
  // 后台结果尚未提交，不能对即将替换的格子创建编辑事务。
  if (state.generating) return;
  editorSession.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  editorSession.suppressUntil = performance.now() + 500;
  if (editorSession.pointers.size >= 2) {
    cancelEditorDraft();
    const [a, b] = [...editorSession.pointers.values()];
    editorSession.gesture = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: state.zoom, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    // 用户手势接管阅读位置，过期的程序居中任务不能把双指平移拉回去。
    state.viewTask++; state.adjustingView = false;
    return true;
  }
  if (editorSession.tool === 'pan' || editorSession.space) {
    editorSession.pan = { x: event.clientX, y: event.clientY }; return true;
  }
  const point = editorPoint(event);
  if (!point) return true;
  const index = point.y * state.width + point.x, code = editorCodes()[index];
  if (editorSession.tool === 'eyedropper') {
    if (code === null) { toast('这里是留空格，当前色号保持不变。'); return true; }
    state.currentColorCode = code; setEditorTool(editorSession.previous); return true;
  }
  if (editorSession.tool === 'recolor') {
    if (code === null) { toast('请在有豆子的格子选择待替换色号。'); return true; }
    editorSession.pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    openColorEditor(state.cells[index], { x: state.mirrored ? state.width - 1 - point.x : point.x, y: point.y }, 'region'); return true;
  }
  if (['pencil', 'fill'].includes(editorSession.tool) && !state.currentColorCode) { toast('请先选择绘制色号。'); return true; }
  if (editorSession.tool === 'fill' || editorSession.tool === 'remove') {
    if (editorSession.tool === 'remove' && code === null) return true;
    previewEditorRegion(index, editorSession.tool === 'fill' ? state.currentColorCode : null,
      editorSession.tool === 'remove' ? $('editorRemoveMode').value : 'connected', editorNames[editorSession.tool]);
    return true;
  }
  editorSession.draft = { codes: editorCodes(), changed: [], label: editorNames[editorSession.tool] };
  editorSession.stroke = { pointerId: event.pointerId, last: point, changed: new Set(), code: editorSession.tool === 'eraser' ? null : state.currentColorCode };
  extendEditorStroke(point);
  refreshEditor();
  return true;
}

/** 移动时只改草稿或查看位置，第二触点出现后整次手势都不能重新落笔。 */
export function editorPointerMove(event) {
  if (!editorSession.pointers.has(event.pointerId)) return false;
  event.preventDefault();
  editorSession.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (editorSession.gesture) {
    if (editorSession.pointers.size >= 2) {
      const [a, b] = [...editorSession.pointers.values()];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, before = canvas.getBoundingClientRect();
      const anchor = { x: (editorSession.gesture.center.x - before.x) / before.width, y: (editorSession.gesture.center.y - before.y) / before.height };
      state.zoom = Math.max(.5, Math.min(mobileLayout.matches ? 4 : 2.5, editorSession.gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, editorSession.gesture.distance)));
      // 围绕双指中点缩放，再把同一个图纸位置移到新中点；同距离移动即为纯平移。
      fitCanvas();
      const after = canvas.getBoundingClientRect();
      $('canvasScroll').scrollLeft += after.x + anchor.x * after.width - center.x;
      $('canvasScroll').scrollTop += after.y + anchor.y * after.height - center.y;
      editorSession.gesture.center = center;
      markProjectChange();
    }
    return true;
  }
  if (editorSession.pan) {
    $('canvasScroll').scrollLeft -= event.clientX - editorSession.pan.x;
    $('canvasScroll').scrollTop -= event.clientY - editorSession.pan.y;
    editorSession.pan = { x: event.clientX, y: event.clientY }; return true;
  }
  if (editorSession.stroke?.pointerId === event.pointerId) extendEditorStroke(editorPoint(event));
  return true;
}

/** 抬起提交一笔；pointercancel只撤销草稿，区域预览保留到明确应用/取消。 */
export function editorPointerUp(event, cancelled = false) {
  if (!editorSession.pointers.has(event.pointerId)) return false;
  editorSession.pointers.delete(event.pointerId);
  if (editorSession.stroke?.pointerId === event.pointerId) {
    const draft = editorSession.draft;
    editorSession.stroke = null;
    if (!cancelled && draft) commitEditorCodes(draft.codes, draft.label);
    cancelEditorDraft();
  }
  editorSession.pan = null; editorSession.suppressUntil = performance.now() + 500;
  if (!editorSession.pointers.size) editorSession.gesture = null;
  return true;
}

/** 工具处理后的click不可再落入旧的全图改色入口，拼豆仍沿用原找色。 */
export function editorConsumesClick() {
  return (state.originalPreview || state.previewMode === 'beads') || (state.mode === 'design' && (editorSession.tool !== 'inspect' || performance.now() < editorSession.suppressUntil));
}

/** 只在屏幕绘制草稿，显示坐标按镜像转换；PNG/打印直接调用drawPattern，不包含此层。 */
export function drawEditorOverlay(ctx) {
  if (state.mode !== 'design' || !editorSession.draft) return;
  const colors = new Map(state.card.colors.map(color => [color.code, color.hex]));
  ctx.save();
  for (const index of editorSession.draft.changed) {
    const x = index % state.width, y = Math.floor(index / state.width), code = editorSession.draft.codes[index];
    const left = MARGIN + (state.mirrored ? state.width - 1 - x : x) * CELL, top = MARGIN + y * CELL;
    ctx.fillStyle = code === null ? (document.documentElement.dataset.theme === 'dark' ? '#292433' : '#ffffff') : colors.get(code);
    ctx.fillRect(left, top, CELL, CELL);
    ctx.strokeStyle = '#9d64e6'; ctx.lineWidth = 1.5; ctx.strokeRect(left + 1, top + 1, CELL - 2, CELL - 2);
  }
  ctx.restore();
}

/** 桌面把工具匣停靠图纸左侧；手机放回图纸上方按需展开，不挤占图纸宽度。 */
export function arrangeEditor() {
  const panel = $('editorPanel'), stage = $('canvasStage');
  if (mobileLayout.matches) {
    stage.before(panel);
    if (editorSession.mobile !== true || state.mode !== 'design') panel.hidden = true;
  } else {
    stage.prepend(panel);
    panel.hidden = state.mode !== 'design';
  }
  editorSession.mobile = mobileLayout.matches;
  stage.classList.toggle('editor-docked', !mobileLayout.matches && state.mode === 'design');
  $('editorToolsBtn').setAttribute('aria-expanded', String(!panel.hidden));
  // 停靠占用的是预留侧边空间，图纸仍按剩余容器等比适应。
  fitCanvas();
}

/** 将原生浮层放在“更多”旁边或上方，并限制在视口内；顶层浮层不受工具匣滚动裁切。 */
function positionEditorMore() {
  const menu = $('editorMoreMenu'), button = $('editorMoreBtn');
  // 关闭状态不参与几何计算，避免尺寸变化把不可见菜单当作零尺寸定位。
  if (!menu.matches(':popover-open')) return;
  // 读取当前按钮与菜单实测尺寸，兼容手机展开和桌面竖向停靠。
  const anchor = button.getBoundingClientRect(), box = menu.getBoundingClientRect();
  const left = mobileLayout.matches ? anchor.right - box.width : anchor.right + 8;
  const top = mobileLayout.matches ? anchor.top - box.height - 8 : anchor.bottom - box.height;
  // 四边留12px，短窗口和窄屏也能完整显示恢复按钮及键盘焦点。
  menu.style.left = `${Math.max(12, Math.min(left, innerWidth - box.width - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(top, innerHeight - box.height - 12))}px`;
}

/** 绑定工具面板和快捷键；原生浮层处理外点/Escape关闭及焦点，输入框和模态对话保留原生按键。 */
export function initEditor() {
  arrangeEditor();
  mobileLayout.addEventListener('change', arrangeEditor);
  $('editorToolsBtn').addEventListener('click', () => { $('editorPanel').hidden = !$('editorPanel').hidden; $('editorToolsBtn').setAttribute('aria-expanded', String(!$('editorPanel').hidden)); });
  $('editorCloseBtn').addEventListener('click', () => { setEditorTool('inspect'); $('editorPanel').hidden = true; $('editorToolsBtn').setAttribute('aria-expanded', 'false'); });
  for (const button of document.querySelectorAll('[data-edit-tool]')) button.addEventListener('click', () => setEditorTool(button.dataset.editTool));
  $('editorUndoBtn').addEventListener('click', () => editorHistory());
  $('editorRedoBtn').addEventListener('click', () => editorHistory(true));
  $('editorColorBtn').addEventListener('click', () => openColorEditor(null, null, 'choose'));
  $('editorApplyBtn').addEventListener('click', applyEditorDraft);
  $('editorCancelBtn').addEventListener('click', cancelEditorDraft);
  $('editorRemoveMode').addEventListener('change', cancelEditorDraft);
  // 原生popover进入顶层，避免桌面工具匣overflow裁切；同步展开状态供键盘与辅助技术读取。
  $('editorMoreMenu').addEventListener('toggle', event => {
    // 外点和Escape同样派发toggle，展开标记不依赖具体的关闭入口。
    $('editorMoreBtn').setAttribute('aria-expanded', String(event.newState === 'open'));
    // 打开后按最终尺寸定位，外点或Escape关闭均由浏览器负责。
    positionEditorMore();
  });
  // 窗口或页面滚动时跟随入口定位，不改变图纸自身的缩放、滚动或编辑状态。
  window.addEventListener('resize', positionEditorMore);
  document.addEventListener('scroll', positionEditorMore, true);
  $('editorConfirmApply').addEventListener('click', () => $('editorConfirmDialog').close('apply'));
  $('editorConfirmCancel').addEventListener('click', () => $('editorConfirmDialog').close('cancel'));
  document.addEventListener('keydown', event => {
    if (event.target.closest?.('input,textarea,select,[contenteditable=true]') || event.isComposing || document.querySelector('dialog[open]') || $('editorMoreMenu').matches(':popover-open') || (state.originalPreview || state.previewMode === 'beads')) return;
    if (event.key === 'Escape') { cancelEditorDraft(); return; }
    if (state.mode !== 'design') return;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); editorHistory(event.key.toLowerCase() === 'y' || event.shiftKey); return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tool = { b: 'pencil', e: 'eraser', g: 'fill', i: 'eyedropper', h: 'pan', v: 'inspect' }[event.key.toLowerCase()];
    if (tool) { event.preventDefault(); $('editorPanel').hidden = false; setEditorTool(tool); }
    if (event.code === 'Space') { event.preventDefault(); editorSession.space = true; cancelEditorDraft(); }
  });
  document.addEventListener('keyup', event => { if (event.code === 'Space') editorSession.space = false; });
  window.addEventListener('blur', () => { editorSession.space = false; editorSession.pointers.clear(); editorSession.gesture = null; if (editorSession.stroke) cancelEditorDraft(); });
  refreshEditor();
}
