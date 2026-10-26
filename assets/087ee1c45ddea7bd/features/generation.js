/** 后台执行桥：一次仅运行一个最新任务，失败和取消不触碰已应用作品。 */
let computeWorker = null;
let computeAbort = null;
let computeEpoch = 0;

/** 终止线程／兼容计算并拒绝旧 Promise；调用方负责恢复已应用界面。 */
export function cancelComputation() {
  computeEpoch++;
  // 终止计算本身，避免旧任务仍占用 CPU；取消错误由业务入口静默处理。
  computeAbort?.();
  computeAbort = null;
  computeWorker?.terminate();
  computeWorker = null;
}

/**
 * 从固定源帧异步计算整份结果；parameters/colors 是本次请求的独立快照。
 * Worker 初始化不支持时才走相同算法的分段兼容路径，计算错误直接报告给调用方。
 */
export async function computePattern(source, parameters, colors) {
  // 新请求先使旧线程及其所有迟到消息失效。
  cancelComputation();
  const epoch = computeEpoch;
  const aborted = () => epoch !== computeEpoch;
  let bitmap = null, workerURL = null, ownedWorker = null;
  try {
    if (typeof Worker !== 'function' || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('worker-unavailable');
    // 克隆可转移位图，不转移原作品 Canvas；取消和失败仍保留源帧。
    bitmap = await createImageBitmap(source);
    if (aborted()) throw new DOMException('计算已取消', 'AbortError');
    const config = JSON.parse(document.getElementById('generation-config').textContent);
    if (config.worker) workerURL = new URL(config.worker, document.baseURI).href;
    else {
      // 离线单文件从同一组源码嵌入 Worker，断网 file:// 无需 import 或请求文件。
      const raw = atob(document.getElementById('generation-worker').textContent);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      workerURL = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    }
    // 只有收到 ready 才转交位图；脚本或策略限制导致的初始化失败可安全回退。
    ownedWorker = new Worker(workerURL);
    computeWorker = ownedWorker;
    await new Promise((resolve, reject) => {
      const worker = computeWorker;
      const timer = setTimeout(() => reject(new Error('worker-unavailable')), 5000);
      computeAbort = () => { clearTimeout(timer); reject(new DOMException('计算已取消', 'AbortError')); };
      worker.onerror = () => { clearTimeout(timer); reject(new Error('worker-unavailable')); };
      worker.onmessage = event => { if (event.data.ready) { clearTimeout(timer); resolve(); } };
    });
  } catch (error) {
    bitmap?.close();
    if (workerURL?.startsWith('blob:')) URL.revokeObjectURL(workerURL);
    ownedWorker?.terminate();
    if (epoch === computeEpoch) { computeWorker = null; computeAbort = null; }
    if (aborted() || error.name === 'AbortError') throw new DOMException('计算已取消', 'AbortError');
    // 初始化兼容降级仍逐块计算，不用一次同步量化阻塞页面。
    const result = await globalThis.BeadEngine.cooperative(globalThis.BeadEngine.calculateSteps(source, parameters, colors), aborted);
    return { result, backend: 'cooperative' };
  }
  try {
    const worker = ownedWorker;
    if (aborted()) throw new DOMException('计算已取消', 'AbortError');
    // ready 后的业务错误不降级换算法；只允许完整、同请求号的结果返回。
    const result = await new Promise((resolve, reject) => {
      computeAbort = () => reject(new DOMException('计算已取消', 'AbortError'));
      worker.onerror = () => reject(new Error('后台计算失败'));
      worker.onmessage = event => {
        if (aborted() || event.data.epoch !== epoch) return;
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.result);
      };
      // 位图所有权交给 Worker；成功、失败或取消均由线程结束释放。
      worker.postMessage({ epoch, source: bitmap, parameters, colors }, [bitmap]);
      bitmap = null;
    });
    return { result, backend: 'worker' };
  } finally {
    // 只回收本任务资源，迟到的 finally 不能终止后来的线程。
    if (epoch === computeEpoch) { computeWorker?.terminate(); computeWorker = null; computeAbort = null; }
    bitmap?.close();
    if (workerURL?.startsWith('blob:')) URL.revokeObjectURL(workerURL);
  }
}
