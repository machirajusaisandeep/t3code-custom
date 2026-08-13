export function isHarAttachmentFile(file: Pick<File, "name">): boolean {
  return /\.har$/i.test(file.name);
}

export function isSupportedComposerFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("image/") || isHarAttachmentFile(file);
}

export function composerFileMimeType(file: Pick<File, "name" | "type">): string {
  return file.type || (isHarAttachmentFile(file) ? "application/json" : "application/octet-stream");
}
