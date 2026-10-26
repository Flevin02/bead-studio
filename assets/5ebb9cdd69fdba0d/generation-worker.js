importScripts('./palettes.js', './engine.js');
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
