import { createContext, useContext } from "react";

/**
 * Which adapter the renderer is mounted against, for the few labels that say
 * so ([D-NEW-desktop-sample-host](../../../../../docs/11-open-decisions.md)).
 *
 * Nothing but wording reads it: every record a screen renders comes from a
 * reply, and both adapters answer the same table, so no screen branches here.
 */
export type Surface = "native" | "sample";
const SurfaceContext = createContext<Surface>("native");
export const SurfaceProvider = SurfaceContext.Provider;
export const useSurface = (): Surface => useContext(SurfaceContext);
