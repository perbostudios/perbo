import { describe, expect, it } from "vitest";
import { inspectCommand } from "./prohibited.js";

/**
 * `mail`, `sendmail` and `mailx` are prohibited as the program a segment runs,
 * never as a word on its line. The executor verifies its own output with a
 * `grep` whose pattern names `e-?mail`; that line runs `grep`, and refusing it
 * as sending mail ends a ticket over a search.
 *
 * Both directions are asserted, because only the pair pins the reading: a rule
 * that matched nothing passes the first half, and a rule that matches the word
 * anywhere fails it.
 */

const mailHits = (command: string) =>
  inspectCommand(command).filter(
    (hit) => hit.action === "external_communication" && hit.detail.startsWith("sending mail"),
  );

describe("sending mail is the program a segment runs", () => {
  for (const command of [
    String.raw`grep -icE '[A-Za-z0-9._]+@[A-Za-z0-9.]+|[0-9][0-9 ().-]{6,}[0-9]|\b(phone|tel|mobile|e-?mail|address|employee *(number|id|no))\b' resignation-letter.md`,
    "grep mail file",
    "cat mailbox.txt",
    "git log --grep=mail",
    "echo mail && ls sendmail.d",
    "rg -n 'e-?mail' src",
    "ls src/mail/ && cat mailbox/inbox.txt",
    'echo "$(grep -c mail notes.md)"',
    "make test",
    "command -v mail >/dev/null || echo 'no mail'",
    // A directory named `mail` is not the program.
    "ls src/mail",
    "rg foo packages/mail",
    "cat /var/mail/x",
    "ls /var/mail",
    "cp -r src/mail/templates out/",
    // A file called `mail` that a copier reads is a file, not the program.
    "cat mail",
    "tee mail < notes.md",
    "cat templates/mail",
    "tee logs/mail < notes.md",
  ]) {
    it(`is not a hit: \`${command.slice(0, 60)}\``, () => {
      expect(mailHits(command), command).toEqual([]);
    });
  }

  for (const command of [
    "mail -s hi user@host",
    "sendmail -t < message.eml",
    "mailx",
    "MAIL -s hi user@host",
    "echo x | mail -s hi user@host",
    "sudo sendmail -t",
    "env FROM=x mail user@host",
    "command mail user@host",
    "exec mail user@host",
    "busybox mail -s hi user@host",
    "nohup mail user@host",
    "mail -s hi user@host </dev/null &",
    "(mail -s hi user@host)",
    "bash <<EOF\nmail -s hi user@host </dev/null\nEOF",
    "echo user@host | xargs mail -s hi",
    "time mailx user@host",
    "/usr/sbin/sendmail -t",
    '"mail" user@host',
    "true && mail user@host",
    "ls || mail user@host",
    "ls; mailx user@host",
    "sh -c 'mail user@host'",
    // A command substitution runs its body before the command it stands in.
    'echo "$(mail -s hi a@b </dev/null)"',
    "echo `mail -s hi a@b </dev/null`",
    "status=$(mail -s hi a@b </dev/null)",
    "true $(sendmail -t < m.eml)",
    'echo "$(sh mail.sh)"',
    "cat <<EOF\n$(mail -s hi a@b </dev/null)\nEOF",
    // So does a process substitution.
    "echo <(mail -s hi a@b </dev/null)",
    "while read l; do :; done < <(mail -s hi a@b)",
    "tee >(sendmail -t) < m.eml",
    // `$((a) ; (b))` is a command substitution, not arithmetic.
    "echo $((mail -s hi a@b </dev/null) ; (true))",
    "echo $((true) && (mail -s hi a@b))",
    "cat <<EOF\n$((mail -s hi a@b) ; (true))\nEOF",
    // An escaped backtick nests a substitution inside the backtick pair.
    "echo `echo \\`mail -s hi a@b\\``",
    // A program that runs an argument as a program.
    "make --eval='t:;@mail -s hi a@b </dev/null' t",
    "rg --pre mail pattern src",
    "rg --pre=./mailx pattern src",
    "watch -n 60 mail -s hi a@b",
    // A program staged under another name, found by the path that names it.
    "ln -s /usr/sbin/sendmail t && pnpm exec ./t -t < m.eml",
    "ln -s /usr/sbin/sendmail t",
    "cp /usr/bin/mailx ./notify",
    "install -m 755 /usr/bin/mail bin/notify",
    "ln -s $(which mail) t",
    // Or copied byte for byte, and then made executable.
    "cat /usr/sbin/sendmail > t && chmod +x t && ./t",
    "dd if=/usr/sbin/sendmail of=t && chmod +x t",
    "tee t < /usr/bin/mailx",
    "cat ~/bin/mail > t",
  ]) {
    it(`is a hit that ends the attempt: \`${command.replace(/\n/g, "⏎")}\``, () => {
      const hits = mailHits(command);
      expect(hits, command).toHaveLength(1);
      expect(hits[0]!.detail).toMatch(/^sending mail: /);
    });
  }

  it("is a hit for the name anywhere in a segment the reader could not account for", () => {
    // `sh script.sh` runs a script the reader cannot see, so it has no
    // program list to trust, and the rule falls back to the name.
    expect(mailHits("sh notify.sh")).toEqual([]);
    expect(mailHits("sh mail.sh")).toHaveLength(1);
  });
});
