import "@testing-library/jest-dom/vitest";

// jsdom implements animation frames with setInterval, which polling tests mock.
// Keep popup focus/positioning frames independent of those polling intervals.
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
