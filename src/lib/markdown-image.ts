/** Image-only URL handling. Link URLs still use ReactMarkdown's default policy. */
export function markdownImageUrl(value: string, modFolder?: string): string {
  const original = value.trim();
  if (!original || /[\u0000-\u001f]/.test(original)) return '';
  if (/^https?:\/\//i.test(original) || /^blob:/i.test(original)) return original;
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif|avif|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i.test(original)) return original;
  if (/^modmixer-asset:/i.test(original)) {
    try {
      const url = new URL(original);
      return ['preview', 'chat', 'image', 'workspace'].includes(url.hostname) &&
        !url.username && !url.password && !url.port ? original : '';
    } catch { return ''; }
  }
  let local = original;
  try { local = decodeURIComponent(local); } catch { /* A literal % can be a filename. */ }
  if (/^file:/i.test(local)) {
    try {
      const url = new URL(original);
      // Network file shares are not an implicit image source.
      if (url.hostname && url.hostname !== 'localhost') return '';
      local = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:[\/\\]/i.test(local)) local = local.slice(1);
    } catch { return ''; }
  }
  local = local.replace(/\\/g, '/');
  if (/^\/[a-z]:\//i.test(local)) local = local.slice(1);
  if (local.startsWith('//')) return '';
  const absolute = /^[a-z]:\//i.test(local) || local.startsWith('/');
  // Reject other URI schemes, including drive-relative paths such as C:foo.
  if (!absolute && /^[a-z][a-z0-9+.-]*:/i.test(local)) return '';
  if (absolute) return `modmixer-asset://image/${encodeURIComponent(local)}`;
  if (modFolder) return `modmixer-asset://chat/${encodeURIComponent(modFolder)}/${encodeURIComponent(local)}`;
  return `modmixer-asset://workspace/${encodeURIComponent(local)}`;
}
