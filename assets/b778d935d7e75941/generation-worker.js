/* 图纸取样、色卡解析与感知匹配共用纯函数；编号和颜色始终来自同一个已校验条目。 */
globalThis.BeadPalettes = (() => {
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

  /**
   * 按 CIEDE2000 标准计算两个 D65 Lab 颜色的感知色差，返回非负距离。
   * 零彩度使用另一颜色的色相；蓝紫区域的旋转项按带符号交叉项参与计算。
   */
  function ciede2000(lab1, lab2) {
    const rad = Math.PI / 180;
    const c1 = Math.hypot(lab1[1], lab1[2]), c2 = Math.hypot(lab2[1], lab2[2]), cb = (c1 + c2) / 2;
    const g = .5 * (1 - Math.sqrt(Math.pow(cb, 7) / (Math.pow(cb, 7) + Math.pow(25, 7))));
    const a1 = lab1[1] * (1 + g), a2 = lab2[1] * (1 + g);
    const p1 = Math.hypot(a1, lab1[2]), p2 = Math.hypot(a2, lab2[2]);
    let h1 = Math.atan2(lab1[2], a1) / rad; if (h1 < 0) h1 += 360;
    let h2 = Math.atan2(lab2[2], a2) / rad; if (h2 < 0) h2 += 360;
    const dL = lab2[0] - lab1[0], dC = p2 - p1;
    let dh = 0;
    if (p1 * p2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
    const dH = 2 * Math.sqrt(p1 * p2) * Math.sin(dh / 2 * rad);
    const lb = (lab1[0] + lab2[0]) / 2, cp = (p1 + p2) / 2;
    let hp;
    if (p1 * p2 !== 0) {
      hp = (h1 + h2) / 2;
      if (Math.abs(h1 - h2) > 180) { if (h1 + h2 < 360) hp += 180; else hp -= 180; }
    // 任一颜色无彩度时，平均色相取两者之和，不能将有彩度一方的色相减半。
    } else hp = h1 + h2;
    const t = 1 - .17 * Math.cos((hp - 30) * rad) + .24 * Math.cos(2 * hp * rad) + .32 * Math.cos((3 * hp + 6) * rad) - .2 * Math.cos((4 * hp - 63) * rad);
    const dT = 30 * Math.exp(-Math.pow((hp - 275) / 25, 2));
    const rc = 2 * Math.sqrt(Math.pow(cp, 7) / (Math.pow(cp, 7) + Math.pow(25, 7)));
    const sl = 1 + .015 * Math.pow(lb - 50, 2) / Math.sqrt(20 + Math.pow(lb - 50, 2));
    const sc = 1 + .045 * cp, sh = 1 + .015 * cp * t;
    const rt = -Math.sin(2 * dT * rad) * rc;
    const x = dC / sc, y = dH / sh;
    // rt 自身已包含负号；再次相减会反转蓝紫区修正，使公开参考色差对失真。
    return Math.sqrt(Math.pow(dL / sl, 2) + x * x + y * y + rt * x * y);
  }

  /** 返回指定 RGB 在色卡中的最近色；相同距离保留色卡顺序，结果可重复。 */
  function nearest(rgb, colors) {
    const lab = toLab(rgb);
    let best = colors[0], bestDelta = ciede2000(lab, best.lab);
    for (let i = 1; i < colors.length; i++) {
      const delta = ciede2000(lab, colors[i].lab);
      if (delta < bestDelta) { best = colors[i]; bestDelta = delta; }
    }
    return best;
  }

  /**
   * 判断小尺寸取样帧是否具有明确的离散像素结构；不推断图片题材，也不改变用户设置。
   * image 为原始或有界缩小后的 ImageData；仅接受少量精确颜色、二值透明和连续相同像素。
   * 返回 true 时可按格子内的面积主色取样，避免规则像素边界混出原图不存在的颜色。
   */
  function* hasPixelStructureSteps(image) {
    const { data, width } = image;
    const colors = new Set();
    let repeated = 0, neighbors = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((i & 8191) === 0) yield;
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
   * image 来自本页自算的取样帧；width、height 为已校验的目标图纸尺寸。
   * 清晰像素结构使用面积主色，其余使用 alpha 加权均色；覆盖率不足一半仍留空。
   * 同格同时存在透明背景和不透明前景时分离边缘覆盖率与豆色；均匀半透明仍按白底合成。
   * demote 标记的像素（背景清理的贴边混色残带）只占覆盖率与去留，不参与配色与投票：
   * 格子里还有可信像素时豆色取自可信像素，只剩残带的格子留空。
   */
  function* sampleSteps(image, width, height, demote = null) {
    const { data, width: sw, height: sh } = image;
    // 仅在结构证据充分时保留离散主色；不要求用户选择图片模式。
    const crisp = yield* hasPixelStructureSteps(image);
    const pixels = [], sx = sw / width, sy = sh / height;
    for (let y = 0; y < height; y++) {
      // 分段点不改变遍历顺序，兼容路径在行间交还主线程。
      yield;
      for (let x = 0; x < width; x++) {
        const left = x * sx, right = (x + 1) * sx, top = y * sy, bottom = (y + 1) * sy;
        let alpha = 0, red = 0, green = 0, blue = 0, colorWeight = 0, minAlpha = 255, maxAlpha = 0;
        const votes = crisp ? new Map() : null;
        // 边缘源像素只贡献交叠面积，非整数缩放不会把边界格整颗重复计入。
        for (let iy = Math.floor(top); iy < Math.ceil(bottom) && iy < sh; iy++) {
          for (let ix = Math.floor(left); ix < Math.ceil(right) && ix < sw; ix++) {
            // 面积与 alpha 分开累计，透明背景中的 RGB 不参与前景颜色统计。
            const area = (Math.min(right, ix + 1) - Math.max(left, ix)) * (Math.min(bottom, iy + 1) - Math.max(top, iy));
            if (area <= 1e-9) continue;
            const i = (iy * sw + ix) * 4, a = data[i + 3], weight = area * a / 255;
            minAlpha = Math.min(minAlpha, a); maxAlpha = Math.max(maxAlpha, a);
            alpha += weight;
            if (demote && demote[iy * sw + ix]) continue;
            colorWeight += weight; red += data[i] * weight; green += data[i + 1] * weight; blue += data[i + 2] * weight;
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
          if (!votes.size) { pixels.push(null); continue; }
          let winner = 0, weight = -1;
          for (const [key, value] of votes) if (value > weight) { winner = key; weight = value; }
          // 离散像素不混色，透明占有率只决定是否放豆，不将边缘豆色掺白。
          pixels.push([winner >> 16, (winner >> 8) & 255, winner & 255]);
        } else {
          if (!colorWeight) { pixels.push(null); continue; }
          const edge = minAlpha <= 16 && maxAlpha >= 250;
          const opacity = edge ? 1 : coverage;
          // 只移除有透明背景证据的边缘白晕，保留有意半透明图片的白底视觉语义。
          pixels.push([red, green, blue].map(value => Math.round(value / colorWeight * opacity + 255 * (1 - opacity))));
        }
      }
    }
    return pixels;
  }

  /**
   * 把 RGB/null 格子映射为真实色卡；maxColors 为颜色上限，colors 为已校验的完整色卡。
   * 先保留原贪心色集作为起点，再做至多三轮受限色卡优化，降低原始格子的加权 Lab 平方误差。
   * 最终逐格映射与改色建议使用 CIEDE2000（感知更准）；选色与三轮优化仍用 Lab76（快一个量级）。
   * dither ∈ (0,1] 时按 Floyd–Steinberg 在 Lab 空间做误差扩散（需传图纸宽高）：
   * 相邻豆混出色卡没有的过渡色，空格阻断误差传播，强度按比例缩放误差；0 为关闭。
   * 返回同一份结果的 palette/cells，编号、RGB、数量及内部索引始终绑定；输入及旧作品不变。
   */
  function* quantizeSteps(pixels, maxColors, colors, dither = 0, width = 0, height = 0) {
    // UI 与旧调用共用此入口；非法强度按关闭处理，有效值限制在标准 FS 的 0～1。
    dither = Number.isFinite(dither) ? Math.max(0, Math.min(1, dither)) : 0;
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
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      if ((pointIndex & 63) === 0) yield;
      const point = points[pointIndex];
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
          if ((p & 63) === 0) yield;
        for (let c = 0; c < colors.length; c++) distances[p * colors.length + c] = distance(points[p].lab, colors[c].lab);
      }
      // 使用色卡原索引优化；输出时仍独立统计用量，不把候选顺序当作最终格子索引。
      const chosen = selected.map(color => colors.indexOf(color));
      for (let pass = 0; pass < 3; pass++) {
        const costs = new Float64Array(chosen.length * colors.length);
        for (let p = 0; p < points.length; p++) {
          if ((p & 63) === 0) yield;
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
    for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
      if ((pointIndex & 63) === 0) yield;
      const point = points[pointIndex];
      // 最终映射用 CIEDE2000：相同距离的并列保持色卡顺序，结果可重复。
      let best = selected[0], bestDelta = ciede2000(point.lab, best.lab);
      for (let i = 1; i < selected.length; i++) {
        const delta = ciede2000(point.lab, selected[i].lab);
        if (delta < bestDelta) { best = selected[i]; bestDelta = delta; }
      }
      lookup.set(point.rgb.join(','), best.code);
      counts.set(best.code, (counts.get(best.code) || 0) + point.weight);
    }
    // 无抖动时零用量色可直接移除；误差扩散可能重新用到这些色，必须保留完整选定色集。
    const diffuse = dither > 0 && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height === pixels.length;
    const candidates = diffuse ? selected : selected.filter(c => counts.has(c.code));
    const palette = candidates.map(c => ({ ...c, count: counts.get(c.code) || 0 })).sort((a, b) => b.count - a.count);
    const indices = new Map(palette.map((c, index) => [c.code, index]));
    if (!diffuse) {
      return { palette, cells: pixels.map(rgb => rgb ? indices.get(lookup.get(rgb.join(','))) : -1) };
    }
    // Floyd–Steinberg 误差扩散：每格取最近色后，误差按 7/16 右、3/16 左下、5/16 下、1/16 右下
    // 传给未处理的非空邻居；空格（背景）阻断传播。误差乘 dither 控制强度，1 为标准 FS。
    const labCache = new Map();
    const cellLab = rgb => {
      const key = rgb.join(',');
      let lab = labCache.get(key);
      if (!lab) { lab = toLab(rgb); labCache.set(key, lab); }
      return lab;
    };
    const errors = new Float32Array(width * height * 3);
    const cells = new Array(width * height);
    const ditherCounts = new Map();
    for (let y = 0; y < height; y++) {
      // 分段点不改变遍历顺序，兼容路径在行间交还主线程。
      yield;
      for (let x = 0; x < width; x++) {
        const i = y * width + x, rgb = pixels[i];
        if (!rgb) { cells[i] = -1; continue; }
        const lab = cellLab(rgb);
        const target = [lab[0] + errors[i * 3], lab[1] + errors[i * 3 + 1], lab[2] + errors[i * 3 + 2]];
        let pick = 0, pickDelta = ciede2000(target, palette[0].lab);
        for (let p = 1; p < palette.length; p++) {
          const delta = ciede2000(target, palette[p].lab);
          if (delta < pickDelta) { pick = p; pickDelta = delta; }
        }
        cells[i] = pick;
        ditherCounts.set(palette[pick].code, (ditherCounts.get(palette[pick].code) || 0) + 1);
        const e0 = (target[0] - palette[pick].lab[0]) * dither;
        const e1 = (target[1] - palette[pick].lab[1]) * dither;
        const e2 = (target[2] - palette[pick].lab[2]) * dither;
        const push = (nx, ny, weight) => {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
          const j = ny * width + nx;
          if (!pixels[j]) return;
          errors[j * 3] += e0 * weight; errors[j * 3 + 1] += e1 * weight; errors[j * 3 + 2] += e2 * weight;
        };
        push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
      }
    }
    // 扩散后用量与色号成员都会变，重建调色板并把格子索引重映射到新顺序。
    const dithered = palette.filter(c => ditherCounts.has(c.code)).map(c => ({ ...c, count: ditherCounts.get(c.code) })).sort((a, b) => b.count - a.count);
    const remap = new Map(dithered.map((c, index) => [c.code, index]));
    return { palette: dithered, cells: cells.map(index => index < 0 ? -1 : remap.get(palette[index].code)) };
  }

  /**
   * 清理量化后的格子：先修正孤格，再把不超过 minArea 格的连通色块并进接触最多的邻色。
   * 只改写格子索引并重建用量，不新增色号、不改动留空区域；调用方关闭该选项时直接跳过。
   */
  function* refineSteps(result, width, height, minArea = 1) {
    const { palette } = result, grid = result.cells.slice();
    if (!palette.length || grid.length !== width * height) return result;
    // 第一遍：同色邻居不足两格、四周又被另一色几乎占满的格子视为杂点，改成该主色。
    // 替换会改变邻域统计，所以按轮推进；主色扩展后，贴着边缘的杂点在第二轮一并收敛。
    for (let round = 0; round < 2; round++) {
      const source = grid.slice();
      let changed = false;
      for (let y = 0; y < height; y++) {
      // 分段点不改变遍历顺序，兼容路径在行间交还主线程。
      yield;
        for (let x = 0; x < width; x++) {
          const index = source[y * width + x];
          if (index < 0) continue;
          const votes = new Map();
          let same = 0, count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              // 留空格不投票，透明边界不能当作颜色证据把边缘豆拉向深色。
              if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
              const value = source[ny * width + nx];
              if (value < 0) continue;
              count++;
              votes.set(value, (votes.get(value) || 0) + 1);
              if (value === index) same++;
            }
          }
          // 两格以上同色说明是有意的细节，例如眼睛、装饰点，保留不动。
          if (same > 1 || count < 5) continue;
          let winner = -1, top = 0;
          for (const [value, weight] of votes) if (weight > top) { winner = value; top = weight; }
          if (winner >= 0 && top > same && top >= count - 1) { grid[y * width + x] = winner; changed = true; }
        }
      }
      if (!changed) break;
    }
    // 第二遍：把零碎小色块并进边界接触最长的邻色，修掉毛边和二连格；同长时取颜色更接近的。
    const visited = new Uint8Array(grid.length), stack = [], group = [];
    for (let start = 0; start < grid.length; start++) {
      if ((start & 255) === 0) yield;
      const index = grid[start];
      if (visited[start] || index < 0) continue;
      group.length = 0; stack.push(start); visited[start] = 1;
      while (stack.length) {
        if ((group.length & 511) === 0) yield;
        const cell = stack.pop(); group.push(cell);
        const x = cell % width;
        const around = [x > 0 ? cell - 1 : -1, x < width - 1 ? cell + 1 : -1, cell >= width ? cell - width : -1, cell < grid.length - width ? cell + width : -1];
        for (const next of around) if (next >= 0 && !visited[next] && grid[next] === index) { visited[next] = 1; stack.push(next); }
      }
      if (group.length > minArea) continue;
      const borders = new Map();
      let red = 0, green = 0, blue = 0;
      for (const cell of group) {
        const rgb = palette[index].rgb;
        red += rgb[0]; green += rgb[1]; blue += rgb[2];
        const x = cell % width;
        const around = [x > 0 ? cell - 1 : -1, x < width - 1 ? cell + 1 : -1, cell >= width ? cell - width : -1, cell < grid.length - width ? cell + width : -1];
        for (const next of around) {
          if (next < 0) continue;
          const value = grid[next];
          if (value >= 0 && value !== index) borders.set(value, (borders.get(value) || 0) + 1);
        }
      }
      // 四周只有留空格的色块保持原样，那是图形的真实外沿。
      if (!borders.size) continue;
      const mean = toLab([red / group.length, green / group.length, blue / group.length]);
      let target = -1, length = 0;
      for (const [value, weight] of borders) {
        if (weight > length || (weight === length && target >= 0 && distance(mean, palette[value].lab) < distance(mean, palette[target].lab))) {
          target = value; length = weight;
        }
      }
      for (const cell of group) grid[cell] = target;
    }
    // 用量按清理后的格子重算，被清理干净的色号一起退出清单，索引重新绑定。
    const counts = new Array(palette.length).fill(0);
    for (const index of grid) if (index >= 0) counts[index]++;
    const kept = palette.map((color, index) => ({ color, count: counts[index] }))
      .filter(item => item.count > 0).sort((a, b) => b.count - a.count);
    const lookup = new Map(kept.map((item, index) => [item.color.code, index]));
    return {
      palette: kept.map(({ color, count }) => ({ ...color, count })),
      cells: grid.map(index => index < 0 ? -1 : lookup.get(palette[index].code))
    };
  }

  /** 以相同顺序完成可分段计算；同步入口供校验、固定样本和无副作用参考使用。 */
  function finishSteps(steps) {
    let step;
    // 只消费同一计算器，不另维护同步算法。
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  /** 同步取样接口；参数和返回值沿用原 API，后台管线使用 sampleSteps。 */
  function sample(...args) {
    // 同步参考与后台计算共用逐格取样。
    return finishSteps(sampleSteps(...args));
  }

  /** 同步限色接口；第七个参数为 fs／smart／riemersma，缺失按原 FS 处理。 */
  function quantize(...args) {
    // 同步参考与后台计算共用选色、扩散及最终用量重建。
    return finishSteps(quantizeSteps(...args));
  }

  /** 同步杂点清理接口；不改变颜色成员、留空区域或原有清理规则。 */
  function refine(...args) {
    // 保留既有调用入口，实际实现仅有可分段版本。
    return finishSteps(refineSteps(...args));
  }

  return { normalizeHex, toLab, distance, ciede2000, validate, parse, nearest, sample, refine, quantize, sampleSteps, refineSteps, quantizeSteps };
})();

/** 图纸共用计算运行时：主线程、兼容分段执行和 Worker 只维护这一套算法。 */
globalThis.BeadEngine = (() => {
'use strict';
const P = globalThis.BeadPalettes;
// 按源帧对象缓存主体分析；换源和 Worker 终止后可回收。
const subjectCache = new WeakMap();

/** 创建 1:1 读回的工作表面；不借用浏览器缩放核，不依赖页面状态。 */
function makeSurface() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1);
  // 老浏览器兼容路径仍使用相同采样器，执行器会在分段点让出主线程。
  return document.createElement('canvas');
}

/** 完成同一分段器，返回整份结果；仅用于同步参考及小型初始化。 */
function complete(steps) {
  let step;
  // 同步和后台不会分叉出另一套算法。
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

/** 按约 8ms 预算推进计算；signal 失效时停止，不产生半份结果。 */
async function cooperative(steps, signal = () => false) {
  let step, start = performance.now();
  while (true) {
    if (signal()) throw new DOMException('计算已取消', 'AbortError');
    // 每次推进只跨越预先定义的小块计算。
    step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - start >= 8) {
      // 定时任务让出绘制和输入机会；后台页也能推进，不依赖 requestAnimationFrame。
      await new Promise(resolve => setTimeout(resolve, 0));
      start = performance.now();
    }
  }
}

/** 泛洪识别在多小的帧上做：最长边约 512 像素，小图保持原分辨率，几毫秒内完成。 */
const WORK_LIMIT = 512;

/**
 * 估计背景颜色：取四边 2 格厚的边框条带里不透明像素的 Lab 中位数。
 * 中位数抗边框上的小杂物；全部透明则返回 transparent 模式，由 alpha 直接判定。
 * opaque 为 false 表示图片自带透明通道，调用方应直接沿用旧路径，不做识别。
 */
function* estimateBackgroundSteps(frame) {
  const { data, width: w, height: h } = frame;
  const strip = 2;
  const labs = [];
  let minAlpha = 255;
  for (let i = 3; i < data.length; i += 4) if (data[i] < minAlpha) minAlpha = data[i];
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      if (x >= strip && x < w - strip && y >= strip && y < h - strip) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 250) continue;
      labs.push(P.toLab([data[i], data[i + 1], data[i + 2]]));
    }
  }
  if (!labs.length) return { opaque: minAlpha >= 250, mode: 'transparent', lab: null };
  // 逐通道取中位数；Lab 各通道独立排序即可，边框颜色接近时误差远小于容差。
  const median = channel => {
    const values = labs.map(lab => lab[channel]).sort((a, b) => a - b);
    return values[values.length >> 1];
  };
  return { opaque: minAlpha >= 250, mode: 'solid', lab: [median(0), median(1), median(2)] };
}

