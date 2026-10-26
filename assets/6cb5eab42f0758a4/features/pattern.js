/**
 * 图像到图纸：取样帧、有限色集量化、杂点清理，以及换图 / 示例载入。
 */

import { $, P, canvas, env, persistence, state } from '../core/state.js';
import { renderPalette, updateControls, updateCardLabel } from '../features/panels.js';
import { confirmNewProject, markProjectChange, saveProject } from '../features/project.js';
import { cellAt, render } from '../features/renderer.js';
import { imageError, toast } from '../features/shell.js';
import { applySubjectMask, estimateBackground, fillLabs, floodBackground, planCrop, shallowBand, subjectBounds, WORK_LIMIT } from './subject.js';
import { setDirection } from '../features/view.js';

import { confirmEditorAction, resetEditorSession } from './editor.js';
import { resetSourcePreview } from './source-preview.js';

// 主体识别的工作帧与背景估计按源图缓存：容差、留白变化只重跑泛洪，不重复读几百万像素。
const subjectCache = new WeakMap();

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

/** 返回按源图比例缩放的网格；最长边不超过用户设置，另一边至少一格。 */
export function patternSize(source, longest) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const ratio = longest / Math.max(width, height);
  return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
}

/**
 * 把原图（或主体裁剪矩形）压成每格最多 4×4 样本的取样帧：按 1024 像素切片 1:1 读回，缩放全由本页求和完成。
 * drawImage 的重采样核由各家浏览器自行决定，桌面与手机会得到不同像素，这里不再借用它。
 * rect 表示只取样主体所在的源图区域，坐标映射与整图路径完全一致，导出与坐标换算不受影响。
 */
export function samplingFrame(source, width, height, rect = null) {
  const rx = rect ? rect.x : 0, ry = rect ? rect.y : 0;
  const sw = rect ? rect.width : source.naturalWidth || source.width;
  const sh = rect ? rect.height : source.naturalHeight || source.height;
  const bw = Math.min(sw, Math.max(1, width * 4)), bh = Math.min(sh, Math.max(1, height * 4));
  const acc = new Float64Array(bw * bh * 4), weight = new Uint32Array(bw * bh);
  // 源像素落在哪个取样格，预先算成查表；否则几百万像素的内层循环每步都要做一次除法。
  const column = new Int32Array(sw), rowOrigin = new Int32Array(sh);
  for (let x = 0; x < sw; x++) column[x] = Math.floor(x * bw / sw);
  for (let y = 0; y < sh; y++) rowOrigin[y] = Math.floor(y * bh / sh) * bw;
  const tile = document.createElement('canvas');
  const context = tile.getContext('2d', { willReadFrequently: true });
  const size = 1024;
  for (let ty = 0; ty < sh; ty += size) {
    for (let tx = 0; tx < sw; tx += size) {
      const w = Math.min(size, sw - tx), h = Math.min(size, sh - ty);
        // 切片按原始像素 1:1 绘制，不触发重采样；重设尺寸同时清空上一片。
        tile.width = w; tile.height = h;
        context.drawImage(source, tx + rx, ty + ry, w, h, 0, 0, w, h);
      const data = context.getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y++) {
        const line = rowOrigin[ty + y], data8 = y * w;
        for (let x = 0; x < w; x++) {
          const bin = line + column[tx + x], target = bin * 4, from = (data8 + x) * 4;
          acc[target] += data[from]; acc[target + 1] += data[from + 1];
          acc[target + 2] += data[from + 2]; acc[target + 3] += data[from + 3];
          weight[bin]++;
        }
      }
    }
  }
  const frame = new Uint8ClampedArray(bw * bh * 4);
  for (let bin = 0; bin < weight.length; bin++) {
    const count = weight[bin], target = bin * 4;
    // 缩得比源图还密的格子没有样本，保持透明，不能被当成白色前景。
    if (!count) continue;
    for (let channel = 0; channel < 4; channel++) frame[target + channel] = Math.round(acc[target + channel] / count);
  }
  return { data: frame, width: bw, height: bh };
}

