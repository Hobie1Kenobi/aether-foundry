"use strict";

const fs = require("fs");
const path = require("path");

function empty() {
  return { plans: [], reviews: [] };
}

function memoryStore(seed) {
  const state = seed ? JSON.parse(JSON.stringify(seed)) : empty();
  return {
    kind: "memory",
    list() {
      return state.plans.slice();
    },
    findByClient(clientId) {
      return state.plans.find((row) => row.client_id === clientId) || null;
    },
    get(id) {
      return state.plans.find((row) => row.id === id) || null;
    },
    put(plan) {
      const prev = state.plans.findIndex((row) => row.id === plan.id || row.client_id === plan.client_id);
      if (prev >= 0) state.plans[prev] = plan;
      else state.plans.push(plan);
      return plan;
    },
    putReview(review) {
      state.reviews.push(review);
      return review;
    },
    reviews(planId) {
      return state.reviews.filter((row) => row.plan_id === planId);
    },
  };
}

function fileStore(file) {
  function read() {
    if (!fs.existsSync(file)) return empty();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.plans) || !Array.isArray(parsed.reviews)) {
      throw Object.assign(new Error("bridge plan store is not the expected shape"), { code: "STORE" });
    }
    return parsed;
  }
  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  }
  const mem = memoryStore(fs.existsSync(file) ? read() : empty());
  return {
    kind: "file",
    file,
    list() {
      return read().plans;
    },
    findByClient(clientId) {
      return read().plans.find((row) => row.client_id === clientId) || null;
    },
    get(id) {
      return read().plans.find((row) => row.id === id) || null;
    },
    put(plan) {
      const state = read();
      const idx = state.plans.findIndex((row) => row.id === plan.id || row.client_id === plan.client_id);
      if (idx >= 0) state.plans[idx] = plan;
      else state.plans.push(plan);
      write(state);
      return plan;
    },
    putReview(review) {
      const state = read();
      state.reviews.push(review);
      write(state);
      return review;
    },
    reviews(planId) {
      return read().reviews.filter((row) => row.plan_id === planId);
    },
    _mem: mem,
  };
}

module.exports = { memoryStore, fileStore };
