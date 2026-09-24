// Azure metadata values must be ASCII; filenames may contain Arabic or emoji.
export function encodeDisplayMetadata(displayFilename) {
  return typeof displayFilename === 'string' && displayFilename.length
    ? { cfh_display_name: Buffer.from(displayFilename, 'utf8').toString('base64') }
    : {};
}

export function decodeDisplayMetadata(metadata) {
  if (!metadata?.cfh_display_name) return {};
  return { displayFilename: Buffer.from(metadata.cfh_display_name, 'base64').toString('utf8') };
}