/** 读取一份生成参数；已应用值与待确认值分开，快照不会保存半次滑动。 */
export function readGenerationParameters() {
  return {
    longest: Math.max(16, Math.min(128, Number($('sizeRange').value) || 32)),
    maxColors: Math.max(4, Math.min(32, Number($('colorRange').value) || 16)),
    denoise: $('denoiseCheck').checked,
    dither: Math.max(0, Math.min(100, Number($('ditherRange').value) || 0)),
    background: { remove: $('bgCheck').checked, tolerance: Number($('bgTolerance').value) || 12, margin: Number($('bgMargin').value) || 0 }
  };
}

/** 恢复已应用控件或一次完整的新参数；不派发input，防止确认/取消再次触发重算。 */
export function applyGenerationParameters(parameters) {
  $('sizeRange').value = parameters.longest; $('colorRange').value = parameters.maxColors;
  $('denoiseCheck').checked = parameters.denoise !== false; $('ditherRange').value = parameters.dither || 0;
  $('bgCheck').checked = parameters.background?.remove !== false;
  $('bgTolerance').value = parameters.background?.tolerance ?? 12; $('bgMargin').value = parameters.background?.margin ?? 2;
  updateControls();
}

/**
 * 主体识别计划：在工作帧上估计背景、泛洪、量边界，再换算成源图裁剪矩形与网格尺寸。
 * 任何一步不可靠（自带透明、没有成片背景、主体过小）都返回 null，调用方退回整图路径。
 */
function planSubject(source, settings) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  let cache = subjectCache.get(source);
  if (!cache) {
    // 工作帧最长边约 512 像素；samplingFrame 的帧尺寸是网格的 4 倍，按比例反推网格。
    const ratio = Math.min(1, WORK_LIMIT / Math.max(sw, sh));
    const frame = samplingFrame(source, Math.max(1, Math.round(sw * ratio / 4)), Math.max(1, Math.round(sh * ratio / 4)));
    const bg = estimateBackground(frame);
    const labs = new Float32Array(frame.width * frame.height * 3);
    fillLabs(frame, labs);
    cache = { frame, bg, labs };
    subjectCache.set(source, cache);
  }
  // 图片自带透明通道时，空白格本来就存在；不重复识别，行为与旧版完全一致。
  if (!cache.bg.opaque) return null;
  const flood = floodBackground(cache.frame, cache.bg, settings.tolerance, cache.labs);
  if (flood.count < cache.frame.width * cache.frame.height * .02) return null;
  const bounds = subjectBounds(cache.frame, flood.mask);
  if (!bounds) return null;
  // 帧坐标换成源像素：向下取整起点、向上取整边长，宁多留一格也不切掉主体。
  const boundsPx = {
    x: Math.max(0, Math.floor(bounds.x * sw / cache.frame.width)),
    y: Math.max(0, Math.floor(bounds.y * sh / cache.frame.height)),
    width: Math.ceil(bounds.width * sw / cache.frame.width),
    height: Math.ceil(bounds.height * sh / cache.frame.height)
  };
  boundsPx.width = Math.min(sw - boundsPx.x, boundsPx.width);
  boundsPx.height = Math.min(sh - boundsPx.y, boundsPx.height);
  return { bg: cache.bg, ...planCrop(boundsPx, settings.longest, settings.margin, sw, sh) };
}

/**
 * 从固定 source 帧计算图纸；格数、色数、背景清理与杂点清理都直接读界面控件。
 * 取样帧由 samplingFrame 自算，同一张图在任何浏览器上都得到同一份格子。
 * 返回完整量化结果、尺寸与背景清理信息；不修改当前作品，换图失败时旧状态和成功记录仍然有效。
 */
