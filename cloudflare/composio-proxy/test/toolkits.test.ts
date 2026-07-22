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
  assert.ok(d.includes("googleslides"));
  assert.ok(d.includes("google_chat"));
  assert.ok(d.includes("one_drive"));
  assert.ok(d.includes("microsoft_teams"));
  assert.ok(d.includes("share_point"));
  assert.ok(d.includes("excel"));
  assert.ok(d.includes("onenote"));
  assert.ok(!d.includes("google_drive"));
  assert.ok(!d.includes("onedrive")); // alias only; canonical is one_drive
});

test("canonicalizeToolkit maps product aliases", () => {
  assert.equal(canonicalizeToolkit("google_drive"), "googledrive");
  assert.equal(canonicalizeToolkit("GOOGLE_CALENDAR"), "googlecalendar");
  assert.equal(canonicalizeToolkit("dropbox-sign"), "dropbox_sign");
  assert.equal(canonicalizeToolkit("gmail"), "gmail");
  assert.equal(canonicalizeToolkit("onedrive"), "one_drive");
  assert.equal(canonicalizeToolkit("sharepoint"), "share_point");
  assert.equal(canonicalizeToolkit("teams"), "microsoft_teams");
  assert.equal(canonicalizeToolkit("slides"), "googleslides");
});

test("resolveToolkits intersects allowlist", () => {
  assert.deepEqual(resolveToolkits(["gmail", "google_drive", "not_a_thing"]), [
    "gmail",
    "googledrive",
  ]);
  assert.deepEqual(resolveToolkits(["onedrive", "teams"]), [
    "one_drive",
    "microsoft_teams",
  ]);
  assert.ok(resolveToolkits([]).includes("gmail"));
  assert.ok(resolveToolkits(null).includes("googledrive"));
});
