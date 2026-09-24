import test from "ava";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import FormData from "form-data";
import axios from "axios";
import { uploadBlob } from "../src/blobHandler.js";
import { StorageFactory } from "../src/services/storage/StorageFactory.js";
import { getUserContainerName, getDefaultContainerName } from "../src/constants.js";

test("chat camera uploads retain distinct bytes in Azure and the GCS backup", async (t) => {
  t.is(process.env.AZURE_STORAGE_CONNECTION_STRING, "UseDevelopmentStorage=true");
  t.regex(process.env.STORAGE_EMULATOR_HOST || "", /^http:\/\/(localhost|127\.0\.0\.1):/);
  if (process.env.AZURE_STORAGE_CONNECTION_STRING !== "UseDevelopmentStorage=true" || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(process.env.STORAGE_EMULATOR_HOST || "")) return;
  const userId = `upload-${randomUUID()}`;
  const uploaded = [];
  const upload = async (content) => {
    const form = new FormData();
    form.append("userId", userId);
    form.append("chatId", "synthetic-camera-chat");
    form.append("fileScope", "chat");
    form.append("file", content, { filename: "image.jpg", contentType: "image/jpeg" });
    const request = Readable.from(form.getBuffer());
    request.headers = form.getHeaders();
    const result = await uploadBlob({ log() {} }, request);
    uploaded.push(result);
    return result;
  };
  const firstBytes = Buffer.from("synthetic camera image one");
  const secondBytes = Buffer.from("synthetic camera image two");
  try {
    const first = await upload(firstBytes);
    const second = await upload(secondBytes);
    t.not(first.blobPath, second.blobPath);
    for (const [result, expected] of [[first, firstBytes], [second, secondBytes]]) {
      t.is(result.displayFilename, "image.jpg");
      const response = await axios.get(result.url, { responseType: "arraybuffer" });
      t.deepEqual(Buffer.from(response.data), expected);
      t.truthy(result.gcs);
      const url = new URL(result.gcs);
      const object = encodeURIComponent(decodeURIComponent(url.pathname.slice(1)));
      const backup = await axios.get(`${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${url.hostname}/o/${object}`, { params: { alt: "media" }, responseType: "arraybuffer" });
      t.deepEqual(Buffer.from(backup.data), expected);
    }
  } finally {
    const provider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), userId));
    const { containerClient } = await provider.getBlobClient();
    await containerClient.deleteIfExists();
    for (const result of uploaded) {
      if (result.gcs) {
        const url = new URL(result.gcs);
        const object = encodeURIComponent(decodeURIComponent(url.pathname.slice(1)));
        await axios.delete(`${process.env.STORAGE_EMULATOR_HOST}/storage/v1/b/${url.hostname}/o/${object}`, { validateStatus: (status) => status === 204 || status === 200 || status === 404 });
      }
    }
  }
});
