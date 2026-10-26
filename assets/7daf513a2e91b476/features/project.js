/**
 * 作品存档：快照结构、串行写入、版本冲突保护，以及启动时的一次性恢复。
 */

import { $, canvas, persistence, state } from '../core/state.js';
import { renderPalette, updateCardLabel, updateControls } from '../features/panels.js';
import { createDemo, flushPending, readGenerationParameters, updateSourceThumbnail, useSource } from '../features/pattern.js';
import { render } from '../features/renderer.js';
import { setMode, toast } from '../features/shell.js';
import { resetEditorSession } from './editor.js';
import { maxZoom, readingCenter, restoreReadingView, setDirection } from '../features/view.js';

/** 更新内部保存状态；日常保存及暂时失败不打扰，仅显示必须处理的恢复、版本或并发保护。 */
export function saveStatus(kind, message) {
  $('saveStatus').textContent = message;
  $('saveStatus').dataset.state = kind;
  // 状态仍供保存链跟踪；隐藏日常通知及其重试入口，关键保护状态保留可见操作。
  $('saveBox').hidden = !['recovery', 'newer', 'conflict'].includes(kind);
  $('retrySaveBtn').hidden = kind !== 'failed' && kind !== 'unavailable';
  $('retryRestoreBtn').hidden = kind !== 'recovery' && kind !== 'newer';
  $('newProjectBtn').hidden = kind !== 'recovery';
  $('reloadProjectBtn').hidden = kind !== 'conflict';
}

