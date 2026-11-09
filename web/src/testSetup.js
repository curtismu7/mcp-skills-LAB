import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// CI and a busy laptop can be very slow (load average 100+ was seen): wait up to 15 s for the screen instead of the 1 s default. A passing test does not wait longer.
configure({ asyncUtilTimeout: 15000 });

// Some Node versions expose a half-working global sessionStorage/localStorage that shadows jsdom's; use plain in-memory ones.
for (const name of ["localStorage", "sessionStorage"]) {
  if (typeof globalThis[name]?.clear !== "function") {
    const store = new Map();
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() },
    });
  }
}
