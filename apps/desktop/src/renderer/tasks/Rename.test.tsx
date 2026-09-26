// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Rename } from "./Rename.js";

afterEach(cleanup);

describe("renaming a ticket", () => {
  it("takes as many characters as a ticket's name has, sixty (D-127)", () => {
    render(<Rename title="Snake game" onSave={() => Promise.resolve()} open />);
    expect((screen.getByRole("textbox", { name: "Task name" }) as HTMLInputElement).maxLength).toBe(60);
  });
});
