/**
 * The environment **the runner's** git and `gh` run in, which is not the
 * agent's.
 *
 * That distinction is the whole security posture: the agent's environment is
 * scrubbed of every credential and the agent never sees a token, while the
 * runner holds them and performs the commit, the push and the pull request
 * itself. So this forwards what git legitimately needs from the person's setup
 * — the agent socket a signing key is unlocked through, the config files that
 * say whether to sign at all, and how this machine reaches the network — and
 * nothing beyond it.
 *
 * Dropping `SSH_AUTH_SOCK` here looks safer and is not: on a machine with SSH
 * commit signing enabled it makes every seal fail with a passphrase prompt,
 * which is an outage rather than a control. Nothing here suppresses signing;
 * a commit Perbo makes is signed exactly as the person's own are.
 */

/**
 * Names carried through when the host sets them. Each names a directory, a
 * file or a route rather than carrying a secret, with the one exception the
 * posture is built around: `SSH_AUTH_SOCK`, which is a socket the person's own
 * agent already answers on.
 */
const GIT_FORWARDED = [
  // Where git reads the person's own configuration and credentials. Forwarded
  // when set and never emptied: Git for Windows takes its home from
  // `USERPROFILE` only while `HOME` is absent, and an empty one hides
  // `~/.gitconfig` — `safe.directory`, the excludes file, the identity.
  "HOME",
  // Signing and configuration: the person's own setup decides whether a commit
  // is signed and with which key.
  "SSH_AUTH_SOCK",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "XDG_CONFIG_HOME",
  "GNUPGHOME",
  // Where Windows keeps a person's own state. `gh` reads its host credential
  // from `%AppData%\GitHub CLI\hosts.yml` and keeps its state under
  // `%LocalAppData%\GitHub CLI`; `USERPROFILE` is the home Go's
  // `os.UserHomeDir` reads there. Without them the runner's `gh` is logged into
  // no host on a machine whose own `gh auth status` answers, and the attempt
  // fails at `gh pr create` with the work already sealed and reviewed.
  // `SystemRoot` is where Git for Windows and gpg find the system's own DLLs,
  // and `TEMP`/`TMP` are the only writable scratch they are given.
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SystemRoot",
  "TEMP",
  "TMP",
  // How this machine reaches the network. A checkout behind a corporate proxy
  // or a private certificate authority can only fetch, push and talk to the
  // GitHub API with these, and a person who has put a credential inside a proxy
  // URL has put it where it reaches git and nothing else.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
];

/**
 * `gh`'s own, beside git's.
 *
 * The tokens are the credential the runner holds and the agent never sees. The
 * enterprise pair is what a GitHub Enterprise host authenticates with, and a
 * person on one has no `GH_TOKEN` at all.
 */
const GH_FORWARDED = [
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

function forward(base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  for (const name of names) {
    const value = base[name];
    // A name the host does not set is left unset rather than emptied: `gh`
    // reads an empty `APPDATA` as a configuration directory at the filesystem
    // root.
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return forward(base, {
    PATH: base.PATH ?? "/usr/bin:/bin",
    LANG: base.LANG ?? "C",
    // A credential prompt becomes a failure rather than a hang.
    GIT_TERMINAL_PROMPT: "0",
    // Git Credential Manager ignores `GIT_TERMINAL_PROMPT` and raises a window
    // instead, which on a headless run is the same hang with nobody to see it.
    GCM_INTERACTIVE: "never",
  }, GIT_FORWARDED);
}

export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return forward(base, { ...gitEnv(base), GH_PROMPT_DISABLED: "1" }, GH_FORWARDED);
}

/**
 * What a git call that reaches GitHub over HTTPS is given on top of `gitEnv`:
 * the token pair, so gh's credential helper can answer, with the helper's own
 * prompt off, because that helper is a `gh` process and a prompt there is the
 * same hang it is anywhere else. Only where the remote is GitHub, since a
 * token handed to every git call would reach every remote.
 */
export function githubCredentialOverlay(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    GH_PROMPT_DISABLED: "1",
    ...(base.GH_TOKEN ? { GH_TOKEN: base.GH_TOKEN } : {}),
    ...(base.GITHUB_TOKEN ? { GITHUB_TOKEN: base.GITHUB_TOKEN } : {}),
  };
}
