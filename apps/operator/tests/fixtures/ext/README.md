Scenario modules for the Expunge fixture backend. Each `*.ts` file exports a default
`(state: FixtureState) => void` that adds jobs, artifacts, proposals or deployments. The
fixture serves synthetic test data only and says so (`backend.kind: "fixture"`).
