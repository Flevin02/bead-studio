/**
 * 外壳与布局：主题、模式切换、断点迁移、开关形变动画与提示条。
 */

import { arrangeEditor, cancelEditorDraft, setEditorTool } from './editor.js';
import { closeSourcePreview } from './source-preview.js';

import { $, canvas, directionSwitch, env, exportButtons, fileInput, mobileLayout, modeSwitch, motionPreference, palettePanel, persistence, settingsHome, settingsPanel, state, switchVisuals, workspace } from '../core/state.js';
import { flushPending } from '../features/pattern.js';
import { markProjectChange } from '../features/project.js';
import { fitCanvas, render } from '../features/renderer.js';
import { closeReadingPalette, placePalette, readingCenter, restoreReadingView, updateCellMarker } from '../features/view.js';

/** 模式或断点改变后结束旧弹窗的退出动画；避免面板迁移时留下空壳或旧遮罩。 */
export function finishClosedDialogs() {
  for (const dialog of document.querySelectorAll('dialog:not([open])')) {
    for (const animation of dialog.getAnimations({ subtree: true })) animation.finish();
  }
}

/** 采集当前可见面板和图纸尺寸；连续切换从屏幕上的中间位置接续。 */
export function captureWorkspace() {
  if (mobileLayout.matches || motionPreference.matches || !persistence.ready) return null;
  const bounds = workspace.getBoundingClientRect();
  const panels = [settingsPanel, workspace.querySelector('.preview'), palettePanel].filter(Boolean).map(element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { element, x: box.x - bounds.x, y: box.y - bounds.y, width: box.width, height: box.height,
      visible: style.display !== 'none' && box.width > 0, opacity: Number(style.opacity), display: style.display };
  });
  const image = canvas.getBoundingClientRect();
  const snapshot = { panels, height: bounds.height, image: { width: image.width, height: image.height } };
  // 先读取实际中间帧，再撤销旧动画；新布局始终从干净的自然尺寸计算。
  env.workspaceMotion?.finish();
  return snapshot;
}

/** 同步移动面板与图纸边界；过渡期间只改变CSS几何，结束后补足预览像素，不重采样格子。 */
export function animateWorkspace(snapshot, center) {
  if (!snapshot) return;
  const bounds = workspace.getBoundingClientRect();
  const targets = snapshot.panels.map(({ element }) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { element, x: box.x - bounds.x, y: box.y - bounds.y, width: box.width, height: box.height,
      visible: style.display !== 'none' && box.width > 0, display: style.display };
  });
  const image = { width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height };
  const originals = new Map(), animations = [];
  // 一次轻回弹后快速稳定；不采用持续振荡，避免长时间干扰看图。
  const spring = 'linear(0, .12 5%, .37 13%, .68 25%, .89 40%, .985 57%, 1.012 72%, 1.006 86%, 1)';
  const timing = { duration: 480, easing: CSS.supports('animation-timing-function', spring) ? spring : 'cubic-bezier(.2,.8,.2,1)' };
  workspace.classList.add('layout-motion');
  workspace.style.height = `${bounds.height}px`;
  const motion = { frame: null, finish: () => {
    if (env.workspaceMotion !== motion) return;
    cancelAnimationFrame(motion.frame);
    // 移除过渡专用样式，最终尺寸继续由原媒体查询决定；不遗留绝对定位或inert状态。
    for (const animation of animations) animation.cancel();
    for (const [element, saved] of originals) {
      if (saved.style === null) element.removeAttribute('style');
      else element.setAttribute('style', saved.style);
      element.inert = saved.inert;
    }
    workspace.classList.remove('layout-motion'); workspace.style.removeProperty('height');
    env.workspaceMotion = null;
    // 动画期间只调整CSS尺寸；结束后按真实容器恢复同一阅读中心及定位标记。
    fitCanvas();
    restoreReadingView(center);
  } };
  env.workspaceMotion = motion;
  // 面板占位的高度也连续变化，平板的下排清单不会在切换时把页面突然顶开。
  animations.push(workspace.animate([{ height: `${snapshot.height}px` }, { height: `${bounds.height}px` }], timing));
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i], from = snapshot.panels[i], element = target.element;
    if (!from.visible && !target.visible) continue;
    originals.set(element, { style: element.getAttribute('style'), inert: element.inert });
    const side = element === settingsPanel ? -1 : 1;
    const final = target.visible ? target : { ...from, x: side < 0 ? -from.width - 20 : bounds.width + 20 };
    const start = from.visible ? from : { ...target, x: target.x + side * Math.min(target.width, 100) };
    Object.assign(element.style, { position: 'absolute', margin: '0', display: target.visible ? target.display : from.display,
      left: `${final.x}px`, top: `${final.y}px`, width: `${final.width}px`, height: `${final.height}px`,
      opacity: target.visible ? '1' : '0', minWidth: '0', minHeight: '0' });
    // 退出中的面板保留可见像素，但立即停止响应点击和键盘，与业务模式保持一致。
    element.inert = !target.visible;
    animations.push(element.animate([
      { left: `${start.x}px`, top: `${start.y}px`, width: `${start.width}px`, height: `${start.height}px`, opacity: from.visible ? from.opacity : 0 },
      { left: `${final.x}px`, top: `${final.y}px`, width: `${final.width}px`, height: `${final.height}px`, opacity: target.visible ? 1 : 0 }
    ], timing));
  }
  // 图纸以同一原始像素帧平滑适配新边界，不拉伸比例，也不引入新Canvas绘制。
  animations.push(canvas.animate([
    { width: `${snapshot.image.width}px`, height: `${snapshot.image.height}px` },
    { width: `${image.width}px`, height: `${image.height}px` }
  ], timing));
  const pinReadingCenter = () => {
    if (env.workspaceMotion !== motion) return;
    const area = $('canvasScroll'), view = area.getBoundingClientRect(), current = canvas.getBoundingClientRect();
    state.adjustingView = true;
    area.scrollLeft += current.x + current.width * center.x - view.x - view.width / 2;
    area.scrollTop += current.y + current.height * center.y - view.y - view.height / 2;
    // 标记跟随CSS缩放，不进入导出；每帧只保留一个几何同步任务。
    updateCellMarker();
    motion.frame = requestAnimationFrame(pinReadingCenter);
  };
  motion.frame = requestAnimationFrame(pinReadingCenter);
  Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(motion.finish);
}

