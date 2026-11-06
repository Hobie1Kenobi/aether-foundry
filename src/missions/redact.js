"use strict";

const anchors = require("../director/anchors");

const DROP_KEY = /seed|secret|private_?key|passphrase|prompt|chain_of_thought|^cot$|authorization|bearer|token/i;

function redactString(value) {
  return String(value)
    .replace(/sEd[1-9A-HJ-NP-Za-km-z]{15,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function redact(value, depth) {
  const level = depth || 0;
  if (level > 8) return null;
  if (Array.isArray(value)) return value.map((item) => redact(item, level + 1));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return redactString(value);
    return value;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROP_KEY.test(key)) continue;
    out[key] = redact(child, level + 1);
  }
  return out;
}

function assertPublic(value) {
  const text = JSON.stringify(redact(value));
  if (anchors.EMBEDDED_SEED_RE.test(text) || /W0_SEED|BEGIN PRIVATE/i.test(text)) {
    throw Object.assign(new Error("public mission view still contains a secret"), { code: "REDACT" });
  }
  return redact(value);
}

module.exports = { redact, assertPublic };
