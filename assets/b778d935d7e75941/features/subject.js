/** 主体纯算法的 ESM 兼容入口；实现由主线程和 Worker 共用的 engine.js 提供。 */
export const WORK_LIMIT = globalThis.BeadEngine.subject.WORK_LIMIT;
export const estimateBackground = globalThis.BeadEngine.subject.estimateBackground;
export const floodBackground = globalThis.BeadEngine.subject.floodBackground;
export const shallowBand = globalThis.BeadEngine.subject.shallowBand;
export const fillLabs = globalThis.BeadEngine.subject.fillLabs;
export const subjectBounds = globalThis.BeadEngine.subject.subjectBounds;
export const planCrop = globalThis.BeadEngine.subject.planCrop;
export const applySubjectMask = globalThis.BeadEngine.subject.applySubjectMask;
