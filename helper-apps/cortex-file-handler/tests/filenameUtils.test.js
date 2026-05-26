import test from "ava";

import { sanitizeFilename } from "../src/utils/filenameUtils.js";

test("sanitizeFilename strips C1 control characters from mojibake names", (t) => {
  const result = sanitizeFilename("Ø§ÙÙ ð.mp4");

  t.false(/[\u0000-\u001F\u007F-\u009F]/.test(result));
  t.true(result.endsWith(".mp4"));
});

test("sanitizeFilename preserves valid Arabic filenames", (t) => {
  const result = sanitizeFilename("أهل الجنوب.mp4");

  t.is(result, "أهل الجنوب.mp4");
});
