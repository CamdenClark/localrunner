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
  {
    name: "faker-ruby/faker — rubocop lint",
    repo: "faker-ruby/faker",
    commit: "69cf1df39ef6d8d1b5f4c18584986676ff0e465b",
    workflow: ".github/workflows/ruby.yml",
    job: "lint",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "mikel/mail — rspec ruby 3.3",
    repo: "mikel/mail",
    commit: "d1d65b370b109b98e673a934e8b70a0c1f58cc59",
    workflow: ".github/workflows/test.yml",
    job: "ruby",
    matrix: ["ruby:3.3"],
    event: "push",
    expected: "succeeded",
  },
  {
    name: "rack/rack — minitest ruby 3.4",
    repo: "rack/rack",
    commit: "854833037709b8ca0a8c9d408f54eb1b6c3eb7f2",
    workflow: ".github/workflows/test.yaml",
    job: "test",
    matrix: ["os:ubuntu-latest", "ruby:3.4"],
    event: "push",
    expected: "succeeded",
  },
  {
    name: "BurntSushi/ripgrep — rustfmt",
    repo: "BurntSushi/ripgrep",
    commit: "4519153e5e461527f4bca45b042fff45c4ec6fb9",
    workflow: ".github/workflows/ci.yml",
    job: "rustfmt",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "BurntSushi/ripgrep — docs",
    repo: "BurntSushi/ripgrep",
    commit: "4519153e5e461527f4bca45b042fff45c4ec6fb9",
    workflow: ".github/workflows/ci.yml",
    job: "docs",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "sharkdp/bat — lint",
    repo: "sharkdp/bat",
    commit: "11efacbe64564080e9918a16474cf259095af0b8",
    workflow: ".github/workflows/CICD.yml",
    job: "lint",
    event: "push",
    expected: "succeeded",
  },
  {
    name: "sharkdp/fd — clippy lint",
    repo: "sharkdp/fd",
    commit: "a665a3bba9abc85e80c142a7dcdb8c356b12d9c9",
    workflow: ".github/workflows/CICD.yml",
    job: "lint_check",
    event: "push",
    expected: "succeeded",
  },
];
