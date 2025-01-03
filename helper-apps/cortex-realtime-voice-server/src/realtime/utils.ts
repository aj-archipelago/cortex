export function hasNativeWebSocket(): boolean {
  return !!process.versions.bun || !!globalThis.WebSocket;
}

export function trimDebugEvent(event?: any): any {
  if (!event) return event;

  const maxLimit = 200;
  const e = structuredClone(event);

  // if (e.item?.content?.find((c: any) => c.audio)) {
  //   e.item.content = e.item.content.map(({ audio, c }: any) => {
  //     if (audio) {
  //       return {
  //         ...c,
  //         audio: '(base64 redacted...)',
  //       };
  //     } else {
  //       return c;
  //     }
  //   });
  // }
  //
  // if (e.audio) {
  //   e.audio = '(audio redacted...)';
  // }

  if (e.delta?.length > maxLimit) {
    e.delta = e.delta.slice(0, maxLimit) + '... (truncated)';
  }

  return e;
}
