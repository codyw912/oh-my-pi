{
  lib,
  stdenv,
  bun,
  bun2nix,
  nodejs,
  git,
  omp,
  source,
  sjujperpowersSource,
  sourceRev,
  sjujperpowersRev,
  testFiles,
  pname,
  runBaseline ? false,
  runWorkflowTests ? false,
  kata ? null,
}:

# Isolated continuation trial. Non-fixed-output so the sandbox has no network
# except loopback. Per-invocation sentinel/URL cannot enter this derivation
# without impure evaluation (`impureEnvVars` only applies to fixed-output
# drvs); parent creates the fixed paths outside the sandbox and proves them
# there. Do not add extra-sandbox-paths for the sentinel.
assert lib.assertMsg stdenv.hostPlatform.isLinux
  "OMP continuation checks require Linux; got ${stdenv.hostPlatform.system}";
assert lib.assertMsg (
  testFiles != [ ]
) "continuation check needs real test files, not an empty list";

let
  inherit (stdenv) hostPlatform;
  nativeAddon = omp.passthru.nativeAddon or (throw "omp package is missing passthru.nativeAddon");
  parentSentinel = "/home/continuation/containment-parent-sentinel";
  forbiddenUrl = "http://127.0.0.1:43891/omp-continuation-parent-v1";
  probeRel = "packages/coding-agent/test/fixtures/continuation/containment-probe.ts";
  baselineRel = "packages/coding-agent/test/fixtures/continuation/baseline.ts";
  versions = builtins.toJSON {
    system = hostPlatform.system;
    source = toString source;
    workflowSource = toString sjujperpowersSource;
    cpu.arch = hostPlatform.parsed.cpu.name;
    sourceRev = sourceRev;
    sjujperpowersRev = sjujperpowersRev;
    bunVersion = bun.version;
    nativeAddon = nativeAddon;
    ompVersion = omp.version;
    parentSentinel = parentSentinel;
    forbiddenUrl = forbiddenUrl;
  };
in
stdenv.mkDerivation {
  inherit pname;
  inherit (omp) version;
  src = source;

  nativeBuildInputs = [
    bun
    bun2nix.hook
    nodejs
    git
  ]
  ++ lib.optional (kata != null) kata;

  bunDeps = omp.bunDeps;
  bunInstallFlags = [
    "--linker=isolated"
    "--backend=copyfile"
  ];
  dontConfigure = true;
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;
  dontStrip = true;

  preferLocalBuild = true;
  allowSubstitutes = false;

  env = {
    CONTINUATION_PARENT_SENTINEL = parentSentinel;
    CONTINUATION_FORBIDDEN_URL = forbiddenUrl;
    CONTINUATION_SOURCE_REV = sourceRev;
    CONTINUATION_SJUJPERPOWERS_REV = sjujperpowersRev;
    CONTINUATION_SJUJPERPOWERS_SOURCE = toString sjujperpowersSource;
    CONTINUATION_NATIVE_ADDON = nativeAddon;
    CONTINUATION_BUN_VERSION = bun.version;
    CONTINUATION_NATIVE_ADDON_PATH = "${omp}/lib/pi-natives/${nativeAddon}";
  }
  // lib.optionalAttrs (kata != null) {
    CONTINUATION_KATA_BIN = "${kata}/bin/kata";
  };

  buildPhase = ''
    runHook preBuild
    set -euo pipefail

    if [ -e "$CONTINUATION_PARENT_SENTINEL" ]; then
      echo "continuation check: parent sentinel is readable; sandbox failed" >&2
      exit 1
    fi

    scratch="''${NIX_BUILD_TOP:-''${TMPDIR:-/tmp}}"
    export HOME="$scratch/home"
    export XDG_CONFIG_HOME="$scratch/xdg-config"
    export XDG_CACHE_HOME="$scratch/xdg-cache"
    export XDG_DATA_HOME="$scratch/xdg-data"
    export XDG_STATE_HOME="$scratch/xdg-state"
    export XDG_RUNTIME_DIR="$scratch/xdg-runtime"
    export PI_CONFIG_DIR="$scratch/omp-config"
    export PI_CODING_AGENT_DIR="$scratch/omp-agent"
    export CONTINUATION_EVIDENCE_DIR="$scratch/continuation-evidence"
    mkdir -p "$CONTINUATION_EVIDENCE_DIR"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$PI_CONFIG_DIR" "$PI_CODING_AGENT_DIR" \
      "$XDG_DATA_HOME/omp" "$XDG_STATE_HOME/omp" "$XDG_CACHE_HOME/omp"
    unset OMP_PROFILE PI_PROFILE
    if [ -f "${omp}/nix-support/embedded-addon-runpath" ]; then
      export OMP_NATIVE_LIBRARY_PATH="$(cat "${omp}/nix-support/embedded-addon-runpath")"
    fi

    if [ ! -f ${lib.escapeShellArg probeRel} ]; then
      echo "continuation check: missing ${probeRel}" >&2
      exit 1
    fi
    mkdir -p packages/natives/native
    cp "$CONTINUATION_NATIVE_ADDON_PATH" "packages/natives/native/$CONTINUATION_NATIVE_ADDON"

    # Probe before any OMP import. bun install (hook) does not import OMP.
    bun -- ${lib.escapeShellArg probeRel}
    test ! -e .continuation-workflow
    cp -R "$CONTINUATION_SJUJPERPOWERS_SOURCE" .continuation-workflow
    bun run gen:tool-views

    timeout --signal=TERM --kill-after=5s 180s bun test -- ${
      lib.concatMapStringsSep " " lib.escapeShellArg testFiles
    }

    ${lib.optionalString runWorkflowTests ''
      node --test .continuation-workflow/tests/tracking-providers/test-recovery.mjs
    ''}

    ${lib.optionalString runBaseline ''
      if [ ! -f ${lib.escapeShellArg baselineRel} ]; then
        echo "continuation check: missing ${baselineRel}" >&2
        exit 1
      fi
      export CONTINUATION_BASELINE_OUTPUT="$NIX_BUILD_TOP/baseline.json"
      bun -- ${lib.escapeShellArg baselineRel}
      if [ ! -s "$CONTINUATION_BASELINE_OUTPUT" ]; then
        echo "continuation check: baseline.ts did not write $CONTINUATION_BASELINE_OUTPUT" >&2
        exit 1
      fi
    ''}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    printf '%s\n' ${lib.escapeShellArg versions} > "$out/versions.json"
    ${lib.optionalString runBaseline ''
      cp "$NIX_BUILD_TOP/baseline.json" "$out/baseline.json"
    ''}
      if [ -d "$CONTINUATION_EVIDENCE_DIR" ]; then
        cp -R "$CONTINUATION_EVIDENCE_DIR" "$out/evidence"
      fi
    runHook postInstall
  '';

  meta = {
    description = "Isolated OMP continuation ${if runBaseline then "baseline" else "trial"} check";
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
    ];
  };
}
