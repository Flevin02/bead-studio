/* 导入过程只编辑草稿。文件读取、OCR 和校对完成后，才把整张有效色卡交给主应用。 */
window.BeadImports = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.BeadPalettes;
  let rows = [], image = null, words = [], picking = null, version = 0, worker = null, busy = false, cancelOCR = null;
  let applyCard, notify;

  /** 使用 Blob 保存模板和校对后的色卡；文件名固定，不执行导入文件中的内容。 */
  function download(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /** 错误保留在弹窗内，当前生效色卡和图纸不受影响。 */
  function fail(message) {
    $('importError').textContent = message; $('importError').hidden = false;
  }

  /** 同步读取状态，防止 OCR 运行时误应用尚未完成的结果。关闭弹窗始终可用。 */
  function setBusy(value, message) {
    busy = value;
    $('importPreview').inert = value;
    for (const id of ['importFileBtn', 'recognizeBtn', 'resampleBtn', 'saveCardJsonBtn', 'addCardRowBtn']) $(id).disabled = value;
    $('applyCardBtn').disabled = value || !rows.length;
    if (message) $('importStatus').textContent = message;
  }

  /** 展示可编辑草稿，所有外部文字通过 value/textContent 写入，避免 HTML 注入。 */
  function renderRows() {
    $('importPreview').hidden = !rows.length;
    $('importCount').textContent = `${rows.length} 个颜色 · 请核对色号与色块`;
    $('importRows').replaceChildren();
    rows.forEach((row, index) => {
      const tr = document.createElement('tr'); tr.dataset.row = index;
      const chipCell = document.createElement('td'), chip = document.createElement('input');
      chip.type = 'color'; chip.value = P.normalizeHex(row.hex) || '#FFFFFF'; chip.setAttribute('aria-label', `第 ${index + 1} 行颜色`);
      const codeCell = document.createElement('td'), code = document.createElement('input');
      code.value = row.code; code.maxLength = 16; code.setAttribute('aria-label', `第 ${index + 1} 行色号`);
      const hexCell = document.createElement('td'), hex = document.createElement('input');
      hex.value = row.hex; hex.maxLength = 7; hex.setAttribute('aria-label', `第 ${index + 1} 行 HEX`);
      code.addEventListener('input', () => { row.code = code.value; });
      hex.addEventListener('input', () => { row.hex = hex.value; const normalized = P.normalizeHex(row.hex); if (normalized) chip.value = normalized; });
      chip.addEventListener('input', () => { row.hex = chip.value.toUpperCase(); hex.value = row.hex; });
      chipCell.append(chip); codeCell.append(code); hexCell.append(hex);
      const actions = document.createElement('td');
      if (image) {
        const pick = document.createElement('button'); pick.className = 'text-btn'; pick.textContent = '重新取色';
        pick.addEventListener('click', () => { picking = index; $('importStatus').textContent = `请点击图片中 ${row.code || '此编号'} 的色块中心。`; $('cardImageCanvas').scrollIntoView({ block: 'center', behavior: 'smooth' }); });
        actions.append(pick);
      }
      const remove = document.createElement('button'); remove.className = 'text-btn remove-row'; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除第 ${index + 1} 行`);
      remove.addEventListener('click', () => { rows.splice(index, 1); picking = null; renderRows(); });
      const status = document.createElement('small');
      status.textContent = row.confidence === undefined ? '' : row.confidence < 80 ? '识别存疑，请核对' : '图片取样，请核对';
      actions.append(remove, status); tr.append(chipCell, codeCell, hexCell, actions); $('importRows').append(tr);
    });
    $('applyCardBtn').disabled = busy || !rows.length;
    drawImage();
  }

  /** 绘制原图及识别框；真实采样始终读取未加框的独立画布。 */
  function drawImage() {
    if (!image) return;
    const canvas = $('cardImageCanvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    ctx.strokeStyle = '#7755CC'; ctx.lineWidth = Math.max(2, image.width / 600);
    for (const row of rows) if (row.bbox) {
      const b = row.bbox; ctx.strokeRect(b.x0 - 3, b.y0 - 3, b.x1 - b.x0 + 6, b.y1 - b.y0 + 6);
    }
  }

  /** 对指定区域求 RGB 中位数，削弱文字边缘、豆孔和少量反光；空区域返回 null。 */
  function sampleRect(x, y, width, height) {
    const left = Math.max(0, Math.min(image.width - 1, Math.round(x)));
    const top = Math.max(0, Math.min(image.height - 1, Math.round(y)));
    const w = Math.max(1, Math.min(image.width - left, Math.round(width)));
    const h = Math.max(1, Math.min(image.height - top, Math.round(height)));
    const data = image.getContext('2d', { willReadFrequently: true }).getImageData(left, top, w, h).data;
    const channels = [[], [], []];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      for (let c = 0; c < 3; c++) channels[c].push(data[i + c]);
    }
    if (!channels[0].length) return null;
    const rgb = channels.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
    return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /** 根据同排/同列的标签间距估计色块范围；文字和色块位置不符时可切换方向或手动点取。 */
  function sampleWord(word) {
    const b = word.bbox, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const labelHeight = Math.max(8, b.y1 - b.y0);
    const sameRow = words.filter(w => w !== word && Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - cy) < labelHeight);
    const dx = sameRow.length ? Math.min(...sameRow.map(w => Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - cx))) : Math.min(image.width, Math.max(b.x1 - b.x0, labelHeight * 3) * 2.5);
    const otherRows = words.filter(w => Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - cy) > labelHeight * 1.5);
    const dy = otherRows.length ? Math.min(...otherRows.map(w => Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - cy))) : Math.min(image.height, labelHeight * 6);
    const position = $('swatchPosition').value;
    if (position === 'left') return sampleRect(b.x0 - dx * .58, cy - dy * .15, dx * .35, dy * .3);
    if (position === 'right') return sampleRect(b.x1 + dx * .18, cy - dy * .15, dx * .35, dy * .3);
    if (position === 'below') return sampleRect(cx - dx * .2, b.y1 + dy * .15, dx * .4, dy * .36);
    if (position === 'inside') return sampleRect(b.x0 - labelHeight, b.y0 - labelHeight * .5, b.x1 - b.x0 + labelHeight * 2, labelHeight * 2);
    return sampleRect(cx - dx * .2, b.y0 - dy * .56, dx * .4, dy * .36);
  }

  /** 按识别出的文字生成候选色卡，不根据颜色臆测编号，也不把重复色号静默去掉。 */
  function rowsFromWords() {
    rows = words.map(word => ({ code: word.text, hex: sampleWord(word) || '', confidence: word.confidence, bbox: word.bbox }));
    picking = null; renderRows();
    $('importStatus').textContent = rows.length ? `识别到 ${rows.length} 个候选色号。请核对文字和颜色；缺失项可点击原图补色。` : '未读到清晰的字母数字色号。可点击图片色块逐个补色，并手动填写编号；也可改用 CSV/JSON。';
  }

  /**
   * 为文字识别生成独立黑白副本，真实色块取样仍使用原图。
   * 只保留较暗且接近中性的笔画，再去掉面积大、接近实心矩形的色块，
   * 防止稀疏文字模型把整排彩色方块视为文字行。连通区域按四邻域判断。
   */
  function textImage() {
    const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
    const ctx = copy.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height), data = pixels.data;
    const w = copy.width, h = copy.height, mask = new Uint8Array(w * h), queue = new Int32Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      const max = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      const min = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      if (max < 150 && max - min < 70) mask[i] = 1;
    }
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      let read = 0, end = 1, left = w, right = 0, top = h, bottom = 0;
      queue[0] = start; mask[start] = 2;
      while (read < end) {
        const point = queue[read++], x = point % w, y = Math.floor(point / w);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        for (const next of [x > 0 ? point - 1 : -1, x < w - 1 ? point + 1 : -1, y > 0 ? point - w : -1, y < h - 1 ? point + w : -1]) {
          if (next >= 0 && mask[next] === 1) { mask[next] = 2; queue[end++] = next; }
        }
      }
      const area = (right - left + 1) * (bottom - top + 1);
      if (end > 250 && right - left > 10 && bottom - top > 10 && end / area > .9) {
        for (let i = 0; i < end; i++) mask[queue[i]] = 0;
      }
    }
    for (let i = 0; i < mask.length; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = mask[i] === 2 ? 0 : 255; data[i * 4 + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    return copy;
  }

  /**
   * 在独立 Worker 中识别整张色卡的字母数字标签；关闭弹窗会终止当前任务。
   * 资源适配由BeadOCR集中处理，普通制图和表格导入不准备OCR组件。
   */
  async function recognize() {
    if (!image || busy) return;
    const current = version;
    setBusy(true, BeadOCR.embedded ? '正在本地识别色号…' : '正在准备图片色卡识别组件，首次使用需要下载资源…'); $('importError').hidden = true;
    let session, engine, cancel;
    let preparing = true;
    let refining = false;
    const aborted = new Promise((resolve, reject) => { cancel = () => {
      // 句柄在Worker就绪前已经可用，关闭窗口不必等待模型下载和初始化结束。
      if (session) session.terminate();
      reject(new Error('OCR cancelled'));
    }; });
    cancelOCR = cancel;
    // 设备或浏览器不支持识别器时允许退出，仍能手动点取和表格导入。
    const timeout = setTimeout(cancel, 60000);
    try {
      // 大资源仅在有效图片色卡开始识别时准备；等待结束后再次检查本次导入是否已取消。
      await Promise.race([BeadOCR.prepare(), aborted]);
      if (current !== version) return;
      session = BeadOCR.startWorker(message => {
        if (current === version && !refining && message.status === 'recognizing text') $('importStatus').textContent = `正在本地识别色号… ${Math.round(message.progress * 100)}%`;
      });
      engine = await Promise.race([session.ready, aborted]);
      if (current !== version) return;
      preparing = false;
      worker = engine;
      await engine.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_ /', preserve_interword_spaces: '1' });
      // 预处理仅提供文字坐标；取色始终读原图，二值化不会污染实际色值。
      const prepared = textImage();
      const result = await Promise.race([engine.recognize(prepared), aborted]);
      if (current !== version) return;
      const candidates = (result.data.words || []).filter(word => /^[A-Za-z0-9_/-]{1,16}$/.test(word.text));
      const validCode = text => /^(?:[A-Z]{1,5}[-_/]?)?\d{1,4}(?:[-_/][A-Z0-9]+)?$/.test(text);
      // 对疑似漏字和低置信度的标签单独放大识别，使用原文字坐标，不根据颜色猜编号。
      refining = true;
      await engine.setParameters({ tessedit_pageseg_mode: '7' });
      words = [];
      for (let i = 0; i < Math.min(candidates.length, 512); i++) {
        if (current !== version) return;
        const word = candidates[i], raw = word.text.replace(/\s/g, '').toUpperCase();
        let text = raw, confidence = word.confidence;
        if (!validCode(raw) || confidence < 90) {
          $('importStatus').textContent = `正在本地校对标签… ${i + 1}/${Math.min(candidates.length, 512)}`;
          const b = word.bbox, height = Math.max(8, b.y1 - b.y0);
          const left = Math.max(0, Math.floor(b.x0 - height * .7)), top = Math.max(0, Math.floor(b.y0 - height * .4));
          const width = Math.min(prepared.width - left, Math.ceil(b.x1 - b.x0 + height * 1.4));
          const cropHeight = Math.min(prepared.height - top, Math.ceil(height * 1.8));
          const crop = document.createElement('canvas'); crop.width = width * 3; crop.height = cropHeight * 3;
          crop.getContext('2d').drawImage(prepared, left, top, width, cropHeight, 0, 0, crop.width, crop.height);
          const second = await Promise.race([engine.recognize(crop), aborted]);
          const refined = second.data.text.replace(/\s/g, '').toUpperCase();
          if (validCode(refined) && (!validCode(raw) || second.data.confidence >= confidence)) { text = refined; confidence = second.data.confidence; }
        }
        if (validCode(text)) words.push({ text, bbox: word.bbox, confidence });
      }
      rowsFromWords();
    } catch (error) {
      if (current === version) {
        fail(preparing ? '识别组件加载失败，请检查网络后点“重新识别文字”重试；仍可手动补色或导入表格。' : '自动识别未完成，可以点击原图补色并填写编号，或导入 CSV/JSON。');
        $('importStatus').textContent = '可手动补充色块；当前生效色卡未改变。';
      }
    } finally {
      clearTimeout(timeout);
      if (session) session.terminate();
      if (worker === engine) worker = null;
      if (cancelOCR === cancel) cancelOCR = null;
      if (current === version) setBusy(false);
    }
  }

  /** 验证文件再建立导入草稿；解码失败、超限和过期结果都不覆盖原来的有效草稿。 */
  async function readFile(file) {
    if (!file || busy) return;
    const isImage = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type);
    if (!isImage && !/\.(csv|tsv|json)$/i.test(file.name)) { fail('请选择 CSV、TSV、JSON 或 PNG/JPG/WebP 色卡图片。'); return; }
    if (file.size > (isImage ? 20 : 2) * 1024 * 1024) { fail(isImage ? '色卡图片不能超过 20 MB。' : '表格色卡不能超过 2 MB。'); return; }
    const current = ++version; let url;
    setBusy(true, '正在读取色卡…'); $('importError').hidden = true;
    try {
      if (!isImage) {
        const card = P.parse(await file.text(), file.name);
        if (current !== version) return;
        rows = card.colors.map(c => ({ code: c.code, hex: c.hex, name: c.name })); image = null; words = [];
        $('imageCardPane').hidden = true; $('importCardName').value = card.name;
        renderRows(); $('importStatus').textContent = '表格已读取，可修改后使用；当前图纸尚未改变。';
      } else {
        url = URL.createObjectURL(file); const decoded = new Image(); decoded.src = url; await decoded.decode();
        if (current !== version) return;
        if (!decoded.naturalWidth || decoded.naturalWidth * decoded.naturalHeight > 25000000) throw new Error('图片像素过大，请缩小到 2500 万像素以内。');
        const next = document.createElement('canvas'), scale = Math.min(1, 2400 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
        next.width = Math.max(1, Math.round(decoded.naturalWidth * scale)); next.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
        const ctx = next.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, next.width, next.height); ctx.drawImage(decoded, 0, 0, next.width, next.height);
        image = next; rows = []; words = []; picking = null;
        $('imageCardPane').hidden = false; $('importCardName').value = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
        renderRows(); drawImage();
      }
    } catch (error) {
      if (current === version) {
        fail(isImage && !error.message?.startsWith('图片像素') ? '无法读取这张色卡图片，请换一个有效的 PNG/JPG/WebP 文件。' : error.message || '文件无法读取，请换一个文件。');
        $('importStatus').textContent = '读取失败，当前图纸与生效色卡未改变。';
      }
      return;
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (current === version) setBusy(false);
    }
    if (isImage && current === version) await recognize();
  }

  /** 校对通过后形成完整色卡；名称和编号都是纯文本，空名称使用清晰默认值。 */
  function draftCard() {
    return { name: $('importCardName').value.trim().slice(0, 40) || '我的色卡', colors: P.validate(rows), builtin: false };
  }

  /** 绑定导入、导出模板、手动取样与关闭清理事件；应用回调由主界面提供。 */
  function init(onApply, toast) {
    applyCard = onApply; notify = toast;
    $('importCardBtn').addEventListener('click', () => { $('importError').hidden = true; $('importDialog').showModal(); });
    $('importFileBtn').addEventListener('click', () => $('cardFileInput').click());
    $('cardFileInput').addEventListener('change', event => { readFile(event.target.files[0]); event.target.value = ''; });
    $('templateBtn').addEventListener('click', () => download('\uFEFFcode,hex,name\nA1,#F9F0CD,示例浅色\nH7,#000000,示例深色\n', '色卡模板.csv', 'text/csv;charset=utf-8'));
    $('addCardRowBtn').addEventListener('click', () => {
      if (rows.length >= 512) { fail('最多支持 512 个颜色。'); return; }
      rows.push({ code: '', hex: '#FFFFFF' }); renderRows(); $('importRows').lastElementChild?.querySelector('td:nth-child(2) input').focus();
    });
    $('resampleBtn').addEventListener('click', () => {
      for (const row of rows) {
        const word = words.find(w => w.bbox === row.bbox);
        if (word) row.hex = sampleWord(word) || row.hex;
      }
      renderRows();
      $('importStatus').textContent = words.length ? '已按选择的方向重新取色，保留你校对过的编号和手动补色。' : '点击图片色块中心补色，再填写对应编号。';
    });
    $('recognizeBtn').addEventListener('click', recognize);
    $('cardImageCanvas').addEventListener('click', event => {
      if (busy || !image) return;
      const rect = event.target.getBoundingClientRect();
      const x = (event.clientX - rect.left) * image.width / rect.width, y = (event.clientY - rect.top) * image.height / rect.height;
      const radius = Math.max(2, Math.round(image.width / 300));
      const hex = sampleRect(x - radius, y - radius, radius * 2 + 1, radius * 2 + 1);
      if (!hex) { fail('这里没有可取样的颜色，请点击色块中心。'); return; }
      if (picking !== null && rows[picking]) rows[picking].hex = hex;
      else {
        if (rows.length >= 512) { fail('最多支持 512 个颜色。'); return; }
        rows.push({ code: '', hex });
      }
      const focusIndex = picking ?? rows.length - 1; picking = null; renderRows();
      $('importStatus').textContent = '已从点击位置取色，请核对编号和颜色。';
      $('importRows').children[focusIndex]?.querySelector('td:nth-child(2) input').focus();
    });
    $('applyCardBtn').addEventListener('click', () => {
      try { const card = draftCard(); applyCard(card); $('importDialog').close(); }
      catch (error) { fail(error.message); }
    });
    $('saveCardJsonBtn').addEventListener('click', () => {
      try {
        const card = draftCard();
        download(JSON.stringify({ name: card.name, colors: card.colors.map(({ code, hex, name }) => ({ code, hex, ...(name ? { name } : {}) })) }, null, 2), '我的色卡.json', 'application/json');
        notify('已保存校对后的色卡，下次可直接导入。');
      } catch (error) { fail(error.message); }
    });
    for (const id of ['closeImportBtn', 'cancelImportBtn']) $(id).addEventListener('click', () => $('importDialog').close());
    $('importDialog').addEventListener('close', () => { version++; if (cancelOCR) cancelOCR(); if (worker) { worker.terminate(); worker = null; } setBusy(false); picking = null; });
    $('sourcesBtn').addEventListener('click', () => $('sourcesDialog').showModal());
    $('closeSourcesBtn').addEventListener('click', () => $('sourcesDialog').close());
  }
  return { init };
})();
