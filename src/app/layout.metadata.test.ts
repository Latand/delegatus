import { expect, test } from "bun:test";
import { PRODUCT_NAME } from "@/lib/brand";

/* Delegatus rename, slice 2: the page title is the product's name, and the
   description no longer carries the former one. */
test("the page title is Delegatus and the description names it", async () => {
  const { metadata } = await import("./layout");
  expect(PRODUCT_NAME).toBe("Delegatus");
  expect(metadata.title).toBe(PRODUCT_NAME);
  expect(String(metadata.description)).toStartWith("Delegatus");
  expect(String(metadata.description)).not.toContain("Agent Log Viewer");
});