/** 将选中底块绘成一条连续轮廓；两端和细腰高度独立，流动时保持文字与点击区域固定。 */
export function fluidPath(shape) {
  const { left, right, center, startHeight, endHeight, waist } = shape;
  const width = right - left, middle = (left + right) / 2;
  const a = Math.min(6, startHeight), b = Math.min(6, endHeight);
  return `M ${left + a} ${center - startHeight}
      C ${left + width * .25} ${center - startHeight}, ${left + width * .30} ${center - waist}, ${middle} ${center - waist}
      C ${right - width * .30} ${center - waist}, ${right - width * .25} ${center - endHeight}, ${right - b} ${center - endHeight}
      Q ${right} ${center - endHeight} ${right} ${center - endHeight + b}
      L ${right} ${center + endHeight - b} Q ${right} ${center + endHeight} ${right - b} ${center + endHeight}
      C ${right - width * .25} ${center + endHeight}, ${right - width * .30} ${center + waist}, ${middle} ${center + waist}
      C ${left + width * .30} ${center + waist}, ${left + width * .25} ${center + startHeight}, ${left + a} ${center + startHeight}
      Q ${left} ${center + startHeight} ${left} ${center + startHeight - a}
      L ${left} ${center - startHeight + a} Q ${left} ${center - startHeight} ${left + a} ${center - startHeight} Z`;
}

