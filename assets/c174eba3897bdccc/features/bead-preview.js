/** 只读立体拼豆预览：实例几何来自已应用格子，查看角度不进入作品或二维导出。 */
import { $, state } from '../core/state.js';
import { editorHasDraft } from './editor.js';
import { waitForGeneration } from './pattern.js';
import { cellAt } from './renderer.js';
import { toast } from './shell.js';

// 当前作品仅缓存一个实例模型和独立视角；离开时停止绘制，换图或模型变化才释放。
let beadPreview = null;

/** 生成一颗带中孔、外壁、内壁和上下表面的豆子；尺寸单位为一格。 */
function beadMesh() {
  const vertices = [], segments = 20, outside = .44, inside = .16, halfHeight = .29;
  const ring = (radius, angle, z) => [radius * Math.cos(angle), radius * Math.sin(angle), z];
  const face = (a, b, c, d, normal) => {
    for (const point of [a, b, c, a, c, d]) vertices.push(...point, ...normal);
  };
  for (let i = 0; i < segments; i++) {
    const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments, middle = (a + b) / 2;
    // 四个环面共用同一拓扑，中心留空，不能用实心圆柱冒充中孔。
    face(ring(outside, a, halfHeight), ring(outside, b, halfHeight), ring(inside, b, halfHeight), ring(inside, a, halfHeight), [0, 0, 1]);
    face(ring(inside, a, -halfHeight), ring(inside, b, -halfHeight), ring(outside, b, -halfHeight), ring(outside, a, -halfHeight), [0, 0, -1]);
    face(ring(outside, a, -halfHeight), ring(outside, b, -halfHeight), ring(outside, b, halfHeight), ring(outside, a, halfHeight), [Math.cos(middle), Math.sin(middle), 0]);
    face(ring(inside, a, halfHeight), ring(inside, b, halfHeight), ring(inside, b, -halfHeight), ring(inside, a, -halfHeight), [-Math.cos(middle), -Math.sin(middle), 0]);
  }
  return new Float32Array(vertices);
}

/** 编译本地固定 shader，失败保留日志供定位，并交由弹窗显示二维降级说明。 */
function beadShader(gl, type, source) {
  const shader = gl.createShader(type);
  // shader 是随源码固定的文本，不接受图片、色卡或用户输入代码。
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || '3D 着色器无法编译');
  }
  return shader;
}

/** 按当前镜像读格子，生成位置与参考 RGB；每颗豆仅占六个浮点实例值。 */
function beadInstances() {
  const instances = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      // 镜像使用既有 cellAt 坐标转换，不重排作品底层格子。
      const index = cellAt(x, y);
      if (index < 0) continue;
      instances.push(x + .5 - state.width / 2, state.height / 2 - y - .5, 0, ...state.palette[index].rgb.map(value => value / 255));
    }
  }
  return new Float32Array(instances);
}

/** 按独立视角重绘；静止时不请求下一帧，也不修改二维缩放与阅读中心。 */
function drawBeadPreview() {
  const view = beadPreview;
  if (!view || view.lost || $('bead3DView').hidden) return;
  const { gl, canvas, program } = view, area = $('bead3DStage');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.min(1800, Math.round(area.clientWidth * ratio)));
  canvas.height = Math.max(1, Math.min(1400, Math.round(area.clientHeight * ratio)));
  const dark = document.documentElement.dataset.theme === 'dark';
  // 背景跟随主题，豆色与材质始终来自当前已应用色卡。
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(...(dark ? [.085, .09, .12, 1] : [.96, .955, .975, 1]));
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, 'angle'), view.yaw, view.tilt);
  const aspect = canvas.width / canvas.height;
  // 初始视角按实际有豆范围适配，避免小作品在手机上缩成一小团；旋转时保持同一倍率。
  const projectedWidth = view.bounds.width * Math.cos(.2) + view.bounds.height * Math.sin(.2);
  const projectedHeight = (view.bounds.width * Math.sin(.2) + view.bounds.height * Math.cos(.2)) * Math.cos(.7) + .6 * Math.sin(.7);
  gl.uniform2f(gl.getUniformLocation(program, 'center'), view.bounds.x, view.bounds.y);
  gl.uniform2f(gl.getUniformLocation(program, 'projection'), 1.8 * view.zoom * Math.min(aspect / projectedWidth, 1 / projectedHeight), aspect);
  gl.bindVertexArray(view.vao);
  // 同一颗豆的网格复用到所有实例，一次调用绘制整个成品。
  gl.drawArraysInstanced(gl.TRIANGLES, 0, view.vertices, view.count);
  $('bead3DZoom').textContent = Math.round(view.zoom * 100) + '%';
}