/**
 * 从四边种子向内泛洪，标记与外部连通的背景格。
 * 双阈值滞回：强匹配决定「泛洪能在哪里流动」，弱匹配决定「强背景外围清除哪一圈」。
 * 强阈值取容差的四分之一（下限 2）：真实背景平坦，色差几乎为 0；
 * 而与背景只差 ΔE5~12 的浅色主体（白发、浅紫发、肤色边缘）不构成流动通道，
 * 泛洪无法成片吞掉，只会被弱圈层吃掉最外圈抗锯齿混色缝。
 * lab 为帧的逐格 Lab 缓存（可传 null，由本函数就地计算并写回）。
 * 返回标记数组（0 前景 / 1 强背景 / 2 弱背景）与背景格数；人物内部不与边缘连通的同色区域保持前景。
 */
function* floodBackgroundSteps(frame, bg, tolerance, labs = null) {
  const { data, width: w, height: h } = frame;
  const total = w * h;
  const mask = new Uint8Array(total);
  if (!labs) { labs = new Float32Array(total * 3); yield* fillLabsSteps(frame, labs); }
  const weakLimit = tolerance * tolerance;
  const strongTol = Math.min(tolerance, Math.max(2, tolerance / 4));
  const strongLimit = strongTol * strongTol;
  const solid = bg.mode === 'solid';
  // 每格的匹配级别：0 不匹配、1 弱、2 强；透明像素始终按强处理。
  const near = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if ((i & 2047) === 0) yield;
    if (data[i * 4 + 3] < 16) { near[i] = 2; continue; }
    if (!solid) continue;
    const d = P.distance([labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]], bg.lab);
    near[i] = d <= strongLimit ? 2 : (d <= weakLimit ? 1 : 0);
  }
  const queue = new Int32Array(total);
  let head = 0, tail = 0, count = 0;
  const mark = index => {
    if (mask[index] || near[index] !== 2) return;
    mask[index] = 1; count++; queue[tail++] = index;
  };
  for (let x = 0; x < w; x++) { mark(x); mark((h - 1) * w + x); }
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield; mark(y * w); mark(y * w + w - 1); }
  while (head < tail) {
    if ((head & 1023) === 0) yield;
    const index = queue[head++];
    const x = index % w, y = (index - x) / w;
    if (x > 0) mark(index - 1);
    if (x < w - 1) mark(index + 1);
    if (y > 0) mark(index - w);
    if (y < h - 1) mark(index + w);
  }
  // 弱层只从强背景向外扩一整圈（8 邻域）：收走抗锯齿缝与轻微光晕，止步于浅色主体。
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (mask[index] || near[index] !== 1) continue;
      let touch = false;
      for (let dy = -1; dy <= 1 && !touch; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (mask[ny * w + nx] === 1) { touch = true; break; }
        }
      }
      if (touch) { mask[index] = 2; count++; }
    }
  }
  return { mask, count, labs, near };
}

