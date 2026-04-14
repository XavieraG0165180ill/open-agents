import { afterAll, describe, expect, test } from "bun:test";
import { gzipSync } from "zlib";
import { downloadAndExtractTarball } from "./tarball";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function createTarEntry(
  name: string,
  content = "",
  typeFlag: "0" | "5" = "0",
): Buffer {
  const header = Buffer.alloc(512, 0);
  Buffer.from(name).copy(header, 0, 0, 100);

  const contentBuffer = Buffer.from(content, "utf8");
  const size = typeFlag === "5" ? 0 : contentBuffer.length;
  const sizeOctal = `${size.toString(8).padStart(11, "0")}\0`;
  Buffer.from(sizeOctal).copy(header, 124, 0, 12);
  header[156] = typeFlag.charCodeAt(0);

  const paddingSize = (512 - (size % 512)) % 512;
  const padding = Buffer.alloc(paddingSize, 0);

  return Buffer.concat([
    header,
    typeFlag === "5" ? Buffer.alloc(0) : contentBuffer,
    padding,
  ]);
}

function createTarball(entries: Buffer[]): Uint8Array {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));
}

describe("downloadAndExtractTarball", () => {
  test("skips traversal and root-poisoning tar entries", async () => {
    const tarball = createTarball([
      createTarEntry("repo-main/", "", "5"),
      createTarEntry("repo-main/src/index.ts", 'console.log("ok")\n'),
      createTarEntry("repo-main/../escaped.txt", "nope"),
      createTarEntry("repo-main/../../etc/passwd", "nope"),
      createTarEntry("/absolute.txt", "nope"),
      createTarEntry("evil-root/poison.ts", "nope"),
    ]);

    globalThis.fetch = (async () =>
      new Response(Buffer.from(tarball), {
        status: 200,
        headers: {
          "Content-Type": "application/gzip",
        },
      })) as unknown as typeof fetch;

    const result = await downloadAndExtractTarball(
      "https://github.com/vercel/open-harness",
    );

    expect(result.files).toEqual({
      "/vercel/sandbox/src/index.ts": 'console.log("ok")\n',
    });
  });
});
