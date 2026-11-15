import test from "node:test";
import assert from "node:assert/strict";
import { parseClientRole, pickPrimaryClientId } from "../src/backend/server/clientRole";

test("role=display を display と解釈する", () => {
  assert.equal(parseClientRole("/?mode=stage&role=display"), "display");
  assert.equal(parseClientRole("/?role=control"), "control");
  assert.equal(parseClientRole("/"), "control");
  assert.equal(parseClientRole(undefined), "control");
});

test("display がいればそれを優先する", () => {
  assert.equal(
    pickPrimaryClientId([
      { id: "a", role: "control" },
      { id: "b", role: "display" },
    ]),
    "b"
  );
});

test("display が無ければ先頭、0 台なら null", () => {
  assert.equal(pickPrimaryClientId([{ id: "a", role: "control" }]), "a");
  assert.equal(pickPrimaryClientId([]), null);
});
