/**
 * 图像到图纸：取样帧、有限色集量化、杂点清理，以及换图 / 示例载入。
 */

import { $, P, canvas, env, persistence, state } from '../core/state.js';
import { renderPalette, updateControls, updateCardLabel } from '../features/panels.js';
import { confirmNewProject, markProjectChange, saveProject } from '../features/project.js';
import { cellAt, render } from '../features/renderer.js';
import { imageError, toast } from '../features/shell.js';
import { setDirection } from '../features/view.js';

import { confirmEditorAction, resetEditorSession } from './editor.js';
import { resetSourcePreview } from './source-preview.js';
import { cancelComputation, computePattern } from './generation.js';

// 版本隔离覆盖计时器、解码、计算及完整提交；Promise 供导出与保存等待。
let generationSequence = 0;
let generationPromise = Promise.resolve(false);

/** 用本地像素画生成示例，无需联网下载图片，也避免跨域画布限制。 */
export function createDemo() {
  const demo = document.createElement('canvas');
  demo.width = demo.height = 32;
  const ctx = demo.getContext('2d');
  const colors = {
    outline: '#655167', orange: '#e9a665', light: '#f5c590', cream: '#fff1d6',
    pink: '#e9a6ae', green: '#9caf87', leaf: '#75947c', purple: '#c6b2de',
    yellow: '#f4d990', soil: '#b48c7d', pot: '#d5b6b1', white: '#fffaf1'
  };
  const rect = (x, y, w, h, color) => { ctx.fillStyle = colors[color] || color; ctx.fillRect(x, y, w, h); };
  // 左侧花盆与右侧小花让示例不对称，能直观看到镜像效果。
  rect(2, 26, 7, 2, 'pot'); rect(3, 28, 5, 3, 'pot'); rect(3, 27, 5, 1, 'soil');
  rect(5, 19, 1, 7, 'leaf'); rect(3, 21, 2, 2, 'green'); rect(2, 20, 2, 2, 'green');
  rect(6, 23, 2, 2, 'leaf'); rect(7, 22, 2, 2, 'leaf'); rect(4, 18, 3, 3, 'green');
  rect(26, 27, 1, 4, 'leaf'); rect(25, 28, 1, 1, 'green'); rect(27, 29, 2, 1, 'green');
  rect(25, 24, 3, 3, 'purple'); rect(24, 25, 5, 1, 'purple'); rect(26, 25, 1, 1, 'yellow');
  // 猫尾巴、身体、耳朵和脑袋用整像素绘制，低精度图纸也能保留轮廓。
  rect(22, 20, 5, 3, 'outline'); rect(25, 18, 3, 4, 'outline');
  rect(26, 17, 2, 3, 'outline'); rect(23, 21, 3, 1, 'orange'); rect(26, 19, 1, 2, 'orange');
  rect(10, 17, 13, 11, 'outline'); rect(11, 18, 11, 10, 'orange');
  rect(9, 25, 15, 4, 'outline'); rect(10, 26, 13, 2, 'orange');
  rect(14, 19, 7, 8, 'cream'); rect(13, 24, 8, 4, 'cream');
  rect(8, 6, 3, 8, 'outline'); rect(10, 8, 3, 7, 'outline');
  rect(21, 6, 3, 8, 'outline'); rect(19, 8, 3, 7, 'outline');
  rect(9, 8, 1, 5, 'orange'); rect(10, 10, 2, 3, 'pink');
  rect(22, 8, 1, 5, 'orange'); rect(20, 10, 2, 3, 'pink');
  rect(9, 11, 14, 10, 'outline'); rect(7, 13, 18, 6, 'outline');
  rect(9, 12, 14, 8, 'orange'); rect(8, 14, 16, 4, 'orange');
  rect(14, 12, 6, 7, 'cream'); rect(13, 16, 9, 3, 'cream');
  rect(11, 12, 2, 2, 'light'); rect(21, 13, 2, 2, 'light');
  rect(15, 12, 2, 2, 'orange'); rect(15, 14, 1, 1, 'orange');
  rect(11, 15, 2, 2, 'outline'); rect(20, 15, 2, 2, 'outline');
  rect(9, 17, 2, 1, 'pink'); rect(22, 17, 2, 1, 'pink');
  rect(16, 17, 2, 1, 'pink'); rect(16, 18, 1, 1, 'outline');
  rect(15, 19, 1, 1, 'outline'); rect(17, 19, 1, 1, 'outline');
  rect(11, 26, 1, 2, 'outline'); rect(19, 26, 1, 2, 'outline');
  rect(11, 21, 2, 1, 'outline'); rect(11, 23, 2, 1, 'outline');
  rect(27, 6, 1, 5, 'yellow'); rect(25, 8, 5, 1, 'yellow');
  rect(4, 9, 1, 3, 'purple'); rect(3, 10, 3, 1, 'purple');
  return demo;
}

