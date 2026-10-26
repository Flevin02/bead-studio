/**
 * 入口：装配各组件、绑定页面事件、启动一次只读恢复。业务逻辑不要写在这里。
 *
 * 组件边界（浏览器原生 ESM，无打包步骤；彼此只按「调用时的引用」协作）：
 *   core/state.js         共享底座：元素引用、作品状态、断点、持久化事务
 *   features/pattern.js   原图 → 图纸：取样帧、量化、杂点清理、换图与示例
 *   features/renderer.js  图纸绘制：预览与导出共用同一条 drawPattern 路径
 *   features/panels.js    用量清单、改色弹窗、色卡标签
 *   features/view.js      阅读视图：缩放、阅读中心、定位标记、点格找色、清单开合
 *   features/shell.js     外壳：主题、模式切换、断点迁移、开关形变动画、提示条
 *   features/project.js   本地存档：快照、串行写入、版本冲突与恢复
 *   features/exporter.js  高清 PNG 与打印页
 *
 * 事件一律在此绑定：谁触发、调用哪个组件、是否需要先提交挂起的滑块计算，都在这一层看清。
 */

import { editorConsumesClick, editorPointerDown, editorPointerMove, editorPointerUp, initEditor } from './features/editor.js';
import { initSourcePreview } from './features/source-preview.js';
import { initBeadPreview } from './features/bead-preview.js';
import { initPreviewPages } from './features/preview-pages.js';

import { $, P, canvas, builtinCards, defaultCard, env, fileInput, fileInputHome, mobileLayout, motionPreference, persistence, state } from './core/state.js';
import { exportPattern, printPattern } from './features/exporter.js';
import { applyCard, renderColorChoices, resetCustomColors, saveColor, setColorDraft } from './features/panels.js';
import { cancelPendingGeneration, createDemo, flushPending, loadFile, scheduleRegenerate, useSource } from './features/pattern.js';
import { confirmNewProject, markProjectChange, restoreProject, saveProject } from './features/project.js';
import { fitCanvas, render } from './features/renderer.js';
import { adaptMobileLayout, applyTheme, chooseImage, openMobileSettings, refreshButtonMotion, setMode, toast } from './features/shell.js';
import { changeZoom, closeReadingPalette, editCellColor, initReadingPaletteGesture, inspectCell, readingCenter, restoreReadingView, setDirection, showCellInfo, togglePalette, updateHighlight } from './features/view.js';

