import { vi } from "vitest";

/**
 * Every test in this package reads Claude Code's catalog through a stub or
 * not at all: the reader `doctor` defaults to launches the `claude` on PATH,
 * which is the person's own and answers differently on each machine. A test
 * that means to read a catalog passes its own `claudeModels`; the reader's own
 * test unmocks it and runs it against a fake binary.
 */
vi.mock("../commands/run/internal/catalog.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readClaudeModels: () => Promise.reject(new Error("No test reads the catalog of the claude on PATH.")),
}));
