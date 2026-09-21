import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDirectories } from "@perbo/test-support";
import { inspectCommand } from "../src/prohibited.js";

const scratch = scratchDirectories("perbo-runner-");

/**
 * The command lines each review round probed, with the decision each must get.
 * `<root>` is the attempt's worktree root, which exists on disk for this file.
 */

type Decision = "allowed" | "refused";

const ROWS: Array<[string, Decision, string]> = [
  // ---- SCP-156, the two loop-killing lines and the criteria around them.
  ["git show 4fffb08 -- apps/cli/test/escapes.test.ts > <root>/r1.diff", "allowed", "scp"],
  ["git show HEAD:apps/cli/src/stops.ts > <root>/apps/cli/src/stops-head.ts", "allowed", "scp"],
  ["> /tmp/r1.diff", "refused", "scp"],
  ["> $TMPDIR/x", "refused", "scp"],
  ["> $HOME/x", "refused", "scp"],
  ["> ~/x", "refused", "scp"],
  ["> ${HOME}/x", "refused", "scp"],
  ["> ~user/x", "refused", "scp"],
  ["> ~+/x", "refused", "scp"],
  ["> $VAR/x", "refused", "scp"],
  ["git show HEAD >", "refused", "scp"],
  ["git show HEAD > >(cat)", "refused", "scp"],
  ["git show HEAD > `mktemp`", "refused", "scp"],
  ["> /etc/passwd", "refused", "scp"],
  ["> ../../escape.txt", "refused", "scp"],
  ["> sub/../inside", "allowed", "scp"],
  ["> ./*", "allowed", "scp"],
  ["> <root>/", "allowed", "scp"],
  ["> <root>", "allowed", "scp"],

  // ---- Review 1: the lists the reviewer confirmed, in both directions.
  ["2>&1", "allowed", "review-1"],
  ["pnpm test 2>&1", "allowed", "review-1"],
  ["pnpm test >&2", "allowed", "review-1"],
  ["pnpm test >&-", "allowed", "review-1"],
  ["echo 'a > /etc/x'", "allowed", "review-1"],
  ["rg '> /tmp' src", "allowed", "review-1"],
  ["cp ~/src a", "allowed", "review-1"],
  ["cp /etc/hosts ./copy", "allowed", "review-1"],
  ["/bin/cp a <root>/x", "allowed", "review-1"],
  ["FOO=1 cp a b", "allowed", "review-1"],
  ["pnpm install --frozen-lockfile", "allowed", "review-1"],
  ["npm ci", "allowed", "review-1"],
  ["git status", "allowed", "review-1"],
  ["pnpm test", "allowed", "review-1"],
  ["node scripts/x.js > out/report.json", "allowed", "review-1"],
  ["rm -rf node_modules", "allowed", "review-1"],
  ["chmod +x scripts/run.sh", "allowed", "review-1"],
  ["git -C /tmp/wt show HEAD", "allowed", "review-1"],
  ["git log --oneline | grep fix", "allowed", "review-1"],
  ["ls; pwd", "allowed", "review-1"],
  ["pnpm exec turbo run test", "allowed", "review-1"],
  ["cat > notes.md << EOF", "allowed", "review-1"],
  ["pnpm exec vitest run --reporter=basic", "allowed", "review-1"],
  ["cd packages/runner && pnpm exec vitest run > ../../vitest.log 2>&1", "allowed", "review-1"],
  ['Grep {"pattern":"cat > /tmp/x","path":"src"}', "allowed", "review-1"],
  ["Write <root>/src/a.ts", "allowed", "review-1"],
  ['git commit -m "fix: a > b"', "allowed", "review-1"],
  ["rg -e 'foo|bar' src", "allowed", "review-1"],
  ['printf x > "$ROOT/../x"', "refused", "review-1"],
  ["exec 3>/etc/x", "refused", "review-1"],
  ["{fd}>/etc/x", "refused", "review-1"],
  [">&/tmp/x", "refused", "review-1"],
  ["&>> /etc/x", "refused", "review-1"],
  ["<> /etc/x", "refused", "review-1"],
  ["cp -t /tmp a", "refused", "review-1"],
  ["cp --target-directory=/tmp a", "refused", "review-1"],
  ["cp --target-directory /tmp a", "refused", "review-1"],
  ["mv a b c /tmp/dir", "refused", "review-1"],
  ["rm -rf ~", "refused", "review-1"],
  ["rm -rf /", "refused", "review-1"],
  ["rm -- /etc/x", "refused", "review-1"],
  ["chmod 777 /etc/hosts", "refused", "review-1"],
  ["chown me /etc/hosts", "refused", "review-1"],
  ["rm -rf $(git rev-parse --git-common-dir)", "refused", "review-1"],
  ["cp secrets.json ~/backup.json", "refused", "review-1"],
  ['pnpm exec sh -c "echo x > /etc/passwd"', "refused", "review-1"],
  ["npx --yes sh -c 'echo x > ~/x'", "refused", "review-1"],
  ["pnpm exec sh -c 'cp secrets.json ~/backup.json'", "refused", "review-1"],
  ['echo "$(printf x > /etc/passwd)"', "refused", "review-1"],
  ['echo "`printf x > /Users/nobody/x`"', "refused", "review-1"],
  ['echo "$(cp secrets.json ~/x)"', "refused", "review-1"],
  ['git log --format="%h | %s" > ~/log.txt', "refused", "review-1"],
  ['rg -e "foo|bar" src > /etc/x', "refused", "review-1"],
  ['cat "a;b.txt" > /Users/nobody/x', "refused", "review-1"],
  ['git show "HEAD:a|b" > ~/x', "refused", "review-1"],
  ['echo "a && b" > /Users/nobody/x', "refused", "review-1"],
  ["pnpm exec cp secrets.json ~/backup.json", "refused", "review-1"],
  ["pnpm exec rm -rf ~/x", "refused", "review-1"],
  ["find . -name '*.key' -exec cp {} ~/keys/ \\;", "refused", "review-1"],
  ["find . -name x -exec rm {} ~/y \\;", "refused", "review-1"],
  ["for f in *; do cp $f ~/backup/; done", "refused", "review-1"],
  ["if cp a ~/b; then echo hi; fi", "refused", "review-1"],
  ["(cp a ~/b)", "refused", "review-1"],
  ["{ cp a ~/b; }", "refused", "review-1"],
  ["env cp a ~/b", "refused", "review-1"],
  ["xargs rm ~/x", "refused", "review-1"],
  ["time cp a ~/b", "refused", "review-1"],
  ["nohup cp a ~/b", "refused", "review-1"],
  ["cp -rt ~/x a", "refused", "review-1"],
  ["cp -vt ~/x a b", "refused", "review-1"],
  ["mv -ft ~/x a", "refused", "review-1"],
  ["cd /tmp && echo x > y", "refused", "review-1"],
  ["pushd /tmp", "allowed", "review-1"],
  ["cd - && echo x > y", "refused", "review-1"],

  // ---- Review 2: a wrapper's own options, and `eval`.
  ["nice -n 10 cp a ~/b", "refused", "review-2"],
  ["env -i cp a ~/b", "refused", "review-2"],
  ["command -p cp a ~/b", "refused", "review-2"],
  ["time -p cp a ~/b", "refused", "review-2"],
  ["stdbuf -oL cp a ~/b", "refused", "review-2"],
  ["exec -a name cp a ~/b", "refused", "review-2"],
  ["pnpm exec nice -n 5 cp a ~/b", "refused", "review-2"],
  ["find . -exec env -i cp {} ~/y \\;", "refused", "review-2"],
  ["xargs -I{} nice -n5 cp {} ~/o", "refused", "review-2"],
  ["nice -5 cp a ~/b", "refused", "review-2"],
  ["nice --adjustment=5 cp a ~/b", "refused", "review-2"],
  ["sudo -u root cp a /etc/x", "refused", "review-2"],
  ["timeout 5 cp a ~/b", "refused", "review-2"],
  ["timeout -s KILL 5 cp a ~/b", "refused", "review-2"],
  ["xargs -0 -n1 cp -t ~/o", "refused", "review-2"],
  ["stdbuf -o L cp a ~/b", "refused", "review-2"],
  ["stdbuf --output=L cp a ~/b", "refused", "review-2"],
  ["env -u PATH cp a ~/b", "refused", "review-2"],
  ["nice -Z cp a b", "refused", "review-2"],
  ["sudo -Q cp a b", "refused", "review-2"],
  ["npx -c 'cp a ~/x'", "refused", "review-2"],
  ["npx --call='cp a ~/x'", "refused", "review-2"],
  ["eval cp a ~/b", "refused", "review-2"],
  ['eval "cp a" ~/b', "refused", "review-2"],
  ['eval "cp a ~/b"', "refused", "review-2"],
  ['eval echo x ">" ~/out.txt', "refused", "review-2"],
  ["(cd sub && echo x > ../../../escape.txt)", "refused", "review-2"],
  ["nice -n 10 cp a <root>/b", "allowed", "review-2"],
  ["nice -5 cp a <root>/b", "allowed", "review-2"],
  ["nice --adjustment=5 cp a <root>/b", "allowed", "review-2"],
  ["env -i cp a <root>/b", "allowed", "review-2"],
  ["env -u PATH cp a <root>/b", "allowed", "review-2"],
  ["env FOO=1 BAR=2 cp a <root>/b", "allowed", "review-2"],
  ["stdbuf -oL cp a <root>/b", "allowed", "review-2"],
  ["stdbuf -o L cp a <root>/b", "allowed", "review-2"],
  ["stdbuf --output=L cp a <root>/b", "allowed", "review-2"],
  ["command -p cp a <root>/b", "allowed", "review-2"],
  ["command -v git", "allowed", "review-2"],
  ["time -p cp a <root>/b", "allowed", "review-2"],
  ["time -p pnpm test", "allowed", "review-2"],
  ["exec -a name cp a <root>/b", "allowed", "review-2"],
  ["exec 3>&1", "allowed", "review-2"],
  ["sudo -u me cp a <root>/b", "allowed", "review-2"],
  ["timeout 5 cp a <root>/b", "allowed", "review-2"],
  ["timeout -s KILL 5 cp a <root>/b", "allowed", "review-2"],
  ["xargs -I{} cp {} <root>/out", "allowed", "review-2"],
  ["xargs -0 -n1 cp -t <root>/out", "allowed", "review-2"],
  ["npx --yes tsx script.ts", "allowed", "review-2"],
  ["npx -p typescript tsc", "allowed", "review-2"],
  ['npx -c "cp a <root>/b"', "allowed", "review-2"],
  ["eval cp a <root>/b", "allowed", "review-2"],
  ['eval "cp a" <root>/b', "allowed", "review-2"],
  ["timeout 30 pnpm exec vitest run > <root>/log.txt", "allowed", "review-2"],
  ["nohup pnpm test > <root>/log.txt &", "allowed", "review-2"],
  ["(cd sub && echo x > ../real.txt)", "allowed", "review-2"],
  ["(cd sub; echo x > ../real.txt)", "allowed", "review-2"],
  ["pnpm exec nice -n 5 cp a <root>/b", "allowed", "review-2"],

  // ---- Review 3: a wrapper named by path or reached through a flag, and the
  // operator that ends a command.
  ["/usr/bin/env cp a ~/b", "refused", "review-3"],
  ["/usr/bin/env FOO=1 sh -c 'echo x > /etc/passwd'", "refused", "review-3"],
  ["/usr/bin/nice -n 10 cp a ~/b", "refused", "review-3"],
  ["pnpm -r exec cp a ~/b", "refused", "review-3"],
  ["pnpm --filter @perbo/cli exec sh -c 'echo x > /etc/passwd'", "refused", "review-3"],
  ["pnpm --filter=@perbo/cli exec cp a ~/b", "refused", "review-3"],
  ["pnpm exec -- cp a ~/b", "refused", "review-3"],
  ["yarn workspace cli exec cp a ~/b", "refused", "review-3"],
  ["bun x sh -c 'echo x > /etc/passwd'", "refused", "review-3"],
  ["npm exec -- cp a ~/b", "refused", "review-3"],
  ["pnpm --nope exec cp a b", "refused", "review-3"],
  ["pnpm -C /tmp exec cp a b", "refused", "review-3"],
  ["env -C /tmp cp a b", "refused", "review-3"],
  ["env -S 'cp a ~/x' true", "refused", "review-3"],
  ["env --split-string='cp a ~/x' true", "refused", "review-3"],
  ["cd deep & echo x > ../x", "refused", "review-3"],
  ["cd deep & git show HEAD > ../x", "refused", "review-3"],
  ["(cd deep | cat; echo x > ../x)", "refused", "review-3"],
  ["(cd deep & echo x > ../x)", "refused", "review-3"],
  ["npx --silent --prefix <root> tsc", "allowed", "review-3"],
  ["npx -w cli --ignore-scripts --loglevel silly tsc", "allowed", "review-3"],
  ["xargs -J % cp % <root>/out", "allowed", "review-3"],
  ["xargs -R 2 cp -t <root>/out", "allowed", "review-3"],
  ["pnpm -C packages/runner exec cp a b", "allowed", "review-3"],
  ["pnpm install --frozen-lockfile", "allowed", "review-3"],
  ["pnpm run build", "allowed", "review-3"],
  ["pnpm -r run build", "allowed", "review-3"],
  ["pnpm --filter @perbo/cli exec vitest run > <root>/log.txt", "allowed", "review-3"],
  ["cd deep && echo x > ../real.txt", "allowed", "review-3"],
  ["cd deep; echo x > ../real.txt", "allowed", "review-3"],
  ["(cd deep && echo x > ../real.txt)", "allowed", "review-3"],
  ["(cd deep; echo x > ../real.txt)", "allowed", "review-3"],

  // ---- Review 4: options after `exec`, and the device targets.
  ["pnpm exec -c 'echo x > /etc/passwd'", "refused", "review-4"],
  ["pnpm exec --shell-mode 'cp a ~/b'", "refused", "review-4"],
  ["npm x -c 'echo x > /etc/passwd'", "refused", "review-4"],
  ["npm exec --call='cp a ~/b'", "refused", "review-4"],
  ["pnpm exec --parallel cp a ~/b", "refused", "review-4"],
  ["bun x --bun sh -c 'echo x > /etc/passwd'", "refused", "review-4"],
  ["pnpm dlx --package=x sh -c 'echo x > /etc/passwd'", "refused", "review-4"],
  ["pnpm exec --nope cp a b", "refused", "review-4"],
  ["pnpm -s exec cp a ~/b", "refused", "review-4"],
  ["pnpm exec -c 'cp a <root>/b'", "allowed", "review-4"],
  ["pnpm exec --parallel cp a <root>/b", "allowed", "review-4"],
  ["pnpm dlx --package=x sh -c 'cp a <root>/b'", "allowed", "review-4"],
  ["pnpm -s run build", "allowed", "review-4"],
  ["pnpm test > /dev/null", "allowed", "review-4"],
  ["pnpm install > /dev/null 2>&1", "allowed", "review-4"],
  ["git fetch 2>/dev/null", "allowed", "review-4"],
  ["command -v node >/dev/null", "allowed", "review-4"],
  ["pnpm test &>/dev/null", "allowed", "review-4"],
  ["git show HEAD > /dev/stderr", "allowed", "review-4"],
  ["git show HEAD > /dev/stdout", "allowed", "review-4"],
  ["git show HEAD > /dev/fd/2", "allowed", "review-4"],
  ["git show HEAD > /dev/tty", "allowed", "review-4"],
  ["cp a /dev/null", "allowed", "review-4"],
  ["git show HEAD > /dev/disk0", "refused", "review-4"],
  ["cp a /dev/disk0", "refused", "review-4"],
  ["git show HEAD > /dev/nullx", "refused", "review-4"],
  ["(\n cd sub\n pnpm build > ../real.txt\n)", "allowed", "review-4"],
  ["(\n cd sub\n pnpm build > ../../../escape.log\n)", "refused", "review-4"],

  // ---- SCP-162: a move is not a write.
  ["cd /tmp && node /Users/nobody/x/apps/cli/dist/main.js doctor", "allowed", "scp-162"],
  ["cd /tmp", "allowed", "scp-162"],
  ["cd /tmp && git status", "allowed", "scp-162"],
  ["cd ~ && node --version", "allowed", "scp-162"],
  ["pnpm -C /tmp exec node --version", "allowed", "scp-162"],
  ["env -C /tmp node --version", "allowed", "scp-162"],
  ["cd /tmp && echo x > <root>/y", "allowed", "scp-162"],
  ["pnpm -C /tmp exec sh -c 'echo x > <root>/y'", "allowed", "scp-162"],
  ["cd /tmp && echo x > y", "refused", "scp-162"],
  ["(cd /tmp; echo x > y)", "refused", "scp-162"],
  ["pushd /tmp && echo x > y", "refused", "scp-162"],
  ["pnpm -C /tmp exec sh -c 'echo x > y'", "refused", "scp-162"],
  ["cd $ELSEWHERE && node --version", "refused", "scp-162"],
  ["cd - && node --version", "refused", "scp-162"],
  ["cd ~someone && node --version", "refused", "scp-162"],
  ["popd && node --version", "refused", "scp-162"],
  ["cd $(mktemp -d) && node --version", "refused", "scp-162"],
  ["cd deep && echo x > ../real.txt", "allowed", "scp-162"],
  ["cd packages/runner && git show HEAD > ../../../escape.txt", "refused", "scp-162"],

  // ---- SCP-162 review: eval moves the shell, a subshell does not.
  ['eval "cd /tmp" && echo x > y', "refused", "scp-162"],
  ["eval cd /tmp; echo x > y", "refused", "scp-162"],
  ["pnpm exec -c 'eval cd /tmp; echo x > y'", "refused", "scp-162"],
  ["eval cd $ELSEWHERE && echo x > y", "refused", "scp-162"],
  ['eval "cd /tmp" && echo x > <root>/y', "allowed", "scp-162"],
  ["eval cd sub && echo x > ../real.txt", "allowed", "scp-162"],
  ["(cd /tmp && node <root>/apps/cli/dist/main.js doctor) > doctor.log", "allowed", "scp-162"],
  ["(cd /tmp && node <root>/apps/cli/dist/main.js doctor); echo done > status.txt", "allowed", "scp-162"],
  ["(cd /tmp) && echo x > y", "allowed", "scp-162"],
  ["(cd /tmp && echo x > y) > log.txt", "refused", "scp-162"],

  // ---- SCP-174: a heredoc body is the command's input, not command text.
  ["cat >> <root>/loop.test.ts <<'TESTS'\nconst a = \"> /etc/passwd\";\nTESTS", "allowed", "scp-174"],
  ["cat > <root>/a <<EOF\ncd /tmp\nrm -rf /\nEOF", "allowed", "scp-174"],
  ['cat > <root>/a <<"EOF"\n> ~/x\nEOF', "allowed", "scp-174"],
  ["cat > <root>/a <<-EOF\n\t> /etc/passwd\n\tEOF", "allowed", "scp-174"],
  ["cat <<A > <root>/x <<B\n> /etc/x\nA\ncd /tmp\nB", "allowed", "scp-174"],
  ["cat > <root>/a <<'EOF'\n> /etc/passwd", "allowed", "scp-174"],
  ["cat > <root>/a <<'EOF'\nnote\nEOF\necho x > <root>/b", "allowed", "scp-174"],
  ["cat >> /tmp/loop.test.ts <<'TESTS'\nconst a = 1;\nTESTS", "refused", "scp-174"],
  ["cat > <root>/a <<'EOF'\nnote\nEOF\necho x > /tmp/after", "refused", "scp-174"],
  ["cat > <root>/a <<'EOF' && cd /tmp && echo hi > y\nnote\nEOF", "refused", "scp-174"],
  ["cat > <root>/a <<'EOF'\nnote\nEOF\ncd /tmp && echo hi > y", "refused", "scp-174"],
  ["cat <<A > /tmp/x <<B\nnote\nA\nnote\nB", "refused", "scp-174"],
  ["cat <<-EOF > <root>/a\n\tEOF\necho x > /tmp/after", "refused", "scp-174"],
  ["cat <<<EOF > /tmp/x", "refused", "scp-174"],

  // ---- SCP-177: the writers a redirect never passes through, and the
  // interpreters that carry their program on the command line.
  ["pnpm test | tee /tmp/log.txt", "refused", "scp-177"],
  ["pnpm test | tee <root>/log.txt", "allowed", "scp-177"],
  ["dd if=notes.md of=~/copy.md", "refused", "scp-177"],
  ["dd if=notes.md of=<root>/copy.md", "allowed", "scp-177"],
  ["install -m 755 run.sh /usr/local/bin/run", "refused", "scp-177"],
  ["install -m 755 run.sh <root>/bin/run", "allowed", "scp-177"],
  ["rsync -a src/ ~/backup/", "refused", "scp-177"],
  ["rsync -a src/ <root>/backup/", "allowed", "scp-177"],
  ["ln -s /etc/passwd sub/passwd", "refused", "scp-177"],
  ["ln -s <root>/sub/a <root>/sub/b", "allowed", "scp-177"],
  ["git -C /tmp/wt commit -am wip", "refused", "scp-177"],
  ["git -C /tmp/wt show HEAD", "allowed", "scp-177"],
  ["git -C sub commit -am wip", "allowed", "scp-177"],
  ["python3 -c \"open('/etc/hosts','w')\"", "refused", "scp-177"],
  ["node -e \"require('fs').writeFileSync('x','y')\"", "refused", "scp-177"],
  ['node -e "console.log(1 + 1)"', "allowed", "scp-177"],
  ["python3 scripts/report.py", "allowed", "scp-177"],

  // ---- SCP-186: an option the wrapper's table does not know is an option.
  ["ls node_modules/.bin | head && pnpm -v && node -v", "allowed", "scp-186"],
  ["pnpm -v", "allowed", "scp-186"],
  ["pnpm --version", "allowed", "scp-186"],
  ["pnpm --help", "allowed", "scp-186"],
  ["pnpm -w -v", "allowed", "scp-186"],
  ["pnpm exec --help", "allowed", "scp-186"],
  ["npm -v", "allowed", "scp-186"],
  ["npm --version", "allowed", "scp-186"],
  ["yarn --version", "allowed", "scp-186"],
  ["bun --version", "allowed", "scp-186"],
  ["npx --version", "allowed", "scp-186"],
  ["node -v", "allowed", "scp-186"],
  ["git --version", "allowed", "scp-186"],
  ["env --version", "allowed", "scp-186"],
  ["timeout --version", "allowed", "scp-186"],
  ["pnpm -v && echo x > <root>/y", "allowed", "scp-186"],
  // The wrapper answering for itself licenses nothing after it.
  ["pnpm -v && echo x > /tmp/y", "refused", "scp-186"],
  ["pnpm --version && rm -rf /tmp/z", "refused", "scp-186"],
  // A command word after the unknown option keeps the refusal: the guard
  // cannot tell the program from the option's value.
  ["pnpm --frobnicate rm -rf /", "refused", "scp-186"],
  ["npx --frobnicate rm -rf /", "refused", "scp-186"],
  ["env --frobnicate rm -rf /tmp/z", "refused", "scp-186"],
  ["pnpm --frobnicate cp a b", "refused", "scp-186"],
  // A redirect target is not the command word the wrapper lost.
  ["pnpm -v > <root>/log.txt", "allowed", "scp-186"],
  ["pnpm -v > log.txt", "allowed", "scp-186"],
  ["pnpm -v 2>&1", "allowed", "scp-186"],
  ["pnpm -v > /dev/null", "allowed", "scp-186"],
  ["pnpm -v | tee out.txt", "allowed", "scp-186"],
  ["pnpm -v > /tmp/log.txt", "refused", "scp-186"],

  // ---- SCP-190: inline code is refused unless the guard can show it writes
  // nothing. Every line above the divider was allowed by the deny-list reading.
  ["python3 -c \"__import__('os').remove(chr(47)+'x')\"", "refused", "scp-190"],
  ["python3 -c \"__import__('os').replace('a', 'b')\"", "refused", "scp-190"],
  ["python3 -c \"__import__('shutil').move('a', 'b')\"", "refused", "scp-190"],
  ["ruby -e \"File.delete('x')\"", "refused", "scp-190"],
  ["ruby -e \"FileUtils.rm_rf('x')\"", "refused", "scp-190"],
  ["perl -e 'open(my $fh, \">\", $p)'", "refused", "scp-190"],
  ["perl -e '`rm -rf x`'", "refused", "scp-190"],
  ["deno eval \"Deno.remove('x')\"", "refused", "scp-190"],
  // ---- and the shapes an attempt actually types, which stay allowed.
  ['python3 -c "print(1+1)"', "allowed", "scp-190"],
  ['node -e "console.log(process.version)"', "allowed", "scp-190"],
  [
    "python3 -c \"import json,sys; print(json.load(open('package.json'))['name'])\"",
    "allowed",
    "scp-190",
  ],
  ["python3 -c \"import json; print(json.dumps({'a': 1}))\"", "allowed", "scp-190"],
  ["node -e \"console.log(JSON.stringify({a: 1}))\"", "allowed", "scp-190"],
  ["awk '{print $1}' sub/data.csv", "allowed", "scp-190"],
  ["perl -e 'print 1'", "allowed", "scp-190"],
];

