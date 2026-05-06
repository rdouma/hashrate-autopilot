/**
 * Cross-context copy-to-clipboard helper.
 *
 * `navigator.clipboard.writeText` is only defined in secure contexts
 * (HTTPS or localhost). On a LAN hostname over plain HTTP - e.g.
 * `http://clarent:3010` - `navigator.clipboard` is undefined and
 * calling `.writeText(...)` throws, which means a button with a
 * bare `await navigator.clipboard.writeText(...)` wrapped in a
 * silent try/catch will appear to do nothing.
 *
 * This helper falls back to the pre-Clipboard-API technique
 * (ephemeral `<textarea>` + `document.execCommand('copy')`) when the
 * async API isn't available. Both branches succeed or throw; callers
 * can await and update UI state accordingly.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for insecure contexts (LAN HTTP).
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  try {
    ta.select();
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('document.execCommand("copy") returned false');
  } finally {
    document.body.removeChild(ta);
  }
}
