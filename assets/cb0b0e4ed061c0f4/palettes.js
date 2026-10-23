/* 图纸取样、色卡解析与感知匹配共用纯函数；编号和颜色始终来自同一个已校验条目。 */
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
   * 判断小尺寸取样帧是否具有明确的离散像素结构；不推断图片题材，也不改变用户设置。
   * image 为原始或有界缩小后的 ImageData；仅接受少量精确颜色、二值透明和连续相同像素。
   * 返回 true 时可按格子内的面积主色取样，避免规则像素边界混出原图不存在的颜色。
   */
  function hasPixelStructure(image) {
    const { data, width } = image;
    const colors = new Set();
    let repeated = 0, neighbors = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha !== 0 && alpha !== 255) return false;
      if (!alpha) continue;
      // 颜色总量设严格上限；照片通常很快退出，不对整张照片做昂贵分类。
      colors.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (colors.size > 64) return false;
      for (const offset of [i % (width * 4) ? 4 : 0, i >= width * 4 ? width * 4 : 0]) {
        if (!offset || data[i - offset + 3] !== 255) continue;
        neighbors++;
        if (data[i] === data[i - offset] && data[i + 1] === data[i - offset + 1] && data[i + 2] === data[i - offset + 2]) repeated++;
      }
    }
    return colors.size > 0 && neighbors > 0 && repeated / neighbors >= .6;
  }

  /**
   * 将有界 RGBA 帧按真实面积交叠取样为 width × height 个格子，返回 RGB 或留空 null。
   * image 来自浏览器解码的固定源帧；width、height 为已校验的目标图纸尺寸。
   * smoothed 可提供同源的目标尺寸平滑帧；连续不透明图沿用它，避免面积取样增加照片纹理杂豆。
   * 清晰像素结构使用面积主色，其余使用 alpha 加权均色；覆盖率不足一半仍留空。
   * 同格同时存在透明背景和不透明前景时分离边缘覆盖率与豆色；均匀半透明仍按白底合成。
   */
  function sample(image, width, height, smoothed = null) {
    const { data, width: sw, height: sh } = image;
    // 仅在结构证据充分时保留离散主色；不要求用户选择图片模式。
    const crisp = hasPixelStructure(image);
    if (smoothed && !crisp) {
      let opaque = true;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { opaque = false; break; }
      if (opaque) {
        const pixels = [], frame = smoothed.data;
        // 照片保持既有平滑强度；新的限色优化独立降低配色误差，不额外锐化细碎纹理。
        for (let i = 0; i < frame.length; i += 4) pixels.push([frame[i], frame[i + 1], frame[i + 2]]);
        return pixels;
      }
    }
    const pixels = [], sx = sw / width, sy = sh / height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const left = x * sx, right = (x + 1) * sx, top = y * sy, bottom = (y + 1) * sy;
        let alpha = 0, red = 0, green = 0, blue = 0, minAlpha = 255, maxAlpha = 0;
        const votes = crisp ? new Map() : null;
        // 边缘源像素只贡献交叠面积，非整数缩放不会把边界格整颗重复计入。
        for (let iy = Math.floor(top); iy < Math.ceil(bottom) && iy < sh; iy++) {
          for (let ix = Math.floor(left); ix < Math.ceil(right) && ix < sw; ix++) {
            // 面积与 alpha 分开累计，透明背景中的 RGB 不参与前景颜色统计。
            const area = (Math.min(right, ix + 1) - Math.max(left, ix)) * (Math.min(bottom, iy + 1) - Math.max(top, iy));
            if (area <= 1e-9) continue;
            const i = (iy * sw + ix) * 4, a = data[i + 3], weight = area * a / 255;
            minAlpha = Math.min(minAlpha, a); maxAlpha = Math.max(maxAlpha, a);
            alpha += weight; red += data[i] * weight; green += data[i + 1] * weight; blue += data[i + 2] * weight;
            if (votes && weight) {
              const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
              // 像素画按覆盖面积投票；同量保留源图扫描顺序，使结果可重复。
              votes.set(key, (votes.get(key) || 0) + weight);
            }
          }
        }
        const coverage = alpha / (sx * sy);
        if (coverage < .5 - 1e-9 || !alpha) { pixels.push(null); continue; }
        if (votes) {
          let winner = 0, weight = -1;
          for (const [key, value] of votes) if (value > weight) { winner = key; weight = value; }
          // 离散像素不混色，透明占有率只决定是否放豆，不将边缘豆色掺白。
          pixels.push([winner >> 16, (winner >> 8) & 255, winner & 255]);
        } else {
          const edge = minAlpha <= 16 && maxAlpha >= 250;
          const opacity = edge ? 1 : coverage;
          // 只移除有透明背景证据的边缘白晕，保留有意半透明图片的白底视觉语义。
          pixels.push([red, green, blue].map(value => Math.round(value / alpha * opacity + 255 * (1 - opacity))));
        }
      }
    }
    return pixels;
  }

  /**
   * 把 RGB/null 格子映射为真实色卡；maxColors 为颜色上限，colors 为已校验的完整色卡。
   * 先保留原贪心色集作为起点，再做至多三轮受限色卡优化，降低原始格子的加权 Lab 平方误差。
   * 每轮只替换能降低所属格子总误差的色号；不清除孤立格，也不合并或改写图形轮廓。
   * 返回同一份结果的 palette/cells，编号、RGB、数量及内部索引始终绑定；输入及旧作品不变。
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
    if (ranked.length > maxColors) {
      // 每个原始颜色与真实色卡的距离仅计算一次；32位缓存控制最大图纸的临时内存。
      const distances = new Float32Array(points.length * colors.length);
      for (let p = 0; p < points.length; p++) {
        for (let c = 0; c < colors.length; c++) distances[p * colors.length + c] = distance(points[p].lab, colors[c].lab);
      }
      // 使用色卡原索引优化；输出时仍独立统计用量，不把候选顺序当作最终格子索引。
      const chosen = selected.map(color => colors.indexOf(color));
      for (let pass = 0; pass < 3; pass++) {
        const costs = new Float64Array(chosen.length * colors.length);
        for (let p = 0; p < points.length; p++) {
          const row = p * colors.length;
          let slot = 0;
          for (let s = 1; s < chosen.length; s++) if (distances[row + chosen[s]] < distances[row + chosen[slot]]) slot = s;
          // 对该组的原始颜色评估完整色卡，允许找到旧最近色候选之外的折中豆色。
          for (let c = 0; c < colors.length; c++) costs[slot * colors.length + c] += distances[row + c] * points[p].weight;
        }
        let changed = false;
        for (let s = 0; s < chosen.length; s++) {
          const row = s * colors.length;
          let best = chosen[s];
          for (let c = 0; c < colors.length; c++) {
            // 不产生重复色号；零收益保持原选择，避免色集在相同误差下反复跳动。
            if (!chosen.includes(c) && costs[row + c] < costs[row + best] - 1e-6) best = c;
          }
          if (best !== chosen[s]) { chosen[s] = best; changed = true; }
        }
        if (!changed) break;
      }
      for (let s = 0; s < selected.length; s++) selected[s] = colors[chosen[s]];
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

  return { normalizeHex, toLab, distance, validate, parse, nearest, sample, quantize };
})();