/**
 * SCP-166: the runner names a scratch directory inside the worktree and hands
 * it to the executor as `$TMPDIR`, so the guard resolves the variable instead
 * of refusing it by name. `<tmp>` is that directory, `<root>/.perbo-tmp`.
 */
const SCRATCH_ROWS: Array<[string, Decision, string]> = [
  ["printf x > $TMPDIR/x", "allowed", "scp-166"],
  ["printf x > ${TMPDIR}/x", "allowed", "scp-166"],
  ["cat > $TMPDIR/probe.test.ts", "allowed", "scp-166"],
  ['cp a "$TMPDIR/b"', "allowed", "scp-166"],
  ["cp a $TMP/b", "allowed", "scp-166"],
  ["mv a ${TEMP}/b", "allowed", "scp-166"],
  ["rm -rf $TMPDIR/build", "allowed", "scp-166"],
  ["sh -c 'printf x > $TMPDIR/x'", "allowed", "scp-166"],
  ["pnpm exec vitest run > $TMPDIR/log.txt 2>&1", "allowed", "scp-166"],
  ["printf x > <tmp>/x", "allowed", "scp-166"],
  // The habit the directory exists to catch is redirected, not licensed: the
  // literal path is still outside the worktree.
  ["printf x > /tmp/x", "refused", "scp-166"],
  ["cat > /tmp/probe.test.ts", "refused", "scp-166"],
  ["cp a /tmp/b", "refused", "scp-166"],
  ["printf x > $TMPDIR/../../escape", "refused", "scp-166"],
  ["printf x > $TMPDIRX/x", "refused", "scp-166"],
  ["printf x > $OUT/x", "refused", "scp-166"],
  ["printf x > $HOME/x", "refused", "scp-166"],
  // A line that gives the variable a different value is judged as if the
  // runner had named no scratch directory at all.
  ["TMPDIR=/tmp printf x > $TMPDIR/x", "refused", "scp-166"],
  ["export TMPDIR=/tmp; printf x > $TMPDIR/x", "refused", "scp-166"],
  ["env TMP=/tmp cp a $TMP/b", "refused", "scp-166"],
  ["sh -c 'TMPDIR=/tmp; cat > $TMPDIR/x'", "refused", "scp-166"],
  ["unset TMPDIR; printf x > $TMPDIR/x", "refused", "scp-166"],
  // A rebinding written inside a heredoc body is data the command reads, not
  // the environment of the next one (SCP-174).
  ["cat > $TMPDIR/x <<'EOF'\nunset TMPDIR\nEOF", "allowed", "scp-174"],
];

