/* 色卡解析与感知匹配共用纯函数；编号和颜色始终来自同一个已校验条目。 */
window.BeadPalettes = (() => {
  'use strict';

  /** 接受六位/三位 HEX；拒绝非字符串与不完整颜色，返回标准大写颜色或 null。 */
  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(value.trim());
    if (!match) return null;
    return '#' + (match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]).toUpperCase();
  }

  /** 将 sRGB 转到 D65 CIELAB；距离计算据此兼顾明度和色相，而非直接平均 RGB。 */
  function toLab(rgb) {
    const [r, g, b] = rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    const f = v => v > .0088564517 ? Math.cbrt(v) : 7.787037 * v + 16 / 116;
    const x = f((r * .4124564 + g * .3575761 + b * .1804375) / .95047);
    const y = f(r * .2126729 + g * .7151522 + b * .0721750);
    const z = f((r * .0193339 + g * .1191920 + b * .9503041) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  /** 返回 Lab 欧氏距离的平方；比较最近色时无需开方。 */
  const distance = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  /** 验证完整色卡，拒绝空卡、重复色号和越界 RGB；不静默丢弃错误行。 */
  function validate(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 512) throw new Error('色卡需要包含 1～512 个颜色。');
    const codes = new Set();
    return rows.map((row, index) => {
      if (!row || typeof row !== 'object') throw new Error(`第 ${index + 1} 行不是有效颜色。`);
      const code = String(row.code ?? row['色号'] ?? row.reference_code ?? '').trim();
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._/\-]{0,15}$/u.test(code)) throw new Error(`第 ${index + 1} 行：色号需为 1～16 位字母、数字或 . _ / -。`);
      if (codes.has(code.toUpperCase())) throw new Error(`第 ${index + 1} 行：色号 ${code} 重复，请校正或删除。`);
      codes.add(code.toUpperCase());
      let hex = normalizeHex(row.hex ?? row['色值'] ?? row['颜色']);
      if (!hex) {
        const rgb = row.rgb ?? [row.r ?? row.rgb_r, row.g ?? row.rgb_g, row.b ?? row.rgb_b];
        if (Array.isArray(rgb) && rgb.length === 3 && rgb.every(v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 255)) {
          hex = '#' + rgb.map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
        }
      }
      if (!hex) throw new Error(`第 ${index + 1} 行 ${code}：请填写有效 HEX 或 0～255 的 RGB。`);
      const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
      return { code, hex, rgb, lab: toLab(rgb), name: String(row.name ?? row['名称'] ?? '').slice(0, 60) };
    });
  }

  /** 读取常见 CSV/TSV，支持 BOM、引号内逗号与换行；分号方便兼容部分表格软件。 */
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const header = text.split(/\r?\n/, 1)[0];
    const delimiter = header.includes('\t') ? '\t' : header.includes(';') ? ';' : ',';
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i <= text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (char === delimiter || char === '\n' || char === undefined)) {
        row.push(cell.trim()); cell = '';
        if (char !== delimiter) { if (row.some(Boolean)) rows.push(row); row = []; }
      } else if (char !== '\r' || quoted) cell += char;
    }
    if (quoted) throw new Error('CSV 引号未闭合，请检查文件。');
    if (rows.length < 2) throw new Error('CSV 需要表头和至少一个颜色，示例：code,hex。');
    const keys = rows.shift().map(key => key.toLowerCase());
    return rows.map((values, i) => {
      if (values.length !== keys.length) throw new Error(`CSV 第 ${i + 2} 行列数与表头不一致。`);
      return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    });
  }

  /** 解析表格文件；JSON 接受颜色数组或含 colors 数组的对象，不执行文件中的代码。 */
  function parse(text, filename) {
    let rows, name;
    if (/\.json$/i.test(filename)) {
      let data;
      try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
      catch { throw new Error('JSON 格式有误，请检查括号、逗号和引号。'); }
      if (!data || typeof data !== 'object') throw new Error('JSON 需要颜色数组，或含 colors 数组的对象。');
      rows = Array.isArray(data) ? data : data.colors;
      name = !Array.isArray(data) && (data.name || data.title);
    } else rows = parseCSV(text);
    return { name: String(name || filename.replace(/\.[^.]+$/, '')).slice(0, 40), colors: validate(rows) };
  }

  /** 返回指定 RGB 在色卡中的最近色；相同距离保留色卡顺序，结果可重复。 */
  function nearest(rgb, colors) {
    const lab = toLab(rgb);
    return colors.reduce((best, color) => distance(lab, color.lab) < distance(lab, best.lab) ? color : best, colors[0]);
  }

  /**
   * 把非透明像素映射为真实色卡条目。先匹配全色卡，再按用量和感知差异选有限色集。
   * 减色只选择色卡已有的颜色；颜色、编号、统计与格子索引由同一结果返回。
   */
  function quantize(pixels, maxColors, colors) {
    const histogram = new Map();
    for (const rgb of pixels) {
      if (!rgb) continue;
      const key = rgb.join(',');
      if (histogram.has(key)) histogram.get(key).weight++;
      else histogram.set(key, { rgb, lab: toLab(rgb), weight: 1 });
    }
    const points = [...histogram.values()];
    if (!points.length) return { palette: [], cells: pixels.map(() => -1) };
    const weights = new Map();
    for (const point of points) {
      const color = colors.reduce((best, c) => distance(point.lab, c.lab) < distance(point.lab, best.lab) ? c : best, colors[0]);
      weights.set(color, (weights.get(color) || 0) + point.weight);
    }
    const ranked = [...weights.keys()].sort((a, b) => weights.get(b) - weights.get(a));
    const selected = [ranked[0]];
    while (selected.length < Math.min(maxColors, ranked.length)) {
      let best = null, score = -1;
      for (const color of ranked) {
        if (selected.includes(color)) continue;
        const value = Math.min(...selected.map(c => distance(c.lab, color.lab))) * Math.sqrt(weights.get(color));
        if (value > score) { best = color; score = value; }
      }
      selected.push(best);
    }
    const counts = new Map(), lookup = new Map();
    for (const point of points) {
      const best = selected.reduce((a, b) => distance(point.lab, b.lab) < distance(point.lab, a.lab) ? b : a);
      lookup.set(point.rgb.join(','), best.code);
      counts.set(best.code, (counts.get(best.code) || 0) + point.weight);
    }
    const palette = selected.filter(c => counts.has(c.code)).map(c => ({ ...c, count: counts.get(c.code) })).sort((a, b) => b.count - a.count);
    const indices = new Map(palette.map((c, index) => [c.code, index]));
    return { palette, cells: pixels.map(rgb => rgb ? indices.get(lookup.get(rgb.join(','))) : -1) };
  }

  return { normalizeHex, toLab, distance, validate, parse, nearest, quantize };
})();
