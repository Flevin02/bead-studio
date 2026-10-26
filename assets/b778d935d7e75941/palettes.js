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
