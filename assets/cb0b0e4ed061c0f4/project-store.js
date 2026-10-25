/* 作品只保存在此浏览器；图片和结构化快照在同一个 IndexedDB 事务内提交。 */
window.BeadProjectStore = (() => {
  'use strict';
  const DB_NAME = 'wolege-dou-projects';
  const STORE = 'workspace';
  const FORMAT = 1;
  let connection = null;

  /** 创建可供界面区分冲突、新版本与损坏记录的错误，不暴露用户图片数据。 */
  function fail(code, message) { return Object.assign(new Error(message), { code }); }

  /** 打开专用数据库；失败后允许显式重试，版本变化时释放旧连接。 */
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let finished = false;
      const timeout = setTimeout(() => {
        finished = true; connection = null;
        reject(fail('unavailable', '浏览器存储没有响应。'));
      }, 6000);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = request.onblocked = () => {
        clearTimeout(timeout); finished = true; connection = null;
        reject(fail('unavailable', '浏览器暂时无法打开作品存储。'));
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        if (finished) { db.close(); return; }
        db.onversionchange = () => { db.close(); connection = null; };
        resolve(db);
      };
    }).catch(error => { connection = null; throw error; });
    return connection;
  }

  /** 修订号是正常记录的比较标识；损坏记录使用完整内容作保护，不能误当成空库。 */
  function token(record) {
    if (record === undefined) return null;
    return typeof record?.revision === 'string' ? record.revision : JSON.stringify(record);
  }

  /** 在同一只读事务中读取快照和原图，不生成、修复或覆盖任何记录。 */
  async function read() {
    // 连接失败由调用方显示降级提示，原有制图仍可继续。
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      let record, source;
      store.get('latest').onsuccess = event => { record = event.target.result; };
      store.get('source').onsuccess = event => { source = event.target.result; };
      tx.oncomplete = () => resolve({ record, source, token: token(record) });
      tx.onerror = tx.onabort = () => reject(tx.error || fail('unavailable', '读取作品失败。'));
    });
  }

  /**
   * 比较旧修订再原子写入最近作品。source 仅换图时传入，普通阅读不重复写图片。
   * 只在事务完成后返回成功；冲突、容量不足或中止都会保留上次成功的整套记录。
   */
  async function write(snapshot, source, expectedToken) {
    // 在事务开始前完成所有异步准备，避免 IndexedDB 因等待图片编码而提前提交。
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let failure = null;
      const record = { ...snapshot, formatVersion: FORMAT, revision: crypto.randomUUID(), savedAt: Date.now() };
      store.get('latest').onsuccess = event => {
        if (token(event.target.result) !== expectedToken) {
          failure = fail('conflict', '作品已在另一个页面更新，请重新载入后继续。');
          tx.abort(); return;
        }
        store.get('source').onsuccess = sourceEvent => {
          const next = source || sourceEvent.target.result;
          if (!next || next.id !== snapshot.sourceId) {
            failure = fail('corrupt', '原图与图纸不是同一个版本。');
            tx.abort(); return;
          }
          if (source) store.put(source, 'source');
          store.put(record, 'latest');
        };
      };
      tx.oncomplete = () => resolve({ token: record.revision, savedAt: record.savedAt });
      tx.onerror = tx.onabort = () => reject(failure || tx.error || fail('unavailable', '作品未能写入此浏览器。'));
    });
  }

  /** 验证实际格子、编号引用和用量，并从已验证色卡重建颜色；绝不重新量化。 */
  function validatePattern(pattern, width, height, colors, maxColors) {
    if (!pattern || !Array.isArray(pattern.palette) || pattern.palette.length > maxColors ||
        !Array.isArray(pattern.cells) || pattern.cells.length !== width * height) throw fail('corrupt', '格子数据长度不正确。');
    const codes = new Set(), counts = Array(pattern.palette.length).fill(0);
    const palette = pattern.palette.map(item => {
      const color = colors.find(c => c.code === item?.code);
      if (!color || codes.has(color.code) || !Number.isInteger(item.count) || item.count <= 0) throw fail('corrupt', '配色色号或数量不正确。');
      codes.add(color.code);
      return { ...color, count: item.count };
    });
    for (const index of pattern.cells) {
      if (!Number.isInteger(index) || index < -1 || index >= palette.length) throw fail('corrupt', '格子引用了无效色号。');
      if (index >= 0) counts[index]++;
    }
    if (palette.some((color, index) => color.count !== counts[index])) throw fail('corrupt', '格子与用量不一致。');
    return { palette, cells: pattern.cells.slice() };
  }

  /** 严格检查完整记录；新格式和坏记录只报告错误，绝不自动迁移或用示例覆盖。 */
  function validate(record, source) {
    if (record?.formatVersion !== FORMAT) throw fail(record?.formatVersion > FORMAT ? 'newer' : 'corrupt',
      record?.formatVersion > FORMAT ? '该作品由更新版本保存，请更新工具后重试。' : '作品记录格式不正确。');
    const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
    const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
    if (!text(record.revision, 80) || !finite(record.savedAt, 1, Number.MAX_SAFE_INTEGER) ||
        !source || source.id !== record.sourceId || !(source.blob instanceof Blob) || source.blob.type !== 'image/png' ||
        !integer(source.width, 1, 25000000) || !integer(source.height, 1, 25000000) || source.width * source.height > 25000000 ||
        !text(record.fileName, 1024) || !text(record.fileMeta, 200) || typeof record.demo !== 'boolean') throw fail('corrupt', '原图记录不完整。');
    const { parameters: params, pattern, display, reading } = record;
    if (!params || !integer(params.longest, 16, 128) || !integer(params.maxColors, 4, 32) ||
        (params.denoise !== undefined && typeof params.denoise !== 'boolean') ||
        (params.dither !== undefined && !integer(params.dither, 0, 100)) ||
        (params.background !== undefined && (typeof params.background !== 'object' || params.background === null ||
          typeof params.background.remove !== 'boolean' || !finite(params.background.tolerance, 4, 40) || !integer(params.background.margin, 0, 10))) ||
        !pattern || !integer(pattern.width, 1, 128) || !integer(pattern.height, 1, 128) || typeof pattern.hasEdits !== 'boolean') throw fail('corrupt', '图纸参数不正确。');
    const scale = params.longest / Math.max(source.width, source.height);
    // 主体裁剪的记录：网格来自裁剪矩形加留白，不等于整图等比缩放；矩形必须完整落在原图内。
    const crop = pattern.crop;
    if (crop !== undefined && (typeof crop !== 'object' || crop === null ||
        !integer(crop.x, 0, source.width - 1) || !integer(crop.y, 0, source.height - 1) ||
        !integer(crop.width, 1, source.width) || !integer(crop.height, 1, source.height) ||
        crop.x + crop.width > source.width || crop.y + crop.height > source.height)) throw fail('corrupt', '裁剪区域超出原图。');
    if (crop ? params.background?.remove !== true :
      pattern.width !== Math.max(1, Math.round(source.width * scale)) || pattern.height !== Math.max(1, Math.round(source.height * scale))) throw fail('corrupt', '原图与图纸尺寸不一致。');
    if (!record.card || !text(record.card.name, 40) || typeof record.card.builtin !== 'boolean') throw fail('corrupt', '色卡信息不完整。');
    // 复用导入色卡的编号、HEX 与重复项校验，恢复时保持自定义色卡的实际内容。
    const colors = BeadPalettes.validate(record.card.colors);
    if (record.card.builtin && (colors.length !== MARD_221.length || colors.some((c, i) => c.code !== MARD_221[i].code || c.hex !== MARD_221[i].hex))) throw fail('corrupt', '内置色卡内容不一致。');
    // 当前配色和自动基线分别验证，恢复后仍可撤销同色号合并。
    const current = validatePattern(pattern, pattern.width, pattern.height, colors, params.maxColors);
    const automatic = validatePattern(pattern.autoResult, pattern.width, pattern.height, colors, params.maxColors);
    if (current.cells.some((cell, index) => (cell < 0) !== (automatic.cells[index] < 0))) throw fail('corrupt', '自动基线的留空区域不一致。');
    if (!display || ['mirrored', 'grid', 'codes', 'beads'].some(key => typeof display[key] !== 'boolean') ||
        (display.guides !== undefined && typeof display.guides !== 'boolean') ||
        !reading || !['design', 'beading'].includes(reading.mode) || !finite(reading.zoom, .5, 4) ||
        !reading.center || !finite(reading.center.x, 0, 1) || !finite(reading.center.y, 0, 1) ||
        reading.activeCell !== null && (!reading.activeCell || !integer(reading.activeCell.x, 0, pattern.width - 1) || !integer(reading.activeCell.y, 0, pattern.height - 1)) ||
        reading.selectedCode !== null && !current.palette.some(c => c.code === reading.selectedCode)) throw fail('corrupt', '阅读位置不正确。');
    return { card: { name: record.card.name, builtin: record.card.builtin, colors }, current, automatic };
  }

  return { read, write, validate };
})();
