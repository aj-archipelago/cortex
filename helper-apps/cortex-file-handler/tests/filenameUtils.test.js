import test from "ava";

import { sanitizeFilename, generateChatUploadFilename } from "../src/utils/filenameUtils.js";

test("chat upload names stay unique with repeated names and preserve Unicode and extensions", (t) => {
  const names = new Set(Array.from({ length: 1000 }, () => generateChatUploadFilename("صورة.jpg")));
  t.is(names.size, 1000);
  for (const name of names) {
    t.regex(name, /^صورة-[0-9a-f-]{36}\.jpg$/);
  }
  t.false(generateChatUploadFilename("../../image.jpg").includes("/"));
});

test("sanitizeFilename strips C1 control characters from mojibake names", (t) => {
  const result = sanitizeFilename("Ø§ÙÙ ð.mp4");

  t.false(/[\u0000-\u001F\u007F-\u009F]/.test(result));
  t.true(result.endsWith(".mp4"));
});

test("sanitizeFilename preserves valid Arabic filenames", (t) => {
  const result = sanitizeFilename("أهل الجنوب.mp4");

  t.is(result, "أهل الجنوب.mp4");
});
