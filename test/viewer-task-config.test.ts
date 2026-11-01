import { expect, test } from "bun:test";

test("the investigation browser lane is an uncached Nx target using the viewer build", async () => {
  const project: unknown = await Bun.file(new URL("../project.json", import.meta.url)).json();
  expect(project).toMatchObject({
    targets: {
      "browser-investigation": {
        executor: "nx:run-commands",
        cache: false,
        dependsOn: ["viewer-build"],
        options: { command: "bun --no-env-file run test:browser:investigation" },
      },
    },
  });
  expect(Object.hasOwn(Object(project), "browser-investigation")).toBe(false);
});
