/**
 * Stubs for GenOffice's `HtmlApi` (window.htmlApi).
 *
 * 61 members, of which the renderer calls a scattered handful during bootstrap —
 * none of them guessable from the outside (the first slides run died on
 * `clipboardProbe`). Each returns the SHAPE its declaration promises, so a
 * stubbed call degrades to "feature unavailable" rather than blowing up
 * somewhere far from the cause.
 *
 * Every real implementation lives in the shim next to this file, spread over
 * the top of this object.
 *
 * Generated from apps/html/src/shared/ipc.ts by scripts/gen-api-stubs.mjs. Regenerate rather
 * than edit — but do check it in: it is read far more often than written.
 */
export const htmlApiStubs: Record<string, unknown> = {
  consumePending: () => Promise.resolve(null),
  openSourcePath: () => Promise.resolve(),
  consumeHeadlessExport: () => Promise.resolve(null),
  headlessExportDone: () => undefined,
  readFile: () => Promise.resolve(''),
  updatePreview: () => undefined,
  getPreviewInfo: () => Promise.resolve(''),
  setPresentFullScreen: () => Promise.resolve(),
  presentInNewTab: () => Promise.resolve(false),
  save: () => Promise.resolve(null),
  setDirty: () => undefined,
  onSaveRequest: () => () => undefined,
  sendSaveRequestAck: () => undefined,
  onReadTextRequest: () => () => undefined,
  sendReadTextResult: () => undefined,
  onCloseSaveRequest: () => () => undefined,
  sendCloseSaveResult: () => undefined,
  onFileRenamed: () => () => undefined,
  onFileChangedOnDisk: () => () => undefined,
  ackFileChangedOnDisk: () => undefined,
  setProvisionalTitle: () => undefined,
  pickImage: () => Promise.resolve(null),
  saveImage: () => Promise.resolve(null),
  readImage: () => Promise.resolve(null),
  pickAttachments: () => Promise.resolve(null),
  addAttachmentPaths: () => Promise.resolve(null),
  addPastedImage: () => Promise.resolve(null),
  readAttachment: () => Promise.resolve(null),
  readAttachmentImage: () => Promise.resolve(null),
  getPathForFile: () => undefined,
  onExportRequest: () => () => undefined,
  onPrintRequest: () => () => undefined,
  exportDocx: () => Promise.resolve(null),
  exportPdf: () => Promise.resolve(null),
  exportHtml: () => Promise.resolve(null),
  printHtml: () => Promise.resolve(null),
  getLanguage: () => Promise.resolve(null),
  onLanguageChanged: () => () => undefined,
  getTheme: () => Promise.resolve(null),
  onThemeChanged: () => () => undefined,
  getAutoSaveDefault: () => Promise.resolve(null),
  onAutoSaveDefaultChanged: () => () => undefined,
  getAiPanelPrefs: () => Promise.resolve(null),
  setAiPanelPrefs: () => Promise.resolve(null),
  onAiPanelPrefsChanged: () => () => undefined,
  onChromePressed: () => () => undefined,
  getAiSettings: () => Promise.resolve(null),
  setAiSettings: () => Promise.resolve(),
  onAiSettingsChanged: () => () => undefined,
  openAiModelSettings: () => Promise.resolve(),
  openSkillsSettings: () => Promise.resolve(),
  skillsList: () => Promise.resolve([]),
  skillText: () => Promise.resolve(''),
  aiGskStatus: () => Promise.resolve(null),
  aiStream: () => Promise.resolve(),
  aiStreamCancel: () => Promise.resolve(),
  onAiStream: () => () => undefined,
  webSearch: () => Promise.resolve(null),
  imageSearch: () => Promise.resolve(null),
  fetchImage: () => Promise.resolve(null),
  aiGenerateImage: () => Promise.resolve(''),
};
