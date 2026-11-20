interface Slot {
  parts: string[];
  promise: Promise<string>;
}

/** Collapse a burst of messages from one channel identity into a single turn. */
export function createAggregator(delayMs: number, flush: (key: string, content: string) => Promise<string>) {
  const slots = new Map<string, Slot>();

  return async function submit(key: string, content: string): Promise<{ leader: boolean; reply: string }> {
    const existing = slots.get(key);
    if (existing) {
      existing.parts.push(content);
      return { leader: false, reply: await existing.promise };
    }
    let settle: (value: string) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const slot: Slot = {
      parts: [content],
      promise: new Promise<string>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
    };
    slots.set(key, slot);
    setTimeout(() => {
      slots.delete(key);
      const text = slot.parts.map((part) => part.trim()).filter(Boolean).join("\n");
      flush(key, text).then(settle, fail);
    }, delayMs);
    return { leader: true, reply: await slot.promise };
  };
}
