import test from "node:test";
import assert from "node:assert/strict";
import {
  SHERPA_MODEL_TYPES,
  isSherpaModelType,
} from "../src/shared/stt/modelTypes";

test("sherpa の 4 種別だけを受け付ける", () => {
  for (const type of SHERPA_MODEL_TYPES) {
    assert.equal(isSherpaModelType(type), true);
  }
  assert.equal(isSherpaModelType("whisper"), false);
  assert.equal(isSherpaModelType(""), false);
  assert.equal(isSherpaModelType(undefined), false);
  assert.equal(isSherpaModelType(1), false);
});

test("一覧は schema の型と同じ並び", () => {
  assert.deepEqual([...SHERPA_MODEL_TYPES], [
    "nemo_transducer",
    "nemo_ctc",
    "sense_voice",
    "zipformer_transducer",
  ]);
});
