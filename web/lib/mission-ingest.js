"use strict";

const crypto = require("crypto");
const remote = require("./mission-remote");

const MAX_BYTES = 262144;
const BLOB_PATH = "missions/public-status.json";

function bearerOk(secret, header) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(String(header || ""));
  if (expected.length !== got.length) {
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(expected, got);
}

function forbidden(doc) {
  const text = JSON.stringify(doc);
  return /tx_blob|TxnSignature|sEd[1-9A-HJ-NP-Za-km-z]{15,}|BEGIN PRIVATE|W0_SEED/i.test(text);
}

function acceptDocument(doc, current) {
  const checked = remote.verify(doc, doc && doc.source_observed_at);
  if (!checked.ok) return { ok: false, code: checked.error === "integrity" ? "integrity" : "PUBLISH" };
  if (forbidden(doc)) return { ok: false, code: "REDACT" };
  if (current && Number.isInteger(current.sequence)) {
    if (doc.sequence < current.sequence) return { ok: false, code: "OUT_OF_ORDER" };
    if (doc.sequence === current.sequence && doc.integrity === current.integrity) {
      return { ok: true, stored: false, sequence: doc.sequence };
    }
    if (doc.prev_sequence !== current.sequence) return { ok: false, code: "OUT_OF_ORDER" };
  }
  return { ok: true, stored: true, sequence: doc.sequence, document: checked.body };
}

async function handlePost(input) {
  const body = input || {};
  const secret = body.secret || "";
  if (typeof secret !== "string" || secret.length < 32) {
    return { status: 503, body: { ok: false, code: "STORE", error: "ingest secret is not configured" } };
  }
  if (!bearerOk(secret, body.authorization)) {
    return { status: 401, body: { ok: false, code: "AUTH", error: "ingest secret does not match" } };
  }
  const raw = typeof body.raw === "string" ? body.raw : "";
  if (Buffer.byteLength(raw) > MAX_BYTES) {
    return { status: 413, body: { ok: false, code: "PUBLISH", error: "snapshot is too large" } };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false, code: "PUBLISH", error: "snapshot is not JSON" } };
  }
  if (!body.blobToken && !body.write) {
    return { status: 503, body: { ok: false, code: "STORE", error: "durable snapshot store is not connected" } };
  }
  let current = null;
  if (typeof body.read === "function") current = await body.read();
  const accepted = acceptDocument(doc, current);
  if (!accepted.ok) return { status: 400, body: { ok: false, code: accepted.code, error: "snapshot was refused" } };
  if (accepted.stored && typeof body.write === "function") {
    await body.write(BLOB_PATH, doc);
  }
  return {
    status: 200,
    body: { ok: true, stored: accepted.stored === true, sequence: accepted.sequence, path: BLOB_PATH },
  };
}

module.exports = {
  MAX_BYTES,
  BLOB_PATH,
  bearerOk,
  acceptDocument,
  handlePost,
};
