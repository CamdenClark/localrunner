export interface AcceptanceFixture {
  name: string;
  repo: string;
  commit: string;
  workflow: string;
  job?: string;
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
    repo: "CamdenClark/localrunner-tests",
    commit: "a3cf6f698c5269c92e9d411b90a7ee227dbe48f5",
    workflow: ".github/workflows/redis-service.yml",
    event: "push",
    expected: "succeeded",
  },
];
