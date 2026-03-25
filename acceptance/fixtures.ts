export interface RemoteFixture {
  name: string;
  type: "remote";
  repo: string;
  commit: string;
  workflow: string;
  job?: string;
  event: string;
  expected: "succeeded" | "failed";
}

export interface LocalFixture {
  name: string;
  type: "local";
  workflowContent: string;
  job?: string;
  event: string;
  expected: "succeeded" | "failed";
}

export type AcceptanceFixture = RemoteFixture | LocalFixture;

export const fixtures: AcceptanceFixture[] = [
  {
    name: "sindresorhus/is — npm test",
    type: "remote",
    repo: "sindresorhus/is",
    commit: "eff8e6b318d098317d5673b9d391f8e72cb15363",
    workflow: ".github/workflows/main.yml",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "colinhacks/zod — lint",
    type: "remote",
    repo: "colinhacks/zod",
    commit: "c7805073fef5b6b8857307c3d4b3597a70613bc2",
    workflow: ".github/workflows/test.yml",
    job: "lint",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "services — redis",
    type: "local",
    event: "push",
    expected: "succeeded",
    workflowContent: `
name: Redis Service Test
on: push
jobs:
  test-redis:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - name: Test Redis connection
        run: |
          for i in 1 2 3 4 5; do
            if echo PING | nc -w 1 redis 6379 | grep -q PONG; then
              echo "Redis is up!"
              break
            fi
            sleep 2
          done
          echo -e "SET testkey hello\\r\\nGET testkey\\r\\nQUIT\\r" | nc redis 6379
`,
  },
];
