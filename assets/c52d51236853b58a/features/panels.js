/**
 * 面板与清单：用量统计、豆子清单、改色弹窗与色卡标签。
 */

import { $, P, persistence, state } from '../core/state.js';
import { flushPending, requestCardChange } from '../features/pattern.js';
import { markProjectChange } from '../features/project.js';
import { toast } from '../features/shell.js';
import { updateHighlight } from '../features/view.js';
import { commitEditorCodes, editorCodes, previewEditorRegion, refreshEditor, restoreEditorAutomatic } from './editor.js';

/** 更新图纸尺寸、用量总计及控件状态；5毫米仅用于成品尺寸估算。 */
export function updateControls() {
  $('sizeValue').textContent = `${state.width} × ${state.height}`;
  $('patternMeta').textContent = `${state.width} × ${state.height} 格`;
  $('longestValue').textContent = $('sizeRange').value;
  $('colorsValue').textContent = $('colorRange').value;
  // 暂停清理只影响本次生成，不改 checked；关闭抖动后恢复用户原来的清理偏好。
  const dithering = Number($('ditherRange').value) > 0;
  $('ditherMode').disabled = Number($('ditherRange').value) === 0;
  $('ditherValue').textContent = dithering ? `${$('ditherRange').value}%` : '关闭';
  $('denoiseCheck').disabled = dithering;
  $('denoiseNote').textContent = dithering
    ? '渐变过渡已开启，暂不清理杂点，避免抹掉过渡色；关闭渐变后恢复此设置。'
    : '修掉孤立的单格和零碎小色块，轮廓更贴人物边缘；关闭可保留逐格原始识别结果。';
  $('totalBeads').textContent = state.palette.reduce((sum, color) => sum + color.count, 0).toLocaleString('zh-CN');
  // 按需要备豆的色号计数；相同色号已合并，不把不同编号的同色材料混为一项。
  $('totalColors').textContent = state.palette.length;
  $('mobileBeadSummary').textContent = `${$('totalBeads').textContent} 颗 · ${state.palette.length} 色`;
  $('dimensions').textContent = `${state.width / 2} × ${state.height / 2} cm`;
  $('demoTag').hidden = !state.demo;
  // 背景清理摘要：识别到主体时显示留白，其余情况说明当前为什么没有裁剪。
  $('bgValue').textContent = state.background ? `留白 ${$('bgMargin').value} 格`
    : $('bgCheck').checked ? '未识别到背景' : '已关闭';
  for (const range of [$('sizeRange'), $('colorRange'), $('bgTolerance'), $('bgMargin'), $('ditherRange')]) {
    const value = ((Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
    range.style.setProperty('--fill', `${value}%`);
  }
  document.querySelectorAll('[data-size]').forEach(button => button.classList.toggle('active', button.dataset.size === $('sizeRange').value));
}

/** 返回清单展示项：字母前缀分组，组内用量降序，同量按自然色号排序；保留原索引供找色和改色使用。 */
export function paletteListEntries() {
  const order = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  // 只排序副本，不能重排state.palette，否则已生成格子、选色及保存记录的索引会错位。
  return state.palette.map((color, index) => ({ color, index, group: color.code.match(/^[\p{L}]+/u)?.[0] || '' }))
    .sort((a, b) => order.compare(a.group, b.group) || b.color.count - a.color.count || order.compare(a.color.code, b.color.code));
}

/** 为每种实际使用的颜色构建用量行；文本使用textContent，文件名也不作为HTML插入。 */
export function renderPalette(repaint = true) {
  $('paletteList').replaceChildren();
  // 清单按色号分组展示；事件继续绑定量化结果里的原始索引，不以行号代替颜色索引。
  for (const { color, index } of paletteListEntries()) {
    const item = document.createElement('div'); item.className = 'color-item';
    const button = document.createElement('button');
    button.className = 'color-row'; button.dataset.colorIndex = index;
    button.setAttribute('aria-label', `${color.code} ${color.hex}，${color.count}颗，点击高亮`);
    button.setAttribute('aria-pressed', 'false');
    const chip = document.createElement('span'); chip.className = 'color-chip'; chip.style.background = color.hex;
    const detail = document.createElement('span'); detail.className = 'color-detail';
    const code = document.createElement('strong'); code.textContent = color.code;
    const hex = document.createElement('small'); hex.textContent = color.hex;
    const count = document.createElement('span'); count.className = 'color-count'; count.textContent = color.count.toLocaleString('zh-CN');
    detail.append(code, hex); button.append(chip, detail, count);
    button.addEventListener('click', () => {
      state.selected = state.selected === index ? null : index;
      // 屏幕找色使用同一索引；拼豆收起清单后也保持高亮，并保存当前阅读状态。
      updateHighlight();
      markProjectChange();
    });
    // 改色和高亮使用独立按钮，避免点击改色时误切换高亮，也避免嵌套交互元素。
    const edit = document.createElement('button');
    edit.className = 'color-edit'; edit.dataset.colorIndex = index; edit.textContent = '改色';
    edit.setAttribute('aria-label', `替换 ${color.code} 色号`);
    edit.addEventListener('click', () => openColorEditor(index));
    item.append(button, edit);
    $('paletteList').append(item);
  }
  // 恢复入口归入修图菜单；没有手改时保留说明位置，但不允许执行空操作。
  $('resetColorsBtn').disabled = !state.hasEdits;
  // 常用色仍引用同一配色索引；它只提供找色入口，完整编号与改色继续在清单内操作。
  renderPalettePeek();
  // 批量生成由调用方统一绘图；清单点击回调仍使用默认即时重绘。
  updateHighlight(repaint);
}

/** 手机主图下展示用量最多的前四色，按清单分组规则排列；点击保留原配色索引及阅读保存规则。 */
export function renderPalettePeek() {
  $('mobileColorPeek').replaceChildren();
  // 原配色按用量降序排列；先保留原索引前四种，再沿用完整清单的展示顺序，避免改变快捷色集合或点击映射。
  paletteListEntries().filter(({ index }) => index < 4).forEach(({ color, index }) => {
    const button = document.createElement('button');
    button.className = 'palette-peek-color'; button.dataset.colorIndex = index;
    button.setAttribute('aria-label', `${color.code}，${color.count}颗，点击找色`);
    button.title = `${color.code} ${color.hex}`;
    const chip = document.createElement('i'); chip.style.backgroundColor = color.hex; chip.setAttribute('aria-hidden', 'true');
    const code = document.createElement('strong'); code.textContent = color.code;
    const count = document.createElement('span'); count.textContent = color.count.toLocaleString('zh-CN');
    button.append(chip, code, count);
    button.addEventListener('click', () => {
      state.selected = state.selected === index ? null : index;
      // 快捷预览与完整清单共用同一选色，不修改图纸数据或画布几何。
      updateHighlight();
      // 已有作品继续保存选中色号，纯示例仍不制造作品记录。
      markProjectChange();
    });
    $('mobileColorPeek').append(button);
  });
}

/** 复用真实色卡选择与替换草稿；purpose区分绘制选色、旧全图入口和区域预览。 */
export function openColorEditor(index, cell = null, purpose = 'replace') {
  if (state.mode === 'beading' || (state.originalPreview || state.previewMode === 'beads') || persistence.blocked) return;
  if (state.loading) { toast('图片正在读取，请稍后再修改颜色。'); return; }
  flushPending();
  // 后台结果尚未提交，不能对即将替换的格子创建编辑事务。
  if (state.generating) return;
  const color = purpose === 'choose' ? state.card.colors.find(c => c.code === state.currentColorCode) || state.card.colors[0] : state.palette[index];
  if (!color) return;
  state.colorContext = { purpose, seed: cell ? cell.y * state.width + (state.mirrored ? state.width - 1 - cell.x : cell.x) : null };
  $('colorScopeRow').hidden = purpose === 'choose';
  $('colorScope').value = purpose === 'region' ? 'connected' : 'all';
  for (const option of $('colorScope').options) option.disabled = option.value !== 'all' && !cell;
  state.editingColor = index;
  state.draftColor = state.card.colors.find(c => c.code === color.code);
  $('colorDialogTitle').textContent = purpose === 'choose' ? '选择绘制色号' : `替换 ${color.code}`;
  document.querySelector('#colorForm button[type=submit]').textContent = purpose === 'choose' ? '选择此色号' : purpose === 'region' ? '预览替换' : '保存颜色';
  const position = cell ? `第 ${cell.y + 1} 行，第 ${cell.x + 1} 列 · ${color.code} · ${color.hex}\n` : '';
  $('colorTargetSummary').textContent = purpose === 'choose' ? `${state.card.name} · 仅选择绘制色号，不修改图纸。` : `${position}${state.card.name} · 当前全图 ${color.count} 颗 ${color.code}，按下方范围替换。`;
  $('colorAutoPreview').style.backgroundColor = color.hex;
  $('colorAutoHex').textContent = color.code + ' ' + color.hex;
  $('colorSearch').value = '';
  setColorDraft(color.hex, color.code);
  $('colorDialog').showModal();
}

/** 用输入颜色寻找当前色卡的最近色；草稿只采用色卡已有的编号和参考色。 */
export function setColorDraft(hex, preferredCode = null) {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  // 相同RGB的不同材料编号不能在打开弹窗时被近似匹配悄悄合并；用户输入新HEX才重新找近似色。
  state.draftColor = state.card.colors.find(color => color.code === preferredCode && color.hex === hex) || P.nearest(rgb, state.card.colors);
  $('colorPicker').value = hex;
  $('colorHex').value = hex;
  $('colorHex').removeAttribute('aria-invalid');
  $('colorError').hidden = true;
  renderColorChoices(rgb);
}

/** 展示可搜索色卡；输入 HEX 时按感知距离排序，选中态明确标出将保存的真实色号。 */
export function renderColorChoices(rgb = null) {
  const query = $('colorSearch').value.trim().toLowerCase();
  const choices = state.card.colors.filter(c => !query || c.code.toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
  if (rgb) {
    const lab = P.toLab(rgb);
    choices.sort((a, b) => P.ciede2000(lab, a.lab) - P.ciede2000(lab, b.lab));
  }
  $('colorChoices').replaceChildren();
  for (const color of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'card-choice';
    button.dataset.code = color.code; button.setAttribute('aria-pressed', String(state.draftColor?.code === color.code));
    const chip = document.createElement('span'); chip.style.background = color.hex;
    const label = document.createElement('strong'); label.textContent = color.code;
    button.append(chip, label); button.title = `${color.code} ${color.hex}`;
    button.addEventListener('click', () => {
      state.draftColor = color;
      $('colorHex').value = color.hex; $('colorPicker').value = color.hex;
      $('colorHex').removeAttribute('aria-invalid'); $('colorError').hidden = true;
      renderColorChoices();
    });
    $('colorChoices').append(button);
  }
  if (!choices.length) $('colorChoices').textContent = '没有找到该色号，请换个关键词。';
  const draft = state.draftColor;
  $('colorDraftPreview').style.backgroundColor = draft.hex;
  $('colorDraftHex').textContent = draft.code + ' ' + draft.hex;
}

/** 保存选中的色卡条目；若目标编号已经使用，合并用量和格子索引，避免重复备豆。 */
export function saveColor(event) {
  event.preventDefault();
  if (!P.normalizeHex($('colorHex').value)) {
    $('colorError').textContent = '请输入有效 HEX，例如 #AABBCC，或直接选择下方色号。';
    $('colorError').hidden = false; $('colorHex').setAttribute('aria-invalid', 'true'); return;
  }
  const index = state.editingColor, replacement = state.draftColor;
  if (!replacement) return;
  // 统一色号选择只更新绘制色，不改格子或保存记录。
  if (state.colorContext?.purpose === 'choose') {
    state.currentColorCode = replacement.code;
    refreshEditor();
    $('colorDialog').close();
    return;
  }
  if (!state.palette[index]) return;
  const sourceCode = state.palette[index].code, scope = $('colorScope').value;
  // 新工具的局部范围先在图纸预览，旧全图入口继续在明确的弹窗确认后一次应用。
  if (state.colorContext?.purpose === 'region' || scope !== 'all') {
    const seed = state.colorContext.seed;
    $('colorDialog').close();
    if (seed !== null) previewEditorRegion(seed, replacement.code, scope, '区域换色');
    return;
  }
  const codes = editorCodes().map(code => code === sourceCode ? replacement.code : code);
  const changed = commitEditorCodes(codes, '全图换色');
  $('colorDialog').close();
  toast(changed ? `已替换为 ${replacement.code}，相同色号用量已合并。` : '图纸无需替换，格子保持不变。');
}

/** 一并恢复自动配色和分组，包括之前被手动合并的格子。 */
export function resetCustomColors() {
  // 恢复自动格子属于可撤销事务，不能清掉手改历史或再次识别原图。
  return restoreEditorAutomatic();
}

/** 切换色卡后重新匹配原图，避免把旧卡编号配到新卡颜色上。 */
export function applyCard(card) {
  // 计算成功后才切换生效色卡；有手改时先取得重新生成确认。
  return requestCardChange(card);
}

/** 展示当前生效色卡的真实名称、数量和恢复入口。 */
export function updateCardLabel() {
  $('activeCardName').textContent = state.card.name;
  $('activeCardCount').textContent = `${state.card.colors.length} 色 · ` + (state.card.builtin ? '内置参考色卡' : '自定义色卡');
  $('defaultCardBtn').hidden = state.card.builtin && (!state.card.id || state.card.id === 'mard221');
  $('builtinCardSelect').querySelector('[value="custom"]').hidden = !!state.card.builtin;
  $('builtinCardSelect').value = state.card.builtin ? state.card.id || 'mard221' : 'custom';
  $('paletteBrandNote').textContent = state.card.name + ' · 社区参考颜色';
}