/** 返回固定计算运行时的网格尺寸，供原有调用及独立验证使用。 */
export const patternSize = globalThis.BeadEngine.patternSize;
/** 按原始像素确定性取样；同步参考和 Worker 使用同一实现。 */
export const samplingFrame = globalThis.BeadEngine.samplingFrame;

/** 读取一份生成参数；已应用值与待确认值分开，快照不会保存半次滑动。 */
export function readGenerationParameters() {
  return {
    longest: Math.max(16, Math.min(128, Number($('sizeRange').value) || 32)),
    maxColors: Math.max(4, Math.min(32, Number($('colorRange').value) || 16)),
    denoise: $('denoiseCheck').checked,
    dither: Math.max(0, Math.min(100, Number($('ditherRange').value) || 0)),
    ditherMode: $('ditherMode').value,
    background: { remove: $('bgCheck').checked, tolerance: Number($('bgTolerance').value) || 12, margin: Number($('bgMargin').value) || 0 }
  };
}

/** 恢复已应用控件或一次完整的新参数；不派发input，防止确认/取消再次触发重算。 */
export function applyGenerationParameters(parameters) {
  $('sizeRange').value = parameters.longest; $('colorRange').value = parameters.maxColors;
  $('denoiseCheck').checked = parameters.denoise !== false; $('ditherRange').value = parameters.dither || 0;
  $('ditherMode').value = parameters.ditherMode || 'fs';
  $('bgCheck').checked = parameters.background?.remove !== false;
  $('bgTolerance').value = parameters.background?.tolerance ?? 12; $('bgMargin').value = parameters.background?.margin ?? 2;
  updateControls();
}

/** 同步计算参考：不修改作品；产品生成通过后台入口提交。 */
export function calculatePattern(source, parameters = readGenerationParameters(), colors = state.card.colors) {
  // 独立验证仍能调用同步参考，后台与此处共用同一个分段计算器。
  return globalThis.BeadEngine.calculate(source, parameters, colors);
}

/** 从固定源帧重新采样；可接收换图前已成功计算的结果，避免失败时部分替换状态。 */
export function regenerate(computed = null) {
  if (!state.source) return;
  // 参数变化会重新识别色号，旧的手动分组不能套用到新结果。
  const result = computed || calculatePattern(state.source);
  $('colorDialog').close();
  // 保存独立快照；手动换成已用色号时会合并分组，恢复仍须还原原来的逐格映射。
  state.autoResult = { palette: result.palette.map(c => ({ ...c })), cells: result.cells.slice() };
  state.hasEdits = false;
  Object.assign(state, result, { selected: null, activeCell: null });
  state.appliedParameters = readGenerationParameters();
  // 新自动结果提交后才清历史，计算失败时旧手改和撤销仍可用。
  resetEditorSession();
  updateControls();
  renderPalette();
  render();
  if (!state.palette.length) toast('这张图片是透明的，没有需要放置的豆子。可以换一张图片。');
  // 只在完整量化成功后开始保存，初始化示例由 ready 状态阻止写入。
  markProjectChange(true);
}

/** 打开示例或换图后重置查看状态，保留尺寸和颜色偏好。 */
export async function useSource(source, name, meta, demo) {
  // 完成新图的解码与量化后才提交页面状态，失败继续展示原作品。
  const request = ++generationSequence, parameters = readGenerationParameters();
  // 换图与调参共用线程隔离，旧源帧在计算成功前仍完整保留。
  cancelComputation();
  state.loading = true;
  setGenerationBusy(true);
  try {
  const computed = await computePattern(source, parameters, state.card.colors);
  if (request !== generationSequence) return false;
  const result = computed.result;
  // 先验证整份结果，不让坏线程消息部分替换源图。
  validateGenerationResult(result, state.card.colors, parameters.maxColors);
  state.generationBackend = computed.backend;
  resetSourcePreview();
  state.source = source; state.name = name.replace(/\.[^.]+$/, '') || '我的拼豆作品'; state.demo = demo;
  state.sourceId = crypto.randomUUID();
  state.zoom = 1; state.mirrored = false; state.selected = null;
  $('fileName').textContent = name;
  $('mobileSourceAction').textContent = demo ? '上传图片' : '更换图片';
  $('fileMeta').textContent = meta;
  updateSourceThumbnail();
  regenerate(result);
  setDirection(false);
  // 用户已确认开始新作品，坏记录仍等新作品事务成功后才被替换。
  if (persistence.blocked === 'recovery') persistence.blocked = null;
  markProjectChange(true);
  return true;
  } finally {
    if (request === generationSequence) { state.loading = false; setGenerationBusy(false); }
  }
}

