import test from "node:test";
import assert from "node:assert/strict";
import { createTempProject } from "./helpers/project";

test("avatar の既定値", () => {
  const project = createTempProject();
  try {
    const avatar = project.config.getAvatar();
    assert.equal(avatar.enabled, true);
    assert.equal(avatar.lip_sync_smoothing, 0.4);
    assert.equal(avatar.lip_sync_gain, 1);
    assert.deepEqual(Object.keys(avatar.expressions), [
      "happy", "angry", "sad", "surprised", "shy", "thinking",
    ]);
  } finally {
    project.cleanup();
  }
});

test("avatar の数値は範囲へ補正され警告が残る", () => {
  const project = createTempProject();
  try {
    project.config.update({ avatar: { lip_sync_smoothing: 5, scale: 0, lip_sync_gain: 9 } });
    const avatar = project.config.getAvatar();
    assert.equal(avatar.lip_sync_smoothing, 1);
    assert.equal(avatar.scale, 0.1);
    assert.equal(avatar.lip_sync_gain, 3);
    assert.ok(project.config.getWarnings().some((w) => w.includes("avatar.lip_sync_smoothing")));
  } finally {
    project.cleanup();
  }
});

test("llm の keep_alive / num_ctx", () => {
  const project = createTempProject();
  try {
    assert.equal(project.config.getLLM().keep_alive, "30m");
    assert.equal(project.config.getLLM().num_ctx, 4096);
    project.config.update({ llm: { num_ctx: 99 } });
    assert.equal(project.config.getLLM().num_ctx, 512);
  } finally {
    project.cleanup();
  }
});

test("audio.playback_target は server / browser のみ許可", () => {
  const project = createTempProject();
  try {
    assert.equal(project.config.getAudio().playback_target, "server");
    project.config.update({ audio: { playback_target: "bogus" as unknown as "server" } });
    assert.equal(project.config.getAudio().playback_target, "server");
  } finally {
    project.cleanup();
  }
});
