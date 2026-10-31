import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeMatrixEscape } from "../src/lib/matrixEscape";

function key(target: EventTarget, value: string, prevented = false, composing = false) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, { key: { value }, isComposing: { value: composing } });
  if (prevented) event.preventDefault();
  target.dispatchEvent(event);
}

test("Escape invokes the supplied close action; other keys do not", () => {
  const target = new EventTarget();
  let closed = 0;
  const unsubscribe = subscribeMatrixEscape(target, () => closed++);
  key(target, "Enter");
  assert.equal(closed, 0);
  key(target, "Escape");
  assert.equal(closed, 1);
  unsubscribe();
  key(target, "Escape");
  assert.equal(closed, 1);
});

test("composition and an Escape already consumed by a child do not close MATRIX", () => {
  const target = new EventTarget();
  let closed = 0;
  const unsubscribe = subscribeMatrixEscape(target, () => closed++);
  key(target, "Escape", true);
  key(target, "Escape", false, true);
  assert.equal(closed, 0);
  unsubscribe();
});
