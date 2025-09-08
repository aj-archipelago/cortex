import fs from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import test from "ava";
import axios from "axios";
import XLSX from "xlsx";
import { FileConversionService } from "../src/services/FileConversionService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock context
const mockContext = {
  log: console.log,
};

// Setup: Create test documents
test.before(async (t) => {
  const testDir = join(__dirname, "test-docs");
  await fs.mkdir(testDir, { recursive: true });

  // Create various test files
  const textFile = join(testDir, "test.txt");
  const largeTextFile = join(testDir, "large.txt");
  const unicodeFile = join(testDir, "unicode.txt");
  const jsonFile = join(testDir, "test.json");
  const emptyFile = join(testDir, "empty.txt");
  const excelFile = join(testDir, "test.xlsx");

  // Regular text content
  await fs.writeFile(
    textFile,
    "This is a test document content.\nIt has multiple lines.\nThird line here.",
  );

  // Large text content (>100KB)
  const largeContent = "Lorem ipsum ".repeat(10000);
  await fs.writeFile(largeTextFile, largeContent);

  // Unicode content
  const unicodeContent =
    "这是中文内容\nこれは日本語です\nЭто русский текст\n🌟 emoji test";
  await fs.writeFile(unicodeFile, unicodeContent);

  // JSON content
  await fs.writeFile(jsonFile, JSON.stringify({ test: "content" }));

  // Empty file
  await fs.writeFile(emptyFile, "");

  // Create a test Excel file
  const workbook = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([
    ["Header 1", "Header 2"],
    ["Data 1", "Data 2"],
    ["Data 3", "Data 4"],
  ]);
  XLSX.utils.book_append_sheet(workbook, ws1, "Sheet1");
  XLSX.writeFile(workbook, excelFile);

  t.context = {
    testDir,
    textFile,
    largeTextFile,
    unicodeFile,
    jsonFile,
    emptyFile,
    excelFile,
  };
});

// Cleanup
test.after.always(async (t) => {
  await fs.rm(t.context.testDir, { recursive: true, force: true });
});

// Test Excel to CSV conversion
test("converts Excel to CSV successfully", async (t) => {
  const service = new FileConversionService(mockContext);
  const result = await service.convertFile(t.context.excelFile);

  t.true(result.converted);
  t.true(result.convertedPath.endsWith(".csv"));

  // Read the converted file and verify content
  const content = await fs.readFile(result.convertedPath, "utf-8");
  t.true(content.includes("Header 1,Header 2"));
  t.true(content.includes("Data 1,Data 2"));
  t.true(content.includes("Data 3,Data 4"));
});

// Test document conversion with MarkItDown API
test("converts document to markdown via MarkItDown API", async (t) => {
  // Set the environment variable for the test
  const originalEnv = process.env.MARKITDOWN_CONVERT_URL;
  process.env.MARKITDOWN_CONVERT_URL = "http://localhost:8080/convert?url=";
  
  // Mock axios.get for MarkItDown API
  const originalAxiosGet = axios.get;
  axios.get = async (url) => {
    if (url.includes("test.docx")) {
      return {
        data: {
          markdown:
            "# Test Document\n\nThis is a test document converted to markdown.",
        },
      };
    }
    throw new Error("Invalid URL");
  };

  const service = new FileConversionService(mockContext);
  const result = await service.convertFile(
    "test.docx",
    "https://example.com/test.docx",
  );

  t.true(result.converted);
  t.true(result.convertedPath.endsWith(".md"));

  // Read the converted file and verify content
  const content = await fs.readFile(result.convertedPath, "utf-8");
  t.true(content.includes("# Test Document"));
  t.true(content.includes("This is a test document converted to markdown"));

  // Restore original axios.get and environment variable
  axios.get = originalAxiosGet;
  if (originalEnv) {
    process.env.MARKITDOWN_CONVERT_URL = originalEnv;
  } else {
    delete process.env.MARKITDOWN_CONVERT_URL;
  }
});

// Test error handling for missing original URL
test("handles missing original URL for document conversion", async (t) => {
  const service = new FileConversionService(mockContext);
  await t.throwsAsync(async () => service.convertFile("test.docx"), {
    message: "Original URL is required for document conversion",
  });
});

// Test error handling for unsupported file types
test("handles unsupported file types", async (t) => {
  const service = new FileConversionService(mockContext);
  const result = await service.convertFile(t.context.jsonFile);
  t.false(result.converted);
});

// Test file extension detection
test("correctly detects file extensions", (t) => {
  const service = new FileConversionService(mockContext);
  t.true(service.needsConversion("test.docx"));
  t.true(service.needsConversion("test.xlsx"));
  t.false(service.needsConversion("test.txt"));
  t.false(service.needsConversion("test.json"));
});
