import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeToolkit,
  defaultToolkits,
  resolveToolkits,
} from "../src/toolkits";

test("default toolkits use Composio no-underscore Google slugs", () => {
  const d = defaultToolkits();
  assert.ok(d.includes("gmail"));
  assert.ok(d.includes("googledrive"));
  assert.ok(d.includes("googlecalendar"));
  assert.ok(!d.includes("google_drive"));
  assert.ok(!d.includes("onedrive")); // not enabled without valid project config
});

test("canonicalizeToolkit maps product aliases", () => {
  assert.equal(canonicalizeToolkit("google_drive"), "googledrive");
  assert.equal(canonicalizeToolkit("GOOGLE_CALENDAR"), "googlecalendar");
  assert.equal(canonicalizeToolkit("dropbox-sign"), "dropbox_sign");
  assert.equal(canonicalizeToolkit("gmail"), "gmail");
});

test("resolveToolkits intersects allowlist", () => {
  assert.deepEqual(resolveToolkits(["gmail", "google_drive", "not_a_thing"]), [
    "gmail",
    "googledrive",
  ]);
  assert.ok(resolveToolkits([]).includes("gmail"));
  assert.ok(resolveToolkits(null).includes("googledrive"));
});
