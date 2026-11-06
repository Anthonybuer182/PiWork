/**
 * Stubs for GenOffice's `MarkdownApi` (window.markdownApi).
 *
 * 69 members, of which the renderer calls a scattered handful during bootstrap —
 * none of them guessable from the outside (the first slides run died on
 * `clipboardProbe`). Each returns the SHAPE its declaration promises, so a
 * stubbed call degrades to "feature unavailable" rather than blowing up
 * somewhere far from the cause.
 *
 * Every real implementation lives in the shim next to this file, spread over
 * the top of this object.
 *
 * Generated from apps/markdown/src/shared/ipc.ts by scripts/gen-api-stubs.mjs. Regenerate rather
 * than edit — but do check it in: it is read far more often than written.
 */
export const markdownApiStubs: Record<string, unknown> = {
  consumePending: () => Promise.resolve(null),
  openSourcePath: () => Promise.resolve(),
  resolveWikiLinks: () => Promise.resolve(''),
  rememberWikiFragment: () => Promise.resolve(),
  takeWikiFragment: () => Promise.resolve(''),
  listWikiNotes: () => Promise.resolve([]),
  createWikiNote: () => Promise.resolve(null),
  wikiHeads: () => Promise.resolve([]),
  wikiBacklinks: () => Promise.resolve([]),
  wikiTags: () => Promise.resolve([]),
  wikiGraph: () => Promise.resolve(null),
  consumeHeadlessExport: () => Promise.resolve(null),
  headlessExportDone: () => undefined,
  readFile: () => Promise.resolve(''),
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
  pickImage: () => Promise.resolve(null),
  saveImage: () => Promise.resolve(null),
  getMarkdownTheme: () => Promise.resolve(null),
  setMarkdownTheme: () => Promise.resolve(null),
  getImageHost: () => Promise.resolve(null),
  setImageHost: () => Promise.resolve(null),
  uploadImage: () => Promise.resolve(false),
  readImage: () => Promise.resolve(null),
  saveImageAs: () => Promise.resolve(false),
  onViewImage: () => () => undefined,
  onExportRequest: () => () => undefined,
  onPrintRequest: () => () => undefined,
  exportDocx: () => Promise.resolve(null),
  exportPdf: () => Promise.resolve(null),
  prepareImageExport: () => Promise.resolve(null),
  writeExportImage: () => undefined,
  finishImageExport: () => Promise.resolve(null),
  getLanguage: () => Promise.resolve(null),
  onLanguageChanged: () => () => undefined,
  getTheme: () => Promise.resolve(null),
  onThemeChanged: () => () => undefined,
  getDocumentTheme: () => Promise.resolve(null),
  onDocumentThemeChanged: () => () => undefined,
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
