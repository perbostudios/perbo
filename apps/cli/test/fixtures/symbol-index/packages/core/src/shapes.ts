export interface Shape {
  readonly kind: string;
}

export type Area = number;

export enum Corner {
  TopLeft = "top-left",
}

export class Circle implements Shape {
  readonly kind = "circle";
}

export function area(shape: Shape): Area {
  return shape.kind.length;
}

export const ORIGIN = 0;
export const { x, y } = { x: 1, y: 2 };

export namespace Geometry {
  export const PI = 3;
}

function helper(): number {
  return 1;
}

export { helper, helper as alias };