export function calculatePattern(source, parameters = readGenerationParameters(), colors = state.card.colors) {
  // 沿用现有格数、色数上限；背景清理不改变保存格式，只影响取样范围与空白格。
  const longest = parameters.longest, colorLimit = parameters.maxColors;
  // 渐变过渡（抖动）强度 0~100% → 0~1；默认关闭，行为与旧版一致。
  const dither = parameters.dither / 100;
  const settings = { longest, remove: parameters.background.remove, tolerance: parameters.background.tolerance, margin: parameters.background.margin };
  // 先识别主体、确定留白裁剪，再在裁剪后的取样帧上按同一容差泛洪写透明。
  let plan = settings.remove ? planSubject(source, settings) : null;
  let width = 0, height = 0, frame = null, removed = 0, shallow = null;
  if (plan) {
    width = plan.width; height = plan.height;
    frame = samplingFrame(source, width, height, plan.rect);
    const flood = floodBackground(frame, plan.bg, settings.tolerance);
    removed = applySubjectMask(frame, flood.mask);
    // 裁剪后的边框上找不到背景（留白被原图边界顶满、容差在细分辨率下失配），退回整图。
    if (removed < .02) plan = frame = null;
    // 贴边混色残带只占覆盖率不配色：轮廓豆色取自主体本体，纯残带格子留空。
    else shallow = shallowBand(frame, flood);
  }
  if (!plan) [width, height] = patternSize(source, longest);
  // 覆盖率决定留空，取样器自动保留明确像素结构，无需用户选择模式。
  if (!frame) frame = samplingFrame(source, width, height);
  const pixels = P.sample(frame, width, height, shallow);
  // 在真实色卡上优化有限色集；结果生成成功后，调用方才替换当前作品。
  const result = P.quantize(pixels, colorLimit, colors, dither, width, height);
  const background = plan ? { rect: plan.rect, removed } : null;
  // 抖动点是主动生成的过渡色，后续清理会把它们当杂点抹掉；开启时保留，关闭后沿用清理偏好。
  if (dither > 0 || !parameters.denoise) return { ...result, width, height, background };
  // 无抖动时才按图纸密度清理抗锯齿混色与柔和阴影留下的孤格。
  const cleaned = P.refine(result, width, height, Math.min(2, Math.floor(Math.max(width, height) / 40) + 1));
  return { ...cleaned, width, height, background };
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
export function useSource(source, name, meta, demo) {
  // 完成新图的解码与量化后才提交页面状态，失败继续展示原作品。
  const result = calculatePattern(source);
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
    useSource(frozen, file.name, `${image.naturalWidth} × ${image.naturalHeight} 像素 · ${(file.size / 1024 / 1024).toFixed(2)} MB`, false);
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

/** 生成请求统一保护：参数/色卡仅在计算成功后一起提交，取消恢复当前已应用值。 */
async function requestGeneration(parameters, card = state.card) {
  if (!state.source || persistence.blocked || state.generationPrompt) return false;
  const previous = state.appliedParameters || readGenerationParameters();
  if (state.hasEdits) {
    applyGenerationParameters(previous);
    state.generationPrompt = true;
    const confirmed = await confirmEditorAction('重新生成会清除当前手工修改和逐步历史。取消可保留当前图纸、色卡与参数。');
    state.generationPrompt = false;
    if (!confirmed) return false;
  }
  try {
    // 使用参数/色卡副本计算；失败不能先改生效色卡或清空编辑历史。
    const result = calculatePattern(state.source, parameters, card.colors);
    applyGenerationParameters(parameters);
    state.card = card;
    updateCardLabel();
    regenerate(result);
    return true;
  } catch (error) {
    applyGenerationParameters(previous);
    toast('无法重新生成，当前手工图纸和参数已保留。', true);
    return false;
  }
}

/** 应用完整校验后的色卡；保持导入弹窗的旧调用入口，新增重生成前保护。 */
export function requestCardChange(card) {
  flushPending();
  return requestGeneration(readGenerationParameters(), card);
}

/** 合并高频拖动；已有手改时立即恢复旧控件并等待一次确认，不留可被保存绕过的定时任务。 */
export function scheduleRegenerate() {
  const parameters = readGenerationParameters();
  clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
  if (state.hasEdits) { requestGeneration(parameters); return; }
  updateControls();
  state.regenerateTimer = setTimeout(() => {
    state.regenerateTimer = null;
    requestGeneration(parameters);
  }, 65);
}

/** 导出/保存/落笔前提交未执行的正常参数；手改确认期间没有挂起任务可绕过保护。 */
export function flushPending() {
  if (state.regenerateTimer !== null) {
    clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
    requestGeneration(readGenerationParameters());
  }
}
