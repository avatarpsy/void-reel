import { describe, expect, it } from "vitest";
import { aspectToRecorder, isFromParent, readInit, readParams, readPhoneResult, readTakeResult } from "./protocol";

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
    expect(readInit(msg, "s1")).toEqual({ shotId: "s1", title: "Intro", script: "Hi there", aspect: "9:16", takeCount: 0 });
    expect(readInit(msg, "s2")).toBeNull();
    expect(readInit({ type: "other" }, "s1")).toBeNull();
    expect(readInit({ type: "voidspace:recorder-init", shotId: "s1" }, "s1")).toEqual({ shotId: "s1", title: "", script: "", aspect: "", takeCount: 0 });
  });

  it("numbers on from the takes the shot already has", () => {
    const init = (takeCount: unknown) => readInit({ type: "voidspace:recorder-init", shotId: "s1", takeCount }, "s1")!.takeCount;
    expect(init(2)).toBe(2);
    expect(init(2.7)).toBe(2);
    expect(init(-1)).toBe(0);
    expect(init("3")).toBe(0);
    expect(init(Number.NaN)).toBe(0);
  });

  it("reads the board's answer to a take", () => {
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: true }, "s1")).toEqual({ ok: true });
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: false, message: "Shot was deleted" }, "s1"))
      .toEqual({ ok: false, message: "Shot was deleted" });
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s2", ok: true }, "s1")).toBeNull();
    expect(readTakeResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: "yes" }, "s1")).toEqual({ ok: false });
  });

  it("reads the board's answer to record on your phone", () => {
    expect(readPhoneResult({ type: "voidspace:recorder-phone-result", shotId: "s1", ok: true }, "s1")).toEqual({ ok: true });
    expect(readPhoneResult({ type: "voidspace:recorder-phone-result", shotId: "s1", ok: false, message: "Your phone is not signed in." }, "s1"))
      .toEqual({ ok: false, message: "Your phone is not signed in." });
    expect(readPhoneResult({ type: "voidspace:recorder-phone-result", shotId: "s2", ok: true }, "s1")).toBeNull();
    expect(readPhoneResult({ type: "voidspace:recorder-take-result", shotId: "s1", ok: true }, "s1")).toBeNull();
    expect(readPhoneResult({ type: "voidspace:recorder-phone-result", shotId: "s1", ok: 1, message: "  " }, "s1")).toEqual({ ok: false });
    // A take result is not a phone result, and the other way round.
    expect(readTakeResult({ type: "voidspace:recorder-phone-result", shotId: "s1", ok: true }, "s1")).toBeNull();
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