/** 显示实际提交时间；只在存储事务完成或成功恢复一份已保存记录后使用。 */
export function savedMessage(time) {
  return `已保存到此设备 · ${new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

/** 标记一轮修改；纯浏览启动示例不建记录，已有作品的阅读变化合并为800ms一次保存。 */
export function markProjectChange(edit = false) {
  if (!persistence.ready || (state.originalPreview && !edit)) return;
  if (edit) persistence.tracked = true;
  if (!persistence.tracked || persistence.blocked) return;
  persistence.sequence++;
  // 一有新修改即撤下旧成功状态，避免用户误以为当前结果已经写入。
  saveStatus('pending', '有修改待保存');
  clearTimeout(persistence.timer);
  persistence.timer = setTimeout(saveProject, 800);
}

/** 获取源图的固定PNG帧；同一原图的平移、缩放和换色复用同一个编码 Promise。 */
export function sourcePacket() {
  if (persistence.sourceCache?.id === state.sourceId) return persistence.sourceCache.promise;
  const source = state.source, id = state.sourceId;
  const promise = new Promise((resolve, reject) => source.toBlob(blob => {
    if (!blob) { reject(new Error('原图编码失败。')); return; }
    resolve({ id, blob, width: source.width, height: source.height });
  }, 'image/png'));
  persistence.sourceCache = { id, promise };
  // 编码失败可重试；成功的 Blob 留到换图，不在阅读操作时重复编码。
  promise.catch(() => { if (persistence.sourceCache?.id === id) persistence.sourceCache = null; });
  return promise;
}

/** 形成同一计算结果的结构化快照；草稿、临时URL、弹窗和主题不属于作品。 */
export function projectSnapshot() {
  const result = value => ({ palette: value.palette.map(c => ({ code: c.code, count: c.count })), cells: value.cells.slice() });
  return {
    sourceId: state.sourceId, fileName: $('fileName').textContent, fileMeta: $('fileMeta').textContent, demo: state.demo,
    card: { id: state.card.id, version: state.card.version, source: state.card.source, license: state.card.license, name: state.card.name, builtin: !!state.card.builtin, colors: state.card.colors.map(({ code, hex, name }) => ({ code, hex, name })) },
    parameters: state.appliedParameters || readGenerationParameters(),
    editor: { colorCode: state.currentColorCode },
    pattern: { ...result(state), width: state.width, height: state.height, hasEdits: state.hasEdits, autoResult: result(state.autoResult),
      // 裁剪矩形只在识别到主体时存在；旧版校验会拒绝带裁剪的记录，提示更新工具而非静默出错。
      ...(state.background ? { crop: { ...state.background.rect } } : {}) },
    display: { mirrored: state.mirrored, grid: $('gridCheck').checked, guides: $('guideCheck').checked, codes: $('codeCheck').checked, beads: $('beadCheck').checked },
    reading: { mode: state.mode, zoom: state.zoom, center: readingCenter(), activeCell: state.activeCell ? { ...state.activeCell } : null,
      selectedCode: state.selected === null ? null : state.palette[state.selected].code }
  };
}

/** 串行保存最新完整作品；异步编码过期则重新取快照，冲突时暂停而不覆盖其他页面。 */
export async function saveProject() {
  clearTimeout(persistence.timer);
  if (!persistence.ready || !persistence.tracked || persistence.blocked || persistence.writing || state.loading) return;
  // 先启动挂起生成，但保存只取已应用参数；等待计算或确认期间也不能丢失上一次完整手改。
  flushPending();
  if (persistence.writing || state.loading || persistence.blocked) return;
  persistence.writing = true;
  const sequence = persistence.sequence;
  try {
    // 初次读库失败不能假定库为空；恢复连接后先确认没有旧作品需要保护。
    if (!persistence.initialRead) {
      const found = await BeadProjectStore.read();
      if (found.record !== undefined) throw Object.assign(new Error('此浏览器已有作品，请重新载入后继续。'), { code: 'conflict' });
      persistence.token = found.token; persistence.initialRead = true;
    }
    const snapshot = projectSnapshot();
    // 只对换图后的源帧编码；普通阅读写入不携带图片Blob。
    const source = persistence.sourceSavedId === snapshot.sourceId ? null : await sourcePacket();
    if (sequence !== persistence.sequence || state.loading) return;
    saveStatus('saving', '正在保存…');
    // 最新修订比较和原图/快照写入都在同一个事务里执行。
    const saved = await BeadProjectStore.write(snapshot, source, persistence.token);
    persistence.token = saved.token; persistence.savedAt = saved.savedAt;
    persistence.recordPresent = true; persistence.sourceSavedId = snapshot.sourceId;
    persistence.savedSequence = sequence;
    // 写入期间仍可操作，只有快照确实是当前版本才显示已保存。
    saveStatus(sequence === persistence.sequence ? 'saved' : 'pending', sequence === persistence.sequence ? savedMessage(saved.savedAt) : '有修改待保存');
  } catch (error) {
    if (error.code === 'conflict') {
      persistence.blocked = 'conflict';
      saveStatus('conflict', '作品已在另一个页面更新，请重新载入后继续；本页仍可导出。');
    } else saveStatus('failed', '未能保存到此设备，本次修改仅保留在当前页面。');
  } finally {
    persistence.writing = false;
    // 写入过程中积累的新修改继续保存；失败等待用户重试，不陷入自动写入循环。
    if (!persistence.blocked && persistence.sequence !== sequence) {
      clearTimeout(persistence.timer);
      persistence.timer = setTimeout(saveProject, 800);
    }
  }
}

/** 最近作品可能被替换时先明确提示；新版本和并发冲突记录禁止旧页面强行覆盖。 */
export async function confirmNewProject() {
  if (persistence.blocked === 'conflict' || persistence.blocked === 'newer') {
    // 保留数据并让现有作品继续导出，不能将新建动作当成跨版本覆盖许可。
    toast('请先重新载入，或使用能够读取该作品的更新版本。', true);
    return false;
  }
  if (!persistence.recordPresent && !persistence.tracked) return true;
  const dialog = $('newProjectDialog');
  dialog.querySelector('p').textContent = state.hasEdits ? '开始新作品会替换当前手工图纸和逐步历史。取消可保留；新图生成并保存成功前，旧记录会保留。' : '开始新作品会替换此浏览器保存的上一件作品。新图生成并保存成功前，旧记录会保留。';
  if (dialog.open) return false;
  // 设置内开始新作品时叠加确认，确认或取消均返回原设置，不提前退出其上下文。
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'continue'), { once: true });
    dialog.showModal();
  });
}

/** 只在完整校验、源帧解码成功后应用记录；不重新采样，保留手动色号合并与自动基线。 */
export async function restoreProject() {
  persistence.ready = false;
  clearTimeout(persistence.timer);
  $('projectLoading').hidden = false;
  document.querySelector('main').inert = true;
  document.querySelector('header').inert = true;
  try {
    const stored = await BeadProjectStore.read();
    persistence.initialRead = true; persistence.token = stored.token;
    persistence.recordPresent = stored.record !== undefined;
    if (stored.record === undefined) {
      persistence.tracked = false; persistence.blocked = null;
      persistence.sequence = persistence.savedSequence = 0;
      persistence.sourceSavedId = null;
      await useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
      saveStatus('example', '修改后自动保存作品');
      return;
    }
    // 格子、编号、数量、参数、版本及阅读位置全部通过校验后才解码源图。
    const checked = BeadProjectStore.validate(stored.record, stored.source);
    const url = URL.createObjectURL(stored.source.blob);
    const image = new Image();
    let source;
    try {
      image.src = url;
      await image.decode();
      if (image.naturalWidth !== stored.source.width || image.naturalHeight !== stored.source.height) throw new Error('原图尺寸不一致。');
      source = document.createElement('canvas'); source.width = image.naturalWidth; source.height = image.naturalHeight;
      source.getContext('2d').drawImage(image, 0, 0);
    } finally { URL.revokeObjectURL(url); }
    const record = stored.record;
    Object.assign(state, checked.current, { source, sourceId: record.sourceId, demo: record.demo,
      name: record.fileName.replace(/\.[^.]+$/, '') || '我的拼豆作品', width: record.pattern.width, height: record.pattern.height,
      card: checked.card, autoResult: checked.automatic, hasEdits: record.pattern.hasEdits, background: null,
      activeCell: record.reading.activeCell, zoom: Math.min(maxZoom(), record.reading.zoom),
      selected: record.reading.selectedCode === null ? null : checked.current.palette.findIndex(c => c.code === record.reading.selectedCode) });
    $('sizeRange').value = record.parameters.longest; $('colorRange').value = record.parameters.maxColors;
    // 旧作品没有杂点清理字段，按默认开启恢复，不当作损坏记录。
    $('denoiseCheck').checked = record.parameters.denoise !== false;
    // 旧记录没有抖动字段，默认关闭；范围校验交给 project-store，这里只做防御性收敛。
    $('ditherMode').value = record.parameters.ditherMode || 'fs';
    $('ditherRange').value = Number.isFinite(record.parameters.dither) ? Math.min(100, Math.max(0, Math.round(record.parameters.dither))) : 0;
    // 旧作品没有背景清理字段，按默认开启恢复；有裁剪矩形时一并还原，保证下次保存的快照稳定。
    const background = record.parameters.background;
    $('bgCheck').checked = background?.remove !== false;
    $('bgTolerance').value = Number.isFinite(background?.tolerance) ? Math.min(40, Math.max(4, Math.round(background.tolerance))) : 12;
    $('bgMargin').value = Number.isInteger(background?.margin) ? Math.min(10, Math.max(0, background.margin)) : 2;
    if (record.pattern.crop) state.background = { rect: { ...record.pattern.crop }, removed: null };
    for (const [id, key] of [['gridCheck', 'grid'], ['codeCheck', 'codes'], ['beadCheck', 'beads']]) $(id).checked = record.display[key];
    // 旧作品没有辅助线字段，按默认开启恢复，不当作损坏记录。
    $('guideCheck').checked = record.display.guides !== false;
    $('fileName').textContent = record.fileName; $('fileMeta').textContent = record.fileMeta;
    $('mobileSourceAction').textContent = record.demo ? '上传图片' : '更换图片';
    // 缩略图继续使用小图，完整透明帧保留在Canvas和IndexedDB中。
    // 老格式可能把无变化的换色标成手改；新格式保存前以实际格子/留空差异为准。
    state.hasEdits = state.cells.some((index, cell) => (index < 0 ? null : state.palette[index].code) !== (state.autoResult.cells[cell] < 0 ? null : state.autoResult.palette[state.autoResult.cells[cell]].code));
    state.appliedParameters = readGenerationParameters();
    state.currentColorCode = record.editor?.colorCode || checked.current.palette[0]?.code || checked.card.colors[0].code;
    resetEditorSession();
    updateSourceThumbnail();
    updateCardLabel();
    setDirection(record.display.mirrored);
    state.activeCell = record.reading.activeCell;
    setMode(record.reading.mode);
    updateControls(); renderPalette(); render();
    // 当前屏幕先适配缩放，再使最近定位格尽可能落在视口内。
    await restoreReadingView(record.reading.center, true);
    persistence.tracked = true; persistence.blocked = null;
    persistence.sequence = persistence.savedSequence = 0;
    persistence.sourceSavedId = record.sourceId; persistence.savedAt = record.savedAt;
    saveStatus('saved', savedMessage(record.savedAt));
    // 成功恢复直接呈现作品，不额外弹出自动保存相关通知。
  } catch (error) {
    // 失败时仅在页面展示示例；保留原始记录与比较标识，直到明确开始新作品。
    await useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
    persistence.tracked = false;
    if (persistence.initialRead && persistence.recordPresent) {
      persistence.blocked = error.code === 'newer' ? 'newer' : 'recovery';
      saveStatus(persistence.blocked, error.code === 'newer' ? error.message : '未能恢复上次作品，原记录已保留。可重试恢复或开始新作品。');
    } else saveStatus('unavailable', '此浏览器暂时无法保存作品，本页仍可使用。');
  } finally {
    persistence.ready = true;
    $('projectLoading').hidden = true;
    document.querySelector('main').inert = false;
    document.querySelector('header').inert = false;
  }
}
