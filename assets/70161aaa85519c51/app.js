(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  // 源图和量化结果分开保管：镜像只改变读取坐标，来回切换不会损失图像。
  const state = {
    source: null, name: '午后的橘子猫', demo: true,
    width: 32, height: 32, cells: [], palette: [],
    mirrored: false, zoom: 1, selected: null, loadVersion: 0,
    loading: false, toastTimer: null, regenerateTimer: null,
    // 当前改色弹窗对应的色号索引；取消或关闭后不保留未保存的草稿。
    editingColor: null,
    // 固定最近点击的显示坐标；颜色和色号每次从当前图纸读取，改色后不会显示旧值。
    activeCell: null,
    // 制图保留快捷改色；拼豆定位并筛选同色号，两种模式共用同一份格子与配色。
    mode: 'design', sourceId: null, viewTask: 0
  };
  const P = window.BeadPalettes;
  const defaultCard = { name: 'MARD 221 色', colors: P.validate(window.MARD_221), builtin: true };
  state.card = defaultCard;
  state.autoResult = null;
  state.hasEdits = false;
  const canvas = $('patternCanvas');
  const CELL = 24;
  const MARGIN = 28;
  const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';
  const mobileLayout = window.matchMedia('(max-width: 650px)');
  // 动画只保留在界面层，不进入作品快照；同一切换器最多运行一个形变任务。
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const switchVisuals = new Map();
  const modeSwitch = $('designModeBtn').parentElement;
  const directionSwitch = $('normalBtn').parentElement;
  const exportButtons = [$('exportBtn'), $('mobileExportBtn'), $('readingExportBtn')];
  let exporting = false;
  const settingsPanel = $('settingsPanel');
  const settingsHome = document.createComment('图纸设置在桌面布局中的位置');
  settingsPanel.before(settingsHome);
  // 系统选图共用同一控件；设置打开时移入顶层弹窗，避免落在其 inert 背景中。
  const fileInput = $('fileInput');
  const fileInputHome = document.createComment('共享图片输入控件的原位置');
  fileInput.before(fileInputHome);
  // 仅保留本次选图的入口和设置会话，不进入作品快照；旧异步错误不干扰重开的面板。
  let filePickContext, settingsVisit = 0;
  const palettePanel = $('palettePanel');
  const paletteHome = document.createComment('豆子清单在工作区中的位置');
  palettePanel.before(paletteHome);
  // 保存事务串行执行；sequence 区分写入期间发生的新修改，不提前显示“已保存”。
  const persistence = {
    ready: false, tracked: false, recordPresent: false, initialRead: false,
    token: null, sequence: 0, savedSequence: 0, savedAt: null,
    timer: null, writing: false, blocked: null, sourceCache: null, sourceSavedId: null
  };

  /** 更新内部保存状态；日常保存及暂时失败不打扰，仅显示必须处理的恢复、版本或并发保护。 */
  function saveStatus(kind, message) {
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
  function savedMessage(time) {
    return `已保存到此设备 · ${new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  /** 取得画布中心的归一化坐标；布局、模式及缩放变化后仍对着同一阅读区域。 */
  function readingCenter() {
    const area = $('canvasScroll').getBoundingClientRect(), image = canvas.getBoundingClientRect();
    return {
      x: image.width ? Math.max(0, Math.min(1, (area.x + area.width / 2 - image.x) / image.width)) : .5,
      y: image.height ? Math.max(0, Math.min(1, (area.y + area.height / 2 - image.y) / image.height)) : .5
    };
  }

  /** 在下一帧按新布局恢复中心；启动恢复时优先保证最近定位格可见，旧布局任务自动失效。 */
  function restoreReadingView(center, ensureActive = false) {
    const task = ++state.viewTask;
    state.adjustingView = true;
    return new Promise(resolve => requestAnimationFrame(() => {
      if (task !== state.viewTask) { resolve(); return; }
      const area = $('canvasScroll'), view = area.getBoundingClientRect();
      let image = canvas.getBoundingClientRect();
      area.scrollLeft += image.x + image.width * center.x - view.x - view.width / 2;
      area.scrollTop += image.y + image.height * center.y - view.y - view.height / 2;
      if (ensureActive && state.activeCell) {
        image = canvas.getBoundingClientRect();
        const scale = image.width / canvas.width;
        const left = image.x + (MARGIN + state.activeCell.x * CELL) * scale;
        const top = image.y + (MARGIN + state.activeCell.y * CELL) * scale;
        const cell = CELL * scale;
        if (left < view.left || left + cell > view.right) area.scrollLeft += left + cell / 2 - view.x - view.width / 2;
        if (top < view.top || top + cell > view.bottom) area.scrollTop += top + cell / 2 - view.y - view.height / 2;
      }
      // DOM 定位层只用于阅读，任何导出路径均不绘制这些标记。
      updateCellMarker();
      // 浏览器在下一帧派发程序滚动事件，等事件完成后再允许记录用户阅读变化。
      requestAnimationFrame(() => {
        if (task === state.viewTask) state.adjustingView = false;
        resolve();
      });
    }));
  }

  /** 标记一轮修改；纯浏览启动示例不建记录，已有作品的阅读变化合并为800ms一次保存。 */
  function markProjectChange(edit = false) {
    if (!persistence.ready) return;
    if (edit) persistence.tracked = true;
    if (!persistence.tracked || persistence.blocked) return;
    persistence.sequence++;
    // 一有新修改即撤下旧成功状态，避免用户误以为当前结果已经写入。
    saveStatus('pending', '有修改待保存');
    clearTimeout(persistence.timer);
    persistence.timer = setTimeout(saveProject, 800);
  }

  /** 获取源图的固定PNG帧；同一原图的平移、缩放和换色复用同一个编码 Promise。 */
  function sourcePacket() {
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
  function projectSnapshot() {
    const result = value => ({ palette: value.palette.map(c => ({ code: c.code, count: c.count })), cells: value.cells.slice() });
    return {
      sourceId: state.sourceId, fileName: $('fileName').textContent, fileMeta: $('fileMeta').textContent, demo: state.demo,
      card: { name: state.card.name, builtin: !!state.card.builtin, colors: state.card.colors.map(({ code, hex, name }) => ({ code, hex, name })) },
      parameters: { longest: Number($('sizeRange').value), maxColors: Number($('colorRange').value) },
      pattern: { ...result(state), width: state.width, height: state.height, hasEdits: state.hasEdits, autoResult: result(state.autoResult) },
      display: { mirrored: state.mirrored, grid: $('gridCheck').checked, codes: $('codeCheck').checked, beads: $('beadCheck').checked },
      reading: { mode: state.mode, zoom: state.zoom, center: readingCenter(), activeCell: state.activeCell ? { ...state.activeCell } : null,
        selectedCode: state.selected === null ? null : state.palette[state.selected].code }
    };
  }

  /** 串行保存最新完整作品；异步编码过期则重新取快照，冲突时暂停而不覆盖其他页面。 */
  async function saveProject() {
    clearTimeout(persistence.timer);
    if (!persistence.ready || !persistence.tracked || persistence.blocked || persistence.writing || state.loading) return;
    // 先提交滑块计算，快照中的参数、尺寸和实际格子必须一致。
    flushPending();
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
  async function confirmNewProject() {
    if (persistence.blocked === 'conflict' || persistence.blocked === 'newer') {
      // 保留数据并让现有作品继续导出，不能将新建动作当成跨版本覆盖许可。
      toast('请先重新载入，或使用能够读取该作品的更新版本。', true);
      return false;
    }
    if (!persistence.recordPresent && !persistence.tracked) return true;
    const dialog = $('newProjectDialog');
    if (dialog.open) return false;
    // 设置内开始新作品时叠加确认，确认或取消均返回原设置，不提前退出其上下文。
    dialog.returnValue = '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'continue'), { once: true });
      dialog.showModal();
    });
  }

  /** 只在完整校验、源帧解码成功后应用记录；不重新采样，保留手动色号合并与自动基线。 */
  async function restoreProject() {
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
        useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
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
        card: checked.card, autoResult: checked.automatic, hasEdits: record.pattern.hasEdits,
        activeCell: record.reading.activeCell, zoom: Math.min(maxZoom(), record.reading.zoom),
        selected: record.reading.selectedCode === null ? null : checked.current.palette.findIndex(c => c.code === record.reading.selectedCode) });
      $('sizeRange').value = record.parameters.longest; $('colorRange').value = record.parameters.maxColors;
      for (const [id, key] of [['gridCheck', 'grid'], ['codeCheck', 'codes'], ['beadCheck', 'beads']]) $(id).checked = record.display[key];
      $('fileName').textContent = record.fileName; $('fileMeta').textContent = record.fileMeta;
      $('mobileSourceAction').textContent = record.demo ? '上传图片' : '更换图片';
      // 缩略图继续使用小图，完整透明帧保留在Canvas和IndexedDB中。
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
      useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
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

  /** 更新DOM定位框与行列边缘标记，外框不遮住格内色号，且不会进入PNG或打印。 */
  function updateCellMarker() {
    const cell = state.activeCell, show = state.mode === 'beading' && cell !== null;
    for (const id of ['cellMarker', 'rowMarker', 'columnMarker']) $(id).hidden = !show;
    if (!show) return;
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    const size = CELL * scale, left = (MARGIN + cell.x * CELL) * scale, top = (MARGIN + cell.y * CELL) * scale;
    Object.assign($('cellMarker').style, { left: `${left}px`, top: `${top}px`, width: `${size}px`, height: `${size}px` });
    Object.assign($('rowMarker').style, { left: '0px', top: `${top}px`, width: `${Math.max(0, MARGIN * scale - 2)}px`, height: `${size}px` });
    Object.assign($('columnMarker').style, { left: `${left}px`, top: '0px', width: `${size}px`, height: `${Math.max(0, MARGIN * scale - 2)}px` });
  }

  /** 收起豆子清单；桌面在工作区展开，手机使用同一份清单的底部弹窗。 */
  function closeReadingPalette() {
    $('readingPaletteDialog').close();
    document.body.classList.remove('palette-open');
    $('paletteToggleBtn').setAttribute('aria-expanded', 'false');
    $('mobilePaletteBtn').setAttribute('aria-expanded', 'false');
  }

  /** 将选中底块绘成一条连续轮廓；两端和细腰高度独立，流动时保持文字与点击区域固定。 */
  function fluidPath(shape) {
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
  function syncFluidSwitch(group, button, animate = false) {
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
      const t = Math.min(1, (now - started) / 320), leading = 1 - Math.pow(1 - t, 3), trailing = t * t * (3 - 2 * t);
      const stretch = Math.sin(Math.PI * t), rebound = t > .82 ? Math.sin((t - .82) / .18 * Math.PI) * 1.2 * (rightward ? 1 : -1) : 0;
      const shape = {
        left: mix(from.left, target.left, rightward ? trailing : leading) + rebound,
        right: mix(from.right, target.right, rightward ? leading : trailing) + rebound,
        center: mix(from.center, target.center, leading),
        startHeight: mix(from.startHeight, target.startHeight, leading) * (1 - .35 * stretch * (rightward ? t : 1 - t)),
        endHeight: mix(from.endHeight, target.endHeight, leading) * (1 - .35 * stretch * (rightward ? 1 - t : t)),
        waist: mix(from.waist, target.waist, leading) * (1 - .74 * stretch)
      };
      visual.shape = t === 1 ? target : shape;
      // 只更新装饰SVG，不重绘图纸、不改变任何按钮尺寸和业务选中状态。
      visual.path.setAttribute('d', fluidPath(visual.shape));
      visual.frame = t < 1 ? requestAnimationFrame(step) : null;
    };
    visual.frame = requestAnimationFrame(step);
  }

  /** 根据当前可见按钮的真实尺寸计算图标位移；模式切换或横竖屏变化后仍保持居中。 */
  function positionExportIcons() {
    for (const button of exportButtons) {
      if (!button.offsetWidth) continue;
      const slot = button.querySelector('.export-icon-slot');
      button.style.setProperty('--export-shift', `${button.clientWidth / 2 - slot.offsetLeft - slot.offsetWidth / 2}px`);
    }
  }

  /** 初次显示、断点变化或系统减少动画设置改变时，直接同步两组按钮的最终视觉位置。 */
  function refreshButtonMotion() {
    // 读取已有aria状态，不给恢复作品或调整布局额外制造业务切换。
    syncFluidSwitch(modeSwitch, modeSwitch.querySelector('[aria-pressed="true"]'));
    syncFluidSwitch(directionSwitch, directionSwitch.querySelector('[aria-pressed="true"]'));
    // 图标保留正常流布局，动态计算位移，不通过隐藏文字缩窄导出按钮。
    positionExportIcons();
  }

  /** 仅改变操作与布局，不重新生成图纸；切换后仍看同一区域。 */
  function setMode(mode) {
    if (!['design', 'beading'].includes(mode)) return;
    const changed = state.mode !== mode;
    const center = readingCenter();
    // 参数若尚在等待量化，先生成完整结果，再进入只读的拼豆模式。
    flushPending();
    closeReadingPalette();
    $('mobileSettingsDialog').close(); $('colorDialog').close();
    state.mode = mode;
    document.body.classList.toggle('beading-mode', mode === 'beading');
    // 桌面返回制图时让设置轻柔进入；布局立即到位，图纸适配不等待动画。
    settingsPanel.classList.toggle('motion-return', changed && mode === 'design' && persistence.ready);
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
    canvas.setAttribute('aria-label', mode === 'beading' ? '拼豆图纸，点击色块只显示全部同色号豆子并查看格子信息，取消高亮恢复全图' : '拼豆图纸，点击色块可替换同色号，配色清单可查看豆数和改色');
    // 同一份清单和设置随屏幕布局移动，避免编号与状态出现两份不同步的DOM。
    placePalette();
    render();
    restoreReadingView(center).then(() => markProjectChange());
  }

  /** 按模式和屏幕放置清单；手机返回制图时恢复原来的页面位置。 */
  function placePalette() {
    // 手机两种模式均从同一份清单弹窗读取；主图下只保留四个常用色快捷预览。
    if (mobileLayout.matches) $('readingPaletteContent').append(palettePanel);
    else paletteHome.after(palettePanel);
    $('paletteToggleBtn').setAttribute('aria-controls', mobileLayout.matches ? 'readingPaletteDialog' : 'palettePanel');
  }

  /** 放大或缩小时围绕当前阅读中心变化，避免每次操作跳回画布边缘。 */
  function changeZoom(value) {
    const center = readingCenter();
    state.zoom = Math.max(.5, Math.min(maxZoom(), value));
    // 新缩放先布局，再还原中心；滚动稳定后才记入阅读快照。
    fitCanvas();
    restoreReadingView(center).then(() => markProjectChange());
  }

  /** 手机把同一组设置移到弹窗中，避免首屏被参数占满；桌面恢复原来的侧栏位置。 */
  function adaptMobileLayout() {
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
    if (state.source) {
      fitCanvas();
      restoreReadingView(center);
    }
  }

  /** 手机需要更大的格子供触摸与读色号；桌面沿用 250% 的缩放上限。 */
  function maxZoom() { return mobileLayout.matches ? 4 : 2.5; }

  /** 打开手机设置并聚焦标题；同一文件控件移入弹窗，程序聚焦不滚动面板或背景。 */
  function openMobileSettings() {
    settingsVisit++;
    $('sourceError').hidden = true;
    $('mobileSettingsDialog').append(fileInput);
    // 标题的 autofocus 先约束原生初始焦点，再显式使用 preventScroll 保持阅读位置。
    $('mobileSettingsDialog').showModal();
    $('mobileSettingsTitle').focus({ preventScroll: true });
  }

  /** 在原点击任务内唤起系统选图；临时入口仅供错误显示使用，不等待异步操作或关闭设置。 */
  function chooseImage() {
    const inSettings = $('mobileSettingsDialog').open;
    filePickContext = inSettings ? settingsVisit : null;
    $('sourceError').hidden = true;
    // 保留浏览器的用户激活，并复用原来的文件校验、解码和替换确认链。
    fileInput.click();
  }

  /** 将本次图片错误放到有效的设置会话内；面板已关闭或重开时只沿用页面提示。 */
  function imageError(message, context) {
    if (context === settingsVisit && $('mobileSettingsDialog').open) {
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
  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast visible${error ? ' error' : ''}`;
    state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), error ? 6500 : 3200);
  }

  /** 用本地像素画生成示例，无需联网下载图片，也避免跨域画布限制。 */
  function createDemo() {
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
  function patternSize(source, longest) {
    const width = source.naturalWidth || source.width;
    const height = source.naturalHeight || source.height;
    const ratio = longest / Math.max(width, height);
    return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
  }

  /** 先在临时画布计算完整结果；新图生成失败时尚未改动当前作品和成功记录。 */
  function calculatePattern(source, demo) {
    const longest = Math.max(16, Math.min(128, Number($('sizeRange').value) || 32));
    const colorLimit = Math.max(4, Math.min(32, Number($('colorRange').value) || 16));
    const [width, height] = patternSize(source, longest);
    const sample = document.createElement('canvas');
    sample.width = width; sample.height = height;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = !demo;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height).data;
    const pixels = [];
    for (let i = 0; i < image.length; i += 4) {
      const alpha = image[i + 3] / 255;
      pixels.push(alpha < .5 ? null : [0, 1, 2].map(c => Math.round(image[i + c] * alpha + 255 * (1 - alpha))));
    }
    const result = P.quantize(pixels, colorLimit, state.card.colors);
    return { ...result, width, height };
  }

  /** 从固定源帧重新采样；可接收换图前已成功计算的结果，避免失败时部分替换状态。 */
  function regenerate(computed = null) {
    if (!state.source) return;
    const hadCustomColors = state.hasEdits;
    // 参数变化会重新识别色号，旧的手动分组不能套用到新结果。
    const result = computed || calculatePattern(state.source, state.demo);
    $('colorDialog').close();
    // 保存独立快照；手动换成已用色号时会合并分组，恢复仍须还原原来的逐格映射。
    state.autoResult = { palette: result.palette.map(c => ({ ...c })), cells: result.cells.slice() };
    state.hasEdits = false;
    Object.assign(state, result, { selected: null, activeCell: null });
    updateControls();
    renderPalette();
    render();
    if (!state.palette.length) toast('这张图片是透明的，没有需要放置的豆子。可以换一张图片。');
    else if (hadCustomColors) toast('图纸已重新生成，手动改色已重置为新的自动配色。');
    // 只在完整量化成功后开始保存，初始化示例由 ready 状态阻止写入。
    markProjectChange(true);
  }

  /** 取当前方向的格子；x、y始终是成品图纸坐标，镜像转换只在此处执行。 */
  function cellAt(x, y, mirrored = state.mirrored) {
    const sourceX = mirrored ? state.width - 1 - x : x;
    return state.cells[y * state.width + sourceX];
  }

  /** 根据颜色亮度选择文字颜色，保证深色格和浅色格中的色号均可辨认。 */
  function textColor(rgb) {
    // 转为线性亮度后判断对比度，避免饱和绿色被普通RGB平均值误判成深色。
    const linear = rgb.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
    return luminance > .197 ? '#1B1221' : '#FFFFFF';
  }

  /** 绘制完整图纸。预览与PNG共用同一绘制路径，导出不受缩放和高亮影响。 */
  function drawPattern(ctx, { x = MARGIN, y = MARGIN, cell = CELL, codes = false, grid = true, beads = false, highlight = null, dark = false, isolateColor = false } = {}) {
    const width = state.width * cell, height = state.height * cell;
    // 深色仅用于屏幕环境；调用方未指定 dark 时，导出和打印保持白底及原始豆色。
    ctx.fillStyle = dark ? '#191C25' : '#FFFFFF';
    ctx.fillRect(x - MARGIN, y - MARGIN, width + MARGIN * 2, height + MARGIN * 2);
    for (let row = 0; row < state.height; row++) {
      for (let col = 0; col < state.width; col++) {
        const index = cellAt(col, row);
        if (index < 0) continue;
        // 拼豆找色只绘制目标色号：其他豆子及其格内文字暂时隐藏，原始格子数据不变。
        if (isolateColor && highlight !== null && highlight !== index) continue;
        const color = state.palette[index];
        const left = x + col * cell, top = y + row * cell;
        ctx.globalAlpha = highlight !== null && highlight !== index ? .15 : 1;
        ctx.fillStyle = color.hex;
        if (beads) {
          ctx.beginPath(); ctx.arc(left + cell / 2, top + cell / 2, cell * .44, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = dark ? '#191C25CC' : '#FFFFFFB8';
          ctx.beginPath(); ctx.arc(left + cell / 2, top + cell / 2, cell * .12, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillRect(left, top, cell, cell);
        }
        if (codes) {
          ctx.fillStyle = textColor(color.rgb);
          ctx.font = `500 ${Math.min(cell * .35, cell * 1.5 / color.code.length)}px ${FONT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(color.code, left + cell / 2, top + cell / 2 + .5);
        }
        ctx.globalAlpha = 1;
      }
    }

    // 每五格加深网格线，编号按1起算，方便对照实体模板数格。
    if (grid) {
      for (let col = 0; col <= state.width; col++) {
        ctx.beginPath(); ctx.strokeStyle = dark ? (col % 5 === 0 ? '#9B90AD80' : '#70667F66') : (col % 5 === 0 ? '#A99CB98C' : '#CFC6D55C');
        ctx.lineWidth = col % 5 === 0 ? 1.2 : .65;
        ctx.moveTo(x + col * cell, y); ctx.lineTo(x + col * cell, y + height); ctx.stroke();
      }
      for (let row = 0; row <= state.height; row++) {
        ctx.beginPath(); ctx.strokeStyle = dark ? (row % 5 === 0 ? '#9B90AD80' : '#70667F66') : (row % 5 === 0 ? '#A99CB98C' : '#CFC6D55C');
        ctx.lineWidth = row % 5 === 0 ? 1.2 : .65;
        ctx.moveTo(x, y + row * cell); ctx.lineTo(x + width, y + row * cell); ctx.stroke();
      }
    }
    ctx.fillStyle = dark ? '#B8ADC8' : '#A69BAE'; ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let col = 0; col < state.width; col++) {
      if (col === 0 || (col + 1) % 5 === 0) ctx.fillText(col + 1, x + (col + .5) * cell, y - 14);
    }
    for (let row = 0; row < state.height; row++) {
      if (row === 0 || (row + 1) % 5 === 0) ctx.fillText(row + 1, x - 15, y + (row + .5) * cell);
    }
  }

  /** 仅覆盖屏幕像素与找色信息，不适配尺寸、不恢复滚动；找色更新始终保持同一阅读几何。 */
  function paintPattern() {
    $('readingHighlightStatus').hidden = state.mode !== 'beading';
    $('readingAllColors').hidden = state.selected !== null;
    $('readingSelectedColor').hidden = state.selected === null;
    $('cancelReadingHighlightBtn').hidden = state.selected === null;
    if (state.selected !== null) {
      $('readingHighlightCode').textContent = state.palette[state.selected].code;
      $('readingHighlightSwatch').style.background = state.palette[state.selected].hex;
    }
    // 每轮先绘制完整底色，切色及取消不会残留上一次豆子或格内文字。
    drawPattern(canvas.getContext('2d'), {
      grid: $('gridCheck').checked, codes: $('codeCheck').checked,
      beads: $('beadCheck').checked, highlight: state.selected,
      dark: document.documentElement.dataset.theme === 'dark', isolateColor: state.mode === 'beading'
    });
    // 渲染可能由换色或恢复触发，格子信息也要读取新的色号与颜色。
    showCellInfo();
    // DOM定位标记只随当前格更新，不改变Canvas像素或CSS尺寸。
    updateCellMarker();
  }

  /** 图纸或实际布局变化时适配尺寸；仅在像素宽高改变时重设Canvas，随后保留阅读中心。 */
  function render() {
    const center = readingCenter();
    const width = state.width * CELL + MARGIN * 2, height = state.height * CELL + MARGIN * 2;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    // 内容与尺寸适配分开，普通找色只使用上面的绘制入口。
    paintPattern();
    // 模式、原图尺寸和主题等完整渲染仍沿用原有适配及阅读中心恢复。
    fitCanvas();
    // 放大后的完整布局更新也不把阅读位置带回左上角。
    restoreReadingView(center);
  }

  /** 保持图纸原始宽高比例，100%表示完整适应当前可见画布。 */
  function fitCanvas() {
    const container = $('canvasScroll');
    const availableWidth = Math.max(80, container.clientWidth - (mobileLayout.matches ? 20 : 36));
    const availableHeight = Math.max(80, container.clientHeight - 12);
    const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height) * state.zoom;
    canvas.style.width = `${Math.round(canvas.width * scale)}px`;
    canvas.style.height = `${Math.round(canvas.height * scale)}px`;
    $('zoomResetBtn').textContent = `${Math.round(state.zoom * 100)}%`;
    $('zoomOutBtn').disabled = state.zoom <= .5;
    $('zoomInBtn').disabled = state.zoom >= maxZoom();
    // CSS尺寸变化后同步定位层，不在Canvas上留下不可移除的标记。
    updateCellMarker();
  }

  /** 更新图纸尺寸、用量总计及控件状态；5毫米仅用于成品尺寸估算。 */
  function updateControls() {
    $('sizeValue').textContent = `${state.width} × ${state.height}`;
    $('patternMeta').textContent = `${state.width} × ${state.height} 格`;
    $('longestValue').textContent = $('sizeRange').value;
    $('colorsValue').textContent = $('colorRange').value;
    $('totalBeads').textContent = state.palette.reduce((sum, color) => sum + color.count, 0).toLocaleString('zh-CN');
    // 按需要备豆的色号计数；相同色号已合并，不把不同编号的同色材料混为一项。
    $('totalColors').textContent = state.palette.length;
    $('mobileBeadSummary').textContent = `${$('totalBeads').textContent} 颗 · ${state.palette.length} 色`;
    $('dimensions').textContent = `${state.width / 2} × ${state.height / 2} cm`;
    $('demoTag').hidden = !state.demo;
    for (const range of [$('sizeRange'), $('colorRange')]) {
      const value = ((Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
      range.style.setProperty('--fill', `${value}%`);
    }
    document.querySelectorAll('[data-size]').forEach(button => button.classList.toggle('active', button.dataset.size === $('sizeRange').value));
  }

  /** 为每种实际使用的颜色构建用量行；文本使用textContent，文件名也不作为HTML插入。 */
  function renderPalette() {
    $('paletteList').replaceChildren();
    for (let index = 0; index < state.palette.length; index++) {
      const color = state.palette[index];
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
    $('resetColorsBtn').hidden = !state.hasEdits;
    // 常用色仍引用同一配色索引；它只提供找色入口，完整编号与改色继续在清单内操作。
    renderPalettePeek();
    updateHighlight();
  }

  /** 手机主图下显示用量最多的前四色；点击沿用现有选色/取消与阅读保存规则。 */
  function renderPalettePeek() {
    $('mobileColorPeek').replaceChildren();
    state.palette.slice(0, 4).forEach((color, index) => {
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

  /** 打开当前色号的替换草稿；cell 是可选的点击坐标，保存始终替换全图同色号。 */
  function openColorEditor(index, cell = null) {
    if (state.mode === 'beading') return;
    if (state.loading) { toast('图片正在读取，请稍后再修改颜色。'); return; }
    flushPending();
    const color = state.palette[index];
    if (!color) return;
    state.editingColor = index;
    state.draftColor = state.card.colors.find(c => c.code === color.code);
    $('colorDialogTitle').textContent = `替换 ${color.code}`;
    const position = cell ? `第 ${cell.y + 1} 行，第 ${cell.x + 1} 列 · ${color.code} · ${color.hex}\n` : '';
    $('colorTargetSummary').textContent = `${position}${state.card.name} · 将图纸中全部 ${color.count} 颗 ${color.code} 豆子替换，位置保持不变。`;
    $('colorAutoPreview').style.backgroundColor = color.hex;
    $('colorAutoHex').textContent = color.code + ' ' + color.hex;
    $('colorSearch').value = '';
    setColorDraft(color.hex);
    $('colorDialog').showModal();
  }

  /** 用输入颜色寻找当前色卡的最近色；草稿只采用色卡已有的编号和参考色。 */
  function setColorDraft(hex) {
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
    state.draftColor = P.nearest(rgb, state.card.colors);
    $('colorPicker').value = hex;
    $('colorHex').value = hex;
    $('colorHex').removeAttribute('aria-invalid');
    $('colorError').hidden = true;
    renderColorChoices(rgb);
  }

  /** 展示可搜索色卡；输入 HEX 时按感知距离排序，选中态明确标出将保存的真实色号。 */
  function renderColorChoices(rgb = null) {
    const query = $('colorSearch').value.trim().toLowerCase();
    const choices = state.card.colors.filter(c => !query || c.code.toLowerCase().includes(query) || c.name.toLowerCase().includes(query));
    if (rgb) {
      const lab = P.toLab(rgb);
      choices.sort((a, b) => P.distance(lab, a.lab) - P.distance(lab, b.lab));
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
  function saveColor(event) {
    event.preventDefault();
    if (!P.normalizeHex($('colorHex').value)) {
      $('colorError').textContent = '请输入有效 HEX，例如 #AABBCC，或直接选择下方色号。';
      $('colorError').hidden = false; $('colorHex').setAttribute('aria-invalid', 'true'); return;
    }
    const index = state.editingColor, replacement = state.draftColor;
    if (!state.palette[index] || !replacement) return;
    const codes = state.cells.map(i => i < 0 ? null : i === index ? replacement.code : state.palette[i].code);
    const counts = new Map();
    for (const code of codes) if (code !== null) counts.set(code, (counts.get(code) || 0) + 1);
    state.palette = [...counts].map(([code, count]) => ({ ...state.card.colors.find(c => c.code === code), count })).sort((a, b) => b.count - a.count);
    const indices = new Map(state.palette.map((c, i) => [c.code, i]));
    state.cells = codes.map(code => code === null ? -1 : indices.get(code));
    state.selected = null; state.hasEdits = true;
    updateControls(); renderPalette();
    $('colorDialog').close();
    toast(`已替换为 ${replacement.code}，相同色号用量已合并。`);
    // 保存完整格子映射和独立的自动基线，刷新后仍能撤销合并。
    markProjectChange(true);
  }

  /** 一并恢复自动配色和分组，包括之前被手动合并的格子。 */
  function resetCustomColors() {
    if (!state.autoResult) return;
    state.palette = state.autoResult.palette.map(c => ({ ...c }));
    state.cells = state.autoResult.cells.slice();
    state.hasEdits = false; state.selected = null;
    updateControls(); renderPalette();
    toast('已恢复当前图纸的自动配色。');
    markProjectChange(true);
  }

  /** 高亮仅用于屏幕找色，不改变豆数或导出数据。 */
  function updateHighlight() {
    document.querySelectorAll('.color-row, .palette-peek-color').forEach(button => {
      const selected = Number(button.dataset.colorIndex) === state.selected;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('clearHighlightBtn').hidden = state.selected === null;
    // 找色只重绘内容，不能重新 fit 或制造新的滚动恢复任务。
    paintPattern();
  }

  /** 切换展示方向，并让按钮、方向提示与图纸保持一致。 */
  function setDirection(mirrored) {
    const changed = state.mirrored !== mirrored;
    // 切换方向后取消旧的点击坐标，避免把旧位置误当成当前选中的那颗豆子。
    if (state.mirrored !== mirrored) state.activeCell = null;
    state.mirrored = mirrored;
    $('normalBtn').classList.toggle('active', !mirrored);
    $('mirrorBtn').classList.toggle('active', mirrored);
    $('normalBtn').setAttribute('aria-pressed', String(!mirrored));
    $('mirrorBtn').setAttribute('aria-pressed', String(mirrored));
    // 与模式按钮共用流动轮廓；图纸镜像和编号仍按原规则立即更新。
    syncFluidSwitch(directionSwitch, mirrored ? $('mirrorBtn') : $('normalBtn'), changed);
    $('directionBadge').classList.toggle('mirrored', mirrored);
    $('directionBadge').querySelector('span').textContent = mirrored ? '镜像图纸' : '正向图纸';
    $('directionBadge').querySelector('use').setAttribute('href', mirrored ? '#i-mirror' : '#i-normal');
    $('mirrorNote').hidden = !mirrored;
    $('readingDirection').textContent = mirrored ? '镜像' : '正向';
    render();
    if (changed) markProjectChange(true);
  }

  /** 打开示例或换图后重置查看状态，保留尺寸和颜色偏好。 */
  function useSource(source, name, meta, demo) {
    // 完成新图的解码与量化后才提交页面状态，失败继续展示原作品。
    const result = calculatePattern(source, demo);
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
  function updateSourceThumbnail() {
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
    $('mobileSourceThumb').src = preview;
    $('mobileFileName').textContent = $('fileName').textContent;
  }

  /**
   * 解码用户图片，检查实际尺寸后才替换当前图纸。
   * file为共享控件或拖入的文件；context仅标记发起换图的设置会话，默认是主页面。
   * 返回Promise；版本号让后来选择的文件优先，失败或取消不会清空已有作品。
   */
  async function loadFile(file, context = null) {
    if (!file) return;
    // 每次实际选择都使旧解码失效，即使新选择无效，旧异步结果也不能回填。
    const version = ++state.loadVersion;
    let url = null;
    if (context === settingsVisit) $('sourceError').hidden = true;
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

  /** 生成独立PNG页面：固定网格、始终附带色号和用量，方向以当前选择为准。 */
  function createExportCanvas() {
    const gridWidth = state.width * CELL, gridHeight = state.height * CELL;
    const gridArea = Math.max(gridWidth, 480);
    const legendWidth = 220;
    const legendHeight = 100 + state.palette.length * 43;
    const sheet = document.createElement('canvas');
    sheet.width = gridArea + legendWidth + 100;
    sheet.height = Math.max(gridHeight + 180, legendHeight + 180, 520);
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.fillStyle = '#7755CC'; ctx.font = `600 24px ${FONT}`;
    ctx.fillText('我勒个豆 · 拼豆图纸', 34, 42);
    ctx.fillStyle = '#776985'; ctx.font = `13px ${FONT}`;
    const direction = state.mirrored ? '镜像' : '正向';
    const total = state.palette.reduce((sum, color) => sum + color.count, 0);
    const colorCount = state.palette.length;
    ctx.fillText(`${state.width} × ${state.height} 格  |  ${direction}  |  ${total} 颗豆子  |  ${colorCount} 种颜色`, 34, 70);
    const gx = 36 + (gridArea - gridWidth) / 2, gy = 120;
    drawPattern(ctx, { x: gx, y: gy, cell: CELL, grid: true, codes: true, beads: false });
    const lx = gridArea + 72;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#584561'; ctx.font = `600 15px ${FONT}`;
    ctx.fillText('配色与用量', lx, 112);
    for (let i = 0; i < state.palette.length; i++) {
      const color = state.palette[i], top = 134 + i * 43;
      ctx.fillStyle = color.hex; ctx.fillRect(lx, top, 27, 27);
      ctx.strokeStyle = '#D8CFDF'; ctx.lineWidth = .7; ctx.strokeRect(lx, top, 27, 27);
      ctx.fillStyle = '#5D4B68'; ctx.font = `600 12px ${FONT}`;
      ctx.fillText(`${color.code}   ${color.count} 颗`, lx + 38, top + 11, 165);
      ctx.fillStyle = '#A195A9'; ctx.font = `10px ${FONT}`;
      ctx.fillText(color.hex, lx + 38, top + 26);
    }
    ctx.fillStyle = '#A094AA'; ctx.font = `11px ${FONT}`;
    ctx.fillText(`色卡：${state.card.name} · 参考颜色请以实物核对。透明格不放豆。`, 34, sheet.height - 32, sheet.width - 68);
    ctx.fillText(`成品约 ${state.width / 2} × ${state.height / 2} cm（按 5 mm 豆估算）`, 34, sheet.height - 14);
    return sheet;
  }

  /** 用Blob下载PNG；动画只反馈生成状态，成功或失败均恢复按钮，连续点击不重复创建下载。 */
  async function exportPattern() {
    if (exporting) return;
    if (state.loading) { toast('图片正在读取，请稍后再导出。'); return; }
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
      toast('图纸已导出，包含色号和完整用量清单。');
    } catch (error) {
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
  async function printPattern() {
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

  /** 显示悬停格或最近点击格的坐标、色号和 HEX；未指定坐标时保留点击信息。 */
  function showCellInfo(cell = state.activeCell) {
    const output = $('cellInfo').querySelector('span');
    if (!cell) { output.textContent = state.mode === 'beading' ? '点击色块，只看同色号豆子' : '点击色块，快捷改色'; return; }
    const index = cellAt(cell.x, cell.y);
    const label = index < 0 ? '留空' : `${state.palette[index].code} · ${state.palette[index].hex}`;
    output.textContent = `第 ${cell.y + 1} 行，第 ${cell.x + 1} 列 · ${label}`;
  }

  /** 按CSS缩放换算当前显示坐标；返回格子坐标，画布边距和越界位置返回 null。 */
  function inspectCell(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) * canvas.width / rect.width - MARGIN) / CELL);
    const y = Math.floor(((event.clientY - rect.top) * canvas.height / rect.height - MARGIN) / CELL);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) { canvas.style.cursor = 'default'; return null; }
    const cell = { x, y };
    // 有色格可以点击改色，以小手提示；留空格只读信息，保留定位用的十字准星。
    canvas.style.cursor = state.mode === 'beading' || cellAt(x, y) >= 0 ? 'pointer' : 'crosshair';
    // 悬停仅展示信息，不覆盖最近一次点击固定的坐标，也不打开改色窗口。
    showCellInfo(cell);
    return cell;
  }

  /** 制图点击有色格打开全图同色号改色；拼豆点击则仅显示同色号，留空格只定位。 */
  function editCellColor(event) {
    // 先提交滑块待执行的重新采样，再按当前尺寸和镜像方向判断点击位置。
    flushPending();
    const cell = inspectCell(event);
    if (!cell) return;
    state.activeCell = cell;
    // 两种模式都保留完整格子信息；DOM外框和边缘标记不会写进导出图纸。
    updateCellMarker();
    const index = cellAt(cell.x, cell.y);
    if (state.mode === 'beading') {
      if (index >= 0) {
        state.selected = index;
        // 复用清单高亮与取消入口，所有同色号保留原色，其他豆子只在预览中隐藏。
        updateHighlight();
      }
      // 阅读选择随已有作品保存；点击留空格不清除当前找色结果。
      markProjectChange();
      return;
    }
    markProjectChange();
    if (index < 0) return;
    // 复用已有的色卡、校验、合并用量及保存逻辑，快捷入口只改变打开方式。
    openColorEditor(index, cell);
  }

  /** 将高频滑动合并为一次量化，避免大网格在拖动滑块时连续占用主线程。 */
  function scheduleRegenerate() {
    updateControls();
    clearTimeout(state.regenerateTimer);
    state.regenerateTimer = setTimeout(() => {
      regenerate();
      state.regenerateTimer = null;
    }, 65);
  }

  /** 导出、打印和方向切换前提交尚未执行的滑块变更，避免显示和数据错位。 */
  function flushPending() {
    if (state.regenerateTimer !== null) {
      clearTimeout(state.regenerateTimer); state.regenerateTimer = null;
      regenerate();
    }
  }

  /** 更新界面模式及图纸空格；remember 仅保存用户主动选择，不保存图片或作品。 */
  function applyTheme(theme, remember = false) {
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

  // 事件只初始化一次；图片、色卡与 OCR 均在本地处理，不使用外部服务。
  $('themeToggleBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    if (document.documentElement.dataset.themeSource !== 'manual') applyTheme(event.matches ? 'dark' : 'light');
  });
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
    const context = filePickContext === undefined ? ($('mobileSettingsDialog').open ? settingsVisit : null) : filePickContext;
    filePickContext = undefined;
    // 只传递这次发起入口，不保存到作品；清空value允许再次选择同一文件。
    loadFile(event.target.files[0], context);
    event.target.value = '';
  });
  fileInput.addEventListener('cancel', () => { filePickContext = undefined; });
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
    useSource(createDemo(), '午后的橘子猫.png', '内置示例 · 32 × 32 像素', true);
    toast('已打开橘子猫示例。');
  });
  $('sizeRange').addEventListener('input', scheduleRegenerate);
  $('colorRange').addEventListener('input', scheduleRegenerate);
  document.querySelectorAll('[data-size]').forEach(button => button.addEventListener('click', () => {
    $('sizeRange').value = button.dataset.size; flushPending(); regenerate();
  }));
  for (const id of ['gridCheck', 'codeCheck', 'beadCheck']) $(id).addEventListener('change', () => { flushPending(); render(); markProjectChange(true); });
  $('normalBtn').addEventListener('click', () => { flushPending(); setDirection(false); });
  $('mirrorBtn').addEventListener('click', () => { flushPending(); setDirection(true); });
  $('clearHighlightBtn').addEventListener('click', () => { state.selected = null; updateHighlight(); markProjectChange(); });
  $('cancelReadingHighlightBtn').addEventListener('click', () => { state.selected = null; updateHighlight(); markProjectChange(); });
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
  $('zoomInBtn').addEventListener('click', () => changeZoom(state.zoom + .25));
  $('zoomOutBtn').addEventListener('click', () => changeZoom(state.zoom - .25));
  const resetZoom = () => { state.zoom = 1; fitCanvas(); $('canvasScroll').scrollTo(0, 0); markProjectChange(); };
  $('zoomResetBtn').addEventListener('click', resetZoom);
  $('fitBtn').addEventListener('click', resetZoom);
  $('exportBtn').addEventListener('click', () => { flushPending(); exportPattern(); });
  $('printBtn').addEventListener('click', () => { flushPending(); printPattern(); });
  canvas.addEventListener('pointermove', inspectCell);
  canvas.addEventListener('click', editCellColor);
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
  $('retrySaveBtn').addEventListener('click', saveProject);
  $('retryRestoreBtn').addEventListener('click', restoreProject);
  $('reloadProjectBtn').addEventListener('click', () => location.reload());
  $('newProjectBtn').addEventListener('click', chooseImage);
  $('cancelNewProjectBtn').addEventListener('click', () => $('newProjectDialog').close('cancel'));
  $('confirmNewProjectBtn').addEventListener('click', () => $('newProjectDialog').close('continue'));
  /** 顶部和手机预览入口打开同一份清单；只有桌面实际展开侧栏时才需要重新适配。 */
  function togglePalette() {
    const center = readingCenter();
    if (document.body.classList.contains('palette-open')) closeReadingPalette();
    else {
      document.body.classList.add('palette-open');
      $('paletteToggleBtn').setAttribute('aria-expanded', 'true');
      $('mobilePaletteBtn').setAttribute('aria-expanded', 'true');
      if (mobileLayout.matches) {
        // 原生初始焦点交给标题，避免关闭按钮打开即出现焦点环。
        $('readingPaletteDialog').showModal();
        // 重开时也聚焦标题；preventScroll保留清单和背景图纸的阅读位置。
        $('readingPaletteTitle').focus({ preventScroll: true });
      }
    }
    // 展开桌面侧栏时画布变窄，仍然保留原来的阅读中心。
    if (!mobileLayout.matches) {
      // 桌面侧栏宽度实际变化，继续按原阅读中心适配。
      fitCanvas();
      // 手机弹窗不占背景布局，不创建无必要的阅读恢复任务。
      restoreReadingView(center);
    }
  }
  $('paletteToggleBtn').addEventListener('click', togglePalette);
  $('mobilePaletteBtn').addEventListener('click', togglePalette);
  $('closeReadingPaletteBtn').addEventListener('click', closeReadingPalette);
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
  /** 切换色卡后重新匹配原图，避免把旧卡编号配到新卡颜色上。 */
  function applyCard(card) {
    flushPending();
    state.card = card;
    // 使用与启动恢复相同的标签渲染，不把已保存自定义色卡误显示成默认卡。
    updateCardLabel();
    regenerate();
    toast(`已使用 ${card.name}，图纸已按色卡重新匹配。`);
  }
  /** 展示当前生效色卡的真实名称、数量和恢复入口。 */
  function updateCardLabel() {
    $('activeCardName').textContent = state.card.name;
    $('activeCardCount').textContent = `${state.card.colors.length} 色 · ` + (state.card.builtin ? '内置参考色卡' : '自定义色卡');
    $('defaultCardBtn').hidden = !!state.card.builtin;
  }
  $('defaultCardBtn').addEventListener('click', () => applyCard(defaultCard));
  window.BeadImports.init(applyCard, toast);
  window.addEventListener('resize', () => {
    const center = readingCenter();
    fitCanvas();
    restoreReadingView(center);
    // 布局改变时直接对齐真实按钮，不在过期尺寸上继续形变。
    refreshButtonMotion();
  });
  // 系统切到减少动画时立即收拢当前底块，后续操作仍提供明确的静态选中与忙碌状态。
  motionPreference.addEventListener('change', refreshButtonMotion);
  adaptMobileLayout();
  // 为初次示例建立静态底块，读取作品时由已有状态直接覆盖，不播放启动动画。
  refreshButtonMotion();
  // 初始化按钮与浏览器主题栏，颜色选择已在 head 中完成以防白屏闪烁。
  applyTheme(document.documentElement.dataset.theme);
  // 先只读恢复，完成前不允许示例或用户点击覆盖磁盘里的作品。
  restoreProject();
})();
