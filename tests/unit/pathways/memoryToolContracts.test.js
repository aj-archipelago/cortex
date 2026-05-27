import test from "ava";
import storeMemory from "../../../pathways/system/entity/tools/sys_tool_store_memory.js";
import searchMemory from "../../../pathways/system/entity/tools/sys_tool_remember.js";
import repairJson from "../../../pathways/system/sys_repair_json.js";

test("StoreMemory is budgeted as a cheap tool", (t) => {
  t.is(storeMemory.toolDefinition[0].toolCost, 1);
});

test("StoreMemory accepts numeric-string priorities defensively", (t) => {
  t.regex(String(storeMemory.executePathway), /Number\.parseInt\(memory\.priority, 10\)/);
});

test("SearchMemory and JSON repair disable reasoning by default", (t) => {
  t.regex(String(searchMemory.executePathway), /reasoningEffort:\s*['"]none['"]/);
  t.is(repairJson.inputParameters.reasoningEffort, "none");
});
