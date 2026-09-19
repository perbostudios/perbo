import { Circle, area } from "@fixture/core";
import { measured } from "@fixture/ui";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { helpers } from "./helpers";

export async function main(path: string): Promise<number> {
  const { Button } = await import("@fixture/ui");
  const data = z.string().parse(readFileSync(path, "utf8"));
  return measured(new Circle()) + area(new Circle()) + helpers.count + data.length + Number(Button);
}

export default main;
