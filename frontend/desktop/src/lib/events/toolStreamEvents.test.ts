import { describe, it, expect } from "vitest";
import {
  parseRunErrorPayload,
  parseSessionContextPayload,
  type RunErrorPayload,
  type SessionContextPayload,
} from "./toolStreamEvents";

describe("parseRunErrorPayload", () => {
  it("returns null for null or non-object", () => {
    expect(parseRunErrorPayload(null)).toBeNull();
    expect(parseRunErrorPayload(undefined)).toBeNull();
    expect(parseRunErrorPayload("string")).toBeNull();
    expect(parseRunErrorPayload(123)).toBeNull();
  });

  it("returns null when data is missing or not object", () => {
    expect(parseRunErrorPayload({})).toBeNull();
    expect(parseRunErrorPayload({ type: "run_error" })).toBeNull();
    expect(parseRunErrorPayload({ data: null })).toBeNull();
    expect(parseRunErrorPayload({ data: "string" })).toBeNull();
  });

  it("parses valid run_error payload", () => {
    const d = {
      type: "run_error",
      data: { error_code: "context_exceeded", message: "Context limit reached" },
    };
    const out = parseRunErrorPayload(d) as RunErrorPayload;
    expect(out).not.toBeNull();
    expect(out.error_code).toBe("context_exceeded");
    expect(out.message).toBe("Context limit reached");
  });

  it("normalizes error_code to string when number, message null yields undefined", () => {
    const d = {
      type: "run_error",
      data: { error_code: 502, message: null },
    };
    const out = parseRunErrorPayload(d) as RunErrorPayload;
    expect(out).not.toBeNull();
    expect(out.error_code).toBe("502");
    expect(out.message).toBeUndefined();
  });
});

describe("parseSessionContextPayload", () => {
  it("returns null for null or non-object", () => {
    expect(parseSessionContextPayload(null)).toBeNull();
    expect(parseSessionContextPayload(undefined)).toBeNull();
    expect(parseSessionContextPayload("string")).toBeNull();
  });

  it("returns null when data is missing or threadId invalid", () => {
    expect(parseSessionContextPayload({})).toBeNull();
    expect(parseSessionContextPayload({ type: "session_context" })).toBeNull();
    expect(parseSessionContextPayload({ data: {} })).toBeNull();
    expect(parseSessionContextPayload({ data: { threadId: null } })).toBeNull();
  });

  it("parses valid session_context payload", () => {
    const d = {
      type: "session_context",
      data: { threadId: "thread-1", mode: "agent", roleId: "role-1" },
    };
    const out = parseSessionContextPayload(d) as SessionContextPayload;
    expect(out).not.toBeNull();
    expect(out?.threadId).toBe("thread-1");
    expect(out?.mode).toBe("agent");
    expect(out?.roleId).toBe("role-1");
  });

  it("accepts numeric threadId and normalizes to string", () => {
    const d = { type: "session_context", data: { threadId: 12345 } };
    const out = parseSessionContextPayload(d) as SessionContextPayload;
    expect(out?.threadId).toBe("12345");
  });
});
