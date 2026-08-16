import assert from "node:assert/strict";
import test from "node:test";
import { parseHostedPiExecutable } from "./hostedRuntimeConfig.js";

test("hosted Pi executable cannot resolve relative to an untrusted workspace", () => {
  assert.equal(parseHostedPiExecutable(undefined), undefined);
  assert.equal(parseHostedPiExecutable("pi"), "pi");
  assert.equal(parseHostedPiExecutable("/opt/pi/bin/pi"), "/opt/pi/bin/pi");
  for (const value of ["./pi", "bin/pi", "..\\pi"]) {
    assert.throws(() => parseHostedPiExecutable(value), /PATH command name or an absolute trusted path/);
  }
});
