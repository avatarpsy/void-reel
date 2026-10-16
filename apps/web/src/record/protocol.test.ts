import { describe, expect, it } from "vitest";
import { aspectToRecorder, isFromParent, readInit, readParams, readTakeResult } from "./protocol";

describe("shot recorder protocol", () => {
  it("reads the shot from the url", () => {
    expect(readParams("?shotId=s1&boardId=b1&aspect=9:16")).toEqual({ shotId: "s1", boardId: "b1", aspect: "9:16" });
    expect(readParams("")).toEqual({ shotId: "", boardId: "", aspect: "" });
  });

  it("only trusts same-origin messages from the parent window", () => {
    const parent = {} as Window;
    const win = { parent, location: { origin: "https://voidspace.ai" } } as unknown as Window;
    expect(isFromParent({ origin: "https://voidspace.ai", source: parent }, win)).toBe(true);
    expect(isFromParent({ origin: "https://evil.example", source: parent }, win)).toBe(false);
    expect(isFromParent({ origin: "https://voidspace.ai", source: {} as Window }, win)).toBe(false);
    expect(isFromParent({ origin: "https://voidspace.ai", source: null }, win)).toBe(false);
  });

  it("accepts the init for this shot only", () => {
    const msg = { type: "voidspace:recorder-init", shotId: "s1", title: "Intro", script: "Hi there", aspect: "9:16" };
    expect(readInit(msg, "s1")).toEqual({ shotId: "s1", title: "Intro", script: "Hi there", aspect: "9:16" });
    expect(readInit(msg, "s2")).toBeNull();
    expect(readInit({ type: "other" }, "s1")).toBeNull();
    expect(readInit({ type: "voidspace:recorder-init", shotId: "s1" }, "s1")).toEqual({ shotId: "s1", title: "", script: "", aspect: "" });
  });

  it("reads the board's answer to a take", () => {
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: true }, "s1")).toEqual({ ok: true });
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: false, message: "Shot was deleted" }, "s1"))
      .toEqual({ ok: false, message: "Shot was deleted" });
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s2", ok: true }, "s1")).toBeNull();
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: "yes" }, "s1")).toEqual({ ok: false });
  });

  it("caps the script the way the board does", () => {
    const long = "a".repeat(5000);
    expect(readInit({ type: "voidspace:recorder-init", shotId: "s1", script: long }, "s1")!.script.length).toBe(4000);
  });

  it("maps shot aspects to recorder shapes", () => {
    expect(aspectToRecorder("9:16")).toMatchObject({ aspect: "9:16", ratio: 9 / 16 });
    expect(aspectToRecorder("16:9").aspect).toBe("16:9");
    expect(aspectToRecorder("1080x1920").aspect).toBe("9:16");
    expect(aspectToRecorder("2.39:1")).toMatchObject({ aspect: "project", targetAspect: 2.39 });
    expect(aspectToRecorder("")).toEqual({ aspect: "project", ratio: null });
    expect(aspectToRecorder("nonsense")).toEqual({ aspect: "project", ratio: null });
  });
});
