import { expect, test } from "bun:test";
import { runnerOutputLinked, runnerOutputMentions, runnerOutputPath } from "./runnerOutputLinks";

/** Whether a record whose text is `written` links the checkout file `relative`. */
const links = (written: string, relative: string) =>
  runnerOutputLinked(runnerOutputMentions([JSON.stringify({ report: written })]), runnerOutputPath(relative)!);

test("a path counts from its first runner output directory; other paths have none", () => {
  expect(runnerOutputPath("apps/web/test-results/login-chromium/shot.png")).toBe("test-results/login-chromium/shot.png");
  expect(runnerOutputPath("playwright-report/data/a.png")).toBe("playwright-report/data/a.png");
  expect(runnerOutputPath("captures/shot.png")).toBeNull();
  expect(runnerOutputPath("apps/web/test-results")).toBeNull();
});

test("a record that writes the file's path links it, whatever prefix the path carries", () => {
  const file = "apps/web/test-results/login-chromium/shot.png";
  expect(links("see test-results/login-chromium/shot.png", file)).toBeTrue();
  expect(links("see /work/lane/apps/web/test-results/login-chromium/shot.png.", file)).toBeTrue();
  expect(links("![failure](apps/web/test-results/login-chromium/shot.png)", file)).toBeTrue();
  expect(links("see test-results/login-chromium/other.png", file)).toBeFalse();
  expect(links("the test-results directory is ignored", file)).toBeFalse();
});

test("a record that writes a directory inside the runner directory links every file under it", () => {
  const file = "test-results/login-chromium/retry1/shot.png";
  for (const written of ["screenshots in `test-results/login-chromium/`", "screenshots in test-results/login-chromium.", "look at test-results/login-chromium/retry1:"])
    expect(links(written, file)).toBeTrue();
  expect(links("screenshots in test-results/login-chrom", file)).toBeFalse();
  expect(links("screenshots in test-results/logout-chromium/", file)).toBeFalse();
  // The runner directory alone names nothing in particular.
  expect(links("output went to test-results/", file)).toBeFalse();
});

test("a link to the HTML report's entry page links the files of that report", () => {
  expect(links("open playwright-report/index.html", "playwright-report/data/a.png")).toBeTrue();
  expect(links("http://localhost:9323/playwright-report/index.html#?testId=1a2b", "playwright-report/data/a.png")).toBeTrue();
  expect(links("open playwright-report/index.html", "apps/web/playwright-report/trace/b.webm")).toBeTrue();
  expect(links("open playwright-report/index.html", "test-results/case/shot.png")).toBeFalse();
});

test("URL encoding, backslash escapes, backslash separators and case do not hide a link", () => {
  expect(links("test-results/my%20case/shot%2B1.png", "test-results/my case/shot+1.png")).toBeTrue();
  expect(links("test-results%2Fcase%2Fshot.png", "test-results/case/shot.png")).toBeTrue();
  expect(links("open test-results/my\\ case/shot.png now", "test-results/my case/shot.png")).toBeTrue();
  expect(links("test\\-results/case\\_one/shot.png", "test-results/case_one/shot.png")).toBeTrue();
  expect(links("apps\\web\\test-results\\case\\shot.png", "apps/web/test-results/case/shot.png")).toBeTrue();
  expect(links("Test-Results/Case/SHOT.PNG", "test-results/case/shot.png")).toBeTrue();
  expect(links("first line\ntest-results/case/shot.png\nlast line", "test-results/case/shot.png")).toBeTrue();
});

test("a name with a bare space, a `#` or a `?` is linked by the part written before it", () => {
  expect(links("see test-results/my dir/shot.png", "test-results/my dir/shot.png")).toBeTrue();
  expect(links("see test-results/case/shot one.png", "test-results/case/shot one.png")).toBeTrue();
  expect(links("see test-results/case/shot#1.png", "test-results/case/shot#1.png")).toBeTrue();
  expect(links("see test-results/case/what?.png", "test-results/case/what?.png")).toBeTrue();
  // Every file that begins the same way is kept with it.
  expect(links("see test-results/my dir/shot.png", "test-results/my other/shot.png")).toBeTrue();
  expect(links("see test-results/my dir/shot.png", "test-results/your dir/shot.png")).toBeFalse();
  // The runner directory followed by a space begins nothing in particular.
  expect(links("output went to test-results/ and stayed", "test-results/case/shot.png")).toBeFalse();
});