/** 释放旧模型与 GPU 资源；仅换源、模型变化或上下文失效时重建。 */
export function releaseBeadPreview() {
  const view = beadPreview;
  beadPreview = null;
  if (!view) return;
  // 先取消布局观察，避免已释放上下文被迟到回调使用。
  view.observer?.disconnect();
  for (const buffer of view.buffers) view.gl.deleteBuffer(buffer);
  view.gl.deleteVertexArray(view.vao); view.gl.deleteProgram(view.program);
  // 主动归还上下文；Canvas 将随弹窗内容清除，不把失效上下文用于下次打开。
  view.gl.getExtension('WEBGL_lose_context')?.loseContext();
  $('bead3DStage').replaceChildren();
}

/** 以当前完整图纸创建立体预览；草稿和正在生成的结果均不作为模型数据。 */
export async function openBeadPreview() {
  if (editorHasDraft()) { toast('请先应用或取消修图预览，再查看 3D 成品。'); return; }
  // 等最新调参完整提交后，再固定本次实例数据。
  await waitForGeneration();
  if (state.loading) return false;
  const dialog = $('bead3DView'), stage = $('bead3DStage');
  // 完整结果签名不写入存档，只用于判断缓存模型是否仍对应当前格子与方向。
  const signature = JSON.stringify([state.sourceId, state.card.name, state.card.id, state.card.version, state.width, state.height, state.mirrored, state.cells, state.palette.map(c => [c.code, c.hex])]);
  dialog.hidden = false;
  if (beadPreview?.signature === signature && !beadPreview.lost) {
    drawBeadPreview();
    return true;
  }
  releaseBeadPreview();
  stage.replaceChildren();
  $('bead3DStatus').hidden = true;
  $('bead3DMeta').textContent = state.card.name + ' · ' + (state.mirrored ? '镜像' : '正向') + ' · ' + state.palette.reduce((sum, color) => sum + color.count, 0) + ' 颗';
  for (const button of $('bead3DTools').querySelectorAll('[data-bead-view]')) button.disabled = true;
  try {
    const data = beadInstances();
    if (!data.length) throw new Error('当前图纸没有豆子。可先补豆或更换图片。');
    const canvas = document.createElement('canvas');
    canvas.id = 'bead3DCanvas'; canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', '立体拼豆成品；拖动旋转、双指缩放，方向键旋转，加减键缩放');
    stage.append(canvas);
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('此浏览器暂不支持 3D 预览，请继续使用二维图纸。');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < data.length; i += 6) {
      minX = Math.min(minX, data[i]); maxX = Math.max(maxX, data[i]);
      minY = Math.min(minY, data[i + 1]); maxY = Math.max(maxY, data[i + 1]);
    }
    const bounds = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX + 1, height: maxY - minY + 1 };
    const view = { signature, bounds, gl, canvas, buffers: [], vao: gl.createVertexArray(), program: gl.createProgram(), yaw: -.2, tilt: .7, zoom: 1, count: data.length / 6, extent: Math.hypot(state.width, state.height), pointers: new Map(), lost: false };
    beadPreview = view;
    const vertex = beadShader(gl, gl.VERTEX_SHADER, `#version 300 es
      in vec3 point; in vec3 normal; in vec3 position; in vec3 color;
      uniform vec2 angle; uniform vec2 projection; uniform vec2 center; out vec3 tint; out vec3 lighting;
      vec3 rotate(vec3 p) {
        float a=angle.x,b=angle.y;
        p.xy=mat2(cos(a),sin(a),-sin(a),cos(a))*p.xy;
        p.yz=mat2(cos(b),sin(b),-sin(b),cos(b))*p.yz;
        return p;
      }
      void main() {
        vec3 p=rotate(point+position-vec3(center,0)); lighting=rotate(normal); tint=color;
        gl_Position=vec4(p.x*projection.x/projection.y,p.y*projection.x,-p.z*projection.x*.3,1.0);
      }`);
    const fragment = beadShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
      precision mediump float; in vec3 tint; in vec3 lighting; out vec4 outputColor;
      void main() {
        vec3 n=normalize(lighting), light=normalize(vec3(-.45,.65,1.0));
        float diffuse=max(dot(n,light),0.0);
        float gloss=pow(max(dot(reflect(-light,n),vec3(0,0,1)),0.0),24.0)*.12;
        outputColor=vec4(tint*(.48+.52*diffuse)+gloss,1.0);
      }`);
    gl.attachShader(view.program, vertex); gl.attachShader(view.program, fragment); gl.linkProgram(view.program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(view.program, gl.LINK_STATUS)) throw new Error('无法准备 3D 预览，请继续使用二维图纸。');
    gl.bindVertexArray(view.vao);
    const geometry = beadMesh();
    view.vertices = geometry.length / 6;
    for (const [values, names, divisor] of [[geometry, ['point', 'normal'], 0], [data, ['position', 'color'], 1]]) {
      const buffer = gl.createBuffer(); view.buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
      names.forEach((name, i) => {
        const location = gl.getAttribLocation(view.program, name);
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, i * 12); gl.vertexAttribDivisor(location, divisor);
      });
    }
    gl.enable(gl.DEPTH_TEST);
    // 数据属性只描述实例数量；验证可对照实际豆数，不暴露或改写作品状态。
    canvas.dataset.instances = String(view.count);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (beadPreview !== view) return;
      view.lost = true;
      $('bead3DStatus').textContent = '3D 显示已中断，切回图纸后可重新打开；二维图纸仍然保留。';
      $('bead3DStatus').hidden = false;
    });
    const distance = () => {
      const points = [...view.pointers.values()];
      return points.length < 2 ? 0 : Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    canvas.addEventListener('pointerdown', event => {
      event.preventDefault(); canvas.setPointerCapture(event.pointerId);
      view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    canvas.addEventListener('pointermove', event => {
      const previous = view.pointers.get(event.pointerId);
      if (!previous) return;
      event.preventDefault();
      const before = distance();
      view.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (view.pointers.size > 1) view.zoom = Math.max(.35, Math.min(5, view.zoom * distance() / Math.max(1, before)));
      else { view.yaw += (event.clientX - previous.x) * .01; view.tilt = Math.max(-1.25, Math.min(1.25, view.tilt + (event.clientY - previous.y) * .01)); }
      drawBeadPreview();
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(eventName, event => view.pointers.delete(event.pointerId));
    canvas.addEventListener('wheel', event => { event.preventDefault(); view.zoom = Math.max(.35, Math.min(5, view.zoom * Math.exp(-event.deltaY * .001))); drawBeadPreview(); }, { passive: false });
    canvas.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') view.yaw -= .1;
      else if (event.key === 'ArrowRight') view.yaw += .1;
      else if (event.key === 'ArrowUp') view.tilt = Math.max(-1.25, view.tilt - .1);
      else if (event.key === 'ArrowDown') view.tilt = Math.min(1.25, view.tilt + .1);
      else view.zoom = Math.max(.35, Math.min(5, view.zoom * (event.key === '-' ? .85 : 1.15)));
      drawBeadPreview();
    });
    view.observer = new ResizeObserver(drawBeadPreview); view.observer.observe(stage);
    for (const button of $('bead3DTools').querySelectorAll('[data-bead-view]')) button.disabled = false;
    drawBeadPreview();
    return true;
  } catch (error) {
    // 只读模型失败不改变任何图纸或保存记录，错误留在当前弹窗内可见。
    releaseBeadPreview();
    $('bead3DStatus').textContent = error.message; $('bead3DStatus').hidden = false;
    return true;
  }
}

/** 绑定独立视角按钮；页面切换由 preview-pages.js 管理，不累积监听器。 */
export function initBeadPreview() {
  for (const button of $('bead3DTools').querySelectorAll('[data-bead-view]')) button.addEventListener('click', () => {
    if (!beadPreview) return;
    if (button.dataset.beadView === 'reset') { beadPreview.yaw = -.2; beadPreview.tilt = .7; beadPreview.zoom = 1; }
    else beadPreview.zoom = Math.max(.35, Math.min(5, beadPreview.zoom * (button.dataset.beadView === 'in' ? 1.2 : 1 / 1.2)));
    drawBeadPreview();
  });
}