/** 同步一组按钮的选中底块；animate仅用于用户切换，恢复、布局变化和减少动画设置直接到位。 */
export function syncFluidSwitch(group, button, animate = false) {
  let visual = switchVisuals.get(group);
  if (!group.clientWidth || !group.clientHeight) {
    // 方向按钮在拼豆模式隐藏；退出未完成的帧，返回制图时按真实尺寸重新定位。
    if (visual) cancelAnimationFrame(visual.frame);
    return;
  }
  const box = button.getBoundingClientRect(), bounds = group.getBoundingClientRect();
  const target = { left: box.left - bounds.left - group.clientLeft,
    right: box.right - bounds.left - group.clientLeft, center: box.top - bounds.top - group.clientTop + box.height / 2,
    startHeight: box.height / 2, endHeight: box.height / 2, waist: box.height / 2 };
  if (!visual) {
    const layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    layer.classList.add('fluid-indicator'); layer.setAttribute('aria-hidden', 'true'); layer.setAttribute('focusable', 'false');
    layer.append(path); group.prepend(layer); group.classList.add('fluid-switch');
    visual = { layer, path, shape: target, button: null, frame: null };
    switchVisuals.set(group, visual);
  }
  // 同一选项重复点击不重放动画；快速反向切换从上一帧的真实轮廓继续。
  if (animate && visual.button === button) return;
  cancelAnimationFrame(visual.frame);
  visual.layer.setAttribute('viewBox', `0 0 ${group.clientWidth} ${group.clientHeight}`);
  visual.button = button;
  const from = visual.shape;
  if (!animate || !persistence.ready || motionPreference.matches) {
    visual.shape = target;
    // 静止时恢复完整圆角矩形，不保留上次动画的细腰或拉伸。
    visual.path.setAttribute('d', fluidPath(target));
    return;
  }
  const started = performance.now(), rightward = target.left > from.left;
  const mix = (a, b, progress) => a + (b - a) * progress;
  const step = now => {
    const t = Math.min(1, (now - started) / 360);
    // 阻尼曲线让底块先跟手加速，再带一次克制的回弹；前后缘只留很短的时差。
    const response = value => 1 - Math.exp(-8 * value) * (Math.cos(9 * value) + 8 / 9 * Math.sin(9 * value));
    const leading = response(Math.min(1, t * 1.08)), trailing = response(t);
    const stretch = Math.sin(Math.PI * t), rebound = 0;
    const shape = {
      left: mix(from.left, target.left, rightward ? trailing : leading) + rebound,
      right: mix(from.right, target.right, rightward ? leading : trailing) + rebound,
      center: mix(from.center, target.center, leading),
      startHeight: mix(from.startHeight, target.startHeight, leading) * (1 - .08 * stretch * (rightward ? t : 1 - t)),
      endHeight: mix(from.endHeight, target.endHeight, leading) * (1 - .08 * stretch * (rightward ? 1 - t : t)),
      waist: mix(from.waist, target.waist, leading) * (1 - .16 * stretch)
    };
    visual.shape = t === 1 ? target : shape;
    // 只更新装饰SVG，不重绘图纸、不改变任何按钮尺寸和业务选中状态。
    visual.path.setAttribute('d', fluidPath(visual.shape));
    visual.frame = t < 1 ? requestAnimationFrame(step) : null;
  };
  visual.frame = requestAnimationFrame(step);
}

/** 根据当前可见按钮的真实尺寸计算图标位移；模式切换或横竖屏变化后仍保持居中。 */
export function positionExportIcons() {
  for (const button of exportButtons) {
    if (!button.offsetWidth) continue;
    const slot = button.querySelector('.export-icon-slot');
    button.style.setProperty('--export-shift', `${button.clientWidth / 2 - slot.offsetLeft - slot.offsetWidth / 2}px`);
  }
}

/** 初次显示、断点变化或系统减少动画设置改变时，直接同步两组按钮的最终视觉位置。 */
export function refreshButtonMotion() {
  // 读取已有aria状态，不给恢复作品或调整布局额外制造业务切换。
  syncFluidSwitch(modeSwitch, modeSwitch.querySelector('[aria-pressed="true"]'));
  syncFluidSwitch(directionSwitch, directionSwitch.querySelector('[aria-pressed="true"]'));
  // 图标保留正常流布局，动态计算位移，不通过隐藏文字缩窄导出按钮。
  positionExportIcons();
}

/** 仅改变操作与布局，不重新生成图纸；切换后仍看同一区域。 */
export function setMode(mode) {
  if (!['design', 'beading'].includes(mode)) return;
  const changed = state.mode !== mode;
  if (!changed) return;
  const center = readingCenter();
  // 捕获两侧及中央的实际中间帧，快速反向时从当前位置继续。
  const layout = captureWorkspace();
  // 参数若尚在等待量化，先生成完整结果，再进入只读的拼豆模式。
  flushPending();
  closeReadingPalette();
  $('mobileSettingsDialog').close(); $('colorDialog').close();
  closeSourcePreview(true);
  cancelEditorDraft();
  state.mode = mode;
  setEditorTool('inspect');
  $('editorPanel').hidden = true;
  $('editorToolsBtn').setAttribute('aria-expanded', 'false');
  arrangeEditor();
  document.body.classList.toggle('beading-mode', mode === 'beading');
  $('designModeBtn').classList.toggle('active', mode === 'design');
  $('beadingModeBtn').classList.toggle('active', mode === 'beading');
  $('designModeBtn').setAttribute('aria-pressed', String(mode === 'design'));
  $('beadingModeBtn').setAttribute('aria-pressed', String(mode === 'beading'));
  // 模式立即生效，底块只做跟随动画；重新出现的方向按钮直接对齐原选项。
  syncFluidSwitch(modeSwitch, mode === 'beading' ? $('beadingModeBtn') : $('designModeBtn'), true);
  syncFluidSwitch(directionSwitch, state.mirrored ? $('mirrorBtn') : $('normalBtn'));
  // 导出期间也允许阅读模式切换，新出现的同款按钮继续显示居中图标。
  positionExportIcons();
  $('previewHeading').textContent = mode === 'beading' ? '拼豆图纸' : '图纸预览';
  canvas.setAttribute('aria-label', mode === 'beading' ? '拼豆图纸，点击色块只显示全部同色号豆子并查看格子信息，取消高亮恢复全图' : '拼豆图纸，悬停突出同色号，点击查看格子信息，换色请使用工具或清单');
  // 同一份清单和设置随屏幕布局移动，避免编号与状态出现两份不同步的DOM。
  placePalette();
  // 面板已归属新布局，旧模态的离散退出无需继续保留在顶层。
  finishClosedDialogs();
  render();
  // 原布局计算完后再播放真实面板的边界变化；模式与按钮状态已经立即生效。
  animateWorkspace(layout, center);
  restoreReadingView(center).then(() => markProjectChange());
}