/** 缩略图只保留88px，完整源帧由作品保存单独缓存，避免预览重复编码大照片。 */
export function updateSourceThumbnail() {
  const source = state.source;
  const thumbnail = document.createElement('canvas');
  thumbnail.width = thumbnail.height = 88;
  const context = thumbnail.getContext('2d');
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  const ratio = 88 / Math.max(sw, sh);
  context.imageSmoothingEnabled = !state.demo;
  context.drawImage(source, (88 - sw * ratio) / 2, (88 - sh * ratio) / 2, sw * ratio, sh * ratio);
  // 设置侧栏和手机紧凑图片栏复用同一份88px缩略图，不新增原图编码或网络资源。
  const preview = thumbnail.toDataURL('image/png');
  $('sourceThumb').src = preview;
  $('sourcePreviewThumb').src = preview;
  $('mobileSourceThumb').src = preview;
  $('mobileFileName').textContent = $('fileName').textContent;
}

/**
 * 解码用户图片，检查实际尺寸后才替换当前图纸。
 * file为共享控件或拖入的文件；context仅标记发起换图的设置会话，默认是主页面。
 * 返回Promise；版本号让后来选择的文件优先，失败或取消不会清空已有作品。
 */
export async function loadFile(file, context = null) {
  if (!file) return;
  // 每次实际选择都使旧解码失效，即使新选择无效，旧异步结果也不能回填。
  const version = ++state.loadVersion;
  // 新选图先取消旧生成，迟到的旧参数任务不能在读取期间回填。
  cancelPendingGeneration();
  let url = null;
  if (context === env.settingsVisit) $('sourceError').hidden = true;
  try {
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
      // 设置内的文件错误必须可见，不仅写到被弹窗遮住的页面toast。
      imageError('请选择 PNG、JPG、WebP 或 GIF 图片。', context); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      // 文件大小限制与主页面一致，验证失败保留旧图及成功保存记录。
      imageError('图片超过 20 MB，请压缩后重新选择。', context); return;
    }
    url = URL.createObjectURL(file);
    state.loading = true; $('uploadBtn').disabled = true;
    $('uploadBtn').querySelector('strong').textContent = '正在读取图片…';
    const image = new Image(); image.src = url;
    // 实际解码后再判断像素上限，不仅信任文件扩展名或MIME。
    await image.decode();
    if (version !== state.loadVersion) return;
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 25000000) {
      // 像素超限同样反馈到本次有效的设置上下文。
      imageError('图片像素过大，请缩小到 2500 万像素以内再试。', context); return;
    }
    // 固定解码时的画面，动图之后调整参数时不会跳到其他帧。
    const frozen = document.createElement('canvas');
    frozen.width = image.naturalWidth; frozen.height = image.naturalHeight;
    frozen.getContext('2d').drawImage(image, 0, 0);
    // 文件选择取消、非法图片均不会弹出替换提示；有效新图才需要确认。
    if (!await confirmNewProject() || version !== state.loadVersion) return;
    await useSource(frozen, file.name, `${image.naturalWidth} × ${image.naturalHeight} 像素 · ${(file.size / 1024 / 1024).toFixed(2)} MB`, false);
    toast('图片已转成图纸，试着调整一下尺寸和配色吧。');
  } catch (error) {
    if (version === state.loadVersion) {
      // 过期解码失败不覆盖新任务的反馈，当前失败仍保留现有作品。
      imageError('无法读取这张图片，请换一张有效的图片后重试。', context);
    }
  } finally {
    // 图片已完成解码，释放临时URL；当前Image仍可作为画布源使用。
    if (url) URL.revokeObjectURL(url);
    if (version === state.loadVersion) {
      state.loading = false; $('uploadBtn').disabled = false;
      $('uploadBtn').querySelector('strong').textContent = '点击上传，或拖入图片';
      if (persistence.tracked && persistence.sequence !== persistence.savedSequence && !persistence.blocked) {
        // 文件选择期间未写入半成品，读取结束后继续保存最新完整作品。
        clearTimeout(persistence.timer);
        persistence.timer = setTimeout(saveProject, 800);
      }
    }
  }
}

/** 只开关计算状态，保留图纸供阅读，编辑入口按 generating 保护。 */
function setGenerationBusy(busy) {
  state.generating = busy;
  $('generationStatus').hidden = !busy;
  $('patternCanvas').setAttribute('aria-busy', String(busy));
}

