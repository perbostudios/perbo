import { describe, expect, it } from "vitest";
import { defang, delimit } from "./delimit.js";

describe("delimit", () => {
  it("turns every spelling of the delimiter inside a body into text", () => {
    for (const spelling of ["</perbo:x>", "</PERBO:x>", "< /perbo:x>", "</ perbo:x>", "<\n/perbo:x>", "<perbo :x>"]) {
      expect(defang(spelling).toLowerCase().match(/<\s*\/?\s*perbo\s*:/g)).toBeNull();
    }
    expect(defang("a < b and </perbo:x> and <div>")).toBe("a < b and &lt;/perbo:x> and <div>");
  });

  it("keeps an attribute value on the opening line, whatever it carries", () => {
    const opened = delimit({ kind: "repo_file", trust: "repo", attrs: { path: 'a"b>c<perbo:d\ne' }, body: "" }).split("\n")[0];
    expect(opened).toBe("<perbo:repo_file trust=\"repo\" path=\"a'b&gt;c&lt;perbo:d e\">");
  });
});
