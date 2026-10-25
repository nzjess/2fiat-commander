import { expect, test } from "vitest";
import { CLIENT_NAME } from "../src/index.ts";

test("library loads", () => {
  expect(CLIENT_NAME).toBe("twofiat-client");
});
