/* 两种交付共享识别逻辑：网站首次识图才下载本站资源，离线版从内嵌数据创建组件。 */
window.BeadOCR = (() => {
  'use strict';
  const config = JSON.parse(document.getElementById('ocr-config').textContent);
  const embedded = config.mode === 'embedded';
  let libraryPromise = null;

  /** 解码离线资产；只在图片色卡识别时调用，不在普通制图启动时分配大数组。 */
  function decode(id) {
    const binary = atob(document.getElementById(id).textContent.trim());
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  }

  /** 相对当前HTML解析路径，兼容GitHub Pages的项目子目录，绝不回退公共CDN。 */
  function resource(name) {
    return new URL(config.base + name, document.baseURI).href;
  }

  /** 并发准备共享同一个Promise；失败移除script并清空状态，下一次识别可重新下载。 */
  function prepare() {
    if (libraryPromise) return libraryPromise;
    const pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const localURL = embedded ? URL.createObjectURL(new Blob([decode('ocr-library')], { type: 'text/javascript' })) : null;
      script.src = localURL || resource('tesseract.min.js');
      const finish = () => { if (localURL) URL.revokeObjectURL(localURL); };
      script.onload = () => {
        finish();
        if (typeof window.Tesseract?.createWorker === 'function') resolve();
        else { script.remove(); reject(new Error('识别组件内容不完整。')); }
      };
      script.onerror = () => { finish(); script.remove(); reject(new Error('识别组件下载失败。')); };
      document.head.append(script);
    });
    libraryPromise = pending.catch(error => { libraryPromise = null; throw error; });
    return libraryPromise;
  }

  /**
   * 开始一轮可立即取消的Worker初始化，返回ready和terminate。
   * 固定版本Tesseract 5.1.1在createWorker同步段创建原生Worker，却在模型初始化后才暴露句柄。
   * 仅在该同步调用期间捕获句柄并立即恢复构造器，使加载失败/关闭窗口也能终止尚未就绪的Worker。
   */
  function startWorker(logger) {
    let workerURL = null, nativeWorker = null, stopped = false, rejectStartup;
    const failure = new Promise((resolve, reject) => { rejectStartup = reject; });
    const options = { logger, cacheMethod: 'none', gzip: true, workerBlobURL: false,
      errorHandler: error => rejectStartup(new Error(String(error))) };
    if (embedded) {
      const language = document.getElementById('ocr-language').textContent.trim();
      const prefix = `self.fetch = async function(url) { if (!String(url).endsWith('/eng.traineddata.gz')) throw new Error('Unexpected OCR resource'); const text = atob('${language}'); return new Response(Uint8Array.from(text, c => c.charCodeAt(0))); };\n`;
      // 核心先定义在Worker内，模型fetch只返回内嵌内容，不向虚拟地址发送网络请求。
      workerURL = URL.createObjectURL(new Blob([decode('ocr-core'), prefix, decode('ocr-worker')], { type: 'text/javascript' }));
      Object.assign(options, { workerPath: workerURL, langPath: 'https://bead-local.invalid' });
    } else {
      // 明确指定现有单个LSTM核心文件，避免SIMD自动选路或默认CDN导致缺文件。
      Object.assign(options, { workerPath: resource('worker.min.js'), corePath: resource('tesseract-core-lstm.wasm.js'), langPath: new URL(config.base, document.baseURI).href });
    }
    const NativeWorker = window.Worker;
    let startup;
    try {
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); nativeWorker = this; }
      };
      // 引擎在本同步段创建Worker，JavaScript任务不会在构造器恢复前插入其他异步任务。
      startup = Tesseract.createWorker('eng', 1, options);
    } catch (error) { startup = Promise.reject(error); }
    finally { window.Worker = NativeWorker; }
    if (nativeWorker) nativeWorker.addEventListener('error', event => {
      event.preventDefault();
      rejectStartup(new Error(event.message || '识别Worker加载失败。'));
    });

    /** 终止正在下载、初始化或识别的本轮Worker，并释放该轮离线Blob资源。 */
    function terminate() {
      if (stopped) return;
      stopped = true;
      if (nativeWorker) nativeWorker.terminate();
      if (workerURL) URL.revokeObjectURL(workerURL);
      rejectStartup(new DOMException('OCR cancelled', 'AbortError'));
    }
    const ready = Promise.race([startup, failure]).then(engine => {
      if (stopped) { engine.terminate(); throw new DOMException('OCR cancelled', 'AbortError'); }
      return engine;
    }).catch(error => { terminate(); throw error; });
    return { ready, terminate };
  }

  return { prepare, startWorker, embedded };
})();