/** Every scratch row again, with no scratch directory named by the runner. */
const WITHOUT_SCRATCH: Array<[string, Decision]> = [
  ["printf x > $TMPDIR/x", "refused"],
  ["printf x > ${TMPDIR}/x", "refused"],
  ["cp a $TMP/b", "refused"],
  ["mv a ${TEMP}/b", "refused"],
];

describe("the probe lists, by round", () => {
  const root = scratch("perbo-scp156-probe-");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, "packages", "runner"), { recursive: true });
  const scope = { root, home: "/Users/nobody" };

  for (const [template, decision, round] of ROWS) {
    const command = template.replaceAll("<root>", root);
    it(`${round}: ${decision} — ${template}`, () => {
      const refused = inspectCommand(command, scope).some(
        (hit) => hit.action === "write_outside_worktree",
      );
      expect(refused ? "refused" : "allowed", command).toBe(decision);
    });
  }
});

describe("the probe list for the runner's scratch directory", () => {
  const root = scratch("perbo-scp166-probe-");
  const tmp = join(root, ".perbo-tmp");
  mkdirSync(tmp, { recursive: true });
  const scope = { root, tmpdir: tmp, home: "/Users/nobody" };

  for (const [template, decision, round] of SCRATCH_ROWS) {
    const command = template.replaceAll("<root>", root).replaceAll("<tmp>", tmp);
    it(`${round}: ${decision} — ${template}`, () => {
      const refused = inspectCommand(command, scope).some(
        (hit) => hit.action === "write_outside_worktree",
      );
      expect(refused ? "refused" : "allowed", command).toBe(decision);
    });
  }

  for (const [command, decision] of WITHOUT_SCRATCH) {
    it(`scp-166: ${decision} with no scratch directory named — ${command}`, () => {
      const found = inspectCommand(command, { root, home: "/Users/nobody" }).filter(
        (hit) => hit.action === "write_outside_worktree",
      );
      expect(found.length > 0 ? "refused" : "allowed", command).toBe(decision);
      // Refused by name, exactly as before the runner had one to offer.
      expect(found[0]?.detail, command).toMatch(/cannot be resolved — an unquoted variable/);
    });
  }
});

