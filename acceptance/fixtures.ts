export interface AcceptanceFixture {
  name: string;
  repo: string;
  commit: string;
  workflow: string;
  job?: string;
  matrix?: string[];
  event: string;
  expected: "succeeded" | "failed";
}

export const fixtures: AcceptanceFixture[] = [
  {
    name: "sindresorhus/is — npm test",
    repo: "sindresorhus/is",
    commit: "eff8e6b318d098317d5673b9d391f8e72cb15363",
    workflow: ".github/workflows/main.yml",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "colinhacks/zod — lint",
    repo: "colinhacks/zod",
    commit: "c7805073fef5b6b8857307c3d4b3597a70613bc2",
    workflow: ".github/workflows/test.yml",
    job: "lint",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "services — redis",
    repo: "CamdenClark/localactions-tests",
    commit: "a3cf6f698c5269c92e9d411b90a7ee227dbe48f5",
    workflow: ".github/workflows/redis-service.yml",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "artifacts — upload",
    repo: "CamdenClark/localactions-tests",
    commit: "a2de9845095610494921f28920adfafc183c3ec7",
    workflow: ".github/workflows/artifact-upload.yml",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "chalk/chalk — npm test",
    repo: "chalk/chalk",
    commit: "aa06bb5ac3f14df9fda8cfb54274dfc165ddfdef",
    workflow: ".github/workflows/main.yml",
    matrix: ["node-version:18"],
    event: "push",
    expected: "succeeded",
  },
  {
    name: "date-fns/date-fns — code quality",
    repo: "date-fns/date-fns",
    commit: "dd66398305c2b015fba3c1b3d31ccff42ee8d4cf",
    workflow: ".github/workflows/code_quality.yaml",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "tj/commander.js — tests",
    repo: "tj/commander.js",
    commit: "8247364da749736570161e95682b07fc2d72497b",
    workflow: ".github/workflows/tests.yml",
    matrix: ["os:ubuntu-latest", "node-version:22.x"],
    event: "push",
    expected: "succeeded",
  },
];
