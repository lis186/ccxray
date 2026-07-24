"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { stripInjectedTags } = require("../server/store");

describe("stripInjectedTags", () => {
  it("strips system-reminder blocks and returns real text", () => {
    const input = "<system-reminder>\nlots of CLAUDE.md content\n</system-reminder>\n<command-message>/dothing</command-message>\n<command-name>/dothing</command-name>\n<command-args>some args</command-args>\nHello, please help me with this bug";
    assert.strictEqual(stripInjectedTags(input), "Hello, please help me with this bug");
  });

  it("returns null when all content is tags", () => {
    const input = "<system-reminder>only tags</system-reminder>";
    assert.strictEqual(stripInjectedTags(input), null);
  });

  it("passes through normal text unchanged", () => {
    assert.strictEqual(stripInjectedTags("hello world"), "hello world");
  });

  it("handles null/undefined", () => {
    assert.strictEqual(stripInjectedTags(null), null);
    assert.strictEqual(stripInjectedTags(undefined), null);
  });

  it("strips antl: prefixed tags", () => {
    const input = "<antl:thinking>internal</antl:thinking> real text";
    assert.strictEqual(stripInjectedTags(input), "real text");
  });

  it("strips antml: prefixed tags (canonical wire format)", () => {
    const input = "<antml:function_calls>tool calls</antml:function_calls> real text";
    assert.strictEqual(stripInjectedTags(input), "real text");
  });

  it("strips bare opening tag (no closing pair)", () => {
    assert.strictEqual(stripInjectedTags("<system-reminder>"), null);
    assert.strictEqual(stripInjectedTags("<system-reminder> real text"), "real text");
  });

  it("strips user-prompt-submit-hook tags", () => {
    const input = "<user-prompt-submit-hook>hook output</user-prompt-submit-hook> real text";
    assert.strictEqual(stripInjectedTags(input), "real text");
  });

  it("strips context tags", () => {
    const input = "<context>injected context</context> real text";
    assert.strictEqual(stripInjectedTags(input), "real text");
  });
});

describe("setSessionTitle rejects bad titles", () => {
  it("rejects title that is just a tag pair", () => {
    const { setSessionTitle } = require("../server/store");
    const result = setSessionTitle("test-sid", "<system-reminder>injected content</system-reminder>");
    assert.strictEqual(result, false);
  });

  it("rejects title that is a bare tag", () => {
    const { setSessionTitle } = require("../server/store");
    const result = setSessionTitle("test-sid-bare", "<system-reminder>");
    assert.strictEqual(result, false);
  });

  it("accepts a normal title", () => {
    const { setSessionTitle, getSessionTitle } = require("../server/store");
    const result = setSessionTitle("test-sid-2", "Fix the login bug");
    assert.strictEqual(result, true);
    assert.strictEqual(getSessionTitle("test-sid-2"), "Fix the login bug");
  });
});
