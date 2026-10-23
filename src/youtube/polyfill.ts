// Runs before anything else: Folia's code expects a global Buffer, and the page defaults to
// Simplified Chinese unless the visitor already picked a language.
import { Buffer } from 'buffer';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

try {
  if (!localStorage.getItem('folia_app_language')) localStorage.setItem('folia_app_language', 'zh-CN');
} catch {
  // Storage blocked: the language detector falls back to the browser language.
}
