import { initRepository, type Repository, type Scratch } from "@perbo/test-support";

/** A throwaway repository with two commits and a gitignored `.env`. */
export function workspaceRepository(scratch: Scratch): Repository & { first: string } {
  const repository = initRepository(scratch("perbo-ws-"), {
    files: {
      ".gitignore": ".env\n.env.*\ncerts/\nnode_modules/\n",
      "package.json": JSON.stringify({ name: "fixture", scripts: { test: "node -e 0" } }, null, 2),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
    message: "first",
  });
  const head = repository.commit({ "src.ts": "export const value = 1;\n" }, "second");
  return { ...repository, head, first: repository.head };
}
