export type AttachmentType = 'image' | 'pdf' | 'office' | 'code' | 'audio' | 'video' | 'other';

export type AttachmentStatus = 'uploading' | 'ready' | 'error';

export interface Attachment {
  id: string;
  name: string;
  type: AttachmentType;
  size: number;
  mimeType: string;
  url?: string;
  status: AttachmentStatus;
  preview?: string;
  /** base64 encoded raw data (without data: URL prefix), populated after FileReader reads the file */
  data?: string;
  /**
   * Absolute OS path at attach time (desktop only). Used to copy the file into
   * the workspace when the message is sent.
   */
  sourcePath?: string;
  createdAt: string;
}

/** Input for copying a composer attachment into the workspace. */
export interface SaveAttachmentInput {
  /** OS path of the picked/dropped file. */
  sourcePath?: string;
  /** Fallback bytes when there is no OS path (web build, generated files). */
  dataBase64?: string;
  /** The original file name; the host sanitizes it and de-duplicates collisions. */
  name: string;
}

/** Where an attachment was stored, and the path the model should use. */
export interface SavedAttachment {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the workspace root, with forward slashes. */
  relativePath: string;
  /** Final file name (may carry a ` (n)` suffix after de-duplication). */
  name: string;
}

export type QuoteSource =
  | 'markdown' | 'html' | 'pdf-canvas' | 'pdf-text'
  | 'docx' | 'xlsx' | 'pptx' | 'code-editor' | 'browser'
  | 'chat' | 'plugin';
