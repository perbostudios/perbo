import { useId } from "react";
import type { Shape } from "@fixture/core";

export interface ButtonProps {
  readonly shape: Shape;
}

export default function Button(props: ButtonProps) {
  return <button id={useId()}>{props.shape.kind}</button>;
}

export const SIZES = ["sm", "lg"] as const;
