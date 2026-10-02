import { describe, expect, it } from "vitest";
import { redactObject, redactText, safeErrorMessage } from "../src/redact.js";

describe("collector redaction", () => {
  it("redacts bearer tokens, pairing codes, and local paths", () => {
    const text =
      "Authorization: Bearer collector-secret ABCD-1234 /Users/danielmunoz/Repos/private token=abc123";
    const redacted = redactText(text);

    expect(redacted).not.toContain("collector-secret");
    expect(redacted).not.toContain("ABCD-1234");
    expect(redacted).not.toContain("/Users/danielmunoz");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts secret-shaped object keys recursively", () => {
    const redacted = redactObject({
      collector_token: "secret",
      nested: { api_key: "key", message: "Bearer token-value" }
    });

    expect(redacted).toEqual({
      collector_token: "[REDACTED]",
      nested: { api_key: "[REDACTED]", message: "[REDACTED]" }
    });
  });

  it("returns safe error messages", () => {
    expect(safeErrorMessage(new Error("Bearer secret-token"))).not.toContain("secret-token");
  });

  it("redacts local source canaries and raw row details", () => {
    const text = [
      "/Users/danielmunoz/Repos/private-project",
      "/home/daniel/private-project",
      "SELECT * FROM logs WHERE prompt = 'CANARY_PROMPT_DO_NOT_UPLOAD'",
      "response=CANARY_RESPONSE_DO_NOT_UPLOAD",
      "cat /Users/danielmunoz/.ssh/id_rsa",
      "cookie=CANARY_COOKIE_DO_NOT_UPLOAD",
      "sk_canarysecret123456"
    ].join(" ");

    const redacted = redactText(text);
    expect(redacted).not.toContain("/Users/danielmunoz");
    expect(redacted).not.toContain("/home/daniel");
    expect(redacted).not.toContain("SELECT * FROM logs");
    expect(redacted).not.toContain("CANARY_PROMPT_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("CANARY_RESPONSE_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("CANARY_COOKIE_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("sk_canarysecret123456");
  });

  it("redacts Windows drive, forward-slash, long-path, and UNC paths", () => {
    const samples = [
      "open C:\\Users\\danielmunoz\\Repos\\private-project\\file.ts failed",
      "open C:/Users/danielmunoz/Repos/private-project/file.ts failed",
      "open \\\\?\\C:\\Users\\danielmunoz\\Repos\\private-project failed",
      "open \\\\fileserver\\share\\danielmunoz\\private-project failed",
      "ENOENT: no such file, open 'D:\\work\\danielmunoz\\private-project\\.codex\\x.jsonl'"
    ];

    for (const sample of samples) {
      const redacted = redactText(sample);
      expect(redacted).not.toContain("danielmunoz");
      expect(redacted).not.toContain("private-project");
      expect(redacted).not.toContain("fileserver");
      expect(redacted).toMatch(/^(open|ENOENT)/);
    }
  });

  it("redacts JSON-escaped Windows paths inside serialized objects", () => {
    const redacted = redactText({
      detail: "C:\\Users\\danielmunoz\\Repos\\private-project\\a.ts",
      share: "\\\\fileserver\\share\\private-project"
    });

    expect(redacted).not.toContain("danielmunoz");
    expect(redacted).not.toContain("private-project");
    expect(redacted).not.toContain("fileserver");
  });

  it("does not prepend match offsets to redactions without a kept prefix", () => {
    expect(redactText("contact me@danmunoz.example now")).toBe("contact [REDACTED] now");
    expect(redactText("failed at C:\\Users\\dev\\repo")).toBe("failed at [REDACTED]");
  });

  it("leaves URLs and ratios alone", () => {
    expect(redactText("see https://example.com/docs/page")).toBe("see https://example.com/docs/page");
    expect(redactText("ratio 1:2/3")).toBe("ratio 1:2/3");
  });
});