/** 手机把同一组设置移到弹窗中，避免首屏被参数占满；桌面恢复原来的侧栏位置。 */
export function adaptMobileLayout() {
  // 浏览器重算媒体条件时也可能通知相同状态；只有真正跨断点才移动DOM和收起清单。
  if (state.mobileView === mobileLayout.matches) return;
  state.mobileView = mobileLayout.matches;
  const center = readingCenter();
  // 断点改变时先收起弹窗，再把清单移到新布局的位置。
  closeReadingPalette();
  if (mobileLayout.matches) $('mobileSettingsContent').append(settingsPanel);
  else {
    $('mobileSettingsDialog').close();
    settingsHome.after(settingsPanel);
    // 手机可放大到 400%；回到桌面时限制到原有范围。
    state.zoom = Math.min(state.zoom, 2.5);
  }
  placePalette();
  // 跨断点迁移真实DOM时，立即移除旧底部抽屉的过渡和遮罩。
  finishClosedDialogs();
  if (state.source) {
    fitCanvas();
    restoreReadingView(center);
  }
}

/** 打开手机设置并聚焦标题；同一文件控件移入弹窗，程序聚焦不滚动面板或背景。 */
export function openMobileSettings() {
  env.settingsVisit++;
  $('sourceError').hidden = true;
  $('mobileSettingsDialog').append(fileInput);
  // 标题的 autofocus 先约束原生初始焦点，再显式使用 preventScroll 保持阅读位置。
  $('mobileSettingsDialog').showModal();
  $('mobileSettingsTitle').focus({ preventScroll: true });
}

/** 在原点击任务内唤起系统选图；临时入口仅供错误显示使用，不等待异步操作或关闭设置。 */
export function chooseImage() {
  const inSettings = $('mobileSettingsDialog').open;
  env.filePickContext = inSettings ? env.settingsVisit : null;
  $('sourceError').hidden = true;
  // 保留浏览器的用户激活，并复用原来的文件校验、解码和替换确认链。
  fileInput.click();
}

/** 将本次图片错误放到有效的设置会话内；面板已关闭或重开时只沿用页面提示。 */
export function imageError(message, context) {
  if (context === env.settingsVisit && $('mobileSettingsDialog').open) {
    $('sourceError').textContent = message;
    $('sourceError').hidden = false;
    // 错误靠近当前图片，短屏也能看到；仅滚动设置内部，不跳动背景作品。
    $('sourceError').scrollIntoView({ block: 'nearest' });
  } else {
    // 主页面上传和已退出设置的操作仍使用原有的错误反馈。
    toast(message, true);
  }
}

/** 在页面底部报告操作结果；错误会保留更长时间，便于阅读。 */
export function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').className = `toast visible${error ? ' error' : ''}`;
  state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), error ? 6500 : 3200);
}

/** 更新界面模式及图纸空格；remember 仅保存用户主动选择，不保存图片或作品。 */
export function applyTheme(theme, remember = false) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (remember) {
    document.documentElement.dataset.themeSource = 'manual';
    try { localStorage.setItem('bead-studio-theme', dark ? 'dark' : 'light'); }
    catch { /* 无痕或受限存储不影响本页切换，界面依旧保持用户选择。 */ }
  }
  const label = dark ? '切换到白天模式' : '切换到黑夜模式';
  $('themeToggleBtn').setAttribute('aria-label', label);
  $('themeToggleBtn').setAttribute('aria-pressed', String(dark));
  $('themeToggleBtn').title = label;
  $('themeToggleBtn').querySelector('span').textContent = dark ? '白天模式' : '黑夜模式';
  $('themeToggleBtn').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#191820' : '#7755cc';
  // 重绘只改变环境颜色；源图、色号、用量、镜像与缩放状态均沿用当前结果。
  if (state.source) render();
}
