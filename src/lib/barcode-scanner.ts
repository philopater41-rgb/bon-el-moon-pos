/** Collects the rapid keyboard input sent by a barcode scanner. */
export function createBarcodeScanner(onScan: (barcode: string) => void) {
  const maxKeyGapMs = 100;
  const idleMs = 250;
  let buffer = '';
  let lastKey = 0;
  let ignoreEnterUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    buffer = '';
    lastKey = 0;
  };
  const finish = (fromIdle = false) => {
    const code = buffer;
    cancel();
    if (code.length < 3) return false;
    if (fromIdle) ignoreEnterUntil = Date.now() + 500;
    onScan(code);
    return true;
  };
  const feed = (key: string, now = Date.now()) => {
    if (lastKey && now - lastKey > maxKeyGapMs) finish(true);
    if (key === 'Enter') {
      if (!buffer && now < ignoreEnterUntil) { ignoreEnterUntil = 0; return true; }
      return finish();
    }
    if (key.length !== 1) return false;
    lastKey = now;
    if (buffer.length >= 100) { cancel(); return false; }
    buffer += key;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => finish(true), idleMs);
    return false;
  };
  return { feed, cancel };
}