/**
 * SCP-195: the same table again, under a contract whose scope is `apps/cli/**`.
 *
 * Two columns, because a row has two answers: the action the refusal must carry
 * under that contract, and the action it must carry under `**`, which admits
 * every path inside the root. `null` is admitted. The pair is what says which
 * refusals are the contract's and which were there before it — widening the
 * scope must not loosen anything else the guard refuses.
 */
type Action = "write_outside_scope" | "write_outside_worktree" | null;

const SCOPE_ROWS: Array<[string, Action, Action]> = [
  ["printf x > apps/cli/src/a.ts", null, null],
  ["printf x > apps/cli/nested/deep/a.ts", null, null],
  ["cp a apps/cli/b", null, null],
  ["mkdir -p apps/cli/x", null, null],
  ["> <root>/apps/cli/out.txt", null, null],
  ["printf x > $TMPDIR/x", null, null],
  ["cat package.json", null, null],
  ["git show HEAD:package.json", null, null],
  ["rg TODO packages", null, null],
  ["printf x > package.json", "write_outside_scope", null],
  ["printf x > packages/contracts/src/a.ts", "write_outside_scope", null],
  ["> <root>/out.txt", "write_outside_scope", null],
  ["cp a docs/b", "write_outside_scope", null],
  ["rm -rf packages/contracts/src", "write_outside_scope", null],
  ["mv apps/cli/a apps/api/a", "write_outside_scope", null],
  ["cd apps && printf x > api/a.ts", "write_outside_scope", null],
  ["sed -i '' s/a/b/ package.json", "write_outside_scope", null],
  ["pnpm test | tee package.json", "write_outside_scope", null],
  // The scope reading reaches a path written inside inline code. Since SCP-234
  // an `open` on a literal path is judged by where that path lands, so the
  // contract's globs are the whole of what refuses it: under `**` the write is
  // inside the worktree and inside the scope, and it is admitted.
  [`python3 -c "open('packages/contracts/src/a.ts','w')"`, "write_outside_scope", null],
  ["printf x > /tmp/x", "write_outside_worktree", "write_outside_worktree"],
  ["cp a ~/b", "write_outside_worktree", "write_outside_worktree"],
];