/** 验证完整线程结果；色号、用量、索引及尺寸必须成套有效。 */
function validateGenerationResult(result, colors, maxColors) {
  if (!result || !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 128 || result.height > 128 || !Array.isArray(result.cells) || result.cells.length !== result.width * result.height || !Array.isArray(result.palette) || result.palette.length > maxColors) throw new Error('生成尺寸或配色无效');
  const counts = new Array(result.palette.length).fill(0), codes = new Set();
  for (const index of result.cells) {
    if (!Number.isInteger(index) || index < -1 || index >= counts.length) throw new Error('生成索引无效');
    if (index >= 0) counts[index]++;
  }
  for (let i = 0; i < result.palette.length; i++) {
    const color = result.palette[i], reference = colors.find(item => item.code === color.code);
    if (!reference || reference.hex !== color.hex || codes.has(color.code) || counts[i] !== color.count || !counts[i]) throw new Error('生成色号或用量无效');
    codes.add(color.code);
  }
}

/** 取消挂起与运行任务；默认恢复已应用参数和色卡，保留原图及编辑历史。 */
export function cancelPendingGeneration(restore = true) {
  generationSequence++;
  // 取消定时器与线程本身，防止取消后仍有一次晚到提交。
  clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
  cancelComputation();
  setGenerationBusy(false);
  if (restore && state.appliedParameters) {
    // 这里只恢复控件，不触发重新计算或保存。
    applyGenerationParameters(state.appliedParameters);
    updateCardLabel();
  }
}

/** 生成请求统一保护；参数、色卡及结果在最新请求成功后一次提交。 */
async function requestGeneration(parameters, card = state.card) {
  if (!state.source || persistence.blocked || state.generationPrompt || state.loading) return false;
  const previous = state.appliedParameters || readGenerationParameters();
  if (state.hasEdits) {
    // 提示期间恢复控件，不允许未确认参数被快照或落笔绕过。
    applyGenerationParameters(previous);
    state.generationPrompt = true;
    const confirmed = await confirmEditorAction('重新生成会清除当前手工修改和逐步历史。取消可保留当前图纸、色卡与参数。');
    state.generationPrompt = false;
    if (!confirmed) { updateCardLabel(); return false; }
  }
  const request = ++generationSequence, source = state.source, sourceId = state.sourceId;
  // 先显示计算状态，再启动真正的后台任务；期间仍可继续调参和取消。
  setGenerationBusy(true);
  try {
    const computed = await computePattern(source, parameters, card.colors);
    if (request !== generationSequence || state.source !== source || state.sourceId !== sourceId) return false;
    // 校验通过前不修改生效卡、参数、格子、自动基线和撤销历史。
    validateGenerationResult(computed.result, card.colors, parameters.maxColors);
    applyGenerationParameters(parameters);
    state.card = card; state.generationBackend = computed.backend;
    updateCardLabel();
    regenerate(computed.result);
    return true;
  } catch (error) {
    if (request !== generationSequence || error.name === 'AbortError') return false;
    // 当前任务失败才恢复界面；旧任务的错误不得覆盖最新请求。
    applyGenerationParameters(previous);
    updateCardLabel();
    console.error('图纸生成失败', error);
    toast('无法重新生成，当前图纸和参数已保留。请重试。', true);
    return false;
  } finally {
    if (request === generationSequence) setGenerationBusy(false);
  }
}

/** 切换色卡包含当前未提交参数，只建立一次最新请求。 */
export function requestCardChange(card) {
  clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
  generationPromise = requestGeneration(readGenerationParameters(), card);
  return generationPromise;
}

/** 高频调参使正在计算的结果立即失效，合并 65ms 后只计算最后一份参数。 */
export function scheduleRegenerate() {
  const parameters = readGenerationParameters();
  // 不恢复正在拖动的控件；仅取消旧任务和旧计时器。
  cancelPendingGeneration(false);
  if (state.loading) { if (state.appliedParameters) applyGenerationParameters(state.appliedParameters); return; }
  updateControls();
  if (state.hasEdits) { generationPromise = requestGeneration(parameters); return; }
  state.regenerateTimer = setTimeout(() => {
    state.regenerateTimer = null;
    generationPromise = requestGeneration(parameters);
  }, 65);
}

/** 立即提交待执行滑块，返回当前完整请求；旧同步调用仍能即时启动计算保护。 */
export function flushPending() {
  if (state.regenerateTimer !== null) {
    clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
    generationPromise = requestGeneration(readGenerationParameters());
  }
  return generationPromise;
}

/** 导出／保存等待最新完整请求，等待中又发生新调参则继续等待最后一份。 */
export async function waitForGeneration() {
  while (true) {
    // flushPending 同步建立请求，避免落在计时器空窗中导出旧参数。
    const current = flushPending();
    await current;
    if (current === generationPromise && state.regenerateTimer === null) return;
  }
}