// 事件只初始化一次；图片、色卡与 OCR 均在本地处理，不使用外部服务。
// 页面展示文案不写入剪贴板；编辑控件保留原生复制，不拦截粘贴或键盘快捷键。
document.addEventListener('copy', event => {
  const target = event.target;
  // 放行输入框及可编辑内容，动态生成的色卡校对框也沿用同一规则。
  if (target instanceof Element && (target.matches('input, textarea') || target.isContentEditable)) return;
  // 阻止页面级全选或浏览器复制命令带走展示文案。
  event.preventDefault();
});
// ── 主题 ──
$('themeToggleBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
  if (document.documentElement.dataset.themeSource !== 'manual') applyTheme(event.matches ? 'dark' : 'light');
});
// ── 选图（按钮、拖放、示例） ──
$('uploadBtn').addEventListener('click', chooseImage);
$('mobileUploadBtn').addEventListener('click', chooseImage);
$('mobileSettingsBtn').addEventListener('click', openMobileSettings);
for (const id of ['closeMobileSettingsBtn', 'doneMobileSettingsBtn']) $(id).addEventListener('click', () => $('mobileSettingsDialog').close());
$('mobileSettingsDialog').addEventListener('close', () => {
  if ($('mobileSettingsDialog').open) return;
  // 仅退出设置才把同一文件控件归位；确认新作品及系统选图不触发此路径。
  fileInputHome.after(fileInput);
  if (mobileLayout.matches && state.mode === 'design') {
    // 主动退出时回到入口，跨断点或模式切换不聚焦已隐藏的按钮。
    $('mobileSettingsBtn').focus({ preventScroll: true });
  }
});
$('mobileExportBtn').addEventListener('click', () => { flushPending(); exportPattern(); });
mobileLayout.addEventListener('change', adaptMobileLayout);
$('replaceBtn').addEventListener('click', chooseImage);
fileInput.addEventListener('change', event => {
  const context = env.filePickContext === undefined ? ($('mobileSettingsDialog').open ? env.settingsVisit : null) : env.filePickContext;
  env.filePickContext = undefined;
  // 只传递这次发起入口，不保存到作品；清空value允许再次选择同一文件。
  loadFile(event.target.files[0], context);
  event.target.value = '';
});
fileInput.addEventListener('cancel', () => { env.filePickContext = undefined; });
for (const name of ['dragenter', 'dragover']) $('uploadBtn').addEventListener(name, event => { event.preventDefault(); $('uploadBtn').classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) $('uploadBtn').addEventListener(name, event => { event.preventDefault(); $('uploadBtn').classList.remove('drag-over'); });
$('uploadBtn').addEventListener('drop', event => loadFile(event.dataTransfer.files[0]));
// 拦截落在页面其他区域的文件，防止浏览器导航离开当前作品。
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('drop', event => { event.preventDefault(); if (!event.target.closest('#uploadBtn')) toast('把图片拖进左侧上传区域即可。'); });
$('demoBtn').addEventListener('click', async () => {
  // 有已保存作品时重置示例也是开始新作品，沿用同一保护提示。
  if (!await confirmNewProject()) return;
  state.loadVersion++; state.loading = false;
  $('uploadBtn').disabled = false; $('uploadBtn').querySelector('strong').textContent = '点击上传，或拖入图片';
  const used = await useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
  if (!used) return;
  toast('已打开橘子猫示例。');
});
// ── 参数与显示开关（都会重新量化或重绘） ──
// 最新计算可取消；品牌切换沿用手改确认和完整提交。
$('cancelGenerationBtn').addEventListener('click', () => cancelPendingGeneration());
$('builtinCardSelect').addEventListener('change', () => {
  const card = builtinCards.find(item => item.id === $('builtinCardSelect').value);
  if (card) applyCard(card);
});
$('ditherMode').addEventListener('change', scheduleRegenerate);
$('sizeRange').addEventListener('input', scheduleRegenerate);
$('colorRange').addEventListener('input', scheduleRegenerate);
// 杂点清理改变的是格子本身，需要重新量化而不是只重绘。
$('denoiseCheck').addEventListener('change', scheduleRegenerate);
// 背景清理：开关决定是否识别，容差与留白改变裁剪与取样范围，都需要重新量化。
$('bgCheck').addEventListener('change', scheduleRegenerate);
for (const id of ['bgTolerance', 'bgMargin', 'ditherRange']) $(id).addEventListener('input', scheduleRegenerate);
document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => {
  $('sizeRange').value = button.dataset.size; scheduleRegenerate();
}));
for (const id of ['gridCheck', 'guideCheck', 'codeCheck', 'beadCheck']) $(id).addEventListener('change', () => { flushPending(); render(); markProjectChange(true); });
$('normalBtn').addEventListener('click', () => { flushPending(); setDirection(false); });
$('mirrorBtn').addEventListener('click', () => { flushPending(); setDirection(true); });
$('clearHighlightBtn').addEventListener('click', () => { state.selected = null; updateHighlight(); markProjectChange(); });
$('cancelReadingHighlightBtn').addEventListener('click', () => { state.selected = null; updateHighlight(); markProjectChange(); });
// ── 改色弹窗 ──
$('resetColorsBtn').addEventListener('click', resetCustomColors);
$('colorForm').addEventListener('submit', saveColor);
$('colorPicker').addEventListener('input', event => setColorDraft(event.target.value.toUpperCase()));
$('colorHex').addEventListener('input', event => {
  const hex = P.normalizeHex(event.target.value);
  if (hex) setColorDraft(hex);
});
$('colorSearch').addEventListener('input', () => renderColorChoices());
for (const id of ['closeColorBtn', 'cancelColorBtn']) $(id).addEventListener('click', () => $('colorDialog').close());
$('colorDialog').addEventListener('close', () => { state.editingColor = null; });
// ── 阅读视图：缩放、点格找色、模式与清单 ──
$('zoomInBtn').addEventListener('click', () => changeZoom(state.zoom + .25));
$('zoomOutBtn').addEventListener('click', () => changeZoom(state.zoom - .25));
const resetZoom = () => { state.zoom = 1; fitCanvas(); $('canvasScroll').scrollTo(0, 0); markProjectChange(); };
$('zoomResetBtn').addEventListener('click', resetZoom);
$('fitBtn').addEventListener('click', resetZoom);
// ── 导出、打印与说明弹窗 ──
$('exportBtn').addEventListener('click', () => { flushPending(); exportPattern(); });
$('printBtn').addEventListener('click', () => { flushPending(); printPattern(); });
canvas.addEventListener('pointerdown', editorPointerDown);
canvas.addEventListener('pointermove', event => { if (!editorPointerMove(event)) inspectCell(event); });
canvas.addEventListener('pointerup', event => editorPointerUp(event));
canvas.addEventListener('pointercancel', event => editorPointerUp(event, true));
canvas.addEventListener('click', event => { if (!editorConsumesClick()) editCellColor(event); });
canvas.addEventListener('pointerleave', () => { canvas.style.cursor = 'default'; showCellInfo(); });
$('guideBtn').addEventListener('click', () => {
  // 标题承接原生初始焦点，避免打开指南时默认高亮关闭按钮。
  $('guideDialog').showModal();
  // 反复打开也回到标题；不因程序聚焦改变指南或背景的阅读位置。
  $('guideDialogTitle').focus({ preventScroll: true });
});
$('closeGuideBtn').addEventListener('click', () => $('guideDialog').close());
$('gotItBtn').addEventListener('click', () => $('guideDialog').close());
$('designModeBtn').addEventListener('click', () => setMode('design'));
$('beadingModeBtn').addEventListener('click', () => setMode('beading'));
$('readingExportBtn').addEventListener('click', () => { flushPending(); exportPattern(); });
// ── 保存与恢复（重试、切后台兜底） ──
$('retrySaveBtn').addEventListener('click', saveProject);
$('retryRestoreBtn').addEventListener('click', restoreProject);
$('reloadProjectBtn').addEventListener('click', () => location.reload());
$('newProjectBtn').addEventListener('click', chooseImage);
$('cancelNewProjectBtn').addEventListener('click', () => $('newProjectDialog').close('cancel'));
$('confirmNewProjectBtn').addEventListener('click', () => $('newProjectDialog').close('continue'));
$('paletteToggleBtn').addEventListener('click', togglePalette);
$('mobilePaletteBtn').addEventListener('click', togglePalette);
$('closeReadingPaletteBtn').addEventListener('click', closeReadingPalette);
// 手机底部清单支持下拉收起，内容区保留原生滚动及点选找色。
initReadingPaletteGesture();
$('readingPaletteDialog').addEventListener('close', () => {
  document.body.classList.remove('palette-open');
  $('paletteToggleBtn').setAttribute('aria-expanded', 'false');
  $('mobilePaletteBtn').setAttribute('aria-expanded', 'false');
});
$('canvasScroll').addEventListener('scroll', () => {
  // 适配布局、启动恢复和主题重绘产生的滚动不是用户修改，不能制造待保存状态。
  if (!state.adjustingView) markProjectChange();
}, { passive: true });
// 平时已合并保存；切后台再尝试提交，不把卸载时的异步写入当作成功保证。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && persistence.sequence !== persistence.savedSequence) saveProject();
});
$('guideDialog').addEventListener('click', event => { if (event.target === $('guideDialog')) { const r = $('guideDialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('guideDialog').close(); } });
$('defaultCardBtn').addEventListener('click', () => applyCard(defaultCard));
window.BeadImports.init(applyCard, toast, cancelPendingGeneration);
window.addEventListener('resize', () => {
  // 断点或横竖屏改变时取消过期几何，交还给现有响应式布局。
  env.workspaceMotion?.finish();
  const center = readingCenter();
  fitCanvas();
  restoreReadingView(center);
  // 布局改变时直接对齐真实按钮，不在过期尺寸上继续形变。
  refreshButtonMotion();
});
// 系统切到减少动画时立即收拢当前底块，后续操作仍提供明确的静态选中与忙碌状态。
motionPreference.addEventListener('change', () => {
  // 系统减少动画在运行中生效时，也立即结束边栏过渡，保留最终业务状态。
  env.workspaceMotion?.finish();
  refreshButtonMotion();
});
// 编辑与原图查看只绑定一次，作品恢复仍由原存储链路负责。
initEditor();
initSourcePreview();
// 立体预览独立绑定，不接管二维编辑或原图入口。
initBeadPreview();
// 同一区域的三页导航最后绑定，边缘事件在捕获阶段与编辑／旋转隔离。
initPreviewPages();
// ── 启动：先适配布局与底块，再只读恢复作品 ──
adaptMobileLayout();
// 为初次示例建立静态底块，读取作品时由已有状态直接覆盖，不播放启动动画。
refreshButtonMotion();
// 初始化按钮与浏览器主题栏，颜色选择已在 head 中完成以防白屏闪烁。
applyTheme(document.documentElement.dataset.theme);
// 先只读恢复，完成前不允许示例或用户点击覆盖磁盘里的作品。
restoreProject();