/**
 * 弱像素浅带：从已清除的背景出发，在未被清除的「弱匹配」像素里按 BFS 距离
 * 标出贴边浅带（默认 3 格深，棋盘距离）。浅带多半是抗锯齿混色与 JPEG 噪声的
 * 半程残余——清除它们会误伤细发丝，保留则让轮廓渲染成脏灰色；调用方据此让
 * 浅带像素只占格子覆盖率、不参与配色，纯浅带格子直接留空。
 * 深处的弱像素（浅色主体内部、被主体包住的浅色区）距离背景远，不受影响。
 */
function* shallowBandSteps(frame, flood, depth = 3) {
  const { width: w, height: h } = frame;
  const total = w * h;
  const band = new Uint8Array(total);
  const { mask, near } = flood;
  const dist = new Int16Array(total).fill(-1);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  for (let i = 0; i < total; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    if ((head & 1023) === 0) yield;
    const index = queue[head++], d = dist[index];
    if (d >= depth) continue;
    const x = index % w, y = (index - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        const n = ny * w + nx;
        if (dist[n] >= 0 || mask[n] || near[n] !== 1) continue;
        dist[n] = d + 1;
        band[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  return band;
}

/** 把帧的 RGB 逐格转成 Lab，缓存后多次泛洪不再重复换算。 */
function* fillLabsSteps(frame, labs) {
  const { data } = frame;
  const rgb = [0, 0, 0];
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    if ((i & 8191) === 0) yield;
    rgb[0] = data[i]; rgb[1] = data[i + 1]; rgb[2] = data[i + 2];
    const lab = P.toLab(rgb);
    labs[j] = lab[0]; labs[j + 1] = lab[1]; labs[j + 2] = lab[2];
  }
}

/**
 * 主体边界：前景（非背景）格的外接矩形，先剥掉孤立噪点再量边界。
 * 只有 8 邻域内前景数不足 2 的格视为噪点，不参与边界；发丝、对角细线仍保留。
 * 返回帧坐标的 bounds，前景过少（识别失败）时返回 null。
 */
function* subjectBoundsSteps(frame, bgMask) {
  const { width: w, height: h } = frame;
  const total = w * h, fg = new Uint8Array(total);
  let count = 0;
  for (let i = 0; i < total; i++) if (!bgMask[i]) { fg[i] = 1; count++; }
  if (count < total * .005) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    if ((y & 7) === 0) yield;
    for (let x = 0; x < w; x++) {
      const index = y * w + x;
      if (!fg[index]) continue;
      let neighbors = 0;
      for (let dy = -1; dy <= 1 && neighbors < 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (fg[ny * w + nx] && ++neighbors >= 2) break;
        }
      }
      if (neighbors < 2) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * 留白裁剪计划：主体外扩 margin 格，同时保持用户设置的最长边不变。
 * 每格对应的源像素由主体最长边除以「最长边 − 两侧留白」得出，留白挤占的是主体精度而不是网格尺寸。
 * 返回取样用的源图矩形与最终网格尺寸；margin 会让小格数图纸放不下留白，此时按剩余空间收缩。
 */
function* planCropSteps(bounds, longest, margin, sourceWidth, sourceHeight) {
  margin = Math.max(0, Math.min(margin, Math.floor((longest - 8) / 2)));
  const subjectW = Math.max(1, bounds.width), subjectH = Math.max(1, bounds.height);
  const cell = Math.max(subjectW, subjectH) / Math.max(8, longest - 2 * margin);
  const width = Math.min(128, Math.max(1, Math.round(subjectW / cell)) + 2 * margin);
  const height = Math.min(128, Math.max(1, Math.round(subjectH / cell)) + 2 * margin);
  const left = Math.max(0, Math.min(sourceWidth - 1, Math.round(bounds.x - margin * cell)));
  const top = Math.max(0, Math.min(sourceHeight - 1, Math.round(bounds.y - margin * cell)));
  const rect = {
    x: left, y: top,
    width: Math.max(1, Math.min(sourceWidth - left, Math.round(subjectW + 2 * margin * cell))),
    height: Math.max(1, Math.min(sourceHeight - top, Math.round(subjectH + 2 * margin * cell)))
  };
  return { rect, width, height };
}

/**
 * 把泛洪结果写进取样帧的 alpha：背景格透明，前景格保留原值。
 * 帧是二值透明（0/255），sample() 的边缘去光晕分支会自动只统计前景颜色，不把背景白掺进轮廓。
 * 返回被清成空白的格数占比；几乎为 0 说明这帧没有可用背景，调用方应退回整图路径。
 */
function* applySubjectMaskSteps(frame, mask) {
  const { data } = frame;
  let cleared = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (data[i * 4 + 3]) { data[i * 4 + 3] = 0; cleared++; }
  }
  return cleared / mask.length;
}

function patternSize(source, longest) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  const ratio = longest / Math.max(width, height);
  return [Math.max(1, Math.round(width * ratio)), Math.max(1, Math.round(height * ratio))];
}

function* samplingFrameSteps(source, width, height, rect = null) {
  const rx = rect ? rect.x : 0, ry = rect ? rect.y : 0;
  const sw = rect ? rect.width : source.naturalWidth || source.width;
  const sh = rect ? rect.height : source.naturalHeight || source.height;
  const bw = Math.min(sw, Math.max(1, width * 4)), bh = Math.min(sh, Math.max(1, height * 4));
  const acc = new Float64Array(bw * bh * 4), weight = new Uint32Array(bw * bh);
  // 源像素落在哪个取样格，预先算成查表；否则几百万像素的内层循环每步都要做一次除法。
  const column = new Int32Array(sw), rowOrigin = new Int32Array(sh);
  for (let x = 0; x < sw; x++) column[x] = Math.floor(x * bw / sw);
  for (let y = 0; y < sh; y++) rowOrigin[y] = Math.floor(y * bh / sh) * bw;
  const tile = makeSurface();
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
        if ((y & 15) === 0) yield;
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

function* planSubjectSteps(source, settings) {
  const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
  let cache = subjectCache.get(source);
  if (!cache) {
    // 工作帧最长边约 512 像素；samplingFrame 的帧尺寸是网格的 4 倍，按比例反推网格。
    const ratio = Math.min(1, WORK_LIMIT / Math.max(sw, sh));
    const frame = yield* samplingFrameSteps(source, Math.max(1, Math.round(sw * ratio / 4)), Math.max(1, Math.round(sh * ratio / 4)));
    const bg = yield* estimateBackgroundSteps(frame);
    const labs = new Float32Array(frame.width * frame.height * 3);
    yield* fillLabsSteps(frame, labs);
    cache = { frame, bg, labs };
    subjectCache.set(source, cache);
  }
  // 图片自带透明通道时，空白格本来就存在；不重复识别，行为与旧版完全一致。
  if (!cache.bg.opaque) return null;
  const flood = yield* floodBackgroundSteps(cache.frame, cache.bg, settings.tolerance, cache.labs);
  if (flood.count < cache.frame.width * cache.frame.height * .02) return null;
  const bounds = yield* subjectBoundsSteps(cache.frame, flood.mask);
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
  return { bg: cache.bg, ...yield* planCropSteps(boundsPx, settings.longest, settings.margin, sw, sh) };
}

function* calculateSteps(source, parameters, colors) {
  // 沿用现有格数、色数上限；背景清理不改变保存格式，只影响取样范围与空白格。
  const longest = parameters.longest, colorLimit = parameters.maxColors;
  // 渐变过渡（抖动）强度 0~100% → 0~1；默认关闭，行为与旧版一致。
  const dither = parameters.dither / 100;
  const settings = { longest, remove: parameters.background.remove, tolerance: parameters.background.tolerance, margin: parameters.background.margin };
  // 先识别主体、确定留白裁剪，再在裁剪后的取样帧上按同一容差泛洪写透明。
  let plan = settings.remove ? (yield* planSubjectSteps(source, settings)) : null;
  let width = 0, height = 0, frame = null, removed = 0, shallow = null;
  if (plan) {
    width = plan.width; height = plan.height;
    frame = yield* samplingFrameSteps(source, width, height, plan.rect);
    const flood = yield* floodBackgroundSteps(frame, plan.bg, settings.tolerance);
    removed = yield* applySubjectMaskSteps(frame, flood.mask);
    // 裁剪后的边框上找不到背景（留白被原图边界顶满、容差在细分辨率下失配），退回整图。
    if (removed < .02) plan = frame = null;
    // 贴边混色残带只占覆盖率不配色：轮廓豆色取自主体本体，纯残带格子留空。
    else shallow = yield* shallowBandSteps(frame, flood);
  }
  if (!plan) [width, height] = patternSize(source, longest);
  // 覆盖率决定留空，取样器自动保留明确像素结构，无需用户选择模式。
  if (!frame) frame = yield* samplingFrameSteps(source, width, height);
  const pixels = yield* P.sampleSteps(frame, width, height, shallow);
  // 在真实色卡上优化有限色集；结果生成成功后，调用方才替换当前作品。
  const result = yield* P.quantizeSteps(pixels, colorLimit, colors, dither, width, height, parameters.ditherMode || 'fs');
  const background = plan ? { rect: plan.rect, removed } : null;
  // 抖动点是主动生成的过渡色，后续清理会把它们当杂点抹掉；开启时保留，关闭后沿用清理偏好。
  if (dither > 0 || !parameters.denoise) return { ...result, width, height, background };
  // 无抖动时才按图纸密度清理抗锯齿混色与柔和阴影留下的孤格。
  const cleaned = yield* P.refineSteps(result, width, height, Math.min(2, Math.floor(Math.max(width, height) / 40) + 1));
  return { ...cleaned, width, height, background };
}


const subject = { WORK_LIMIT, estimateBackground: (...args) => complete(estimateBackgroundSteps(...args)), floodBackground: (...args) => complete(floodBackgroundSteps(...args)), shallowBand: (...args) => complete(shallowBandSteps(...args)), fillLabs: (...args) => complete(fillLabsSteps(...args)), subjectBounds: (...args) => complete(subjectBoundsSteps(...args)), planCrop: (...args) => complete(planCropSteps(...args)), applySubjectMask: (...args) => complete(applySubjectMaskSteps(...args)) };
return { subject, patternSize, samplingFrame: (...args) => complete(samplingFrameSteps(...args)), calculate: (...args) => complete(calculateSteps(...args)), calculateSteps, cooperative };
})();

/** 构建将同一份 palettes.js/engine.js 放在本入口之前，网站与离线不各写算法。 */
self.onmessage = event => {
  const { epoch, source, parameters, colors } = event.data;
  try {
    // Worker 中无页面状态，结果仅包含本请求的格子、色号、用量及裁剪信息。
    const result = self.BeadEngine.calculate(source, parameters, colors);
    self.postMessage({ epoch, result });
  } catch (error) {
    // 明确的计算错误交回业务层，旧作品由主线程保留。
    self.postMessage({ epoch, error: error.message || '图纸计算失败' });
  } finally {
    // 主线程已移交位图，处理结束立即归还图形内存。
    source.close();
  }
};
// 握手成功后主线程才移交源帧，初始化失败可走分段兼容路径。
self.postMessage({ ready: true });
