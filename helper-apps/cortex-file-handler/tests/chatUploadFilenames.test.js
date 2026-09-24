import test from "ava";
import { Readable } from "node:stream";
import FormData from "form-data";
import { uploadBlob } from "../src/blobHandler.js";
import { StorageFactory } from "../src/services/storage/StorageFactory.js";
import { StorageService } from "../src/services/storage/StorageService.js";

async function upload(content, fileScope = "chat", filename = "image.jpg") {
  const form = new FormData();
  form.append("userId", "synthetic-user");
  form.append("chatId", "synthetic-chat");
  form.append("fileScope", fileScope);
  form.append("file", Buffer.from(content), { filename, contentType: "image/jpeg" });
  const request = Readable.from(form.getBuffer());
  request.headers = form.getHeaders();
  return uploadBlob({ log() {} }, request);
}

test.beforeEach((t) => {
  const factory = StorageFactory.getInstance();
  t.context.original = factory.getAzureProvider;
  t.context.originalBackup = StorageService.prototype.ensureGCSUpload;
  StorageService.prototype.ensureGCSUpload = async (_context, file) => ({ ...file, gcs: "gs://synthetic/backup.jpg" });
  const blobs = new Map();
  t.context.blobs = blobs;
  factory.getAzureProvider = async () => ({
    async uploadStream(_context, filename, stream, _contentType, folderPath) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const blobName = `${folderPath}/${filename}`;
      blobs.set(blobName, Buffer.concat(chunks).toString());
      return { blobName, url: `https://storage.example/${blobName}` };
    },
  });
});

test.afterEach.always((t) => {
  StorageFactory.getInstance().getAzureProvider = t.context.original;
  StorageService.prototype.ensureGCSUpload = t.context.originalBackup;
});

test.serial("same-name chat uploads preserve both objects and their original display name", async (t) => {
  const [first, second] = await Promise.all([upload("first camera image"), upload("second camera image")]);
  t.not(first.blobPath, second.blobPath);
  t.is(t.context.blobs.size, 2);
  t.is(t.context.blobs.get(first.blobPath), "first camera image");
  t.is(t.context.blobs.get(second.blobPath), "second camera image");
  for (const result of [first, second]) {
    t.is(result.displayFilename, "image.jpg");
    t.true(result.blobPath.startsWith("chats/synthetic-chat/"));
    t.true(result.filename.endsWith(".jpg"));
  }
});

test.serial("explicit global file paths retain their existing replacement behavior", async (t) => {
  const first = await upload("old", "global");
  const second = await upload("new", "global");
  t.is(first.blobPath, "global/image.jpg");
  t.is(second.blobPath, first.blobPath);
  t.is(t.context.blobs.get(first.blobPath), "new");
});

test.serial("multipart uploads preserve UTF-8 original filenames", async (t) => {
  const uploaded = await upload("image", "chat", "تقرير قطر.jpg");
  t.is(uploaded.displayFilename, "تقرير قطر.jpg");
});
