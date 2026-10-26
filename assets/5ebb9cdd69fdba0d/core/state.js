/**
 * 共享底座：页面元素引用、作品状态、设备断点与持久化事务对象。
 * 只放「所有组件都要读」的东西；具体业务写在 features/ 下，不要往这里加逻辑。
 *
 * features 之间允许互相引用，但只能发生在函数被调用时（浏览器原生 ESM 的循环依赖
 * 靠函数提升工作）；不要在模块顶层执行兄弟模块的代码，否则会读到尚未初始化的绑定。
 */

export const $ = id => document.getElementById(id);

// 源图和量化结果分开保管：镜像只改变读取坐标，来回切换不会损失图像。
export const state = {
  source: null, name: '午后的橘子猫', demo: true,
  width: 32, height: 32, cells: [], palette: [],
  mirrored: false, zoom: 1, selected: null, loadVersion: 0,
  loading: false, generating: false, toastTimer: null, regenerateTimer: null,
  // 当前改色弹窗对应的色号索引；取消或关闭后不保留未保存的草稿。
  editingColor: null,
  // 固定最近点击的显示坐标；颜色和色号每次从当前图纸读取，改色后不会显示旧值。
  activeCell: null,
  // 检查工具的临时悬停色索引；只用于屏幕淡化，不写作品、历史或导出。
  hoverColor: null,
  // 制图点格只检查；拼豆定位并筛选同色号，两种模式共用同一份格子与配色。
  // 真实绘制色独立于找色索引；原图查看只读，生成参数仅在完整应用后更新。
  currentColorCode: null, originalPreview: false, previewMode: 'pattern', appliedParameters: null,
  mode: 'design', sourceId: null, viewTask: 0
};

export const P = window.BeadPalettes;
// 色卡是所有图纸的共同前提，随底座一起确定；换卡只改 state.card。
export const defaultCard = { id: 'mard221', version: 'mard221-v1', name: 'MARD 221 色', colors: P.validate(window.MARD_221), builtin: true, source: 'https://github.com/maxcleme/beadcolors', license: 'MIT' };
// 每套内置卡保留真实品牌及版本，颜色条目统一经过导入相同校验。
export const builtinCards = [defaultCard, ...globalThis.BeadBuiltinCards.map(card => ({ ...card, colors: P.validate(card.colors) }))];
state.card = defaultCard;
state.autoResult = null;
state.hasEdits = false;

// 图纸几何：格子、页边距与画布上限，预览、导出与打印共用同一套坐标。
export const canvas = $('patternCanvas');
export const CELL = 24;
export const MARGIN = 28;
// 预览与导出都限制最长边，避免高格数图纸在手机上分配过大的位图。
export const MAX_CANVAS_EDGE = 4096;
export const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';

export const mobileLayout = window.matchMedia('(max-width: 650px)');
// 动画只保留在界面层，不进入作品快照；同一切换器最多运行一个形变任务。
export const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
export const switchVisuals = new Map();
export const modeSwitch = $('designModeBtn').parentElement;
export const directionSwitch = $('normalBtn').parentElement;
export const exportButtons = [$('exportBtn'), $('mobileExportBtn'), $('readingExportBtn')];

// 只存放正在过渡的真实面板；中断后恢复自然布局，不克隆控件或保存动画状态。
export const workspace = document.querySelector('.workspace');
export const settingsPanel = $('settingsPanel');
export const settingsHome = document.createComment('图纸设置在桌面布局中的位置');
settingsPanel.before(settingsHome);

// 系统选图共用同一控件；设置打开时移入顶层弹窗，避免落在其 inert 背景中。
export const fileInput = $('fileInput');
export const fileInputHome = document.createComment('共享图片输入控件的原位置');
fileInput.before(fileInputHome);

export const palettePanel = $('palettePanel');
export const paletteHome = document.createComment('豆子清单在工作区中的位置');
palettePanel.before(paletteHome);

// 保存事务串行执行；sequence 区分写入期间发生的新修改，不提前显示“已保存”。
export const persistence = {
  ready: false, tracked: false, recordPresent: false, initialRead: false,
  token: null, sequence: 0, savedSequence: 0, savedAt: null,
  timer: null, writing: false, blocked: null, sourceCache: null, sourceSavedId: null
};

// 跨模块可写状态：ESM 导入是只读视图，需要跨文件改写的量集中放这里。
// workspaceMotion 是正在播放的布局过渡；filePickContext / settingsVisit 标记本轮选图属于哪个入口。
export const env = { workspaceMotion: null, filePickContext: undefined, settingsVisit: 0 };
