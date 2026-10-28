const RANGE_WINDOW = 1024 * 1024;
const TAIL_HINT = 4 * 1024 * 1024;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/gw-media\/(-?\d+)\/(\d+)\/?$/);
  if (!match || event.request.method !== "GET") return;
  event.respondWith(serveMedia(event, match[1], match[2]));
});

function parseRange(header, size) {
  if (size <= 0) return { start: 0, end: 0, partial: false };
  if (!header || !header.toLowerCase().startsWith("bytes=")) {
    return { start: 0, end: Math.min(size, RANGE_WINDOW) - 1, partial: true };
  }
  const spec = header.split("=")[1].split(",")[0].trim();
  if (spec.startsWith("-")) {
    const tail = Number(spec.slice(1) || 0);
    const start = Math.max(0, size - tail);
    return { start, end: size - 1, partial: true };
  }
  const [left, right] = spec.split("-");
  let start = Number(left || 0);
  let end;
  if (right) end = Math.min(Number(right), size - 1);
  else end = size - 1;
  start = Math.max(0, Math.min(start, size - 1));
  end = Math.max(start, end);
  return { start, end, partial: true };
}

function askClient(event, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("读取超时")), timeoutMs);
    const finish = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    (async () => {
      let client = null;
      if (event.clientId) client = await self.clients.get(event.clientId);
      if (!client) {
        const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        client = all[0] || null;
      }
      if (!client) {
        finish(reject, new Error("页面未打开"));
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (ev) => {
        const data = ev.data || {};
        if (data.error) finish(reject, new Error(data.error));
        else finish(resolve, data);
      };
      client.postMessage({ channel: "gw", ...payload }, [channel.port2]);
    })().catch((err) => finish(reject, err));
  });
}

function copyBytes(read) {
  const n = read.byteLength || (read.buffer && read.buffer.byteLength) || 0;
  const out = new Uint8Array(n);
  if (n) out.set(new Uint8Array(read.buffer, read.byteOffset || 0, n));
  return out;
}

async function serveMedia(event, chatId, msgId) {
  try {
    const sized = await askClient(event, { op: "size", chatId, msgId }, 180000);
    const size = Number(sized.size || 0);
    if (!size) return new Response("没有影片", { status: 404 });
    const range = parseRange(event.request.headers.get("range"), size);
    const length = range.end - range.start + 1;
    let pos = range.start;
    const stream = new ReadableStream({
      async pull(controller) {
        if (pos > range.end) {
          controller.close();
          return;
        }
        const n = Math.min(256 * 1024, range.end - pos + 1);
        const read = await askClient(
          event,
          { op: "read", chatId, msgId, start: pos, length: n },
          45000
        );
        const bytes = copyBytes(read);
        if (!bytes.byteLength) {
          controller.error(new Error("影片数据中断"));
          return;
        }
        controller.enqueue(bytes);
        pos += bytes.byteLength;
        if (pos > range.end) controller.close();
      },
    });
    return new Response(stream, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Content-Length": String(length),
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return new Response(String(err && err.message ? err.message : err), { status: 502 });
  }
}
