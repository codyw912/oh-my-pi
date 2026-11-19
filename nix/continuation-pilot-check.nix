{ sourcePath, omp ? null }:
let
  f = builtins.getFlake ("path:" + sourcePath);
  base = f.packages.aarch64-linux.default;
in
f.checks.aarch64-linux.continuation-local.override {
  pname = "omp-continuation-pilot-check";
  testFiles = [ "packages/coding-agent/evals/continuation-pilot/verify.test.ts" ];
  runWorkflowTests = false;
  omp = if omp == null then base else omp;
}