describe("the probe list for the contract's allowed paths", () => {
  const root = scratch("perbo-scp195-probe-");
  const tmp = join(root, ".perbo-tmp");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(root, "apps", "cli"), { recursive: true });
  mkdirSync(join(root, "packages", "contracts", "src"), { recursive: true });
  const scoped = { root, tmpdir: tmp, home: "/Users/nobody", paths_allowed: ["apps/cli/**"] };
  const everything = { ...scoped, paths_allowed: ["**"] };

  const writes = (command: string, scope: typeof scoped) =>
    inspectCommand(command, scope).filter(
      (hit) => hit.action === "write_outside_worktree" || hit.action === "write_outside_scope",
    );

  for (const [template, action] of SCOPE_ROWS) {
    const command = template.replaceAll("<root>", root);
    it(`scp-195: ${action ?? "allowed"} — ${template}`, () => {
      const hits = writes(command, scoped);
      expect(hits.length > 0 ? "refused" : "allowed", command).toBe(
        action === null ? "allowed" : "refused",
      );
      if (action === null) return;
      expect(hits[0]!.action, command).toBe(action);
      if (action === "write_outside_scope") {
        // The refusal quotes the globs, because the executor has to be able to
        // tell which file it may not write from the sentence it is handed.
        expect(hits[0]!.detail, command).toContain("apps/cli/**");
        expect(hits[0]!.detail, command).toContain("refused before it happens");
      }
    });
  }

  for (const [template, , action] of SCOPE_ROWS) {
    const command = template.replaceAll("<root>", root);
    it(`scp-195: ${action ?? "allowed"} under \`**\` — ${template}`, () => {
      const hits = writes(command, everything);
      expect(hits.length > 0 ? "refused" : "allowed", command).toBe(
        action === null ? "allowed" : "refused",
      );
      if (action !== null) expect(hits[0]!.action, command).toBe(action);
      // Nothing is ever refused as a scope escape while every path is admitted.
      expect(hits.some((hit) => hit.action === "write_outside_scope"), command).toBe(false);
    });
  }
});

describe("the probe lists with no worktree root named", () => {
  const conservative: Array<[string, Decision]> = [
    ["> /tmp/x", "refused"],
    ["> ../x", "refused"],
    ["cp secrets.json ~/backup.json", "refused"],
    ["nice -n 10 cp a ~/b", "refused"],
    ["eval cp a ~/b", "refused"],
    ["> sub/x", "allowed"],
    ["pnpm test", "allowed"],
    ["git status", "allowed"],
    ["rg TODO src", "allowed"],
    ["node scripts/build.js", "allowed"],
    ["pnpm install", "allowed"],
  ];

  for (const [command, decision] of conservative) {
    it(`no-root: ${decision} — ${command}`, () => {
      const refused = inspectCommand(command).some(
        (hit) => hit.action === "write_outside_worktree",
      );
      expect(refused ? "refused" : "allowed", command).toBe(decision);
    });
  }
});
