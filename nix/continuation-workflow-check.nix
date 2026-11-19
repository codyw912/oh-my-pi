{
  lib,
  runCommand,
  bun,
  nodejs,
  bash,
  gitMinimal,
  jq,
  jujutsu,
  source,
  workflowSource,
}:

runCommand "sjujperpowers-continuation-recovery-check"
  {
    nativeBuildInputs = [
      bun
      nodejs
      bash
      gitMinimal
      jq
      jujutsu
    ];
    preferLocalBuild = true;
    allowSubstitutes = false;
    CONTINUATION_PARENT_SENTINEL = "/home/continuation/containment-parent-sentinel";
    CONTINUATION_FORBIDDEN_URL = "http://127.0.0.1:43891/omp-continuation-parent-v1";
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    export XDG_CONFIG_HOME="$TMPDIR/xdg-config"
    export XDG_CACHE_HOME="$TMPDIR/xdg-cache"
    export XDG_DATA_HOME="$TMPDIR/xdg-data"
    export XDG_STATE_HOME="$TMPDIR/xdg-state"
    export XDG_RUNTIME_DIR="$TMPDIR/xdg-runtime"
    export PI_CONFIG_DIR="$TMPDIR/omp-config"
    export PI_CODING_AGENT_DIR="$TMPDIR/omp-agent"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$PI_CONFIG_DIR" "$PI_CODING_AGENT_DIR"
    unset OMP_PROFILE PI_PROFILE

    bun -- ${source}/packages/coding-agent/test/fixtures/continuation/containment-probe.ts
    cp -R ${lib.escapeShellArg (toString workflowSource)} "$TMPDIR/workflow"
    chmod -R u+w "$TMPDIR/workflow"
    patchShebangs "$TMPDIR/workflow"
    cd "$TMPDIR/workflow"
    mkdir -p "$out"
    node --test tests/tracking-providers/test-recovery.mjs tests/omp/test-omp-extension.mjs \
      2>&1 | tee "$out/node-tests.log"
    bash tests/claude-code/test-sdd-workspace.sh 2>&1 | tee "$out/sdd-workspace.log"
  ''
